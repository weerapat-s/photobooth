/**
 * QR พร้อมเพย์สำหรับให้ลูกค้าสนับสนุน (สมัครใจ)
 *
 * ชุดทดสอบค่าคาดหวังได้มาจากไลบรารี promptpay-qr ที่แอปธนาคารไทยใช้กันแพร่หลาย
 * ถ้าข้อความเพี้ยนแม้ตัวเดียว แอปธนาคารจะอ่าน QR ไม่ได้หรือโอนผิดบัญชี จึงต้องตรงทุกตัวอักษร
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { crc16, promptPayPayload, isValidPromptPayId } from '../server/promptpay.js';

const REFERENCE = [
  ['0801234567', null, '00020101021129370016A000000677010111011300668012345675802TH530376463046197'],
  ['080-123-4567', 50, '00020101021229370016A000000677010111011300668012345675802TH5303764540550.006304AD50'],
  ['1234567890123', 100, '00020101021229370016A000000677010111021312345678901235802TH53037645406100.006304BB6C'],
  ['123456789012345', 30, '00020101021229390016A00000067701011103151234567890123455802TH5303764540530.006304EBB4'],
];

const PORT = 4798;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opt = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'content-type': 'application/json' }, ...opt });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
};

function startServer(extraEnv) {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CAPTURE_SOURCE: 'mock', KIOSK_MODE: 'operator', ...extraEnv },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  return { server, log: () => log };
}

async function waitUp(log) {
  for (let i = 0; i < 60; i++) {
    try { if ((await api('/api/health')).status === 200) return; } catch { /* ยังไม่ขึ้น */ }
    await sleep(500);
  }
  throw new Error(`เซิร์ฟเวอร์ไม่ขึ้น:\n${log()}`);
}

async function run() {
  console.log('--- STARTING PROMPTPAY TEST ---');

  assert.strictEqual(crc16('123456789'), '29B1', 'CRC-16/CCITT-FALSE ต้องได้ค่าตรวจสอบมาตรฐาน 29B1');
  for (const [id, amount, expected] of REFERENCE) {
    assert.strictEqual(promptPayPayload(id, amount), expected, `ข้อความ QR ของ ${id} ยอด ${amount} ต้องตรงกับไลบรารีอ้างอิง`);
  }
  assert(isValidPromptPayId('081-234-5678'));
  assert(!isValidPromptPayId('12345'));
  assert(!isValidPromptPayId('1812345678'), 'เบอร์มือถือต้องขึ้นต้นด้วย 0');
  console.log('Payload matches the reference library.');

  // ปิดอยู่ถ้าไม่ได้ตั้งเลขพร้อมเพย์ — หน้าที่ลูกค้าเปิดต้องพาไปรับรูปทันที
  const run1 = startServer({ PROMPTPAY_ID: '', PUBLIC_URL: 'https://booth.example.test' });
  try {
    await waitUp(run1.log);
    const page = await api('/r');
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /"payEnabled":false/, 'ไม่ตั้งเลขพร้อมเพย์ = ข้ามหน้าสนับสนุน');
    assert.strictEqual((await api('/api/public/pay-qr?amount=50')).status, 404);
  } finally {
    run1.server.kill();
  }
  await sleep(800);

  const run2 = startServer({
    PROMPTPAY_ID: '0801234567', PAY_AMOUNTS: '20,50,100', PAY_MAX_AMOUNT: '5000',
    PUBLIC_URL: 'https://booth.example.test', EVENT_NAME: 'Test </script><b>x</b>',
  });
  try {
    await waitUp(run2.log);
    const page = await fetch(`http://127.0.0.1:${PORT}/r`);
    const html = await page.text();
    assert.strictEqual(page.headers.get('cache-control'), 'no-store');
    assert.match(html, /"payEnabled":true/);
    assert.match(html, /"amounts":\[20,50,100\]/);
    assert(!html.includes('__BOOTH_CONFIG__'), 'ต้องฝังค่าลงหน้าแล้ว');
    // ชื่องานมี </script> ต้องไม่หลุดออกจากแท็ก script
    assert(!/Test <\/script>/.test(html), 'ค่าที่ฝังลงหน้าต้อง escape < แล้ว');
    assert(html.includes('Test \\u003c/script>'), 'escaped script tag');

    const qr = await fetch(`http://127.0.0.1:${PORT}/api/public/pay-qr?amount=50`);
    assert.strictEqual(qr.status, 200);
    assert.strictEqual(qr.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await qr.arrayBuffer());
    assert.strictEqual(bytes.subarray(1, 4).toString(), 'PNG', 'ต้องได้ไฟล์ PNG จริง บันทึกลงอัลบั้มได้');

    for (const bad of ['0', '-5', 'abc', '5001']) {
      assert.strictEqual((await api(`/api/public/pay-qr?amount=${bad}`)).status, 400, `ยอด ${bad} ต้องถูกปฏิเสธ`);
    }
    console.log('Landing page and public pay QR passed.');
  } finally {
    run2.server.kill();
  }
  await sleep(800);

  // QR บนจอต้องชี้หน้าชวนสนับสนุน โดยส่งแค่ token ของลิงก์แชร์เซสชันนั้นหลัง #
  const run3 = startServer({ PROMPTPAY_ID: '0801234567', PUBLIC_URL: 'https://booth.example.test/', SHOTS: '1', PRINT_SHOTS: '1' });
  try {
    await waitUp(run3.log);
    assert.strictEqual((await api('/api/start', { method: 'POST', body: '{}' })).status, 200);
    await api('/api/mock-shot', { method: 'POST', body: '{}' });
    const finished = await api('/api/finish', { method: 'POST', body: '{}' });
    assert.strictEqual(finished.status, 200, `ปิดเซสชันไม่ได้: ${JSON.stringify(finished.body)}`);
    const { session } = (await api('/api/state')).body;
    const token = session.shareUrl.match(/\/s\/([A-Za-z0-9]+)$/)?.[1];
    assert(token, `ลิงก์แชร์ต้องเป็นแชร์แยกของเซสชัน: ${session.shareUrl}`);
    assert.strictEqual(session.qrUrl, `https://booth.example.test/r#${token}`);
    console.log('Booth QR points at the landing page.');
  } finally {
    run3.server.kill();
  }

  console.log('--- PROMPTPAY TEST PASSED SUCCESSFULLY ---');
}

run().catch((err) => {
  console.error('PROMPTPAY TEST FAILED:', err);
  process.exit(1);
});
