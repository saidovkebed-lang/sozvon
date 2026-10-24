// «Смотреть вместе»: синхронный просмотр видео в голосовом канале (docs/WATCH.md).
//
// Видео скачивает СЕРВЕР (yt-dlp с теми же YTDLP_PROXY/YTDLP_COOKIES/--js-runtimes, что и музыка) —
// поэтому YouTube работает у всех, даже если у кого-то он заблокирован/замедлен. Файл (один mp4 ≤720p,
// по возможности H.264+AAC) лежит в DATA_DIR/watch и отдаётся с нашего адреса с Range и проверкой доступа.
//
// Состояние на голосовой канал (как music:state):
//   {channelId, video, queue[], paused, position, updatedAt, seekSeq, loading[], serverNow}
//   video/queue[i]: {qid, id, title, duration, url, source, by:{id,name}}
//   loading[i]:     {id, title, stage:'queued'|'meta'|'download'|'process', progress:0..1|null, by}
// Позиция сейчас = position + (paused ? 0 : (serverNow − updatedAt)/1000).
//
// Сокет (ack {ok, error?}):
//   watch:sync                         → {states:[…], token, limits}  (все видимые голосовые каналы)
//   watch:start {url}                  — скачать и включить (или в очередь), в своём голосовом канале
//   watch:control {action, position?, qid?, id?}
//        action: play | pause | seek | skip | stop | remove (qid) | cancel (id загрузки)
// REST: POST /api/watch/upload?channelId=… (multipart «file»); GET /media/watch/<id>.<ext>?t=<token> (Range).
// Право: USE_MUSIC_BOT («Музыка и совместный просмотр») в канале + быть в этом голосовом канале.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import multer from 'multer';
import { db } from './db.js';
import { findChannel, findServer, findUser, isMember, canViewChannel, userServers, serverChannels } from './model.js';
import { PERMS, has, computeChannel } from './permissions.js';
import { requireAuth, HttpError } from './auth.js';
import { runYtDlp, explainYtDlp, parseLastJson, parseMusicLink, urlKey } from './music-sources.js';
import { hasYtDlp, fixMulterName, sanitizeFileName } from './music-library.js';

// ---------- настройки (env читается при каждом обращении) ----------
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export function watchLimits() {
  return {
    maxDurationSec: Math.round(num('WATCH_MAX_DURATION_MIN', 180) * 60),
    maxBytes: Math.floor(num('WATCH_MAX_MB', 1500) * 1024 * 1024),
    cacheBytes: Math.floor(num('WATCH_CACHE_GB', 10) * 1024 ** 3),
    downloadTimeoutMs: num('WATCH_DOWNLOAD_TIMEOUT_MIN', 60) * 60_000,
    metaTimeoutMs: num('YTDLP_META_TIMEOUT_SEC', 90) * 1000,
    concurrency: Math.max(1, Math.floor(num('WATCH_DOWNLOAD_CONCURRENCY', 1))),
    idleMs: num('WATCH_IDLE_SEC', 60) * 1000,
  };
}
const MAX_QUEUE = 30;        // очередь + загрузки на канал
const START_LEAD_MS = 1000;  // новое видео стартует чуть позже — чтобы все успели загрузить начало
const TOKEN_TTL_MS = 48 * 3600_000;
const VIDEO_EXT = new Set(['.mp4', '.webm']);                       // отдаём как есть
const UPLOAD_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv']);
const NO_PERM = 'Нет права включать видео (право «Музыка и совместный просмотр»)';
const MB = (b) => Math.round(b / 1024 / 1024);
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const nameOf = (u) => u.displayName || u.username;
const err = (status, msg) => new HttpError(status, msg);

