// Spotify: только МЕТАДАННЫЕ (название, исполнитель, длительность) плейлиста/альбома/трека.
// Звук Spotify не скачиваем (DRM) — каждый трек потом ищется на YouTube/SoundCloud (music-sources.js).
//
// Источники метаданных:
//   1) Web API (client credentials), если заданы SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET;
//   2) публичная embed-страница open.spotify.com/embed/<type>/<id> (без ключей; ~50–100 первых треков).
// Адреса переопределяются для тестов: SPOTIFY_EMBED_BASE, SPOTIFY_API_BASE, SPOTIFY_ACCOUNTS_BASE.
import { HttpError } from './auth.js';

const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
const EMBED_BASE = () => env('SPOTIFY_EMBED_BASE', 'https://open.spotify.com/embed');
const API_BASE = () => env('SPOTIFY_API_BASE', 'https://api.spotify.com');
const ACCOUNTS_BASE = () => env('SPOTIFY_ACCOUNTS_BASE', 'https://accounts.spotify.com');
const HTTP_TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const TYPE_RU = { playlist: 'плейлист', album: 'альбом', track: 'трек' };

export const spotifyApiConfigured = () => !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

// ---------- разбор ссылок ----------
const ID_RE = '([A-Za-z0-9]{22})';
/** open.spotify.com/(intl-xx/)?(embed/)?(playlist|album|track)/ID, spotify:type:ID → {type,id} | null */
export function parseSpotify(raw) {
  const s = String(raw || '').trim();
  let m = s.match(new RegExp(`^spotify:(playlist|album|track):${ID_RE}$`, 'i'));
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  m = s.match(/^spotify:user:[^:]+:playlist:([A-Za-z0-9]{22})$/i);
  if (m) return { type: 'playlist', id: m[1] };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^(open|play)\.spotify\.com$/i.test(u.hostname)) return null;
  m = u.pathname.match(new RegExp(`^/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:embed/)?(?:user/[^/]+/)?(playlist|album|track)/${ID_RE}/?$`, 'i'));
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}
export const isSpotifyShortLink = (raw) => {
  try { return /^(spotify\.link|spotify\.app\.link)$/i.test(new URL(String(raw).trim()).hostname); } catch { return false; }
};

async function httpGet(url, { headers = {}, method = 'GET', body, redirect = 'follow' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, body, headers: { 'user-agent': UA, 'accept-language': 'en', ...headers }, redirect, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  } catch (err) {
    const why = err.name === 'AbortError' ? 'не ответил за 15 с' : (err.cause?.code || err.message);
    throw new HttpError(502, `Spotify недоступен с этого сервера (${why}). Проверка: sudo bash /opt/sozvon/deploy/music-check.sh`);
  } finally {
    clearTimeout(t);
  }
}

/** spotify.link/xxx → {type,id} (несколько редиректов или ссылка внутри страницы) */
export async function expandShortLink(raw) {
  let url = String(raw).trim();
  for (let i = 0; i < 4; i++) {
    const r = await httpGet(url, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (loc) {
      url = new URL(loc, url).toString();
      const p = parseSpotify(url);
      if (p) return p;
      continue;
    }
    const m = r.text.match(/https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track)\/([A-Za-z0-9]{22})/);
    if (m) return { type: m[1], id: m[2] };
    break;
  }
  throw new HttpError(400, 'Не удалось раскрыть короткую ссылку Spotify — пришлите полную ссылку open.spotify.com/…');
}

// ---------- нормализация ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
function mkTrack({ id, title, artists, durationMs }) {
  const list = (Array.isArray(artists) ? artists : String(artists || '').split(/\s*,\s*/)).map(clean).filter(Boolean);
  const t = clean(title);
  if (!t) return null;
  return {
    spotifyId: typeof id === 'string' && /^[A-Za-z0-9]{22}$/.test(id) ? id : null,
    title: t.slice(0, 200),
    artist: list.join(', ').slice(0, 200),
    mainArtist: list[0] || '',
    duration: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 100) / 10 : 0,
  };
}
const idFromUri = (uri) => (String(uri || '').match(/^spotify:track:([A-Za-z0-9]{22})$/) || [])[1] || null;

