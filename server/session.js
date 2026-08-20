import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import { config } from './config.js';
import { camera } from './camera.js';
import { watcher, mockShot } from './watcher.js';
import { composePrint, makePreview } from './compose.js';
import { makeVideoFromFrames } from './video.js';
import * as nc from './nextcloud.js';

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

let actionLock = false;
let currentCancelToken = null;

export function snapshot(extra = {}) {
  const s = state.session;
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
    session: s && {
      id: s.id,
      total: config.shots,
      count: s.photos.length,
      previews: s.previews.map((n) => `/api/session/${s.id}/file/${n}`),
      shareUrl: s.shareUrl || null,
      qr: s.qr || null,
      printed: Boolean(s.printed),
      queueNumber: s.queueNumber || null,
      startedAt: s.startedAt,
    },
    ...extra,
  };
}

function emit(patch = {}) {
  if (patch.phase && patch.phase !== state.phase) {
    const validNext = ALLOWED_TRANSITIONS[state.phase] || [];
    if (!validNext.includes(patch.phase)) {
      console.warn(`[state] Invalid transition requested: ${state.phase} -> ${patch.phase}`);
    }
  }
  Object.assign(state, patch);
  bus.emit('update', snapshot());
}

function newSession() {
  const randomHex = Math.random().toString(36).substring(2, 6);
  const id = `${config.boothName}-${stamp()}-${randomHex}`;
  return {
    id,
    localDir: path.join(config.sessionsDir, id),
    rawDir: path.join(config.captureDir, id),
    startedAt: Date.now(),
    photos: [],
    previews: [],
    shareUrl: null,
    qr: null,
    printed: false,
  };
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  if (config.captureSource !== 'folder') return;
  idleTimer = setTimeout(() => {
    if (state.phase === 'shooting' && state.session?.photos.length) {
      finish('หมดเวลารอช็อตถัดไป').catch(reportError);
    }
  }, config.sessionIdleSeconds * 1000);
}

function reportError(err) {
  console.error('[session]', err);
  clearTimeout(idleTimer);
  capturing = false;
  emit({ phase: 'error', message: err.message, countdown: 0 });
}

async function beginSession() {
  clearTimeout(reviewTimer);
  if (currentCancelToken) currentCancelToken.cancelled = true;
  currentCancelToken = { cancelled: false };

  const s = newSession();
  await fsp.mkdir(s.localDir, { recursive: true });
  emit({ phase: 'shooting', session: s, message: '', countdown: 0 });
  return s;
}

/** เพิ่มหนึ่งช็อตเข้าเซสชัน (มาจากกล้องหรือจากโฟลเดอร์ที่เฝ้าอยู่) */
async function addPhoto(file) {
  if (actionLock) {
    console.warn('[session] Action locked, buffering photo:', file);
    buffered.push(file);
    return;
  }
  actionLock = true;
  try {
    if (state.phase === 'processing') {
      buffered.push(file);
      return;
    }
    if (state.phase !== 'shooting') await beginSession();

    const s = state.session;
    s.photos.push(file);
    const name = `preview-${s.photos.length}.jpg`;
    try {
      await makePreview(file, s.localDir, name);
      s.previews.push(name);
    } catch (err) {
      console.warn('[session] ทำภาพพรีวิวไม่ได้:', err.message);
    }
    emit({ lastPhotoAt: Date.now(), countdown: 0 });

    if (s.photos.length >= config.shots) await finish('ครบจำนวนช็อต');
    else armIdleTimer();
  } finally {
    actionLock = false;
  }
}

/** โหมด digicam: แอปนับถอยหลังและสั่งชัตเตอร์เอง */
export async function startSession() {
  if (config.captureSource === 'folder') {
    throw new Error('โหมดเฝ้าโฟลเดอร์ — ช่างกดชัตเตอร์เอง ไม่ต้องกดเริ่ม');
  }
  if (capturing || state.phase === 'processing' || actionLock) throw new Error('กำลังทำงานอยู่');

  capturing = true;
  const s = await beginSession();
  const token = currentCancelToken;
  runCaptureLoop(s, token).catch(reportError).finally(() => { capturing = false; });
  return s.id;
}

async function runCaptureLoop(s, cancelToken) {
  const mock = config.captureSource === 'mock';
  if (!mock) {
    await camera.setSessionFolder(s.rawDir);
    await camera.startLiveView();
  } else {
    await fsp.mkdir(s.rawDir, { recursive: true });
  }

  try {
    for (let i = 1; i <= config.shots; i++) {
      if (cancelToken?.cancelled) break;
      for (let t = config.countdown; t >= 1; t--) {
        if (cancelToken?.cancelled) break;
        emit({ countdown: t, shot: i });
        await sleep(1000);
      }
      if (cancelToken?.cancelled) break;
      emit({ countdown: 0, shot: i });
      bus.emit('update', snapshot({ flash: true }));
      emit({ message: 'กำลังบันทึกภาพ...' });

      const file = mock ? await mockShot(s.rawDir) : await camera.capture(s.rawDir);
      if (cancelToken?.cancelled) break;
      await addPhoto(file);
      if (state.phase !== 'shooting' || cancelToken?.cancelled) break;
      await sleep(config.shotGapSeconds * 1000);
    }
  } finally {
    if (!mock) await camera.stopLiveView();
  }
}

