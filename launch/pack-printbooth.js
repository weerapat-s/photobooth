// สร้างโฟลเดอร์พร้อมก๊อปไปลงเครื่องบูทปริ้นเครื่องอื่น
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'printbooth');
const outRoot = path.join(ROOT, 'dist');
const out = path.join(outRoot, 'printbooth');

const SKIP = new Set(['node_modules', '.env', 'logs', 'package-lock.json']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(out, { recursive: true, force: true });
copyDir(src, out);

// อ่านค่า Nextcloud จาก .env ของเครื่องนี้ ใส่ให้ .env.example ของแพ็กเกจเลย จะได้ไม่ต้องพิมพ์ซ้ำ
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  const env = Object.fromEntries(
    fs.readFileSync(envFile, 'utf8')
      .split('\n')
      .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*([^#]*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const target = path.join(out, '.env.example');
  let text = fs.readFileSync(target, 'utf8');
  for (const key of ['NC_BASE', 'NC_SHARE_TOKEN', 'NC_SHARE_PASSWORD', 'NC_ROOT']) {
    if (env[key] !== undefined) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${env[key]}`);
  }
  fs.writeFileSync(target, text, 'utf8');
}

const readme = `บูทปริ้น — วิธีติดตั้งบนเครื่องใหม่

1. ติดตั้ง Node.js จาก https://nodejs.org (LTS ก็พอ)
2. ก๊อปโฟลเดอร์นี้ทั้งโฟลเดอร์ไปวางบนเครื่องปริ้น เช่น C:\\printbooth
3. ดับเบิลคลิก install.cmd — มันจะลง dependency, สร้าง .env, สร้างไอคอนบนเดสก์ท็อป แล้วเปิด .env ให้แก้
4. ใน .env แก้ 2 บรรทัด:
     PRINTER_ID=print-2          <- ห้ามซ้ำกับเครื่องอื่น
     PRINTER_NAME=ชื่อเครื่องพิมพ์ <- ดูชื่อจาก Settings > Printers & scanners (เว้นว่าง = เครื่องพิมพ์เริ่มต้น)
5. ดับเบิลคลิกไอคอน "บูทปริ้น" บนเดสก์ท็อป (หน้าคอนโซลช่าง)

ได้ไอคอนอีกอัน "คิวปริ้น" — เปิดจอบอร์ดเต็มจอโชว์เลขคิวที่กำลังพิมพ์ตัวใหญ่ ๆ
เอาไปเปิดบนจอทีวี/มอนิเตอร์ที่ลูกค้ามองเห็นได้ เพื่อรอฟังเลขคิวแทนการเดินไปดูหน้าจอช่าง

กี่เครื่องก็ได้ ทุกเครื่องดึงคิวเดียวกันจาก Nextcloud
งานหนึ่งชิ้นถูกจองด้วยการย้ายไฟล์ เครื่องที่ย้ายสำเร็จก่อนได้ไป เครื่องอื่นข้าม ไม่พิมพ์ซ้ำ
ถ้าเครื่องไหนดับกลางคัน งานที่ค้างเกิน STALE_CLAIM_MINUTES นาที จะถูกเอากลับเข้าคิวให้เครื่องที่เหลือทำต่อ

อยากให้เครื่องนี้รับเฉพาะบางบูท ตั้ง ACCEPT_BOOTHS=booth-1,booth-2
อยากเทสต์โดยไม่เปลืองกระดาษ ตั้ง DRY_RUN=true
`;
fs.writeFileSync(path.join(out, 'อ่านก่อน.txt'), readme, 'utf8');

console.log('แพ็กเสร็จ:', out);
console.log('ก๊อปโฟลเดอร์นี้ไปวางบนเครื่องปริ้นแต่ละเครื่อง แล้วดับเบิลคลิก install.cmd');
