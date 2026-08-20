import assert from 'node:assert';
import { runCleanup, retentionConfig } from '../server/retention.js';

async function runRetentionTest() {
  console.log('--- STARTING PHASE 6 RETENTION & MONITORING TEST ---');

  // 1. Check retention configuration
  assert.strictEqual(typeof retentionConfig.localRetentionDays, 'number');
  assert.strictEqual(typeof retentionConfig.cloudRetentionDays, 'number');

  // 2. Test dryRun cleanup
  const dryReport = await runCleanup({ dryRun: true });
  assert.strictEqual(dryReport.dryRun, true);
  assert(Array.isArray(dryReport.deletedLocal));
  console.log('DryRun cleanup test passed.');

  console.log('--- PHASE 6 RETENTION & MONITORING TEST PASSED SUCCESSFULLY ---');
}

runRetentionTest().catch((err) => {
  console.error('RETENTION TEST FAILED:', err);
  process.exit(1);
});
