// Музыка из интернета: распознавание ссылок (YouTube / Spotify / SoundCloud), поиск трека,
// скачивание через yt-dlp с кэшем в библиотеке (повторно один и тот же трек не качается).
//
// Контракт с ботом (REST, см. routes.js):
//   POST /api/music/resolve {input}  → {track}                  — одиночная ссылка / текстовый поиск: уже скачано
//                                    → {playlist, items:[pending]} — плейлист/альбом: «ожидающие» элементы
//   POST /api/music/fetch {item}     → {track}                  — скачать ожидающий элемент (перед воспроизведением)
//
// Ожидающий элемент: {pending:true, id:'p-…', title, artist, duration, source, ref:{url?, key?, query?}}
//   source: 'youtube' | 'soundcloud' | 'spotify' | 'search'; ref — откуда брать звук (бот возвращает его как есть).
//
// Ключи кэша (tracks[].sources в db.json): «<extractor>:<id>» (youtube:dQw4w9WgXcQ, soundcloud:293),
// «spotify:<trackId>», «url:<host/path>» — по любому из них трек находится без вызова yt-dlp.
import { cookiesSource } from './cookies.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HttpError } from './auth.js';
import {
  getMusicDir, registerFile, findBySource, findTrackRec, sanitizeFileName, uniqueName, hasYtDlp, hasFfmpeg, ytdlpPath,
  AUDIO_EXT, MUSIC_MAX_BYTES, YTDLP_HOSTS, parseUrl, downloadDirect,
} from './music-library.js';
import { coverUrl, titleCoverKey } from './covers.js';
import { parseSpotify, isSpotifyShortLink, expandShortLink, fetchSpotify, spotifyApiConfigured, TYPE_RU } from './spotify.js';

// ---------- настройки (env читается при каждом обращении — удобно для тестов) ----------
const num = (k, d, min = 1) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= min ? v : d; };
export const playlistLimit = () => Math.min(num('MUSIC_PLAYLIST_LIMIT', 100), 1000);
const durationTolerance = () => num('MUSIC_DURATION_TOLERANCE', 15, 0);
const downloadTimeoutMs = () => num('YTDLP_TIMEOUT_SEC', 300) * 1000;
const metaTimeoutMs = () => num('YTDLP_META_TIMEOUT_SEC', 90) * 1000;
const maxParallel = () => num('MUSIC_DOWNLOAD_CONCURRENCY', 2);
const SEARCH_PREFIX = { youtube: 'ytsearch', soundcloud: 'scsearch' };
const SOURCE_RU = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', search: 'поиск' };
export function searchSources() {
  const list = String(process.env.MUSIC_SEARCH_SOURCES || 'youtube,soundcloud')
    .split(/[\s,]+/).map((s) => s.trim().toLowerCase()).map((s) => ({ yt: 'youtube', sc: 'soundcloud' }[s] || s))
    .filter((s) => SEARCH_PREFIX[s]);
  return list.length ? [...new Set(list)] : ['youtube', 'soundcloud'];
}

// ---------- распознавание ссылок ----------
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
/**
 * @returns {{kind:'youtube'|'soundcloud'|'spotify'|'other', type:'video'|'playlist'|'track'|'set'|'album'|'unknown',
 *            id?:string, url:string, listId?:string} | null}
 */
export function parseMusicLink(raw) {
  const s = String(raw || '').trim();
  const sp = parseSpotify(s);
  if (sp) return { kind: 'spotify', type: sp.type, id: sp.id, url: s };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (isSpotifyShortLink(s)) return { kind: 'spotify', type: 'unknown', url: s };

  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1];
    if (YT_ID.test(id || '')) return { kind: 'youtube', type: 'video', id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    const list = u.searchParams.get('list');
    const pm = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/);
    if (v && YT_ID.test(v)) return { kind: 'youtube', type: 'video', id: v, url: `https://www.youtube.com/watch?v=${v}`, listId: list || undefined };
    if (pm) return { kind: 'youtube', type: 'video', id: pm[1], url: `https://www.youtube.com/watch?v=${pm[1]}` };
    if (list && /^[A-Za-z0-9_-]{2,64}$/.test(list)) {
      const base = host === 'music.youtube.com' ? 'https://music.youtube.com' : 'https://www.youtube.com';
      return { kind: 'youtube', type: 'playlist', id: list, url: `${base}/playlist?list=${list}` };
    }
    if (/^\/browse\/(MPREb_|VL)/.test(u.pathname)) return { kind: 'youtube', type: 'playlist', url: u.toString() };
    return { kind: 'youtube', type: 'unknown', url: u.toString() };
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com' || host === 'api.soundcloud.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    const clean = `https://soundcloud.com/${parts.join('/')}`;
    if (host === 'soundcloud.com' && parts[1] === 'sets' && parts[2]) return { kind: 'soundcloud', type: 'set', url: clean };
    if (host === 'soundcloud.com' && parts.length >= 2 && !['sets', 'likes', 'tracks', 'albums', 'reposts', 'popular-tracks'].includes(parts[1])) {
      return { kind: 'soundcloud', type: 'track', url: clean };
    }
    return { kind: 'soundcloud', type: 'unknown', url: u.toString() };
  }
  return { kind: 'other', type: 'unknown', url: u.toString() };
}

