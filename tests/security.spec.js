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
  assert.strictEqual(serverConfig.host, '127.0.0.1', 'Server host must default to 127.0.0.1');
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
  assert(!content.includes('mTt85rx6nbb7Wya'), 'Packed .env.example MUST NOT contain hardcoded secret tokens!');
  assert(content.includes('NC_SHARE_TOKEN='), 'Packed .env.example must have NC_SHARE_TOKEN key present');
  console.log('Pack-printbooth secret redaction check passed.');

  console.log('--- PHASE 1 SECURITY TEST PASSED SUCCESSFULLY ---');
}

runSecurityTest().catch((err) => {
  console.error('SECURITY TEST FAILED:', err);
  process.exit(1);
});
