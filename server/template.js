import fs from 'node:fs';
import sharp from 'sharp';

/**
 * รองรับการ์ดแบบ "เทมเพลตสำเร็จรูป" — ใช้ไฟล์ที่ออกแบบไว้แล้ว (พื้นหลัง โลโก้ มาสคอต ฯลฯ)
 * แล้ววางรูปถ่ายลงในช่องว่างของเทมเพลต
 *
 * แต่ละช่องประกอบเป็น 2 ชั้น: รูปปูเต็มกล่องช่อง แล้ววาง "ชั้นลาย" ของเทมเพลตทับ
 * ชั้นลายพารูปทรงและสีของกราฟิกที่ต้องอยู่หน้ารูป (มาสคอต ดาว กรอบ มุมมน) มาเอง
 *
 * ข้อจำกัด: ถ้าไฟล์เทมเพลตเป็นภาพแบน (ช่องเป็นสีขาวทึบ ไม่ใช่โปร่งใส) จะแยก
 * "ขาวที่เป็นพื้นช่อง" ออกจาก "ขาวที่เป็นตัวลาย" ได้ไม่หมด เพราะข้อมูลหายไปตอนแบนภาพ
 * โค้ดจึงเลือกทางปลอดภัย: แตะเฉพาะขอบฟุ้งแคบ ๆ รอบพื้นช่อง ลายจะไม่โดนรูปกิน
 * แต่ปลายกราฟิกที่ออกแบบให้ไล่เฉดจนกลืนพื้นขาว (เช่นปลายแขนดาว) จะยังเห็นเป็นสีซีด
 * ถ้าต้องการให้เป๊ะ ให้ส่งไฟล์เทมเพลตที่ช่องรูป "โปร่งใส" มาแทน แล้วผลจะถูกต้องทุกพิกเซล
 */

const NEAR_WHITE = 240;
const ALPHA_EMPTY = 16;

// ขอบเขตที่ยอมให้นับเป็น "ขอบฟุ้งของพื้นช่อง": ต้องผสมพื้นขาวอยู่บ้าง
// เข้มกว่า SHADOW_MIN = ตัวลายเต็ม ๆ / ขาวกว่า OPAQUE_WHITE = ของขาวในตัวลายเอง
const SHADOW_MIN = 150;
const OPAQUE_WHITE = 242;
// ระยะที่ยอมให้ไล่ระดับออกนอกพื้นขาวของช่อง (พิกเซล ที่ความละเอียดไฟล์เทมเพลต)
// ต้องแคบ เพราะกว้างกว่านี้จะลามเข้าไปกินของขาวในตัวมาสคอต (ชุดอวกาศ ถุงมือ หมวก)
// ทดสอบแล้ว: 12 ขึ้นไป กำปั้นแพนด้าเริ่มโดนรูปทะลุ
const SOFT_RADIUS = 4;
// เผื่อขอบกล่องช่องออกไปเล็กน้อย ให้คลุมขอบฟุ้งระหว่างพื้นขาวกับกรอบส้ม
// ไม่งั้นเหลือเป็นเส้นขาวบาง ๆ คั่นระหว่างรูปกับกรอบ
const BOX_PAD = 6;

/** ขยายมาสก์ด้วย max filter แบบแยกแกน */
function dilate(mask, w, h, r) {
  const tmp = Buffer.alloc(w * h);
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { const v = mask[y * w + xx]; if (v > m) m = v; }
      }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { const v = tmp[yy * w + x]; if (v > m) m = v; }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * มาสก์ไล่ระดับของช่อง (0 = ลายทึบ, 255 = พื้นว่างให้รูปทับเต็ม)
 *
 * มาสก์ไบนารีตัดตรงเส้น 240 พอดี ทำให้ขอบฟุ้งของกรอบ/ลาย (ขาวราว 200-239)
 * ไม่ถูกนับเป็นช่อง แล้วโผล่เป็นคราบขาวหยัก ๆ ข้างรูป จึงต้องไล่ระดับแทน
 */
