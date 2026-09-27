import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 4700),
  shots: num(process.env.SHOTS, 4),
  reviewSeconds: num(process.env.REVIEW_SECONDS, 90),
  sessionIdleSeconds: num(process.env.SESSION_IDLE_SECONDS, 25),
  boothName: process.env.BOOTH_NAME || 'booth-1',
  eventName: process.env.EVENT_NAME || 'Photo Booth',
  kioskMode: process.env.KIOSK_MODE || 'operator',
  requirePreflight: bool(process.env.REQUIRE_PREFLIGHT, false),
  preflightMaxAgeMinutes: num(process.env.PREFLIGHT_MAX_AGE_MINUTES, 60),

  // แหล่งภาพ: folder = เฝ้าโฟลเดอร์ Capture ของ Capture One | mock = สร้างภาพปลอมไว้เทสต์
  // digicam = แอปคุมกล้องผ่าน digiCamControl (มี live view) | folder = เฝ้าโฟลเดอร์ Capture One | mock = เทสต์
  captureSource: process.env.CAPTURE_SOURCE || 'digicam',
  ipadApiToken: process.env.IPAD_API_TOKEN || '',
  webPairCode: process.env.WEB_PAIR_CODE || '',
  webCameraFacing: process.env.WEB_CAMERA_FACING || 'user',
  webMirror: bool(process.env.WEB_MIRROR, true),
  watchDir: process.env.WATCH_DIR || '',
  watchPolling: bool(process.env.WATCH_POLLING, false),

  countdown: num(process.env.COUNTDOWN, 3),
  // ใครเป็นคนสั่งชัตเตอร์: software = โปรแกรมสั่งกล้องถ่าย | manual = เจ้าหน้าที่กดที่ตัวกล้องเอง
  // โหมด manual โปรแกรมจะเฝ้าโฟลเดอร์ของเซสชันแทน ไฟล์ที่กล้องส่งลงมาจะเข้าช่องว่างเอง
  shutterMode: process.env.SHUTTER || 'software',
  shotGapSeconds: num(process.env.SHOT_GAP_SECONDS, 1.5),
  // remotecmd เสถียรกว่า webserver ของ digiCamControl 2.1.7 ซึ่งอาจล้มเมื่อ client ตัด socket
  dccTransport: process.env.DCC_TRANSPORT || 'remotecmd',
  dccAutoStart: bool(process.env.DCC_AUTO_START, true),
  dccHost: (process.env.DCC_HOST || 'http://localhost:5513').replace(/\/$/, ''),
  dccPath: process.env.DCC_PATH || String.raw`C:\Program Files (x86)\digiCamControl`,
  captureDir: process.env.CAPTURE_DIR || String.raw`C:\photobooth-captures`,
  captureTimeout: num(process.env.CAPTURE_TIMEOUT, 25000),

  // สนับสนุนผ่านพร้อมเพย์ (ตามใจลูกค้า ไม่บังคับ) — เว้นว่างไว้ = ปิด ข้ามไปหน้ารับรูปเลย
  promptpayId: process.env.PROMPTPAY_ID || '',
  // ปุ่มยอดเงินที่ให้กดเลือก (บาท) ลูกค้ายังพิมพ์ยอดเองได้อีกทาง
  payAmounts: String(process.env.PAY_AMOUNTS || '20,50,100')
    .split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0),
  payMaxAmount: num(process.env.PAY_MAX_AMOUNT, 5000),
  // ที่อยู่สาธารณะของตู้ (ผ่าน Cloudflare Tunnel) — QR บนจอจะพาไปหน้าชวนสนับสนุนบนมือถือลูกค้าก่อน
  // เว้นว่าง = QR ชี้ไปโฟลเดอร์รูปบน NAS ตรง ๆ แบบเดิม
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  // ถ้าคลาวด์ไม่ตอบภายในเวลานี้ ถือว่าใช้ไม่ได้ แล้วข้ามไปเลย
  // ลูกค้าไม่ควรต้องยืนรอเพราะ NAS ล่ม ในเมื่อรูปพร้อมส่งจากตู้อยู่แล้ว
  cloudProbeMs: num(process.env.CLOUD_PROBE_MS, 4000),

  ffmpeg: process.env.FFMPEG || String.raw`C:\Program Files (x86)\digiCamControl\ffmpeg.exe`,
  videoSeconds: num(process.env.VIDEO_SECONDS, 6),

  // การ์ดแบบเทมเพลตสำเร็จรูป (PNG ที่ออกแบบไว้แล้ว) — ถ้าตั้งไว้จะใช้แทน PRINT_LAYOUT
  cardTemplate: process.env.CARD_TEMPLATE || '',
  // เทมเพลตที่วางสตริปคู่กันไว้ ให้ตัดมาใช้ครึ่งเดียว: left | right | full
  cardTemplateHalf: process.env.CARD_TEMPLATE_HALF || 'left',
  // ขยายการ์ดกี่เท่าจากขนาดไฟล์เทมเพลต — ใช้เมื่อไฟล์เทมเพลตความละเอียดต่ำ
  // รูปถ่ายจะคมขึ้นจริง (ย่อจากต้นฉบับกล้องน้อยลง) แต่ลายกราฟิกของเทมเพลตจะซอฟต์ลงตามการอัปสเกล
  cardTemplateScale: num(process.env.CARD_TEMPLATE_SCALE, 1),

  // รายการเลย์เอาต์ที่เลือกได้ (ดู server/layouts.js) — ถ้าไม่มีไฟล์นี้จะถอยไปใช้ CARD_TEMPLATE เดี่ยว ๆ
  cardLayoutsFile: process.env.CARD_LAYOUTS || 'assets/layouts.json',
  // id ของเลย์เอาต์ที่ใช้เป็นค่าตั้งต้น
  cardLayout: process.env.CARD_LAYOUT || '',
  // fixed = ช่างล็อกไว้แบบเดียว | customer = ลูกค้ากดเลือกเองก่อนเริ่มถ่าย
  cardLayoutChoice: process.env.CARD_LAYOUT_CHOICE || 'fixed',

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

