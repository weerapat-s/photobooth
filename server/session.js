import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { camera } from './camera.js';
import { watcher, mockShot, start as startWatch, stop as stopWatch } from './watcher.js';
import { composeCard, makePreview } from './compose.js';
import { resolveLayout } from './layouts.js';
import { forgetCache } from './customer.js';
import { makeVideoFromFrames } from './video.js';
import * as nc from './nextcloud.js';
import { saveJournal, loadJournal, scanUnfinishedSessions, filterExistingPaths } from './journal.js';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export const state = {
  phase: 'idle', // idle | shooting | processing | done | error
  session: null,
  message: '',
  lastPhotoAt: null,
  countdown: 0,
  shot: 0,
};

let idleTimer = null;
let reviewTimer = null;
let capturing = false;
const buffered = [];

const ALLOWED_TRANSITIONS = {
  idle: ['shooting', 'error'],
  shooting: ['processing', 'idle', 'error'],
  processing: ['done', 'idle', 'error'],
  done: ['idle', 'shooting', 'error'],
  error: ['idle', 'shooting'],
};

let currentCancelToken = null;
let photoQueue = Promise.resolve();

const filledPhotos = (session) => (session?.photos || []).filter((file) => typeof file === 'string' && file);

function normalizeSlots(session) {
  if (!session) return;
  session.photos = Array.from({ length: config.shots }, (_, i) => session.photos?.[i] || null);
  session.previews = Array.from({ length: config.shots }, (_, i) => session.previews?.[i] || null);
}

export function snapshot(extra = {}) {
  const s = state.session;
  if (s) normalizeSlots(s);
  const slots = s ? Array.from({ length: config.shots }, (_, i) => ({
    number: i + 1,
    filled: Boolean(s.photos[i]),
    preview: s.previews[i] ? `/api/session/${s.id}/file/${s.previews[i]}` : null,
  })) : [];
  return {
    phase: state.phase,
    message: state.message,
    lastPhotoAt: state.lastPhotoAt,
    countdown: state.countdown,
    shot: state.shot,
    at: Date.now(),
    shots: config.shots,
    eventName: config.eventName,
    captureSource: config.captureSource,
    capturing,
    session: s && {
      id: s.id,
      total: config.shots,
      count: filledPhotos(s).length,
      slots,
      previews: slots.filter((slot) => slot.preview).map((slot) => slot.preview),
      activePreview: state.shot > 0 ? slots[state.shot - 1]?.preview || null : null,
      cardUrl: s.cardFile ? `/api/session/${s.id}/file/card.jpg` : null,
      shareUrl: s.shareUrl || null,
      qrUrl: s.qrUrl || s.shareUrl || null,
      qr: s.qr || null,
      startedAt: s.startedAt,
      layout: s.layout || null,
      files: localFileList(s),
      cloudError: s.cloudError || null,
    },
    ...extra,
  };
}

function emit(patch = {}) {
  if (patch.phase && patch.phase !== state.phase) {
    const validNext = ALLOWED_TRANSITIONS[state.phase] || [];
    if (!validNext.includes(patch.phase)) {
      throw new Error(`Invalid session transition: ${state.phase} -> ${patch.phase}`);
    }
  }
  Object.assign(state, patch);
  if (state.session) {
    saveJournal({
      ...state.session,
      phase: state.phase,
      lastError: state.message,
    });
  }
  bus.emit('update', snapshot());
}

function newSession(layoutId = null) {
  const randomHex = Math.random().toString(36).substring(2, 6);
  const id = `${config.boothName}-${stamp()}-${randomHex}`;
  return {
    id,
    // กุญแจเดาไม่ได้สำหรับหน้ารับรูปของลูกค้า — ชื่อเซสชันเดาได้ (ชื่อบูท+เวลา) จึงใช้เป็นกุญแจไม่ได้
    publicToken: randomBytes(16).toString('hex'),
    localDir: path.join(config.sessionsDir, id),
    rawDir: path.join(config.captureDir, id),
    startedAt: Date.now(),
    layout: layoutId,
    photos: [],
    previews: [],
    shareUrl: null,
    qr: null,
  };
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  // โหมดเจ้าหน้าที่ควบคุม: ห้ามจบเซสชันเองแม้เว้นช่วงนาน
}

