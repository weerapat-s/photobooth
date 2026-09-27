/**
 * สร้างเทมเพลตการ์ดสำหรับงานรับปริญญา -> assets/graduation-template.png
 *
 * เก็บสคริปต์ไว้เพื่อแก้สี/ข้อความแล้วสร้างใหม่ได้ ไม่ต้องเปิดโปรแกรมกราฟิก
 *   node launch/make-graduation-template.js
 *
 * กติกาที่ต้องรักษาไว้ ไม่งั้นตัวตรวจช่องใน server/template.js จะหาช่องไม่เจอ:
 *  - ช่องใส่รูปต้องเป็นสี่เหลี่ยมขาวสนิท (ทุกช่องสี >= 240) และเต็มกรอบอย่างน้อย 85%
 *  - ห้ามวางลวดลายทับเข้าไปในช่อง ที่นี่จึงวางของประดับนอกช่องทั้งหมด
 *    (โค้ดรองรับลายที่ล้ำเข้ามาได้ แต่ต้องเดาว่าอันไหนตัวละครอันไหนของประดับ เลี่ยงได้ก็เลี่ยง)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'graduation-template.png');

// ขนาดและตำแหน่งช่อง — ยกมาจากเทมเพลตเดิมทั้งหมด การ์ดที่ได้จึงขนาดเท่าเดิม
const W = 1591;
const H = 4500;
const SLOT = { left: 170, width: 1204, height: 740, tops: [755, 1792, 2836] };
const RADIUS = 18;

// โทนแดง-ทอง ตามประกาศพิธีพระราชทานปริญญาบัตรของสถาบัน
const INK = '#6E0D12';
const INK_2 = '#A8151B';
const GOLD = '#E0B74F';
const GOLD_LIGHT = '#F6DE9E';
const GOLD_DEEP = '#B98D2C';
const CREAM = '#FBF3E2';
const MUTED = '#E6C9A8';

const THAI = 'Leelawadee UI, Noto Sans Thai, Tahoma, sans-serif';
const DISPLAY = 'Georgia, Times New Roman, serif';

/** หมวกบัณฑิต วาดด้วย path ไม่ใช้ฟอนต์ไอคอน จะได้คมทุกขนาด */
function mortarboard(x, y, size, fill = GOLD, opacity = 1) {
  const s = size / 100;
  return `
    <g transform="translate(${x} ${y}) scale(${s})" opacity="${opacity}">
      <path d="M0 -26 L52 0 L0 26 L-52 0 Z" fill="${fill}"/>
      <path d="M-30 9 L-30 34 C-30 44 30 44 30 34 L30 9 L0 24 Z" fill="${fill}" opacity=".82"/>
      <path d="M52 0 L52 34" stroke="${fill}" stroke-width="4" stroke-linecap="round" fill="none"/>
      <circle cx="52" cy="38" r="7" fill="${fill}"/>
    </g>`;
}

/** ดาวประกายสี่แฉก */
function sparkle(x, y, size, fill = GOLD_LIGHT, opacity = 1) {
  const s = size / 100;
  return `
    <g transform="translate(${x} ${y}) scale(${s})" opacity="${opacity}">
      <path d="M0 -50 C6 -16 16 -6 50 0 C16 6 6 16 0 50 C-6 16 -16 6 -50 0 C-16 -6 -6 -16 0 -50 Z" fill="${fill}"/>
    </g>`;
}

/** ช่อใบไม้ครึ่งซีก ใช้ประกบซ้าย-ขวาของข้อความแสดงความยินดี */
function laurel(x, y, scale, flip = false) {
  const leaves = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const ly = -70 + t * 140;
    const lx = -Math.sin(t * Math.PI) * 26;
    const rot = -60 + t * 120;
    leaves.push(`<ellipse cx="${lx}" cy="${ly}" rx="17" ry="7" fill="${GOLD}" opacity="${0.5 + 0.5 * Math.sin(t * Math.PI)}" transform="rotate(${rot} ${lx} ${ly})"/>`);
  }
  return `<g transform="translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})">${leaves.join('')}</g>`;
}

/** แถบผ้าเฉียงสีทองที่มุม เลียนแบบสายสะพายในประกาศของสถาบัน */
function sash(corner, size = 1) {
  const flip = corner.includes('right') ? `translate(${W} 0) scale(-1 1)` : '';
  const down = corner.includes('bottom') ? `translate(0 ${H}) scale(1 -1)` : '';
  return `
    <g transform="${down} ${flip} scale(${size})">
      <path d="M0 0 L300 0 L0 300 Z" fill="url(#sash)" opacity=".95"/>
      <path d="M0 330 L330 0 L392 0 L0 392 Z" fill="#1A1A2E" opacity=".9"/>
      <path d="M0 420 L420 0 L452 0 L0 452 Z" fill="url(#sash)" opacity=".85"/>
    </g>`;
}

/** จุดแสงอ่อน ๆ กระจายพื้นหลัง ใช้ค่าคงที่ไม่สุ่ม เพื่อให้สร้างกี่ครั้งก็ได้ภาพเดิม */
function bokeh() {
  const dots = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 90; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = 2 + rand() * 9;
    dots.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${GOLD_LIGHT}" opacity="${(0.04 + rand() * 0.1).toFixed(3)}"/>`);
  }
  return dots.join('');
}

