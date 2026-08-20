import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const remoteCmdExe = () => path.join(config.dccPath, 'CameraControlRemoteCmd.exe');

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
  const { stdout } = await execFileAsync(remoteCmdExe(), args, { timeout: 20000, windowsHide: true });
  const out = stdout.trim();
  if (/error/i.test(out) && !/no error/i.test(out)) throw new Error(`digiCamControl: ${out}`);
  return out;
}

/**
 * digiCamControl มีสองทางคุย: webserver (มี live view แต่ต้อง bind พอร์ตได้)
 * กับ named pipe ผ่าน CameraControlRemoteCmd.exe (ไม่มี live view แต่ไม่ต้องใช้พอร์ต)
 * ถ้าตั้งเป็น auto จะลอง webserver ก่อน ล้มแล้วค่อยตกไป remotecmd
 */
let resolved = { transport: null, at: 0 };
const TRANSPORT_TTL = 15000;

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
  if (resolved.transport && Date.now() - resolved.at < TRANSPORT_TTL) return resolved.transport;
  const transport = (await pingWebserver()) ? 'webserver' : 'remotecmd';
  resolved = { transport, at: Date.now() };
  return transport;
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
      await slc('set', 'session.filenametemplate', '[Date yyyy-MM-dd-HH-mm-ss]');
    } else {
      await remote(['/c', 'set', 'session.folder', dir]);
      await remote(['/c', 'set', 'session.filenametemplate', '[Date yyyy-MM-dd-HH-mm-ss]']);
    }
  },

  /** ถ่าย 1 ช็อต คืน path ไฟล์ที่กล้องบันทึกลง dir */
  async capture(dir) {
    const before = await listFiles(dir);
    if ((await resolveTransport()) === 'webserver') await slc('capture');
    else await remote(['/c', 'capture']);
    return waitForNewFile(dir, before, config.captureTimeout);
  },

  async startLiveView() {
    if ((await resolveTransport()) !== 'webserver') return false;
    try {
      await slc('LiveViewWnd_Show');
      return true;
    } catch {
      return false;
    }
  },

  async stopLiveView() {
    if ((await resolveTransport()) !== 'webserver') return;
    try { await slc('LiveViewWnd_Hide'); } catch { /* ไม่สำคัญ */ }
  },

  /** เฟรม live view 1 เฟรม (null ถ้าไม่มี) */
  async liveViewFrame() {
    if ((await resolveTransport()) !== 'webserver') return null;
    try {
      const { status, body } = await httpGet(`${config.dccHost}/liveview.jpg`, 4000);
      if (status !== 200 || body.length === 0) return null;
      return body;
    } catch {
      return null;
    }
  },

  async status() {
    const transport = await resolveTransport();
    try {
      const out = transport === 'webserver' ? await slc('list', 'cameras') : await remote(['/c', 'list', 'cameras']);
      const cameras = out.split('\n').map((s) => s.trim()).filter(Boolean);
      return {
        ok: cameras.length > 0,
        transport,
        liveView: transport === 'webserver',
        cameras,
        error: cameras.length ? undefined : 'digiCamControl ไม่เห็นกล้อง — เช็คสาย USB / เปิดกล้อง / ตั้งเป็นโหมด PC connection',
      };
    } catch (err) {
      return { ok: false, transport, liveView: false, cameras: [], error: err.message };
    }
  },
};


