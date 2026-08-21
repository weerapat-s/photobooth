import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../server/config.js';
import { deletePhoto, discard, ingestIpadPhoto, snapshot, startSession } from '../server/session.js';

async function runIpadFlowTest() {
  console.log('--- STARTING IPAD INGEST FLOW TEST ---');
  const original = {
    captureSource: config.captureSource,
    captureDir: config.captureDir,
    shots: config.shots,
  };
  const captureRoot = path.join(config.sessionsDir, 'test-ipad-captures');
  let sessionId = null;

  try {
    config.captureSource = 'mock';
    config.captureDir = captureRoot;
    config.shots = 2;

    sessionId = await startSession();
    const first = await sharp({
      create: { width: 640, height: 426, channels: 3, background: '#ff4d6d' },
    }).jpeg().toBuffer();
    await ingestIpadPhoto(1, first);

    let state = snapshot();
    assert.strictEqual(state.session.count, 1);
    assert.strictEqual(state.session.slots[0].filled, true);
    assert.strictEqual(state.session.slots[1].filled, false);

    await deletePhoto(1);
    state = snapshot();
    assert.strictEqual(state.session.count, 0);
    assert.strictEqual(state.session.slots[0].filled, false);

    const replacement = await sharp({
      create: { width: 640, height: 426, channels: 3, background: '#ffd166' },
    }).jpeg().toBuffer();
    await ingestIpadPhoto(1, replacement);
    await ingestIpadPhoto(2, replacement);
    state = snapshot();
    assert.strictEqual(state.session.count, 2);
    assert.deepStrictEqual(state.session.slots.map((slot) => slot.filled), [true, true]);
  } finally {
    try { discard(); } catch {}
    if (sessionId) fs.rmSync(path.join(config.sessionsDir, sessionId), { recursive: true, force: true });
    fs.rmSync(captureRoot, { recursive: true, force: true });
    config.captureSource = original.captureSource;
    config.captureDir = original.captureDir;
    config.shots = original.shots;
  }

  console.log('--- IPAD INGEST FLOW TEST PASSED ---');
}

runIpadFlowTest().catch((err) => {
  console.error('IPAD INGEST FLOW TEST FAILED:', err);
  process.exit(1);
});
