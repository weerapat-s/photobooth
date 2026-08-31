/**
 * ตรวจว่าเครื่องที่เพิ่งติดตั้งพร้อมใช้จริงไหม แล้วคืนผลเป็น JSON ให้ setup.ps1 อ่าน
 * ตรวจสามอย่างที่ทำให้ระบบใช้ไม่ได้ถ้าพัง: ต่อ NAS ได้, แยกลิงก์ต่อคนได้, เทมเพลตการ์ดใช้ได้
 */
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import {
  health, hasOwnerCredentials, ensureDir, remove,
  createSessionShare, deleteShare, NC_ROOT,
} from '../server/nextcloud.js';
import { detectSlots, templateExists } from '../server/template.js';

const report = { share: { ok: false }, owner: { ok: false }, template: { ok: false } };

const shareCheck = await health();
report.share = shareCheck.ok
  ? { ok: true, base: config.nc.base }
  : { ok: false, error: shareCheck.error || `HTTP ${shareCheck.status}` };

if (!hasOwnerCredentials()) {
  report.owner = { ok: false, error: 'ยังไม่ได้ตั้ง NC_USER / NC_APP_PASSWORD' };
} else if (!report.share.ok) {
  report.owner = { ok: false, error: 'ข้ามเพราะต่อ NAS ไม่ได้' };
} else {
  // สร้างโฟลเดอร์ + แชร์จริงแล้วลบทิ้ง เป็นวิธีเดียวที่พิสูจน์ได้ว่าสิทธิ์ใช้ได้จริงทั้งสองทาง
  const probe = `${NC_ROOT}/.install-check-${Date.now()}`;
  let shareId = null;
  try {
    await ensureDir(probe);
    shareId = (await createSessionShare(probe)).shareId;
    report.owner = { ok: true };
  } catch (err) {
    report.owner = { ok: false, error: err.message };
  } finally {
    if (shareId) await deleteShare(shareId).catch(() => {});
    await remove(probe).catch(() => {});
  }
}

if (!config.cardTemplate) {
  report.template = { ok: false, error: 'ยังไม่ได้ตั้ง CARD_TEMPLATE' };
} else {
  const templatePath = path.isAbsolute(config.cardTemplate)
    ? config.cardTemplate
    : path.join(ROOT, config.cardTemplate);
  if (!templateExists(templatePath)) {
    report.template = { ok: false, error: `ไม่พบไฟล์ ${config.cardTemplate}` };
  } else {
    try {
      const t = await detectSlots(templatePath);
      const perCard = config.cardTemplateHalf === 'full' ? t.slots.length : Math.floor(t.slots.length / 2);
      report.template = perCard > 0
        ? { ok: true, slots: perCard, size: `${t.width}x${t.height}` }
        : { ok: false, error: 'หาช่องใส่รูปในเทมเพลตไม่เจอ' };
    } catch (err) {
      report.template = { ok: false, error: err.message };
    }
  }
}

process.stdout.write(JSON.stringify(report));