import { saveEnvAtomic, validateConfigPatch } from './schema.js';

const runtimeCheck = validateConfigPatch({
  PORT: config.port,
  SHOTS: config.shots,
  PRINT_SHOTS: config.printShots,
  COUNTDOWN: config.countdown,
  SESSION_IDLE_SECONDS: config.sessionIdleSeconds,
  REVIEW_SECONDS: config.reviewSeconds,
  PRINT_LAYOUT: config.printLayout,
  CAPTURE_SOURCE: config.captureSource,
  KIOSK_MODE: config.kioskMode,
  SHUTTER: config.shutterMode,
  PROMPTPAY_ID: config.promptpayId,
  PAY_AMOUNTS: config.payAmounts.join(','),
  CARD_LAYOUT_CHOICE: config.cardLayoutChoice,
  WEB_CAMERA_FACING: config.webCameraFacing,
  WEB_MIRROR: config.webMirror,
  DCC_TRANSPORT: config.dccTransport,
  PRINT_THEME_COLOR: config.printThemeColor,
  PRINT_FRAME_COLOR: config.printFrameColor,
  GRID_BG_COLOR: config.gridBgColor,
  GRID_ACCENT_COLOR: config.gridAccentColor,
});
if (!runtimeCheck.ok) {
  throw new Error(`การตั้งค่าเริ่มต้นไม่ถูกต้อง:\n- ${runtimeCheck.errors.join('\n- ')}`);
}

/** เขียนค่ากลับลง .env (ใช้จากหน้าตั้งค่าของ operator) แล้วอัปเดตค่าใน memory ให้ด้วย */
export function saveEnv(patch) {
  saveEnvAtomic(config.envFile, patch);

  if ('WATCH_DIR' in patch) config.watchDir = String(patch.WATCH_DIR);
  if ('SHOTS' in patch) config.shots = Number(patch.SHOTS);
  if ('EVENT_NAME' in patch) config.eventName = String(patch.EVENT_NAME);
  if ('KIOSK_MODE' in patch) config.kioskMode = String(patch.KIOSK_MODE);
  if ('SESSION_IDLE_SECONDS' in patch) config.sessionIdleSeconds = Number(patch.SESSION_IDLE_SECONDS);
  if ('PRINT_LAYOUT' in patch) config.printLayout = String(patch.PRINT_LAYOUT);
  if ('CARD_TEMPLATE' in patch) config.cardTemplate = String(patch.CARD_TEMPLATE);
  if ('CARD_TEMPLATE_HALF' in patch) config.cardTemplateHalf = String(patch.CARD_TEMPLATE_HALF);
  if ('CARD_LAYOUT' in patch) config.cardLayout = String(patch.CARD_LAYOUT);
  if ('CARD_LAYOUT_CHOICE' in patch) config.cardLayoutChoice = String(patch.CARD_LAYOUT_CHOICE);
  if ('PRINT_SHOTS' in patch) config.printShots = Number(patch.PRINT_SHOTS);
  if ('PRINT_THEME_COLOR' in patch) config.printThemeColor = String(patch.PRINT_THEME_COLOR);
  if ('PRINT_FRAME_COLOR' in patch) config.printFrameColor = String(patch.PRINT_FRAME_COLOR);
  if ('GRID_BG_COLOR' in patch) config.gridBgColor = String(patch.GRID_BG_COLOR);
  if ('GRID_ACCENT_COLOR' in patch) config.gridAccentColor = String(patch.GRID_ACCENT_COLOR);
  if ('CAPTURE_SOURCE' in patch) config.captureSource = String(patch.CAPTURE_SOURCE);
  if ('WEB_CAMERA_FACING' in patch) config.webCameraFacing = String(patch.WEB_CAMERA_FACING);
  if ('WEB_MIRROR' in patch) config.webMirror = String(patch.WEB_MIRROR).toLowerCase() === 'true';
  if ('COUNTDOWN' in patch) config.countdown = Number(patch.COUNTDOWN);
  if ('SHUTTER' in patch) config.shutterMode = String(patch.SHUTTER);
  if ('PROMPTPAY_ID' in patch) config.promptpayId = String(patch.PROMPTPAY_ID);
  if ('PAY_AMOUNTS' in patch) {
    config.payAmounts = String(patch.PAY_AMOUNTS).split(',').map((v) => Number(v.trim())).filter((v) => v > 0);
  }
}
