// สร้างไฟล์ .ico สำหรับ shortcut (ICO สมัยใหม่ฝัง PNG ได้ตรง ๆ)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const boothSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff4d6d"/><stop offset="1" stop-color="#c9184a"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <rect x="44" y="84" width="168" height="112" rx="20" fill="#fff"/>
  <rect x="96" y="62" width="64" height="30" rx="10" fill="#fff"/>
  <circle cx="128" cy="140" r="38" fill="#c9184a"/>
  <circle cx="128" cy="140" r="22" fill="#fff"/>
  <circle cx="186" cy="108" r="9" fill="#ffd166"/>
</svg>`;

/** ห่อ PNG หลายขนาดเป็นไฟล์ ICO */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function write(name, svg) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const data = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    pngs.push({ size, data });
  }
  const file = path.join(outDir, `${name}.ico`);
  fs.writeFileSync(file, buildIco(pngs));
  console.log('wrote', file);
}

const operatorSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#f77f00"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <rect x="36" y="56" width="184" height="122" rx="16" fill="#fff"/>
  <rect x="56" y="76" width="70" height="12" rx="6" fill="#f77f00"/>
  <rect x="56" y="100" width="118" height="10" rx="5" fill="#e0a44c" opacity="0.6"/>
  <rect x="56" y="122" width="94" height="10" rx="5" fill="#e0a44c" opacity="0.6"/>
  <circle cx="186" cy="146" r="16" fill="#2d6a4f"/>
  <rect x="96" y="190" width="64" height="14" rx="7" fill="#fff"/>
</svg>`;

await write('booth', boothSvg);
await write('operator', operatorSvg);
