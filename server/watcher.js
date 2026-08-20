import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';
import { config } from './config.js';

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png']);
const RAW_EXT = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.iiq']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * เฝ้าโฟลเดอร์ Capture ของ Capture One
 * ช่างกดชัตเตอร์เอง ไฟล์ตกลงโฟลเดอร์ แล้วเราค่อยหยิบไปใช้
 */
export const watcher = new EventEmitter();

let handle = null;
let watchDir = null;
let lastError = null;
const seen = new Set();

/** รอจนไฟล์เขียนเสร็จ (ขนาดนิ่ง + เปิดอ่านได้) */
async function waitStable(file, { tries = 60, gap = 250 } = {}) {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    let size;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      await sleep(gap);
      continue;
    }
    if (size > 0 && size === last) {
      try {
        const fh = await fsp.open(file, 'r');
        await fh.close();
        return true;
      } catch {
        // ยังถูกล็อกโดยโปรแกรมที่เขียนอยู่
      }
    }
    last = size;
    await sleep(gap);
  }
  return false;
}

async function onFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (RAW_EXT.has(ext)) {
    // RAW จะถูกข้าม รอไฟล์ JPEG คู่ของมัน (ตั้งกล้องเป็น RAW+JPEG หรือให้ Capture One export JPEG)
    watcher.emit('raw', file);
    return;
  }
  if (!PHOTO_EXT.has(ext)) return;
  const key = path.resolve(file).toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);

  const ok = await waitStable(file);
  if (!ok) {
    watcher.emit('warn', `อ่านไฟล์ไม่สำเร็จ (ยังถูกล็อกอยู่): ${path.basename(file)}`);
    return;
  }
  watcher.emit('photo', file);
}

export function start(dir = config.watchDir) {
  stop();
  watchDir = dir;
  lastError = null;
  seen.clear();

  if (!dir) {
    lastError = 'ยังไม่ได้ตั้งโฟลเดอร์ Capture (WATCH_DIR)';
    return { ok: false, error: lastError };
  }
  if (!fs.existsSync(dir)) {
    lastError = `ไม่พบโฟลเดอร์: ${dir}`;
    return { ok: false, error: lastError };
  }

  handle = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 150 },
    usePolling: config.watchPolling,
    interval: 300,
  });

  handle.on('add', (file) => { onFile(file).catch((err) => watcher.emit('warn', err.message)); });
  handle.on('error', (err) => { lastError = err.message; watcher.emit('warn', err.message); });
  watcher.emit('watching', dir);
  return { ok: true, dir };
}

export function stop() {
  if (handle) {
    handle.close().catch(() => {});
    handle = null;
  }
}

export function status() {
  return { dir: watchDir, watching: Boolean(handle), error: lastError, source: config.captureSource };
}

/** โหมดทดสอบ: ปล่อยไฟล์ปลอมลงโฟลเดอร์ เหมือนช่างกดชัตเตอร์ */
export async function mockShot(targetDir) {
  const sharp = (await import('sharp')).default;
  const dir = targetDir || watchDir || config.watchDir || config.captureDir;
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `mock-${Date.now()}.jpg`);
  const hue = Math.floor(Math.random() * 360);
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#222' } })
    .composite([{
      input: Buffer.from(
        `<svg width="3000" height="2000" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="3000" height="2000" fill="hsl(${hue},55%,45%)"/>` +
        `<text x="1500" y="1050" font-size="200" fill="#fff" text-anchor="middle" font-family="Arial">MOCK ${new Date().toLocaleTimeString()}</text></svg>`,
      ),
      top: 0,
      left: 0,
    }])
    .jpeg({ quality: 90 })
    .toFile(out);
  return out;
}
