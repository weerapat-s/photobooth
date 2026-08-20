import express from 'express';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const raw = await nc.getFile(claimedPath);
  const job = JSON.parse(raw.toString('utf8'));
  const copies = Math.max(1, Math.min(config.maxCopies, Number(job.copies) || 1));

  await fsp.mkdir(tmpRoot, { recursive: true });
  const local = path.join(tmpRoot, `${job.sessionId}.jpg`);
  await fsp.writeFile(local, await nc.getFile(job.printFile));

  const detail = await printImage(local, copies);
  await nc.move(claimedPath, `${paths.done}/${path.posix.basename(claimedPath)}`, { overwrite: true });
  remember({ id: job.sessionId, queueNumber: job.queueNumber || parseQueueNumber(path.basename(claimedPath)), at: new Date().toISOString(), ok: true, copies, detail });
  log(`พิมพ์แล้ว #${job.queueNumber || '?'} ${job.sessionId} x${copies} — ${detail}`);
  await fsp.rm(local, { force: true });
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
  const maskedToken = config.nc.token ? `${config.nc.token.slice(0, 3)}***` : '';
  res.json({
    ...state,
    printer: config.printerName || '(เครื่องพิมพ์เริ่มต้น)',
    paper: config.paper,
    auto: config.auto,
    dryRun: config.dryRun,
    acceptBooths: config.acceptBooths,
    queueDir: paths.queue,
    share: `${config.nc.base}/s/${maskedToken}`,
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
    await runJob(claimedPath);
    res.json({ ok: true });
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
  const maskedToken = config.nc.token ? `${config.nc.token.slice(0, 3)}***` : '(none)';
  console.log(`บูทปริ้น Admin "${config.printerId}"  http://${config.host}:${config.port}`);
  console.log(`  เครื่องพิมพ์: ${config.printerName || '(เริ่มต้นของ Windows)'}  กระดาษ ${config.paper}  auto=${config.auto}${config.dryRun ? '  DRY RUN' : ''}`);
  console.log(`  คิว: ${config.nc.base}/s/${maskedToken} -> ${paths.queue}`);
  if (config.acceptBooths.length) console.log(`  รับเฉพาะบูท: ${config.acceptBooths.join(', ')}`);

  for (const dir of [paths.queue, paths.claimed, paths.done, paths.failed]) {
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