// ---------- Web API ----------
let tokenCache = { token: null, exp: 0 };
async function apiToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await httpGet(`${ACCOUNTS_BASE()}/api/token`, {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* не JSON */ }
  if (!r.ok || !j?.access_token) {
    throw new HttpError(502, `Spotify API отклонил ключи (${r.status}${j?.error ? ' ' + j.error : ''}). Проверьте SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET`);
  }
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

async function apiGet(pathOrUrl) {
  // next-ссылки пагинации приходят абсолютными — ходим только на свой API_BASE
  let rel = pathOrUrl;
  if (/^https?:/i.test(pathOrUrl)) { const u = new URL(pathOrUrl); rel = u.pathname + u.search; }
  const token = await apiToken();
  const r = await httpGet(API_BASE() + rel, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (r.status === 401) tokenCache = { token: null, exp: 0 };
  if (!r.ok) { const e = new HttpError(r.status === 404 ? 404 : 502, `Spotify API ответил ${r.status}`); e.apiStatus = r.status; throw e; }
  return JSON.parse(r.text);
}

async function viaApi(type, id, limit) {
  if (type === 'track') {
    const t = await apiGet(`/v1/tracks/${id}`);
    const tr = mkTrack({ id: t.id, title: t.name, artists: (t.artists || []).map((a) => a.name), durationMs: t.duration_ms });
    return { title: tr?.title || 'Трек', tracks: tr ? [tr] : [], total: 1 };
  }
  const obj = await apiGet(type === 'album' ? `/v1/albums/${id}` : `/v1/playlists/${id}`);
  // в 2026 Spotify переименовывает tracks→items у плейлиста; поддерживаем оба
  let page = obj.tracks || obj.items || null;
  const tracks = [];
  const total = Number(page?.total) || 0;
  while (page && tracks.length < limit) {
    for (const it of page.items || []) {
      const t = type === 'album' ? it : (it?.track || it?.item);
      if (!t || t.is_local || (t.type && t.type !== 'track')) continue;
      const tr = mkTrack({ id: t.id, title: t.name, artists: (t.artists || []).map((a) => a.name), durationMs: t.duration_ms });
      if (tr) tracks.push(tr);
      if (tracks.length >= limit) break;
    }
    if (!page.next || tracks.length >= limit) break;
    page = await apiGet(page.next);
  }
  return { title: clean(obj.name) || TYPE_RU[type], tracks, total: total || tracks.length };
}

// ---------- embed-страница ----------
function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  yield node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) yield* walk(v, depth + 1);
}

/** Найти в произвольном JSON сущность Spotify (плейлист/альбом с trackList или трек). */
function entityFrom(json, type) {
  const direct = json?.props?.pageProps?.state?.data?.entity;
  if (direct && (direct.trackList || direct.type === type)) return direct;
  for (const n of walk(json)) {
    if (Array.isArray(n.trackList) && n.trackList.length) return n;
  }
  if (type === 'track') {
    for (const n of walk(json)) if (n.type === 'track' && (n.name || n.title)) return n;
  }
  return null;
}

function tracksFromEntity(entity, type) {
  if (type === 'track' && !Array.isArray(entity.trackList)) {
    const tr = mkTrack({
      id: entity.id || idFromUri(entity.uri), title: entity.name || entity.title,
      artists: Array.isArray(entity.artists) ? entity.artists.map((a) => a?.name || a?.profile?.name) : entity.subtitle,
      durationMs: Number(entity.duration?.totalMilliseconds ?? entity.duration),
    });
    return tr ? [tr] : [];
  }
  return (entity.trackList || []).map((t) => mkTrack({
    id: idFromUri(t.uri), title: t.title || t.name,
    artists: t.subtitle ?? (t.artists || []).map((a) => a?.name),
    durationMs: Number(t.duration?.totalMilliseconds ?? t.duration),
  })).filter(Boolean);
}

