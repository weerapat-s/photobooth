import fs from 'node:fs';
import sharp from 'sharp';

/**
 * รองรับการ์ดแบบ "เทมเพลตสำเร็จรูป" — ใช้ไฟล์ PNG ที่ออกแบบไว้แล้ว (พื้นหลัง โลโก้ มาสคอต ฯลฯ)
 * แล้ววางรูปถ่ายลงในช่องว่างของเทมเพลต
 *
 * ช่องรูปในเทมเพลตเป็นได้ 2 แบบ ซึ่งต้องวางรูปคนละลำดับกัน:
 *  - โปร่งใส (alpha = 0) → วางรูป "ใต้" เทมเพลต กรอบและเงาของเทมเพลตทับบนรูปได้สวย
 *  - ขาวทึบ            → วางรูป "ทับ" เทมเพลตตรงช่องนั้น (ถ้าวางใต้จะโดนพื้นขาวบัง)
 */

const NEAR_WHITE = 240;
const ALPHA_EMPTY = 16;

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
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    // ต้องเป็นสี่เหลี่ยมจริง ๆ ไม่ใช่รูปทรงอิสระ (ตัวหนังสือขาว/ดาวขาวจะตกรอบนี้ไป)
    if (area / (boxW * boxH) < minFillRatio) continue;

    // เก็บรูปทรงจริงของช่องไว้เป็นมาสก์ ไม่ใช่แค่กรอบสี่เหลี่ยม
    // เพราะมาสคอต/ดาวที่ล้ำเข้ามาในกรอบไม่ใช่พิกเซลขาว จะได้ไม่โดนรูปทับ
    const mask = Buffer.alloc(boxW * boxH, 0);
    for (const pixel of members) {
      const x = pixel % width;
      const y = (pixel - x) / width;
      mask[(y - minY) * boxW + (x - minX)] = 255;
    }
    slots.push({ left: minX, top: minY, width: boxW, height: boxH, mask });
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

const roundedMask = (w, h, r) =>
  Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

/**
 * ครอปรูปให้เต็มช่อง (cover) แล้วตัดตามรูปทรงของช่องจริง
 * ถ้ามีมาสก์จากเทมเพลต ใช้มาสก์นั้น (ได้มุมโค้งตามกรอบจริง และเว้นที่ให้มาสคอต/ดาวที่ล้ำเข้ามา)
 * ถ้าไม่มี ค่อยมนมุมด้วยรัศมีประมาณ
 */
async function fitToSlot(photoPath, slot, cornerRadius, sourceMask) {
  const filled = await sharp(photoPath)
    .rotate()
    .resize(slot.width, slot.height, { fit: 'cover', position: 'attention' })
    .png()
    .toBuffer();

  if (sourceMask) {
    // ค่ามาสก์ต้องไปอยู่ใน "ช่องอัลฟา" ไม่ใช่ช่องสีเทา
    // ถ้าส่งเป็นภาพขาวดำเฉย ๆ อัลฟาจะทึบทั้งผืน แล้ว dest-in ไม่ตัดอะไรเลย (รูปทับมาสคอตเหมือนไม่มีมาสก์)
    // blur+linear = ขยายขอบมาสก์ออกนิดหน่อย ให้รูปลอดเข้าไปใต้ขอบมาสคอต
    // ไม่งั้นขอบฟุ้งของมาสคอต (ไม่ขาวพอ เลยไม่นับเป็นช่อง) จะเหลือเป็นคราบขาวรอบตัว
    const alphaRaw = await sharp(sourceMask.data, {
      raw: { width: sourceMask.width, height: sourceMask.height, channels: 1 },
    })
      .resize(slot.width, slot.height, { fit: 'fill', kernel: 'nearest' })
      .blur(1.2)
      .linear(2, 0)
      // blur คืนภาพ 3 ช่อง (sRGB) ต้องบีบกลับเป็นช่องเดียว ไม่งั้น joinChannel ได้บัฟเฟอร์ยาว 3 เท่าและอ่านเพี้ยน
      .toColourspace('b-w')
      .raw()
      .toBuffer();
    const alpha = await sharp({
      create: { width: slot.width, height: slot.height, channels: 3, background: '#ffffff' },
    })
      .joinChannel(alphaRaw, { raw: { width: slot.width, height: slot.height, channels: 1 } })
      .png()
      .toBuffer();
    return sharp(filled)
      .composite([{ input: alpha, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }

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
    const radius = Math.round(Math.min(slot.width, slot.height) * cornerRadiusRatio);
    // มาสก์เก็บไว้ที่ความละเอียดไฟล์ต้นฉบับ (template.slots) ส่วน slot อาจถูกขยายแล้ว
    const source = template.slots[i];
    const sourceMask = source?.mask
      ? { data: source.mask, width: source.width, height: source.height }
      : null;
    layers.push({
      input: await fitToSlot(photos[i], slot, radius, sourceMask),
      left: slot.left,
      top: slot.top,
    });
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

  // ช่องโปร่งใส → รูปอยู่ล่าง เทมเพลตทับบน; ช่องขาวทึบ → เทมเพลตอยู่ล่าง รูปทับช่องขาว
  const ordered = slotsTransparent
    ? [...layers, { input: templateBuf, left: 0, top: 0 }]
    : [{ input: templateBuf, left: 0, top: 0 }, ...layers];

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
