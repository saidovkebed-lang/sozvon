#!/usr/bin/env node
// Фейковый yt-dlp для тестов музыки v2 (YTDLP_PATH). Имитирует реальный вывод yt-dlp 2026.08.19
// (структуры взяты из tests/fixtures/music/ytdlp-*.json), без сети.
//  -J [--flat-playlist] <url|ytsearchN:q|scsearchN:q>  → JSON плейлиста/видео/результатов поиска
//  -j                                                 → JSON по строке на элемент
//  --print [WHEN:]TPL  (%(field)s, %(.{a,b})j)         → печать полей (after_move:* — после скачивания)
//  скачивание (-o tpl)                                → ffmpeg-синус в файл <id>.<ext>
// Каждый вызов дописывается JSON-строкой в $QA_YTDLP_LOG.
// Каталог:
//  - youtube playlist?list=PLqaThree  → 3 видео qaVid000001..3
//  - youtube playlist?list=PLqaWithFail → qaVid000001, qaVidFAIL01, qaVid000003
//  - youtube playlist?list=PLqaCtl → qaCtl000001..3 (+ видео qaCtl000004) — для tests/v10-music-controls
//  - видео с FAIL в id → «ERROR: [youtube] <id>: Video unavailable», код 1
//  - ytsearchN:"<артист> - <название>" → если название есть в Spotify-фикстурах: 3 результата,
//    первый с длительностью +60 с (должен быть отвергнут проверкой ±15 с), второй — точный.
//    Название с «QA FAIL» → результаты есть, но скачивание падает. Иначе — пусто.
//  - scsearchN: → всегда пусто.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const LOG = process.env.QA_YTDLP_LOG;
function log(extra) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), argv, ...extra }) + '\n'); } catch { /* ignore */ }
}
function fail(msg, code = 1) { log({ result: 'error', msg }); process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); }

if (argv.includes('--version')) { log({ result: 'version' }); console.log('2026.08.19'); process.exit(0); }

// ---- разбор аргументов ----
const VALUE_FLAGS = new Set(['-o', '--output', '-f', '--format', '--audio-format', '--audio-quality', '--print', '-O',
  '--cookies', '--proxy', '--js-runtimes', '--playlist-end', '--playlist-start', '-I', '--playlist-items', '--socket-timeout',
  '--retries', '--ffmpeg-location', '--extractor-args', '--max-filesize', '--paths', '-P', '--cache-dir', '--match-filter',
  '--default-search', '--user-agent', '--sleep-interval', '--limit-rate', '-r', '--fragment-retries', '--add-header', '--remux-video', '--recode-video', '--match-filters', '--match-filter']);
const opts = { print: [] }; const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
  if (VALUE_FLAGS.has(a)) {
    const v = argv[++i];
    if (a === '--print' || a === '-O') opts.print.push(v); else opts[a.replace(/^-+/, '')] = v;
    continue;
  }
  if (a.startsWith('--') && a.includes('=')) { const [k, v] = a.split(/=(.*)/s); opts[k.slice(2)] = v; continue; }
  if (a.startsWith('-')) { opts[a.replace(/^-+/, '')] = true; continue; }
  positional.push(a);
}
const target = positional[positional.length - 1];
if (!target) fail('You must provide at least one URL.', 2);

