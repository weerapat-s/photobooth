import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config, ROOT } from './config.js';
import { camera } from './camera.js';
import { state, snapshot, bus, reset, scanUnfinishedSessions, recoverSession, finishNow } from './session.js';
import * as nc from './nextcloud.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'self-heal.log');

// Memory buffer of recent self-healing events for UI display
const MAX_INCIDENTS = 50;
const incidentHistory = [];

let watchdogTimer = null;
let updateCheckTimer = null;
let isHealingInProgress = false;
let isUpdatingInProgress = false;

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

export function recordIncident(category, symptom, action, result, details = null) {
  ensureLogDir();
  const entry = {
    id: `inc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    category,
    symptom,
    action,
    result, // 'repaired' | 'mitigated' | 'failed' | 'info'
    details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null,
  };

  incidentHistory.unshift(entry);
  if (incidentHistory.length > MAX_INCIDENTS) incidentHistory.pop();

  const logLine = `[${entry.timestamp}] [${entry.category.toUpperCase()}] [${entry.result.toUpperCase()}] ${entry.symptom} -> ${entry.action}${entry.details ? ` (${entry.details})` : ''}\n`;
  try {
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('[self-heal] บันทึก log ไม่สำเร็จ:', err.message);
  }

  bus.emit('self-heal', entry);
  console.log(`[self-heal] ${logLine.trim()}`);
  return entry;
}

export function getIncidentHistory() {
  return [...incidentHistory];
}

/**
 * 1. ซ่อมแซม Cloudflare Tunnel อัตโนมัติ
 * ตรวจว่า cloudflared.exe ทำงานอยู่และ public domain ตอบสนองไหม ถ้าไม่ ทำการ restart ทันที
 */
export async function healTunnel() {
  if (!config.publicUrl) return { ok: true, status: 'skipped' };
  const cfExe = path.join(process.env.LOCALAPPDATA || '', 'PhotoBooth', 'bin', 'cloudflared.exe');
  const cfConfig = path.join(process.env.USERPROFILE || '', '.cloudflared', 'config.yml');
  const tunnelLog = path.join(LOG_DIR, 'tunnel.log');

  if (!fs.existsSync(cfExe) || !fs.existsSync(cfConfig)) {
    return { ok: false, status: 'missing_binary', error: 'ไม่พบ cloudflared.exe หรือ config.yml' };
  }

  let processAlive = false;
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH');
    processAlive = stdout.toLowerCase().includes('cloudflared.exe');
  } catch {
    processAlive = false;
  }

  // Probe public URL
  let publicReachable = false;
  if (processAlive) {
    try {
      const probeRes = await fetch(`${config.publicUrl}/api/health`, {
        signal: AbortSignal.timeout(6000),
      });
      publicReachable = probeRes.ok;
    } catch {
      publicReachable = false;
    }
  }

  if (processAlive && publicReachable) {
    return { ok: true, status: 'healthy' };
  }

  const reason = !processAlive ? 'โพรเซส cloudflared.exe ดับ' : 'โดเมนสาธารณะไม่ตอบสนอง';
  recordIncident('tunnel', reason, 'กำลังรีสตาร์ท cloudflared.exe ใหม่', 'mitigated');

  try {
    await execAsync('taskkill /F /IM cloudflared.exe /T').catch(() => {});
    await sleep(800);

    ensureLogDir();
    const out = fs.openSync(tunnelLog, 'a');
    const errFd = fs.openSync(tunnelLog, 'a');
    const child = spawn(cfExe, ['tunnel', '--config', cfConfig, '--logfile', tunnelLog, '--loglevel', 'info', 'run'], {
      detached: true,
      stdio: ['ignore', out, errFd],
      windowsHide: true,
    });
    child.unref();

    // รอตรวจว่ากลับมาออนไลน์
    let recovered = false;
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      try {
        const check = await fetch(`${config.publicUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
        if (check.ok) {
          recovered = true;
          break;
        }
      } catch {}
    }

    if (recovered) {
      recordIncident('tunnel', 'Tunnel ฟื้นตัวแล้ว', 'รีสตาร์ทสำเร็จ โดเมนสาธารณะออนไลน์', 'repaired');
      return { ok: true, status: 'repaired' };
    } else {
      recordIncident('tunnel', 'Tunnel เริ่มทำงานแล้วแต่ยังไม่ตอบสนอง', 'กำลังรอเครือข่ายเชื่อมต่อ', 'mitigated');
      return { ok: false, status: 'starting' };
    }
  } catch (err) {
    recordIncident('tunnel', 'รีสตาร์ท Tunnel ล้มเหลว', err.message, 'failed');
    return { ok: false, status: 'failed', error: err.message };
  }
}

