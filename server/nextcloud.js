import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const nc = config.nc;
const auth = 'Basic ' + Buffer.from(`${nc.token}:${nc.password}`).toString('base64');

const clean = (p) => String(p).split('\\').join('/').replace(/^\/+|\/+$/g, '');
const encodePath = (p) => clean(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
const davUrl = (p) => `${nc.base}/public.php/webdav/${encodePath(p)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dav(method, remotePath, { body, headers = {}, timeout = 120000 } = {}) {
  return fetch(davUrl(remotePath), {
    method,
    headers: { Authorization: auth, ...headers },
    body,
    duplex: body ? 'half' : undefined,
    signal: AbortSignal.timeout(timeout),
  });
}

/** สร้างโฟลเดอร์แบบไล่ทีละชั้น (WebDAV MKCOL ไม่ทำ recursive ให้) */
export async function ensureDir(remotePath) {
  const parts = clean(remotePath).split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const res = await dav('MKCOL', cur, { timeout: 30000 });
    // 201 = สร้างแล้ว, 405 = มีอยู่แล้ว
    if (![201, 405].includes(res.status)) {
      throw new Error(`สร้างโฟลเดอร์ ${cur} ไม่ได้: HTTP ${res.status}`);
    }
  }
  return clean(remotePath);
}

export async function uploadFile(localPath, remotePath, { retries = 3 } = {}) {
  const buf = await fsp.readFile(localPath);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await dav('PUT', remotePath, {
        body: buf,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
      });
      if ([200, 201, 204].includes(res.status)) return clean(remotePath);
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === retries) throw new Error(`อัปโหลด ${path.basename(localPath)} ไม่สำเร็จ: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
}