// ---- каталог ----
const tplPlaylist = JSON.parse(fs.readFileSync(path.join(HERE, 'music', 'ytdlp-youtube-playlist-flat.json'), 'utf8'));
const tplEntry = tplPlaylist.entries[0];
const VIDEOS = {
  qaVid000001: { title: 'QA Tube One', uploader: 'QA Channel', duration: 14 },
  qaVid000002: { title: 'QA Tube Two', uploader: 'QA Channel', duration: 15 },
  qaVid000003: { title: 'QA Tube Three', uploader: 'QA Channel', duration: 16 },
  qaVid000004: { title: 'QA Tube Four Single', uploader: 'QA Solo', duration: 17 },
  qaVidFAIL01: { title: 'QA Tube Broken', uploader: 'QA Channel', duration: 13 },
  // v10 (перемотка/очередь): свои id, чтобы не трогать кэш, на который рассчитывают тесты v2
  qaCtl000001: { title: 'QA Ctl One', uploader: 'QA Ctl', duration: 14 },
  qaCtl000002: { title: 'QA Ctl Two', uploader: 'QA Ctl', duration: 15 },
  qaCtl000003: { title: 'QA Ctl Three', uploader: 'QA Ctl', duration: 16 },
  qaCtl000004: { title: 'QA Ctl Four Single', uploader: 'QA Ctl Solo', duration: 17 },
};
const PLAYLISTS = {
  PLqaThree: { title: 'QA YouTube Playlist', ids: ['qaVid000001', 'qaVid000002', 'qaVid000003'] },
  PLqaWithFail: { title: 'QA YouTube Playlist With Fail', ids: ['qaVid000001', 'qaVidFAIL01', 'qaVid000003'] },
  PLqaCtl: { title: 'QA Ctl Playlist', ids: ['qaCtl000001', 'qaCtl000002', 'qaCtl000003'] },
};
function spotifyTracks() {
  const out = [];
  for (const f of fs.readdirSync(path.join(HERE, 'music'))) {
    if (!/^spotify-.*\.html$/.test(f)) continue;
    const html = fs.readFileSync(path.join(HERE, 'music', f), 'utf8');
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) continue;
    try {
      const e = JSON.parse(m[1]).props.pageProps.state.data.entity;
      for (const t of e.trackList || []) out.push({ title: t.title, artist: String(t.subtitle || '').split(',')[0].replace(/ /g, ' ').trim(), ms: t.duration });
      if (!e.trackList && e.duration) out.push({ title: e.name || e.title, artist: e.artists?.[0]?.name || '', ms: e.duration });
    } catch { /* ignore */ }
  }
  return out;
}
const hashId = (s) => 'qs' + crypto.createHash('sha1').update(s).digest('base64url').slice(0, 9);
function videoInfo(id) {
  const v = VIDEOS[id] || (id.startsWith('qs') ? searchCache()[id] : null);
  if (!v) return null;
  return {
    ...tplEntry, _type: 'url', ie_key: 'Youtube', id, title: v.title, duration: v.duration,
    channel: v.uploader, uploader: v.uploader, url: `https://www.youtube.com/watch?v=${id}`,
    webpage_url: `https://www.youtube.com/watch?v=${id}`, extractor_key: 'Youtube', extractor: 'youtube',
  };
}
// результаты поиска запоминаем, чтобы последующая загрузка по id знала название/длительность
// (по файлу на id: параллельные вызовы yt-dlp не должны затирать друг друга)
const SEARCH_DB = LOG ? LOG + '.search' : null;
function searchCache() {
  const out = {};
  if (!SEARCH_DB) return out;
  try { for (const f of fs.readdirSync(SEARCH_DB)) out[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(SEARCH_DB, f), 'utf8')); } catch { /* пусто */ }
  return out;
}
function saveSearch(id, v) {
  if (!SEARCH_DB) return;
  fs.mkdirSync(SEARCH_DB, { recursive: true });
  const tmp = path.join(SEARCH_DB, `.${id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, path.join(SEARCH_DB, id + '.json'));
}

function search(kind, n, q) {
  const base = { id: q, title: q, _type: 'playlist', webpage_url: `${kind}${n}:${q}`, original_url: `${kind}${n}:${q}`,
    extractor: kind === 'ytsearch' ? 'youtube:search' : 'soundcloud:search', extractor_key: kind === 'ytsearch' ? 'YoutubeSearch' : 'SoundcloudSearch', entries: [] };
  if (kind !== 'ytsearch') return base;
  const ql = q.toLowerCase();
  const hit = spotifyTracks().find((t) => t.title && ql.includes(t.title.toLowerCase()));
  if (!hit) return base;
  const dur = Math.round(hit.ms / 1000);
  const mk = (suffix, d, title) => {
    const h = hashId(q + suffix);
    const id = hit.title.includes('QA FAIL') ? 'qsFAIL' + h.slice(2, 7) : h;
    const v = { title, uploader: hit.artist || 'QA Artist', duration: d };
    saveSearch(id, v);
    return videoInfo(id) || { ...tplEntry, id, ...v };
  };
  base.entries = [
    mk('#wrong', dur + 60, `${hit.artist} - ${hit.title} (1 hour loop)`),
    mk('#ok', dur + 3, `${hit.artist} - ${hit.title} (Official Audio)`),
    mk('#live', dur + 40, `${hit.artist} - ${hit.title} (Live)`),
  ].slice(0, n);
  base.playlist_count = base.entries.length;
  return base;
}

function resolve() {
  let m = target.match(/^(ytsearch|scsearch)(\d*):(.*)$/s);
  if (m) return { kind: 'search', data: search(m[1], Number(m[2] || 1), m[3]) };
  let u; try { u = new URL(target); } catch { fail(`'${target}' is not a valid URL.`); }
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname)) fail(`Unsupported URL: ${target}`);
  const list = u.searchParams.get('list');
  const vid = u.hostname === 'youtu.be' ? u.pathname.slice(1) : (u.searchParams.get('v') || (u.pathname.match(/\/shorts\/([\w-]{11})/) || [])[1]);
  if (list && (!vid || opts['yes-playlist']) && !opts['no-playlist']) {
    const pl = PLAYLISTS[list];
    if (!pl) fail(`[youtube:tab] ${list}: The playlist does not exist.`);
    const end = Number(opts['playlist-end'] || 1e9);
    return { kind: 'playlist', data: { ...tplPlaylist, id: list, title: pl.title, uploader: 'QA Channel', channel: 'QA Channel',
      webpage_url: `https://www.youtube.com/playlist?list=${list}`, playlist_count: pl.ids.length,
      entries: pl.ids.slice(0, end).map(videoInfo) } };
  }
  if (vid) {
    const info = videoInfo(vid);
    if (!info) fail(`[youtube] ${vid}: Video unavailable. This video is not available`);
    return { kind: 'video', data: info };
  }
  fail(`Unsupported URL: ${target}`);
}

