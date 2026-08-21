import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { validateConfigPatch, saveEnvAtomic } from '../server/schema.js';
import { reset, state, startSession } from '../server/session.js';

async function runValidationTest() {
  console.log('--- STARTING PHASE 2 VALIDATION TEST ---');

  // 1. Valid config patch
  const validPatch = {
    SHOTS: 4,
    COUNTDOWN: 3,
    PRINT_LAYOUT: 'grid4x6',
    PRINT_THEME_COLOR: '#ff0000',
    KIOSK_MODE: 'self_service',
  };
  const res1 = validateConfigPatch(validPatch);
  assert.strictEqual(res1.ok, true, 'Valid config patch must pass');

  // 2. Invalid config patch
  const invalidPatch = {
    SHOTS: 99,
    PRINT_LAYOUT: 'invalid_layout',
    PRINT_THEME_COLOR: 'blue',
    COUNTDOWN: 'bad_val\nCRLF_INJECTION=1',
    KIOSK_MODE: 'unknown',
  };
  const res2 = validateConfigPatch(invalidPatch);
  assert.strictEqual(res2.ok, false, 'Invalid config patch must fail');
  assert(res2.errors.length >= 5, 'Must detect multiple invalid values');
  console.log('Schema validation assertions passed.');

  // 3. Atomic .env writer check
  const tmpEnvPath = path.join(process.cwd(), 'sessions', 'test.env');
  if (fs.existsSync(tmpEnvPath)) fs.unlinkSync(tmpEnvPath);
  saveEnvAtomic(tmpEnvPath, { SHOTS: 5, EVENT_NAME: 'Atomic Test' });
  assert(fs.existsSync(tmpEnvPath), 'Env file must be created');
  const envContent = fs.readFileSync(tmpEnvPath, 'utf8');
  assert(envContent.includes('SHOTS=5'), 'Env file must contain SHOTS=5');
  assert(envContent.includes('EVENT_NAME="Atomic Test"'), 'String values must be quoted safely');
  assert(!fs.existsSync(`${tmpEnvPath}.tmp`), 'Temporary tmp file must be cleaned up');
  fs.unlinkSync(tmpEnvPath);
  console.log('Atomic .env writer test passed.');

  // 4. Session cancellation & state transition check
  reset();
  assert.strictEqual(state.phase, 'idle');
  console.log('--- PHASE 2 VALIDATION TEST PASSED SUCCESSFULLY ---');
}

runValidationTest().catch((err) => {
  console.error('VALIDATION TEST FAILED:', err);
  process.exit(1);
});