function reportError(err) {
  console.error('[session]', err);
  clearTimeout(idleTimer);
  capturing = false;
  emit({ phase: 'error', message: err.message, countdown: 0 });
}

async function beginSession(layoutId = null) {
  clearTimeout(reviewTimer);
  if (currentCancelToken) currentCancelToken.cancelled = true;
  currentCancelToken = { cancelled: false };

  const s = newSession(layoutId);
  await fsp.mkdir(s.localDir, { recursive: true });
  normalizeSlots(s);
  emit({ phase: 'shooting', session: s, message: 'พร้อมถ่ายรูปที่ 1 — รอเจ้าหน้าที่กดถ่าย', countdown: 0, shot: 0 });
  return s;
}

async function removeSupersededFiles(s, photo, preview, replacementPhoto = null) {
  if (photo && (!replacementPhoto || path.resolve(photo) !== path.resolve(replacementPhoto))) {
    const rawRoot = `${path.resolve(s.rawDir)}${path.sep}`.toLowerCase();
    const resolved = path.resolve(photo).toLowerCase();
    if (resolved.startsWith(rawRoot)) await fsp.unlink(photo).catch(() => {});
  }
  if (preview) await fsp.unlink(path.join(s.localDir, path.basename(preview))).catch(() => {});
}

async function invalidateGeneratedOutputs(s) {
  for (const key of ['cardFile', 'videoFile', 'gifFile']) {
    const file = s[key];
    if (file && path.resolve(file).startsWith(`${path.resolve(s.localDir)}${path.sep}`)) {
      await fsp.unlink(file).catch(() => {});
    }
    s[key] = null;
  }
  s.uploaded = [];
  s.forceUploadAll = true;
}

/** วางภาพลงช่องคงที่ รูปอื่นจะไม่เลื่อนเมื่อมีการลบหรือถ่ายซ้ำ */
async function handlePhoto(file, requestedSlot = null) {
  if (state.phase === 'processing') {
    buffered.push(file);
    return;
  }
  if (state.phase !== 'shooting' || !state.session) {
    throw new Error('ต้องให้เจ้าหน้าที่กดเริ่มเซสชันก่อนถ่าย');
  }

  const s = state.session;
  normalizeSlots(s);
  const slotIndex = requestedSlot === null
    ? s.photos.findIndex((photo) => !photo)
    : Number(requestedSlot);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= config.shots) {
    throw new Error('ไม่มีช่องรูปว่างหรือหมายเลขช่องไม่ถูกต้อง');
  }

  const oldPhoto = s.photos[slotIndex];
  const oldPreview = s.previews[slotIndex];
  const name = `preview-${slotIndex + 1}-${Date.now()}.jpg`;
  await makePreview(file, s.localDir, name);
  s.photos[slotIndex] = file;
  s.previews[slotIndex] = name;
  await removeSupersededFiles(s, oldPhoto, oldPreview, file);
  await invalidateGeneratedOutputs(s);

  const count = filledPhotos(s).length;
  emit({
    lastPhotoAt: Date.now(),
    countdown: 0,
    shot: slotIndex + 1,
    message: count >= config.shots
      ? 'ครบทุกช่องแล้ว — เจ้าหน้าที่ตรวจรูปแล้วกดยืนยันจบงาน'
      : `รูปที่ ${slotIndex + 1} พร้อมตรวจ — เลือกถ่ายใหม่หรือถ่ายช่องถัดไป`,
  });
  armIdleTimer();
}

/** โปรแกรมไม่สั่งชัตเตอร์ ให้เจ้าหน้าที่กดที่ตัวกล้องเอง (ใช้ได้เฉพาะโหมดที่กล้องส่งไฟล์ลงโฟลเดอร์) */
function manualShutter() {
  return config.shutterMode === 'manual' && config.captureSource === 'digicam';
}

