// Аватары, баннеры, иконки серверов: кадрирование и сжатие через ffmpeg (SPEC-v3 §2.2).
// Без ffmpeg (dev/CI) файл сохраняется как есть, без обрезки.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { HttpError } from './auth.js';

export const MEDIA_KINDS = {
  avatar: { dir: 'avatars', w: 256, h: 256, maxBytes: 10 * 1024 * 1024 },
  icon: { dir: 'icons', w: 256, h: 256, maxBytes: 10 * 1024 * 1024 },
  banner: { dir: 'banners', w: 960, h: 340, maxBytes: 15 * 1024 * 1024 },
};
export const MEDIA_DIRS = ['avatars', 'banners', 'icons'];
const ANIM_MAX_BYTES = 4 * 1024 * 1024;
const ANIM_MAX_SECONDS = 15;
const ANIM_MAX_FPS = 60;
const FF_TIMEOUT_MS = 90_000;

let mediaRoot = null;
export function initMedia(dataDir) {
  mediaRoot = path.join(dataDir, 'media');
  for (const d of [...MEDIA_DIRS, '.tmp']) fs.mkdirSync(path.join(mediaRoot, d), { recursive: true });
  // хвосты прерванных загрузок
  for (const f of fs.readdirSync(path.join(mediaRoot, '.tmp'))) fs.rmSync(path.join(mediaRoot, '.tmp', f), { force: true, recursive: true });
  return mediaRoot;
}
export const getMediaRoot = () => mediaRoot;
export const mediaTmpDir = () => path.join(mediaRoot, '.tmp');

// ---------------------------------------------------------------- ffmpeg --
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
let caps = null;
export function ffmpegCaps() {
  if (caps) return caps;
  caps = { ffmpeg: false, webp: false, webpAnim: false };
  if (['1', 'true', 'yes'].includes(String(process.env.SOZVON_NO_FFMPEG).toLowerCase())) return caps;
  try {
    const v = spawnSync(FFMPEG, ['-hide_banner', '-version'], { timeout: 5000 });
    const p = spawnSync(FFPROBE, ['-hide_banner', '-version'], { timeout: 5000 });
    if (v.status !== 0 || p.status !== 0) return caps;
    const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { timeout: 5000, encoding: 'utf8' }).stdout || '';
    caps = { ffmpeg: true, webp: /\slibwebp\s/.test(enc), webpAnim: /\slibwebp_anim\s/.test(enc) };
  } catch { /* нет ffmpeg */ }
  return caps;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 1e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e4) err = err.slice(-2e4); });
    const t = setTimeout(() => p.kill('SIGKILL'), FF_TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

// не больше 2 тяжёлых преобразований одновременно
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 2) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

// --------------------------------------------------------- тип по байтам --
/** {ext, mime, maybeAnimated} по сигнатуре; null — не картинка из списка. */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    // APNG: чанк acTL до первого IDAT
    let off = 8, anim = false;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      if (type === 'acTL') { anim = true; break; }
      if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len;
    }
    return { ext: 'png', mime: anim ? 'image/apng' : 'image/png', maybeAnimated: anim };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', maybeAnimated: false };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    // больше одного блока Graphic Control / изображения — анимация (точно считает ffprobe)
    let frames = 0;
    for (let i = 0; i < buf.length - 1 && frames < 2; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xf9) frames++;
    return { ext: 'gif', mime: 'image/gif', maybeAnimated: frames > 1 };
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const anim = buf.toString('latin1', 12, 16) === 'VP8X' && (buf[20] & 0x02) === 0x02;
    return { ext: 'webp', mime: 'image/webp', maybeAnimated: anim };
  }
  return null;
}

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=width,height,nb_read_packets,avg_frame_rate,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out);
  const st = j.streams?.[0] || {};
  const rate = (s) => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : 0; };
  return {
    width: Number(st.width) || 0, height: Number(st.height) || 0,
    frames: Number(st.nb_read_packets) || 0,
    fps: rate(st.avg_frame_rate) || rate(st.r_frame_rate) || 0,
    duration: Number(j.format?.duration) || 0,
  };
}

