import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  recordIncident,
  getIncidentHistory,
  healTunnel,
  healCamera,
  healUnfinishedSessions,
  healPendingUploads,
  checkForUpdates,
  diagnoseAndHeal,
  installExceptionShield,
} from '../server/self-heal.js';
import { config, ROOT } from '../server/config.js';
import { state, reset } from '../server/session.js';

async function run() {
  console.log('--- STARTING SELF-HEAL & AUTO-UPDATE TEST SUITE ---');

  // 1. Test incident recording and history
  const testIncident = recordIncident('test', 'Simulated failure for verification', 'Applied test patch', 'repaired', { code: 123 });
  assert(testIncident.id.startsWith('inc-'), 'Incident ID must be generated');
  assert.strictEqual(testIncident.category, 'test');
  assert.strictEqual(testIncident.result, 'repaired');

  const history = getIncidentHistory();
  assert(history.length > 0, 'Incident history must contain at least 1 item');
  assert.strictEqual(history[0].id, testIncident.id, 'Latest incident must be at the top');

  const logFile = path.join(ROOT, 'logs', 'self-heal.log');
  assert(fs.existsSync(logFile), 'self-heal.log must exist');
  console.log('Incident recording and history test PASSED.');

  // 2. Test Exception Shield installation
  installExceptionShield();
  console.log('Exception shield installation test PASSED.');

  // 3. Test healCamera in bypass mode
  const origBypass = config.bypassCamera;
  try {
    config.bypassCamera = true;
    const camRes = await healCamera();
    assert.strictEqual(camRes.ok, true, 'healCamera in bypass mode must be ok');
    assert.strictEqual(camRes.status, 'skipped');
    console.log('healCamera test PASSED.');
  } finally {
    config.bypassCamera = origBypass;
  }

  // 4. Test healTunnel
  const tunnelRes = await healTunnel();
  assert(typeof tunnelRes === 'object', 'healTunnel must return an object');
  console.log('healTunnel test PASSED (status:', tunnelRes.status, ').');

  // 5. Test healUnfinishedSessions with an error state
  state.phase = 'error';
  state.message = 'Simulated stuck error';
  const sessRes = await healUnfinishedSessions();
  assert.strictEqual(sessRes.ok, true);
  assert.strictEqual(state.phase, 'idle', 'Stuck error phase must be auto-recovered to idle');
  console.log('healUnfinishedSessions test PASSED.');

  // 6. Test checkForUpdates
  const updateRes = await checkForUpdates();
  assert(typeof updateRes === 'object', 'checkForUpdates must return an object');
  assert('updateAvailable' in updateRes, 'Must have updateAvailable property');
  console.log('checkForUpdates test PASSED (updateAvailable:', updateRes.updateAvailable, ').');

  // 7. Test diagnoseAndHeal (Comprehensive Doctor)
  const docRes = await diagnoseAndHeal();
  assert(typeof docRes === 'object', 'diagnoseAndHeal must return a report');
  assert(docRes.checks && docRes.checks.tunnel, 'Must contain tunnel check');
  assert(docRes.checks && docRes.checks.camera, 'Must contain camera check');
  assert(docRes.checks && docRes.checks.sessions, 'Must contain sessions check');
  assert(docRes.checks && docRes.checks.update, 'Must contain update check');
  assert(['healthy', 'repaired', 'error'].includes(docRes.overall), 'Overall status must be valid');
  console.log('diagnoseAndHeal test PASSED (overall:', docRes.overall, ').');

  reset();
  console.log('--- ALL SELF-HEAL TESTS PASSED SUCCESSFULLY ---');
}

run().catch((err) => {
  console.error('SELF-HEAL TEST SUITE FAILED:', err);
  process.exit(1);
});
