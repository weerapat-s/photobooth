import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { config as serverConfig } from '../server/config.js';

async function runSecurityTest() {
  console.log('--- STARTING PHASE 1 SECURITY TEST ---');

  // 1. Host binding checks
  assert(
    ['127.0.0.1', '0.0.0.0'].includes(serverConfig.host),
    'Server host must be loopback or an explicit all-interface LAN bridge binding',
  );
  console.log('Host binding config assertions passed.');

  // 2. ไฟล์ตัวอย่างและเอกสารต้องไม่มีความลับติดไปด้วย
  const example = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
  const token = (example.match(/^NC_SHARE_TOKEN=([^#\r\n]*)/m) || [])[1]?.trim() || '';
  assert(!/^[A-Za-z0-9]{10,}$/.test(token), '.env.example contains a token-shaped secret');
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert(!/\/s\/[A-Za-z0-9]{10,}/.test(readme), 'README must not contain a live share URL');
  console.log('Secret redaction check passed.');

  // 3. ตัวติดตั้งฝังค่า NAS ไว้ "โดยตั้งใจ" เพื่อให้กดครั้งเดียวแล้วใช้ได้เลย
  //    จึงต้องกันสองทาง: .env ของเครื่อง build ต้องไม่ติดไปทั้งไฟล์ และ exe ต้องไม่ถูก commit
  const builder = fs.readFileSync(path.join(process.cwd(), 'launch', 'build-installer.js'), 'utf8');
  assert(
    /skipAnywhere\s*=\s*new Set\(\['\.env'/.test(builder),
    'build-installer must exclude .env from the payload',
  );
  const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8').split(/\r?\n/);
  assert(gitignore.includes('dist/'), '.gitignore must keep dist/ (the installer) out of the repository');
  console.log('Installer secret-handling check passed.');

  console.log('--- PHASE 1 SECURITY TEST PASSED SUCCESSFULLY ---');
}

runSecurityTest().catch((err) => {
  console.error('SECURITY TEST FAILED:', err);
  process.exit(1);
});
