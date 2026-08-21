import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const port = 48714;
const base = `http://127.0.0.1:${port}`;
const token = 'web-flow-test-token-at-least-32-characters';
let child;
let sessionId;
let serverOutput = '';

async function request(route, options = {}) {
  const response = await fetch(base + route, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const { response } = await request('/api/config');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web flow test server did not start (exit=${child?.exitCode})\n${serverOutput}`);
}

async function run() {
  console.log('--- STARTING WEB PWA FLOW TEST ---');
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CAPTURE_SOURCE: 'web',
      KIOSK_MODE: 'self_service',
      IPAD_API_TOKEN: token,
      SHOTS: '2',
      REQUIRE_PREFLIGHT: 'false',
    },
  });
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForServer();

  let result = await request('/api/web/bootstrap');
  assert.strictEqual(result.response.status, 401, 'bootstrap without pairing must be rejected');

  result = await request('/api/web/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }),
  });
  assert.strictEqual(result.response.status, 401, 'wrong pairing token must be rejected');

  result = await request('/api/web/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  assert.strictEqual(result.response.status, 200);
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie?.startsWith('photobooth_web_auth='), 'pairing must issue HttpOnly auth cookie');

  const auth = { Cookie: cookie };
  result = await request('/api/web/bootstrap', { headers: auth });
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.data.config.cameraFacing, 'user');
  assert.strictEqual(result.data.config.devicePreview, true, 'web kiosk must use the iPad camera preview');

  result = await request('/api/web/session', { method: 'POST', headers: auth });
  assert.strictEqual(result.response.status, 200);
  sessionId = result.data.id;

  const first = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ff4d6d' } }).jpeg().toBuffer();
  result = await request('/api/web/session/photo/1', { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: first });
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.data.state.session.count, 1);

  const replacement = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffd166' } }).jpeg().toBuffer();
  result = await request('/api/web/session/photo/1', { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: replacement });
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.data.state.session.count, 1, 'retake in same slot must not increase count');

  result = await request('/api/web/session/photo/2', { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: replacement });
  assert.strictEqual(result.data.state.session.count, 2);

  result = await request('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(result.response.status, 403, 'legacy mutation must stay blocked in web mode');

  result = await request('/api/web/session', { method: 'DELETE', headers: auth });
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.data.state.phase, 'idle');
  console.log('--- WEB PWA FLOW TEST PASSED ---');
}

run().catch((err) => {
  console.error('WEB PWA FLOW TEST FAILED:', err);
  process.exitCode = 1;
}).finally(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (sessionId) fs.rmSync(path.join(process.cwd(), 'sessions', sessionId), { recursive: true, force: true });
});
