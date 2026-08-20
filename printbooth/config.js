import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  // ชื่อเครื่องพิมพ์ตัวนี้ ต้องไม่ซ้ำกันในงานเดียวกัน — ใช้ตอนจองงานจากคิว
  printerId: (process.env.PRINTER_ID || os.hostname() || 'print-1').replace(/[^A-Za-z0-9_-]/g, '-'),
  host: process.env.PRINT_HOST || '127.0.0.1',
  port: num(process.env.PRINT_PORT, 4701),
  boardHost: process.env.BOARD_HOST || '0.0.0.0',
  boardPort: num(process.env.BOARD_PORT, 4702),
  printerName: process.env.PRINTER_NAME || '',
  paper: process.env.PAPER || '4x6',
  auto: bool(process.env.AUTO_PRINT, true),
  pollMs: num(process.env.POLL_SECONDS, 5) * 1000,
  dryRun: bool(process.env.DRY_RUN, false),
  maxCopies: num(process.env.MAX_COPIES, 5),
  // รับงานเฉพาะบูทที่ระบุ (เว้นว่าง = รับทุกบูท) เช่น "booth-1,booth-2"
  acceptBooths: list(process.env.ACCEPT_BOOTHS),
  // งานที่จองไว้แล้วค้างเกินกี่นาที ถือว่าเครื่องนั้นตาย เอากลับเข้าคิว
  staleClaimMinutes: num(process.env.STALE_CLAIM_MINUTES, 10),

  nc: {
    base: (process.env.NC_BASE || '').replace(/\/$/, ''),
    token: process.env.NC_SHARE_TOKEN || '',
    password: process.env.NC_SHARE_PASSWORD || '',
    root: (process.env.NC_ROOT || 'photobooth').replace(/^\/|\/$/g, ''),
  },
};

export const paths = {
  queue: `${config.nc.root}/_print/queue`,
  claimed: `${config.nc.root}/_print/claimed`,
  done: `${config.nc.root}/_print/done`,
  failed: `${config.nc.root}/_print/failed`,
  review: `${config.nc.root}/_print/review`,
};
