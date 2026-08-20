import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, ROOT, saveEnv } from './config.js';
import * as watch from './watcher.js';
import * as nc from './nextcloud.js';
import { camera } from './camera.js';
import { bus, snapshot, reset, startSession, finishNow, discard, sendToPrint, fakeShot, scanUnfinishedSessions, recoverSession } from './session.js';

app.get('/api/unfinished', (req, res) => {
  try {
    const list = scanUnfinishedSessions();
    res.json({ ok: true, unfinished: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/recover/:id', async (req, res) => {
  try {
    const result = await recoverSession(req.params.id, req.body?.action);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'kiosk')));

app.get('/api/config', (req, res) => {
  res.json({
    shots: config.shots,
    eventName: config.eventName,
    boothName: config.boothName,
    reviewSeconds: config.reviewSeconds,
    sessionIdleSeconds: config.sessionIdleSeconds,
    printLayout: config.printLayout,
    printShots: config.printShots,
    printThemeColor: config.printThemeColor,
    printOnDone: config.printOnDone,
    watchDir: config.watchDir,
    captureSource: config.captureSource,
    countdown: config.countdown,
    liveView: config.captureSource === 'digicam' && config.dccTransport === 'webserver',
  });
});

app.get('/api/health', async (req, res) => {
  const [cloud, cam] = await Promise.all([
    nc.health(),
    config.captureSource === 'digicam' ? camera.status() : Promise.resolve({ ok: true, transport: config.captureSource, cameras: [] }),
  ]);
  res.json({
    camera: cam,
    watch: watch.status(),
    nextcloud: cloud,
    ffmpeg: fs.existsSync(config.ffmpeg),
    perSessionShare: nc.hasOwnerCredentials(),
  });
});

app.post('/api/start', async (req, res) => {
  try {
    const id = await startSession();
    res.json({ ok: true, id });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.get('/api/liveview.jpg', async (req, res) => {
  const buf = await camera.liveViewFrame();
  if (!buf) return res.status(503).end();
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(buf);
});

app.get('/api/state', (req, res) => res.json(snapshot()));

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(snapshot());
  const onUpdate = (s) => send(s);
  bus.on('update', onUpdate);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('update', onUpdate);
  });
});

app.post('/api/finish', async (req, res) => {
  try {
    await finishNow();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/discard', (req, res) => {
  try {
    discard();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/reset', (req, res) => {
  reset();
  res.json({ ok: true });
});

app.post('/api/print', async (req, res) => {
  try {
    const job = await sendToPrint(req.body?.copies);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/mock-shot', async (req, res) => {
  try {
    const file = await fakeShot();
    res.json({ ok: true, file });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** เปลี่ยนค่าตั้งต้นจากหน้า operator แล้วเขียนกลับ .env */
app.post('/api/settings', (req, res) => {
  const allowed = ['WATCH_DIR', 'SHOTS', 'PRINT_SHOTS', 'EVENT_NAME', 'SESSION_IDLE_SECONDS', 'PRINT_ON_DONE', 'PRINT_LAYOUT', 'PRINT_THEME_COLOR', 'REVIEW_SECONDS', 'CAPTURE_SOURCE', 'COUNTDOWN'];
  const patch = {};
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined && req.body[key] !== null) patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'ไม่มีค่าที่จะบันทึก' });

  if (patch.WATCH_DIR && !fs.existsSync(patch.WATCH_DIR)) {
    return res.status(400).json({ ok: false, error: `ไม่พบโฟลเดอร์: ${patch.WATCH_DIR}` });
  }

  saveEnv(patch);
  if (config.captureSource === 'folder') watch.start(config.watchDir);
  else watch.stop();
  res.json({ ok: true, config: { watchDir: config.watchDir, shots: config.shots, eventName: config.eventName } });
});

/** ช่วยเลือกโฟลเดอร์จากหน้าเว็บ (ไม่มี native picker ในเบราว์เซอร์) */
app.get('/api/browse', async (req, res) => {
  const dir = req.query.dir;
  try {
    if (!dir) {
      const drives = [];
      for (const letter of 'CDEFGH') {
        const root = `${letter}:\\`;
        if (fs.existsSync(root)) drives.push({ name: root, path: root });
      }
      return res.json({ current: null, parent: null, dirs: drives });
    }
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .slice(0, 300);
    const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
    res.json({ current: dir, parent, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/session/:id/file/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const id = path.basename(req.params.id);
  const file = path.join(config.sessionsDir, id, name);
  if (!file.startsWith(config.sessionsDir) || !fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.listen(config.port, config.host, () => {
  const maskedToken = config.nc.token ? `${config.nc.token.slice(0, 3)}***` : '(none)';
  console.log(`photobooth  จอลูกค้า http://${config.host}:${config.port}  |  จอช่าง http://${config.host}:${config.port}/operator.html`);
  if (config.captureSource === 'folder') {
    const started = watch.start(config.watchDir);
    if (started.ok) console.log(`  เฝ้าโฟลเดอร์: ${config.watchDir}`);
    else console.log(`  !! ${started.error} — ตั้งค่าได้ที่หน้าจอช่าง`);
  } else {
    console.log(`  แหล่งภาพ: ${config.captureSource}${config.captureSource === 'digicam' ? ` (${config.dccHost})` : ''}`);
  }
  console.log(`  Nextcloud: ${config.nc.base}/s/${maskedToken} (โฟลเดอร์ ${config.nc.root})`);
  console.log(`  ${config.shots} ช็อต/เซสชัน  ปิดเซสชันอัตโนมัติถ้าเงียบ ${config.sessionIdleSeconds} วิ`);
});
