// Обложки треков (DATA_DIR/covers): своя картинка источника (миниатюра YouTube/SoundCloud из yt-dlp,
// обложка альбома Spotify), иначе — поиск по «исполнитель название» в бесплатных API без ключей:
// Deezer (api.deezer.com/search → album.cover_medium), затем iTunes Search (artworkUrl100 → 600x600).
//
// Клиенту чужие адреса не отдаём никогда (приватность + блокировки в РФ): у трека есть только
// cover: '/media/covers/<id>.jpg' — наш адрес. Картинка ищется лениво, при первом запросе этого адреса
// (за ней приходят плеер, очередь, библиотека, Media Session), кладётся на диск и дальше отдаётся с диска.
//
// id обложки = sha1(ключ).slice(0, 20); ключ — ключ кэша источника («youtube:<id>», «spotify:<id>» …),
// а если его нет — «t:<исполнитель>|<название>». Ожидающий элемент очереди и скачанный из него трек
// имеют один ключ (ключ источника становится первым в tracks[].sources) — обложка ищется один раз.
//
// Настройки (env читается при каждом обращении — удобно для тестов):
//   COVERS=0                    — выключить (у треков нет поля cover, /media/covers/* → 204 без картинки)
//   COVERS_PROXY=http://h:p     — HTTP-прокси (CONNECT) для всех запросов за обложками; по умолчанию напрямую
//   COVERS_DEEZER_BASE / COVERS_ITUNES_BASE — адреса API (тесты: фейковый сервер)
//   COVERS_IMAGE_HOSTS          — с каких хостов можно качать картинки (через запятую, суффиксы доменов)
//   COVERS_MIN_INTERVAL_MS (300), COVERS_MAX_PER_HOUR (600) — ограничение запросов к Deezer/iTunes
//   COVERS_MISS_TTL_H (24)      — сколько помнить «обложки нет» (при сетевых ошибках — 15 минут)
//   COVERS_WAIT_MS (12000)      — сколько запрос картинки ждёт поиска, прежде чем ответить 204 (нет картинки)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';

const num = (k, d, min = 0) => { const v = Number(process.env[k]); return process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(v) && v >= min ? v : d; };
export const coversEnabled = () => !['0', 'false', 'off', 'no'].includes(String(process.env.COVERS ?? '1').trim().toLowerCase());
const base = (k, d) => String(process.env[k] || d).replace(/\/+$/, '');
const DEEZER_BASE = () => base('COVERS_DEEZER_BASE', 'https://api.deezer.com');
const ITUNES_BASE = () => base('COVERS_ITUNES_BASE', 'https://itunes.apple.com');
const DEFAULT_HOSTS = 'ytimg.com,ggpht.com,googleusercontent.com,scdn.co,spotifycdn.com,sndcdn.com,dzcdn.net,deezer.com,mzstatic.com';
const SIZE = 300;                    // сторона итоговой картинки, px
const MAX_STORED = 300 * 1024;       // без ресайза храним оригинал не больше 300 КБ
const MAX_DOWNLOAD = 3 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const COVER_ID_RE = /^[a-f0-9]{20}$/;

let dir = null;
export function initCovers(dataDir) {
  dir = path.join(dataDir, 'covers');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith('.tmp-')) fs.rmSync(path.join(dir, f), { force: true });
  return dir;
}
export const coversDir = () => dir;

// ---------- ключи и реестр ----------
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Ключ по названию: «t:<исполнитель>|<название>» (null, если названия нет) */
export function titleCoverKey(artist, title) {
  const t = norm(title);
  return t ? `t:${norm(artist)}|${t}`.slice(0, 300) : null;
}
export const coverIdOf = (key) => crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
export const coverPath = (id) => `/media/covers/${id}.jpg`;

const REGISTRY_MAX = 20_000;
const registry = new Map(); // id → {key, artist, title, thumbs:[]}
let resolver = null;        // (id) → info | null — для обложек, о которых реестр ещё не знает (после перезапуска)
export function setCoverResolver(fn) { resolver = typeof fn === 'function' ? fn : null; }

