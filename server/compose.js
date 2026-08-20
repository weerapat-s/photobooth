import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

const DPI = config.printDpi;
const inch = (n) => Math.round(n * DPI);
const FONTS = 'Leelawadee UI, Sarabun, Tahoma, Segoe UI, Arial, sans-serif';

/** ขนาดฟอนต์ที่ยังพอดีความกว้าง (ประมาณจากจำนวนตัวอักษร) */
function fitFontSize(text, maxWidth, preferred) {
  const est = (maxWidth * 0.94) / Math.max(1, text.length * 0.56);
  return Math.max(12, Math.round(Math.min(preferred, est)));
}

// ---------------------------------------------------------------------------
// strip2x6 — สตริปแคบ พาสเทล กรอบขาวมนแบบโพลารอยด์ (ธีมเดิม)
// ---------------------------------------------------------------------------

/** เลย์เอาต์สตริป 2x6 นิ้ว วางสองแถบบนกระดาษ 4x6 (ตัดครึ่งได้ 2 ใบ) */
function stripSpec(shots) {
  const W = inch(2), H = inch(6);
  const pad = Math.round(DPI * 0.08);
  const footer = Math.round(DPI * 0.75);
  const cellW = W - pad * 2;
  const gap = pad;
  const cellH = Math.floor((H - footer - pad - (shots - 1) * gap - pad) / shots);
  const cells = [];
  for (let i = 0; i < shots; i++) {
    cells.push({ left: pad, top: pad + i * (cellH + gap), width: cellW, height: cellH });
  }
  return { W, H, cells, footerTop: pad + shots * (cellH + gap) };
}

const roundedMask = (w, h, r) =>
  Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

/**
 * ครอปภาพลงกรอบมนแบบโพลารอยด์ วางบนพื้นสีธีม
 * ครอปแค่พอประมาณ (ไม่เกิน 1:1) ไม่ใช่ครอปเต็มช่องแคบ ๆ ของสตริป — เทสต์กับภาพคนจริงแล้วพบว่า
 * ถ้าครอปจนสุดถึงอัตราส่วนช่อง (แคบมาก) จะตัดหน้าคนที่ยืนกว้างเต็มเฟรมขาดได้
 * เลยจำกัดครอปไว้ที่ ~1:1 เป็นอย่างมาก ที่เหลือ contain ลงกรอบแทนเพื่อความปลอดภัย
 */
async function renderPolaroidCell(photoPath, cell) {
  const pad = Math.round(Math.min(cell.width, cell.height) * 0.035);
  const boxW = cell.width - pad * 2;
  const boxH = cell.height - pad * 2;
  const radius = Math.round(Math.min(boxW, boxH) * 0.06);

  const raw = await sharp(photoPath).metadata();
  const orientation = raw.orientation || 1;
  const swapped = orientation >= 5 && orientation <= 8;
  const dispW = (swapped ? raw.height : raw.width) || 3;
  const dispH = (swapped ? raw.width : raw.height) || 2;
  const srcAspect = dispW / dispH;
  const cellAspect = boxW / boxH;

  // ครอปได้ไม่เกินจนเหลืออัตราส่วน 1:1 (ภาพแนวนอนกว้างมากค่อยครอปเยอะหน่อย แต่ไม่ครอปจนแคบเท่าช่อง)
  const targetAspect = srcAspect >= 1
    ? Math.max(cellAspect, Math.min(srcAspect, 1))
    : Math.min(cellAspect, srcAspect);

  const { cropW, cropH } = pickCropBox(dispW, dispH, srcAspect, targetAspect);

  const cropped = await sharp(photoPath)
    .rotate()
    .resize({ width: cropW, height: cropH, fit: 'cover', position: 'attention' })
    .toBuffer();

  const contained = await sharp(cropped)
    .resize(boxW, boxH, { fit: 'contain', background: config.printFrameColor })
    .png()
    .toBuffer();

  const framed = await sharp(contained)
    .composite([{ input: roundedMask(boxW, boxH, radius), blend: 'dest-in' }])
    .png()
    .toBuffer();

  return { input: framed, left: cell.left + pad, top: cell.top + pad };
}

/** เลือกครอปจากมิติที่ไม่ต้องอัพสเกล (ครอปกว้างแล้วเก็บสูงเต็ม หรือครอปสูงแล้วเก็บกว้างเต็ม) */
function pickCropBox(dispW, dispH, srcAspect, targetAspect) {
  if (targetAspect <= srcAspect) return { cropW: Math.round(dispH * targetAspect), cropH: dispH };
  return { cropW: dispW, cropH: Math.round(dispW / targetAspect) };
}