function softMask(core, data, info, minX, minY, boxW, boxH) {
  const { width, channels } = info;
  const n = boxW * boxH;

  // "ความว่าง" ของแต่ละพิกเซล = ช่องสีที่ต่ำสุด (ขาวสนิท = 255, สีลายเข้ม = ต่ำ)
  const lum = new Uint8Array(n);
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const i = ((minY + y) * width + (minX + x)) * channels;
      lum[y * boxW + x] = channels === 4 && data[i + 3] < ALPHA_EMPTY
        ? 255 // โปร่งใสอยู่แล้ว = ว่างเต็มที่
        : Math.min(data[i], data[i + 1], data[i + 2]);
    }
  }

  // ลามจากพื้นขาวของช่องออกไปตามพิกเซลที่ยังผสมพื้นขาวอยู่ = ขอบฟุ้ง
  // คุมด้วยระยะแคบ ๆ เพราะขาวของพื้นช่องกับขาวของตัวลายแยกกันไม่ออกในภาพแบน
  const allowed = dilate(core, boxW, boxH, SOFT_RADIUS);
  const near = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let o = 0; o < n; o++) if (core[o]) { near[o] = 1; queue[tail++] = o; }
  while (head < tail) {
    const o = queue[head++];
    const x = o % boxW;
    const y = (o - x) / boxW;
    // ขาวจัด (>= OPAQUE_WHITE) ที่ไม่ได้อยู่ในพื้นช่อง คือของขาวในตัวลายเอง — ห้ามลามเข้า
    const push = (p) => { if (!near[p] && allowed[p] && lum[p] > SHADOW_MIN && lum[p] < OPAQUE_WHITE) { near[p] = 1; queue[tail++] = p; } };
    if (x > 0) push(o - 1);
    if (x < boxW - 1) push(o + 1);
    if (y > 0) push(o - boxW);
    if (y < boxH - 1) push(o + boxW);
  }

  const out = Buffer.alloc(n, 0);
  // สูตรถอดพื้นขาว: พิกเซลในไฟล์คือสีลายผสมพื้นขาว T = a*S + (1-a)*255
  // ถ้าสีลายจริงเข้ม (min ใกล้ 0) จะได้ a = 1 - min(T)/255 พอดี
  // ฉะนั้น "ความว่าง" ที่ให้รูปทับ = min(T) ตรง ๆ ไม่ต้องตั้งเกณฑ์เอง
  for (let o = 0; o < n; o++) if (near[o]) out[o] = lum[o];
  return out;
}

/** พิกเซลนี้ถือเป็น "ช่องว่างสำหรับใส่รูป" ไหม */
function isSlotPixel(data, idx, channels) {
  if (channels === 4) {
    const alpha = data[idx + 3];
    if (alpha < ALPHA_EMPTY) return true;
    if (alpha < 250) return false;
  }
  return data[idx] >= NEAR_WHITE && data[idx + 1] >= NEAR_WHITE && data[idx + 2] >= NEAR_WHITE;
}

/**
 * หากล่องสี่เหลี่ยมว่างในเทมเพลตด้วย flood fill (วนซ้ำ ไม่ใช้ recursion กัน stack ล้นกับภาพใหญ่)
 * @returns {Promise<{width:number,height:number,hasAlpha:boolean,slots:Array<{left:number,top:number,width:number,height:number}>}>}
 */
