import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { config, ROOT } from './config.js';
import * as nc from './nextcloud.js';
import { loadJournal, saveJournal, scanUnfinishedSessions } from './journal.js';

const days = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const retentionConfig = {
  localRetentionDays: days('LOCAL_RETENTION_DAYS', 7),
  cloudRetentionDays: days('CLOUD_RETENTION_DAYS', 30),
  shareRetentionDays: days('SHARE_RETENTION_DAYS', 7),
  minFreeDiskGb: days('MIN_FREE_DISK_GB', 5),
};

function logAudit(entry) {
  try {
    const auditLogPath = path.join(ROOT, 'logs', 'audit.log');
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.appendFileSync(auditLogPath, `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.warn('[retention] เขียน audit log ไม่สำเร็จ:', err.message);
  }
}

const olderThan = (value, cutoff) => {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp < cutoff;
};

export async function diskStatus() {
  try {
    const stat = await fsp.statfs(config.sessionsDir);
    const freeGb = Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3;
    return { ok: freeGb >= retentionConfig.minFreeDiskGb, freeGb, minFreeDiskGb: retentionConfig.minFreeDiskGb };
  } catch (err) {
    return { ok: false, freeGb: null, minFreeDiskGb: retentionConfig.minFreeDiskGb, error: err.message };
  }
}

export async function runCleanup({ dryRun = true, activeSessionId = null, skipCloud = false } = {}) {
  const now = Date.now();
  const localCutoff = now - retentionConfig.localRetentionDays * 86400 * 1000;
  const cloudCutoff = now - retentionConfig.cloudRetentionDays * 86400 * 1000;
  const shareCutoff = now - retentionConfig.shareRetentionDays * 86400 * 1000;
  const unfinishedIds = new Set(scanUnfinishedSessions().map((s) => s.id));
  const deletedLocal = [];
  const deletedCloud = [];
  const revokedShares = [];

  if (fs.existsSync(config.sessionsDir)) {
    const entries = await fsp.readdir(config.sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === activeSessionId || unfinishedIds.has(entry.name)) continue;
      const dirPath = path.join(config.sessionsDir, entry.name);
      const journal = loadJournal(dirPath);
      const stat = await fsp.stat(dirPath);

      if (journal?.phase === 'done' && journal.shareId && olderThan(journal.startedAt, shareCutoff)) {
        revokedShares.push({ id: entry.name, shareId: journal.shareId });
        if (!dryRun) {
          await nc.deleteShare(journal.shareId);
          journal.shareId = null;
          journal.shareUrl = null;
          saveJournal({ ...journal, localDir: dirPath });
          logAudit({ action: 'revoke_session_share', id: entry.name });
        }
      }

      if (stat.mtimeMs < localCutoff) {
        deletedLocal.push(entry.name);
        if (!dryRun) {
          await fsp.rm(dirPath, { recursive: true, force: true });
          logAudit({ action: 'delete_local_session', id: entry.name });
        }
      }
    }
  }

  const remoteSessions = skipCloud ? [] : await nc.list(nc.NC_ROOT).catch(() => []);
  for (const item of remoteSessions) {
    if (!item.isDir || item.name.startsWith('_') || !olderThan(item.modified, cloudCutoff)) continue;
    const remoteDir = `${nc.NC_ROOT}/${item.name}`;
    deletedCloud.push(item.name);
    if (!dryRun) {
      const shares = await nc.findSessionShares(remoteDir).catch(() => []);
      for (const share of shares) await nc.deleteShare(share.shareId);
      await nc.remove(remoteDir);
      logAudit({ action: 'delete_cloud_session', id: item.name });
    }
  }

  return {
    dryRun,
    policy: retentionConfig,
    disk: await diskStatus(),
    deletedLocal,
    deletedCloud,
    revokedShares,
    timestamp: new Date().toISOString(),
  };
}
