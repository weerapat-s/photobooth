const $ = (id) => document.getElementById(id);
const screens = {
  setup: $('screen-setup'), idle: $('screen-idle'), shoot: $('screen-shoot'),
  processing: $('screen-processing'), done: $('screen-done'), error: $('screen-error'),
};

let cfg = { shots: 4, countdown: 3, eventName: 'Photo Booth', reviewSeconds: 90, captureSource: 'digicam', liveView: false, devicePreview: true, kioskMode: 'operator', cameraFacing: 'user', mirror: true };
let liveTimer = null;
let cameraStream = null;
let eventStream = null;
let doneDeadline = 0;
let shownSessionId = null;
let shownPhotoAt = null;
let latestState = null;
let capturePending = false;
let cameraReady = false;
let cameraStatusTimer = null;
let cameraStatusPending = false;

const isSelfService = () => cfg.kioskMode === 'self_service';
const isWebCamera = () => cfg.captureSource === 'web';
// โหมด digicam ใช้กล้อง iPad เป็นกระจก/Live View เท่านั้น ส่วนไฟล์จริงยังมาจาก EOS R
const usesDevicePreview = () => isWebCamera() || (cfg.captureSource === 'digicam' && cfg.devicePreview !== false);
const usesPairedKiosk = () => isSelfService();
const startPath = () => usesPairedKiosk() ? '/api/web/session' : '/api/start';
const resetPath = () => usesPairedKiosk() ? '/api/web/session/reset' : '/api/reset';
const finishPath = () => usesPairedKiosk() ? '/api/web/session/finish' : '/api/finish';
const discardPath = () => usesPairedKiosk() ? '/api/web/session' : '/api/discard';

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  if (name === 'shoot') {
    if (usesDevicePreview()) ensureCamera().catch((err) => { $('shoot-status').textContent = cameraErrorMessage(err); });
    else startServerLiveView();
  } else stopServerLiveView();
  if (name !== 'shoot') stopCamera();
}

function startServerLiveView() {
  if (!cfg.liveView || liveTimer) return;
  const video = $('liveview');
  video.hidden = true;
  let fallback = $('server-liveview');
  if (!fallback) {
    fallback = document.createElement('img');
    fallback.id = 'server-liveview';
    fallback.alt = 'ภาพสดจาก EOS R';
    video.after(fallback);
  }
  fallback.hidden = false;
  fallback.classList.toggle('mirrored', Boolean(cfg.mirror));
  const liveViewPath = usesPairedKiosk() ? '/api/web/liveview.jpg' : '/api/liveview.jpg';
  const refresh = () => { fallback.src = liveViewPath + '?t=' + Date.now(); };
  refresh();
  liveTimer = setInterval(refresh, 220);
}

function stopServerLiveView() {
  clearInterval(liveTimer);
  liveTimer = null;
  $('server-liveview')?.remove();
}

async function ensureCamera() {
  if (!usesDevicePreview()) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้ กรุณาใช้ Safari ผ่าน HTTPS');
  if (!window.isSecureContext) throw new Error('กล้องเว็บต้องเปิดผ่าน HTTPS เท่านั้น');
  if (cameraStream?.active) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: cfg.cameraFacing || 'user' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
  });
  const video = $('liveview');
  video.srcObject = cameraStream;
  video.hidden = false;
  video.classList.toggle('mirrored', Boolean(cfg.mirror));
  await video.play();
  if (!video.videoWidth) await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
}

function stopCamera() {
  if (!cameraStream) return;
  for (const track of cameraStream.getTracks()) track.stop();
  cameraStream = null;
  $('liveview').srcObject = null;
}

function renderDots(total, slots, active) {
  const bar = $('shotbar');
  if (bar.childElementCount !== total) {
    bar.innerHTML = '';
    for (let i = 0; i < total; i++) bar.appendChild(document.createElement('div'));
  }
  [...bar.children].forEach((dot, index) => {
    dot.className = 'dot' + (slots?.[index]?.filled ? ' done' : index === active ? ' active' : '');
  });
}