function addPhoto(file, slotIndex = null) {
  const task = photoQueue.then(() => handlePhoto(file, slotIndex));
  photoQueue = task.catch(() => {});
  return task;
}

/** เจ้าหน้าที่เริ่มเซสชันก่อน แล้วจึงกดถ่ายทีละช่อง */
export async function startSession({ layout } = {}) {
  if (capturing || state.phase === 'processing') throw new Error('กำลังทำงานอยู่');
  if (state.phase === 'shooting') throw new Error('มีเซสชันที่กำลังถ่ายอยู่แล้ว');

  if (config.captureSource === 'digicam') {
    const cameraStatus = await camera.status();
    if (!cameraStatus.ok) {
      throw new Error(cameraStatus.error || 'digiCamControl ยังไม่เห็นกล้อง');
    }
  }

  // ตัดสินเลย์เอาต์ทีเดียวตอนเริ่ม แล้วผูกไว้กับเซสชัน
  // ถ้าไปตัดสินตอนประกอบการ์ด ช่างสลับค่ากลางคันแล้วลูกค้าจะได้คนละแบบกับที่กดเลือก
  const chosen = resolveLayout(layout);
  const s = await beginSession(chosen?.id || null);
  try {
    await fsp.mkdir(s.rawDir, { recursive: true });
    if (config.captureSource === 'digicam') await camera.setSessionFolder(s.rawDir);
    // ชัตเตอร์มือ: ไม่สั่งกล้อง แต่ไปเฝ้าโฟลเดอร์ของเซสชันแทน
    // ไฟล์ที่กล้องส่งลงมาตอนเจ้าหน้าที่กดชัตเตอร์จะเข้าช่องว่างเองผ่าน watcher
    if (manualShutter()) {
      const watching = startWatch(s.rawDir);
      if (!watching.ok) throw new Error(`เฝ้าโฟลเดอร์ของเซสชันไม่ได้: ${watching.error}`);
    }
  } catch (err) {
    reportError(err);
    throw err;
  }
  return s.id;
}

export async function captureSlot(slotNumber = null) {
  if (capturing) throw new Error('กล้องกำลังทำงานอยู่ กรุณารอ');
  if (state.phase !== 'shooting' || !state.session) throw new Error('ต้องกดเริ่มเซสชันก่อน');
  if (config.captureSource === 'folder') throw new Error('โหมด folder ให้เจ้าหน้าที่กดชัตเตอร์ที่กล้อง ภาพจะเข้าช่องว่างอัตโนมัติ');
  if (manualShutter()) throw new Error('ตั้งไว้ให้เจ้าหน้าที่กดชัตเตอร์ที่กล้องเอง ภาพจะเข้าช่องว่างอัตโนมัติ');
  if (config.captureSource === 'ipad' || config.captureSource === 'web') {
    throw new Error('โหมด iPad/Web ต้องส่งภาพ JPEG จากอุปกรณ์เข้า API');
  }

  const s = state.session;
  normalizeSlots(s);
  const slotIndex = slotNumber === null || slotNumber === undefined
    ? s.photos.findIndex((photo) => !photo)
    : Number(slotNumber) - 1;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= config.shots) {
    throw new Error('หมายเลขช่องรูปไม่ถูกต้องหรือรูปครบแล้ว');
  }

  capturing = true;
  const cancelToken = currentCancelToken;
  const mock = config.captureSource === 'mock';
  try {
    for (let t = config.countdown; t >= 1; t--) {
      if (cancelToken?.cancelled) throw new Error('ยกเลิกการถ่ายแล้ว');
      emit({ countdown: t, shot: slotIndex + 1, message: `เตรียมถ่ายรูปที่ ${slotIndex + 1}` });
      await sleep(1000);
    }
    if (cancelToken?.cancelled) throw new Error('ยกเลิกการถ่ายแล้ว');
    emit({ countdown: 0, shot: slotIndex + 1, message: `กำลังบันทึกรูปที่ ${slotIndex + 1}...` });
    bus.emit('update', snapshot({ flash: true }));
    const file = mock ? await mockShot(s.rawDir) : await camera.capture(s.rawDir);
    if (cancelToken?.cancelled) return null;
    await addPhoto(file, slotIndex);
    return file;
  } catch (err) {
    if (!cancelToken?.cancelled && state.phase === 'shooting') {
      emit({ countdown: 0, message: `ถ่ายรูปที่ ${slotIndex + 1} ไม่สำเร็จ: ${err.message}` });
    }
    throw err;
  } finally {
    capturing = false;
    if (state.phase === 'shooting') emit({});
  }
}

