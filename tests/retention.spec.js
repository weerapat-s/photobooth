import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { runCleanup, retentionConfig } from '../server/retention.js';
import { config } from '../server/config.js';
import { saveJournal } from '../server/journal.js';

async function runRetentionTest() {
  console.log('--- STARTING PHASE 6 RETENTION & MONITORING TEST ---');

  // 1. Check retention configuration
  assert.strictEqual(typeof retentionConfig.localRetentionDays, 'number');
  assert.strictEqual(typeof retentionConfig.cloudRetentionDays, 'number');

  // 2. Test dryRun cleanup
  const dryReport = await runCleanup({ dryRun: true, skipCloud: true });
  assert.strictEqual(dryReport.dryRun, true);
  assert(Array.isArray(dryReport.deletedLocal));
  console.log('DryRun cleanup test passed.');

  // 3. Test real local cleanup in an isolated test session; cloud operations stay disabled.
  const id = 'test-retention-expired';
  const dir = path.join(config.sessionsDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  saveJournal({ id, localDir: dir, phase: 'done', startedAt: Date.now() - 20 * 86400 * 1000 });
  const old = new Date(Date.now() - (retentionConfig.localRetentionDays + 2) * 86400 * 1000);
  fs.utimesSync(dir, old, old);
  const realReport = await runCleanup({ dryRun: false, skipCloud: true });
  assert(realReport.deletedLocal.includes(id));
  assert(!fs.existsSync(dir), 'expired local test session must be removed');

  console.log('--- PHASE 6 RETENTION & MONITORING TEST PASSED SUCCESSFULLY ---');
}

runRetentionTest().catch((err) => {
  console.error('RETENTION TEST FAILED:', err);
  process.exit(1);
});