function footerSvg(width, height, title, subtitle) {
  const t = String(title).replace(/[<&>]/g, '');
  const s = String(subtitle).replace(/[<&>]/g, '');
  const big = fitFontSize(t, width, Math.round(height * 0.42));
  const small = fitFontSize(s, width, Math.round(height * 0.22));
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width / 2}" y="${height * 0.5}" text-anchor="middle" font-family="${FONTS}"
            font-size="${big}" font-weight="700" fill="#111">${t}</text>
      <text x="${width / 2}" y="${height * 0.85}" text-anchor="middle" font-family="${FONTS}"
            font-size="${small}" fill="#666">${s}</text>
    </svg>`,
  );
}

async function composeStripCard(photos, spec, meta) {
  const layers = [];
  for (let i = 0; i < photos.length; i++) {
    const cell = spec.cells[i];
    if (!cell) break;
    layers.push(await renderPolaroidCell(photos[i], cell));
  }
  const footerH = spec.H - spec.footerTop;
  layers.push({
    input: footerSvg(spec.W, footerH, meta.title, meta.subtitle),
    left: 0,
    top: spec.footerTop,
  });
  return sharp({ create: { width: spec.W, height: spec.H, channels: 3, background: config.printThemeColor } })
    .composite(layers)
    .jpeg({ quality: 94 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// grid4x6 — กระดาษ 4x6 พอร์เทรตใบเดียว พื้นมืด หัวตัวอักษรเรืองแสง + วงกลมวันที่
// ---------------------------------------------------------------------------

/** อ่านสัดส่วนภาพจริง (คิด EXIF orientation ด้วย) ไว้คำนวณความสูงช่องให้พอดีเป๊ะ ไม่ใช่เดาคงที่ */
async function photoAspect(photoPath) {
  const raw = await sharp(photoPath).metadata();
  const o = raw.orientation || 1;
  const swapped = o >= 5 && o <= 8;
  const w = (swapped ? raw.height : raw.width) || 3;
  const h = (swapped ? raw.width : raw.height) || 2;
  return w / h;
}

/**
 * เลย์เอาต์ 2x2 บนกระดาษ 4x6 แนวตั้ง (มาตรฐานกระดาษปริ้นภาพ)
 * ความสูงช่องคำนวณจากสัดส่วนภาพจริง (ใส่แบบ contain ไม่ครอป) ไม่ใช่แบ่งพื้นที่เท่า ๆ กันแบบเดา
 * ไม่งั้นภาพ contain แล้วจะเหลือช่องว่างเยอะเกิน — จัดกึ่งกลางแนวตั้งถ้าเหลือพื้นที่ ยุบสัดส่วนถ้าไม่พอ
 */
function gridSpec(shots, aspect) {
  const W = inch(4), H = inch(6);
  const headerH = Math.round(DPI * 0.62);
  const badgeR = Math.round(DPI * 0.34);
  const pad = Math.round(DPI * 0.1);
  const footerH = badgeR * 2 + pad; // ต้องพอดีวงกลมป้ายวันที่เต็มวง ไม่ตัดขอบล่าง
  const gap = Math.round(DPI * 0.05);
  const cols = 2, rows = Math.ceil(Math.max(shots, 1) / cols);
  const usableH = H - headerH - footerH - pad * 2;
  const cellW = Math.floor((W - pad * (cols + 1)) / cols);

  let cellH = Math.round(cellW / Math.max(aspect || 1.5, 0.4));
  const blockH = rows * cellH + (rows - 1) * gap;
  const topOffset = blockH < usableH ? Math.round((usableH - blockH) / 2) : 0;
  if (blockH > usableH) cellH = Math.floor((usableH - (rows - 1) * gap) / rows);

  const cells = [];
  for (let i = 0; i < shots; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    cells.push({
      left: pad + c * (cellW + pad),
      top: headerH + pad + topOffset + r * (cellH + gap),
      width: cellW,
      height: cellH,
    });
  }
  return { W, H, cells, headerH, badgeR };
}

/** ใส่ภาพเต็มใบลงช่องตาราง กึ่งกลาง ไม่ครอปทิ้ง — ขอบที่เหลือกลืนกับพื้นมืดของธีมพอดี ไม่เห็นเป็นแถบขาว */
async function renderGridCell(photoPath, cell) {
  const radius = Math.round(Math.min(cell.width, cell.height) * 0.035);
  const contained = await sharp(photoPath)
    .rotate()
    .resize(cell.width, cell.height, { fit: 'contain', background: config.gridBgColor })
    .png()
    .toBuffer();
  const framed = await sharp(contained)
    .composite([{ input: roundedMask(cell.width, cell.height, radius), blend: 'dest-in' }])
    .png()
    .toBuffer();
  return { input: framed, left: cell.left, top: cell.top };
}

/** หัวข้อตัวอักษรเรืองแสง (วาดซ้อน 2 ชั้น: ชั้นเบลอสีเข้มเป็นแสงเรือง + ชั้นคมด้านบน) */
function glowHeaderSvg(width, height, text, accent) {
  const t = String(text).replace(/[<&>]/g, '');
  const fs = fitFontSize(t, width * 0.92, Math.round(height * 0.46));
  const y = Math.round(height * 0.62);
  const blur = Math.max(2, Math.round(fs * 0.1));
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="${blur}"/>
        </filter>
      </defs>
      <line x1="${width * 0.08}" y1="${height - 2}" x2="${width * 0.92}" y2="${height - 2}" stroke="${accent}" stroke-width="2" opacity="0.5"/>
      <text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONTS}" font-weight="800"
            font-size="${fs}" fill="${accent}" filter="url(#glow)" opacity="0.85">${t}</text>
      <text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONTS}" font-weight="800"
            font-size="${fs}" fill="${accent}">${t}</text>
    </svg>`,
  );
}

