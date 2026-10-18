// Музыкальная библиотека бота: файлы в data/music, метаданные через music-metadata,
// загрузка файлов, импорт по прямой ссылке или через yt-dlp (если установлен).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import { db, save } from './db.js';
import { HttpError } from './auth.js';

export const MUSIC_MAX_BYTES = 50 * 1024 * 1024;
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm', '.weba', '.mp4']);
const MIME_BY_EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
  'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/webm': '.webm',
};
export const YTDLP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com|soundcloud\.com|vk\.com|vkvideo\.ru|bandcamp\.com|twitch\.tv|rutube\.ru|vimeo\.com|dailymotion\.com|mixcloud\.com)$/i;
// Путь к yt-dlp: env YTDLP_PATH (для тестов — фейковый скрипт), иначе «yt-dlp» из PATH
export const ytdlpPath = () => process.env.YTDLP_PATH || 'yt-dlp';

let musicDir = null;
export function initMusicLibrary(dataDir) {
  musicDir = path.join(dataDir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  return musicDir;
}
export const getMusicDir = () => musicDir;

// ---------- утилиты ----------
function commandExists(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}
let ytdlpCache = null;
let ytdlpCheckedAt = 0;
export function hasYtDlp() {
  // «нет» перепроверяем раз в минуту: yt-dlp могли доустановить без перезапуска
  if (!ytdlpCache && Date.now() - ytdlpCheckedAt > 60_000) {
    ytdlpCache = commandExists(ytdlpPath());
    ytdlpCheckedAt = Date.now();
  }
  return ytdlpCache;
}
let ffmpegCache = null;
export const hasFfmpeg = () => (ffmpegCache ??= commandExists(process.env.FFMPEG_PATH || 'ffmpeg'));

export function sanitizeFileName(name) {
  let base = String(name || '').normalize('NFC');
  base = path.basename(base.replace(/\\/g, '/'));
  base = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+/, '');
  if (!base) base = 'track';
  if (Buffer.byteLength(base) > 180) {
    const ext = path.extname(base).slice(0, 10);
    base = Buffer.from(base).subarray(0, 160).toString('utf8').replace(/�/g, '') + ext;
  }
  return base;
}

export function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
  return candidate;
}

// multer 2 отдаёт originalname в latin1 — восстанавливаем UTF-8
export function fixMulterName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch { return name; }
}

const trackId = (file) => crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);

export function publicTrack(t) {
  return {
    id: t.id, title: t.title, artist: t.artist, duration: t.duration,
    url: '/media/music/' + encodeURIComponent(t.file), addedBy: t.addedBy,
  };
}

async function readMeta(file) {
  const full = path.join(musicDir, file);
  const stem = file.replace(/\.[^.]+$/, '');
  let title = '', artist = '', duration = 0;
  try {
    const meta = await parseFile(full, { duration: true, skipCovers: true });
    title = (meta.common.title || '').trim();
    artist = (meta.common.artist || meta.common.albumartist || '').trim();
    duration = Number.isFinite(meta.format.duration) ? Math.round(meta.format.duration * 10) / 10 : 0;
  } catch { /* битые/неподдерживаемые теги — берём имя файла */ }
  if (!title) {
    // «Исполнитель - Название.mp3»
    const m = stem.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m && !artist) { artist = m[1].trim(); title = m[2].trim(); } else title = stem;
  }
  return { title: title.slice(0, 200), artist: artist.slice(0, 200), duration };
}

// ---------- синхронизация с диском ----------
let syncing = null;
let lastSync = 0;
export function syncLibrary({ force = false } = {}) {
  if (syncing) return syncing;
  if (!force && Date.now() - lastSync < 1500) return Promise.resolve(listTracks());
  syncing = (async () => {
    const entries = await fsp.readdir(musicDir, { withFileTypes: true });
    const present = new Map();
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (!AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const st = await fsp.stat(path.join(musicDir, e.name)).catch(() => null);
      if (st) present.set(e.name, st);
    }
    let changed = false;
    const byFile = new Map(db.data.tracks.map((t) => [t.file, t]));
    for (const [file, st] of present) {
      const known = byFile.get(file);
      if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
      const meta = await readMeta(file);
      if (known) Object.assign(known, meta, { size: st.size, mtimeMs: st.mtimeMs });
      else db.data.tracks.push({ id: trackId(file), file, ...meta, addedBy: null, size: st.size, mtimeMs: st.mtimeMs, createdAt: Date.now() });
      changed = true;
    }
    const before = db.data.tracks.length;
    db.data.tracks = db.data.tracks.filter((t) => present.has(t.file));
    if (db.data.tracks.length !== before) changed = true;
    if (changed) save();
    lastSync = Date.now();
    return listTracks();
  })().finally(() => { syncing = null; });
  return syncing;
}

export const findTrackRec = (id) => db.data.tracks.find((t) => t.id === id) || null;

/** Удалить трек из библиотеки вместе с файлом */
export async function deleteTrack(id) {
  const t = findTrackRec(id);
  if (!t) return null;
  await fsp.rm(path.join(musicDir, path.basename(t.file)), { force: true });
  db.data.tracks = db.data.tracks.filter((x) => x !== t);
  save();
  lastSync = 0;
  return publicTrack(t);
}

export function listTracks() {
  return [...db.data.tracks]
    .sort((a, b) => (a.artist + ' ' + a.title).localeCompare(b.artist + ' ' + b.title, 'ru'))
    .map(publicTrack);
}

