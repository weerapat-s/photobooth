import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const remoteCmdExe = () => path.join(config.dccPath, 'CameraControlRemoteCmd.exe');
const cameraControlExe = () => path.join(config.dccPath, 'CameraControl.exe');

let dccStartPromise = null;
let dccLastStartAt = 0;
const DCC_RESTART_COOLDOWN = 60000;

async function dccIsRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('tasklist.exe', [
      '/FI', 'IMAGENAME eq CameraControl.exe', '/FO', 'CSV', '/NH',
    ], { timeout: 5000, windowsHide: true });
    return /"CameraControl\.exe"/i.test(stdout);
  } catch {
    return false;
  }
}

async function runRemoteRaw(args, timeout = 20000) {
  return execFileAsync(remoteCmdExe(), args, { timeout, windowsHide: true });
}

function friendlyDccError(raw) {
  const text = [raw?.message, raw?.stdout, raw?.stderr, typeof raw === 'string' ? raw : '']
    .filter(Boolean)
    .map(String)
    .join('\n');
  if (/no camera is connected/i.test(text)) {
    return 'ยังไม่พบ EOS R — ตรวจสาย USB เปิดกล้อง และปิดโปรแกรมอื่นที่กำลังจับกล้อง';
  }
  if (/ENOENT|not found|cannot find/i.test(text)) {
    return 'ไม่พบ digiCamControl — ตรวจตำแหน่งติดตั้งใน DCC_PATH';
  }
  if (/timeout|timed out|ไม่ตอบ/i.test(text)) {
    return 'digiCamControl ไม่ตอบสนอง — กดตรวจใหม่หรือเปิดโปรแกรมอีกครั้ง';
  }
  const responseMessage = text.match(/response:error;message:([^\r\n]+)/i)?.[1]?.trim();
  if (responseMessage) return `digiCamControl: ${responseMessage}`;
  if (/CameraControlRemoteCmd|command failed/i.test(text)) {
    return 'ตรวจ EOS R ไม่สำเร็จ — กดตรวจใหม่ หากยังไม่พบให้ปิดแล้วเปิดกล้องใหม่';
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0] || 'digiCamControl ทำงานไม่สำเร็จ';
}

function parseCameraList(raw) {
  const text = String(raw || '').trim();
  const response = text.match(/response:\s*(\[[^\r\n]*\])/i)?.[1];
  const json = response || (/^\s*\[.*\]\s*$/s.test(text) ? text : null);
  if (json) {
    try {
      const value = JSON.parse(json);
      if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
    } catch { /* ตกไปใช้ตัวแยกแบบข้อความ */ }
  }
  return text.split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/digiCamControl remote command line utility|^running$/i.test(s));
}