/** ป้ายกลมวันที่ (วันที่ + เดือนย่อ) มุมล่าง */
function dateBadgeSvg(size, day, monthAbbr, accent, bg) {
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${accent}" stroke="${bg}" stroke-width="4"/>
      <text x="${size / 2}" y="${size * 0.46}" text-anchor="middle" font-family="${FONTS}" font-weight="800"
            font-size="${Math.round(size * 0.36)}" fill="${bg}">${day}</text>
      <text x="${size / 2}" y="${size * 0.76}" text-anchor="middle" font-family="${FONTS}" font-weight="700"
            font-size="${Math.round(size * 0.2)}" fill="${bg}" letter-spacing="1">${monthAbbr}</text>
    </svg>`,
  );
}

async function composeGridCard(photos, spec, meta) {
  const layers = [];
  for (let i = 0; i < photos.length; i++) {
    const cell = spec.cells[i];
    if (!cell) break;
    layers.push(await renderGridCell(photos[i], cell));
  }

  layers.push({ input: glowHeaderSvg(spec.W, spec.headerH, meta.title, config.gridAccentColor), left: 0, top: 0 });

  const d = meta.date instanceof Date && !Number.isNaN(meta.date) ? meta.date : new Date();
  const day = d.getDate();
  const monthAbbr = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const badgeSize = spec.badgeR * 2;
  layers.push({
    input: dateBadgeSvg(badgeSize, day, monthAbbr, config.gridAccentColor, config.gridBgColor),
    left: Math.round(spec.W * 0.07),
    top: spec.H - badgeSize - Math.round(spec.W * 0.05),
  });

  return sharp({ create: { width: spec.W, height: spec.H, channels: 3, background: config.gridBgColor } })
    .composite(layers)
    .jpeg({ quality: 94 })
    .toBuffer();
}

// ---------------------------------------------------------------------------

/**
 * ประกอบไฟล์ปริ้น
 * @returns {{print:string, card:string}} path ของไฟล์ชีทปริ้น และไฟล์การ์ดเดี่ยว (ไว้โชว์/แชร์)
 */
export async function composePrint(photos, outDir, meta = {}) {
  const isGrid = config.printLayout === 'grid4x6';
  const spec = isGrid ? gridSpec(photos.length, await photoAspect(photos[0])) : stripSpec(photos.length);
  const fullMeta = {
    title: meta.title || config.eventName,
    subtitle: meta.subtitle || new Date().toLocaleString('th-TH'),
    date: meta.date,
  };

  const cardBuf = isGrid
    ? await composeGridCard(photos, spec, fullMeta)
    : await composeStripCard(photos, spec, fullMeta);

  const card = path.join(outDir, 'card.jpg');
  await sharp(cardBuf).toFile(card);

  // print.jpg = card.jpg เดี่ยว ๆ เสมอ ไม่วางซ้อน 2 ชุดบนกระดาษแล้ว (ตามที่ขอ)
  const print = path.join(outDir, 'print.jpg');
  await sharp(cardBuf).toFile(print);

  return { print, card };
}

/** ย่อภาพไว้โชว์บนจอ kiosk */
export async function makePreview(src, outDir, name) {
  const out = path.join(outDir, name);
  await sharp(src).rotate().resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 82 }).toFile(out);
  return out;
}
