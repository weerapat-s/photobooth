import assert from 'node:assert';
import { camera } from '../server/camera.js';
import { config } from '../server/config.js';
import { reset, startSession, state } from '../server/session.js';

async function run() {
  console.log('--- STARTING CAMERA READY GUARD TEST ---');
  const originalSource = config.captureSource;
  const originalStatus = camera.status;
  try {
    reset();
    config.captureSource = 'digicam';
    camera.status = async () => ({ ok: false, error: 'test: no camera connected' });
    await assert.rejects(startSession(), /no camera connected/);
    assert.strictEqual(state.phase, 'idle', 'missing camera must not create a shooting session');
    assert.strictEqual(state.session, null, 'missing camera must not leave an orphan session');
  } finally {
    camera.status = originalStatus;
    config.captureSource = originalSource;
    reset();
  }
  console.log('--- CAMERA READY GUARD TEST PASSED ---');
}

run().catch((err) => {
  console.error('CAMERA READY GUARD TEST FAILED:', err);
  process.exit(1);
});