/** Ключ кэша по ссылке: «url:host/path?значимые-параметры» */
export function urlKey(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    const keep = ['v', 'list', 'id'].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`).join('&');
    return `url:${host}${u.pathname.replace(/\/+$/, '')}${keep ? '?' + keep : ''}`;
  } catch { return null; }
}

// ---------- запуск yt-dlp ----------
let running = 0;
const waiters = [];
async function acquire() {
  if (running < maxParallel()) { running++; return; }
  await new Promise((r) => waiters.push(r));
  running++;
}
function release() { running--; waiters.shift()?.(); }

let versionInfo = null; // {raw, supportsJsRuntimes}
function ytdlpVersion() {
  if (versionInfo) return versionInfo;
  return (versionInfo = new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(ytdlpPath(), ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve({ raw: '', supportsJsRuntimes: true }); }
    const t = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); versionInfo = null; resolve({ raw: '', supportsJsRuntimes: true }); });
    child.on('close', () => {
      clearTimeout(t);
      const raw = out.trim().split('\n')[0] || '';
      const m = raw.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
      // --js-runtimes появился в 2025.11.12; старым версиям флаг не передаём (иначе «no such option»)
      const supportsJsRuntimes = !m || `${m[1]}${m[2]}${m[3]}` >= '20251112';
      setTimeout(() => { versionInfo = null; }, 10 * 60_000).unref(); // после автообновления перечитаем
      resolve({ raw, supportsJsRuntimes });
    });
  }));
}

function cacheDir() {
  const dir = path.join(path.dirname(getMusicDir()), '.cache', 'yt-dlp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// cookies.txt копируем к себе: yt-dlp перезаписывает файл cookies, а /etc под ProtectSystem=strict только для чтения
function cookiesArg() {
  const src = cookiesSource(); // YTDLP_COOKIES или DATA_DIR/cookies.txt (server/cookies.js)
  if (!src) return [];
  try {
    const dst = path.join(cacheDir(), 'cookies.txt');
    const mark = path.join(cacheDir(), 'cookies.src-mtime');
    const st = fs.statSync(src);
    let copied = '';
    try { copied = fs.readFileSync(mark, 'utf8'); } catch { /* ещё не копировали */ }
    if (!fs.existsSync(dst) || copied !== String(st.mtimeMs)) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
      fs.writeFileSync(mark, String(st.mtimeMs));
    }
    return ['--cookies', dst];
  } catch (err) {
    console.warn(`[music] cookies ${src}: не читается (${err.code || err.message}) — работаю без cookies`);
    return [];
  }
}

async function baseArgs() {
  const v = await ytdlpVersion();
  const a = ['--ignore-config', '--no-warnings', '--socket-timeout', String(num('YTDLP_SOCKET_TIMEOUT', 20)), '--cache-dir', cacheDir()];
  // YouTube требует JS-рантайм для расшифровки подписей: используем тот же Node, что запускает сервер
  if (v.supportsJsRuntimes && process.env.YTDLP_JS_RUNTIME !== 'off') a.push('--js-runtimes', process.env.YTDLP_JS_RUNTIME || `node:${process.execPath}`);
  a.push(...cookiesArg());
  if (process.env.YTDLP_PROXY) a.push('--proxy', process.env.YTDLP_PROXY);
  if (process.env.YTDLP_EXTRA_ARGS) a.push(...process.env.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  return a;
}

export const ytdlpStats = { calls: 0 }; // для отладки/проверок

/**
 * Запуск yt-dlp → {code, stdout, stderr, timedOut}.
 * onLine(line, stream) — построчно (для прогресса); вернул true — строка «съедена» и не копится в stdout/stderr.
 * signal — AbortSignal (отмена убивает процесс); queue=false — без общей очереди скачиваний музыки.
 */
async function runYtDlp(args, { timeoutMs, onLine = null, signal = null, queue = true }) {
  if (!hasYtDlp()) {
    throw new HttpError(503, 'На сервере не установлен yt-dlp — музыка из YouTube/SoundCloud/Spotify недоступна. ' +
      'Администратору: sudo bash /opt/sozvon/deploy/update.sh (или pip install yt-dlp; путь — YTDLP_PATH). Можно загрузить mp3 через «Библиотеку».');
  }
  if (queue) await acquire();
  try {
    const full = [...(await baseArgs()), ...args];
    ytdlpStats.calls++;
    return await new Promise((resolve, reject) => {
      const child = spawn(ytdlpPath(), full, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', XDG_CACHE_HOME: path.dirname(cacheDir()) },
      });
      let stdout = '', stderr = '', timedOut = false;
      const tail = { stdout: '', stderr: '' };
      const take = (which, d) => {
        if (!onLine) {
          if (which === 'stdout') { if (stdout.length < 20e6) stdout += d; } else if (stderr.length < 1e6) stderr += d;
          return;
        }
        const lines = (tail[which] + d).split(/\r?\n|\r/);
        tail[which] = lines.pop();
        for (const line of lines) {
          if (onLine(line, which)) continue;
          if (which === 'stdout') { if (stdout.length < 20e6) stdout += line + '\n'; } else if (stderr.length < 1e6) stderr += line + '\n';
        }
      };
      child.stdout.on('data', (d) => take('stdout', String(d)));
      child.stderr.on('data', (d) => take('stderr', String(d)));
      const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      const onAbort = () => child.kill('SIGKILL');
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      child.on('error', (err) => {
        clearTimeout(killer);
        signal?.removeEventListener('abort', onAbort);
        reject(new HttpError(503, `Не удалось запустить yt-dlp (${ytdlpPath()}): ${err.code || err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(killer);
        signal?.removeEventListener('abort', onAbort);
        if (onLine) { for (const w of ['stdout', 'stderr']) if (tail[w]) take(w, '\n'); }
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  } finally {
    if (queue) release();
  }
}