const decodeHtml = (s) => String(s).replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Разбор HTML embed-страницы. Несколько стратегий, т.к. Spotify периодически меняет вёрстку. */
export function parseEmbedHtml(html, type) {
  const jsonCandidates = [];
  // 1) Next.js: <script id="__NEXT_DATA__" type="application/json">…</script>
  const next = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) jsonCandidates.push(() => JSON.parse(next[1]));
  // 2) любые JSON-скрипты
  for (const m of html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    jsonCandidates.push(() => JSON.parse(m[1]));
  }
  // 3) старый формат: <script id="resource"|"initial-state">base64(JSON)</script>
  for (const m of html.matchAll(/<script[^>]*id=["'](?:resource|initial-state|initialState)["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    jsonCandidates.push(() => JSON.parse(raw.startsWith('{') ? decodeURIComponent(raw) : Buffer.from(raw, 'base64').toString('utf8')));
  }
  for (const get of jsonCandidates) {
    let json;
    try { json = get(); } catch { continue; }
    const entity = entityFrom(json, type);
    if (!entity) continue;
    const tracks = tracksFromEntity(entity, type);
    if (tracks.length) return { title: clean(entity.name || entity.title) || TYPE_RU[type], tracks, strategy: 'json' };
  }
  // 4) «"trackList":[ … ]» где угодно в тексте — вырезаем массив по скобкам
  const idx = html.indexOf('"trackList":[');
  if (idx !== -1) {
    const start = html.indexOf('[', idx);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end = i; break; }
    }
    if (end > start) {
      try {
        const tracks = tracksFromEntity({ trackList: JSON.parse(html.slice(start, end + 1)) }, 'playlist');
        const name = (html.slice(Math.max(0, idx - 3000), idx).match(/"name":"((?:[^"\\]|\\.)*)"/g) || []).pop();
        if (tracks.length) return { title: name ? clean(JSON.parse(name.slice(7))) : TYPE_RU[type], tracks, strategy: 'scan' };
      } catch { /* дальше */ }
    }
  }
  // 5) трек: метатеги og:title / og:description («Исполнитель · Song · 2020»)
  if (type === 'track') {
    const meta = (p) => (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i')) || [])[1];
    const title = meta('og:title');
    if (title) {
      const desc = decodeHtml(meta('og:description') || '');
      const tr = mkTrack({ title: decodeHtml(title), artists: desc.split(' · ')[0] || '' });
      if (tr) return { title: tr.title, tracks: [tr], strategy: 'meta' };
    }
  }
  return null;
}

async function viaEmbed(type, id) {
  const r = await httpGet(`${EMBED_BASE()}/${type}/${id}`, { headers: { accept: 'text/html' } });
  if (r.status === 404) throw new HttpError(404, `Spotify: ${TYPE_RU[type]} не найден или он приватный. Проверьте ссылку (приватные плейлисты не открываются)`);
  if (r.status === 429) throw new HttpError(502, 'Spotify временно ограничил запросы (429). Попробуйте через минуту или задайте ключи SPOTIFY_CLIENT_ID/SECRET');
  if (!r.ok) throw new HttpError(502, `Spotify ответил ошибкой ${r.status} на embed-страницу`);
  const parsed = parseEmbedHtml(r.text, type);
  if (!parsed) {
    throw new HttpError(502, 'Не удалось разобрать страницу Spotify (похоже, Spotify изменил формат). Обновите Созвон или задайте ключи Spotify API (SPOTIFY_CLIENT_ID/SECRET, см. docs/MUSIC.md)');
  }
  return { ...parsed, total: parsed.tracks.length, viaEmbed: true };
}

/**
 * Метаданные Spotify: {title, tracks:[{spotifyId,title,artist,mainArtist,duration}], total, viaEmbed?}
 * Web API (если есть ключи) → при ошибке API фолбэк на embed.
 */
export async function fetchSpotify({ type, id }, { limit = 100 } = {}) {
  let apiErr = null;
  if (spotifyApiConfigured()) {
    try {
      const res = await viaApi(type, id, limit);
      if (res.tracks.length) return res;
    } catch (err) {
      apiErr = err;
      console.warn(`[spotify] Web API: ${err.message} — пробую embed-страницу`);
    }
  }
  try {
    const res = await viaEmbed(type, id);
    res.tracks = res.tracks.slice(0, limit);
    return res;
  } catch (err) {
    if (apiErr && err.status !== 404) err.message += ` (Web API: ${apiErr.message})`;
    throw err;
  }
}
