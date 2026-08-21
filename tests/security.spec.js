import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config as serverConfig } from '../server/config.js';
import { config as printConfig } from '../printbooth/config.js';

const execFileAsync = promisify(execFile);

async function runSecurityTest() {
  console.log('--- STARTING PHASE 1 SECURITY TEST ---');

  // 1. Host binding checks
  assert(
    ['127.0.0.1', '0.0.0.0'].includes(serverConfig.host),
    'Server host must be loopback or an explicit all-interface LAN bridge binding',
  );
  assert.strictEqual(printConfig.host, '127.0.0.1', 'Printbooth admin host must default to 127.0.0.1');
  assert.strictEqual(printConfig.boardHost, '0.0.0.0', 'Printbooth board host must be 0.0.0.0');
  assert.strictEqual(printConfig.boardPort, 4702, 'Printbooth board port must default to 4702');
  console.log('Host binding config assertions passed.');

  // 2. Test pack-printbooth output
  console.log('Testing pack-printbooth script...');
  const packScript = path.join(process.cwd(), 'launch', 'pack-printbooth.js');
  await execFileAsync('node', [packScript]);

  const packedEnvExample = path.join(process.cwd(), 'dist', 'printbooth', '.env.example');
  assert(fs.existsSync(packedEnvExample), 'Packed .env.example must exist in dist');
  
  const content = fs.readFileSync(packedEnvExample, 'utf8');
  assert(content.includes('NC_SHARE_TOKEN='), 'Packed .env.example must have NC_SHARE_TOKEN key present');
  const trackedExamples = [
    path.join(process.cwd(), '.env.example'),
    path.join(process.cwd(), 'printbooth', '.env.example'),
    packedEnvExample,
  ];
  for (const file of trackedExamples) {
    const text = fs.readFileSync(file, 'utf8');
    const token = (text.match(/^NC_SHARE_TOKEN=([^#\r\n]*)/m) || [])[1]?.trim() || '';
    assert(!/^[A-Za-z0-9]{10,}$/.test(token), `${path.relative(process.cwd(), file)} contains a token-shaped secret`);
  }
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert(!/\/s\/[A-Za-z0-9]{10,}/.test(readme), 'README must not contain a live share URL');
  console.log('Pack-printbooth secret redaction check passed.');

  console.log('--- PHASE 1 SECURITY TEST PASSED SUCCESSFULLY ---');
}

runSecurityTest().catch((err) => {
  console.error('SECURITY TEST FAILED:', err);
  process.exit(1);
});
