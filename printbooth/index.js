import express from 'express';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { config, paths, ROOT } from './config.js';
import * as nc from './nextcloud.js';

const execFileAsync = promisify(execFile);
const tmpRoot = path.join(os.tmpdir(), 'photobooth-print');

const state = {
  printerId: config.printerId,
  running: false,
  lastPoll: null,
  lastError: null,
  pending: [],
  mine: [],
  history: [],
};

const log = (...args) => console.log(`[${config.printerId}]`, ...args);

function remember(entry) {
  state.history.unshift(entry);
  state.history = state.history.slice(0, 40);
}

async function printImage(file, copies) {
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'print.ps1'),
    '-ImagePath', file,
    '-Copies', String(copies),
    '-Paper', config.paper,
  ];
  if (config.printerName) args.push('-PrinterName', config.printerName);
  if (config.dryRun) args.push('-DryRun');
  const { stdout } = await execFileAsync('powershell.exe', args, { timeout: 180000, windowsHide: true });
  return stdout.trim();
}

/** ชื่อไฟล์ตอนจอง: <printerId>__<เวลา>__<ชื่อเดิม> */
const claimName = (jobFile) => `${config.printerId}__${Date.now()}__${jobFile}`;
const claimOwner = (name) => name.split('__')[0];
const claimTime = (name) => Number(name.split('__')[1] || 0);
/** ชื่อไฟล์งานขึ้นต้นด้วย Q<เลขคิว>__ เสมอ (เจ้าเดิม, ถูกจองแล้วก็ยังมีส่วนนี้ต่อท้าย) */
const parseQueueNumber = (name) => Number((name.match(/Q(\d+)__/) || [])[1]) || null;

function accepts(job) {
  if (!config.acceptBooths.length) return true;
  return config.acceptBooths.includes(job.booth);
}

/** จองงานหนึ่งชิ้น — ถ้า MOVE ไม่สำเร็จแปลว่าเครื่องอื่นคว้าไปแล้ว */
async function claim(jobFile) {
  const target = `${paths.claimed}/${claimName(jobFile)}`;
  const got = await nc.move(`${paths.queue}/${jobFile}`, target);
  return got ? target : null;
}

