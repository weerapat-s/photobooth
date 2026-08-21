import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, ROOT, saveEnv } from './config.js';
import * as watch from './watcher.js';
import * as nc from './nextcloud.js';
import { camera } from './camera.js';
import { bus, snapshot, reset, startSession, captureSlot, deletePhoto, finishNow, discard, sendToPrint, fakeShot, scanUnfinishedSessions, recoverSession, ingestIpadPhoto } from './session.js';
import { runPreflightChecks } from './preflight.js';
import { generateCalibrationSheet } from './calibration.js';
import { runCleanup } from './retention.js';

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'kiosk')));
let lastPreflight = null;
const WEB_AUTH_COOKIE = 'photobooth_web_auth';
const WEB_AUTH_DAYS = 30;
const pairAttempts = new Map();

function secretMatches(actualValue) {
  const actual = Buffer.from(String(actualValue || ''));
  const expected = Buffer.from(config.ipadApiToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pairCodeMatches(actualValue) {
  if (!config.webPairCode) return false;
  const actual = Buffer.from(String(actualValue || ''));
  const expected = Buffer.from(config.webPairCode);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signWebPayload(payload) {
  return createHmac('sha256', config.ipadApiToken).update(payload).digest('base64url');
}

function makeWebAuthCookie() {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    expiresAt: Date.now() + WEB_AUTH_DAYS * 86400000,
  })).toString('base64url');
  return `${payload}.${signWebPayload(payload)}`;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function hasValidWebCookie(req) {
  if (!config.ipadApiToken) return false;
  const value = parseCookies(req)[WEB_AUTH_COOKIE] || '';
  const [payload, signature] = value.split('.');
  if (!payload || !signature || !secretMatchesSignature(signature, signWebPayload(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.version === 1 && Number(data.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function secretMatchesSignature(actualValue, expectedValue) {
  const actual = Buffer.from(String(actualValue || ''));
  const expected = Buffer.from(String(expectedValue || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireWebKiosk(req, res, next) {
  if (!config.ipadApiToken) return res.status(503).json({ ok: false, error: 'ยังไม่ได้ตั้งรหัสเชื่อมต่อ WEB/IPAD_API_TOKEN' });
  if (!hasValidWebCookie(req)) return res.status(401).json({ ok: false, error: 'ต้องจับคู่ iPad เครื่องนี้ก่อน' });
  next();
}

function requireIpadToken(req, res, next) {
  if (!config.ipadApiToken) {
    return res.status(503).json({ ok: false, error: 'ยังไม่ได้ตั้ง IPAD_API_TOKEN' });
  }
  const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secretMatches(token)) {
    return res.status(401).json({ ok: false, error: 'iPad token ไม่ถูกต้อง' });
  }
  next();
}

function requirePairedWhenSelfService(req, res, next) {
  if (config.kioskMode === 'self_service') return requireWebKiosk(req, res, next);
  next();
}

function blockLegacyMutationInIpadMode(req, res, next) {
  if (config.kioskMode === 'self_service' || config.captureSource === 'ipad' || config.captureSource === 'web') {
    return res.status(403).json({ ok: false, error: 'โหมด iPad/Web รับคำสั่งผ่าน API ของอุปกรณ์เท่านั้น' });
  }
  next();
}

app.post('/api/web/pair', (req, res) => {
  if (!config.ipadApiToken) return res.status(503).json({ ok: false, error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสเชื่อมต่อ' });
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (pairAttempts.get(key) || []).filter((time) => now - time < 60000);
  if (recent.length >= 5) return res.status(429).json({ ok: false, error: 'ลองรหัสมากเกินไป กรุณารอ 1 นาที' });
  recent.push(now);
  pairAttempts.set(key, recent);
  if (!secretMatches(req.body?.token) && !pairCodeMatches(req.body?.token)) {
    return res.status(401).json({ ok: false, error: 'รหัสเชื่อมต่อไม่ถูกต้อง' });
  }
  pairAttempts.delete(key);
  const secure = req.secure || String(req.get('x-forwarded-proto')).toLowerCase() === 'https';
  const flags = [`${WEB_AUTH_COOKIE}=${encodeURIComponent(makeWebAuthCookie())}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${WEB_AUTH_DAYS * 86400}`];
  if (secure) flags.push('Secure');
  res.set('Set-Cookie', flags.join('; ')).json({ ok: true });
});

app.post('/api/web/unpair', requireWebKiosk, (req, res) => {
  res.set('Set-Cookie', `${WEB_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`).json({ ok: true });
});

app.get('/api/web/bootstrap', requireWebKiosk, (req, res) => {
  res.json({
    ok: true,
    config: {
      shots: config.shots,
      countdown: config.countdown,
      eventName: config.eventName,
      printOnDone: config.printOnDone,
      reviewSeconds: config.reviewSeconds,
      cameraFacing: config.webCameraFacing,
      mirror: config.webMirror,
      devicePreview: config.captureSource === 'digicam' || config.captureSource === 'web',
    },
    state: snapshot(),
  });
});

app.post('/api/web/session', requireWebKiosk, async (req, res) => {
  try {
    const id = await startSession();
    res.json({ ok: true, id, state: snapshot() });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.put('/api/web/session/photo/:slot', requireWebKiosk,
  express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    if (config.captureSource !== 'web') return res.status(409).json({ ok: false, error: 'route อัปโหลดรูปใช้ได้เฉพาะ CAPTURE_SOURCE=web' });
    try {
      await ingestIpadPhoto(req.params.slot, req.body);
      res.json({ ok: true, state: snapshot() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

app.post('/api/web/capture', requireWebKiosk, async (req, res) => {
  if (config.captureSource === 'web' || config.captureSource === 'ipad') {
    return res.status(409).json({ ok: false, error: 'โหมดนี้ต้องส่งไฟล์ภาพจากอุปกรณ์' });
  }
  try {
    const file = await captureSlot(req.body?.slot ?? null);
    res.json({ ok: true, file, state: snapshot() });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.get('/api/web/camera/status', requireWebKiosk, async (req, res) => {
  if (config.captureSource !== 'digicam') {
    return res.json({ ok: true, transport: config.captureSource, liveView: false, cameras: [] });
  }
  const status = await camera.status();
  res.status(status.ok ? 200 : 503).json(status);
});

app.get('/api/web/liveview.jpg', requireWebKiosk, async (req, res) => {
  if (config.captureSource === 'digicam') return res.status(410).end();
  const buf = await camera.liveViewFrame();
  if (!buf) return res.status(503).end();
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(buf);
});

app.post('/api/web/session/finish', requireWebKiosk, async (req, res) => {
  try {
    await finishNow();
    res.json({ ok: true, state: snapshot() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/web/session', requireWebKiosk, (req, res) => {
  try {
    discard();
    res.json({ ok: true, state: snapshot() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/web/session/reset', requireWebKiosk, (req, res) => {
  reset();
  res.json({ ok: true, state: snapshot() });
});

app.post('/api/web/print', requireWebKiosk, async (req, res) => {
  try {
    const job = await sendToPrint(req.body?.copies);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/web/events', requireWebKiosk, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(snapshot());
  const onUpdate = (state) => send(state);
  bus.on('update', onUpdate);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); bus.off('update', onUpdate); });
});

app.get('/api/ipad/bootstrap', requireIpadToken, (req, res) => {
  res.json({
    ok: true,
    config: {
      shots: config.shots,
      countdown: config.countdown,
      eventName: config.eventName,
      printOnDone: config.printOnDone,
      reviewSeconds: config.reviewSeconds,
    },
    state: snapshot(),
  });
});

app.post('/api/ipad/session', requireIpadToken, async (req, res) => {
  try {
    const id = await startSession();
    res.json({ ok: true, id, state: snapshot() });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.put(
  '/api/ipad/session/photo/:slot',
  requireIpadToken,
  express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '40mb' }),
  async (req, res) => {
    try {
      await ingestIpadPhoto(req.params.slot, req.body);
      res.json({ ok: true, state: snapshot() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

app.post('/api/ipad/session/finish', requireIpadToken, async (req, res) => {
  try {
    await finishNow();
    res.json({ ok: true, state: snapshot() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/ipad/session', requireIpadToken, (req, res) => {
  try {
    discard();
    res.json({ ok: true, state: snapshot() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/ipad/session/reset', requireIpadToken, (req, res) => {
  reset();
  res.json({ ok: true, state: snapshot() });
});

app.post('/api/cleanup', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const dryRun = req.query.dryRun !== 'false';
    const result = await runCleanup({ dryRun, activeSessionId: snapshot().session?.id || null });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/preflight', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const report = await runPreflightChecks({ deep: req.query.deep === 'true' });
    lastPreflight = report;
    res.json(report);
  } catch (err) {
    res.status(500).json({ status: 'BLOCKED', error: err.message });
  }
});

app.get('/api/calibration', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const layout = req.query.layout || config.printLayout;
    const buf = await generateCalibrationSheet(layout);
    res.set('Content-Type', 'image/jpeg').send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/unfinished', blockLegacyMutationInIpadMode, (req, res) => {
  try {
    const list = scanUnfinishedSessions();
    res.json({ ok: true, unfinished: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/recover/:id', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const result = await recoverSession(req.params.id, req.body?.action);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

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
    kioskMode: config.kioskMode,
    countdown: config.countdown,
    webCameraFacing: config.webCameraFacing,
    webMirror: config.webMirror,
    cameraFacing: config.webCameraFacing,
    mirror: config.webMirror,
    liveView: false,
    devicePreview: config.captureSource === 'digicam' || config.captureSource === 'web',
    ipadApiReady: Boolean(config.ipadApiToken),
    operatorControl: config.kioskMode === 'operator',
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

app.get('/api/camera/status', requirePairedWhenSelfService, async (req, res) => {
  if (config.captureSource !== 'digicam') {
    return res.json({ ok: true, transport: config.captureSource, liveView: false, cameras: [] });
  }
  const status = await camera.status();
  res.status(status.ok ? 200 : 503).json(status);
});

app.post('/api/start', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    if (config.requirePreflight) {
      const ageMs = lastPreflight ? Date.now() - Date.parse(lastPreflight.timestamp) : Infinity;
      if (!lastPreflight || lastPreflight.status !== 'READY' || ageMs > config.preflightMaxAgeMinutes * 60000) {
        throw new Error('ต้องผ่าน Production Preflight ก่อนเริ่มถ่าย');
      }
    }
    const id = await startSession();
    res.json({ ok: true, id });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.post('/api/capture', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const file = await captureSlot(req.body?.slot ?? null);
    res.json({ ok: true, file });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.delete('/api/photo/:slot', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    await deletePhoto(req.params.slot);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/liveview.jpg', requirePairedWhenSelfService, async (req, res) => {
  if (config.captureSource === 'digicam') return res.status(410).end();
  const buf = await camera.liveViewFrame();
  if (!buf) return res.status(503).end();
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(buf);
});

app.get('/api/state', requirePairedWhenSelfService, (req, res) => res.json(snapshot()));

app.get('/api/events', requirePairedWhenSelfService, (req, res) => {
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

app.post('/api/finish', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    await finishNow();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/discard', blockLegacyMutationInIpadMode, (req, res) => {
  try {
    discard();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/reset', blockLegacyMutationInIpadMode, (req, res) => {
  reset();
  res.json({ ok: true });
});

app.post('/api/print', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const job = await sendToPrint(req.body?.copies);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/mock-shot', blockLegacyMutationInIpadMode, async (req, res) => {
  try {
    const file = await fakeShot(req.body?.slot ?? null);
    res.json({ ok: true, file });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** เปลี่ยนค่าตั้งต้นจากหน้า operator แล้วเขียนกลับ .env */
app.post('/api/settings', blockLegacyMutationInIpadMode, (req, res) => {
  try {
    const allowed = ['WATCH_DIR', 'SHOTS', 'PRINT_SHOTS', 'EVENT_NAME', 'SESSION_IDLE_SECONDS', 'PRINT_ON_DONE', 'PRINT_LAYOUT', 'PRINT_THEME_COLOR', 'REVIEW_SECONDS', 'CAPTURE_SOURCE', 'COUNTDOWN', 'KIOSK_MODE', 'WEB_CAMERA_FACING', 'WEB_MIRROR'];
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
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** ช่วยเลือกโฟลเดอร์จากหน้าเว็บ (ไม่มี native picker ในเบราว์เซอร์) */
app.get('/api/browse', blockLegacyMutationInIpadMode, async (req, res) => {
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

app.get('/api/session/:id/file/:name', requirePairedWhenSelfService, (req, res) => {
  const name = path.basename(req.params.name);
  const id = path.basename(req.params.id);
  const file = path.join(config.sessionsDir, id, name);
  if (!file.startsWith(config.sessionsDir) || !fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.listen(config.port, config.host, () => {
  console.log(`photobooth  จอลูกค้า http://${config.host}:${config.port}  |  จอช่าง http://${config.host}:${config.port}/operator.html`);
  if (config.captureSource === 'folder') {
    const started = watch.start(config.watchDir);
    if (started.ok) console.log(`  เฝ้าโฟลเดอร์: ${config.watchDir}`);
    else console.log(`  !! ${started.error} — ตั้งค่าได้ที่หน้าจอช่าง`);
  } else {
    console.log(`  แหล่งภาพ: ${config.captureSource}${config.captureSource === 'digicam' ? ` (${config.dccHost})` : ''}`);
  }
  console.log(`  Nextcloud: ${config.nc.base || '(ยังไม่ได้ตั้ง)'} (โฟลเดอร์ ${config.nc.root})`);
  console.log(`  ${config.shots} ช็อต/เซสชัน  โหมดหน้าจอ: ${config.kioskMode}`);
});
