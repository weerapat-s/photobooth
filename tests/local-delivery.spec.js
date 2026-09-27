/**
 * ส่งรูปให้ลูกค้าจากตู้เครื่องนี้ โดยไม่พึ่ง NAS
 *
 * เหตุผลที่ต้องมี: NAS ถูกปิดได้ (ไฟดับ/น้ำท่วม) หรือเน็ตล่มกลางงาน
 * ลูกค้าต้องยังได้รูปทันที และห้ามเห็นของเซสชันคนอื่นเด็ดขาด
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const PORT = 4787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opt = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'content-type': 'application/json' }, ...opt });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
};

async function run() {
  console.log('--- STARTING LOCAL DELIVERY TEST ---');

  // NAS ชี้ไปโดเมนที่ไม่มีจริง = จำลองตอนปิด NAS ไว้
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1', CAPTURE_SOURCE: 'mock', KIOSK_MODE: 'operator',
      PUBLIC_URL: `http://127.0.0.1:${PORT}`, PROMPTPAY_ID: '', SHOTS: '2', PRINT_SHOTS: '2',
      NC_BASE: 'https://nextcloud.invalid', CLOUD_PROBE_MS: '1500',
    },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await api('/api/health')).status === 200) { up = true; break; } } catch { /* ยังไม่ขึ้น */ }
      await sleep(500);
    }
    assert(up, `เซิร์ฟเวอร์ไม่ขึ้น:\n${log}`);

    assert.strictEqual((await api('/api/start', { method: 'POST', body: '{}' })).status, 200);
    for (let i = 0; i < 2; i++) { await api('/api/mock-shot', { method: 'POST', body: '{}' }); await sleep(300); }

    // NAS ล่มต้องไม่ทำให้ปิดเซสชันไม่ได้ และต้องไม่ช้าจนลูกค้ายืนรอ
    const started = Date.now();
    const finished = await api('/api/finish', { method: 'POST', body: '{}' });
    const took = Date.now() - started;
    assert.strictEqual(finished.status, 200, `ปิดเซสชันไม่ได้ทั้งที่ NAS ล่ม: ${JSON.stringify(finished.body)}`);
    assert(took < 60000, `ปิดเซสชันช้าเกินไปตอน NAS ล่ม: ${took}ms`);

    const { session, phase } = (await api('/api/state')).body;
    assert.strictEqual(phase, 'done');
    assert(session.cloudError, 'ต้องบันทึกไว้ว่าอัปคลาวด์ไม่สำเร็จ');

    // ไม่ได้ตั้งพร้อมเพย์ = QR พาไปหน้ารับรูปเลย ไม่ต้องผ่านหน้าชวนสนับสนุน
    assert.match(session.qrUrl, /\/g#[a-f0-9]{32}$/, `qrUrl ไม่ถูกต้อง: ${session.qrUrl}`);
    const token = session.qrUrl.split('#')[1];

    const meta = await api(`/api/public/session/${token}`);
    assert.strictEqual(meta.status, 200);
    const names = meta.body.files.map((file) => file.name);
    for (const expected of ['card.jpg', 'video.mp4', 'photo-1.jpg', 'photo-2.jpg']) {
      assert(names.includes(expected), `ขาดไฟล์ ${expected} (ได้ ${names.join(', ')})`);
    }

    for (const name of ['card.jpg', 'video.mp4', 'photo-1.jpg']) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/public/session/${token}/${name}`);
      assert.strictEqual(res.status, 200, `โหลด ${name} ไม่ได้`);
      assert((await res.arrayBuffer()).byteLength > 1000, `${name} ว่างเปล่า`);
    }
    console.log('Files served from the booth while the NAS is down. Passed.');

    // กุญแจคนอื่น/ชื่อไฟล์นอกรายการ/ไต่โฟลเดอร์ ต้องไม่ได้อะไรเลย
    for (const bad of ['0'.repeat(32), 'deadbeef', '']) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/public/session/${bad}/card.jpg`);
      assert.strictEqual(res.status, 404, `กุญแจ "${bad}" ต้องไม่ได้ไฟล์`);
    }
    for (const name of ['session.json', '..%2F..%2Fsession.json', 'photo-99.jpg', 'all.zip.jpg']) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/public/session/${token}/${name}`);
      assert.strictEqual(res.status, 404, `ไฟล์ "${name}" ต้องไม่ถูกส่งออก`);
    }
    console.log('Only allow-listed files, only with the right key. Passed.');

    // ไฟล์รวมต้องเป็น zip ที่เปิดได้จริง และขนาดตรงกับที่แจ้งไว้
    const zip = await fetch(`http://127.0.0.1:${PORT}/api/public/session/${token}/all.zip`);
    assert.strictEqual(zip.status, 200);
    const buf = Buffer.from(await zip.arrayBuffer());
    assert.strictEqual(Number(zip.headers.get('content-length')), buf.length, 'ขนาด zip ไม่ตรงกับที่แจ้ง');
    assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'ไม่ใช่ไฟล์ zip');
    assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'ท้ายไฟล์ zip ไม่ถูกต้อง');
    assert.strictEqual(buf.readUInt16LE(buf.length - 12), names.length, 'จำนวนไฟล์ใน zip ไม่ครบ');
    console.log('Zip is well formed. Passed.');

    const page = await fetch(`http://127.0.0.1:${PORT}/g`);
    assert.strictEqual(page.status, 200);
    assert(!(await page.text()).includes('__BOOTH_CONFIG__'), 'หน้าเว็บต้องฝังค่าของตู้แล้ว');

    console.log('--- LOCAL DELIVERY TEST PASSED SUCCESSFULLY ---');
  } finally {
    server.kill();
  }
}

run().catch((err) => {
  console.error('LOCAL DELIVERY TEST FAILED:', err);
  process.exit(1);
});
