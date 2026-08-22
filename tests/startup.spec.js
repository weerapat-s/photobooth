import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }
  throw lastError || new Error(`หมดเวลารอ ${url}`);
}

async function waitForStatus(url, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === expected) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`ไม่ได้ HTTP ${expected} จาก ${url}`);
}

async function withServer(script, env, verify) {
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await verify();
    assert.strictEqual(child.exitCode, null, `${script} exited early:\n${output}`);
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000),
    ]);
  }
}

const startupCaptureDir = path.join(process.cwd(), 'sessions', 'test-startup-captures');
fs.rmSync(startupCaptureDir, { recursive: true, force: true });
let startupSessionId = null;
await withServer('server/index.js', {
  HOST: '127.0.0.1',
  PORT: '48711',
  CAPTURE_SOURCE: 'mock',
  KIOSK_MODE: 'operator',
  CAPTURE_DIR: startupCaptureDir,
  COUNTDOWN: '0',
  SHOTS: '4',
  REQUIRE_PREFLIGHT: 'false',
}, async () => {
  const state = await waitForJson('http://127.0.0.1:48711/api/state');
  assert.strictEqual(state.phase, 'idle');
  const startResponse = await fetch('http://127.0.0.1:48711/api/start', { method: 'POST' });
  assert.strictEqual(startResponse.status, 200);
  startupSessionId = (await startResponse.json()).id;
  const duplicateStart = await fetch('http://127.0.0.1:48711/api/start', { method: 'POST' });
  assert.strictEqual(duplicateStart.status, 409, 'ห้ามเริ่มเซสชันซ้อน');

  const capture = (slot) => fetch('http://127.0.0.1:48711/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot }),
  });
  assert.strictEqual((await capture(1)).status, 200);
  assert.strictEqual((await capture(2)).status, 200);
  const beforeDelete = await waitForJson('http://127.0.0.1:48711/api/state');
  assert.strictEqual(beforeDelete.session.count, 2);
  assert.strictEqual(beforeDelete.session.slots[0].filled, true);
  assert.strictEqual(beforeDelete.session.slots[1].filled, true);
  const slotOnePreview = beforeDelete.session.slots[0].preview;

  const deleteResponse = await fetch('http://127.0.0.1:48711/api/photo/2', { method: 'DELETE' });
  assert.strictEqual(deleteResponse.status, 200);
  const afterDelete = await waitForJson('http://127.0.0.1:48711/api/state');
  assert.strictEqual(afterDelete.session.count, 1);
  assert.strictEqual(afterDelete.session.slots[0].preview, slotOnePreview, 'รูปที่ 1 ต้องอยู่ช่องเดิม');
  assert.strictEqual(afterDelete.session.slots[1].filled, false, 'รูปที่ 2 ต้องกลายเป็นช่องว่าง');

  assert.strictEqual((await capture(2)).status, 200);
  const afterRetake = await waitForJson('http://127.0.0.1:48711/api/state');
  assert.strictEqual(afterRetake.session.count, 2);
  assert.strictEqual(afterRetake.session.slots[0].preview, slotOnePreview, 'ถ่ายรูปที่ 2 ใหม่ต้องไม่กระทบรูปที่ 1');
  assert.strictEqual(afterRetake.session.slots[1].filled, true);

  const earlyFinish = await fetch('http://127.0.0.1:48711/api/finish', { method: 'POST' });
  assert.strictEqual(earlyFinish.status, 400, 'ห้ามจบงานถ้ายังมีช่องรูปว่าง');

  const discardResponse = await fetch('http://127.0.0.1:48711/api/discard', { method: 'POST' });
  assert.strictEqual(discardResponse.status, 200);
  const discarded = await waitForJson('http://127.0.0.1:48711/api/state');
  assert.strictEqual(discarded.phase, 'idle');
  const unfinished = await waitForJson('http://127.0.0.1:48711/api/unfinished');
  assert(!unfinished.unfinished.some((item) => item.id === startupSessionId));
});
if (startupSessionId) fs.rmSync(path.join(process.cwd(), 'sessions', startupSessionId), { recursive: true, force: true });
fs.rmSync(startupCaptureDir, { recursive: true, force: true });

console.log('Startup smoke tests passed.');
