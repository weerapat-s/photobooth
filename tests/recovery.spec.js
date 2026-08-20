import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { saveJournal, loadJournal, scanUnfinishedSessions } from '../server/journal.js';
import { config } from '../server/config.js';

async function runRecoveryTest() {
  console.log('--- STARTING PHASE 3 RECOVERY TEST ---');

  const testSessionId = 'test-session-crash-123';
  const sessionDir = path.join(config.sessionsDir, testSessionId);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const mockJournalData = {
    id: testSessionId,
    localDir: sessionDir,
    phase: 'shooting',
    photos: [path.join(sessionDir, 'photo-1.jpg')],
    previews: ['preview-1.jpg'],
    startedAt: Date.now(),
  };

  // 1. Test atomic journal saving
  saveJournal(mockJournalData);
  const journalPath = path.join(sessionDir, 'session.json');
  assert(fs.existsSync(journalPath), 'session.json must exist');
  assert(!fs.existsSync(`${journalPath}.tmp`), 'session.json.tmp must be cleaned up');

  // 2. Test reading journal
  const loaded = loadJournal(sessionDir);
  assert.strictEqual(loaded.id, testSessionId);
  assert.strictEqual(loaded.phase, 'shooting');
  console.log('Atomic journal save/load passed.');

  // 3. Test scanning unfinished sessions
  const unfinishedList = scanUnfinishedSessions();
  assert(unfinishedList.some((s) => s.id === testSessionId), 'Unfinished scan must detect test-session-crash-123');
  console.log('Unfinished session scan passed.');

  // Cleanup
  fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log('--- PHASE 3 RECOVERY TEST PASSED SUCCESSFULLY ---');
}

runRecoveryTest().catch((err) => {
  console.error('RECOVERY TEST FAILED:', err);
  process.exit(1);
});