export async function putText(text, remotePath) {
  const res = await dav('PUT', remotePath, {
    body: Buffer.from(text, 'utf8'),
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
  if (![200, 201, 204].includes(res.status)) throw new Error(`เขียนไฟล์ ${remotePath} ไม่ได้: HTTP ${res.status}`);
  return clean(remotePath);
}

export async function getFile(remotePath) {
  const res = await dav('GET', remotePath);
  if (!res.ok) throw new Error(`ดาวน์โหลด ${remotePath} ไม่ได้: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** ลิสต์ไฟล์ในโฟลเดอร์ คืน [{name, isDir, size, href}] */
export async function list(remotePath) {
  const res = await dav('PROPFIND', remotePath, {
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
    timeout: 30000,
  });
  if (res.status === 404) return [];
  if (!res.ok && res.status !== 207) throw new Error(`ลิสต์ ${remotePath} ไม่ได้: HTTP ${res.status}`);
  const xml = await res.text();
  const base = `/public.php/webdav/${encodePath(remotePath)}`.replace(/\/$/, '');
  const out = [];
  for (const m of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const block = m[1];
    const href = decodeURIComponent((block.match(/<d:href>([^<]*)<\/d:href>/) || [])[1] || '');
    const self = decodeURIComponent(base);
    if (!href || href.replace(/\/$/, '') === self) continue;
    const isDir = /<d:collection\s*\/>/.test(block);
    const size = Number((block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/) || [])[1] || 0);
    const modified = (block.match(/<d:getlastmodified>([^<]*)<\/d:getlastmodified>/) || [])[1] || null;
    out.push({ name: path.posix.basename(href.replace(/\/$/, '')), isDir, size, modified, href });
  }
  return out;
}

export async function move(fromPath, toPath) {
  const res = await dav('MOVE', fromPath, {
    headers: { Destination: davUrl(toPath), Overwrite: 'T' },
    timeout: 30000,
  });
  if (![201, 204].includes(res.status)) throw new Error(`ย้าย ${fromPath} ไม่ได้: HTTP ${res.status}`);
}

export async function remove(remotePath) {
  const res = await dav('DELETE', remotePath, { timeout: 30000 });
  if (![204, 404].includes(res.status)) throw new Error(`ลบ ${remotePath} ไม่ได้: HTTP ${res.status}`);
}

/**
 * ลิงก์หน้าเว็บของโฟลเดอร์ในเซสชัน แบบ subfolder ของ share หลัก
 * ใช้ได้แค่เป็น fallback — ลูกค้าที่สแกนกดขึ้น breadcrumb แล้วเห็นเซสชันคนอื่นได้
 * ของจริงต้องใช้ createSessionShare() ด้านล่าง ซึ่ง root อยู่ที่โฟลเดอร์เซสชันเลย ขึ้นบนไม่ได้
 */
export function shareUrl(remoteDir) {
  // ต้องคง `/` เป็นตัวคั่นจริง ๆ (ถ้า encode เป็น %2F ทั้งก้อน Nextcloud จะเด้งกลับ root)
  return `${nc.base}/s/${nc.token}?dir=/${encodePath(remoteDir)}`;
}

const ocsAuth = () => 'Basic ' + Buffer.from(`${nc.user}:${nc.appPassword}`).toString('base64');

export function hasOwnerCredentials() {
  return Boolean(nc.user && nc.appPassword);
}

/**
 * สร้าง public share ใหม่ที่ root อยู่ที่โฟลเดอร์เซสชันเอง (อ่านอย่างเดียว)
 * ผ่าน Nextcloud OCS API ด้วยบัญชีเจ้าของไฟล์ (ไม่ใช่ share token) — ต่างจาก shareUrl() ตรงที่
 * ลูกค้าจะกด "ขึ้นบน" ไม่ได้เลย เพราะโฟลเดอร์นี้คือรากของ share ใหม่ตัวเอง ไม่ใช่ subfolder
 * @returns {Promise<{url:string, shareId:string}>}
 */
export async function createSessionShare(remoteDir) {
  if (!hasOwnerCredentials()) {
    throw new Error('ยังไม่ได้ตั้ง NC_USER / NC_APP_PASSWORD — สร้างลิงก์แยกต่อเซสชันไม่ได้');
  }
  const ownerPath = [nc.ownerPrefix, clean(remoteDir)].filter(Boolean).join('/');
  const body = new URLSearchParams({ path: ownerPath, shareType: '3', permissions: '1' });
  const res = await fetch(`${nc.base}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
    method: 'POST',
    headers: {
      Authorization: ocsAuth(),
      'OCS-APIRequest': 'true',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => null);
  const meta = json?.ocs?.meta;
  if (!res.ok || meta?.statuscode >= 300) {
    throw new Error(`สร้างลิงก์เซสชันไม่ได้: ${meta?.message || `HTTP ${res.status}`}`);
  }
  const data = json.ocs.data;
  return { url: data.url, shareId: String(data.id) };
}

export async function deleteShare(shareId) {
  if (!hasOwnerCredentials()) return;
  const res = await fetch(`${nc.base}/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}?format=json`, {
    method: 'DELETE',
    headers: { Authorization: ocsAuth(), 'OCS-APIRequest': 'true' },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ocs?.meta?.statuscode >= 300) {
    throw new Error(`ลบลิงก์ share ${shareId} ไม่ได้: ${json?.ocs?.meta?.message || `HTTP ${res.status}`}`);
  }
}

export async function findSessionShares(remoteDir) {
  if (!hasOwnerCredentials()) return [];
  const ownerPath = [nc.ownerPrefix, clean(remoteDir)].filter(Boolean).join('/');
  const query = new URLSearchParams({ path: ownerPath, reshares: 'true', format: 'json' });
  const res = await fetch(`${nc.base}/ocs/v2.php/apps/files_sharing/api/v1/shares?${query}`, {
    headers: { Authorization: ocsAuth(), 'OCS-APIRequest': 'true' },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ocs?.meta?.statuscode >= 300) return [];
  const data = Array.isArray(json?.ocs?.data) ? json.ocs.data : [];
  return data.map((share) => ({ shareId: String(share.id), url: share.url || null }));
}

/** ลิงก์ดาวน์โหลดไฟล์เดี่ยวตรง ๆ */
export function directDownloadUrl(remoteDir, fileName) {
  const rel = clean(remoteDir);
  return `${nc.base}/s/${nc.token}/download?path=/${encodeURIComponent(rel)}&files=${encodeURIComponent(fileName)}`;
}

export async function health() {
  try {
    const res = await dav('PROPFIND', '', { headers: { Depth: '0' }, timeout: 15000 });
    return { ok: res.status === 207, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const NC_ROOT = nc.root;