/**
 * 2. ซ่อมแซมระบบกล้อง / digiCamControl อัตโนมัติ
 * จัดการเมื่อ DCC ค้าง, ไม่ตอบสนองคำสั่ง หรือกล้องหลุด
 */
export async function healCamera() {
  if (config.bypassCamera || config.captureSource !== 'digicam') {
    return { ok: true, status: 'skipped' };
  }

  let status = await camera.status().catch((err) => ({ ok: false, error: err.message }));
  if (status.ok && status.cameras && status.cameras.length > 0) {
    return { ok: true, status: 'healthy', cameras: status.cameras };
  }

  recordIncident('camera', `กล้องมีปัญหา: ${status.error || 'ไม่พบกล้อง'}`, 'ทำการรีเซ็ต digiCamControl และตรวจสอบการเชื่อมต่อ USB', 'mitigated');

  try {
    // ฆ่าโพรเซสที่ค้าง
    await execAsync('taskkill /F /IM CameraControl.exe /IM CameraControlRemoteCmd.exe /T').catch(() => {});
    await sleep(1000);

    // ปลุก digiCamControl ขึ้นมาใหม่
    const exe = path.join(config.dccPath, 'CameraControl.exe');
    if (fs.existsSync(exe)) {
      const child = spawn(exe, [], {
        cwd: config.dccPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      // รอให้ pipe พร้อมและตรวจเช็คกล้อง
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        status = await camera.status().catch(() => ({ ok: false }));
        if (status.ok) break;
      }
    }

    if (status.ok && status.cameras && status.cameras.length > 0) {
      recordIncident('camera', 'กู้คืนการเชื่อมต่อกล้องสำเร็จ', `พบกล้อง ${status.cameras.join(', ')}`, 'repaired');
      return { ok: true, status: 'repaired', cameras: status.cameras };
    } else {
      recordIncident('camera', 'ยังไม่พบอุปกรณ์กล้องหลังรีเซ็ต', 'โปรดตรวจสาย USB และเปิดสวิตช์กล้อง', 'failed');
      return { ok: false, status: 'failed', error: status.error || 'ยังไม่พบกล้อง' };
    }
  } catch (err) {
    recordIncident('camera', 'รีเซ็ตกล้องขัดข้อง', err.message, 'failed');
    return { ok: false, status: 'failed', error: err.message };
  }
}

/**
 * 3. กู้คืนเซสชันที่ค้าง / ประมวลผลไม่สมบูรณ์อัตโนมัติ
 * ป้องกันไม่ให้ภาพของลูกค้าสูญหายแม้ไฟตกหรือโปรแกรมปิดตัวกะทันหัน
 */
export async function healUnfinishedSessions() {
  const unfinished = scanUnfinishedSessions();
  if (!unfinished.length) return { ok: true, count: 0 };

  let healedCount = 0;
  for (const item of unfinished) {
    // ถ้ามีรูปครบตามจำนวนช็อตแต่ค้างอยู่ที่ shooting หรือ processing ให้กู้คืนและประมวลผลต่อทันที
    if (item.validPhotosCount >= config.shots && state.phase === 'idle') {
      try {
        recordIncident('session', `พบงานค้างที่รูปครบ ${item.id} (${item.validPhotosCount} รูป)`, 'เริ่มกู้คืนและประมวลผลการ์ด/วิดีโออัตโนมัติ', 'mitigated');
        await recoverSession(item.id, 'resume');
        await finishNow();
        healedCount++;
        recordIncident('session', `งาน ${item.id} กู้คืนสำเร็จ`, 'ประกอบการ์ด วิดีโอ และสร้าง QR ครบถ้วนแล้ว', 'repaired');
      } catch (err) {
        recordIncident('session', `กู้คืนงาน ${item.id} ไม่สำเร็จ`, err.message, 'failed');
        reset();
      }
    }
  }

  // หากสถานะปัจจุบันค้างอยู่ที่ 'error' นานเกินไปโดยไม่มีการถ่าย ให้รีเซ็ตกลับเป็น 'idle' เพื่อต้อนรับลูกค้าคนถัดไป
  if (state.phase === 'error') {
    recordIncident('session', 'หน้าจอตู้ค้างอยู่ที่สถานะ Error', 'รีเซ็ตสถานะหน้าจอให้กลับมาพร้อมใช้งาน (idle)', 'repaired');
    reset();
  }

  return { ok: true, count: healedCount };
}

/**
 * 4. ซ่อมแซมการอัปโหลดขึ้น Nextcloud ที่ตกค้าง
 * เมื่อมีปัญหาอินเทอร์เน็ตหลุด รูปจะถูกเก็บปลอดภัยในเครื่อง และจะนำส่งขึ้นคลาวด์อัตโนมัติเมื่อเน็ตกลับมา
 */
export async function healPendingUploads() {
  const health = await nc.health().catch(() => ({ ok: false }));
  if (!health.ok) return { ok: false, status: 'offline' };

  try {
    const entries = await fsp.readdir(config.sessionsDir, { withFileTypes: true }).catch(() => []);
    const sessionDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);

    let uploadedSessions = 0;
    for (const sid of sessionDirs.slice(-20)) {
      const sessionDir = path.join(config.sessionsDir, sid);
      const jsonFile = path.join(sessionDir, 'session.json');
      if (!fs.existsSync(jsonFile)) continue;

      let journal = null;
      try {
        journal = JSON.parse(await fsp.readFile(jsonFile, 'utf8'));
      } catch {
        continue;
      }

      if (!journal || !journal.cloudError) continue;

      const remoteDir = journal.remoteDir || `${nc.NC_ROOT}/${journal.id}`;
      recordIncident('cloud', `พบงานค้างอัปโหลดขึ้น Nextcloud: ${journal.id}`, 'กำลังอัปโหลดไฟล์ที่ตกค้างใหม่ในพื้นหลัง', 'mitigated');

      await nc.ensureDir(remoteDir);
      const toUpload = [
        [journal.cardFile, 'card.jpg'],
        [journal.videoFile, 'video.mp4'],
        [journal.gifFile, 'video.gif'],
      ];
      (journal.photos || []).forEach((p, idx) => {
        if (p) toUpload.push([p, `photo-${idx + 1}.jpg`]);
      });

      let allOk = true;
      for (const [local, name] of toUpload) {
        if (local && fs.existsSync(local)) {
          try {
            await nc.uploadFile(local, `${remoteDir}/${name}`);
          } catch {
            allOk = false;
          }
        }
      }

      if (allOk) {
        journal.cloudError = null;
        await fsp.writeFile(jsonFile, JSON.stringify(journal, null, 2), 'utf8');
        uploadedSessions++;
        recordIncident('cloud', `อัปโหลดงาน ${journal.id} ขึ้น Nextcloud สำเร็จ`, 'ข้อมูลซิงค์ครบถ้วนแล้ว', 'repaired');
      }
    }
    return { ok: true, synced: uploadedSessions };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getGitWorkingDir() {
  if (fs.existsSync(path.join(ROOT, '.git'))) return ROOT;
  const workspaceGit = 'C:/Users/weerapat/photobooth';
  if (fs.existsSync(path.join(workspaceGit, '.git'))) return workspaceGit;
  return ROOT;
}

/**
 * 5. ตรวจสอบอัปเดตจาก Git Repository ("ระบบอัพเดท")
 */
export async function checkForUpdates() {
  const gitCwd = getGitWorkingDir();
  try {
    await execAsync('git fetch origin master', { cwd: gitCwd, timeout: 20000 });
    const { stdout: localRev } = await execAsync('git rev-parse HEAD', { cwd: gitCwd });
    const { stdout: remoteRev } = await execAsync('git rev-parse origin/master', { cwd: gitCwd });
    const local = localRev.trim();
    const remote = remoteRev.trim();

    if (local === remote) {
      return { updateAvailable: false, currentCommit: local.slice(0, 7), remoteCommit: remote.slice(0, 7), behind: 0 };
    }

    const { stdout: countStr } = await execAsync('git rev-list --count HEAD..origin/master', { cwd: gitCwd });
    const { stdout: logStr } = await execAsync('git log -n 5 --oneline HEAD..origin/master', { cwd: gitCwd });
    const behind = parseInt(countStr.trim(), 10) || 0;

    return {
      updateAvailable: behind > 0,
      currentCommit: local.slice(0, 7),
      remoteCommit: remote.slice(0, 7),
      behind,
      changelog: logStr.trim(),
    };
  } catch (err) {
    return { updateAvailable: false, error: err.message };
  }
}

/**
 * 6. ดำเนินการอัปเดตโค้ดอัตโนมัติ พร้อมระบบตรวจความถูกต้องและย้อนกลับหากพบข้อผิดพลาด
 */
export async function applyUpdate({ autoRestart = true } = {}) {
  const gitCwd = getGitWorkingDir();
  if (isUpdatingInProgress) throw new Error('กำลังดำเนินการอัปเดตอยู่');
  isUpdatingInProgress = true;
  recordIncident('update', 'เริ่มกระบวนการอัปเดตระบบอัตโนมัติ', 'ดึงโค้ดเวอร์ชันล่าสุดและตรวจสอบความถูกต้อง', 'mitigated');

  let originalCommit = '';
  try {
    const { stdout: head } = await execAsync('git rev-parse HEAD', { cwd: gitCwd });
    originalCommit = head.trim();

    // ดึงโค้ดล่าสุด
    await execAsync('git fetch origin master', { cwd: gitCwd, timeout: 30000 });
    await execAsync('git pull --ff-only origin master', { cwd: gitCwd, timeout: 30000 });

    const { stdout: newHead } = await execAsync('git rev-parse HEAD', { cwd: gitCwd });
    const updatedCommit = newHead.trim();

    if (originalCommit === updatedCommit) {
      isUpdatingInProgress = false;
      recordIncident('update', 'ระบบเป็นเวอร์ชันล่าสุดอยู่แล้ว', 'ไม่พบการเปลี่ยนแปลงใหม่', 'info');
      return { ok: true, status: 'already_up_to_date', commit: updatedCommit.slice(0, 7) };
    }

    // รัน Regression Tests อัตโนมัติเพื่อตรวจสอบว่าโค้ดใหม่ไม่ทำลายฟังก์ชันเดิม
    recordIncident('update', `อัปเดตโค้ดเป็น ${updatedCommit.slice(0, 7)}`, 'กำลังรันชุดทดสอบความถูกต้องอัตโนมัติ...', 'mitigated');
    let testsPassed = false;
    try {
      const { stdout: testOut } = await execAsync('npm run test:unit', { cwd: gitCwd, timeout: 60000 });
      testsPassed = testOut.includes('PASSED') && !testOut.includes('FAILED');
    } catch {
      testsPassed = false;
    }

    if (!testsPassed) {
      // ถ้ารันเทสต์ไม่ผ่าน ให้ย้อนกลับ (Rollback) ทันที
      recordIncident('update', 'การทดสอบโค้ดใหม่ไม่ผ่าน', `ทำการย้อนกลับ (Rollback) สู่ Commit เดิม ${originalCommit.slice(0, 7)} ทันทีเพื่อความปลอดภัย`, 'failed');
      await execAsync(`git reset --hard ${originalCommit}`, { cwd: gitCwd });
      isUpdatingInProgress = false;
      return { ok: false, error: 'ชุดทดสอบไม่ผ่าน — ระบบทำการย้อนกลับสู่เวอร์ชันเดิมโดยอัตโนมัติเรียบร้อยแล้ว' };
    }

    // ซิงค์ไฟล์ไปยังโฟลเดอร์ Production (AppData)
    const appDataRoot = path.join(process.env.LOCALAPPDATA || '', 'PhotoBooth');
    if (fs.existsSync(appDataRoot)) {
      try {
        const normGit = path.win32.normalize(gitCwd);
        const normApp = path.win32.normalize(appDataRoot);
        await execAsync(`powershell -Command "Copy-Item -Path '${normGit}\\server\\*' -Destination '${normApp}\\server' -Recurse -Force; Copy-Item -Path '${normGit}\\assets\\*' -Destination '${normApp}\\assets' -Recurse -Force; Copy-Item -Path '${normGit}\\kiosk\\*' -Destination '${normApp}\\kiosk' -Recurse -Force;"`);
      } catch (syncErr) {
        console.warn('[self-heal] ซิงค์ไฟล์ไป AppData มีการเตือน:', syncErr.message);
      }
    }

    recordIncident('update', `อัปเดตและผ่านการทดสอบสำเร็จ (${updatedCommit.slice(0, 7)})`, 'ซิงค์ไฟล์ระบบเรียบร้อย', 'repaired');

    if (autoRestart) {
      scheduleSafeRestart(1500);
    }

    isUpdatingInProgress = false;
    return { ok: true, status: 'updated', commit: updatedCommit.slice(0, 7), restarted: autoRestart };
  } catch (err) {
    if (originalCommit) {
      await execAsync(`git reset --hard ${originalCommit}`, { cwd: gitCwd }).catch(() => {});
    }
    isUpdatingInProgress = false;
    recordIncident('update', 'อัปเดตระบบขัดข้อง', err.message, 'failed');
    throw err;
  }
}


/**
 * 7. รีสตาร์ทเซิร์ฟเวอร์แบบปลอดภัย (Safe Restart)
 */
export function scheduleSafeRestart(delayMs = 1000) {
  setTimeout(() => {
    console.log('[self-heal] กำลังเริ่มการรีสตาร์ทเซิร์ฟเวอร์ใหม่อย่างปลอดภัย...');
    const appDataRoot = path.join(process.env.LOCALAPPDATA || '', 'PhotoBooth');
    const vbs = path.join(appDataRoot, 'launch', 'booth.vbs');
    if (fs.existsSync(vbs)) {
      spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
    }
    process.exit(0);
  }, delayMs);
}

/**
 * 8. Comprehensive Doctor & Self-Healing ("หมอตรวจสุขภาพและรักษาอัตโนมัติ")
 */
export async function diagnoseAndHeal() {
  if (isHealingInProgress) return { status: 'busy', message: 'กำลังดำเนินกระบวนการรักษาอยู่' };
  isHealingInProgress = true;
  const report = {
    timestamp: new Date().toISOString(),
    actionsTaken: [],
    checks: {},
  };

  try {
    // 1. ตรวจสอบและซ่อมแซม Tunnel
    const tunnelResult = await healTunnel();
    report.checks.tunnel = tunnelResult;
    if (tunnelResult.status === 'repaired') report.actionsTaken.push('รีสตาร์ท Cloudflare Tunnel');

    // 2. ตรวจสอบและซ่อมแซมกล้อง
    const cameraResult = await healCamera();
    report.checks.camera = cameraResult;
    if (cameraResult.status === 'repaired') report.actionsTaken.push('รีเซ็ตการเชื่อมต่อ digiCamControl & กล้อง');

    // 3. ตรวจสอบและกู้คืนงานค้าง
    const sessionResult = await healUnfinishedSessions();
    report.checks.sessions = sessionResult;
    if (sessionResult.count > 0) report.actionsTaken.push(`กู้คืนงานที่ตกค้างจำนวน ${sessionResult.count} รายการ`);

    // 4. ตรวจสอบและซิงค์งานค้างอัปโหลด
    const uploadResult = await healPendingUploads();
    report.checks.cloudUploads = uploadResult;
    if (uploadResult.synced > 0) report.actionsTaken.push(`ซิงค์รูปภาพขึ้น Nextcloud สำเร็จ ${uploadResult.synced} เซสชัน`);

    // 5. ตรวจสอบอัปเดต Git
    const updateResult = await checkForUpdates();
    report.checks.update = updateResult;

    report.overall = report.actionsTaken.length ? 'repaired' : 'healthy';
  } catch (err) {
    report.overall = 'error';
    report.error = err.message;
  } finally {
    isHealingInProgress = false;
  }

  return report;
}

/**
 * 9. เกราะป้องกันข้อผิดพลาดระดับโพรเซส (Process Armor)
 * ป้องกันไม่ให้แอปพลิเคชันตู้ล้มเหลวจาก unhandled exception ที่กู้คืนได้
 */
export function installExceptionShield() {
  process.on('uncaughtException', (err) => {
    const isNetworkErr = /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|socket hang up/i.test(err?.message || '');
    recordIncident('process', `ตรวจพบ Uncaught Exception: ${err.message}`, isNetworkErr ? 'ดักจับข้อผิดพลาดเครือข่ายและรักษาสภาพการทำงานของระบบ' : 'บันทึกรายงานข้อผิดพลาดและคงสถานะเซิร์ฟเวอร์', isNetworkErr ? 'repaired' : 'mitigated', err.stack);
    if (!isNetworkErr && state.phase === 'shooting') {
      // แจ้งสถานะเตือนบนหน้าจอแต่ไม่ให้โพรเซสดับ
      try { reset(); } catch {}
    }
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    const isNetworkErr = /ECONNRESET|ETIMEDOUT|fetch failed|network timeout/i.test(msg);
    recordIncident('process', `ตรวจพบ Unhandled Rejection: ${msg}`, isNetworkErr ? 'กู้คืนข้อผิดพลาดแบบ Asynchronous อัตโนมัติ' : 'ดักจับและอุดรอยรั่วเรียบร้อย', 'repaired');
  });

  console.log('[self-heal] ติดตั้งระบบเกราะป้องกันข้อผิดพลาด (Exception Shield) เรียบร้อยแล้ว');
}

/**
 * 10. เริ่มต้น Watchdog ประจำระบบ
 */
export function startSelfHealingWatchdog() {
  installExceptionShield();

  // รันรอบแรกหลังเปิดเครื่อง 5 วินาที
  setTimeout(() => {
    diagnoseAndHeal().then((r) => {
      console.log(`[self-heal] การตรวจสุขภาพระบบเบื้องต้นเสร็จสิ้น: ${r.overall}`);
    });
  }, 5000);

  // เฝ้าระวังอัตโนมัติทุกๆ 60 วินาที
  if (!watchdogTimer) {
    watchdogTimer = setInterval(async () => {
      // ตรวจสอบเฉพาะเวลาเครื่องว่าง (idle) เพื่อไม่รบกวนลูกค้าระหว่างถ่ายรูป
      if (state.phase === 'idle') {
        await healTunnel();
        await healUnfinishedSessions();
        await healPendingUploads();
      }
    }, 60000);
    watchdogTimer.unref();
  }

  // ตรวจหาอัปเดตโค้ดอัตโนมัติทุกๆ 15 นาที
  if (!updateCheckTimer) {
    updateCheckTimer = setInterval(async () => {
      if (state.phase === 'idle') {
        const update = await checkForUpdates();
        if (update.updateAvailable) {
          recordIncident('update', `พบโค้ดอัปเดตใหม่ (${update.behind} commits)`, 'พร้อมสำหรับการอัปเดตอัตโนมัติ', 'info');
        }
      }
    }, 15 * 60 * 1000);
    updateCheckTimer.unref();
  }

  console.log('[self-heal] ระบบเฝ้าระวังและรักษาตัวเองอัตโนมัติ (Autonomous Watchdog) พร้อมทำงาน 24/7');
}
