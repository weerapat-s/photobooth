import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * เขียนไฟล์ ZIP แบบ "เก็บอย่างเดียว" (store ไม่บีบอัด) ส่งออกทาง stream
 *
 * เขียนเองเพราะของที่จะใส่เป็น JPEG กับ MP4 ซึ่งบีบอัดมาแล้ว บีบซ้ำแทบไม่ลดขนาด
 * และตู้ต้องติดตั้งแบบออฟไลน์ได้ จึงไม่อยากเพิ่มไลบรารีเข้าไปในชุดติดตั้ง
 *
 * ส่งทีละไฟล์ อ่านไฟล์เข้าหน่วยความจำทีละไฟล์เท่านั้น (ต้องรู้ CRC กับขนาดก่อนเขียนหัวไฟล์)
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** เวลาแบบ MS-DOS ที่ ZIP ใช้ (ความละเอียด 2 วินาที เริ่มนับปี 1980) */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {import('node:stream').Writable} out
 * @param {Array<{name: string, path: string}>} entries
 */
export async function writeZip(out, entries) {
  const directory = [];
  let offset = 0;
  const push = (buf) => { out.write(buf); offset += buf.length; };

  for (const entry of entries) {
    let data;
    try {
      data = await fsp.readFile(entry.path);
    } catch {
      continue; // ไฟล์หายระหว่างทาง ข้ามไป ดีกว่าส่ง zip พัง
    }
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const stat = await fsp.stat(entry.path).catch(() => null);
    const { time, date } = dosDateTime(stat?.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // ต้องใช้เวอร์ชัน 2.0
    local.writeUInt16LE(0x0800, 6);    // บิต 11 = ชื่อไฟล์เป็น UTF-8
    local.writeUInt16LE(0, 8);         // 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const headerOffset = offset;
    push(local);
    push(name);
    push(data);
    directory.push({ name, crc, size: data.length, time, date, headerOffset });
  }

  const centralStart = offset;
  for (const item of directory) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // เขียนโดยเวอร์ชัน 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(item.time, 12);
    central.writeUInt16LE(item.date, 14);
    central.writeUInt32LE(item.crc, 16);
    central.writeUInt32LE(item.size, 20);
    central.writeUInt32LE(item.size, 24);
    central.writeUInt16LE(item.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(item.headerOffset, 42);
    push(central);
    push(item.name);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  push(end);
  out.end();
}

/** ขนาดรวมของ zip ที่จะได้ (ไว้ใส่ Content-Length ให้เบราว์เซอร์โชว์ความคืบหน้า) */
export function zipSize(entries) {
  let total = 22;
  for (const entry of entries) {
    let size;
    try {
      size = fs.statSync(entry.path).size;
    } catch {
      continue;
    }
    const nameLength = Buffer.byteLength(entry.name, 'utf8');
    total += 30 + nameLength + size + 46 + nameLength;
  }
  return total;
}