/**
 * Запомнить, что известно о треке с этим ключом (миниатюры источника, исполнитель, название),
 * и вернуть наш адрес обложки. null — обложки выключены или ключа нет.
 */
export function coverUrl(key, { artist = '', title = '', thumbs = [] } = {}) {
  if (!key || !coversEnabled()) return null;
  const id = coverIdOf(key);
  let e = registry.get(id);
  if (!e) {
    e = { key, artist: '', title: '', thumbs: [] };
    if (registry.size >= REGISTRY_MAX) registry.delete(registry.keys().next().value);
  } else registry.delete(id); // LRU: в конец
  registry.set(id, e);
  if (!e.title && title) e.title = String(title).slice(0, 200);
  if (!e.artist && artist) e.artist = String(artist).slice(0, 200);
  for (const u of [].concat(thumbs || [])) {
    if (typeof u === 'string' && /^https?:\/\//.test(u) && !e.thumbs.includes(u) && e.thumbs.length < 4) e.thumbs.push(u.slice(0, 1000));
  }
  return coverPath(id);
}

/** Миниатюра YouTube по ключу «youtube:<id>» (для треков, у которых нет сохранённой) */
export function youtubeThumb(key) {
  const m = /^youtube:([A-Za-z0-9_-]{11})$/.exec(String(key || ''));
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

// ---------- статистика (для отладки и тестов) ----------
export const coverStats = { lookups: 0, hits: 0, misses: 0, apiCalls: 0, limited: 0 };

// ---------- HTTP ----------
function imageHosts() {
  return String(process.env.COVERS_IMAGE_HOSTS || DEFAULT_HOSTS).split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}
export function allowedImageUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return imageHosts().some((h) => host === h || host.endsWith('.' + h));
}

/** GET → {status, headers, body:Buffer}; COVERS_PROXY — через HTTP CONNECT. Тело не больше maxBytes. */
function httpGet(url, { maxBytes = MAX_DOWNLOAD, accept = '*/*', hops = 0, allow = null } = {}) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { 'user-agent': UA, accept, 'accept-language': 'en' };
  const proxyRaw = process.env.COVERS_PROXY;
  return new Promise((resolve, reject) => {
    let done = false;
    let req = null, conn = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { req?.destroy(); conn?.destroy(); reject(err); } else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), HTTP_TIMEOUT_MS);
    const onRes = (r) => {
      const loc = r.headers.location;
      if (loc && r.statusCode >= 300 && r.statusCode < 400 && hops < 4) {
        r.resume();
        const next = new URL(loc, url).toString();
        clearTimeout(timer);
        done = true;
        // редирект картинки — снова только на разрешённые хосты (не во внутреннюю сеть)
        if (allow && !allow(next)) { reject(new Error('redirect to a host that is not allowed')); return; }
        httpGet(next, { maxBytes, accept, hops: hops + 1, allow }).then(resolve, reject);
        return;
      }
      const len = Number(r.headers['content-length'] || 0);
      if (len > maxBytes) { r.destroy(); finish(new Error('too large')); return; }
      const chunks = [];
      let size = 0;
      r.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { r.destroy(); finish(new Error('too large')); return; }
        chunks.push(c);
      });
      r.on('end', () => finish(null, { status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
      r.on('error', (e) => finish(e));
    };
    if (!proxyRaw) {
      req = lib.request(target, { method: 'GET', headers }, onRes);
      req.on('error', (e) => finish(e));
      req.end();
      return;
    }
    let proxy;
    try { proxy = new URL(proxyRaw); } catch { finish(new Error('bad COVERS_PROXY')); return; }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const auth = proxy.username
      ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }
      : {};
    conn = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${target.hostname}:${port}`, headers: { host: `${target.hostname}:${port}`, ...auth } });
    conn.on('error', (e) => finish(e));
    conn.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) { socket.destroy(); finish(new Error(`proxy ${pres.statusCode}`)); return; }
      req = lib.request(target, {
        method: 'GET', headers: { ...headers, host: target.host },
        createConnection: () => (target.protocol === 'https:' ? tls.connect({ socket, servername: target.hostname }) : socket),
      }, onRes);
      req.on('error', (e) => finish(e));
      req.end();
    });
    conn.end();
  });
}

async function getJson(url) {
  const r = await httpGet(url, { maxBytes: 2 * 1024 * 1024, accept: 'application/json' });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8'));
}

// ---------- ограничение запросов к Deezer/iTunes ----------
let apiChain = Promise.resolve();
let lastApiAt = 0;
const hourWindow = [];
/** Последовательно, не чаще раза в COVERS_MIN_INTERVAL_MS и не больше COVERS_MAX_PER_HOUR в час */
function throttled(fn) {
  const run = apiChain.then(async () => {
    const now = Date.now();
    while (hourWindow.length && now - hourWindow[0] > 3600_000) hourWindow.shift();
    if (hourWindow.length >= num('COVERS_MAX_PER_HOUR', 600, 1)) { coverStats.limited++; throw Object.assign(new Error('rate limited'), { limited: true }); }
    const wait = lastApiAt + num('COVERS_MIN_INTERVAL_MS', 300) - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastApiAt = Date.now();
    hourWindow.push(lastApiAt);
    coverStats.apiCalls++;
    return fn();
  });
  apiChain = run.catch(() => {});
  return run;
}

// ---------- поиск ----------
/** «Исполнитель - Название (Official Video) [4K]» → {artist, title} для поиска */
export function searchTerms(artist, title) {
  let a = String(artist || '').trim();
  let t = String(title || '').trim();
  if (!a) {
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) { a = m[1]; t = m[2]; }
  }
  const clean = (s) => s
    .replace(/\((?:[^)]*\b(?:official|video|audio|lyrics?|lyric|visuali[sz]er|remaster(?:ed)?|hd|4k|mv|clip|клип|премьера|live)\b[^)]*)\)/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, ' ')
    .replace(/\s*-\s*topic$/i, ' ')
    .replace(/[|•]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  a = clean(a).split(/\s*,\s*|\s+&\s+|\s+x\s+/i)[0] || '';
  t = clean(t);
  // «Канал - Название»: исполнитель уже в названии — не дублируем
  if (a && t.toLowerCase().startsWith(a.toLowerCase() + ' - ')) t = t.slice(a.length + 3);
  return { artist: a.slice(0, 100), title: t.slice(0, 150) };
}

const sameArtist = (want, got) => {
  const a = norm(want), b = norm(got);
  return !a || !b || a === b || a.includes(b) || b.includes(a);
};

async function viaDeezer({ artist, title }) {
  const q = [artist, title].filter(Boolean).join(' ');
  const json = await throttled(() => getJson(`${DEEZER_BASE()}/search?q=${encodeURIComponent(q)}&limit=5`));
  if (json?.error) throw new Error(`Deezer: ${json.error.message || json.error.type || 'ошибка'}`);
  const list = Array.isArray(json?.data) ? json.data : [];
  const hit = list.find((d) => d?.album?.cover_medium && sameArtist(artist, d.artist?.name)) || null;
  return hit ? String(hit.album.cover_medium) : null;
}

async function viaItunes({ artist, title }) {
  const term = [artist, title].filter(Boolean).join(' ');
  const json = await throttled(() => getJson(`${ITUNES_BASE()}/search?term=${encodeURIComponent(term)}&entity=song&limit=5`));
  const list = Array.isArray(json?.results) ? json.results : [];
  const hit = list.find((r) => r?.artworkUrl100 && sameArtist(artist, r.artistName)) || null;
  return hit ? String(hit.artworkUrl100).replace(/\/(\d+)x(\d+)(bb)?\.(jpg|png|webp)$/i, '/600x600bb.$4') : null;
}

// ---------- картинки ----------
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

let ffmpegOk = null;
function hasFfmpeg() {
  if (['0', 'off', 'false'].includes(String(process.env.COVERS_FFMPEG).toLowerCase())) return false;
  if (['1', 'true', 'yes'].includes(String(process.env.SOZVON_NO_FFMPEG).toLowerCase())) return false;
  if (ffmpegOk === null) {
    try { ffmpegOk = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { ffmpegOk = false; }
  }
  return ffmpegOk;
}

let sharpMod; // undefined — не проверяли, null — нет
async function getSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try { sharpMod = (await import('sharp')).default; } catch { sharpMod = null; }
  return sharpMod;
}

function ffmpegSquare(buf) {
  // Квадрат из центра → 300×300 JPEG. Миниатюра YouTube 4:3 (hqdefault) — это 16:9 с чёрными полосами:
  // берём квадрат высотой 3/4 кадра, чтобы полосы не попали.
  const side = "if(eq(iw*3\\,ih*4)\\,ih*3/4\\,min(iw\\,ih))";
  const vf = `crop=w='${side}':h='${side}',scale=${SIZE}:${SIZE}:flags=lanczos`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', vf,
      '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      const b = Buffer.concat(out);
      if (code === 0 && sniff(b) === 'jpg') resolve(b); else reject(new Error(`ffmpeg ${code}: ${err.trim().slice(0, 200)}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

/** Картинка → {ext, body}: 300×300 JPEG (sharp или ffmpeg), иначе оригинал не больше 300 КБ */
async function normalizeImage(buf) {
  const kind = sniff(buf);
  if (!kind) return null;
  const sharp = await getSharp();
  if (sharp) {
    try { return { ext: 'jpg', body: await sharp(buf).resize(SIZE, SIZE, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer() }; } catch { /* дальше */ }
  }
  if (hasFfmpeg()) {
    try { return { ext: 'jpg', body: await ffmpegSquare(buf) }; } catch (e) { console.warn('[covers] ffmpeg:', e.message); }
  }
  return buf.length <= MAX_STORED ? { ext: kind, body: buf } : null;
}

async function fetchImage(url) {
  if (!allowedImageUrl(url)) return null;
  const r = await httpGet(url, { accept: 'image/*', allow: allowedImageUrl });
  if (r.status !== 200) return null;
  return normalizeImage(r.body);
}

// ---------- диск ----------
function fileOf(id) {
  if (!dir) return null;
  for (const ext of ['jpg', 'webp', 'png']) {
    const f = path.join(dir, `${id}.${ext}`);
    if (fs.existsSync(f)) return { file: f, type: TYPES[ext] };
  }
  return null;
}
export const hasCover = (id) => !!fileOf(id);

function missActive(id) {
  try {
    const { until } = JSON.parse(fs.readFileSync(path.join(dir, `${id}.miss`), 'utf8'));
    return Number(until) > Date.now();
  } catch { return false; }
}

async function store(id, img) {
  const tmp = path.join(dir, `.tmp-${id}-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.writeFile(tmp, img.body);
  await fsp.rename(tmp, path.join(dir, `${id}.${img.ext}`));
  await fsp.rm(path.join(dir, `${id}.miss`), { force: true });
}

// ---------- поиск обложки ----------
const inflight = new Map(); // id → Promise<boolean>
const MAX_PENDING = 200;

/**
 * Найти и сохранить обложку (порядок: миниатюры источника → Deezer → iTunes).
 * @returns {Promise<'hit'|'miss'|'cached'|'skipped'>}
 */
export function ensureCover(id, info) {
  if (!dir || !coversEnabled() || !COVER_ID_RE.test(id)) return Promise.resolve('skipped');
  if (fileOf(id)) return Promise.resolve('cached');
  if (missActive(id)) return Promise.resolve('miss');
  const cur = inflight.get(id);
  if (cur) return cur;
  if (inflight.size >= MAX_PENDING) return Promise.resolve('skipped');
  const p = lookup(id, info).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// не больше 4 поисков одновременно (плейлист на 100 треков не должен открыть 100 соединений)
const LOOKUP_PARALLEL = 4;
let lookupsRunning = 0;
const lookupWaiters = [];
async function lookup(id, info) {
  if (lookupsRunning >= LOOKUP_PARALLEL) await new Promise((r) => lookupWaiters.push(r));
  lookupsRunning++;
  try { return await lookupNow(id, info); } finally { lookupsRunning--; lookupWaiters.shift()?.(); }
}

async function lookupNow(id, info) {
  if (fileOf(id)) return 'cached';
  coverStats.lookups++;
  let errors = 0;
  let limited = false;
  const thumbs = [...(info.thumbs || [])];
  const yt = youtubeThumb(info.key);
  if (yt && !thumbs.includes(yt)) thumbs.push(yt);
  for (const u of thumbs) {
    try {
      const img = await fetchImage(u);
      if (img) { await store(id, img); coverStats.hits++; return 'hit'; }
    } catch (e) { errors++; }
  }
  const terms = searchTerms(info.artist, info.title);
  if (terms.title) {
    for (const api of [viaDeezer, viaItunes]) {
      try {
        const url = await api(terms);
        if (!url) continue;
        const img = await fetchImage(url);
        if (img) { await store(id, img); coverStats.hits++; return 'hit'; }
      } catch (e) {
        errors++;
        if (e.limited) limited = true;
      }
    }
  }
  coverStats.misses++;
  // «нет обложки» запоминаем; если мешали сетевые ошибки/лимит — ненадолго
  const ttl = errors || limited ? 15 * 60_000 : num('COVERS_MISS_TTL_H', 24) * 3600_000;
  if (ttl > 0) {
    await fsp.writeFile(path.join(dir, `${id}.miss`), JSON.stringify({ until: Date.now() + ttl, errors })).catch(() => {});
  }
  return 'miss';
}

/** Сведения для поиска по id: из реестра или через resolver (библиотека после перезапуска) */
export function coverInfo(id) {
  let e = registry.get(id);
  if (!e && resolver) {
    try { resolver(id); } catch { /* ignore */ }
    e = registry.get(id);
  }
  return e || null;
}

// ---------- HTTP-обработчик GET /media/covers/:file ----------
// Доступ — как у файлов музыки (/media/music): без входа, по непредсказуемому имени. Поиск в интернете
// запускается только для обложек, которые сервер сам выдал трекам (реестр), — не по произвольному запросу.
// Обложки нет (не нашлась, ещё ищется, выключены) — 204 без тела: <img> покажет значок ноты, а браузер
// не пишет в консоль ошибку загрузки (как было бы на 404). Некорректное имя — 404.
export async function serveCover(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const m = /^([a-f0-9]{20})\.jpg$/.exec(String(req.params.file || ''));
  if (!m) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).json({ error: 'Обложка не найдена' }); }
  const noCover = (maxAge = 0) => {
    res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-store');
    res.status(204).end();
  };
  if (!coversEnabled() || !dir) return noCover();
  const id = m[1];
  let f = fileOf(id);
  if (!f) {
    const info = coverInfo(id);
    if (!info) return noCover();
    if (missActive(id)) return noCover(600);
    const wait = num('COVERS_WAIT_MS', 12_000);
    let timer;
    await Promise.race([
      ensureCover(id, info).catch(() => 'miss'),
      new Promise((r) => { timer = setTimeout(r, wait); }),
    ]);
    clearTimeout(timer);
    f = fileOf(id);
    if (!f) return noCover();
  }
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.type(f.type);
  res.sendFile(path.basename(f.file), { root: dir }, (err) => { if (err && !res.headersSent) noCover(); });
}

/** Для тестов: забыть реестр и счётчики (файлы на диске остаются) */
export function _resetCoversForTests() {
  registry.clear();
  inflight.clear();
  for (const k of Object.keys(coverStats)) coverStats[k] = 0;
  hourWindow.length = 0;
  lastApiAt = 0;
}