// Понятные причины ошибок yt-dlp (по-русски)
const degradedUntil = new Map(); // source -> ms: источник недавно не отдал звук (бот-проверка и т.п.)
function explain(res, src, timeoutMs) {
  const name = SOURCE_RU[src] || 'Источник';
  if (res.timedOut) return `${name} не отвечает с этого сервера (нет ответа за ${Math.round(timeoutMs / 1000)} с) — попробуйте SoundCloud-ссылку или проверьте deploy/music-check.sh`;
  const err = res.stderr.split('\n').filter((l) => /ERROR/.test(l)).pop() || res.stderr.trim().split('\n').pop() || '';
  console.warn(`[music] yt-dlp (${src || '?'}), код ${res.code}: ${err.slice(0, 400)}`);
  const e = err.toLowerCase();
  if (/sign in to confirm|not a bot|confirm you.re not/.test(e)) {
    return `${name}: проверка «подтвердите, что вы не бот» — нужен файл cookies (YTDLP_COOKIES, см. docs/MUSIC.md) или ссылка на SoundCloud`;
  }
  if (/private video|video unavailable|this video is not available|has been removed|404: not found|does not exist|no longer available/.test(e)) return 'видео/трек недоступен (удалён или приватный)';
  if (/not available in your country|geo.?restrict|blocked it in your country|not made this video available/.test(e)) return `${name} не отдаёт этот трек в стране сервера — попробуйте YTDLP_PROXY или другую ссылку`;
  if (/confirm your age|age.restricted|inappropriate for some users/.test(e)) return 'видео с возрастным ограничением — нужен файл cookies (YTDLP_COOKIES)';
  if (/http error 403|forbidden/.test(e)) return `${name}: доступ запрещён (403) — нужны cookies (YTDLP_COOKIES), YTDLP_PROXY или свежий yt-dlp`;
  if (/http error 429|too many requests/.test(e)) return `${name} временно ограничил запросы с сервера (429) — попробуйте позже`;
  if (/timed out|timeout|connection reset|network is unreachable|name or service not known|temporary failure in name resolution|unable to download (webpage|api)|connection refused|getaddrinfo/.test(e)) {
    return `${name} не отвечает с этого сервера — попробуйте SoundCloud-ссылку или проверьте deploy/music-check.sh`;
  }
  if (/requested format is not available|no video formats|n challenge|signature|js runtime|javascript/.test(e)) return `${name}: не удалось получить аудио (обновите yt-dlp: sudo systemctl start sozvon-ytdlp-update)`;
  if (/unsupported url/.test(e)) return 'эта ссылка не поддерживается';
  if (/is live|live event|premieres/.test(e)) return 'прямые эфиры не поддерживаются';
  return (err.replace(/^.*?ERROR:\s*/, '').replace(/\[[^\]]+\]\s*/g, '') || `yt-dlp завершился с кодом ${res.code}`).slice(0, 200);
}
export { runYtDlp, explain as explainYtDlp, parseLastJson };