export async function detectSlots(templatePath, { minAreaRatio = 0.004, minFillRatio = 0.85 } = {}) {
  const image = sharp(templatePath);
  const meta = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const visited = new Uint8Array(width * height);
  const minArea = Math.round(width * height * minAreaRatio);
  const slots = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < width * height; start++) {
    if (visited[start]) continue;
    if (!isSlotPixel(data, start * channels, channels)) {
      visited[start] = 1;
      continue;
    }

    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    let area = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    const members = [];

    while (top > 0) {
      const pixel = stack[--top];
      const x = pixel % width;
      const y = (pixel - x) / width;
      area++;
      members.push(pixel);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // เพื่อนบ้าน 4 ทิศ
      if (x > 0) { const n = pixel - 1; if (!visited[n] && isSlotPixel(data, n * channels, channels)) { visited[n] = 1; stack[top++] = n; } }
      if (x < width - 1) { const n = pixel + 1; if (!visited[n] && isSlotPixel(data, n * channels, channels)) { visited[n] = 1; stack[top++] = n; } }
      if (y > 0) { const n = pixel - width; if (!visited[n] && isSlotPixel(data, n * channels, channels)) { visited[n] = 1; stack[top++] = n; } }
      if (y < height - 1) { const n = pixel + width; if (!visited[n] && isSlotPixel(data, n * channels, channels)) { visited[n] = 1; stack[top++] = n; } }
    }

    if (area < minArea) continue;
    if (area / ((maxX - minX + 1) * (maxY - minY + 1)) < minFillRatio) continue;
    const padX0 = Math.max(0, minX - BOX_PAD);
    const padY0 = Math.max(0, minY - BOX_PAD);
    const padX1 = Math.min(width - 1, maxX + BOX_PAD);
    const padY1 = Math.min(height - 1, maxY + BOX_PAD);
    const boxW = padX1 - padX0 + 1;
    const boxH = padY1 - padY0 + 1;
    // เก็บรูปทรงจริงของช่องไว้เป็นมาสก์ ไม่ใช่แค่กรอบสี่เหลี่ยม
    // เพราะมาสคอต/ดาวที่ล้ำเข้ามาในกรอบไม่ใช่พิกเซลขาว จะได้ไม่โดนรูปทับ
    const core = Buffer.alloc(boxW * boxH, 0);
    for (const pixel of members) {
      const x = pixel % width;
      const y = (pixel - x) / width;
      core[(y - padY0) * boxW + (x - padX0)] = 255;
    }
    const mask = softMask(core, data, info, padX0, padY0, boxW, boxH);
    slots.push({
      left: padX0,
      top: padY0,
      width: boxW,
      height: boxH,
      mask,
      radius: cornerRadiusOf(core, boxW, boxH),
      ink: inkLayer(mask, data, info, padX0, padY0, boxW, boxH),
    });
  }

  // เรียงบนลงล่าง ซ้ายไปขวา เหมือนลำดับที่คนอ่าน
  const rowTolerance = Math.round(height * 0.02);
  slots.sort((a, b) => (Math.abs(a.top - b.top) <= rowTolerance ? a.left - b.left : a.top - b.top));

  // ต้องดูที่ "กลางช่องจริง" ว่าโปร่งใสหรือขาวทึบ — ดูแค่ hasAlpha ของไฟล์ไม่พอ
  // เพราะ PNG มี alpha channel ได้ทั้งที่ช่องรูปเป็นสีขาวทึบ (เจอตอนเทสต์)
  let slotsTransparent = false;
  if (channels === 4 && slots.length) {
    const first = slots[0];
    const cx = first.left + Math.floor(first.width / 2);
    const cy = first.top + Math.floor(first.height / 2);
    slotsTransparent = data[(cy * width + cx) * channels + 3] < ALPHA_EMPTY;
  }

  return { width, height, hasAlpha: Boolean(meta.hasAlpha), slotsTransparent, slots };
}

/** เดารัศมีมุมมนของช่อง จากระยะที่พื้นขาวเว้นจากมุมกล่อง
 *  ใช้ค่าต่ำสุดจาก 8 ด้าน เพราะลายที่บังมุมดันค่าให้สูงเกินจริงได้ทางเดียว */