async function runJob(claimedPath) {
  let stage = 'claimed';
  let localFile = null;
  let heartbeatTimer = null;
  let heartbeatWrite = Promise.resolve();
  let job = null;
  const fileName = path.posix.basename(claimedPath);

  try {
    let raw;
    try {
      raw = await nc.getFile(claimedPath);
    } catch (err) {
      log(`ดาวน์โหลด job json ล้มเหลว (${fileName}): ${err.message}`);
      throw { stage: 'downloading', error: err };
    }

    try {
      job = JSON.parse(raw.toString('utf8'));
    } catch (parseErr) {
      log(`ไฟล์ JSON ไม่ถูกต้อง (${fileName}): ${parseErr.message}`);
      throw { stage: 'invalid_json', error: parseErr };
    }
    if (!job.printFile || String(job.printFile).includes('..') || !String(job.printFile).startsWith(`${config.nc.root}/`)) {
      throw { stage: 'invalid_job', error: new Error('printFile อยู่นอกโฟลเดอร์คิวที่อนุญาต') };
    }
    if (job.paper && job.paper !== config.paper) {
      throw { stage: 'invalid_job', error: new Error(`งานใช้กระดาษ ${job.paper} แต่เครื่องตั้งไว้ ${config.paper}`) };
    }

    const copies = Math.max(1, Math.min(config.maxCopies, Number(job.copies) || 1));
    const jobId = job.jobId || job.sessionId || fileName;

    await fsp.mkdir(tmpRoot, { recursive: true });
    localFile = path.join(tmpRoot, `${jobId}-${Date.now()}.jpg`);

    // Download image with retry
    stage = 'downloading';
    let imageBuf = null;
    for (let retry = 1; retry <= 3; retry++) {
      try {
        imageBuf = await nc.getFile(job.printFile);
        break;
      } catch (err) {
        if (retry === 3) throw { stage: 'downloading', error: err };
        await new Promise((r) => setTimeout(r, 1000 * retry));
      }
    }

    if (job.checksumSha256) {
      const actual = createHash('sha256').update(imageBuf).digest('hex');
      if (actual !== job.checksumSha256) {
        throw { stage: 'invalid_job', error: new Error('checksum ของรูปไม่ตรงกับใบงาน') };
      }
    }

    await fsp.writeFile(localFile, imageBuf);

    // เขียน marker ก่อนเรียก spooler; ถ้า marker เขียนไม่ได้ยังถือว่ายังไม่เริ่มพิมพ์
    stage = 'ready';
    job.status = 'printing';
    job.lastHeartbeat = new Date().toISOString();
    await nc.putText(JSON.stringify(job, null, 2), claimedPath);

    stage = 'printing';
    const heartbeatMs = Math.max(5000, Math.min(30000, Math.floor(config.staleClaimMinutes * 60000 / 3)));
    heartbeatTimer = setInterval(() => {
      job.lastHeartbeat = new Date().toISOString();
      heartbeatWrite = heartbeatWrite.then(() => nc.putText(JSON.stringify(job, null, 2), claimedPath))
        .catch((err) => log(`อัปเดต heartbeat ไม่สำเร็จ (${fileName}): ${err.message}`));
    }, heartbeatMs);
    const detail = await printImage(localFile, copies);
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    await heartbeatWrite;

    job.status = 'done';
    job.lastHeartbeat = new Date().toISOString();
    await nc.putText(JSON.stringify(job, null, 2), claimedPath);
    const moved = await nc.move(claimedPath, `${paths.done}/${fileName}`, { overwrite: true });
    if (!moved) throw new Error('งานหายจาก claimed หลังส่งเข้า spooler');
    remember({ id: job.sessionId, queueNumber: job.queueNumber || parseQueueNumber(fileName), at: new Date().toISOString(), ok: true, copies, detail });
    log(`พิมพ์แล้ว #${job.queueNumber || '?'} ${job.sessionId} x${copies} — ${detail}`);
    return { ok: true, status: 'done', detail };
  } catch (errObj) {
    const err = errObj.error || errObj;
    const currentStage = errObj.stage || stage;

    if (currentStage === 'printing') {
      log(`งาน ${fileName} ขัดข้องระหว่าง/หลังเริ่มพิมพ์ ส่งไป review: ${err.message}`);
      await moveToReview(claimedPath, err);
      return { ok: false, status: 'review', error: err.message };
    } else if (currentStage === 'invalid_json' || currentStage === 'invalid_job') {
      log(`งาน ${fileName} ไม่ถูกต้อง ส่งไป failed: ${err.message}`);
      await failJob(claimedPath, err);
      return { ok: false, status: 'failed', error: err.message };
    } else {
      if (job) {
        job.retryCount = Number(job.retryCount || 0) + 1;
        job.lastError = err.message;
        if (job.retryCount >= config.maxDownloadRetries) {
          await nc.putText(JSON.stringify(job, null, 2), claimedPath).catch(() => {});
          await failJob(claimedPath, new Error(`ดาวน์โหลดล้มเหลว ${job.retryCount} ครั้ง: ${err.message}`));
          return { ok: false, status: 'failed', error: err.message };
        }
        await nc.putText(JSON.stringify(job, null, 2), claimedPath).catch(() => {});
      }
      log(`งาน ${fileName} ดาวน์โหลดไม่สำเร็จ ย้ายกลับคิวรอ retry: ${err.message}`);
      await requeueSingleJob(claimedPath);
      return { ok: false, status: 'queued', error: err.message };
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (localFile) {
      await fsp.rm(localFile, { force: true }).catch(() => {});
    }
  }
}

async function moveToReview(claimedPath, err) {
  const name = path.posix.basename(claimedPath);
  remember({ id: name, queueNumber: parseQueueNumber(name), at: new Date().toISOString(), ok: false, detail: `REVIEW: ${err.message}` });
  try {
    await nc.move(claimedPath, `${paths.review}/${name}`, { overwrite: true });
  } catch (moveErr) {
    log('ย้ายงานไป review ไม่ได้:', moveErr.message);
  }
}

async function requeueSingleJob(claimedPath) {
  const name = path.posix.basename(claimedPath);
  const original = name.split('__').slice(2).join('__') || name;
  try {
    await nc.move(claimedPath, `${paths.queue}/${original}`, { overwrite: true });
  } catch (moveErr) {
    log('เอางานกลับคิวไม่ได้:', moveErr.message);
  }
}

async function failJob(claimedPath, err) {
  const name = path.posix.basename(claimedPath);
  log(`งาน ${name} ล้มเหลว: ${err.message}`);
  remember({ id: name, queueNumber: parseQueueNumber(name), at: new Date().toISOString(), ok: false, detail: err.message });
  try {
    await nc.move(claimedPath, `${paths.failed}/${path.posix.basename(claimedPath)}`, { overwrite: true });
  } catch (moveErr) {
    log('ย้ายงานที่ล้มเหลวไม่ได้:', moveErr.message);
  }
}

/** งานที่เครื่องไหนจองค้างไว้นานเกินไป (เครื่องนั้นดับ) เอากลับเข้าคิวให้คนอื่นทำต่อ */
async function requeueStale() {
  const cutoff = Date.now() - config.staleClaimMinutes * 60000;
  const items = await nc.list(paths.claimed).catch(() => []);
  let requeued = 0;
  for (const item of items) {
    if (item.isDir || !item.name.endsWith('.json')) continue;
    const when = claimTime(item.name);
    if (!when || when > cutoff) continue;

    // ตรวจสอบว่างานค้างอยู่ในช่วง printing หรือไม่ ถ้าเริ่มพิมพ์ไปแล้วส่งไป review
    try {
      const content = JSON.parse((await nc.getFile(`${paths.claimed}/${item.name}`)).toString('utf8'));
      const heartbeatAt = Date.parse(content.lastHeartbeat || '') || 0;
      if (heartbeatAt > cutoff) continue;
      if (content.status === 'printing') {
        log(`งานค้าง ${item.name} เคยเริ่มพิมพ์ไปแล้ว ย้ายไป review`);
        await moveToReview(`${paths.claimed}/${item.name}`, new Error('Stale claimed job during printing stage'));
        continue;
      }
    } catch (e) {
      // ถ้าอ่าน json ไม่ได้ก็ย้ายกลับคิวตามปกติ
    }

    const original = item.name.split('__').slice(2).join('__') || item.name;
    const ok = await nc.move(`${paths.claimed}/${item.name}`, `${paths.queue}/${original}`).catch(() => false);
    if (ok) {
      requeued++;
      log(`เอางานค้างของ ${claimOwner(item.name)} กลับเข้าคิว: ${original}`);
    }
  }
  return requeued;
}

async function poll() {
  if (state.running) return;
  state.running = true;
  try {
    const items = (await nc.list(paths.queue)).filter((f) => !f.isDir && f.name.endsWith('.json'));
    state.pending = items.map((i) => i.name);
    state.lastPoll = new Date().toISOString();
    state.lastError = null;
    if (!config.auto) return;

    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      let claimedPath = null;
      try {
        // อ่านงานก่อนจอง เพื่อเช็คว่าเครื่องนี้รับบูทนี้ไหม
        if (config.acceptBooths.length) {
          const peek = JSON.parse((await nc.getFile(`${paths.queue}/${item.name}`)).toString('utf8'));
          if (!accepts(peek)) continue;
        }
        claimedPath = await claim(item.name);
        if (!claimedPath) continue; // เครื่องอื่นคว้าไปแล้ว
        state.mine = [...state.mine, item.name];
        await runJob(claimedPath);
      } catch (err) {
        if (claimedPath) await failJob(claimedPath, err);
        else remember({ id: item.name, queueNumber: parseQueueNumber(item.name), at: new Date().toISOString(), ok: false, detail: err.message });
      } finally {
        state.mine = state.mine.filter((n) => n !== item.name);
      }
    }
  } catch (err) {
    state.lastError = err.message;
    log('ดึงคิวไม่ได้:', err.message);
  } finally {
    state.running = false;
  }
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'ui.html')));

