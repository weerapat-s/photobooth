import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

export const config = {
  port: num(process.env.PORT, 4700),
  shots: num(process.env.SHOTS, 4),
  reviewSeconds: num(process.env.REVIEW_SECONDS, 90),
  sessionIdleSeconds: num(process.env.SESSION_IDLE_SECONDS, 25),
  boothName: process.env.BOOTH_NAME || 'booth-1',
  eventName: process.env.EVENT_NAME || 'Photo Booth',
  printOnDone: bool(process.env.PRINT_ON_DONE, false),

  // แหล่งภาพ: folder = เฝ้าโฟลเดอร์ Capture ของ Capture One | mock = สร้างภาพปลอมไว้เทสต์
  // digicam = แอปคุมกล้องผ่าน digiCamControl (มี live view) | folder = เฝ้าโฟลเดอร์ Capture One | mock = เทสต์
  captureSource: process.env.CAPTURE_SOURCE || 'digicam',
  watchDir: process.env.WATCH_DIR || '',
  watchPolling: bool(process.env.WATCH_POLLING, false),

  countdown: num(process.env.COUNTDOWN, 3),
  shotGapSeconds: num(process.env.SHOT_GAP_SECONDS, 1.5),
  dccTransport: process.env.DCC_TRANSPORT || 'auto', // auto (ลอง webserver ก่อน) | webserver | remotecmd
  dccHost: (process.env.DCC_HOST || 'http://localhost:5513').replace(/\/$/, ''),
  dccPath: process.env.DCC_PATH || String.raw`C:\Program Files (x86)\digiCamControl`,
  captureDir: process.env.CAPTURE_DIR || String.raw`C:\photobooth-captures`,
  captureTimeout: num(process.env.CAPTURE_TIMEOUT, 25000),

  ffmpeg: process.env.FFMPEG || String.raw`C:\Program Files (x86)\digiCamControl\ffmpeg.exe`,
  videoSeconds: num(process.env.VIDEO_SECONDS, 6),

  printLayout: process.env.PRINT_LAYOUT || 'strip2x6',
  printDpi: num(process.env.PRINT_DPI, 300),
  // การ์ด/ชีทปริ้นใช้แค่ช็อตล่าสุด N ภาพ (ไม่ใช่ทุกช็อตที่ถ่าย) — วิดีโอยังใช้ครบทุกช็อตเหมือนเดิม
  printShots: num(process.env.PRINT_SHOTS, 4),
  // ธีมสีพื้นหลังการ์ด/ชีทปริ้น + สีกรอบขาวรอบรูป — ตั้งตายตัวค่าเดียว (ไม่สุ่ม)
  printThemeColor: process.env.PRINT_THEME_COLOR || '#dff2ef',
  printFrameColor: process.env.PRINT_FRAME_COLOR || '#ffffff',
  // ธีม grid4x6 แยกจาก strip2x6 — พื้นมืด + ตัวอักษรเรืองแสง + วงกลมวันที่ (strip2x6 ยังใช้ธีมพาสเทลด้านบนตามเดิม)
  gridBgColor: process.env.GRID_BG_COLOR || '#15151d',
  gridAccentColor: process.env.GRID_ACCENT_COLOR || '#ffe14d',

  nc: {
    base: (process.env.NC_BASE || '').replace(/\/$/, ''),
    token: process.env.NC_SHARE_TOKEN || '',
    password: process.env.NC_SHARE_PASSWORD || '',
    root: (process.env.NC_ROOT || 'photobooth').replace(/^\/|\/$/g, ''),
    // บัญชี Nextcloud (username + app password) ไว้สร้าง public share ใหม่แยกต่อเซสชัน
    // ผ่าน OCS API — ต้องมีถึงจะล็อกไม่ให้ลูกค้าเห็นเซสชันคนอื่นได้ (แค่ซ่อนปุ่มไม่พอ)
    user: process.env.NC_USER || '',
    appPassword: process.env.NC_APP_PASSWORD || '',
    // path ของโฟลเดอร์ที่มี NC_ROOT อยู่ข้างใน นับจากราก Files ของบัญชีนี้ (ไม่ใช่ path ของ share)
    ownerPrefix: (process.env.NC_OWNER_PREFIX || '').replace(/^\/|\/$/g, ''),
  },

  sessionsDir: path.join(ROOT, 'sessions'),
  envFile: path.join(ROOT, '.env'),
};

fs.mkdirSync(config.sessionsDir, { recursive: true });

/** เขียนค่ากลับลง .env (ใช้จากหน้าตั้งค่าของ operator) แล้วอัปเดตค่าใน memory ให้ด้วย */
export function saveEnv(patch) {
  let text = fs.existsSync(config.envFile) ? fs.readFileSync(config.envFile, 'utf8') : '';
  for (const [key, value] of Object.entries(patch)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
    process.env[key] = String(value);
  }
  fs.writeFileSync(config.envFile, text, 'utf8');

  if ('WATCH_DIR' in patch) config.watchDir = String(patch.WATCH_DIR);
  if ('SHOTS' in patch) config.shots = Number(patch.SHOTS);
  if ('EVENT_NAME' in patch) config.eventName = String(patch.EVENT_NAME);
  if ('SESSION_IDLE_SECONDS' in patch) config.sessionIdleSeconds = Number(patch.SESSION_IDLE_SECONDS);
  if ('PRINT_ON_DONE' in patch) config.printOnDone = String(patch.PRINT_ON_DONE).toLowerCase() === 'true';
  if ('PRINT_LAYOUT' in patch) config.printLayout = String(patch.PRINT_LAYOUT);
  if ('PRINT_SHOTS' in patch) config.printShots = Number(patch.PRINT_SHOTS);
  if ('PRINT_THEME_COLOR' in patch) config.printThemeColor = String(patch.PRINT_THEME_COLOR);
  if ('PRINT_FRAME_COLOR' in patch) config.printFrameColor = String(patch.PRINT_FRAME_COLOR);
  if ('GRID_BG_COLOR' in patch) config.gridBgColor = String(patch.GRID_BG_COLOR);
  if ('GRID_ACCENT_COLOR' in patch) config.gridAccentColor = String(patch.GRID_ACCENT_COLOR);
  if ('CAPTURE_SOURCE' in patch) config.captureSource = String(patch.CAPTURE_SOURCE);
  if ('COUNTDOWN' in patch) config.countdown = Number(patch.COUNTDOWN);
}
