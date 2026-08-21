import assert from 'node:assert';
import { runPreflightChecks } from '../server/preflight.js';
import { generateCalibrationSheet } from '../server/calibration.js';

async function runPreflightTest() {
  console.log('--- STARTING PHASE 5 PREFLIGHT & CALIBRATION TEST ---');

  // 1. Run Preflight
  const report = await runPreflightChecks({ skipExternal: true });
  assert(report.status, 'Preflight report must have status');
  assert(Array.isArray(report.checks), 'Preflight report must have checks array');
  console.log(`Preflight status: ${report.status}, checks run: ${report.checks.length}`);

  // 2. Generate Calibration Sheets
  const stripBuf = await generateCalibrationSheet('strip2x6');
  assert(Buffer.isBuffer(stripBuf) && stripBuf.length > 0, 'Strip calibration sheet must be generated');

  const gridBuf = await generateCalibrationSheet('grid4x6');
  assert(Buffer.isBuffer(gridBuf) && gridBuf.length > 0, 'Grid calibration sheet must be generated');
  console.log('Calibration sheet generation passed.');

  console.log('--- PHASE 5 PREFLIGHT & CALIBRATION TEST PASSED SUCCESSFULLY ---');
}

runPreflightTest().catch((err) => {
  console.error('PREFLIGHT TEST FAILED:', err);
  process.exit(1);
});
