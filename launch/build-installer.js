/**
 * สร้าง dist/PhotoBoothSetup.exe — ตัวติดตั้งไฟล์เดียว กดครั้งเดียวจบ
 *
 * ในไฟล์ exe มี: โค้ดโปรแกรม + node_modules + node.exe + เทมเพลตการ์ด + ค่าตั้งต้นของ NAS
 * เครื่องปลายทางจึงไม่ต้องมี Node.js หรืออินเทอร์เน็ต ยกเว้นตอนโหลด digiCamControl
 *
 * ค่า NAS มาจาก .env ของเครื่องนี้ ซึ่งรวม NC_APP_PASSWORD ด้วย — ดูคำเตือนตอนท้ายที่พิมพ์ออกมา
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const deploy = path.join(root, 'deploy', 'windows');
const exeName = 'PhotoBoothSetup.exe';

// ── ไฟล์ที่ไม่เอาเข้าชุด ─────────────────────────────────────────────────────
// .env ของเครื่องนี้ไม่เอาไปตรง ๆ (มีโทเคน iPad เฉพาะเครื่อง) แต่จะสร้าง env.template แทน
// ตัดเฉพาะโฟลเดอร์ระดับบนสุดเท่านั้น ห้ามจับชื่อทุกระดับ ไม่งั้นจะไปโดนของใน node_modules ด้วย
// (เคยพลาดมาแล้ว: ชื่อ dist ไปตัด node_modules/type-is/node_modules/content-type/dist ทิ้ง แล้ว express พัง)
const skipRoots = new Set(['.git', 'logs', 'sessions', 'dist', 'tests', 'ipad', 'deploy']);
const skipAnywhere = new Set(['.env', '.DS_Store']);

function allowed(source) {
  const parts = path.relative(root, source).split(path.sep);
  if (!parts.length || parts[0] === '') return true;
  if (skipRoots.has(parts[0])) return false;
  return !skipAnywhere.has(parts[parts.length - 1]);
}

/** ค่าที่ต้องมีถึงจะ "ติดตั้งแล้วใช้ได้เลย" — ขาดข้อไหนแปลว่าชุดที่ได้จะใช้ไม่ครบ */
const REQUIRED_ENV = ['NC_BASE', 'NC_SHARE_TOKEN', 'NC_ROOT', 'NC_USER', 'NC_APP_PASSWORD', 'CARD_TEMPLATE'];
/** ค่าที่ต้องไม่ติดไปกับชุด เพราะต้องเป็นของใครของมันในแต่ละเครื่อง */
const PER_MACHINE_ENV = ['IPAD_API_TOKEN', 'WEB_PAIR_CODE', 'BOOTH_NAME'];

function buildEnvTemplate() {
  const source = fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/);
  const seen = new Set();
  const out = source.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    seen.add(key);
    if (PER_MACHINE_ENV.includes(key)) return `${key}=`;
    if (key === 'CAPTURE_SOURCE') return 'CAPTURE_SOURCE=digicam';
    if (key === 'BYPASS_CAMERA') return 'BYPASS_CAMERA=false';
    return line;
  });
  const missing = REQUIRED_ENV.filter((name) => !seen.has(name));
  if (missing.length) throw new Error(`.env ของเครื่องนี้ยังไม่มีค่า: ${missing.join(', ')}`);
  return out.join('\r\n');
}

async function findNodeExe() {
  // ใช้ node.exe ตัวที่กำลังรันสคริปต์นี้ เพราะรู้แน่ว่าใช้กับ node_modules ชุดนี้ได้
  const exe = process.execPath;
  const { stdout } = await execFileAsync(exe, ['-p', 'process.platform + " " + process.arch']);
  const [platform, arch] = stdout.trim().split(' ');
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`ต้อง build บน Windows x64 เท่านั้น (เครื่องนี้ ${platform} ${arch})`);
  }
  return exe;
}

// ── เตรียมโฟลเดอร์ชั่วคราว ───────────────────────────────────────────────────
await fsp.mkdir(dist, { recursive: true });
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'photobooth-installer-'));
const stage = path.join(tempRoot, 'stage');
const app = path.join(stage, 'app');

console.log('คัดลอกโค้ดและ dependency...');
await fsp.cp(root, app, { recursive: true, filter: allowed });

const guard = ['.env', 'logs', 'sessions', '.git', 'ipad'].filter((rel) => fs.existsSync(path.join(app, rel)));
if (guard.length) throw new Error(`มีไฟล์ที่ไม่ควรติดไปในชุด: ${guard.join(', ')}`);
if (!fs.existsSync(path.join(app, 'node_modules', 'sharp'))) {
  throw new Error('ไม่พบ node_modules/sharp — รัน npm install ก่อน build');
}

console.log('ใส่ Node.js runtime...');
const nodeExe = await findNodeExe();
await fsp.mkdir(path.join(app, 'runtime'), { recursive: true });
await fsp.copyFile(nodeExe, path.join(app, 'runtime', 'node.exe'));