/** เปิด digiCamControl ให้อัตโนมัติและรอ named pipe พร้อมรับคำสั่ง */
async function ensureDccRunning() {
  if (!config.dccAutoStart || await dccIsRunning()) return;
  if (dccStartPromise) return dccStartPromise;
  if (Date.now() - dccLastStartAt < DCC_RESTART_COOLDOWN) {
    throw new Error('digiCamControl เพิ่งหยุดทำงาน — ระบบกำลังรอก่อนเปิดใหม่เพื่อป้องกันการเด้งซ้ำ');
  }

  dccStartPromise = (async () => {
    const exe = cameraControlExe();
    if (!fs.existsSync(exe)) throw new Error(`ไม่พบ digiCamControl ที่ ${exe}`);

    dccLastStartAt = Date.now();
    const child = spawn(exe, [], {
      cwd: config.dccPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    let lastError = null;
    for (let i = 0; i < 30; i++) {
      await sleep(750);
      if (!await dccIsRunning()) continue;
      try {
        await runRemoteRaw(['/c', 'list', 'cameras'], 3000);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`digiCamControl เปิดแล้วแต่ยังรับคำสั่งไม่ได้${lastError ? `: ${lastError.message}` : ''}`);
  })().finally(() => {
    dccStartPromise = null;
  });

  return dccStartPromise;
}

/**
 * digiCamControl ส่ง header `Content-Length` ซ้ำสองอันและค่าไม่ตรงกับ body จริง
 * ทั้ง fetch (undici) และ node:http ปฏิเสธ response แบบนี้ แม้เปิด insecureHTTPParser
 * เลยคุยผ่าน TCP ตรง ๆ: ขอแบบ HTTP/1.0 + Connection: close แล้วอ่านจนกว่าฝั่งโน้นจะปิด
 */
function httpGet(url, timeout = 15000) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: u.hostname, port: Number(u.port) || 80 }, () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.0\r\n` +
        `Host: ${u.host}\r\n` +
        'User-Agent: photobooth\r\n' +
        'Connection: close\r\n\r\n',
      );
    });

    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return reject(new Error('digiCamControl ตอบไม่ครบ'));
      const head = raw.subarray(0, split).toString('latin1');
      const status = Number((head.match(/^HTTP\/\d\.\d\s+(\d+)/) || [])[1] || 0);
      resolve({ status, body: raw.subarray(split + 4) });
    };

    socket.setTimeout(timeout, () => {
      if (chunks.length) finish();
      else {
        settled = true;
        socket.destroy();
        reject(new Error(`digiCamControl ไม่ตอบใน ${timeout} ms`));
      }
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (err) => {
      if (chunks.length) return finish();
      settled = true;
      reject(err);
    });
  });
}

/** ยิงคำสั่งไป digiCamControl ผ่าน built-in webserver (Settings > Webserver > Enable) */
async function slc(cmd, p1 = '', p2 = '') {
  const url = `${config.dccHost}/?slc=${encodeURIComponent(cmd)}&param1=${encodeURIComponent(p1)}&param2=${encodeURIComponent(p2)}`;
  const { status, body } = await httpGet(url);
  const text = body.toString('utf8').trim();
  if (status !== 200) throw new Error(`digiCamControl HTTP ${status}: ${text}`);
  if (/^error/i.test(text)) throw new Error(`digiCamControl: ${text}`);
  return text;
}

/** ทางสำรอง: named pipe ผ่าน CameraControlRemoteCmd.exe (ไม่มี live view) */
async function remote(args) {
  await ensureDccRunning();
  let result;
  try {
    result = await runRemoteRaw(args);
  } catch (err) {
    // ถ้า GUI ล้มระหว่างงาน ให้เปิดใหม่และลองคำสั่งเดิมอีกครั้งหนึ่ง
    if (config.dccAutoStart && !await dccIsRunning()) {
      await ensureDccRunning();
      try { result = await runRemoteRaw(args); } catch (retryErr) { throw new Error(friendlyDccError(retryErr)); }
    } else if (args.includes('list') && args.includes('cameras')) {
      // ช่วงเปิดกล้อง named pipe อาจยังไม่พร้อม; list เป็นคำสั่งอ่านล้วน จึงลองซ้ำได้ปลอดภัย
      await sleep(600);
      try { result = await runRemoteRaw(args); } catch (retryErr) { throw new Error(friendlyDccError(retryErr)); }
    } else {
      throw new Error(friendlyDccError(err));
    }
  }
  const { stdout } = result;
  const out = stdout.trim();
  if (/error/i.test(out) && !/no error/i.test(out)) throw new Error(friendlyDccError(out));
  return out;
}

/**
 * digiCamControl มีสองทางคุย: webserver (มี live view แต่ต้อง bind พอร์ตได้)
 * กับ named pipe ผ่าน CameraControlRemoteCmd.exe (ไม่มี live view แต่ไม่ต้องใช้พอร์ต)
 * ถ้าตั้งเป็น auto จะลอง webserver ก่อน ล้มแล้วค่อยตกไป remotecmd
 */
let resolved = { transport: null, at: 0 };
const TRANSPORT_TTL = 15000;
let liveViewActive = false;
let liveViewStartPromise = null;
let primedLiveViewFrame = null;
let liveViewFrameCache = null;
let liveViewFrameCacheAt = 0;
let mjpegRequest = null;
let mjpegResponse = null;
let mjpegBuffer = Buffer.alloc(0);

async function pingWebserver() {
  try {
    await slc('list', 'cameras');
    return true;
  } catch {
    return false;
  }
}

async function resolveTransport() {
  if (config.dccTransport === 'remotecmd') return 'remotecmd';
  if (config.dccTransport === 'webserver') return 'webserver';
  // หลีกเลี่ยงการ probe webserver 5513: digiCamControl 2.1.7 มีบั๊ก socket แล้วปิดตัวเอง
  resolved = { transport: 'remotecmd', at: Date.now() };
  return 'remotecmd';
}

function mjpegUrl() {
  const url = new URL(config.dccHost);
  url.hostname = '127.0.0.1';
  url.port = String((Number(url.port) || 5513) + 1);
  url.pathname = '/live';
  url.search = '';
  return url;
}

function consumeMjpegChunk(chunk) {
  mjpegBuffer = Buffer.concat([mjpegBuffer, chunk]);
  let receivedFrame = false;
  while (mjpegBuffer.length) {
    const start = mjpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      mjpegBuffer = mjpegBuffer.subarray(Math.max(0, mjpegBuffer.length - 1));
      break;
    }
    const end = mjpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      if (start > 0) mjpegBuffer = mjpegBuffer.subarray(start);
      if (mjpegBuffer.length > 5 * 1024 * 1024) mjpegBuffer = Buffer.alloc(0);
      break;
    }
    liveViewFrameCache = Buffer.from(mjpegBuffer.subarray(start, end + 2));
    liveViewFrameCacheAt = Date.now();
    mjpegBuffer = mjpegBuffer.subarray(end + 2);
    receivedFrame = true;
  }
  return receivedFrame;
}

function openMjpegStream() {
  if (mjpegRequest && !mjpegRequest.destroyed) {
    return Promise.resolve(Boolean(liveViewFrameCache));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstFrameTimer);
      resolve(ok);
    };
    const reset = () => {
      mjpegRequest = null;
      mjpegResponse = null;
      mjpegBuffer = Buffer.alloc(0);
      liveViewActive = false;
    };
    const firstFrameTimer = setTimeout(() => {
      mjpegRequest?.destroy();
      reset();
      finish(false);
    }, 5000);
    firstFrameTimer.unref?.();

    const req = http.get(mjpegUrl(), { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reset();
        return finish(false);
      }
      mjpegResponse = res;
      req.setTimeout(0);
      res.on('data', (chunk) => {
        if (consumeMjpegChunk(chunk)) finish(true);
      });
      res.on('end', () => { reset(); finish(false); });
      res.on('error', () => { reset(); finish(false); });
    });
    mjpegRequest = req;
    req.on('timeout', () => req.destroy(new Error('MJPEG timeout')));
    req.on('error', () => { reset(); finish(false); });
  });
}

async function startDccLiveView() {
  if (liveViewActive) return true;
  if (liveViewStartPromise) return liveViewStartPromise;
  liveViewStartPromise = (async () => {
    // บน digiCamControl 2.1.7 ของเครื่องนี้ URL ?CMD=... ตอบ 200 แต่ไม่เปิดหน้าต่างเสมอ
    // Remote Utility เป็นช่องทางที่ทดสอบกับ EOS R แล้วว่าเปิด Live View จริง
    await remote(['/c', 'do', 'LiveViewWnd_Show']);
    liveViewFrameCache = null;
    liveViewFrameCacheAt = 0;
    // พอร์ต 5514 เป็น MJPEG server คนละ implementation กับ webserver 5513 ที่ crash
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(attempt === 0 ? 300 : 400);
      if (await openMjpegStream()) {
        primedLiveViewFrame = liveViewFrameCache;
        liveViewActive = true;
        return true;
      }
    }
    liveViewActive = false;
    return false;
  })().catch(() => {
    liveViewActive = false;
    return false;
  }).finally(() => {
    liveViewStartPromise = null;
  });
  return liveViewStartPromise;
}

async function stopDccLiveView() {
  // EOS R + digiCamControl 2.1.7 บนเครื่องนี้ล้มเมื่อสั่ง LiveViewWnd_Hide ซ้ำๆ
  // จึงคง Live View/MJPEG connection ไว้สำหรับช็อตถัดไป แต่หยุดส่งเฟรมจากหน้าเว็บได้
  primedLiveViewFrame = null;
}



async function listFiles(dir) {
  const out = new Map();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!IMAGE_EXT.has(path.extname(n).toLowerCase())) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      if (st.isFile()) out.set(n, st.size);
    } catch { /* ไฟล์หายระหว่างสแกน */ }
  }
  return out;
}

/** รอไฟล์ใหม่โผล่ แล้วรอจนขนาดนิ่ง (กล้องเขียนเสร็จ) */
async function waitForNewFile(dir, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await listFiles(dir);
    const fresh = [...now.keys()].filter((n) => !before.has(n));
    if (fresh.length) {
      const full = path.join(dir, fresh.sort()[fresh.length - 1]);
      let last = -1;
      for (let i = 0; i < 40; i++) {
        await sleep(150);
        let size;
        try { size = (await fsp.stat(full)).size; } catch { continue; }
        if (size > 0 && size === last) return full;
        last = size;
      }
      return full;
    }
    await sleep(200);
  }
  throw new Error('หมดเวลารอไฟล์จากกล้อง — เช็คว่ากล้องเปิดอยู่ digiCamControl เห็นกล้อง และโฟกัสเข้า');
}

export const camera = {
  async transport() {
    return resolveTransport();
  },

  async setSessionFolder(dir) {
    await fsp.mkdir(dir, { recursive: true });
    if ((await resolveTransport()) === 'webserver') {
      await slc('set', 'session.folder', dir);
      await slc('set', 'session.filenametemplate', 'PB_[Counter 4 digit]');
    } else {
      await remote(['/c', 'set', 'session.folder', dir]);
      await remote(['/c', 'set', 'session.filenametemplate', 'PB_[Counter 4 digit]']);
    }
  },

  /** ถ่าย 1 ช็อต คืน path ไฟล์ที่กล้องบันทึกลง dir */
  async capture(dir) {
    const before = await listFiles(dir);
    // digiCamControl แนะนำ LiveView_Capture ขณะหน้า Live View เปิดอยู่ (กล้องบางรุ่นไม่รับ capture ปกติในโหมดนี้)
    if (liveViewActive) await remote(['/c', 'do', 'LiveView_Capture']);
    else if ((await resolveTransport()) === 'webserver') await slc('capture');
    else await remote(['/c', 'capture']);
    return waitForNewFile(dir, before, config.captureTimeout);
  },

  async startLiveView() {
    return startDccLiveView();
  },

  async stopLiveView() {
    await stopDccLiveView();
  },

  /** เฟรม live view 1 เฟรม (null ถ้าไม่มี) */
  async liveViewFrame() {
    if (!await startDccLiveView()) return null;
    if (primedLiveViewFrame) {
      const frame = primedLiveViewFrame;
      primedLiveViewFrame = null;
      return frame;
    }
    return liveViewFrameCache;
  },

  async status() {
    const transport = await resolveTransport();
    try {
      const out = transport === 'webserver' ? await slc('list', 'cameras') : await remote(['/c', 'list', 'cameras']);
      const cameras = parseCameraList(out);
      return {
        ok: cameras.length > 0,
        transport,
        // โหมดเว็บใช้กล้อง iPad เป็น Live View; ไม่อ่าน DCC webserver เพื่อหลีกเลี่ยง crash
        liveView: false,
        cameras,
        error: cameras.length ? undefined : 'digiCamControl ไม่เห็นกล้อง — เช็คสาย USB / เปิดกล้อง / ตั้งเป็นโหมด PC connection',
      };
    } catch (err) {
      return { ok: false, transport, liveView: false, cameras: [], error: friendlyDccError(err) };
    }
  },
};