/** Быстрая проверка YouTube с текущими cookies (поиск одного видео): { ok, error? }. */
export async function probeYouTube({ timeoutMs = 60_000 } = {}) {
  try {
    const res = await runYtDlp(['--flat-playlist', '--skip-download', '--print', 'id', 'ytsearch1:lofi hip hop radio'], { timeoutMs, queue: false });
    if (res.code === 0 && /^[\w-]{6,}$/m.test(res.stdout.trim())) return { ok: true };
    return { ok: false, error: explain(res, 'youtube', timeoutMs) };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 300) };
  }
}
const isBotCheck = (msg) => /не бот|cookies|не отвечает|403|429/.test(msg);

function parseLastJson(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* дальше */ }
  }
  try { return JSON.parse(stdout); } catch { return null; }
}

const srcOfExtractor = (ex) => {
  const e = String(ex || '').toLowerCase();
  if (e.startsWith('youtube')) return 'youtube';
  if (e.startsWith('soundcloud')) return 'soundcloud';
  return e || 'other';
};
const keyOf = (extractor, id) => (id ? `${srcOfExtractor(extractor)}:${id}` : null);
const slugTitle = (url) => {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return last.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
};
const pendingId = () => 'p-' + crypto.randomBytes(5).toString('hex');

// ---------- скачивание ----------
const inflight = new Map(); // ключ → Promise<track> (одновременные запросы одного трека не качают дважды)
function once(key, fn) {
  if (!key) return fn();
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Скачать аудио по ссылке (YouTube/SoundCloud/…) в библиотеку. Кэш: ключи aliases + url + extractor:id.
 * meta — метаданные для отображения (например, из Spotify), иначе берутся из yt-dlp.
 */
export function downloadUrl(url, { addedBy = null, aliases = [], meta = null, src = null } = {}) {
  const uKey = urlKey(url);
  const cached = findBySource([...aliases, uKey]);
  if (cached) return Promise.resolve(cached);
  return once(`dl:${uKey || url}`, async () => {
    const again = findBySource([...aliases, uKey]);
    if (again) return again;
    const source = src || parseMusicLink(url)?.kind || 'other';
    const musicDir = getMusicDir();
    const tmpDir = path.join(musicDir, `.dl-${crypto.randomBytes(5).toString('hex')}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    const args = ['--no-playlist', '--no-progress', '--match-filters', '!is_live',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best'];
    // с ffmpeg: m4a/mp3 оставляем как есть, остальное (opus/webm, HLS) → mp3 (играет во всех браузерах)
    if (hasFfmpeg()) args.push('-x', '--audio-format', 'm4a>m4a/mp3>mp3/mp3', '--audio-quality', '5');
    args.push('--max-filesize', `${Math.floor(MUSIC_MAX_BYTES / 1024 / 1024)}M`,
      '-o', path.join(tmpDir, '%(id)s.%(ext)s'),
      '--print', 'after_move:%(.{id,title,track,artist,uploader,channel,duration,extractor_key,webpage_url,thumbnail,filepath})j',
      '--', url);
    try {
      const timeoutMs = downloadTimeoutMs();
      const res = await runYtDlp(args, { timeoutMs });
      const info = parseLastJson(res.stdout);
      const filePath = info?.filepath && path.resolve(info.filepath);
      if (res.code !== 0 || !filePath || !filePath.startsWith(tmpDir + path.sep) || !fs.existsSync(filePath)) {
        if (res.code === 0 && !res.timedOut) {
          // yt-dlp пропускает слишком большие файлы и эфиры с кодом 0
          throw new HttpError(400, /larger than max-filesize|file is larger/i.test(res.stdout + res.stderr)
            ? 'трек слишком большой (больше 50 МБ)' : 'трек пропущен (прямой эфир или слишком большой файл)');
        }
        const why = explain(res, source, timeoutMs);
        if (isBotCheck(why)) degradedUntil.set(source, Date.now() + 10 * 60_000);
        throw new HttpError(502, why);
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!AUDIO_EXT.has(ext)) throw new HttpError(400, `скачан файл неподдерживаемого формата (${ext || 'без расширения'})`);
      const st = await fsp.stat(filePath);
      if (st.size > MUSIC_MAX_BYTES) throw new HttpError(400, 'трек слишком большой (больше 50 МБ)');
      const title = String(meta?.title || info.track || info.title || slugTitle(url) || 'Трек').trim();
      const artist = String(meta?.artist ?? (info.artist || info.uploader || info.channel || '')).trim();
      const shown = artist && !title.toLowerCase().includes(artist.toLowerCase()) ? `${artist} - ${title}` : title;
      const finalName = uniqueName(musicDir, sanitizeFileName(shown.slice(0, 120) + ext));
      await fsp.rename(filePath, path.join(musicDir, finalName));
      degradedUntil.delete(source);
      return await registerFile(finalName, addedBy, {
        title, artist, duration: Number(info.duration) || meta?.duration || 0,
        thumb: typeof info.thumbnail === 'string' ? info.thumbnail : null,
        sources: [...aliases, uKey, keyOf(info.extractor_key, info.id), info.webpage_url && urlKey(info.webpage_url)],
      });
    } finally {
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// ---------- поиск ----------
/** Лучшая миниатюра записи yt-dlp (не шире 1280 px): только для поиска обложки на сервере */
function bestThumb(e) {
  const list = Array.isArray(e.thumbnails) ? e.thumbnails.filter((t) => t && typeof t.url === 'string' && /^https?:\/\//.test(t.url)) : [];
  if (list.length) {
    const ok = list.filter((t) => !t.width || t.width <= 1280);
    const pick = (ok.length ? ok : list).reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
    return pick.url;
  }
  return typeof e.thumbnail === 'string' && /^https?:\/\//.test(e.thumbnail) ? e.thumbnail : null;
}

function normEntry(e, fallback = {}) {
  if (!e || typeof e !== 'object') return null;
  const url = e.webpage_url || e.url || null;
  if (!url || !/^https?:\/\//.test(url)) return null;
  const extractor = e.ie_key || e.extractor_key || fallback.extractor;
  return {
    id: e.id ? String(e.id) : null,
    url,
    title: String(e.title || e.track || slugTitle(url) || '').trim(),
    artist: String(e.artist || e.uploader || e.channel || fallback.artist || '').trim(),
    duration: Number(e.duration) > 0 ? Math.round(Number(e.duration)) : 0,
    key: keyOf(extractor, e.id),
    src: srcOfExtractor(extractor),
    thumb: bestThumb(e),
  };
}

async function searchOn(src, query, n = 3) {
  const timeoutMs = metaTimeoutMs();
  const res = await runYtDlp(['-J', '--flat-playlist', '--', `${SEARCH_PREFIX[src]}${n}:${query}`], { timeoutMs });
  const json = res.code === 0 ? parseLastJson(res.stdout) : null;
  if (!json) {
    const why = explain(res, src, timeoutMs);
    if (isBotCheck(why)) degradedUntil.set(src, Date.now() + 10 * 60_000);
    throw new HttpError(502, why);
  }
  return (json.entries || []).map((e) => normEntry(e, { extractor: src })).filter(Boolean);
}

function pickCandidate(entries, expected, tol) {
  if (!expected) {
    // Текстовый поиск: сначала обычные треки (≤ MUSIC_SEARCH_MAX_DURATION, по умолчанию 15 мин),
    // чтобы «!play песня» не включал часовые лупы и миксы; если таких нет — что-то до 3 ч.
    const max = num('MUSIC_SEARCH_MAX_DURATION', 900, 60);
    return entries.find((e) => e.duration && e.duration <= max)
      || entries.find((e) => !e.duration || e.duration <= 3 * 3600) || null;
  }
  return entries.find((e) => e.duration && Math.abs(e.duration - expected) <= tol)
    || entries.find((e) => !e.duration) || null;
}

function orderedSources() {
  const list = searchSources();
  const now = Date.now();
  // источник, который недавно не отдал звук (бот-проверка YouTube и т.п.), — в конец списка
  return [...list.filter((s) => !(degradedUntil.get(s) > now)), ...list.filter((s) => degradedUntil.get(s) > now)];
}

/** Найти и скачать трек по тексту «исполнитель - название» в MUSIC_SEARCH_SOURCES. */
export async function searchAndDownload(query, { expected = 0, aliases = [], meta = null, addedBy = null } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) throw new HttpError(400, 'Пустой запрос');
  const cached = findBySource(aliases);
  if (cached) return cached;
  return once(`q:${aliases.find(Boolean) || `${q.toLowerCase()}:${expected}`}`, async () => {
    const problems = [];
    let mismatch = false;
    for (const src of orderedSources()) {
      let entries;
      const tag = (msg) => (msg.startsWith(SOURCE_RU[src]) ? `${SOURCE_RU[src]}: ${msg.slice(SOURCE_RU[src].length).replace(/^\s*:?\s*/, '')}` : `${SOURCE_RU[src]}: ${msg}`);
      try { entries = await searchOn(src, q); } catch (err) { problems.push(tag(err.message)); continue; }
      const cand = pickCandidate(entries, expected, durationTolerance());
      if (!cand) { if (entries.length) mismatch = true; continue; }
      const hit = findBySource([cand.key, urlKey(cand.url)], aliases);
      if (hit) return hit;
      try {
        return await downloadUrl(cand.url, { addedBy, aliases: [...aliases, cand.key].filter(Boolean), meta, src });
      } catch (err) {
        problems.push(tag(err.message));
      }
    }
    if (problems.length) {
      // одинаковые причины у разных источников не повторяем
      const byReason = new Map();
      for (const p of problems) {
        const [, who, why] = p.match(/^([^:]+): ([\s\S]*)$/) || [null, '', p];
        byReason.set(why, [...(byReason.get(why) || []), who]);
      }
      throw new HttpError(502, [...byReason].map(([why, who]) => `${who.join(' и ')}: ${why}`).join('; '));
    }
    throw new HttpError(404, mismatch
      ? `Ничего не нашёл с подходящей длительностью по запросу «${q}»`
      : `Ничего не нашёл по запросу «${q}»`);
  });
}

// ---------- плейлисты ----------
const resolveCache = new Map(); // url → {at, value}
const RESOLVE_TTL_MS = 10 * 60_000;

async function flatPlaylist(url, src) {
  const limit = playlistLimit();
  const cacheKey = `${url}#${limit}`;
  const hit = resolveCache.get(cacheKey);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const timeoutMs = metaTimeoutMs();
  const res = await runYtDlp(['-J', '--flat-playlist', '--playlist-end', String(limit), '--', url], { timeoutMs });
  const json = res.code === 0 ? parseLastJson(res.stdout) : null;
  if (!json) throw new HttpError(502, explain(res, src, timeoutMs));
  const fallback = { extractor: src === 'soundcloud' ? 'Soundcloud' : 'Youtube', artist: json.uploader || json.channel || '' };
  const entries = (json._type === 'playlist' || Array.isArray(json.entries) ? (json.entries || []) : [json])
    .map((e) => normEntry(e, fallback)).filter(Boolean).slice(0, limit);
  const value = {
    title: String(json.title || 'плейлист').slice(0, 200),
    total: Number(json.playlist_count) || entries.length,
    entries,
  };
  resolveCache.set(cacheKey, { at: Date.now(), value });
  if (resolveCache.size > 100) resolveCache.delete(resolveCache.keys().next().value);
  return value;
}

/** Обложка «ожидающего» элемента: запоминаем миниатюру источника (сервер скачает её сам), клиенту — наш адрес */
function withCover(item, thumb) {
  const cover = coverUrl(item.ref?.key || titleCoverKey(item.artist, item.title), { artist: item.artist, title: item.title, thumbs: thumb ? [thumb] : [] });
  if (cover) item.cover = cover;
  return item;
}

function pendingFromEntry(e, src) {
  return withCover({
    pending: true, id: pendingId(), title: e.title || 'Без названия', artist: e.artist || '', duration: e.duration || 0,
    source: src, ref: { url: e.url, key: e.key || urlKey(e.url) },
  }, e.thumb);
}

function pendingFromSpotify(t) {
  return withCover({
    pending: true, id: pendingId(), title: t.title, artist: t.artist, duration: t.duration || 0, source: 'spotify',
    ref: { key: t.spotifyId ? `spotify:${t.spotifyId}` : null, query: [t.mainArtist, t.title].filter(Boolean).join(' - ') },
  }, t.image);
}

/**
 * Разобрать ввод !play: ссылку или текст.
 * @returns {Promise<{track:object, note?:string} | {playlist:{title,source,type,total,count,truncated,viaEmbed?}, items:object[]}>}
 */
export async function resolveInput(input, { addedBy = null } = {}) {
  const s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Укажите ссылку или название трека');
  let link = parseMusicLink(s);
  if (!link) {
    // текст → поиск в интернете
    return { track: await searchAndDownload(s, { addedBy }) };
  }
  const limit = playlistLimit();
  if (link.kind === 'spotify') {
    let ref = link.type === 'unknown' ? await expandShortLink(s) : { type: link.type, id: link.id };
    if (ref.type === 'track') {
      const cached = findBySource([`spotify:${ref.id}`]);
      if (cached) return { track: cached };
    }
    const data = await fetchSpotify(ref, { limit });
    if (!data.tracks.length) throw new HttpError(404, `В этом ${TYPE_RU[ref.type] === 'трек' ? 'треке' : TYPE_RU[ref.type] === 'альбом' ? 'альбоме' : 'плейлисте'} Spotify нет треков`);
    const items = data.tracks.map(pendingFromSpotify);
    return {
      playlist: {
        title: data.title, source: 'spotify', type: ref.type, total: data.total, count: items.length,
        truncated: data.total > items.length || (data.viaEmbed && !spotifyApiConfigured() && items.length >= 100 && playlistLimit() > 100),
        viaEmbed: !!data.viaEmbed,
      },
      items,
    };
  }
  if ((link.kind === 'youtube' && link.type === 'playlist') || (link.kind === 'soundcloud' && link.type === 'set')) {
    const pl = await flatPlaylist(link.url, link.kind);
    if (!pl.entries.length) throw new HttpError(404, 'Плейлист пустой или недоступен');
    // кэш: уже скачанные элементы сразу готовы (их не нужно качать)
    const items = pl.entries.map((e) => findBySource([e.key, urlKey(e.url)]) || pendingFromEntry(e, link.kind));
    return {
      playlist: { title: pl.title, source: link.kind, type: 'playlist', total: pl.total, count: items.length, truncated: pl.total > items.length },
      items,
    };
  }
  if (link.kind === 'youtube' || link.kind === 'soundcloud' || YTDLP_HOSTS.test(new URL(link.url).hostname)) {
    const aliases = link.kind === 'youtube' && link.id ? [`youtube:${link.id}`] : [];
    const track = await downloadUrl(link.url, { addedBy, aliases, src: link.kind });
    return { track, note: link.listId ? 'list' : undefined };
  }
  return { track: await importFromUrl(s, addedBy) };
}

/** Скачать ожидающий элемент очереди (перед воспроизведением / предзагрузка). */
export async function fetchPending(item, { addedBy = null } = {}) {
  if (!item || typeof item !== 'object') throw new HttpError(400, 'Нет элемента очереди');
  const ref = item.ref && typeof item.ref === 'object' ? item.ref : {};
  const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
  const key = /^[a-z]+:[^\s]{1,200}$/.test(str(ref.key)) ? str(ref.key) : null;
  const url = str(ref.url);
  const meta = item.source === 'spotify' ? { title: str(item.title, 200), artist: str(item.artist, 200), duration: Number(item.duration) || 0 } : null;
  if (url) {
    const link = parseMusicLink(url);
    if (!link || link.kind === 'spotify') throw new HttpError(400, 'Некорректная ссылка в очереди');
    return downloadUrl(link.url, { addedBy, aliases: [key], meta, src: link.kind });
  }
  const query = str(ref.query, 200) || [str(item.artist, 100), str(item.title, 150)].filter(Boolean).join(' - ');
  return searchAndDownload(query, { expected: Number(item.duration) || 0, aliases: [key], meta, addedBy });
}

// ---------- импорт по ссылке (REST /api/music/import, модалка «Библиотека») ----------
export async function importFromUrl(rawUrl, addedBy) {
  const u = parseUrl(rawUrl);
  const link = parseMusicLink(u.toString());
  if (link?.kind === 'spotify' || (link?.kind === 'youtube' && link.type === 'playlist') || (link?.kind === 'soundcloud' && link.type === 'set')) {
    throw new HttpError(400, 'Это плейлист/Spotify — добавьте его командой в чате: !play <ссылка>');
  }
  if (YTDLP_HOSTS.test(u.hostname)) {
    if (!hasYtDlp()) throw new HttpError(400, 'Для ссылок YouTube и других сайтов нужен yt-dlp — он не установлен на сервере. Установите yt-dlp (см. docs/MUSIC.md) или используйте прямую ссылку на аудиофайл.');
    const aliases = link?.kind === 'youtube' && link.id ? [`youtube:${link.id}`] : [];
    return downloadUrl(link?.url || u.toString(), { addedBy, aliases, src: link?.kind });
  }
  const track = await downloadDirect(u, addedBy);
  if (track) return track;
  if (hasYtDlp()) return downloadUrl(u.toString(), { addedBy });
  throw new HttpError(400, 'По ссылке не аудиофайл. Нужна прямая ссылка на mp3/ogg/m4a… (для YouTube и других сайтов установите yt-dlp)');
}

// ---------- автоплей: похожие треки (радио-микс YouTube) ----------
// Микс «RD<id>» строит сам YouTube по видео-затравке. Затравка — YouTube-id трека (из ключей кэша
// библиотеки или ссылки), иначе ищем «<исполнитель> <название>» на YouTube и берём id найденного.
/** Нормализованное название для сравнения «уже играло» (бот считает так же: bot/index.js) */
export const titleKey = (title) => 't:' + String(title || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * @param {{id?:string, title?:string, artist?:string, ref?:{url?:string,key?:string}}} seed — последний сыгранный трек
 * @param {{exclude?:string[], count?:number}} opts — exclude: id треков библиотеки, ключи источников, «t:<название>»
 * @returns {Promise<{seed:{videoId:string, via:'youtube'|'search'}, items:object[]}>} items — «ожидающие» с autoplay:true
 */
export async function similarTracks(seed, { exclude = [], count = 4 } = {}) {
  if (!seed || typeof seed !== 'object') throw new HttpError(400, 'Нет трека для автоплея');
  const n = Math.min(5, Math.max(3, Number(count) || 4));
  const ex = new Set(exclude.filter((x) => typeof x === 'string').slice(0, 300).map((x) => x.slice(0, 220)));
  for (const k of [...ex]) findTrackRec(k)?.sources?.forEach((x) => ex.add(x));
  const rec = typeof seed.id === 'string' ? findTrackRec(seed.id) : null;
  const ref = seed.ref && typeof seed.ref === 'object' ? seed.ref : {};
  const keys = [...(rec?.sources || [])];
  if (typeof ref.key === 'string') keys.push(ref.key);
  if (typeof ref.url === 'string') {
    const l = parseMusicLink(ref.url);
    if (l?.kind === 'youtube' && l.id) keys.push(`youtube:${l.id}`);
  }
  let vid = keys.map((k) => /^youtube:([A-Za-z0-9_-]{11})$/.exec(k)?.[1]).find(Boolean) || null;
  let via = 'youtube';
  if (!vid) {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const q = [str(rec?.artist ?? seed.artist), str(rec?.title || seed.title)].filter(Boolean).join(' ').slice(0, 200);
    if (!q) throw new HttpError(400, 'У трека нет названия — не по чему искать похожие');
    const cand = pickCandidate(await searchOn('youtube', q, 3), 0, 0);
    vid = cand?.src === 'youtube' && YT_ID.test(cand.id || '') ? cand.id : null;
    if (!vid) throw new HttpError(404, `не нашёл «${q}» на YouTube`);
    via = 'search';
  }
  ex.add(`youtube:${vid}`);
  if (rec?.title) ex.add(titleKey(rec.title));
  const timeoutMs = metaTimeoutMs();
  const res = await runYtDlp(['-J', '--flat-playlist', '--yes-playlist', '--playlist-end', '30', '--',
    `https://www.youtube.com/watch?v=${vid}&list=RD${vid}`], { timeoutMs });
  const json = res.code === 0 ? parseLastJson(res.stdout) : null;
  if (!json) throw new HttpError(502, explain(res, 'youtube', timeoutMs));
  const max = num('MUSIC_SEARCH_MAX_DURATION', 900, 60);
  const items = [];
  for (const raw of json.entries || []) {
    const e = normEntry(raw, { extractor: 'Youtube' });
    if (!e?.key || (e.duration && e.duration > max)) continue;
    const tk = titleKey(e.title);
    if (ex.has(e.key) || ex.has(urlKey(e.url)) || ex.has(tk)) continue;
    const hit = findBySource([e.key, urlKey(e.url)]);
    if (hit && (ex.has(hit.id) || ex.has(titleKey(hit.title)))) continue;
    ex.add(tk);
    items.push({ ...pendingFromEntry(e, 'youtube'), autoplay: true });
    if (items.length >= n) break;
  }
  return { seed: { videoId: vid, via }, items };
}