app.get('/api/status', async (req, res) => {
  res.json({
    ...state,
    printer: config.printerName || '(เครื่องพิมพ์เริ่มต้น)',
    paper: config.paper,
    auto: config.auto,
    dryRun: config.dryRun,
    acceptBooths: config.acceptBooths,
    boardPort: config.boardPort,
    queueDir: paths.queue,
  });
});

app.get('/api/claimed', async (req, res) => {
  const items = await nc.list(paths.claimed).catch(() => []);
  res.json(items.filter((i) => !i.isDir).map((i) => ({
    name: i.name,
    owner: claimOwner(i.name),
    queueNumber: parseQueueNumber(i.name),
    since: claimTime(i.name) ? new Date(claimTime(i.name)).toISOString() : null,
  })));
});

app.get('/api/problems', async (req, res) => {
  const [failed, review] = await Promise.all([
    nc.list(paths.failed).catch(() => []),
    nc.list(paths.review).catch(() => []),
  ]);
  const normalize = (bucket, items) => items.filter((i) => !i.isDir).map((i) => ({
    bucket,
    name: i.name,
    queueNumber: parseQueueNumber(i.name),
    modified: i.modified || null,
  }));
  res.json([...normalize('review', review), ...normalize('failed', failed)]);
});

app.post('/api/retry/:bucket/:name', async (req, res) => {
  const bucket = req.params.bucket;
  const name = path.basename(req.params.name);
  if (!['failed', 'review'].includes(bucket)) return res.status(400).json({ ok: false, error: 'bucket ไม่ถูกต้อง' });
  const source = bucket === 'failed' ? paths.failed : paths.review;
  const original = name.split('__').slice(2).join('__') || name;
  const moved = await nc.move(`${source}/${name}`, `${paths.queue}/${original}`, { overwrite: false }).catch(() => false);
  if (!moved) return res.status(409).json({ ok: false, error: 'ย้ายงานกลับคิวไม่ได้หรือมีงานชื่อนี้อยู่แล้ว' });
  res.json({ ok: true, status: 'queued' });
});