/**
 * Зарегистрировать файл из каталога музыки.
 * @param {{title?:string, artist?:string, duration?:number, sources?:string[]}} [extra]
 *   метаданные источника (yt-dlp/Spotify) поверх тегов и ключи кэша источника («youtube:<id>» и т.п.)
 */
export async function registerFile(file, addedBy, extra = {}) {
  const st = await fsp.stat(path.join(musicDir, file));
  const meta = await readMeta(file);
  if (extra.title) meta.title = String(extra.title).slice(0, 200);
  if (extra.artist !== undefined && extra.artist !== null && (extra.title || !meta.artist)) meta.artist = String(extra.artist).slice(0, 200);
  if (!meta.duration && Number.isFinite(extra.duration) && extra.duration > 0) meta.duration = Math.round(extra.duration * 10) / 10;
  db.data.tracks = db.data.tracks.filter((t) => t.file !== file);
  const track = { id: trackId(file), file, ...meta, addedBy, size: st.size, mtimeMs: st.mtimeMs, createdAt: Date.now() };
  const sources = [...new Set((extra.sources || []).filter(Boolean))];
  if (sources.length) track.sources = sources;
  db.data.tracks.push(track);
  save();
  return publicTrack(track);
}

/** Кэш: трек библиотеки, скачанный ранее из источника с одним из ключей (файл должен существовать). */
export function findBySource(keys, addAliases = []) {
  const want = keys.filter(Boolean);
  if (!want.length) return null;
  const t = db.data.tracks.find((x) => x.sources?.some((k) => want.includes(k)));
  if (!t) return null;
  if (!fs.existsSync(path.join(musicDir, t.file))) {
    db.data.tracks = db.data.tracks.filter((x) => x !== t);
    save();
    return null;
  }
  const extra = [...want, ...addAliases].filter((k) => k && !t.sources.includes(k));
  if (extra.length) { t.sources.push(...extra); save(); }
  return publicTrack(t);
}

// ---------- загрузка файла (после multer) ----------
export async function addUploadedFile(multerFile, addedBy) {
  if (!multerFile) throw new HttpError(400, 'Файл не получен (поле «file»)');
  const original = sanitizeFileName(fixMulterName(multerFile.originalname));
  let ext = path.extname(original).toLowerCase();
  const mime = String(multerFile.mimetype || '').toLowerCase();
  const isAudioMime = mime.startsWith('audio/');
  if (!AUDIO_EXT.has(ext)) {
    if (isAudioMime && MIME_BY_EXT[mime]) ext = MIME_BY_EXT[mime];
    else {
      await fsp.rm(multerFile.path, { force: true });
      throw new HttpError(400, 'Это не аудиофайл. Поддерживаются: mp3, m4a, aac, ogg, opus, wav, flac, webm');
    }
  }
  if (!isAudioMime && mime !== 'application/octet-stream' && mime !== 'video/mp4' && mime !== 'video/webm' && mime !== '') {
    await fsp.rm(multerFile.path, { force: true });
    throw new HttpError(400, 'Это не аудиофайл');
  }
  const stem = original.slice(0, original.length - path.extname(original).length) || 'track';
  const finalName = uniqueName(musicDir, sanitizeFileName(stem + ext));
  await fsp.rename(multerFile.path, path.join(musicDir, finalName));
  return registerFile(finalName, addedBy);
}

// ---------- импорт по ссылке ----------
function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'Укажите ссылку');
  let u;
  try { u = new URL(raw.trim()); } catch { throw new HttpError(400, 'Некорректная ссылка'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Поддерживаются только ссылки http:// и https://');
  return u;
}

async function downloadDirect(u, addedBy) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  let res;
  try {
    res = await fetch(u, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Sozvon/1.0' } });
  } catch (err) {
    clearTimeout(t);
    throw new HttpError(400, 'Не удалось скачать файл по ссылке: ' + (err.name === 'AbortError' ? 'превышено время ожидания' : err.message));
  }
  try {
    if (!res.ok) throw new HttpError(400, `Сервер по ссылке ответил ошибкой ${res.status}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const urlName = decodeURIComponent(path.basename(u.pathname || '')) || 'track';
    let ext = path.extname(urlName).toLowerCase();
    const audioByType = type.startsWith('audio/');
    if (!AUDIO_EXT.has(ext)) ext = MIME_BY_EXT[type] || (audioByType ? '.mp3' : '');
    if (!ext || (!audioByType && type !== 'application/octet-stream' && type !== 'video/mp4' && type !== 'video/webm' && type !== '')) {
      return null; // не аудио
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MUSIC_MAX_BYTES) throw new HttpError(400, 'Файл слишком большой (максимум 50 МБ)');
    const stem = urlName.replace(/\.[^.]+$/, '') || 'track';
    const finalName = uniqueName(musicDir, sanitizeFileName(stem + ext));
    const tmp = path.join(musicDir, `.import-${crypto.randomBytes(6).toString('hex')}`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MUSIC_MAX_BYTES) cb(new HttpError(400, 'Файл слишком большой (максимум 50 МБ)'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(tmp));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err instanceof HttpError ? err : new HttpError(400, 'Ошибка при скачивании: ' + err.message);
    }
    await fsp.rename(tmp, path.join(musicDir, finalName));
    return registerFile(finalName, addedBy);
  } finally {
    clearTimeout(t);
  }
}

// Импорт по ссылке (REST /api/music/import) — в server/music-sources.js (yt-dlp, кэш по источнику)
export { parseUrl, downloadDirect };