/** รับ JPEG จากแอป iPad เดิมหรือ PWA แล้ววางลงช่องเดิมของ pipeline */
export async function ingestIpadPhoto(slotNumber, data) {
  if (state.phase !== 'shooting' || !state.session) throw new Error('ต้องเริ่มเซสชันก่อนส่งภาพ');
  if (!Buffer.isBuffer(data) || data.length < 4) throw new Error('ไม่พบข้อมูลภาพ JPEG');
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('รองรับเฉพาะไฟล์ JPEG');

  const slotIndex = Number(slotNumber) - 1;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= config.shots) {
    throw new Error('หมายเลขช่องรูปไม่ถูกต้อง');
  }

  const s = state.session;
  await fsp.mkdir(s.rawDir, { recursive: true });
  const prefix = config.captureSource === 'web' ? 'web' : 'ipad';
  const file = path.join(s.rawDir, `${prefix}-${slotIndex + 1}-${Date.now()}.jpg`);
  await fsp.writeFile(file, data);
  try {
    await addPhoto(file, slotIndex);
    return file;
  } catch (err) {
    await fsp.unlink(file).catch(() => {});
    throw err;
  }
}

export async function deletePhoto(slotNumber) {
  if (capturing) throw new Error('กล้องกำลังทำงานอยู่ กรุณารอ');
  if (state.phase !== 'shooting' || !state.session) throw new Error('ไม่มีเซสชันที่กำลังถ่าย');
  const slotIndex = Number(slotNumber) - 1;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= config.shots) throw new Error('หมายเลขช่องรูปไม่ถูกต้อง');
  const s = state.session;
  normalizeSlots(s);
  if (!s.photos[slotIndex]) throw new Error(`ช่องรูปที่ ${slotNumber} ว่างอยู่แล้ว`);
  const oldPhoto = s.photos[slotIndex];
  const oldPreview = s.previews[slotIndex];
  s.photos[slotIndex] = null;
  s.previews[slotIndex] = null;
  await removeSupersededFiles(s, oldPhoto, oldPreview);
  await invalidateGeneratedOutputs(s);
  emit({ shot: slotIndex + 1, message: `ลบรูปที่ ${slotNumber} แล้ว — กดถ่ายช่องนี้ใหม่ได้เลย` });
}