const slotRects = SLOT.tops.map((top) => `
  <rect x="${SLOT.left - 7}" y="${top - 7}" width="${SLOT.width + 14}" height="${SLOT.height + 14}"
        rx="${RADIUS + 7}" ry="${RADIUS + 7}" fill="none" stroke="${GOLD}" stroke-width="3" opacity=".85"/>
  <rect x="${SLOT.left}" y="${top}" width="${SLOT.width}" height="${SLOT.height}"
        rx="${RADIUS}" ry="${RADIUS}" fill="#FFFFFF"/>`).join('');

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="ground" cx="0.5" cy="0.32" r="0.95">
      <stop offset="0" stop-color="${INK_2}"/>
      <stop offset="0.62" stop-color="#8E1218"/>
      <stop offset="1" stop-color="${INK}"/>
    </radialGradient>
    <linearGradient id="sash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${GOLD_LIGHT}"/>
      <stop offset="0.5" stop-color="${GOLD}"/>
      <stop offset="1" stop-color="${GOLD_DEEP}"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GOLD}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${GOLD}" stop-opacity="1"/>
      <stop offset="1" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#ground)"/>
  ${bokeh()}
  ${sash('top-left')}
  ${sash('top-right')}
  ${sash('bottom-left', 0.62)}
  ${sash('bottom-right', 0.62)}

  <!-- ขอบทองบาง ๆ รอบใบ -->
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="26" ry="26"
        fill="none" stroke="${GOLD}" stroke-width="2" opacity=".35"/>

  <!-- ส่วนหัว -->
  ${mortarboard(W / 2, 250, 190)}
  ${sparkle(W / 2 - 300, 205, 54, GOLD_LIGHT, 0.9)}
  ${sparkle(W / 2 + 305, 235, 40, GOLD_LIGHT, 0.75)}
  ${sparkle(W / 2 + 250, 150, 26, GOLD_LIGHT, 0.55)}

  <text x="${W / 2}" y="470" text-anchor="middle" font-family="${DISPLAY}" font-size="104"
        font-weight="700" letter-spacing="10" fill="${CREAM}">CONGRATULATIONS</text>
  <text x="${W / 2}" y="576" text-anchor="middle" font-family="${THAI}" font-size="66"
        font-weight="700" fill="${GOLD}">ขอแสดงความยินดีกับบัณฑิตใหม่</text>

  <rect x="${W / 2 - 330}" y="648" width="660" height="3" fill="url(#rule)"/>

  <!-- ช่องใส่รูป -->
  ${slotRects}

  <!-- ของประดับระหว่างช่อง วางนอกกรอบทั้งหมด -->
  ${sparkle(105, 1640, 46, GOLD, 0.85)}
  ${sparkle(1487, 1700, 32, GOLD, 0.7)}
  ${mortarboard(102, 2700, 92, GOLD, 0.55)}
  ${sparkle(1492, 2735, 44, GOLD, 0.8)}

  <!-- ส่วนท้าย -->
  ${laurel(W / 2 - 448, 3748, 0.9)}
  ${laurel(W / 2 + 448, 3748, 0.9, true)}
  <text x="${W / 2}" y="3728" text-anchor="middle" font-family="${THAI}" font-size="56"
        font-weight="700" fill="${CREAM}">พิธีพระราชทานปริญญาบัตร</text>
  <text x="${W / 2}" y="3800" text-anchor="middle" font-family="${THAI}" font-size="40"
        fill="${MUTED}">ประจำปีการศึกษา 2568</text>

  <rect x="${W / 2 - 340}" y="3856" width="680" height="76" rx="38" ry="38" fill="url(#sash)"/>
  <text x="${W / 2}" y="3910" text-anchor="middle" font-family="${THAI}" font-size="46"
        font-weight="700" fill="#6E0D12">30 – 31 สิงหาคม 2570</text>

  <text x="${W / 2}" y="4034" text-anchor="middle" font-family="${THAI}" font-size="50"
        font-weight="700" fill="${CREAM}">คณะครุศาสตร์อุตสาหกรรมและเทคโนโลยี</text>
  <text x="${W / 2}" y="4106" text-anchor="middle" font-family="${THAI}" font-size="42"
        fill="${MUTED}">สถาบันเทคโนโลยีพระจอมเกล้าเจ้าคุณทหารลาดกระบัง</text>

  <rect x="${W / 2 - 200}" y="4176" width="400" height="2" fill="url(#rule)"/>

  <text x="${W / 2}" y="4292" text-anchor="middle" font-family="${DISPLAY}" font-size="44"
        letter-spacing="16" fill="${GOLD}">IE — PHOTO</text>

  ${sparkle(W / 2 - 250, 4280, 24, GOLD, 0.6)}
  ${sparkle(W / 2 + 250, 4280, 24, GOLD, 0.6)}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(OUT);
const meta = await sharp(OUT).metadata();
console.log(`${OUT}  ${meta.width}x${meta.height}`);