function flash() {
  const el = $('flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function takeWebPhoto(slot) {
  await ensureCamera();
  $('lastshot').hidden = true;
  $('liveview').hidden = false;
  for (let count = Number(cfg.countdown || 0); count >= 1; count--) {
    $('count').textContent = count;
    $('shoot-status').textContent = `เตรียมถ่ายรูปที่ ${slot}`;
    await wait(1000);
  }
  $('count').textContent = '';
  flash();

  const video = $('liveview');
  const canvas = $('capture-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { alpha: false });
  if (cfg.mirror) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('สร้างไฟล์ภาพไม่สำเร็จ')),
    'image/jpeg', 0.94,
  ));
  $('shoot-status').textContent = 'กำลังบันทึกรูป...';
  await api(`/api/web/session/photo/${slot}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
}

async function captureForReview(slot) {
  if (capturePending) return;
  capturePending = true;
  $('review-actions').hidden = true;
  $('btn-retake').hidden = false;
  $('lastshot').hidden = true;
  $('shoot-status').textContent = `กำลังเตรียมถ่ายรูปที่ ${slot}...`;
  try {
    if (usesDevicePreview()) {
      await ensureCamera();
      $('liveview').hidden = false;
    } else startServerLiveView();
    if (isWebCamera()) await takeWebPhoto(slot);
    else if (cfg.captureSource === 'ipad') throw new Error('โหมด Native iPad ต้องใช้แอป Photo Booth รุ่นเดิม');
    else await api(usesPairedKiosk() ? '/api/web/capture' : '/api/capture', { method: 'POST', body: JSON.stringify({ slot }) });
  } catch (err) {
    $('shoot-status').textContent = 'ถ่ายไม่สำเร็จ: ' + cameraErrorMessage(err);
    $('review-actions').hidden = false;
    $('btn-accept').textContent = 'ลองถ่ายอีกครั้ง';
    $('btn-retake').hidden = true;
  } finally {
    capturePending = false;
  }
}

function cameraErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return 'ยังไม่ได้อนุญาตใช้กล้อง กรุณาอนุญาต Camera ใน Safari Settings';
  if (err?.name === 'NotFoundError') return 'ไม่พบกล้องบนอุปกรณ์';
  if (err?.name === 'NotReadableError') return 'กล้องถูกแอปอื่นใช้งานอยู่';
  return err?.message || 'ไม่ทราบสาเหตุ';
}

async function refreshCameraStatus({ showChecking = false } = {}) {
  if (cfg.captureSource !== 'digicam' || cameraStatusPending) return;
  cameraStatusPending = true;
  const box = $('camera-ready');
  box.hidden = false;
  if (showChecking) {
    box.className = 'camera-ready';
    $('camera-ready-text').textContent = 'กำลังตรวจ EOS R...';
  }
  try {
    const statusPath = usesPairedKiosk() ? '/api/web/camera/status' : '/api/camera/status';
    const response = await fetch(statusPath, { credentials: 'same-origin', cache: 'no-store' });
    const status = await response.json().catch(() => ({}));
    cameraReady = response.ok && Boolean(status.ok);
    box.className = 'camera-ready ' + (cameraReady ? 'ok' : 'bad');
    $('camera-ready-text').textContent = cameraReady
      ? `EOS R พร้อม · ${status.transport || 'digiCamControl'}`
      : (status.error || 'ยังไม่พบ EOS R');
    if (screens.idle.hidden === false) $('btn-start').disabled = !cameraReady;
    if (cameraReady && $('idle-hint').textContent.startsWith('กล้องยังไม่พร้อม')) $('idle-hint').textContent = '';
  } catch (err) {
    cameraReady = false;
    box.className = 'camera-ready bad';
    $('camera-ready-text').textContent = 'ติดต่อ Windows bridge ไม่ได้';
    if (screens.idle.hidden === false) $('btn-start').disabled = true;
  } finally {
    cameraStatusPending = false;
  }
}

$('btn-camera-retry').onclick = () => refreshCameraStatus({ showChecking: true });

$('btn-pair').onclick = async () => {
  const token = $('pair-token').value.trim();
  $('pair-error').textContent = '';
  $('btn-pair').disabled = true;
  try {
    await api('/api/web/pair', { method: 'POST', body: JSON.stringify({ token }) });
    $('pair-token').value = '';
    await boot();
  } catch (err) {
    $('pair-error').textContent = err.message;
  } finally {
    $('btn-pair').disabled = false;
  }
};

$('btn-start').onclick = async () => {
  if (cfg.captureSource === 'digicam' && !cameraReady) {
    await refreshCameraStatus({ showChecking: true });
    if (!cameraReady) return;
  }
  $('btn-start').disabled = true;
  $('idle-hint').textContent = '';
  try {
    if (usesDevicePreview()) await ensureCamera();
    const result = await api(startPath(), { method: 'POST' });
    applyState(result.state || await api(usesPairedKiosk() ? '/api/web/bootstrap' : '/api/state').then((data) => data.state || data));
    if (isSelfService()) await captureForReview(1);
  } catch (err) {
    $('idle-hint').textContent = cameraErrorMessage(err);
  } finally {
    setTimeout(() => { $('btn-start').disabled = false; }, 1000);
  }
};

$('btn-again').onclick = () => api(resetPath(), { method: 'POST' });
$('btn-back').onclick = () => api(resetPath(), { method: 'POST' });

$('btn-accept').onclick = async () => {
  const state = latestState;
  if (!state?.session || capturePending) return;
  $('btn-accept').disabled = true;
  try {
    if (state.session.count >= state.session.total) {
      $('review-actions').hidden = true;
      await api(finishPath(), { method: 'POST' });
      return;
    }
    const next = state.session.slots.find((slot) => !slot.filled)?.number;
    if (next) await captureForReview(next);
  } catch (err) {
    $('shoot-status').textContent = err.message;
    $('review-actions').hidden = false;
  } finally {
    $('btn-accept').disabled = false;
  }
};

$('btn-retake').onclick = async () => {
  const slot = latestState?.shot;
  if (slot > 0) await captureForReview(slot);
};

$('btn-cancel-session').onclick = async () => {
  if (capturePending) return;
  await api(discardPath(), { method: usesPairedKiosk() ? 'DELETE' : 'POST' }).catch((err) => { $('shoot-status').textContent = err.message; });
};

$('btn-print').onclick = async () => {
  $('btn-print').disabled = true;
  $('print-status').textContent = 'กำลังส่งไปเครื่องปริ้น...';
  try {
    await api(usesPairedKiosk() ? '/api/web/print' : '/api/print', { method: 'POST', body: JSON.stringify({ copies: 1 }) });
    $('print-status').textContent = 'ส่งเข้าคิวปริ้นแล้ว รอรับที่บูทปริ้น';
  } catch (err) {
    $('print-status').textContent = 'ส่งไม่สำเร็จ: ' + err.message;
    $('btn-print').disabled = false;
  }
};

function applyState(state) {
  latestState = state;
  if (state.eventName) $('event-title').textContent = state.eventName;
  if (state.phase === 'idle') {
    shownSessionId = null;
    shownPhotoAt = null;
    show('idle');
    return;
  }
  if (state.phase === 'shooting' && state.session) {
    show('shoot');
    const { count, total, previews, slots, activePreview } = state.session;
    $('review-actions').hidden = true;
    $('btn-retake').hidden = false;
    renderDots(total, slots, state.shot ? state.shot - 1 : slots.findIndex((slot) => !slot.filled));
    $('shot-badge').textContent = `${count} / ${total}`;
    const justShot = state.lastPhotoAt && state.lastPhotoAt !== shownPhotoAt && previews.length;
    if (state.capturing) {
      $('lastshot').hidden = true;
      if (usesDevicePreview()) $('liveview').hidden = false;
      else startServerLiveView();
      $('count').textContent = state.countdown > 0 ? state.countdown : '';
      $('shoot-status').textContent = state.message || 'กำลังเตรียมกล้อง...';
      if (state.flash) flash();
      return;
    }
    if (justShot) {
      $('lastshot').src = activePreview || previews[previews.length - 1];
      shownPhotoAt = state.lastPhotoAt;
    }
    if (justShot || (!$('lastshot').hidden && activePreview)) {
      if (!usesDevicePreview()) stopServerLiveView();
      $('lastshot').hidden = false;
      $('liveview').hidden = true;
      $('count').textContent = '';
      if (isSelfService() && !state.capturing && activePreview) {
        $('review-actions').hidden = false;
        $('shoot-status').textContent = count >= total ? 'ครบแล้ว ตรวจรูปสุดท้ายก่อนยืนยัน' : 'ชอบรูปนี้ไหม?';
        $('btn-accept').textContent = count >= total ? 'ยืนยันและรับรูป' : 'ใช้รูปนี้';
      } else {
        $('shoot-status').textContent = count >= total ? 'ครบแล้ว รอเจ้าหน้าที่ตรวจรูป' : 'รอเจ้าหน้าที่ตรวจรูป';
      }
    } else if (usesDevicePreview() && isSelfService() && !capturePending) {
      $('lastshot').hidden = true;
      $('liveview').hidden = false;
      $('review-actions').hidden = false;
      $('btn-accept').textContent = 'ถ่ายต่อ';
      $('btn-retake').hidden = true;
      $('shoot-status').textContent = 'เซสชันเดิมยังอยู่ แตะถ่ายต่อได้เลย';
    } else {
      $('count').textContent = '';
      $('shoot-status').textContent = state.message || 'กำลังเตรียมกล้อง...';
    }
    return;
  }
  if (state.phase === 'processing') {
    show('processing');
    $('proc-msg').textContent = state.message || 'กำลังประมวลผล...';
    return;
  }
  if (state.phase === 'done' && state.session) {
    if (shownSessionId !== state.session.id) {
      shownSessionId = state.session.id;
      $('qr').src = state.session.qr || '';
      $('share-url').textContent = state.session.shareUrl || '';
      $('card').src = state.session.previews[0] || '';
      $('btn-print').disabled = false;
      $('print-status').textContent = '';
      doneDeadline = Date.now() + (cfg.reviewSeconds || 90) * 1000;
    }
    $('btn-print').disabled = Boolean(state.session.printed);
    if (state.session.printed && !$('print-status').textContent) $('print-status').textContent = 'ส่งเข้าคิวปริ้นแล้ว';
    $('queue-number').hidden = !state.session.queueNumber;
    $('queue-number').textContent = state.session.queueNumber ? `คิวปริ้น #${state.session.queueNumber}` : '';
    show('done');
    return;
  }
  if (state.phase === 'error') {
    show('error');
    $('err-msg').textContent = state.message || 'ไม่ทราบสาเหตุ';
  }
}