async function finish(reason) {
  clearTimeout(idleTimer);
  const s = state.session;
  const validPhotos = filledPhotos(s);
  if (!s || !validPhotos.length) return;

  // เลิกเฝ้าโฟลเดอร์ทันทีที่เริ่มประมวลผล กันรูปที่ตกลงมาช้าเข้ามาปนกับเซสชันที่ปิดไปแล้ว
  if (manualShutter()) stopWatch();
  emit({ phase: 'processing', message: 'กำลังจัดหน้าและทำวิดีโอ...', countdown: 0 });
  console.log(`[session] ปิดเซสชัน ${s.id} (${reason}) — ${validPhotos.length} ช็อต`);

  // การ์ดใช้แค่ช็อตล่าสุด N ภาพ (PRINT_SHOTS) ไม่ใช่ทุกช็อตที่ถ่าย — วิดีโอด้านล่างยังใช้ครบทุกช็อต
  if (!s.cardFile || !filterExistingPaths([s.cardFile]).length) {
    const cardPhotos = validPhotos.slice(-config.printShots);
    const { card } = await composeCard(cardPhotos, s.localDir, {
      layout: s.layout,
      title: config.eventName,
      subtitle: new Date(s.startedAt).toLocaleString('th-TH'),
      date: new Date(s.startedAt),
    });
    s.cardFile = card;
  }

  if (!s.videoFile || !filterExistingPaths([s.videoFile]).length) {
    try {
      const video = await makeVideoFromFrames(validPhotos, s.localDir);
      s.videoFile = video.mp4;
      s.gifFile = video.gif || null;
    } catch (vidErr) {
      console.warn('[session] ไม่สามารถสร้างวิดีโอได้ (ข้ามไปสร้างการ์ดและ QR ต่อ):', vidErr.message);
      s.videoFile = null;
      s.gifFile = null;
    }
  }

  // รูปพร้อมส่งให้ลูกค้าแล้วจากเครื่องนี้ การอัปขึ้นคลาวด์เป็นการสำรองไว้ทีหลัง
  // NAS ล่มต้องไม่ทำให้ลูกค้าไม่ได้รูป จึงไม่โยน error ออกไป แต่บันทึกไว้ให้ช่างเห็น
  s.cloudError = null;
  try {
    // เช็คสั้น ๆ ก่อน ถ้าคลาวด์ไม่ตอบก็ข้ามทันที ไม่งั้นติด timeout ยาวทีละคำขอ
    const reachable = await Promise.race([
      nc.health().then((result) => result.ok),
      new Promise((resolve) => setTimeout(() => resolve(false), config.cloudProbeMs)),
    ]);
    if (!reachable) throw new Error('คลาวด์ไม่ตอบ');
    emit({ message: 'กำลังอัปโหลดขึ้นคลาวด์...' });
    const remoteDir = s.remoteDir || `${nc.NC_ROOT}/${s.id}`;
    s.remoteDir = remoteDir;
    await nc.ensureDir(remoteDir);
    const existingRemoteNames = new Set(
      (await nc.list(remoteDir).catch(() => [])).filter((item) => !item.isDir).map((item) => item.name),
    );

    const uploads = [];
    if (s.cardFile && fs.existsSync(s.cardFile)) uploads.push([s.cardFile, 'card.jpg']);
    if (s.videoFile && fs.existsSync(s.videoFile)) uploads.push([s.videoFile, 'video.mp4']);
    if (s.gifFile && fs.existsSync(s.gifFile)) uploads.push([s.gifFile, 'video.gif']);
    s.photos.forEach((p, i) => {
      if (p && fs.existsSync(p)) uploads.push([p, `photo-${i + 1}${path.extname(p).toLowerCase()}`]);
    });
    s.uploaded = (Array.isArray(s.uploaded) ? s.uploaded : []).filter((name) => existingRemoteNames.has(name));
    if (s.forceUploadAll) s.uploaded = [];
    for (const [local, name] of uploads) {
      if (s.uploaded.includes(name)) continue;
      await nc.uploadFile(local, `${remoteDir}/${name}`);
      s.uploaded.push(name);
      emit({ message: `อัปโหลด ${name} แล้ว` });
    }
    s.forceUploadAll = false;

    // ต้องเป็น share แยกต่อเซสชัน (root อยู่ที่โฟลเดอร์นี้เอง) ไม่ใช่ subfolder ของ share หลัก
    // ไม่งั้นลูกค้ากดขึ้น breadcrumb แล้วเห็นเซสชันคนอื่นได้ — ห้ามเด็ดขาด จึงไม่ fallback เงียบ ๆ
    if (!s.shareUrl) {
      const existingShares = await nc.findSessionShares(remoteDir).catch(() => []);
      const share = existingShares[0] || await nc.createSessionShare(remoteDir);
      s.shareUrl = share.url;
      s.shareId = share.shareId;
    }
  } catch (err) {
    s.cloudError = err.message;
    console.error(`[session] อัปขึ้นคลาวด์ไม่สำเร็จ ${s.id} — ลูกค้ายังรับรูปจากตู้ได้:`, err.message);
  }

  s.qrUrl = customerLandingUrl(s) || s.shareUrl;
  s.qr = await QRCode.toDataURL(s.qrUrl, { width: 640, margin: 1, errorCorrectionLevel: 'M' });

  // เซสชันที่เพิ่งปิดต้องเปิดรับรูปได้ทันที ไม่ต้องรอแคชหมดอายุ
  forgetCache();
  emit({ phase: 'done', message: '' });
  armReviewTimer(s.id);

  // ช็อตที่เข้ามาระหว่างประมวลผล = เซสชันถัดไป (โหมดเฝ้าโฟลเดอร์)
  if (buffered.length) {
    const next = buffered.splice(0, buffered.length);
    emit({ phase: 'idle', session: null });
    queueMicrotask(() => {
      for (const file of next) addPhoto(file).catch(reportError);
    });
  }
}

