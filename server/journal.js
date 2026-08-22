import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function saveJournal(sessionData) {
  if (!sessionData || !sessionData.localDir) return;
  const journalPath = path.join(sessionData.localDir, 'session.json');
  const tmpPath = `${journalPath}.tmp`;

  const payload = {
    id: sessionData.id,
    schemaVersion: 1,
    phase: sessionData.phase || 'shooting',
    photos: sessionData.photos || [],
    previews: sessionData.previews || [],
    cardFile: sessionData.cardFile || null,
    videoFile: sessionData.videoFile || null,
    gifFile: sessionData.gifFile || null,
    uploaded: sessionData.uploaded || [],
    forceUploadAll: Boolean(sessionData.forceUploadAll),
    remoteDir: sessionData.remoteDir || null,
    shareId: sessionData.shareId || null,
    shareUrl: sessionData.shareUrl || null,
    lastError: sessionData.lastError || null,
    startedAt: sessionData.startedAt || Date.now(),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(sessionData.localDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, journalPath);
}

export function loadJournal(sessionDir) {
  const journalPath = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(journalPath)) return null;
  try {
    const raw = fs.readFileSync(journalPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[journal] อ่าน session.json ใน ${sessionDir} ล้มเหลว:`, err.message);
    return null;
  }
}

export function filterExistingPaths(paths = []) {
  return paths.filter((file) => typeof file === 'string' && fs.existsSync(file));
}

export function scanUnfinishedSessions() {
  const sessionsDir = config.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return [];

  const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const unfinished = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const fullPath = path.join(sessionsDir, dir.name);
    const journal = loadJournal(fullPath);

    if (journal && !['done', 'discarded'].includes(journal.phase)) {
      const photosExist = filterExistingPaths(journal.photos);
      unfinished.push({
        ...journal,
        localDir: fullPath,
        validPhotosCount: photosExist.length,
      });
    }
  }

  return unfinished;
}