/** Прямоугольник кадрирования с нужными пропорциями, внутри картинки. */
export function cropRect(srcW, srcH, outW, outH, req) {
  const aspect = outW / outH;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  let w = num(req?.width) ?? num(req?.size);
  let x = num(req?.x), y = num(req?.y);
  if (w !== null && w > 0) {
    w = Math.min(w, srcW, srcH * aspect);
  } else {
    w = Math.min(srcW, srcH * aspect);
    x = null; y = null;
  }
  let h = w / aspect;
  w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.min(srcH, Math.floor(h)));
  if (x === null || y === null) { x = (srcW - w) / 2; y = (srcH - h) / 2; }
  x = Math.max(0, Math.min(srcW - w, Math.floor(x)));
  y = Math.max(0, Math.min(srcH - h, Math.floor(y)));
  return { x, y, w, h };
}

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

function place(tmpFile, dir, prefix, suffix, ext) {
  const name = `${prefix}-${hashFile(tmpFile)}${suffix}.${ext}`;
  const dest = path.join(mediaRoot, dir, name);
  fs.renameSync(tmpFile, dest);
  fs.chmodSync(dest, 0o644);
  return `/media/${dir}/${name}`;
}

// Формат анимированной версии: gif (по умолчанию — читается везде, в т.ч. ffprobe) или webp
const ANIM_FORMAT = String(process.env.SOZVON_ANIM_FORMAT || 'gif').toLowerCase() === 'webp' ? 'webp' : 'gif';

