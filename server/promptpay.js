/**
 * สร้างข้อความ QR พร้อมเพย์ (มาตรฐาน EMVCo ที่แอปธนาคารไทยทุกเจ้าอ่านได้)
 *
 * ใส่จำนวนเงินลงใน QR ได้ ลูกค้าสแกนแล้วแอปธนาคารเติมยอดให้เลย ไม่ต้องพิมพ์เอง
 * รองรับเบอร์มือถือ 10 หลัก, เลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก และ e-Wallet 15 หลัก
 *
 * ระบบนี้ "ไม่รู้" ว่าลูกค้าจ่ายจริงหรือเปล่า — ไม่มีการเชื่อมกับธนาคาร
 * เป็นการสนับสนุนตามใจ ปุ่ม "จ่ายแล้ว" จึงเชื่อตามที่ลูกค้าบอก
 */

const PROMPTPAY_AID = 'A000000677010111';

/** แต่ละช่องของ EMVCo = รหัส 2 หลัก + ความยาว 2 หลัก + ค่า */
const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (poly 0x1021, เริ่มที่ 0xFFFF) ตามที่ EMVCo กำหนด */
export function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** เก็บแต่ตัวเลข ตัดขีด ช่องว่าง วงเล็บ ที่คนชอบพิมพ์ปนมา */
export function normalizePromptPayId(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/** รูปแบบเลขพร้อมเพย์ถูกต้องไหม */
export function isValidPromptPayId(raw) {
  const id = normalizePromptPayId(raw);
  return /^0\d{9}$/.test(id) || /^\d{13}$/.test(id) || /^\d{15}$/.test(id);
}

function accountField(id) {
  if (/^0\d{9}$/.test(id)) {
    // เบอร์มือถือ: ตัด 0 ตัวหน้า เติมรหัสประเทศ 66 แล้วเติม 0 ข้างหน้าให้ครบ 13 หลัก
    return field('01', `0066${id.slice(1)}`);
  }
  if (id.length === 13) return field('02', id);
  if (id.length === 15) return field('03', id);
  throw new Error('เลขพร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก เลขบัตร 13 หลัก หรือ e-Wallet 15 หลัก');
}

/**
 * @param {string} rawId เลขพร้อมเพย์ (มีขีดหรือช่องว่างปนได้)
 * @param {number|null} amount จำนวนเงินบาท ถ้าไม่ใส่ = ให้ลูกค้าพิมพ์ยอดเองในแอป
 */
export function promptPayPayload(rawId, amount = null) {
  const id = normalizePromptPayId(rawId);
  const hasAmount = amount !== null && amount !== undefined && Number(amount) > 0;
  const parts = [
    field('00', '01'),
    field('01', hasAmount ? '12' : '11'), // 12 = QR ใช้ครั้งเดียวมียอดเงิน, 11 = QR ถาวรไม่มียอด
    field('29', field('00', PROMPTPAY_AID) + accountField(id)),
    // เรียงช่องตามไลบรารี promptpay-qr ที่ใช้กันแพร่หลาย ซึ่งพิสูจน์แล้วว่าแอปธนาคารไทยอ่านได้
    field('58', 'TH'),
    field('53', '764'), // สกุลเงินบาท
  ];
  if (hasAmount) parts.push(field('54', Number(amount).toFixed(2)));
  const body = `${parts.join('')}6304`;
  return body + crc16(body);
}
