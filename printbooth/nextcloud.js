import path from 'node:path';
import { config } from './config.js';

const nc = config.nc;
const auth = 'Basic ' + Buffer.from(`${nc.token}:${nc.password}`).toString('base64');

const clean = (p) => String(p).split('\\').join('/').replace(/^\/+|\/+$/g, '');
const encodePath = (p) => clean(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
const davUrl = (p) => `${nc.base}/public.php/webdav/${encodePath(p)}`;

async function dav(method, remotePath, { body, headers = {}, timeout = 60000 } = {}) {
  return fetch(davUrl(remotePath), {
    method,
    headers: { Authorization: auth, ...headers },
    body,
    signal: AbortSignal.timeout(timeout),
  });
}

export async function ensureDir(remotePath) {
  const parts = clean(remotePath).split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const res = await dav('MKCOL', cur, { timeout: 30000 });
    if (![201, 405].includes(res.status)) throw new Error(`สร้างโฟลเดอร์ ${cur} ไม่ได้: HTTP ${res.status}`);
  }
}

export async function getFile(remotePath) {
  const res = await dav('GET', remotePath);
  if (!res.ok) throw new Error(`ดาวน์โหลด ${remotePath} ไม่ได้: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** คืน [{name, isDir, size, modified}] */
export async function list(remotePath) {
  const res = await dav('PROPFIND', remotePath, {
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
    timeout: 30000,
  });
  if (res.status === 404) return [];
  if (!res.ok && res.status !== 207) throw new Error(`ลิสต์ ${remotePath} ไม่ได้: HTTP ${res.status}`);
  const xml = await res.text();
  const self = decodeURIComponent(`/public.php/webdav/${encodePath(remotePath)}`).replace(/\/$/, '');
  const out = [];
  for (const m of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const block = m[1];
    const href = decodeURIComponent((block.match(/<d:href>([^<]*)<\/d:href>/) || [])[1] || '');
    if (!href || href.replace(/\/$/, '') === self) continue;
    out.push({
      name: path.posix.basename(href.replace(/\/$/, '')),
      isDir: /<d:collection\s*\/>/.test(block),
      size: Number((block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/) || [])[1] || 0),
      modified: (block.match(/<d:getlastmodified>([^<]*)<\/d:getlastmodified>/) || [])[1] || null,
    });
  }
  return out;
}

/**
 * ย้ายไฟล์ — ใช้เป็นการ "จองงาน" ด้วย
 * เครื่องแรกที่ MOVE สำเร็จคือเจ้าของงาน เครื่องที่มาทีหลังจะได้ 404/412 แล้วข้ามไป
 * @returns {boolean} true = ย้ายสำเร็จ (จองได้), false = ไฟล์ถูกคนอื่นหยิบไปแล้ว
 */
export async function move(fromPath, toPath, { overwrite = false } = {}) {
  const res = await dav('MOVE', fromPath, {
    headers: { Destination: davUrl(toPath), Overwrite: overwrite ? 'T' : 'F' },
    timeout: 30000,
  });
  if ([201, 204].includes(res.status)) return true;
  if ([404, 409, 412].includes(res.status)) return false;
  throw new Error(`ย้าย ${fromPath} ไม่ได้: HTTP ${res.status}`);
}

export async function health() {
  try {
    const res = await dav('PROPFIND', '', { headers: { Depth: '0' }, timeout: 15000 });
    return { ok: res.status === 207, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
