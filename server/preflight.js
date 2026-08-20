import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { camera } from './camera.js';
import * as nc from './nextcloud.js';
import { validateConfigPatch } from './schema.js';

const execFileAsync = promisify(execFile);

export async function runPreflightChecks() {
  const checks = [];
  let status = 'READY';

  // 1. Camera check
  if (config.captureSource === 'digicam') {
    try {
      const camStatus = await camera.status();
      if (!camStatus.ok) {
        checks.push({ name: 'Camera Connection', pass: false, error: 'ไม่พบกล้อง DSLR ใน digiCamControl', critical: true });
        status = 'BLOCKED';
      } else {
        checks.push({ name: 'Camera Connection', pass: true, detail: `กล้องที่พบ: ${camStatus.cameras?.length || 1}` });
      }
    } catch (err) {
      checks.push({ name: 'Camera Connection', pass: false, error: err.message, critical: true });
      status = 'BLOCKED';
    }
  } else {
    checks.push({ name: 'Camera Connection', pass: true, detail: `แหล่งภาพ: ${config.captureSource}` });
  }

  // 2. ffmpeg check
  if (fs.existsSync(config.ffmpeg)) {
    try {
      const { stdout } = await execFileAsync(config.ffmpeg, ['-version']);
      checks.push({ name: 'ffmpeg', pass: true, detail: stdout.split('\n')[0] });
    } catch (err) {
      checks.push({ name: 'ffmpeg', pass: false, error: 'ffmpeg รันไม่ได้', critical: true });
      status = 'BLOCKED';
    }
  } else {
    checks.push({ name: 'ffmpeg', pass: false, error: `ไม่พบไฟล์ ffmpeg ที่ ${config.ffmpeg}`, critical: true });
    status = 'BLOCKED';
  }

  // 3. Capture Directory Write Access
  try {
    await fsp.mkdir(config.captureDir, { recursive: true });
    const testFile = path.join(config.captureDir, `.test-${Date.now()}.tmp`);
    await fsp.writeFile(testFile, 'test');
    await fsp.unlink(testFile);
    checks.push({ name: 'Capture Directory', pass: true, detail: config.captureDir });
  } catch (err) {
    checks.push({ name: 'Capture Directory', pass: false, error: `เขียนโฟลเดอร์ไม่ได้: ${err.message}`, critical: true });
    status = 'BLOCKED';
  }

  // 4. Nextcloud WebDAV Check
  try {
    const cloud = await nc.health();
    if (cloud.ok) {
      checks.push({ name: 'Nextcloud WebDAV', pass: true, detail: config.nc.base });
    } else {
      checks.push({ name: 'Nextcloud WebDAV', pass: false, error: `HTTP ${cloud.status || cloud.error}`, critical: false });
      if (status !== 'BLOCKED') status = 'READY_WITH_WARNINGS';
    }
  } catch (err) {
    checks.push({ name: 'Nextcloud WebDAV', pass: false, error: err.message, critical: false });
    if (status !== 'BLOCKED') status = 'READY_WITH_WARNINGS';
  }

  // 5. Config validation check
  const cfgCheck = validateConfigPatch({
    SHOTS: config.shots,
    COUNTDOWN: config.countdown,
    PRINT_LAYOUT: config.printLayout,
  });
  if (!cfgCheck.ok) {
    checks.push({ name: 'Configuration Integrity', pass: false, error: cfgCheck.errors.join(', '), critical: true });
    status = 'BLOCKED';
  } else {
    checks.push({ name: 'Configuration Integrity', pass: true, detail: 'การตั้งค่าถูกต้อง' });
  }

  return { status, checks, timestamp: new Date().toISOString() };
}
