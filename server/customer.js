import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * หน้ารับรูปของลูกค้า เสิร์ฟจากตู้เครื่องนี้ตรง ๆ
 *
 * ลูกค้าเข้าด้วยกุญแจ 32 ตัวอักษรของเซสชันตัวเอง ไม่ใช่ชื่อเซสชัน (ชื่อเดาได้จากชื่อบูท+เวลา)
 * กุญแจเก็บอยู่ใน session.json ของแต่ละเซสชัน จึงยังใช้ได้หลังเปิดโปรแกรมใหม่
 *
 * ไม่พึ่ง NAS เลย NAS ล่มลูกค้าก็ยังรับรูปได้ ตราบใดที่ตู้ยังเปิดอยู่
 */

const TOKEN_RE = /^[a-f0-9]{32}$/;

/** ชื่อไฟล์ที่ยอมให้โหลด — ไม่รับชื่อจากลูกค้าตรง ๆ เพื่อกันการไต่ออกนอกโฟลเดอร์ */
const ALLOWED = new Map([
  ['card.jpg', 'cardFile'],
  ['video.mp4', 'videoFile'],
  ['video.gif', 'gifFile'],
]);

const PHOTO_RE = /^photo-(\d{1,2})\.jpg$/;

let cache = { at: 0, byToken: new Map() };

/** อ่าน session.json ของทุกเซสชันแล้วทำดัชนีจากกุญแจ (แคชสั้น ๆ กันอ่านดิสก์ทุกคำขอ) */
function index() {
  if (Date.now() - cache.at < 5000) return cache.byToken;
  const byToken = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(config.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch { /* ยังไม่มีโฟลเดอร์เซสชัน */ }

  for (const id of dirs) {
    const journalPath = path.join(config.sessionsDir, id, 'session.json');
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (journal.publicToken && TOKEN_RE.test(journal.publicToken)) {
        byToken.set(journal.publicToken, { id, dir: path.join(config.sessionsDir, id), journal });
      }
    } catch { /* เซสชันที่ยังเขียนไม่เสร็จหรือไฟล์เสีย ข้ามไป */ }
  }
  cache = { at: Date.now(), byToken };
  return byToken;
}

/** ให้เซสชันที่เพิ่งปิดโผล่ทันที ไม่ต้องรอแคชหมดอายุ */
export function forgetCache() {
  cache = { at: 0, byToken: new Map() };
}

export function findByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return index().get(token) || null;
}

/** path จริงของไฟล์ที่ขอ หรือ null ถ้าชื่อไม่อยู่ในรายการที่อนุญาต */
export function resolveFile(entry, requested) {
  const name = String(requested || '');
  const { journal, dir } = entry;

  if (ALLOWED.has(name)) {
    const stored = journal[ALLOWED.get(name)];
    // ไฟล์การ์ด/วิดีโออยู่ในโฟลเดอร์เซสชันอยู่แล้ว ยึดชื่อไฟล์ท้าย path เท่านั้น
    const file = stored ? path.join(dir, path.basename(stored)) : null;
    return file && fs.existsSync(file) ? file : null;
  }

  const photo = name.match(PHOTO_RE);
  if (photo) {
    // รูปดิบอยู่นอกโฟลเดอร์เซสชัน (โฟลเดอร์ที่กล้องส่งลงมา) จึงใช้ path จาก journal ตรง ๆ
    const stored = (journal.photos || [])[Number(photo[1]) - 1];
    return stored && fs.existsSync(stored) ? stored : null;
  }
  return null;
}

/** รายการไฟล์ที่ลูกค้าโหลดได้จริงในตอนนี้ */
export function fileList(entry) {
  const files = [];
  for (const name of ALLOWED.keys()) {
    if (resolveFile(entry, name)) {
      files.push({ kind: name.startsWith('video') ? (name.endsWith('.gif') ? 'gif' : 'video') : 'card', name });
    }
  }
  (entry.journal.photos || []).forEach((photo, i) => {
    const name = `photo-${i + 1}.jpg`;
    if (photo && resolveFile(entry, name)) files.push({ kind: 'photo', name });
  });
  return files;
}

/** หน้าเว็บที่ฝังค่าของตู้ไว้แล้ว — '<' ถูก escape กันค่าหลุดออกนอกแท็ก script */
export function renderPage(template, extra = {}) {
  const boothConfig = {
    eventName: config.eventName,
    ...extra,
  };
  const json = JSON.stringify(boothConfig).replace(/</g, '\\u003c');
  return template.replace('__BOOTH_CONFIG__', json);
}