setInterval(() => {
  if (screens.done.hidden) return;
  const left = Math.max(0, Math.ceil((doneDeadline - Date.now()) / 1000));
  $('timer').textContent = `จอจะกลับหน้าแรกใน ${left} วินาที`;
}, 500);

function connectEvents() {
  eventStream?.close();
  eventStream = new EventSource(usesPairedKiosk() ? '/api/web/events' : '/api/events', { withCredentials: true });
  eventStream.onmessage = (event) => applyState(JSON.parse(event.data));
  eventStream.onerror = () => {
    const target = latestState?.phase === 'shooting' ? $('shoot-status') : $('idle-hint');
    target.textContent = 'ขาดการเชื่อมต่อกับเซิร์ฟเวอร์ กำลังลองใหม่...';
  };
}

async function boot() {
  const publicConfig = await api('/api/config');
  cfg = { ...cfg, ...publicConfig };
  if (usesPairedKiosk()) {
    try {
      const bootstrap = await api('/api/web/bootstrap');
      cfg = { ...cfg, ...bootstrap.config };
      latestState = bootstrap.state;
    } catch (err) {
      if (err.status === 401) {
        show('setup');
        return;
      }
      throw err;
    }
  }
  $('event-title').textContent = cfg.eventName;
  document.title = cfg.eventName;
  $('btn-start').hidden = !isSelfService();
  $('done-actions').hidden = !isSelfService();
  $('idle-sub').textContent = isSelfService() ? 'แตะเพื่อเริ่มถ่ายรูป' : 'รอเจ้าหน้าที่เรียกเข้าถ่ายและกดเริ่มให้';
  $('install-hint').hidden = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!isWebCamera()) {
    const folderMode = cfg.captureSource === 'folder';
    const health = await api('/api/health').catch(() => null);
    if (health) {
      if (!folderMode) cfg.liveView = Boolean(health.camera.liveView);
      if (folderMode && !health.watch.watching) $('idle-hint').textContent = 'ยังไม่ได้เฝ้าโฟลเดอร์: ' + (health.watch.error || 'ไม่ทราบสาเหตุ');
      else if (!folderMode && cfg.captureSource !== 'digicam' && !health.camera.ok) {
        $('idle-hint').textContent = 'กล้องยังไม่พร้อม: ' + (health.camera.error || 'ไม่พบกล้อง');
      }
    }
  }
  $('camera-ready').hidden = cfg.captureSource !== 'digicam';
  clearInterval(cameraStatusTimer);
  if (cfg.captureSource === 'digicam') {
    await refreshCameraStatus({ showChecking: true });
    cameraStatusTimer = setInterval(refreshCameraStatus, 5000);
  }
  connectEvents();
  applyState(latestState || await api(usesPairedKiosk() ? '/api/web/bootstrap' : '/api/state').then((data) => data.state || data));
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot().catch((err) => {
  show('error');
  $('err-msg').textContent = err.message;
});
