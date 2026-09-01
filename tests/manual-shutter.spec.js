/**
 * โหมดชัตเตอร์มือ (SHUTTER=manual): โปรแกรมต้องไม่สั่งกล้องถ่าย
 * เจ้าหน้าที่กดชัตเตอร์ที่ตัวกล้อง ไฟล์ตกลงโฟลเดอร์ของเซสชัน แล้วเข้าช่องว่างเรียงกันเอง
 *
 * ใช้ digiCamControl ปลอมตอบว่ามีกล้องต่ออยู่ จะได้ทดสอบทางเดินทั้งเส้นโดยไม่ต้องมีกล้องจริง
 * (ยังไม่แทนการทดสอบกับกล้องจริง แต่กันไม่ให้ทางเดินนี้พังเงียบ ๆ)
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const ROOT = process.cwd();
const PORT = 4796;
const DCC_PORT = 5598;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, opt = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'content-type': 'application/json' }, ...opt });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
};

async function waitForSlots(count, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await api('/api/state');
    if (state.body.session?.count >= count) return state.body;
    await sleep(400);
  }
  throw new Error(`รอรูปครบ ${count} ช่องไม่ทันใน ${timeoutMs}ms`);
}

async function run() {
  console.log('--- STARTING MANUAL SHUTTER TEST ---');

  const fakeDcc = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('response: ["Test Camera"]');
  });
  await new Promise((resolve) => fakeDcc.listen(DCC_PORT, '127.0.0.1', resolve));

  const captureRoot = path.join(ROOT, 'tests', '.tmp-manual-captures');
  await fsp.rm(captureRoot, { recursive: true, force: true });
  await fsp.mkdir(captureRoot, { recursive: true });

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CAPTURE_SOURCE: 'digicam',
      SHUTTER: 'manual',
      KIOSK_MODE: 'operator',
      SHOTS: '2',
      PRINT_SHOTS: '2',
      CAPTURE_DIR: captureRoot,
      DCC_AUTO_START: 'false',
      DCC_TRANSPORT: 'webserver',
      DCC_HOST: `http://127.0.0.1:${DCC_PORT}`,
    },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  const cleanup = async () => {
    server.kill();
    fakeDcc.close();
    await fsp.rm(captureRoot, { recursive: true, force: true });
  };

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await api('/api/health')).status === 200) { up = true; break; } } catch { /* ยังไม่ขึ้น */ }
      await sleep(500);
    }
    assert(up, `เซิร์ฟเวอร์ไม่ขึ้น:\n${log}`);

    const cfg = await api('/api/config');
    assert.strictEqual(cfg.body.shutterMode, 'manual', 'config ต้องบอกว่าเป็นโหมดชัตเตอร์มือ');

    const started = await api('/api/start', { method: 'POST', body: '{}' });
    assert.strictEqual(started.status, 200, `เริ่มเซสชันไม่ได้: ${JSON.stringify(started.body)}`);
    const id = started.body.id;

    // ข้อสำคัญของโหมดนี้: โปรแกรมต้องปฏิเสธการสั่งถ่าย
    const denied = await api('/api/capture', { method: 'POST', body: '{}' });
    assert.strictEqual(denied.status, 409, 'โหมดชัตเตอร์มือต้องไม่ยอมให้โปรแกรมสั่งถ่าย');
    assert.match(denied.body.error, /ชัตเตอร์/, 'ข้อความต้องบอกว่าให้กดชัตเตอร์ที่กล้อง');

    // จำลองเจ้าหน้าที่กดชัตเตอร์: กล้องส่งไฟล์ลงโฟลเดอร์ของเซสชัน
    const rawDir = path.join(captureRoot, id);
    for (let i = 1; i <= 2; i++) {
      await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30 * i, g: 90, b: 140 } } })
        .jpeg().toFile(path.join(rawDir, `DSC_000${i}.jpg`));
      const state = await waitForSlots(i);
      assert.strictEqual(state.session.count, i, `รูปที่ ${i} ต้องเข้าช่องเอง`);
    }

    const finished = await api('/api/finish', { method: 'POST', body: '{}' });
    assert.strictEqual(finished.status, 200, `ปิดเซสชันไม่ได้: ${JSON.stringify(finished.body)}`);

    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', id, 'session.json'), 'utf8'));
    assert(fs.existsSync(meta.cardFile), 'ต้องได้ไฟล์การ์ด');
    console.log('Manual shutter ingest + card assertions passed.');

    // เลิกเฝ้าโฟลเดอร์หลังจบเซสชัน ไฟล์ที่ตกมาทีหลังต้องไม่ไปโผล่ในเซสชันถัดไป
    await api('/api/reset', { method: 'POST', body: '{}' });
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#333' } })
      .jpeg().toFile(path.join(rawDir, 'late.jpg'));
    await sleep(2000);
    const after = await api('/api/state');
    assert.strictEqual(after.body.phase, 'idle', 'รูปที่มาช้าต้องไม่เปิดเซสชันใหม่');
    console.log('Watcher stops with the session. Passed.');

    console.log('--- MANUAL SHUTTER TEST PASSED SUCCESSFULLY ---');
  } finally {
    await cleanup();
  }
}

run().catch(async (err) => {
  console.error('MANUAL SHUTTER TEST FAILED:', err);
  process.exit(1);
});
