// Музыкальная библиотека бота: файлы в data/music, метаданные через music-metadata,
// загрузка файлов, импорт по прямой ссылке или через yt-dlp (если установлен).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
const YTDLP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com|soundcloud\.com|vk\.com|vkvideo\.ru|bandcamp\.com|twitch\.tv|rutube\.ru|vimeo\.com|dailymotion\.com|mixcloud\.com)$/i;

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
export function hasYtDlp() {
  if (ytdlpCache === null || ytdlpCache === false) ytdlpCache = commandExists('yt-dlp');
  return ytdlpCache;
}
let ffmpegCache = null;
const hasFfmpeg = () => (ffmpegCache ??= commandExists('ffmpeg'));

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

function uniqueName(dir, name) {
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

export function listTracks() {
  return [...db.data.tracks]
    .sort((a, b) => (a.artist + ' ' + a.title).localeCompare(b.artist + ' ' + b.title, 'ru'))
    .map(publicTrack);
}

async function registerFile(file, addedBy) {
  const st = await fsp.stat(path.join(musicDir, file));
  const meta = await readMeta(file);
  db.data.tracks = db.data.tracks.filter((t) => t.file !== file);
  const track = { id: trackId(file), file, ...meta, addedBy, size: st.size, mtimeMs: st.mtimeMs, createdAt: Date.now() };
  db.data.tracks.push(track);
  save();
  return publicTrack(track);
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

function downloadYtDlp(u, addedBy) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(4).toString('hex');
    const args = ['--no-playlist', '--no-progress', '--restrict-filenames', '--max-filesize', '50M',
      '-o', path.join(musicDir, `%(title).80s-${token}.%(ext)s`), '--print', 'after_move:filepath'];
    if (hasFfmpeg()) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
    else args.push('-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio');
    args.push('--', u.toString());
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('error', (err) => { clearTimeout(killer); reject(new HttpError(500, 'Не удалось запустить yt-dlp: ' + err.message)); });
    child.on('close', async (code) => {
      clearTimeout(killer);
      const filePath = out.trim().split('\n').filter(Boolean).pop();
      if (code !== 0 || !filePath || !fs.existsSync(filePath)) {
        const reason = (errOut.split('\n').find((l) => l.includes('ERROR')) || errOut.trim().split('\n').pop() || '').slice(0, 300);
        return reject(new HttpError(400, 'yt-dlp не смог скачать трек' + (reason ? ': ' + reason : '')));
      }
      try {
        let file = path.basename(filePath);
        if (!AUDIO_EXT.has(path.extname(file).toLowerCase())) {
          await fsp.rm(filePath, { force: true });
          return reject(new HttpError(400, 'yt-dlp скачал файл неподдерживаемого формата'));
        }
        const st = await fsp.stat(filePath);
        if (st.size > MUSIC_MAX_BYTES) {
          await fsp.rm(filePath, { force: true });
          return reject(new HttpError(400, 'Файл слишком большой (максимум 50 МБ)'));
        }
        const clean = uniqueName(musicDir, sanitizeFileName(file.replace(`-${token}`, '').replace(/_/g, ' ')));
        await fsp.rename(filePath, path.join(musicDir, clean));
        file = clean;
        resolve(await registerFile(file, addedBy));
      } catch (err) { reject(err); }
    });
  });
}

export async function importFromUrl(rawUrl, addedBy) {
  const u = parseUrl(rawUrl);
  const needsYtDlp = YTDLP_HOSTS.test(u.hostname);
  if (needsYtDlp) {
    if (!hasYtDlp()) throw new HttpError(400, 'Для ссылок YouTube и других сайтов нужен yt-dlp — он не установлен на сервере. Установите yt-dlp (см. README) или используйте прямую ссылку на аудиофайл.');
    return downloadYtDlp(u, addedBy);
  }
  const track = await downloadDirect(u, addedBy);
  if (track) return track;
  if (hasYtDlp()) return downloadYtDlp(u, addedBy);
  throw new HttpError(400, 'По ссылке не аудиофайл. Нужна прямая ссылка на mp3/ogg/m4a… (для YouTube и других сайтов установите yt-dlp)');
}