/**
 * ไฟล์ที่ลูกค้าโหลดได้ พร้อมชื่อที่จะใช้ตอนบันทึก
 * อ่านจากโฟลเดอร์เซสชันในเครื่องนี้ ไม่ต้องรอ NAS
 */
export function localFileList(s) {
  if (!s) return [];
  const list = [];
  if (s.cardFile) list.push({ kind: 'card', name: 'card.jpg', path: s.cardFile });
  if (s.videoFile) list.push({ kind: 'video', name: 'video.mp4', path: s.videoFile });
  if (s.gifFile) list.push({ kind: 'gif', name: 'video.gif', path: s.gifFile });
  (s.photos || []).forEach((photo, index) => {
    if (photo) list.push({ kind: 'photo', name: `photo-${index + 1}.jpg`, path: photo });
  });
  return list.filter((item) => filterExistingPaths([item.path]).length).map(({ kind, name }) => ({ kind, name }));
}

/**
 * ลิงก์ที่ใส่ใน QR บนจอ: หน้าชวนสนับสนุนบนมือถือลูกค้า ซึ่งมีปุ่มข้ามไปรับรูปได้ทันที
 *
 * ส่งไปแค่ token ของลิงก์แชร์เซสชันนั้น ใส่ไว้หลังเครื่องหมาย # ซึ่งเบราว์เซอร์ไม่ส่งขึ้นเซิร์ฟเวอร์
 * ตัวตู้และ tunnel จึงไม่เห็นว่าใครเปิดรูปของเซสชันไหน และหน้านั้นประกอบลิงก์ NAS เองจาก token
 * ไม่รับ URL เต็มทางลิงก์ เพราะจะกลายเป็นช่องให้คนเอาโดเมนของตู้ไปทำลิงก์หลอกพาไปเว็บอื่น
 */
function customerLandingUrl(session) {
  if (!config.publicUrl || !session?.publicToken) return null;
  const page = config.promptpayId ? 'r' : 'g';
  return `${config.publicUrl}/${page}#${session.publicToken}`;
}

/** นับถอยหลังกลับหน้าแรกหลังโชว์ผลงาน */
function armReviewTimer(sessionId) {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    if (state.phase === 'done' && state.session?.id === sessionId) reset();
  }, config.reviewSeconds * 1000);
  return config.reviewSeconds;
}

export function reset() {
  clearTimeout(idleTimer);
  clearTimeout(reviewTimer);
  // โหมดชัตเตอร์มือเฝ้าโฟลเดอร์เป็นราย ๆ เซสชัน จบแล้วต้องเลิกเฝ้า
  // ไม่งั้นรูปที่ตกลงมาทีหลังจะไปโผล่ในเซสชันของคนถัดไป
  if (manualShutter()) stopWatch();
  if (currentCancelToken) currentCancelToken.cancelled = true;
  emit({ phase: 'idle', session: null, message: '', countdown: 0 });
}

