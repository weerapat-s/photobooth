import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { saveJournal, loadJournal, scanUnfinishedSessions, filterExistingPaths } from '../server/journal.js';
import { recoverSession, reset } from '../server/session.js';
import { config } from '../server/config.js';

async function runRecoveryTest() {
  console.log('--- STARTING PHASE 3 RECOVERY TEST ---');

  const testSessionId = 'test-session-crash-123';
  const sessionDir = path.join(config.sessionsDir, testSessionId);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const mockJournalData = {
    id: testSessionId,
    publicToken: '0123456789abcdef0123456789abcdef',
    localDir: sessionDir,
    phase: 'shooting',
    photos: [path.join(sessionDir, 'photo-1.jpg')],
    previews: ['preview-1.jpg'],
    startedAt: Date.now(),
  };
  fs.writeFileSync(mockJournalData.photos[0], 'test');

  // 1. Test atomic journal saving
  saveJournal(mockJournalData);
  const journalPath = path.join(sessionDir, 'session.json');
  assert(fs.existsSync(journalPath), 'session.json must exist');
  assert(!fs.existsSync(`${journalPath}.tmp`), 'session.json.tmp must be cleaned up');

  // 2. Test reading journal
  const loaded = loadJournal(sessionDir);
  assert.strictEqual(loaded.id, testSessionId);
  assert.strictEqual(loaded.publicToken, '0123456789abcdef0123456789abcdef');
  assert.strictEqual(loaded.phase, 'shooting');
  console.log('Atomic journal save/load passed.');

  // 3. Test scanning unfinished sessions
  const unfinishedList = scanUnfinishedSessions();
  assert(unfinishedList.some((s) => s.id === testSessionId), 'Unfinished scan must detect test-session-crash-123');
  assert.deepStrictEqual(filterExistingPaths([mockJournalData.photos[0], path.join(sessionDir, 'missing.jpg')]), [mockJournalData.photos[0]]);
  console.log('Unfinished session scan passed.');

  // 4. Test recoverSession preserves publicToken
  reset();
  const rec = await recoverSession(testSessionId, 'resume');
  assert.strictEqual(rec.ok, true);
  assert.strictEqual(rec.session.publicToken, '0123456789abcdef0123456789abcdef', 'publicToken must be preserved on session recovery');
  reset();
  console.log('Session recovery preserves publicToken passed.');

  // Cleanup
  fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log('--- PHASE 3 RECOVERY TEST PASSED SUCCESSFULLY ---');
}

runRecoveryTest().catch((err) => {
  console.error('RECOVERY TEST FAILED:', err);
  process.exit(1);
});
