const $ = (id) => document.getElementById(id);
const screens = {
  idle: $('screen-idle'),
  shoot: $('screen-shoot'),
  processing: $('screen-processing'),
  done: $('screen-done'),
  error: $('screen-error'),
};

let cfg = { shots: 4, eventName: 'Photo Booth', reviewSeconds: 90, captureSource: 'digicam', liveView: true };
let liveTimer = null;
let doneDeadline = 0;
let shownSessionId = null;
let shownCount = -1;

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  if (name === 'shoot') startLiveView();
  else stopLiveView();
}

function startLiveView() {
  if (!cfg.liveView || liveTimer) return;
  const img = $('liveview');
  liveTimer = setInterval(() => { img.src = '/api/liveview.jpg?t=' + Date.now(); }, 120);
}
function stopLiveView() {
  clearInterval(liveTimer);
  liveTimer = null;
}

function renderDots(total, doneCount, active) {
  const bar = $('shotbar');
  if (bar.childElementCount !== total) {
    bar.innerHTML = '';
    for (let i = 0; i < total; i++) bar.appendChild(document.createElement('div'));
  }
  [...bar.children].forEach((d, i) => {
    d.className = 'dot' + (i < doneCount ? ' done' : i === (active ?? doneCount) ? ' active' : '');
  });
}

function flash() {
  const el = $('flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

$('btn-start').onclick = async () => {
  $('btn-start').disabled = true;
  try {
    await api('/api/start', { method: 'POST' });
  } catch (err) {
    $('idle-hint').textContent = err.message;
  } finally {
    setTimeout(() => { $('btn-start').disabled = false; }, 1500);
  }
};

$('btn-again').onclick = async () => {
  await api('/api/reset', { method: 'POST' });
  if (cfg.captureSource !== 'folder') await api('/api/start', { method: 'POST' }).catch(() => {});
};

$('btn-back').onclick = () => api('/api/reset', { method: 'POST' });

$('btn-print').onclick = async () => {
  $('btn-print').disabled = true;
  $('print-status').textContent = 'กำลังส่งไปเครื่องปริ้น...';
  try {
    await api('/api/print', { method: 'POST', body: JSON.stringify({ copies: 1 }) });
    $('print-status').textContent = 'ส่งเข้าคิวปริ้นแล้ว รอรับที่บูทปริ้น';
  } catch (err) {
    $('print-status').textContent = 'ส่งไม่สำเร็จ: ' + err.message;
    $('btn-print').disabled = false;
  }
};

function applyState(s) {
  if (s.eventName) $('event-title').textContent = s.eventName;

  if (s.phase === 'idle') {
    shownSessionId = null;
    shownCount = -1;
    show('idle');
    return;
  }

  if (s.phase === 'shooting' && s.session) {
    show('shoot');
    const { count, total, previews } = s.session;
    renderDots(total, count, s.shot ? s.shot - 1 : count);
    $('shot-badge').textContent = count + ' / ' + total;

    const justShot = count !== shownCount && previews.length;
    if (justShot) {
      $('lastshot').src = previews[previews.length - 1];
      shownCount = count;
    }

    if (s.countdown > 0) {
      $('lastshot').hidden = true;
      $('liveview').hidden = !cfg.liveView;
      $('count').textContent = s.countdown;
      $('shoot-status').textContent = 'เตรียมตัว!';
    } else if (s.flash) {
      flash();
      $('count').textContent = '';
    } else if (justShot || !$('lastshot').hidden) {
      $('lastshot').hidden = false;
      $('liveview').hidden = true;
      $('count').textContent = '';
      $('shoot-status').textContent = count >= total ? 'ครบแล้ว!' : 'สวยมาก!';
      if (cfg.captureSource !== 'folder') {
        setTimeout(() => {
          if (screens.shoot.hidden) return;
          $('lastshot').hidden = true;
          $('liveview').hidden = !cfg.liveView;
        }, 1400);
      }
    } else {
      $('count').textContent = '';
      $('shoot-status').textContent = cfg.captureSource === 'folder' ? 'พร้อมช็อตต่อไป' : (s.message || '');
    }
    return;
  }

  if (s.phase === 'processing') {
    show('processing');
    $('proc-msg').textContent = s.message || 'กำลังประมวลผล...';
    return;
  }

  if (s.phase === 'done' && s.session) {
    if (shownSessionId !== s.session.id) {
      shownSessionId = s.session.id;
      $('qr').src = s.session.qr || '';
      $('share-url').textContent = s.session.shareUrl || '';
      $('card').src = s.session.previews[0] || '';
      $('btn-print').disabled = false;
      $('print-status').textContent = '';
      doneDeadline = Date.now() + (cfg.reviewSeconds || 90) * 1000;
    }
    if (s.session.printed) {
      $('btn-print').disabled = true;
      if (!$('print-status').textContent) $('print-status').textContent = 'ส่งเข้าคิวปริ้นแล้ว';
    }
    if (s.session.queueNumber) {
      $('queue-number').textContent = 'คิวปริ้น #' + s.session.queueNumber;
      $('queue-number').hidden = false;
    } else {
      $('queue-number').hidden = true;
    }
    show('done');
    return;
  }

  if (s.phase === 'error') {
    show('error');
    $('err-msg').textContent = s.message || 'ไม่ทราบสาเหตุ';
  }
}

setInterval(() => {
  if (screens.done.hidden) return;
  const left = Math.max(0, Math.ceil((doneDeadline - Date.now()) / 1000));
  $('timer').textContent = 'จอจะกลับหน้าแรกใน ' + left + ' วินาที';
}, 500);

async function boot() {
  cfg = await api('/api/config');
  $('event-title').textContent = cfg.eventName;
  document.title = cfg.eventName;

  const folderMode = cfg.captureSource === 'folder';
  $('btn-start').hidden = folderMode;
  $('done-actions').hidden = folderMode;
  $('idle-sub').textContent = folderMode
    ? 'ยืนเข้าเฟรมแล้วยิ้มรอได้เลย — ช่างกดชัตเตอร์ให้เอง'
    : 'แตะที่หน้าจอเพื่อเริ่มถ่าย';

  const health = await api('/api/health').catch(() => null);
  if (health) {
    // live view มีเฉพาะตอนคุย digiCamControl ผ่าน webserver ได้จริง
    if (!folderMode) cfg.liveView = Boolean(health.camera.liveView);
    if (folderMode && !health.watch.watching) {
      $('idle-hint').textContent = 'ยังไม่ได้เฝ้าโฟลเดอร์: ' + (health.watch.error || 'ไม่ทราบสาเหตุ');
    } else if (!folderMode && !health.camera.ok) {
      $('idle-hint').textContent = 'กล้องยังไม่พร้อม: ' + (health.camera.error || 'ไม่พบกล้อง');
    }
  }

  const es = new EventSource('/api/events');
  es.onmessage = (ev) => applyState(JSON.parse(ev.data));
  es.onerror = () => { $('idle-hint').textContent = 'ขาดการเชื่อมต่อกับเซิร์ฟเวอร์ กำลังลองใหม่...'; };

  applyState(await api('/api/state'));
}

boot();