function cornerRadiusOf(core, w, h) {
  const scanRow = (y, fromLeft) => {
    for (let i = 0; i < w; i++) if (core[y * w + (fromLeft ? i : w - 1 - i)]) return i;
    return -1;
  };
  const scanCol = (x, fromTop) => {
    for (let i = 0; i < h; i++) if (core[(fromTop ? i : h - 1 - i) * w + x]) return i;
    return -1;
  };
  const est = [
    scanRow(0, true), scanRow(0, false), scanRow(h - 1, true), scanRow(h - 1, false),
    scanCol(0, true), scanCol(0, false), scanCol(w - 1, true), scanCol(w - 1, false),
  ].filter((v) => v >= 0);
  return est.length ? Math.min(...est) : 0;
}

/**
 * ชั้น "ลาย" ของช่อง = กราฟิกที่ต้องอยู่หน้ารูป (มาสคอต ดาว กรอบ)
 *
 * ถอนพื้นขาวออกจากสีก่อน (unpremultiply) เพราะพิกเซลขอบฟุ้งในไฟล์เทมเพลตคือ
 * สีลายผสมพื้นขาวมาแล้ว ถ้าเอาไปวางทับรูปตรง ๆ จะได้ฝ้าซีด ๆ ตามขอบลาย
 * T = a*S + (1-a)*ขาว  =>  S = (T - 255*(1-a)) / a
 */
