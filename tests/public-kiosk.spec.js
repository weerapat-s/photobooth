import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = 48716;
const base = `http://127.0.0.1:${port}`;
const token = 'public-kiosk-test-token-at-least-32-characters';
let child;
let sessionId;
let output = '';

async function request(route, options = {}) {
  const response = await fetch(base + route, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(base + '/api/config');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`public kiosk server did not start\n${output}`);
}

async function run() {
  console.log('--- STARTING PUBLIC KIOSK AUTH TEST ---');
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CAPTURE_SOURCE: 'mock',
      KIOSK_MODE: 'self_service',
      IPAD_API_TOKEN: token,
      WEB_PAIR_CODE: 'public-kiosk-test-code',
      SHOTS: '1',
      COUNTDOWN: '0',
      REQUIRE_PREFLIGHT: 'false',
    },
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitForServer();

  let result = await request('/api/state');
  assert.strictEqual(result.response.status, 401, 'public state must require paired cookie');
  result = await request('/api/start', { method: 'POST' });
  assert.strictEqual(result.response.status, 403, 'legacy mutation must be blocked in self-service mode');
  result = await request('/api/web/capture', { method: 'POST' });
  assert.strictEqual(result.response.status, 401, 'capture must reject an unpaired client');
  result = await request('/api/camera/status');
  assert.strictEqual(result.response.status, 401, 'legacy camera status must require pairing');
  result = await request('/api/cleanup?dryRun=false', { method: 'POST' });
  assert.strictEqual(result.response.status, 403, 'public cleanup mutation must be blocked');
  result = await request('/api/browse');
  assert.strictEqual(result.response.status, 403, 'public filesystem browser must be blocked');

  result = await request('/api/web/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'public-kiosk-test-code' }),
  });
  assert.strictEqual(result.response.status, 200);
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie?.startsWith('photobooth_web_auth='));
  const auth = { Cookie: cookie };

  result = await request('/api/web/session', { method: 'POST', headers: auth });
  assert.strictEqual(result.response.status, 200);
  sessionId = result.data.id;
  result = await request('/api/web/capture', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: 1 }),
  });
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.data.state.session.count, 1);

  result = await request('/api/web/session', { method: 'DELETE', headers: auth });
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.data.state.phase, 'idle');
  console.log('--- PUBLIC KIOSK AUTH TEST PASSED ---');
}

run().catch((err) => {
  console.error('PUBLIC KIOSK AUTH TEST FAILED:', err);
  process.exitCode = 1;
}).finally(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (sessionId) fs.rmSync(path.join(process.cwd(), 'sessions', sessionId), { recursive: true, force: true });
});
