import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { composePrint, makePreview } from '../server/compose.js';
import { makeVideoFromFrames } from '../server/video.js';
import { config, ROOT } from '../server/config.js';

const execFileAsync = promisify(execFile);

async function runBaselineTest() {
  console.log('--- STARTING BASELINE TEST ---');
  const testDir = path.join(config.sessionsDir, 'test-baseline-session');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  // 1. Generate 4 mock JPEG photos
  const photoPaths = [];
  const colors = [
    { r: 255, g: 100, b: 100 },
    { r: 100, g: 255, b: 100 },
    { r: 100, g: 100, b: 255 },
    { r: 255, g: 255, b: 100 },
  ];

  for (let i = 0; i < 4; i++) {
    const photoPath = path.join(testDir, `photo-${i + 1}.jpg`);
    await sharp({
      create: {
        width: 1920,
        height: 1280,
        channels: 3,
        background: colors[i],
      },
    })
      .jpeg()
      .toFile(photoPath);
    photoPaths.push(photoPath);
    console.log(`Created mock photo: ${photoPath}`);
  }

  // 2. Test strip2x6 composition
  config.printLayout = 'strip2x6';
  const stripRes = await composePrint(photoPaths, testDir, {
    title: 'Baseline Strip',
    subtitle: 'Test Subtitle',
  });
  assert(fs.existsSync(stripRes.card), 'Strip card.jpg must exist');
  assert(fs.existsSync(stripRes.print), 'Strip print.jpg must exist');
  console.log('Strip2x6 compose passed.');

  // 3. Test grid4x6 composition
  const gridDir = path.join(testDir, 'grid');
  fs.mkdirSync(gridDir, { recursive: true });
  config.printLayout = 'grid4x6';
  const gridRes = await composePrint(photoPaths, gridDir, {
    title: 'Baseline Grid',
    subtitle: 'Test Subtitle',
  });
  assert(fs.existsSync(gridRes.card), 'Grid card.jpg must exist');
  assert(fs.existsSync(gridRes.print), 'Grid print.jpg must exist');
  console.log('Grid4x6 compose passed.');

  // 4. Test preview creation
  const previewPath = await makePreview(photoPaths[0], testDir, 'preview-1.jpg');
  assert(fs.existsSync(previewPath), 'Preview file must exist');
  console.log('Preview creation passed.');

  // 5. Test MP4/GIF generation
  if (fs.existsSync(config.ffmpeg)) {
    console.log(`ffmpeg found at ${config.ffmpeg}, testing video creation...`);
    const videoRes = await makeVideoFromFrames(photoPaths, testDir);
    assert(fs.existsSync(videoRes.mp4), 'video.mp4 must exist');
    assert(fs.existsSync(videoRes.gif), 'video.gif must exist');
    console.log('Video generation (MP4/GIF) passed.');
  } else {
    console.log(`ffmpeg not found at ${config.ffmpeg}, skipping video generation in mock baseline.`);
  }

  // 6. Test QR Code generation
  const qrPath = path.join(testDir, 'qr.png');
  await QRCode.toFile(qrPath, 'https://example.com/mock-session');
  assert(fs.existsSync(qrPath), 'QR Code file must exist');
  console.log('QR Code generation passed.');

  // 7. Test Print Dry-Run via PowerShell
  const psScript = path.join(ROOT, 'printbooth', 'print.ps1');
  if (fs.existsSync(psScript)) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          psScript,
          '-ImagePath',
          stripRes.print,
          '-Paper',
          '4x6',
          '-DryRun',
        ],
        { timeout: 15000 }
      );
      assert(stdout.toLowerCase().includes('dry-run'), 'Powershell print script dry run output must include dry-run');
      console.log('Print PowerShell script dry-run passed.');
    } catch (err) {
      throw new Error(`PowerShell print dry-run failed: ${err.message}`);
    }
  }

  // Clean up test directory
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('--- BASELINE TEST PASSED SUCCESSFULLY ---');
}

runBaselineTest().catch((err) => {
  console.error('BASELINE TEST FAILED:', err);
  process.exit(1);
});