async function finish(reason) {
  clearTimeout(idleTimer);
  const s = state.session;
  if (!s || !s.photos.length) return;

  emit({ phase: 'processing', message: 'กำลังจัดหน้าและทำวิดีโอ...', countdown: 0 });
  console.log(`[session] ปิดเซสชัน ${s.id} (${reason}) — ${s.photos.length} ช็อต`);

  // การ์ด/ชีทปริ้นใช้แค่ช็อตล่าสุด N ภาพ (PRINT_SHOTS) ไม่ใช่ทุกช็อตที่ถ่าย — วิดีโอด้านล่างยังใช้ครบทุกช็อต
  const printPhotos = s.photos.slice(-config.printShots);
  const { print, card } = await composePrint(printPhotos, s.localDir, {
    title: config.eventName,
    subtitle: new Date(s.startedAt).toLocaleString('th-TH'),
    date: new Date(s.startedAt),
  });
  s.printFile = print;
  s.cardFile = card;

  const video = await makeVideoFromFrames(s.photos, s.localDir);
  s.videoFile = video.mp4;

  emit({ message: 'กำลังอัปโหลดขึ้นคลาวด์...' });
  const remoteDir = `${nc.NC_ROOT}/${s.id}`;
  await nc.ensureDir(remoteDir);

  const uploads = [[card, 'card.jpg'], [video.mp4, 'video.mp4']];
  if (video.gif) uploads.push([video.gif, 'video.gif']);
  s.photos.forEach((p, i) => uploads.push([p, `photo-${i + 1}${path.extname(p).toLowerCase()}`]));
  uploads.push([print, 'print.jpg']);
  for (const [local, name] of uploads) await nc.uploadFile(local, `${remoteDir}/${name}`);

  s.remoteDir = remoteDir;
  // ต้องเป็น share แยกต่อเซสชัน (root อยู่ที่โฟลเดอร์นี้เอง) ไม่ใช่ subfolder ของ share หลัก
  // ไม่งั้นลูกค้ากดขึ้น breadcrumb แล้วเห็นเซสชันคนอื่นได้ — ห้ามเด็ดขาด จึงไม่ fallback เงียบ ๆ
  const share = await nc.createSessionShare(remoteDir);
  s.shareUrl = share.url;
  s.shareId = share.shareId;
  s.qr = await QRCode.toDataURL(s.shareUrl, { width: 640, margin: 1, errorCorrectionLevel: 'M' });

  emit({ phase: 'done', message: '' });

  if (config.printOnDone) {
    sendToPrint(1).catch((err) => console.warn('[session] ส่งปริ้นอัตโนมัติไม่สำเร็จ:', err.message));
  }

  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    if (state.phase === 'done' && state.session?.id === s.id) reset();
  }, config.reviewSeconds * 1000);

  // ช็อตที่เข้ามาระหว่างประมวลผล = เซสชันถัดไป (โหมดเฝ้าโฟลเดอร์)
  if (buffered.length) {
    const next = buffered.splice(0, buffered.length);
    emit({ phase: 'idle', session: null });
    for (const file of next) await addPhoto(file);
  }
}

export function reset() {
  clearTimeout(idleTimer);
  clearTimeout(reviewTimer);
  if (currentCancelToken) currentCancelToken.cancelled = true;
  emit({ phase: 'idle', session: null, message: '', countdown: 0 });
}

export async function finishNow() {
  if (state.phase !== 'shooting' || !state.session?.photos.length) {
    throw new Error('ยังไม่มีช็อตในเซสชันนี้');
  }
  await finish('operator สั่งปิด');
}

export function discard() {
  if (state.phase === 'processing') throw new Error('กำลังอัปโหลดอยู่ ยกเลิกไม่ได้');
  if (currentCancelToken) currentCancelToken.cancelled = true;
  reset();
}

export async function sendToPrint(copies = 1) {
  const s = state.session;
  if (!s || !s.remoteDir) throw new Error('ยังไม่มีเซสชันที่อัปโหลดเสร็จ');

  // เลขคิวคงที่ต่อเซสชัน — สั่งปริ้นซ้ำ (reprint) ใช้เลขเดิม ไม่จองใหม่
  if (!s.queueNumber) s.queueNumber = await nc.claimQueueNumber();

  const job = {
    sessionId: s.id,
    queueNumber: s.queueNumber,
    booth: config.boothName,
    event: config.eventName,
    createdAt: new Date().toISOString(),
    copies: Math.max(1, Math.min(5, Number(copies) || 1)),
    printFile: `${s.remoteDir}/print.jpg`,
    layout: config.printLayout,
    status: 'queued',
  };
  await nc.ensureDir(`${nc.NC_ROOT}/_print/queue`);
  // ชื่อไฟล์ขึ้นต้นด้วยเลขคิว (zero-padded) ให้บูทปริ้นอ่านและเรียงลำดับได้โดยไม่ต้องเปิดไฟล์
  const fileName = `Q${nc.padQueueNumber(s.queueNumber)}__${s.id}__${Date.now()}.json`;
  await nc.putText(JSON.stringify(job, null, 2), `${nc.NC_ROOT}/_print/queue/${fileName}`);
  s.printed = true;
  emit({});
  return job;
}

/** ปุ่มทดสอบในจอช่าง: โหมด folder = ปล่อยไฟล์ลงโฟลเดอร์ที่เฝ้า, โหมดอื่น = เริ่มเซสชันปลอม */
export async function fakeShot() {
  if (config.captureSource === 'folder') return mockShot();
  const s = state.phase === 'shooting' ? state.session : await beginSession();
  const file = await mockShot(s.rawDir);
  await addPhoto(file);
  return file;
}

watcher.on('photo', (file) => { addPhoto(file).catch(reportError); });
watcher.on('warn', (msg) => console.warn('[watch]', msg));
watcher.on('raw', (file) => console.log('[watch] ข้าม RAW', path.basename(file)));