// เช็คว่าชุดที่ประกอบเสร็จโหลดได้จริง ก่อนเอาไปยัดลง exe
// ตัวกรองไฟล์พลาดทีเดียวก็ทำให้ dependency หายไปเงียบ ๆ แล้วไปพังที่เครื่องปลายทาง
console.log('ตรวจว่าชุดที่ได้โหลดได้จริง...');
await execFileAsync(path.join(app, 'runtime', 'node.exe'), [
  '--input-type=module', '-e',
  "await import('express'); await import('sharp'); await import('chokidar'); await import('qrcode');" +
  " await import('./server/template.js'); await import('./server/compose.js'); await import('./server/nextcloud.js');",
], { cwd: app, windowsHide: true, timeout: 120000 });

console.log('เตรียมค่าตั้งต้น...');
await fsp.writeFile(path.join(stage, 'env.template'), buildEnvTemplate(), 'utf8');
await fsp.copyFile(path.join(deploy, 'setup.ps1'), path.join(stage, 'setup.ps1'));
await fsp.copyFile(path.join(deploy, 'README-INSTALL.txt'), path.join(stage, 'README-INSTALL.txt'));

const packagesDir = path.join(deploy, 'packages');
if (fs.existsSync(packagesDir)) {
  const stagePackages = path.join(stage, 'packages');
  await fsp.mkdir(stagePackages, { recursive: true });
  console.log('ใส่แพ็กเกจติดตั้งโปรแกรมเสริม (digiCamControl / cloudflared)...');
  await fsp.cp(packagesDir, stagePackages, { recursive: true });
}

// ── รวมเป็น zip ──────────────────────────────────────────────────────────────
console.log('บีบอัด...');
const payload = path.join(tempRoot, 'payload.zip');
const q = (value) => value.replaceAll("'", "''");
await execFileAsync('powershell.exe', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${q(stage)}\\*' -DestinationPath '${q(payload)}' -CompressionLevel Optimal -Force`,
], { windowsHide: true, timeout: 600000, maxBuffer: 32 * 1024 * 1024 });

// ── คอมไพล์เป็น exe ──────────────────────────────────────────────────────────
console.log('สร้าง exe...');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) throw new Error(`ไม่พบ C# compiler ที่ ${csc}`);

const exePath = path.join(dist, exeName);
await fsp.rm(exePath, { force: true });
const icon = path.join(root, 'assets', 'icons', 'booth.ico');
const args = [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  '/codepage:65001',
  '/r:System.IO.Compression.FileSystem.dll',
  `/resource:${payload},payload.zip`,
  `/win32manifest:${path.join(deploy, 'Setup.manifest')}`,
  `/out:${exePath}`,
];
if (fs.existsSync(icon)) args.push(`/win32icon:${icon}`);
args.push(path.join(deploy, 'Setup.cs'));

const { stdout: cscOut } = await execFileAsync(csc, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (cscOut.trim()) console.log(cscOut.trim());
if (!fs.existsSync(exePath)) throw new Error('คอมไพล์แล้วไม่ได้ไฟล์ exe');

const bytes = await fsp.readFile(exePath);
const hash = createHash('sha256').update(bytes).digest('hex');
await fsp.writeFile(`${exePath}.sha256.txt`, `${hash}  ${exeName}\r\n`, 'utf8');
await fsp.rm(tempRoot, { recursive: true, force: true });

// ── สร้าง ZIP รวมทุกโปรแกรม (Complete Suite) ─────────────────────────────────
const suiteZip = path.join(dist, 'PhotoBooth-Complete-Suite.zip');
console.log('สร้างชุด ZIP รวมทุกโปรแกรม (Complete Suite)...');
const suiteDir = path.join(os.tmpdir(), 'photobooth-suite-' + Date.now());
await fsp.mkdir(suiteDir, { recursive: true });
await fsp.copyFile(exePath, path.join(suiteDir, exeName));
await fsp.copyFile(`${exePath}.sha256.txt`, path.join(suiteDir, `${exeName}.sha256.txt`));
await fsp.copyFile(path.join(deploy, 'README-INSTALL.txt'), path.join(suiteDir, 'README-INSTALL.txt'));
if (fs.existsSync(packagesDir)) {
  const standalonePackages = path.join(suiteDir, 'standalone-installers');
  await fsp.mkdir(standalonePackages, { recursive: true });
  await fsp.cp(packagesDir, standalonePackages, { recursive: true });
}
await execFileAsync('powershell.exe', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${q(suiteDir)}\\*' -DestinationPath '${q(suiteZip)}' -CompressionLevel Optimal -Force`,
], { windowsHide: true, timeout: 600000 });
await fsp.rm(suiteDir, { recursive: true, force: true });
const suiteBytes = await fsp.readFile(suiteZip);
const suiteHash = createHash('sha256').update(suiteBytes).digest('hex');
await fsp.writeFile(`${suiteZip}.sha256.txt`, `${suiteHash}  PhotoBooth-Complete-Suite.zip\r\n`, 'utf8');

console.log('');
console.log(exePath);
console.log(`ขนาด ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`SHA256 ${hash}`);
console.log('');
console.log(suiteZip);
console.log(`ขนาด ${(suiteBytes.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`SHA256 ${suiteHash}`);
console.log('');
console.log('ระวัง: ในไฟล์นี้มี NC_APP_PASSWORD ของ Nextcloud อยู่ ใครได้ไฟล์ไปก็เขียนลง NAS ได้');
console.log('       แจกเฉพาะเครื่องบูทของงาน และถ้าไฟล์หลุด ให้ถอน app password ตัวนั้นใน Nextcloud');

