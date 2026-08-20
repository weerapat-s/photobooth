import sharp from 'sharp';
import QRCode from 'qrcode';
import { config } from './config.js';

export async function generateCalibrationSheet(layout = 'strip2x6') {
  const isGrid = layout === 'grid4x6';
  const dpi = config.printDpi;
  const width = Math.round((isGrid ? 4 : 2) * dpi);
  const height = Math.round(6 * dpi);

  const qrBuf = await QRCode.toBuffer('CALIBRATION-TEST-CARD', { width: Math.round(dpi * 0.8) });

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#ffffff"/>
      
      <!-- Outer Border / Crop Lines -->
      <rect x="2" y="2" width="${width - 4}" height="${height - 4}" stroke="#000000" stroke-width="2" fill="none"/>
      
      <!-- Safe Area (0.125 inch margin) -->
      <rect x="${Math.round(dpi * 0.125)}" y="${Math.round(dpi * 0.125)}" 
            width="${width - Math.round(dpi * 0.25)}" height="${height - Math.round(dpi * 0.25)}" 
            stroke="#ff0000" stroke-width="2" stroke-dasharray="8 4" fill="none"/>

      <!-- Center Crosshairs -->
      <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" stroke="#0000ff" stroke-width="1"/>
      <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="#0000ff" stroke-width="1"/>

      <!-- Color Swatches -->
      <rect x="${Math.round(dpi * 0.2)}" y="${Math.round(dpi * 0.2)}" width="${Math.round(dpi * 0.4)}" height="${Math.round(dpi * 0.4)}" fill="#000000"/>
      <rect x="${Math.round(dpi * 0.7)}" y="${Math.round(dpi * 0.2)}" width="${Math.round(dpi * 0.4)}" height="${Math.round(dpi * 0.4)}" fill="#808080"/>
      <rect x="${Math.round(dpi * 1.2)}" y="${Math.round(dpi * 0.2)}" width="${Math.round(dpi * 0.4)}" height="${Math.round(dpi * 0.4)}" fill="#ffffff" stroke="#000000"/>

      <text x="${width / 2}" y="${height * 0.75}" font-family="sans-serif" font-size="${Math.round(dpi * 0.2)}" font-weight="bold" text-anchor="middle" fill="#000000">
        ${layout.toUpperCase()} CALIBRATION
      </text>
      <text x="${width / 2}" y="${height * 0.82}" font-family="sans-serif" font-size="${Math.round(dpi * 0.12)}" text-anchor="middle" fill="#666666">
        Blue: Center | Red Dash: Safe Area (1/8 in)
      </text>
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .composite([{ input: qrBuf, left: Math.round(width / 2 - dpi * 0.4), top: Math.round(height * 0.45) }])
    .jpeg({ quality: 95 })
    .toBuffer();
}
