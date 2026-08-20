import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { config } from './config.js';
import * as nc from './nextcloud.js';
import { loadJournal } from './journal.js';

export const retentionConfig = {
  localRetentionDays: Number(process.env.LOCAL_RETENTION_DAYS || 7),
  cloudRetentionDays: Number(process.env.CLOUD_RETENTION_DAYS || 30),
  minFreeDiskGb: Number(process.env.MIN_FREE_DISK_GB || 5),
};

function logAudit(entry) {
  const auditLogPath = path.join(config.ROOT, 'logs', 'audit.log');
  fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
  fs.appendFileSync(auditLogPath, line, 'utf8');
}

export async function runCleanup({ dryRun = true } = {}) {
  const localCutoff = Date.now() - retentionConfig.localRetentionDays * 86400 * 1000;
  const deletedLocal = [];
  const deletedCloud = [];

  // 1. Cleanup local sessions
  if (fs.existsSync(config.sessionsDir)) {
    const entries = await fsp.readdir(config.sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(config.sessionsDir, entry.name);
      const journal = loadJournal(dirPath);

      // Skip current or unfinished session
      if (journal && journal.phase !== 'done') continue;

      const stat = await fsp.stat(dirPath);
      if (stat.mtimeMs < localCutoff) {
        if (!dryRun) {
          await fsp.rm(dirPath, { recursive: true, force: true });
          logAudit({ action: 'delete_local_session', id: entry.name, path: dirPath });
        }
        deletedLocal.push(entry.name);
      }
    }
  }

  return {
    dryRun,
    localRetentionDays: retentionConfig.localRetentionDays,
    deletedLocal,
    deletedCloud,
    timestamp: new Date().toISOString(),
  };
}
