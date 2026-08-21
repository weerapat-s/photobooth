import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dirs = new Set();
const files = new Map();
const modified = new Map();

const clean = (value) => decodeURIComponent(value || '').replace(/^\/+|\/+$/g, '');
const davPath = (url) => clean(new URL(url, 'http://localhost').pathname.replace(/^\/public\.php\/webdav\/?/, ''));
const href = (key) => `/public.php/webdav/${key.split('/').map(encodeURIComponent).join('/')}`;

function xmlEntry(key, isDir, size = 0) {
  return `<d:response><d:href>${href(key)}${isDir ? '/' : ''}</d:href><d:propstat><d:prop>`
    + `<d:getcontentlength>${size}</d:getcontentlength>`
    + `<d:getlastmodified>${modified.get(key) || new Date().toUTCString()}</d:getlastmodified>`
    + `<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>`
    + `</d:prop></d:propstat></d:response>`;
}

const davServer = http.createServer(async (req, res) => {
  const key = davPath(req.url);
  if (req.method === 'MKCOL') {
    const existed = dirs.has(key);
    dirs.add(key);
    modified.set(key, new Date().toUTCString());
    res.writeHead(existed ? 405 : 201).end();
    return;
  }
  if (req.method === 'PROPFIND') {
    if (!dirs.has(key)) return res.writeHead(404).end();
    const children = [];
    for (const dir of dirs) if (dir !== key && path.posix.dirname(dir) === key) children.push(xmlEntry(dir, true));
    for (const [file, body] of files) if (path.posix.dirname(file) === key) children.push(xmlEntry(file, false, body.length));
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xmlEntry(key, true)}${children.join('')}</d:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml' }).end(xml);
    return;
  }
  if (req.method === 'GET') {
    if (!files.has(key)) return res.writeHead(404).end();
    res.writeHead(200).end(files.get(key));
    return;
  }
  if (req.method === 'PUT') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const existed = files.has(key);
    files.set(key, Buffer.concat(chunks));
    modified.set(key, new Date().toUTCString());
    res.writeHead(existed ? 204 : 201).end();
    return;
  }
  if (req.method === 'MOVE') {
    if (!files.has(key)) return res.writeHead(404).end();
    const destination = davPath(req.headers.destination);
    if (req.headers.overwrite === 'F' && files.has(destination)) return res.writeHead(412).end();
    files.set(destination, files.get(key));
    modified.set(destination, new Date().toUTCString());
    files.delete(key);
    modified.delete(key);
    res.writeHead(201).end();
    return;
  }
  res.writeHead(405).end();
});

await new Promise((resolve) => davServer.listen(0, '127.0.0.1', resolve));
const davPort = davServer.address().port;
for (const dir of ['photobooth', 'photobooth/_print', 'photobooth/_print/queue', 'photobooth/test-session']) dirs.add(dir);

const image = await sharp({ create: { width: 600, height: 1800, channels: 3, background: '#55aacc' } }).jpeg().toBuffer();
files.set('photobooth/test-session/print.jpg', image);
const queueName = 'Q0001__test-session__1.json';
const job = {
  jobId: 'test-print-job',
  sessionId: 'test-session',
  queueNumber: 1,
  booth: 'test-booth',
  copies: 1,
  printFile: 'photobooth/test-session/print.jpg',
  layout: 'strip2x6',
  paper: '2x6',
  checksumSha256: createHash('sha256').update(image).digest('hex'),
  retryCount: 0,
  status: 'queued',
};
files.set(`photobooth/_print/queue/${queueName}`, Buffer.from(JSON.stringify(job)));

const child = spawn(process.execPath, ['printbooth/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PRINT_HOST: '127.0.0.1',
    PRINT_PORT: '48821',
    BOARD_HOST: '127.0.0.1',
    BOARD_PORT: '48822',
    AUTO_PRINT: 'true',
    DRY_RUN: 'true',
    POLL_SECONDS: '0.2',
    PAPER: '2x6',
    PRINTER_NAME: '',
    NC_BASE: `http://127.0.0.1:${davPort}`,
    NC_SHARE_TOKEN: 'test-only',
    NC_SHARE_PASSWORD: '',
    NC_ROOT: 'photobooth',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  const donePrefix = 'photobooth/_print/done/';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && ![...files.keys()].some((key) => key.startsWith(donePrefix))) await sleep(100);
  const doneKey = [...files.keys()].find((key) => key.startsWith(donePrefix));
  assert(doneKey, `print job did not reach done:\n${output}`);
  const completed = JSON.parse(files.get(doneKey).toString('utf8'));
  assert.strictEqual(completed.status, 'done');
  assert(![...files.keys()].some((key) => key.includes('/claimed/')), 'claimed job must not remain after completion');
} finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
  await new Promise((resolve) => davServer.close(resolve));
}

console.log('Printbooth queue → claimed → dry-run → done flow passed.');
