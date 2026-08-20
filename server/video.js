import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const MAX_EDGE = 1440;

async function run(args) {
  try {
    await execFileAsync(config.ffmpeg, args, { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  } catch (err) {
    const detail = (err.stderr || err.message || '').split('\n').slice(-4).join(' ').trim();
    throw new Error(`ffmpeg ล้มเหลว: ${detail}`);
  }
}

const even = (n) => (n % 2 === 0 ? n : n + 1);

/** ขนาดวิดีโอตามสัดส่วนภาพจริง ไม่ครอปทิ้ง (ยาวสุด MAX_EDGE) */
async function targetSize(photo) {
  const meta = await sharp(photo).rotate().metadata();
  const w = meta.width || 3000;
  const h = meta.height || 2000;
  const scale = MAX_EDGE / Math.max(w, h);
  return { W: even(Math.round(w * scale)), H: even(Math.round(h * scale)) };
}

/** ครอปเต็มเฟรมตามสัดส่วนภาพจริง (ไม่มีขอบเบลอ ไม่มีแถบดำ) เหมือนบูทถ่ายรูปทั่วไป */
async function renderFrame(src, W, H) {
  return sharp(src)
    .rotate()
    .resize(W, H, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * สไลด์โชว์ตัดสลับตรง ๆ ทีละภาพ (hard cut ไม่มีเฟด ไม่มีซูม ไม่มีไป-กลับ)
 * @returns {{mp4:string, gif:string|null}}
 */
export async function makeVideoFromFrames(photos, outDir) {
  const work = path.join(outDir, '_frames');
  await fsp.mkdir(work, { recursive: true });

  const { W, H } = await targetSize(photos[0]);
  const fps = 25;
  const holdSec = Math.max(0.4, config.videoSeconds / photos.length);
  const framesPerPhoto = Math.max(1, Math.round(holdSec * fps));

  // เขียนไฟล์เฟรมซ้ำแทนพึ่ง fractional framerate — ffmpeg บิลด์เก่าที่มากับ digiCamControl (2015)
  // มีบั๊ก: input framerate ต่ำ ๆ (<1fps) ผสมกับ filter fps= แล้วเฟรมหายไปเงียบ ๆ (duration สั้นกว่าที่ตั้งจริง)
  let idx = 0;
  for (const photo of photos) {
    const buf = await renderFrame(photo, W, H);
    for (let k = 0; k < framesPerPhoto; k++, idx++) {
      await fsp.writeFile(path.join(work, `f${String(idx).padStart(4, '0')}.jpg`), buf);
    }
  }

  const mp4 = path.join(outDir, 'video.mp4');
  await run([
    '-y',
    '-framerate', String(fps),
    '-i', path.join(work, 'f%04d.jpg'),
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart',
    mp4,
  ]);

  const gif = path.join(outDir, 'video.gif');
  const palette = path.join(work, 'palette.png');
  const gifWidth = W >= H ? 640 : 480;
  await run(['-y', '-i', mp4, '-vf', `fps=12,scale=${gifWidth}:-1:flags=lanczos,palettegen`, palette]);
  await run([
    '-y', '-i', mp4, '-i', palette,
    '-filter_complex', `fps=12,scale=${gifWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse`,
    gif,
  ]);

  await fsp.rm(work, { recursive: true, force: true });
  return { mp4, gif };
}

/** แปลงคลิปที่กล้องอัดมาเป็น mp4 พร้อมแชร์ */
export async function normalizeClip(src, outDir) {
  const mp4 = path.join(outDir, 'video.mp4');
  await run([
    '-y', '-i', src,
    '-vf', 'scale=-2:1080,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    mp4,
  ]);
  return { mp4, gif: null };
}
