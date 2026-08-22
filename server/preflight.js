import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { camera } from './camera.js';
import * as nc from './nextcloud.js';
import { validateConfigPatch } from './schema.js';
import { diskStatus } from './retention.js';

const execFileAsync = promisify(execFile);

export async function runPreflightChecks({ deep = false, skipExternal = false } = {}) {
  const checks = [];
  let status = 'READY';
  let cloudReady = false;

  // 1. Camera check
  if (skipExternal) {
    checks.push({ name: 'Camera Connection', pass: true, detail: 'ข้ามในการทดสอบอัตโนมัติ' });
  } else if (config.captureSource === 'digicam') {
    try {
      const camStatus = await camera.status();
      if (!camStatus.ok) {
        checks.push({ name: 'Camera Connection', pass: false, error: 'ไม่พบกล้อง DSLR ใน digiCamControl', critical: true });
        status = 'BLOCKED';
      } else {
        checks.push({ name: 'Camera Connection', pass: true, detail: `กล้องที่พบ: ${camStatus.cameras?.length || 1}` });
        if (camStatus.liveView === false) {
          checks.push({ name: 'Live View', pass: false, error: 'ถ่ายได้แต่ live view ไม่พร้อม', critical: false });
          status = 'READY_WITH_WARNINGS';
        }
      }
    } catch (err) {
      checks.push({ name: 'Camera Connection', pass: false, error: err.message, critical: true });
      status = 'BLOCKED';
    }
  } else {
    checks.push({ name: 'Camera Connection', pass: true, detail: `แหล่งภาพ: ${config.captureSource}` });
  }

  if (config.captureSource === 'ipad' || config.captureSource === 'web') {
    const tokenReady = config.ipadApiToken.length >= 32;
    checks.push({
      name: config.captureSource === 'web' ? 'Web Kiosk Pairing Token' : 'iPad API Token',
      pass: tokenReady,
      detail: tokenReady ? (config.captureSource === 'web' ? 'พร้อมจับคู่ PWA และรับภาพจากเบราว์เซอร์' : 'พร้อมรับภาพจากแอป iPad') : undefined,
      error: tokenReady ? undefined : 'IPAD_API_TOKEN ต้องยาวอย่างน้อย 32 ตัวอักษร',
      critical: true,
    });
    if (!tokenReady) status = 'BLOCKED';
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
    const cloud = skipExternal ? { ok: true, skipped: true } : await nc.health();
    if (cloud.ok) {
      cloudReady = true;
      checks.push({ name: 'Nextcloud WebDAV', pass: true, detail: cloud.skipped ? 'ข้ามในการทดสอบอัตโนมัติ' : config.nc.base });
    } else {
      checks.push({ name: 'Nextcloud WebDAV', pass: false, error: `HTTP ${cloud.status || cloud.error}`, critical: true });
      status = 'BLOCKED';
    }
  } catch (err) {
    checks.push({ name: 'Nextcloud WebDAV', pass: false, error: err.message, critical: true });
    status = 'BLOCKED';
  }

  if (!nc.hasOwnerCredentials()) {
    checks.push({ name: 'Per-session Share', pass: false, error: 'ยังไม่ได้ตั้ง NC_USER/NC_APP_PASSWORD', critical: true });
    status = 'BLOCKED';
  } else {
    checks.push({ name: 'Per-session Share', pass: true, detail: 'มีบัญชีสำหรับสร้างลิงก์แยก' });
  }

  if (deep && !skipExternal && cloudReady && nc.hasOwnerCredentials()) {
    const testDir = `${nc.NC_ROOT}/_preflight/${Date.now()}`;
    let shareId = null;
    try {
      await nc.ensureDir(testDir);
      await nc.putText('photobooth preflight', `${testDir}/write-test.txt`);
      const share = await nc.createSessionShare(testDir);
      shareId = share.shareId;
      checks.push({ name: 'Nextcloud Write + Share', pass: true, detail: 'สร้างไฟล์และลิงก์ทดสอบสำเร็จ' });
    } catch (err) {
      checks.push({ name: 'Nextcloud Write + Share', pass: false, error: err.message, critical: true });
      status = 'BLOCKED';
    } finally {
      if (shareId) {
        await nc.deleteShare(shareId).catch((err) => {
          checks.push({ name: 'Preflight Cleanup', pass: false, error: err.message, critical: true });
          status = 'BLOCKED';
        });
      }
      await nc.remove(testDir).catch(() => {});
    }
  }

  const disk = await diskStatus();
  checks.push({
    name: 'Disk Space',
    pass: disk.ok,
    detail: disk.freeGb === null ? undefined : `เหลือ ${disk.freeGb.toFixed(1)} GB`,
    error: disk.ok ? undefined : (disk.error || `เหลือน้อยกว่า ${disk.minFreeDiskGb} GB`),
    critical: true,
  });
  if (!disk.ok) status = 'BLOCKED';

  // 5. Config validation check
  const cfgCheck = validateConfigPatch({
    SHOTS: config.shots,
    COUNTDOWN: config.countdown,
    PRINT_LAYOUT: config.printLayout,
    CAPTURE_SOURCE: config.captureSource,
    KIOSK_MODE: config.kioskMode,
  });
  if (!cfgCheck.ok) {
    checks.push({ name: 'Configuration Integrity', pass: false, error: cfgCheck.errors.join(', '), critical: true });
    status = 'BLOCKED';
  } else {
    checks.push({ name: 'Configuration Integrity', pass: true, detail: 'การตั้งค่าถูกต้อง' });
  }

  return { status, checks, timestamp: new Date().toISOString() };
}