app.post('/api/resolve/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const moved = await nc.move(`${paths.review}/${name}`, `${paths.done}/${name}`, { overwrite: false }).catch(() => false);
  if (!moved) return res.status(409).json({ ok: false, error: 'ยืนยันงานไม่ได้' });
  res.json({ ok: true, status: 'done' });
});

/**
 * ข้อมูลสำหรับจอบอร์ดคิวเต็มจอ (queue.html) — รวมงานที่รอ/กำลังพิมพ์ และพิมพ์เสร็จ
 */
async function handleGetBoard(req, res) {
  try {
    const [queued, claimed, done] = await Promise.all([
      nc.list(paths.queue).catch(() => []),
      nc.list(paths.claimed).catch(() => []),
      nc.list(paths.done).catch(() => []),
    ]);
    const waiting = [...queued, ...claimed]
      .filter((i) => !i.isDir)
      .map((i) => parseQueueNumber(i.name))
      .filter(Boolean)
      .sort((a, b) => a - b);

    const served = done
      .filter((i) => !i.isDir)
      .map((i) => ({ queueNumber: parseQueueNumber(i.name), at: i.modified }))
      .filter((i) => i.queueNumber)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 8);

    res.json({ waiting: [...new Set(waiting)], latest: served[0] || null, recentServed: served });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/board', handleGetBoard);
app.get('/queue.html', (req, res) => res.sendFile(path.join(ROOT, 'queue.html')));

app.post('/api/poll', async (req, res) => {
  await poll();
  res.json({ ok: true, pending: state.pending });
});

app.post('/api/requeue-stale', async (req, res) => {
  try {
    const n = await requeueStale();
    res.json({ ok: true, requeued: n });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/print/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  let claimedPath = null;
  try {
    claimedPath = await claim(name);
    if (!claimedPath) throw new Error('งานนี้ถูกเครื่องอื่นหยิบไปแล้ว');
    const result = await runJob(claimedPath);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    if (claimedPath) await failJob(claimedPath, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Board App (Read-only for LAN display, binding to 0.0.0.0)
// ---------------------------------------------------------------------------
const boardApp = express();
boardApp.use(express.json());
boardApp.get('/', (req, res) => res.sendFile(path.join(ROOT, 'queue.html')));
boardApp.get('/queue.html', (req, res) => res.sendFile(path.join(ROOT, 'queue.html')));
boardApp.get('/api/board', handleGetBoard);

app.listen(config.port, config.host, async () => {
  console.log(`บูทปริ้น Admin "${config.printerId}"  http://${config.host}:${config.port}`);
  console.log(`  เครื่องพิมพ์: ${config.printerName || '(เริ่มต้นของ Windows)'}  กระดาษ ${config.paper}  auto=${config.auto}${config.dryRun ? '  DRY RUN' : ''}`);
  console.log(`  คิว Nextcloud: ${config.nc.base || '(ยังไม่ได้ตั้ง)'} -> ${paths.queue}`);
  if (config.acceptBooths.length) console.log(`  รับเฉพาะบูท: ${config.acceptBooths.join(', ')}`);

  for (const dir of [paths.queue, paths.claimed, paths.done, paths.failed, paths.review]) {
    await nc.ensureDir(dir).catch((e) => console.error('[print] เตรียมโฟลเดอร์ไม่ได้:', e.message));
  }
  await requeueStale().catch(() => {});
  poll();
  setInterval(poll, config.pollMs);
  setInterval(() => requeueStale().catch(() => {}), Math.max(config.pollMs * 12, 60000));
});

boardApp.listen(config.boardPort, config.boardHost, () => {
  console.log(`จอบอร์ดคิว (Read-only)  http://${config.boardHost}:${config.boardPort}/queue.html`);
});