export async function finishNow() {
  if (capturing) throw new Error('กำลังถ่ายอยู่ กรุณารอให้รูปบันทึกเสร็จ');
  await photoQueue;
  if (state.phase !== 'shooting' || !filledPhotos(state.session).length) {
    throw new Error('ยังไม่มีช็อตในเซสชันนี้');
  }
  const missing = state.session.photos
    .map((photo, i) => photo ? null : i + 1)
    .filter(Boolean);
  if (missing.length) throw new Error(`ยังขาดรูปช่องที่ ${missing.join(', ')}`);
  await finish('operator สั่งปิด');
}

export function discard() {
  if (state.phase === 'processing') throw new Error('กำลังอัปโหลดอยู่ ยกเลิกไม่ได้');
  if (currentCancelToken) currentCancelToken.cancelled = true;
  if (state.session) saveJournal({ ...state.session, phase: 'discarded', lastError: 'operator discarded' });
  reset();
}

export async function recoverSession(sessionId, action = 'resume') {
  const safeId = path.basename(String(sessionId));
  if (!safeId || safeId !== sessionId) throw new Error('รหัสเซสชันไม่ถูกต้อง');
  if (state.phase === 'shooting' || state.phase === 'processing') throw new Error('กำลังมีเซสชันทำงานอยู่');
  const sessionDir = path.join(config.sessionsDir, safeId);
  const journal = loadJournal(sessionDir);
  if (!journal) throw new Error(`ไม่พบ Journal ของเซสชัน ${sessionId}`);

  if (action === 'discard') {
    await fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, action: 'discarded' };
  }

  // โหลดเซสชันเดิมกลับมาเป็น active session
  const s = {
    id: journal.id,
    publicToken: journal.publicToken || randomBytes(16).toString('hex'),
    localDir: sessionDir,
    rawDir: path.join(config.captureDir, journal.id),
    startedAt: journal.startedAt || Date.now(),
    photos: Array.from({ length: config.shots }, (_, i) => {
      const file = journal.photos?.[i];
      return file && filterExistingPaths([file]).length ? file : null;
    }),
    previews: Array.from({ length: config.shots }, (_, i) => journal.previews?.[i] || null),
    cardFile: journal.cardFile || null,
    videoFile: journal.videoFile || null,
    gifFile: journal.gifFile || null,
    uploaded: journal.uploaded || [],
    remoteDir: journal.remoteDir || null,
    shareUrl: journal.shareUrl || null,
    shareId: journal.shareId || null,
    qr: null,
    forceUploadAll: Boolean(journal.forceUploadAll),
  };

  emit({ phase: 'shooting', session: s, message: 'กู้คืนแล้ว — ตรวจรูป ลบ หรือถ่ายช่องที่ต้องการใหม่ได้' });
  return { ok: true, session: s };
}

/** ปุ่มทดสอบในจอช่าง: โหมด folder ปล่อยไฟล์เข้า watcher, โหมดอื่นเพิ่มภาพปลอมเข้าเซสชัน */
export async function fakeShot(slotNumber = null) {
  if (config.captureSource === 'folder') return mockShot();
  if (state.phase !== 'shooting') throw new Error('ต้องกดเริ่มเซสชันก่อน');
  // ชัตเตอร์มือ: จำลองให้เหมือนกล้องส่งไฟล์ลงโฟลเดอร์ของเซสชัน แล้วปล่อยให้ watcher หยิบเอง
  if (manualShutter()) return mockShot(state.session.rawDir);
  return captureSlot(slotNumber);
}

export { scanUnfinishedSessions };

watcher.on('photo', (file) => {
  if (state.phase !== 'shooting') {
    console.log('[watch] ข้ามภาพเพราะเจ้าหน้าที่ยังไม่ได้เริ่มเซสชัน', path.basename(file));
    return;
  }
  addPhoto(file).catch(reportError);
});
watcher.on('warn', (msg) => console.warn('[watch]', msg));
watcher.on('raw', (file) => console.log('[watch] ข้าม RAW', path.basename(file)));
