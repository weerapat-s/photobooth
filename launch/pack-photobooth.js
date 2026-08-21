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
const packageName = 'photobooth-windows-setup';
const zip = path.join(dist, `${packageName}.zip`);
const skipNames = new Set(['.git', '.env', 'node_modules', 'logs', 'sessions', 'dist', '.DS_Store']);
const skipRoots = new Set(['ipad']);

function allowed(source) {
  const relative = path.relative(root, source);
  const parts = relative.split(path.sep);
  if (parts.some((part) => skipNames.has(part))) return false;
  if (parts.length && skipRoots.has(parts[0])) return false;
  return true;
}

await fsp.mkdir(dist, { recursive: true });
await fsp.rm(zip, { force: true });
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'photobooth-pack-'));
const stage = path.join(tempRoot, packageName);
await fsp.cp(root, stage, { recursive: true, filter: allowed });

const deployDir = path.join(stage, 'deploy', 'windows');
for (const name of ['INSTALL.cmd', 'INSTALL.ps1', 'README-INSTALL.txt']) {
  await fsp.copyFile(path.join(deployDir, name), path.join(stage, name));
}
await fsp.rm(path.join(stage, 'deploy'), { recursive: true, force: true });

const forbidden = [];
for (const relative of ['.env', 'logs', 'sessions', 'node_modules', '.git', 'ipad']) {
  if (fs.existsSync(path.join(stage, relative))) forbidden.push(relative);
}
if (forbidden.length) throw new Error(`unsafe paths in package: ${forbidden.join(', ')}`);

await execFileAsync('powershell.exe', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${stage.replaceAll("'", "''")}\\*' -DestinationPath '${zip.replaceAll("'", "''")}' -CompressionLevel Optimal -Force`,
], { windowsHide: true, timeout: 120000 });

const hash = createHash('sha256').update(await fsp.readFile(zip)).digest('hex');
await fsp.writeFile(`${zip}.sha256.txt`, `${hash}  ${path.basename(zip)}\r\n`, 'utf8');
await fsp.rm(tempRoot, { recursive: true, force: true });
console.log(zip);
console.log(`SHA256 ${hash}`);