// ---------- ffprobe / ffmpeg ----------
const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = () => process.env.FFPROBE_PATH
  || (process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe');
const works = (bin) => { try { return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };
let ffmpegOk = null;
const hasFfmpeg = () => (ffmpegOk ??= works(ffmpegBin())); // (music-library.hasFfmpeg вызывает «--version», которого у ffmpeg нет)
let ffprobeOk = null;
const hasFfprobe = () => (ffprobeOk ??= works(ffprobeBin()));

function run(bin, args, timeoutMs = 10 * 60_000) {
  return new Promise((resolve) => {
    let out = '', errOut = '';
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 2e6) out += d; });
    child.stderr.on('data', (d) => { if (errOut.length < 2e5) errOut += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err: errOut }); });
  });
}

/** {duration, vcodec, acodec, container} или null (ffprobe нет/файл не видео) */
async function probe(file) {
  if (!hasFfprobe()) return null;
  const r = await run(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  if (r.code !== 0) return { bad: true };
  try {
    const j = JSON.parse(r.out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const duration = Number(j.format?.duration) || Number(v?.duration) || 0;
    return { duration, vcodec: v?.codec_name || null, acodec: a?.codec_name || null, container: j.format?.format_name || '', width: v?.width || 0, height: v?.height || 0 };
  } catch { return { bad: true }; }
}

/**
 * Проверить скачанный/загруженный файл и привести к тому, что играет в браузере: mp4/webm как есть,
 * остальное (mov/mkv/…) — ffmpeg-ремукс в mp4 без перекодирования. → {file, ext, duration, size}
 */
async function normalizeFile(src, ext, limits, { what = 'Видео' } = {}) {
  const info = await probe(src);
  if (info?.bad || (info && !info.vcodec)) throw err(400, 'Файл не похож на видео (или повреждён)');
  const duration = info?.duration || 0;
  if (duration > limits.maxDurationSec) {
    throw err(400, `${what} слишком длинное: ${fmtDur(duration)} (максимум ${Math.round(limits.maxDurationSec / 60)} мин)`);
  }
  let file = src;
  if (!VIDEO_EXT.has(ext)) {
    if (!hasFfmpeg()) throw err(400, `Формат ${ext || 'без расширения'} не поддерживается — нужен mp4 или webm`);
    const out = src + '.remux.mp4';
    const r = await run(ffmpegBin(), ['-y', '-loglevel', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out]);
    if (r.code !== 0) {
      await fsp.rm(out, { force: true });
      throw err(400, 'Не удалось подготовить видео для браузера (кодек не поддерживается в mp4) — загрузите mp4 (H.264)');
    }
    await fsp.rm(src, { force: true });
    file = out; ext = '.mp4';
  }
  const st = await fsp.stat(file);
  if (st.size > limits.maxBytes) throw err(400, `${what} больше ${MB(limits.maxBytes)} МБ`);
  return { file, ext, duration, size: st.size };
}

export function createWatch(io, { voice, emitToViewers, dataDir }) {
  const dir = path.join(dataDir, 'watch');
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'index.json');

  // ---------- секрет для ссылок на файлы ----------
  const secretFile = path.join(dir, '.secret');
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* создадим */ }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
  }
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url').slice(0, 32);
  function mediaToken(userId) {
    const body = `${Buffer.from(userId).toString('base64url')}.${Date.now() + TOKEN_TTL_MS}`;
    return `${body}.${sign(body)}`;
  }
  function userByMediaToken(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const a = Buffer.from(parts[2]); const b = Buffer.from(sign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (!(Number(parts[1]) > Date.now())) return null;
    const u = findUser(Buffer.from(parts[0], 'base64url').toString());
    return u && !u.isBot ? u : null;
  }

  // ---------- кэш файлов (LRU) ----------
  /** id → {id, file, title, duration, size, keys[], source, createdAt, lastUsed} */
  const cache = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    for (const v of Object.values(j.videos || {})) {
      if (v?.id && v.file && fs.existsSync(path.join(dir, v.file))) cache.set(v.id, v);
    }
  } catch { /* пустой кэш */ }
  // мусор: недокачанное, файлы без записи
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.json' || name === '.secret') continue;
    if ([...cache.values()].some((v) => v.file === name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  let saveTimer = null;
  function saveIndex() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = indexFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ videos: Object.fromEntries(cache) }));
      fs.renameSync(tmp, indexFile);
    }, 300);
    saveTimer.unref?.();
  }
  const findCached = (keys) => {
    const ks = keys.filter(Boolean);
    if (!ks.length) return null;
    for (const v of cache.values()) if (v.keys?.some((k) => ks.includes(k))) return v;
    return null;
  };
  const inUse = (id) => [...states.values()].some((st) => st.video?.id === id || st.queue.some((q) => q.id === id));
  function evict() {
    const limit = watchLimits().cacheBytes;
    let total = [...cache.values()].reduce((n, v) => n + (v.size || 0), 0);
    if (total <= limit) return;
    for (const v of [...cache.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= limit) break;
      if (inUse(v.id)) continue;
      cache.delete(v.id);
      fs.rm(path.join(dir, v.file), { force: true }, () => {});
      total -= v.size || 0;
      console.log(`[watch] Кэш: удалил «${v.title}» (${MB(v.size)} МБ), занято ${MB(total)} из ${MB(limit)} МБ`);
    }
    saveIndex();
  }
  function addToCache({ file, ext, duration, size }, { title, keys = [], source }) {
    const id = crypto.randomBytes(8).toString('hex');
    const name = id + ext;
    fs.renameSync(file, path.join(dir, name));
    const rec = {
      id, file: name, title: String(title || 'Видео').slice(0, 200), duration: Math.round((duration || 0) * 10) / 10,
      size, keys: [...new Set(keys.filter(Boolean))], source, createdAt: Date.now(), lastUsed: Date.now(),
    };
    cache.set(id, rec);
    saveIndex();
    return rec;
  }

  // ---------- состояние каналов ----------
  const states = new Map(); // channelId → {channelId, video, queue, paused, position, updatedAt, seekSeq, loading, endTimer, emptySince}
  const getState = (channelId) => {
    let st = states.get(channelId);
    if (!st) {
      st = { channelId, video: null, queue: [], paused: false, position: 0, updatedAt: Date.now(), seekSeq: 0, loading: [], endTimer: null, emptySince: 0 };
      states.set(channelId, st);
    }
    return st;
  };
  const elapsed = (st) => Math.max(0, st.position + (st.paused ? 0 : (Date.now() - st.updatedAt) / 1000));

  function publicState(st) {
    return {
      channelId: st.channelId,
      video: st.video ? { ...st.video } : null,
      queue: st.queue.map((q) => ({ ...q })),
      paused: st.paused,
      position: Math.round(st.position * 1000) / 1000,
      updatedAt: st.updatedAt,
      seekSeq: st.seekSeq,
      loading: st.loading.map((l) => ({ id: l.id, title: l.job.title || l.input, stage: l.job.stage, progress: l.job.progress, by: l.by })),
      serverNow: Date.now(),
    };
  }
  const emptyState = (channelId) => ({ channelId, video: null, queue: [], paused: false, position: 0, updatedAt: Date.now(), seekSeq: 0, loading: [], serverNow: Date.now() });

  const throttle = new Map(); // channelId → timer
  function emit(st) {
    clearTimeout(throttle.get(st.channelId));
    throttle.delete(st.channelId);
    const idle = !st.video && !st.queue.length && !st.loading.length;
    if (idle) { clearTimeout(st.endTimer); states.delete(st.channelId); }
    emitToViewers(st.channelId, 'watch:state', idle ? emptyState(st.channelId) : publicState(st));
  }
  function emitSoon(st) { // прогресс скачивания — не чаще раза в секунду
    if (throttle.has(st.channelId)) return;
    throttle.set(st.channelId, setTimeout(() => { throttle.delete(st.channelId); if (states.get(st.channelId) === st) emit(st); }, 1000));
  }

  function scheduleEnd(st) {
    clearTimeout(st.endTimer);
    st.endTimer = null;
    if (!st.video || st.paused || !(st.video.duration > 0)) return;
    const left = st.video.duration - elapsed(st) + Math.max(0, (st.updatedAt - Date.now()) / 1000);
    st.endTimer = setTimeout(() => {
      if (states.get(st.channelId) !== st || !st.video) return;
      if (elapsed(st) + 0.5 < st.video.duration) { scheduleEnd(st); return; }
      playNext(st);
      emit(st);
      evict();
    }, Math.max(0, left * 1000) + 1500);
    st.endTimer.unref?.();
  }

  function startVideo(st, item) {
    st.video = item;
    st.paused = false;
    st.position = 0;
    st.updatedAt = Date.now() + START_LEAD_MS;
    st.seekSeq++;
    const rec = cache.get(item.id);
    if (rec) { rec.lastUsed = Date.now(); saveIndex(); }
    scheduleEnd(st);
  }
  function playNext(st) {
    const next = st.queue.shift();
    if (next) startVideo(st, next);
    else { st.video = null; st.paused = false; st.position = 0; st.updatedAt = Date.now(); clearTimeout(st.endTimer); }
  }

  function enqueue(st, rec, by) {
    const item = {
      qid: 'w-' + crypto.randomBytes(5).toString('hex'), id: rec.id, title: rec.title, duration: rec.duration,
      url: `/media/watch/${rec.file}`, source: rec.source, by,
    };
    rec.lastUsed = Date.now();
    if (!st.video) startVideo(st, item); else st.queue.push(item);
    saveIndex();
    return item;
  }

  // ---------- скачивание (одно задание на ссылку, общее для каналов) ----------
  const jobs = new Map(); // key → job {key, title, stage, progress, controller, refs:Set<loadingEntry>, promise}
  let running = 0;
  const waiters = [];
  async function acquire(signal) {
    while (running >= watchLimits().concurrency) {
      await new Promise((r) => waiters.push(r));
      if (signal.aborted) throw err(499, 'Отменено');
    }
    running++;
  }
  function release() { running--; waiters.shift()?.(); }

  function touchJob(job) { for (const l of job.refs) { const st = states.get(l.channelId); if (st) emitSoon(st); } }

  async function downloadJob(job, url) {
    const limits = watchLimits();
    const signal = job.controller.signal;
    const aborted = () => { if (signal.aborted) throw err(499, 'Отменено'); };
    if (!hasYtDlp()) throw err(503, 'На сервере не установлен yt-dlp — ссылки недоступны, но можно загрузить файл');
    job.stage = 'queued'; touchJob(job);
    await acquire(signal);
    let tmpDir = null;
    try {
      aborted();
      // 1. метаданные: название, длительность, эфир/плейлист
      job.stage = 'meta'; touchJob(job);
      const meta = await runYtDlp(['-J', '--no-playlist', '--', url], { timeoutMs: limits.metaTimeoutMs, queue: false, signal });
      aborted();
      const src = parseMusicLink(url)?.kind || 'other';
      const info = meta.code === 0 ? parseLastJson(meta.stdout) : null;
      if (!info) throw err(502, videoReason(explainYtDlp(meta, src, limits.metaTimeoutMs)));
      if (info._type === 'playlist' || Array.isArray(info.entries)) throw err(400, 'Это плейлист — вставьте ссылку на одно видео');
      if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw err(400, 'Прямые эфиры не поддерживаются');
      const duration = Number(info.duration) || 0;
      if (duration > limits.maxDurationSec) {
        throw err(400, `Видео слишком длинное: ${fmtDur(duration)} (максимум ${Math.round(limits.maxDurationSec / 60)} мин)`);
      }
      job.title = String(info.title || job.title || 'Видео').slice(0, 200);
      const exKey = info.extractor_key && info.id ? `${String(info.extractor_key).toLowerCase()}:${info.id}` : null;
      job.keys.push(exKey, info.webpage_url && urlKey(info.webpage_url));
      const hit = findCached(job.keys);
      if (hit) { hit.keys = [...new Set([...hit.keys, ...job.keys.filter(Boolean)])]; saveIndex(); return hit; }
      // 2. скачивание: один файл ≤720p, H.264+AAC в приоритете; с ffmpeg — склейка/ремукс в mp4
      job.stage = 'download'; job.progress = 0; touchJob(job);
      tmpDir = path.join(dir, `.dl-${crypto.randomBytes(5).toString('hex')}`);
      await fsp.mkdir(tmpDir, { recursive: true });
      const ff = hasFfmpeg();
      const args = ['--no-playlist', '--newline', '--progress',
        '--progress-template', 'download:WATCHPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
        '--match-filters', '!is_live',
        '-f', ff ? 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b' : 'b[height<=720][ext=mp4]/b[ext=mp4]/b[height<=720]/b',
        '-S', 'res:720,vcodec:h264,acodec:aac,ext',
        ...(ff ? ['--merge-output-format', 'mp4', '--remux-video', 'mp4>mp4/webm>webm/mp4'] : []),
        '--max-filesize', `${MB(limits.maxBytes)}M`,
        '-o', path.join(tmpDir, '%(id)s.%(ext)s'),
        '--print', 'after_move:%(.{id,title,duration,extractor_key,webpage_url,filepath,ext})j',
        '--', url];
      let part = 0, lastPct = 0;
      const res = await runYtDlp(args, {
        timeoutMs: limits.downloadTimeoutMs, queue: false, signal,
        onLine: (line) => {
          const m = line.match(/WATCHPROG (\S+) (\S+) (\S+)/);
          if (!m) return false;
          const done = Number(m[1]); const total = Number(m[2]) || Number(m[3]);
          if (Number.isFinite(done) && done > limits.maxBytes) job.controller.abort(); // размер заранее неизвестен
          if (Number.isFinite(done) && total > 0) {
            const pct = Math.min(1, done / total);
            if (pct + 0.3 < lastPct) part++; // видео скачано, пошла аудиодорожка
            lastPct = pct;
            const next = Math.min(0.99, part ? 0.9 + pct * 0.09 : pct * 0.9);
            if (Math.abs(next - (job.progress || 0)) >= 0.01) { job.progress = next; touchJob(job); }
          }
          return true;
        },
      });
      if (signal.aborted && !job.cancelled) throw err(400, `Видео больше ${MB(limits.maxBytes)} МБ`);
      aborted();
      const out = parseLastJson(res.stdout);
      const filePath = out?.filepath && path.resolve(out.filepath);
      if (res.code !== 0 || !filePath || !filePath.startsWith(tmpDir + path.sep) || !fs.existsSync(filePath)) {
        if (res.code === 0 && !res.timedOut) {
          throw err(400, /larger than max-filesize|file is larger/i.test(res.stdout + res.stderr)
            ? `Видео больше ${MB(limits.maxBytes)} МБ` : 'Видео пропущено (прямой эфир или слишком большой файл)');
        }
        throw err(502, videoReason(explainYtDlp(res, src, limits.downloadTimeoutMs)));
      }
      // 3. проверка и подготовка файла
      job.stage = 'process'; job.progress = null; touchJob(job);
      const norm = await normalizeFile(filePath, path.extname(filePath).toLowerCase(), limits);
      return addToCache(norm, { title: job.title, keys: job.keys, source: src === 'other' ? String(info.extractor_key || 'other').toLowerCase() : src });
    } finally {
      release();
      if (tmpDir) fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const videoReason = (msg) => String(msg)
    .replace('видео/трек недоступен (удалён или приватный)', 'видео недоступно (удалено или приватное)')
    .replace('не удалось получить аудио', 'не удалось получить видео')
    .replace('этот трек', 'это видео').replace(/трек/g, 'видео');

  function getJob(url, keys, hintTitle) {
    const key = keys[0] || url;
    let job = jobs.get(key);
    if (job) return job;
    job = { key, title: hintTitle, stage: 'queued', progress: null, controller: new AbortController(), refs: new Set(), keys: [...keys], cancelled: false };
    // вытеснение — после того как каналы поставят новое видео в очередь (их .then выполнятся раньше таймера)
    job.promise = downloadJob(job, url).finally(() => { if (jobs.get(key) === job) jobs.delete(key); setTimeout(evict, 0); });
    job.promise.catch(() => {});
    jobs.set(key, job);
    return job;
  }
  function dropLoading(st, l) {
    st.loading = st.loading.filter((x) => x !== l);
    l.job.refs.delete(l);
    if (!l.job.refs.size && l.job.stage !== 'process') { l.job.cancelled = true; l.job.controller.abort(); }
  }

  function startUrl(st, rawUrl, user) {
    let u;
    try { u = new URL(String(rawUrl || '').trim()); } catch { throw err(400, 'Вставьте ссылку на видео (https://…)'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw err(400, 'Поддерживаются только ссылки http:// и https://');
    if (u.toString().length > 2000) throw err(400, 'Слишком длинная ссылка');
    if (st.queue.length + st.loading.length >= MAX_QUEUE) throw err(400, `В очереди уже ${MAX_QUEUE} видео`);
    const link = parseMusicLink(u.toString());
    const url = link?.kind === 'youtube' && link.type === 'video' ? link.url : u.toString();
    const keys = [link?.kind === 'youtube' && link.id ? `youtube:${link.id}` : null, urlKey(url)].filter(Boolean);
    const by = { id: user.id, name: nameOf(user) };
    const cached = findCached(keys);
    if (cached) { const item = enqueue(st, cached, by); emit(st); return { item }; }
    const job = getJob(url, keys, u.hostname.replace(/^www\./, ''));
    const l = { id: 'l-' + crypto.randomBytes(5).toString('hex'), channelId: st.channelId, input: u.hostname, by, job };
    job.refs.add(l);
    st.loading.push(l);
    emit(st);
    job.promise.then((rec) => {
      if (!job.refs.has(l)) return;
      const cur = states.get(st.channelId) === st ? st : null;
      if (cur) { dropLoading(cur, l); enqueue(cur, rec, by); emit(cur); }
    }, (e) => {
      if (!job.refs.has(l)) return;
      dropLoading(st, l);
      if (states.get(st.channelId) === st) emit(st);
      if (e?.status === 499) return;
      if (!(e instanceof HttpError)) console.error('[watch] скачивание:', e);
      emitToViewers(st.channelId, 'watch:error', {
        channelId: st.channelId, title: job.title, by,
        error: e instanceof HttpError ? e.message : 'Не удалось скачать видео',
      });
    });
    return { loadingId: l.id };
  }

  // ---------- права ----------
  /** Канал, где пользователь может управлять просмотром (он в нём + USE_MUSIC_BOT). */
  function controlChannel(user, channelId) {
    const vc = voice.userVoiceChannel(user.id);
    if (!vc) throw err(400, 'Зайди в голосовой канал');
    if (channelId && channelId !== vc) throw err(400, 'Ты в другом голосовом канале');
    const channel = findChannel(vc);
    const server = channel && findServer(channel.serverId);
    if (!server || !isMember(server, user.id)) throw err(404, 'Канал не найден');
    if (!has(computeChannel(server, channel.id, user.id), PERMS.USE_MUSIC_BOT)) throw err(403, NO_PERM);
    return channel;
  }
  function canWatchFile(user, id) {
    for (const st of states.values()) {
      if (st.video?.id !== id && !st.queue.some((q) => q.id === id)) continue;
      const ch = findChannel(st.channelId);
      const server = ch && findServer(ch.serverId);
      if (server && isMember(server, user.id) && canViewChannel(server, ch.id, user.id)) return true;
    }
    return false;
  }

  // ---------- управление ----------
  function control(st, { action, position, qid, id }) {
    switch (action) {
      case 'play':
        if (!st.video) throw err(400, 'Сейчас ничего не играет');
        if (st.paused) { st.paused = false; st.updatedAt = Date.now(); }
        break;
      case 'pause':
        if (!st.video) throw err(400, 'Сейчас ничего не играет');
        if (!st.paused) { st.position = elapsed(st); st.paused = true; st.updatedAt = Date.now(); }
        break;
      case 'seek': {
        if (!st.video) throw err(400, 'Сейчас ничего не играет');
        const p = Number(position);
        if (!Number.isFinite(p)) throw err(400, 'Укажите время');
        const max = st.video.duration > 0 ? Math.max(0, st.video.duration - 0.5) : Infinity;
        st.position = Math.min(max, Math.max(0, p));
        st.updatedAt = Date.now();
        st.seekSeq++;
        break;
      }
      case 'skip': playNext(st); break;
      case 'stop':
        st.queue = [];
        for (const l of [...st.loading]) dropLoading(st, l);
        playNext(st);
        break;
      case 'remove':
        st.queue = st.queue.filter((q) => q.qid !== qid);
        break;
      case 'cancel': {
        const l = st.loading.find((x) => x.id === id);
        if (l) dropLoading(st, l);
        break;
      }
      default: throw err(400, 'Неизвестное действие');
    }
    scheduleEnd(st);
    emit(st);
    if (action === 'stop' || action === 'skip' || action === 'remove') evict(); // освободившиеся файлы можно вытеснять
  }

  // ---------- сокеты ----------
  function attach(socket, user) {
    const on = (event, handler) => socket.on(event, async (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = {}; }
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!findUser(user.id) || !db.data.sessions[socket.data.token]) throw err(401, 'Сессия недействительна');
        const res = await handler(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
        reply({ ok: true, ...(res || {}) });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(`[watch] ${event}:`, e);
        reply({ ok: false, error: e instanceof HttpError ? e.message : 'Внутренняя ошибка сервера' });
      }
    });

    on('watch:sync', () => {
      const out = [];
      for (const s of userServers(user.id)) {
        for (const c of serverChannels(s.id)) {
          if (c.type !== 'voice' || !states.has(c.id) || !canViewChannel(s, c.id, user.id)) continue;
          out.push(publicState(states.get(c.id)));
        }
      }
      const l = watchLimits();
      return { states: out, token: mediaToken(user.id), limits: { maxDurationMin: Math.round(l.maxDurationSec / 60), maxMb: MB(l.maxBytes) } };
    });
    on('watch:start', ({ url, channelId }) => {
      const ch = controlChannel(user, typeof channelId === 'string' ? channelId : null);
      const st = getState(ch.id);
      try { return startUrl(st, url, user); } finally {
        if (!st.video && !st.queue.length && !st.loading.length) states.delete(ch.id);
      }
    });
    on('watch:control', (p) => {
      const ch = controlChannel(user, typeof p.channelId === 'string' ? p.channelId : null);
      const st = states.get(ch.id);
      if (!st) { if (p.action === 'stop') return {}; throw err(400, 'Сейчас ничего не играет'); }
      control(st, { action: String(p.action || ''), position: p.position, qid: String(p.qid || ''), id: String(p.id || '') });
      return {};
    });
  }

  // ---------- уборка: пустые и удалённые каналы ----------
  const sweep = setInterval(() => {
    const { idleMs } = watchLimits();
    for (const st of [...states.values()]) {
      if (!findChannel(st.channelId)) {
        for (const l of [...st.loading]) dropLoading(st, l);
        clearTimeout(st.endTimer); states.delete(st.channelId);
        continue;
      }
      if (voice.humans(st.channelId).length) { st.emptySince = 0; continue; }
      if (!st.emptySince) { st.emptySince = Date.now(); continue; }
      if (Date.now() - st.emptySince < idleMs) continue;
      for (const l of [...st.loading]) dropLoading(st, l);
      st.queue = []; st.video = null;
      emit(st); // все ушли — просмотр закончен
      evict();
    }
  }, 1000);
  sweep.unref();

  // ---------- HTTP ----------
  const router = express.Router();
  router.post('/upload', requireAuth, (req, res, next) => {
    try {
      if (req.isBot) throw err(403, 'Боту нельзя');
      req.watchChannel = controlChannel(req.user, typeof req.query.channelId === 'string' ? req.query.channelId : null);
      const st = states.get(req.watchChannel.id);
      if (st && st.queue.length + st.loading.length >= MAX_QUEUE) throw err(400, `В очереди уже ${MAX_QUEUE} видео`);
    } catch (e) { return next(e); }
    const limits = watchLimits();
    multer({
      storage: multer.diskStorage({
        destination: dir,
        filename: (_req, _file, cb) => cb(null, `.upload-${crypto.randomBytes(8).toString('hex')}`),
      }),
      limits: { fileSize: limits.maxBytes, files: 1, fields: 5 },
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(fixMulterName(file.originalname)).toLowerCase();
        const ok = UPLOAD_EXT.has(ext) || String(file.mimetype || '').startsWith('video/');
        cb(ok ? null : err(400, 'Нужен видеофайл: mp4, webm, mov, mkv'), ok);
      },
    }).single('file')(req, res, next);
  }, async (req, res, next) => {
    const tmp = req.file?.path;
    try {
      if (!req.file) throw err(400, 'Файл нужно передать в поле «file»');
      const original = sanitizeFileName(fixMulterName(req.file.originalname));
      const ext = path.extname(original).toLowerCase() || '.mp4';
      const norm = await normalizeFile(tmp, ext, watchLimits());
      const ch = findChannel(req.watchChannel.id);
      if (!ch || voice.userVoiceChannel(req.user.id) !== ch.id) { await fsp.rm(norm.file, { force: true }); throw err(400, 'Зайди в голосовой канал'); }
      const rec = addToCache(norm, { title: original.replace(/\.[^.]+$/, '') || 'Видео', source: 'upload' });
      const st = getState(ch.id);
      const item = enqueue(st, rec, { id: req.user.id, name: nameOf(req.user) });
      emit(st);
      evict();
      res.json({ ok: true, video: item });
    } catch (e) {
      if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
      if (tmp) fsp.rm(tmp + '.remux.mp4', { force: true }).catch(() => {});
      next(e);
    }
  });
  // eslint-disable-next-line no-unused-vars
  router.use((e, req, res, _next) => {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    if (e instanceof multer.MulterError) {
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Файл слишком большой (максимум ${MB(watchLimits().maxBytes)} МБ)` });
      return res.status(400).json({ error: 'Ошибка загрузки файла' });
    }
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error('[watch]', e);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  /** GET /media/watch/<id>.<ext>?t=<token> — с Range (206), только тем, кто видит канал с этим видео */
  function media(req, res) {
    const m = String(req.params.file || '').match(/^([0-9a-f]{16})(\.(mp4|webm))$/);
    const rec = m && cache.get(m[1]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!rec || rec.file !== m[0]) return res.status(404).json({ error: 'Видео не найдено' });
    const user = userByMediaToken(req.query.t);
    if (!user) return res.status(401).json({ error: 'Требуется авторизация. Войдите заново.' });
    if (!canWatchFile(user, rec.id)) return res.status(403).json({ error: 'Это видео сейчас не показывают в ваших каналах' });
    if (Date.now() - rec.lastUsed > 60_000) { rec.lastUsed = Date.now(); saveIndex(); }
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; sandbox");
    res.sendFile(path.join(dir, rec.file), { dotfiles: 'allow', acceptRanges: true, cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600' } }, (e) => {
      if (e && !res.headersSent) res.status(e.status || 500).json({ error: 'Файл не найден' });
    });
  }

  return {
    attach, router, media,
    // для тестов/отладки
    _debug: { states, cache, jobs, evict },
  };
}