const r = resolve();
const simulateFlags = opts.J || opts['dump-single-json'] || opts.j || opts['dump-json'] || opts.s || opts.simulate || opts['skip-download'];
const printLater = opts.print.some((p) => /^(after_move|post_process|after_video|playlist):/.test(p));
const wantsDownload = r.kind === 'video' && !simulateFlags && (!opts.print.length || printLater || opts['no-simulate']);

function fmt(tpl, info) {
  tpl = tpl.replace(/^[a-z_]+:/, (w) => (/^(after_move|before_dl|video|pre_process|post_process|after_filter|after_video|playlist):$/.test(w) ? '' : w));
  if (!tpl.includes('%(')) return String(info[tpl] ?? 'NA');
  return tpl.replace(/%\((\.\{([^}]*)\}|[\w.]+)\)([sdj])/g, (_, f, list, t) => {
    if (list) { const o = {}; for (const k of list.split(',')) o[k.trim()] = info[k.trim()] ?? null; return JSON.stringify(o); }
    const v = info[f];
    return t === 'j' ? JSON.stringify(v ?? null) : String(v ?? 'NA');
  });
}

if (!wantsDownload) {
  log({ result: 'info', kind: r.kind, target });
  if (opts.J || opts['dump-single-json']) process.stdout.write(JSON.stringify(r.data) + '\n');
  else if (opts.j || opts['dump-json']) {
    const items = r.data.entries ? r.data.entries : [r.data];
    for (const e of items) process.stdout.write(JSON.stringify(e) + '\n');
  } else if (opts.print.length) {
    const items = r.data.entries ? r.data.entries : [r.data];
    for (const e of items) for (const p of opts.print) process.stdout.write(fmt(p, e) + '\n');
  }
  process.exit(0);
}

// ---- скачивание ----
const info = r.data;
if (/FAIL/.test(info.id)) fail(`[youtube] ${info.id}: Video unavailable. This video has been removed by the uploader`);
const fmtArg = String(opts['audio-format'] || 'mp3');
const ext = fmtArg === 'm4a' ? 'm4a' : 'mp3';
let outTpl = opts.o || opts.output || '%(title)s [%(id)s].%(ext)s';
if (opts.P || opts.paths) outTpl = path.join(opts.P || opts.paths, outTpl);
const filepath = outTpl.replace(/%\(id\)s/g, info.id).replace(/%\(ext\)s/g, ext).replace(/%\(title\)s/g, info.title.replace(/[\\/]/g, '_'));
fs.mkdirSync(path.dirname(filepath), { recursive: true });
const freq = 300 + (parseInt(crypto.createHash('md5').update(info.id).digest('hex').slice(0, 4), 16) % 600);
const dur = Math.max(1, Math.min(Number(process.env.QA_FAKE_MAXDUR || 600), info.duration || 10));
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-ac', '1', '-ar', '22050',
    ...(ext === 'm4a' ? ['-c:a', 'aac', '-b:a', '48k'] : ['-q:a', '9']),
    '-metadata', `title=${info.title}`, '-metadata', `artist=${info.uploader}`, filepath]);
} catch (e) { fail('ffmpeg failed: ' + e.message); }
const full = { ...info, track: null, artist: null, filepath, ext, extractor_key: 'Youtube' };
log({ result: 'download', id: info.id, title: info.title, filepath, target });
if (opts.print.length) for (const p of opts.print) process.stdout.write(fmt(p, full) + '\n');
else process.stdout.write(`[download] Destination: ${filepath}\n`);
process.exit(0);
