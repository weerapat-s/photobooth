import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config as serverConfig } from '../server/config.js';

const execFileAsync = promisify(execFile);

async function runSecurityTest() {
  console.log('--- STARTING PHASE 1 SECURITY TEST ---');

  // 1. Host binding checks
  assert(
    ['127.0.0.1', '0.0.0.0'].includes(serverConfig.host),
    'Server host must be loopback or an explicit all-interface LAN bridge binding',
  );
  console.log('Host binding config assertions passed.');

  // 2. ไฟล์ตัวอย่างและเอกสารต้องไม่มีความลับติดไปด้วย
  const packScript = path.join(process.cwd(), 'launch', 'pack-photobooth.js');
  await execFileAsync('node', [packScript]);

  const trackedExamples = [path.join(process.cwd(), '.env.example')];
  const packedEnvExample = path.join(process.cwd(), 'dist', 'photobooth', '.env.example');
  if (fs.existsSync(packedEnvExample)) trackedExamples.push(packedEnvExample);
  for (const file of trackedExamples) {
    const text = fs.readFileSync(file, 'utf8');
    const token = (text.match(/^NC_SHARE_TOKEN=([^#\r\n]*)/m) || [])[1]?.trim() || '';
    assert(!/^[A-Za-z0-9]{10,}$/.test(token), `${path.relative(process.cwd(), file)} contains a token-shaped secret`);
  }
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert(!/\/s\/[A-Za-z0-9]{10,}/.test(readme), 'README must not contain a live share URL');
  console.log('Secret redaction check passed.');

  console.log('--- PHASE 1 SECURITY TEST PASSED SUCCESSFULLY ---');
}

runSecurityTest().catch((err) => {
  console.error('SECURITY TEST FAILED:', err);
  process.exit(1);
});