function inkLayer(soft, data, info, minX, minY, boxW, boxH) {
  const { width, channels } = info;
  const out = Buffer.alloc(boxW * boxH * 4);
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const o = y * boxW + x;
      const oo = o * 4;
      const a = 255 - soft[o];
      if (a <= 0) continue; // ช่องว่างล้วน ปล่อยโปร่งใสให้เห็นรูป
      const i = ((minY + y) * width + (minX + x)) * channels;
      out[oo + 3] = a;
      if (a >= 255) {
        out[oo] = data[i]; out[oo + 1] = data[i + 1]; out[oo + 2] = data[i + 2];
        continue;
      }
      const f = a / 255;
      for (let c = 0; c < 3; c++) {
        const v = (data[i + c] - 255 * (1 - f)) / f;
        out[oo + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return out;
}

const roundedMask = (w, h, r) =>
  Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

/**
 * ครอปรูปให้เต็มช่อง (cover) แล้วตัดตามรูปทรงของช่องจริง
 * ถ้ามีมาสก์จากเทมเพลต ใช้มาสก์นั้น (ได้มุมโค้งตามกรอบจริง และเว้นที่ให้มาสคอต/ดาวที่ล้ำเข้ามา)
 * ถ้าไม่มี ค่อยมนมุมด้วยรัศมีประมาณ
 */
async function fitToSlot(photoPath, slot, cornerRadius) {
  const filled = await sharp(photoPath)
    .rotate()
    .resize(slot.width, slot.height, { fit: 'cover', position: 'attention' })
    .png()
    .toBuffer();

  if (!cornerRadius) return filled;
  return sharp(filled)
    .composite([{ input: roundedMask(slot.width, slot.height, cornerRadius), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * ประกอบการ์ดจากเทมเพลต
 * @param {string[]} photos รูปเรียงตามลำดับช่อง
 * @param {object} template ผลจาก detectSlots (หรือ slots ที่กำหนดเอง)
 * @param {string} templatePath ไฟล์เทมเพลต
 * @param {{cornerRadiusRatio?:number}} options
 */
export async function renderTemplateCard(photos, template, templatePath, { cornerRadiusRatio = 0.04, scale = 1 } = {}) {
  const factor = Math.max(1, Number(scale) || 1);
  const base = factor === 1 ? template : scaleTemplate(template, factor);
  const { slots, slotsTransparent, width, height, cropLeft = 0 } = base;
  if (!slots.length) throw new Error('ไม่พบช่องใส่รูปในเทมเพลต');

  const layers = [];
  for (let i = 0; i < slots.length && i < photos.length; i++) {
    const slot = slots[i];
    // มาสก์/ลาย เก็บไว้ที่ความละเอียดไฟล์ต้นฉบับ (template.slots) ส่วน slot อาจถูกขยายแล้ว
    const source = template.slots[i];
    const grow = source ? slot.width / source.width : 1;
    const radius = source?.radius
      ? Math.round(source.radius * grow)
      : Math.round(Math.min(slot.width, slot.height) * cornerRadiusRatio);

    // มีชั้นลาย = รูปปูเต็มกล่องได้เลย ไม่ต้องมนมุมเอง เพราะชั้นลายทึบนอกพื้นขาวอยู่แล้ว
    // จะได้ไม่เหลือเส้นขาวคั่นระหว่างขอบรูปกับกรอบ
    const shaped = source?.ink ? 0 : radius;
    layers.push({ input: await fitToSlot(photos[i], slot, shaped), left: slot.left, top: slot.top });

    if (source?.ink) {
      const ink = await sharp(source.ink, {
        raw: { width: source.width, height: source.height, channels: 4 },
      })
        .resize(slot.width, slot.height, { fit: 'fill', kernel: 'cubic' })
        .png()
        .toBuffer();
      layers.push({ input: ink, left: slot.left, top: slot.top });
    }
  }

  // ถ้าตัดครึ่งเทมเพลตมาใช้ ต้องครอปไฟล์เทมเพลตตามด้วย ไม่งั้นขนาดไม่ตรงผืนและภาพพื้นหลังเลื่อน
  // (ครึ่งซ้ายได้ cropLeft = 0 ซึ่งเป็น falsy — ต้องเช็ค template.cropped ไม่ใช่ค่า cropLeft)
  let templateImage = sharp(templatePath);
  if (template.cropped) {
    templateImage = templateImage.extract({
      left: Math.round(cropLeft / factor),
      top: 0,
      width: Math.round(width / factor),
      height: Math.round(height / factor),
    });
  }
  if (factor !== 1) templateImage = templateImage.resize(width, height, { kernel: 'lanczos3' });
  const templateBuf = await templateImage.png().toBuffer();

  // เทมเพลตเป็นฐานเสมอ แล้ววางรูป+ชั้นลายของแต่ละช่องทับ
  // (ชั้นลายพารูปทรง/สีของกราฟิกที่ต้องอยู่หน้ารูปมาเองแล้ว ไม่ต้องสลับลำดับตามชนิดช่อง)
  const ordered = [{ input: templateBuf, left: 0, top: 0 }, ...layers];

  return sharp({ create: { width, height, channels: 3, background: '#000000' } })
    .composite(ordered)
    .jpeg({ quality: 94 })
    .toBuffer();
}

/** ขยายพิกัดทั้งหมดตามอัตราขยาย เพื่อเรนเดอร์การ์ดใหญ่กว่าไฟล์เทมเพลตต้นฉบับ */
function scaleTemplate(template, factor) {
  return {
    ...template,
    width: Math.round(template.width * factor),
    height: Math.round(template.height * factor),
    cropLeft: Math.round((template.cropLeft || 0) * factor),
    slots: template.slots.map((s) => ({
      left: Math.round(s.left * factor),
      top: Math.round(s.top * factor),
      width: Math.round(s.width * factor),
      height: Math.round(s.height * factor),
    })),
  };
}

/** ตัดเทมเพลตเอาเฉพาะครึ่งเดียว (เทมเพลตที่วางสตริปคู่กันไว้สำหรับตัดกระดาษ) */
export function halfOf(template, side) {
  if (side !== 'left' && side !== 'right') return template;
  const halfWidth = Math.round(template.width / 2);
  const offset = side === 'left' ? 0 : halfWidth;
  const slots = template.slots
    .filter((s) => s.left + s.width / 2 >= offset && s.left + s.width / 2 < offset + halfWidth)
    .map((s) => ({ ...s, left: s.left - offset }));
  return { ...template, width: halfWidth, slots, cropLeft: offset, cropped: true };
}

export function templateExists(templatePath) {
  return Boolean(templatePath) && fs.existsSync(templatePath);
}