async function encodeAnimated(input, filterBase, info, out, cfg, c) {
  const srcFps = info.fps > 0 && info.fps < 1000 ? info.fps : 25;
  const useWebp = ANIM_FORMAT === 'webp' && c.webpAnim;
  const ladder = [
    { fps: Math.min(srcFps, ANIM_MAX_FPS), q: 80, colors: 256, scale: 1 },
    { fps: Math.min(srcFps, 30), q: 70, colors: 192, scale: 1 },
    { fps: Math.min(srcFps, 20), q: 60, colors: 128, scale: 1 },
    { fps: Math.min(srcFps, 15), q: 50, colors: 64, scale: 1 },
    { fps: Math.min(srcFps, 12), q: 45, colors: 64, scale: 0.75 },
    { fps: Math.min(srcFps, 10), q: 40, colors: 32, scale: 0.5 },
  ];
  const palette = `${out}.palette.png`;
  try {
    for (const step of ladder) {
      const W = Math.max(2, Math.round(cfg.w * step.scale / 2) * 2), H = Math.max(2, Math.round(cfg.h * step.scale / 2) * 2);
      const fpsF = step.fps < srcFps - 0.01 ? `,fps=${Math.round(step.fps * 100) / 100}` : '';
      const base = `${filterBase},scale=${W}:${H}:flags=lanczos${fpsF}`;
      const head = ['-hide_banner', '-v', 'error', '-y', '-t', String(ANIM_MAX_SECONDS), '-i', input];
      if (useWebp) {
        await run(FFMPEG, [...head, '-an', '-vf', base, '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', String(step.q),
          '-compression_level', '4', '-loop', '0', '-f', 'webp', out]);
      } else {
        // два прохода (палитра отдельно): split+palettegen держит в памяти все кадры
        await run(FFMPEG, [...head, '-an', '-vf', `${base},palettegen=max_colors=${step.colors}:stats_mode=diff`, '-frames:v', '1', '-update', '1', palette]);
        await run(FFMPEG, [...head, '-i', palette, '-an', '-lavfi', `[0:v]${base}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
          '-loop', '0', '-f', 'gif', out]);
      }
      if (fs.statSync(out).size <= ANIM_MAX_BYTES) return useWebp ? 'webp' : 'gif';
    }
  } finally {
    fs.rmSync(palette, { force: true });
  }
  throw new HttpError(400, 'Анимация слишком большая даже после сжатия (максимум 4 МБ) — возьмите файл покороче');
}

/**
 * Обработать загруженный файл. Возвращает { url, animatedUrl|null, processed:boolean }.
 * kind: 'avatar' | 'banner' | 'icon'; prefix — id владельца (пользователя/сервера).
 */
export async function processImage(file, { kind, prefix, crop }) {
  const cfg = MEDIA_KINDS[kind];
  const head = fs.readFileSync(file.path);
  const type = sniffImage(head);
  if (!type) throw new HttpError(400, 'Поддерживаются изображения PNG, JPG, WebP и GIF');
  const c = ffmpegCaps();
  const tmpBase = path.join(mediaTmpDir(), crypto.randomBytes(8).toString('hex'));

  const asIs = () => {
    const tmp = `${tmpBase}.${type.ext}`;
    fs.copyFileSync(file.path, tmp);
    const url = place(tmp, cfg.dir, prefix, type.maybeAnimated ? '-a' : '', type.ext);
    return { url, animatedUrl: type.maybeAnimated ? url : null, processed: false };
  };
  if (!c.ffmpeg) return asIs();

  return limited(async () => {
    let info;
    try { info = await probe(file.path); } catch (err) {
      // ffmpeg 6 не декодирует анимированный WebP — сохраняем как есть, честно
      if (type.ext === 'webp' && type.maybeAnimated) return asIs();
      console.error('[media] ffprobe:', err.message);
      throw new HttpError(400, 'Не удалось прочитать изображение');
    }
    if (!info.width || !info.height) {
      if (type.ext === 'webp' && type.maybeAnimated) return asIs();
      throw new HttpError(400, 'Не удалось прочитать изображение');
    }
    const r = cropRect(info.width, info.height, cfg.w, cfg.h, crop);
    const filterBase = `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
    const animated = type.maybeAnimated && info.frames > 1;
    const staticExt = c.webp ? 'webp' : 'png';
    const sOut = `${tmpBase}-s.${staticExt}`;
    const aOut = `${tmpBase}-a.anim`;
    try {
      const sArgs = ['-hide_banner', '-v', 'error', '-y', '-i', file.path, '-vf', `${filterBase},scale=${cfg.w}:${cfg.h}:flags=lanczos`, '-frames:v', '1', '-an'];
      if (c.webp) sArgs.push('-c:v', 'libwebp', '-quality', '88', '-f', 'webp', sOut);
      else sArgs.push('-c:v', 'png', '-f', 'image2', sOut);
      await run(FFMPEG, sArgs);
      const url = place(sOut, cfg.dir, prefix, '', staticExt);
      let animatedUrl = null;
      if (animated) {
        const ext = await encodeAnimated(file.path, filterBase, info, aOut, cfg, c);
        animatedUrl = place(aOut, cfg.dir, prefix, '-a', ext);
      }
      return { url, animatedUrl, processed: true };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (type.ext === 'webp' && type.maybeAnimated) return asIs();
      console.error('[media] ffmpeg:', err.message);
      throw new HttpError(400, 'Не удалось обработать изображение');
    } finally {
      for (const f of [sOut, aOut]) fs.rmSync(f, { force: true });
    }
  });
}

/** Удалить наш медиафайл по url (/media/avatars|banners|icons/<имя>), если на него больше нет ссылок. */
export function removeMediaUrl(url, stillUsed = () => false) {
  if (typeof url !== 'string' || !mediaRoot) return;
  const m = url.match(/^\/media\/(avatars|banners|icons)\/([A-Za-z0-9._-]+)$/);
  if (!m || m[2].startsWith('.')) return;
  if (stillUsed(url)) return;
  try { fs.rmSync(path.join(mediaRoot, m[1], m[2]), { force: true }); } catch (err) { console.error('[media] удаление:', err.message); }
}

/** Проверить, что url — существующий наш файл нужного каталога. */
export function isOwnMediaUrl(url, dirs = MEDIA_DIRS) {
  if (typeof url !== 'string' || !mediaRoot) return false;
  const m = url.match(/^\/media\/(avatars|banners|icons)\/([A-Za-z0-9._-]+)$/);
  return !!m && dirs.includes(m[1]) && !m[2].startsWith('.') && fs.existsSync(path.join(mediaRoot, m[1], m[2]));
}
