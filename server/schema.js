import fs from 'node:fs';
import path from 'node:path';

export function validateConfigPatch(patch) {
  const errors = [];

  for (const [key, val] of Object.entries(patch)) {
    const strVal = String(val);
    if (/[\r\n]/.test(strVal)) {
      errors.push(`ค่า ${key} มีอักขระขึ้นบรรทัดใหม่ (CRLF injection risk)`);
      continue;
    }

    switch (key) {
      case 'SHOTS':
      case 'PRINT_SHOTS': {
        const num = Number(val);
        if (!Number.isInteger(num) || num < 1 || num > 10) {
          errors.push(`${key} ต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 10 (ได้รับ: ${val})`);
        }
        break;
      }
      case 'COUNTDOWN': {
        const num = Number(val);
        if (!Number.isInteger(num) || num < 0 || num > 30) {
          errors.push(`COUNTDOWN ต้องเป็นจำนวนเต็มระหว่าง 0 ถึง 30 (ได้รับ: ${val})`);
        }
        break;
      }
      case 'SHOT_GAP_SECONDS': {
        const num = Number(val);
        if (Number.isNaN(num) || num < 0.5 || num > 10) {
          errors.push(`SHOT_GAP_SECONDS ต้องอยู่ระหว่าง 0.5 ถึง 10 (ได้รับ: ${val})`);
        }
        break;
      }
      case 'SESSION_IDLE_SECONDS':
      case 'REVIEW_SECONDS': {
        const num = Number(val);
        if (!Number.isInteger(num) || num < 5 || num > 600) {
          errors.push(`${key} ต้องอยู่ระหว่าง 5 ถึง 600 วินาที (ได้รับ: ${val})`);
        }
        break;
      }
      case 'PORT':
      case 'PRINT_PORT':
      case 'BOARD_PORT': {
        const num = Number(val);
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          errors.push(`${key} ต้องเป็นหมายเลขพอร์ตระหว่าง 1 ถึง 65535 (ได้รับ: ${val})`);
        }
        break;
      }
      case 'PRINT_LAYOUT': {
        if (!['strip2x6', 'grid4x6'].includes(strVal)) {
          errors.push(`PRINT_LAYOUT ต้องเป็น 'strip2x6' หรือ 'grid4x6' (ได้รับ: ${val})`);
        }
        break;
      }
      case 'CAPTURE_SOURCE': {
        if (!['digicam', 'folder', 'mock', 'ipad', 'web'].includes(strVal)) {
          errors.push(`CAPTURE_SOURCE ต้องเป็น 'digicam', 'folder', 'mock', 'ipad' หรือ 'web' (ได้รับ: ${val})`);
        }
        break;
      }
      case 'WEB_CAMERA_FACING': {
        if (!['user', 'environment'].includes(strVal)) {
          errors.push(`WEB_CAMERA_FACING ต้องเป็น 'user' หรือ 'environment' (ได้รับ: ${val})`);
        }
        break;
      }
      case 'WEB_MIRROR': {
        if (!['true', 'false'].includes(strVal.toLowerCase())) {
          errors.push(`WEB_MIRROR ต้องเป็น true หรือ false (ได้รับ: ${val})`);
        }
        break;
      }
      case 'KIOSK_MODE': {
        if (!['operator', 'self_service'].includes(strVal)) {
          errors.push(`KIOSK_MODE ต้องเป็น 'operator' หรือ 'self_service' (ได้รับ: ${val})`);
        }
        break;
      }
      case 'DCC_TRANSPORT': {
        if (!['auto', 'webserver', 'remotecmd'].includes(strVal)) {
          errors.push(`DCC_TRANSPORT ต้องเป็น 'auto', 'webserver' หรือ 'remotecmd' (ได้รับ: ${val})`);
        }
        break;
      }
      case 'PRINT_ON_DONE': {
        if (!['true', 'false'].includes(strVal.toLowerCase())) {
          errors.push(`PRINT_ON_DONE ต้องเป็น true หรือ false (ได้รับ: ${val})`);
        }
        break;
      }
      case 'PRINT_THEME_COLOR':
      case 'PRINT_FRAME_COLOR':
      case 'GRID_BG_COLOR':
      case 'GRID_ACCENT_COLOR': {
        if (!/^#[0-9A-Fa-f]{6}$/.test(strVal)) {
          errors.push(`${key} ต้องเป็นรหัสสี HEX เช่น #ffffff (ได้รับ: ${val})`);
        }
        break;
      }
      default:
        break;
    }
  }

  return { ok: errors.length === 0, errors };
}

export function saveEnvAtomic(envFilePath, patch) {
  const check = validateConfigPatch(patch);
  if (!check.ok) {
    throw new Error(`การตั้งค่าไม่ถูกต้อง:\n- ${check.errors.join('\n- ')}`);
  }

  let text = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
  for (const [key, value] of Object.entries(patch)) {
    const raw = String(value);
    const serialized = /^-?\d+(\.\d+)?$/.test(raw) || /^(true|false)$/i.test(raw)
      ? raw
      : JSON.stringify(raw);
    const line = `${key}=${serialized}`;
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
    process.env[key] = String(value);
  }

  const tmpFile = `${envFilePath}.tmp`;
  fs.writeFileSync(tmpFile, text, 'utf8');
  fs.renameSync(tmpFile, envFilePath);
}
