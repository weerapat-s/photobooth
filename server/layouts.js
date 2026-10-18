import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { templateExists } from './template.js';

/**
 * รายการเลย์เอาต์การ์ดที่เลือกได้
 *
 * ตัวรายการอยู่ในไฟล์ assets/layouts.json เพราะเลย์เอาต์หนึ่งอันมีหลายค่า
 * (ไฟล์เทมเพลต ครึ่งไหน อัตราขยาย ชื่อที่โชว์) ยัดลง .env แล้วอ่านไม่ออก
 * ส่วน .env เก็บแค่ว่าจะใช้อันไหนเป็นค่าตั้งต้น และให้ลูกค้าเลือกเองได้ไหม
 *
 * ถ้าไม่มีไฟล์รายการ จะสร้างรายการเดียวจาก CARD_TEMPLATE ให้อัตโนมัติ
 * ของเดิมที่ตั้ง CARD_TEMPLATE ไว้จึงยังทำงานเหมือนเดิมโดยไม่ต้องแก้อะไร
 */

const HALVES = new Set(['left', 'right', 'full']);

const abs = (rel) => (path.isAbsolute(rel) ? rel : path.join(ROOT, rel));

let cache = null;

function readFile() {
  const file = abs(config.cardLayoutsFile);
  if (!fs.existsSync(file)) return { file, mtime: 0, raw: null };
  return { file, mtime: fs.statSync(file).mtimeMs, raw: fs.readFileSync(file, 'utf8') };
}

function parse(raw, file) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new Error(`อ่าน ${path.basename(file)} ไม่ได้: ${err.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${path.basename(file)} ต้องเป็น array`);

  const seen = new Set();
  return list.map((entry, index) => {
    const id = String(entry?.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`เลย์เอาต์ลำดับที่ ${index + 1}: id ต้องเป็น a-z 0-9 และ - เท่านั้น`);
    }
    if (seen.has(id)) throw new Error(`เลย์เอาต์ id ซ้ำ: ${id}`);
    seen.add(id);

    const template = String(entry?.template || '').trim();
    if (!template) throw new Error(`เลย์เอาต์ ${id}: ไม่ได้ระบุไฟล์ template`);
    const half = entry?.half === undefined ? 'left' : String(entry.half);
    if (!HALVES.has(half)) throw new Error(`เลย์เอาต์ ${id}: half ต้องเป็น left, right หรือ full`);

    return {
      id,
      name: String(entry?.name || id),
      template,
      templatePath: abs(template),
      half,
      scale: Number(entry?.scale) > 0 ? Number(entry.scale) : 1,
    };
  });
}

/** เลย์เอาต์เดียวที่สร้างจาก CARD_TEMPLATE — ทางเข้ากันได้กับการตั้งค่าแบบเดิม */
function fromLegacyEnv() {
  if (!config.cardTemplate) return [];
  return [{
    id: 'default',
    name: 'เทมเพลตหลัก',
    template: config.cardTemplate,
    templatePath: abs(config.cardTemplate),
    half: HALVES.has(config.cardTemplateHalf) ? config.cardTemplateHalf : 'left',
    scale: config.cardTemplateScale,
  }];
}

/** รายการเลย์เอาต์ทั้งหมดที่ตั้งไว้ (ยังไม่กรองว่าไฟล์มีอยู่จริงไหม) */
export function allLayouts() {
  const { file, mtime, raw } = readFile();
  if (cache && cache.file === file && cache.mtime === mtime) return cache.list;
  const list = raw === null ? fromLegacyEnv() : parse(raw, file);
  cache = { file, mtime, list };
  return list;
}

/** เฉพาะเลย์เอาต์ที่ไฟล์เทมเพลตมีอยู่จริง — อันที่ไฟล์หายจะไม่โผล่ให้เลือก */
export function availableLayouts() {
  return allLayouts().filter((layout) => templateExists(layout.templatePath));
}

/** เลย์เอาต์ที่ใช้เมื่อไม่ได้ระบุมา (ค่าใน .env ถ้าใช้ไม่ได้ ก็เอาอันแรกที่มี) */
export function defaultLayout() {
  const list = availableLayouts();
  if (!list.length) return null;
  return list.find((layout) => layout.id === config.cardLayout) || list[0];
}

/**
 * เลือกเลย์เอาต์สำหรับเซสชัน
 * รับ id ที่ลูกค้าเลือกมาได้ แต่จะยอมก็ต่อเมื่อเปิดโหมดให้ลูกค้าเลือก
 * ไม่งั้นใครยิง API ตรง ๆ ก็ข้ามการตั้งค่าของช่างได้
 */
export function resolveLayout(requestedId) {
  const fallback = defaultLayout();
  if (!requestedId || !customerChooses()) return fallback;
  const picked = availableLayouts().find((layout) => layout.id === String(requestedId));
  return picked || fallback;
}

/** เปิดให้ลูกค้าเลือกเลย์เอาต์เองไหม (ต้องมีให้เลือกมากกว่าหนึ่งแบบด้วย) */
export function customerChooses() {
  return config.cardLayoutChoice === 'customer' && availableLayouts().length > 1;
}

export function findLayout(id) {
  return availableLayouts().find((layout) => layout.id === String(id)) || null;
}

/** ลงทะเบียนเทมเพลตที่เพิ่มจากหน้าจอช่าง */
export function registerLayout({ id, name, template, half = 'left', scale = 1 }) {
  const { file, raw } = readFile();
  if (raw === null) throw new Error('ไม่พบไฟล์รายการเลย์เอาต์');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('id เลย์เอาต์ไม่ถูกต้อง');
  if (!HALVES.has(half)) throw new Error('half ต้องเป็น left, right หรือ full');
  if (!template || path.isAbsolute(template) || template.includes('..')) throw new Error('path เทมเพลตไม่ถูกต้อง');

  const list = JSON.parse(raw);
  if (list.some((entry) => entry.id === id)) throw new Error('มี id เลย์เอาต์นี้แล้ว');
  list.push({ id, name: String(name || id), template, half, scale: Number(scale) > 0 ? Number(scale) : 1 });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  cache = null;
}
