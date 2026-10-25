// «Astra Итоги»: агрегаты активности по серверам и месяцам (docs/RECAP.md).
// Хранилище — отдельный файл DATA_DIR/stats.json (атомарная запись tmp+rename раз в минуту и при выключении).
// Источник событий — те же рассылки, что уходят клиентам (realtime.js → emitToViewers): voice:members,
// music:state, watch:state, message:new. ЛС через emitToViewers не идут — статистики по ЛС нет вообще.
// Содержимое сообщений не сохраняется: только счётчики. Участник может отказаться (user.recapOptOut) —
// тогда его активность попадает только в обезличенные итоги сервера, а личные записи удаляются.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, save } from './db.js';
import { findServer, findChannel, findUser, findUserByName, serverChannels, isMember } from './model.js';
import { PERMS, can } from './permissions.js';
import { requireAuth, HttpError } from './auth.js';

export const RETENTION_MONTHS = 24;
const FLUSH_MS = 60_000;
const TICK_MS = 5 * 60_000;
const ANNOUNCE_HOUR = 10;          // 1-го числа объявляем не раньше 10:00 по времени сервера
const MAX_TRACK_KEYS = 1000;       // уникальных треков/видео в месяце (дальше — только счётчики)
const MAX_SPAN_MS = 3 * 24 * 3600_000; // защита от скачков часов: один отрезок не длиннее 3 суток
const CACHE_TTL_MS = 15_000;

const EMPTY = () => ({ version: 1, servers: {}, settings: {}, announced: {} });

let file = null;
let data = EMPTY();
let dirty = false;
let clockOverride = null;
const rev = new Map();     // serverId → счётчик изменений (для кэша итогов)
const cache = new Map();   // `${sid}|${period}` → {rev, at, base}
const chans = new Map();   // channelId → ChannelTracker
let post = null;           // (server, channel, content, recap) → void — системное сообщение (realtime.js)
const timers = [];

/** Текущее время статистики (в тестах подменяется через POST /api/__test/stats). */
export const statsNow = () => clockOverride ?? Date.now();

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- хранилище --
export function initStats(dataDir) {
  file = path.join(dataDir, 'stats.json');
  data = EMPTY();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = { ...EMPTY(), ...parsed };
    } catch (err) {
      const backup = `${file}.broken-${Date.now()}`;
      try { fs.copyFileSync(file, backup); } catch { /* */ }
      console.error(`[stats] Не удалось прочитать stats.json (${err.message}). Копия: ${backup}. Начинаю заново.`);
    }
  }
  prune();
}

function touch(sid) { dirty = true; rev.set(sid, (rev.get(sid) || 0) + 1); }

/** Удалить месяцы старше RETENTION_MONTHS и данные удалённых серверов. */
function prune(now = statsNow()) {
  const d = new Date(now);
  const cutoff = monthKey(new Date(d.getFullYear(), d.getMonth() - RETENTION_MONTHS + 1, 1).getTime());
  const alive = new Set(db.data.servers.map((s) => s.id));
  for (const [sid, s] of Object.entries(data.servers)) {
    if (!alive.has(sid)) { delete data.servers[sid]; delete data.settings[sid]; delete data.announced[sid]; dirty = true; continue; }
    for (const mk of Object.keys(s.months || {})) if (mk < cutoff) { delete s.months[mk]; dirty = true; }
  }
}

/** Записать stats.json (сначала зачесть идущие сессии). final — выключение: закрыть сессии. */
export function flushStats({ final = false } = {}) {
  if (!file) return;
  const now = statsNow();
  reconcile(now);
  for (const ch of chans.values()) checkpointChannel(ch, now);
  if (final) for (const ch of [...chans.values()]) closeChannel(ch, now);
  prune(now);
  if (!dirty) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    dirty = false;
  } catch (err) {
    console.error('[stats] Ошибка записи статистики:', err.message);
  }
}

// ------------------------------------------------------------------ корзины --
const newUser = () => ({
  voiceMin: 0, longestMin: 0, sessions: 0, night: 0, msgs: 0, atts: 0, streamMin: 0, tracksAdded: 0, watchMin: 0, videosAdded: 0,
});
const newBucket = () => ({
  voiceMin: 0, sessions: 0, hours: Array(24).fill(0), msgHours: Array(24).fill(0), dayVoice: {}, dayMsgs: {},
  peakUsers: 0, peakAt: null, msgs: 0, atts: 0, streamMin: 0, streamViewersPeak: 0, joins: 0,
  music: { plays: 0, manual: 0, auto: 0, minutes: 0, tracks: {}, artists: {} },
  watch: { videos: 0, minutes: 0, titles: {} },
  users: {},
});

function bucket(sid, mk) {
  const s = (data.servers[sid] ||= { months: {} });
  const b = (s.months[mk] ||= newBucket());
  touch(sid);
  return b;
}

/** Участвует ли пользователь в рейтингах (человек, не отказался). */
export function participates(uid) {
  const u = typeof uid === 'string' ? findUser(uid) : null;
  return !!u && !u.isBot && u.recapOptOut !== true;
}
const userRec = (b, uid) => (participates(uid) ? (b.users[uid] ||= newUser()) : null);

/** Разбить отрезок [a, b) по часам местного времени: fn(monthKey, day, hour, minutes). */
function spread(a, b, fn) {
  if (!(b > a)) return;
  if (b - a > MAX_SPAN_MS) a = b - MAX_SPAN_MS;
  let t = a;
  while (t < b) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    const e = Math.min(b, next);
    fn(monthKey(t), pad(d.getDate()), d.getHours(), (e - t) / 60_000);
    t = e;
  }
}

// ------------------------------------------------------------- голос/медиа --
// ChannelTracker: {channelId, serverId, members: Map(uid → {start, credited, streamCredited|null}), music, watch}
// music/watch — текущий отрезок: {key, playing, credited}
function tracker(channelId, serverId) {
  let ch = chans.get(channelId);
  if (!ch) {
    if (!serverId) return null;
    ch = { channelId, serverId, members: new Map(), music: null, watch: null };
    chans.set(channelId, ch);
  }
  return ch;
}

function creditVoice(ch, uid, s, now) {
  spread(s.credited, now, (mk, day, hour, min) => {
    const b = bucket(ch.serverId, mk);
    b.voiceMin = r2(b.voiceMin + min);
    b.hours[hour] = r2(b.hours[hour] + min);
    b.dayVoice[day] = r2((b.dayVoice[day] || 0) + min);
    const u = userRec(b, uid);
    if (u) { u.voiceMin = r2(u.voiceMin + min); if (hour < 5) u.night = r2(u.night + min); }
  });
  s.credited = Math.max(s.credited, now);
  if (s.streamCredited != null) {
    spread(s.streamCredited, now, (mk, _d, _h, min) => {
      const b = bucket(ch.serverId, mk);
      b.streamMin = r2(b.streamMin + min);
      const u = userRec(b, uid);
      if (u) u.streamMin = r2(u.streamMin + min);
    });
    s.streamCredited = Math.max(s.streamCredited, now);
  }
}

function creditMedia(ch, now) {
  for (const kind of ['music', 'watch']) {
    const seg = ch[kind];
    if (!seg) continue;
    if (seg.playing) {
      spread(seg.credited, now, (mk, _d, _h, min) => {
        const b = bucket(ch.serverId, mk);
        b[kind].minutes = r2(b[kind].minutes + min);
        if (kind === 'watch') {
          for (const uid of ch.members.keys()) { const u = userRec(b, uid); if (u) u.watchMin = r2(u.watchMin + min); }
        }
      });
    }
    seg.credited = Math.max(seg.credited, now);
  }
}

function checkpointChannel(ch, now) {
  creditMedia(ch, now);
  for (const [uid, s] of ch.members) creditVoice(ch, uid, s, now);
}

function endSession(ch, uid, now) {
  const s = ch.members.get(uid);
  if (!s) return;
  creditVoice(ch, uid, s, now);
  ch.members.delete(uid);
  const b = bucket(ch.serverId, monthKey(now));
  b.sessions += 1;
  const u = userRec(b, uid);
  if (u) { u.sessions += 1; u.longestMin = Math.max(u.longestMin, r2((now - s.start) / 60_000)); }
}

function closeChannel(ch, now) {
  creditMedia(ch, now);
  for (const uid of [...ch.members.keys()]) endSession(ch, uid, now);
  chans.delete(ch.channelId);
}

/** Каналы, которых больше нет (удалены вместе с сервером/вручную) — закрыть сессии. */
function reconcile(now) {
  for (const ch of [...chans.values()]) if (!findChannel(ch.channelId)) closeChannel(ch, now);
}

function updatePeaks(serverId, now) {
  let total = 0;
  for (const ch of chans.values()) if (ch.serverId === serverId) total += ch.members.size;
  const b = bucket(serverId, monthKey(now));
  if (total > b.peakUsers) { b.peakUsers = total; b.peakAt = now; }
}

function onVoiceMembers(ch, members, now) {
  const present = new Map();
  for (const m of members || []) if (m && !m.isBot && typeof m.userId === 'string') present.set(m.userId, m);
  const before = [...ch.members.keys()].sort().join(',');
  const after = [...present.keys()].sort().join(',');
  if (before !== after) creditMedia(ch, now); // «Киноман»: время до смены состава — тем, кто был
  for (const uid of [...ch.members.keys()]) if (!present.has(uid)) endSession(ch, uid, now);
  let streaming = false;
  for (const [uid, m] of present) {
    let s = ch.members.get(uid);
    if (!s) { s = { start: now, credited: now, streamCredited: null }; ch.members.set(uid, s); }
    if (m.streaming && s.streamCredited == null) s.streamCredited = now;
    else if (!m.streaming && s.streamCredited != null) { creditVoice(ch, uid, s, now); s.streamCredited = null; }
    if (m.streaming) streaming = true;
  }
  if (streaming) {
    const b = bucket(ch.serverId, monthKey(now));
    b.streamViewersPeak = Math.max(b.streamViewersPeak, present.size - 1);
  }
  updatePeaks(ch.serverId, now);
  if (!ch.members.size && !ch.music && !ch.watch) chans.delete(ch.channelId);
}

function topKey(map, key, rec) {
  if (map[key]) { map[key].n += 1; return; }
  if (Object.keys(map).length >= MAX_TRACK_KEYS) return;
  map[key] = { ...rec, n: 1 };
}

function onMusic(ch, st, now) {
  const t = st && typeof st.track === 'object' ? st.track : null;
  const key = t ? String(t.qid || t.id || t.title || '').slice(0, 80) : null;
  creditMedia(ch, now);
  if (key && key !== ch.music?.key) {
    ch.music = { key, playing: !st.paused, credited: now };
    const b = bucket(ch.serverId, monthKey(now));
    b.music.plays += 1;
    const title = String(t.title || 'Без названия').slice(0, 120);
    const artist = String(t.artist || '').slice(0, 80);
    topKey(b.music.tracks, `${artist}\u0001${title}`.toLowerCase(), { t: title, a: artist });
    if (artist) b.music.artists[artist] = (b.music.artists[artist] || 0) + 1;
    if (t.autoplay === true) b.music.auto += 1;
    else {
      b.music.manual += 1;
      const adder = typeof t.addedBy === 'string' ? findUserByName(t.addedBy) : null;
      const u = adder && isMember(findServer(ch.serverId), adder.id) ? userRec(b, adder.id) : null;
      if (u) u.tracksAdded += 1;
    }
  } else if (!key) ch.music = null;
  else ch.music.playing = !st.paused;
}

function onWatch(ch, st, now) {
  const v = st && typeof st.video === 'object' ? st.video : null;
  const key = v ? String(v.qid || v.id || '').slice(0, 80) : null;
  creditMedia(ch, now);
  if (key && key !== ch.watch?.key) {
    ch.watch = { key, playing: !st.paused, credited: now };
    const b = bucket(ch.serverId, monthKey(now));
    b.watch.videos += 1;
    const title = String(v.title || 'Видео').slice(0, 120);
    topKey(b.watch.titles, title.toLowerCase(), { t: title });
    const u = typeof v.by?.id === 'string' ? userRec(b, v.by.id) : null;
    if (u) u.videosAdded += 1;
  } else if (!key) ch.watch = null;
  else ch.watch.playing = !st.paused;
}

function onMessage(msg, now) {
  const author = msg?.author;
  if (!msg || msg.system || !author || author.isBot || typeof author.id !== 'string') return;
  const channel = findChannel(msg.channelId); // только каналы серверов: ЛС — другая коллекция
  if (!channel || channel.type !== 'text') return;
  const d = new Date(now);
  const b = bucket(channel.serverId, monthKey(now));
  const atts = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
  b.msgs += 1;
  b.atts += atts;
  b.msgHours[d.getHours()] += 1;
  const day = pad(d.getDate());
  b.dayMsgs[day] = (b.dayMsgs[day] || 0) + 1;
  const u = userRec(b, author.id);
  if (u) { u.msgs += 1; u.atts += atts; if (d.getHours() < 5) u.night += 1; }
}

/** Событие, которое сервер рассылает участникам канала (realtime.js → emitToViewers). */
export function observeStats(channelId, event, payload, serverIdHint) {
  try {
    const now = statsNow();
    if (event === 'message:new') return onMessage(payload?.message, now);
    if (event !== 'voice:members' && event !== 'music:state' && event !== 'watch:state') return;
    const channel = findChannel(channelId);
    const ch = tracker(channelId, channel?.serverId || serverIdHint);
    if (!ch) return;
    if (!channel) { closeChannel(ch, now); return; }
    if (event === 'voice:members') onVoiceMembers(ch, payload?.members, now);
    else if (event === 'music:state') onMusic(ch, payload, now);
    else onWatch(ch, payload, now);
    if (!ch.members.size && !ch.music && !ch.watch) chans.delete(ch.channelId);
  } catch (err) {
    console.warn('[stats]', err?.message || err);
  }
}

/** Новый участник сервера (по инвайту). */
export function noteMemberJoined(serverId) {
  bucket(serverId, monthKey(statsNow())).joins += 1;
}

/** Участвовать в Итогах. false — убрать личные записи из всех месяцев всех серверов. */
export function setParticipation(user, on) {
  if (on) delete user.recapOptOut; else user.recapOptOut = true;
  save();
  if (!on) {
    for (const [sid, s] of Object.entries(data.servers)) {
      for (const b of Object.values(s.months || {})) if (b.users?.[user.id]) { delete b.users[user.id]; touch(sid); }
    }
  }
  cache.clear();
}

// -------------------------------------------------------------- настройки --
export const announceEnabled = (sid) => data.settings[sid]?.announce !== false;
function setAnnounce(sid, on) {
  if (on) delete data.settings[sid]; else data.settings[sid] = { announce: false };
  dirty = true;
}

// ------------------------------------------------------------------ итоги --
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function parsePeriod(raw, now = statsNow()) {
  const p = raw === undefined || raw === '' ? monthKey(now) : String(raw);
  let m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(p);
  if (m) return { period: p, kind: 'month', months: [p], label: `${MONTHS_NOM[Number(m[2]) - 1]} ${m[1]}` };
  m = /^(\d{4})$/.exec(p);
  if (m) return { period: p, kind: 'year', months: MONTHS_NOM.map((_, i) => `${m[1]}-${pad(i + 1)}`), label: `${m[1]} год` };
  return null;
}

const hasActivity = (b) => !!b && (b.voiceMin > 0 || b.msgs > 0 || b.music.plays > 0 || b.watch.videos > 0 || b.streamMin > 0 || b.joins > 0);

function merge(sid, months) {
  const out = newBucket();
  out.days = {}; // 'YYYY-MM-DD' → {voice, msgs}
  const src = data.servers[sid]?.months || {};
  for (const mk of months) {
    const b = src[mk];
    if (!b) continue;
    for (const k of ['voiceMin', 'sessions', 'msgs', 'atts', 'streamMin', 'joins']) out[k] = r2(out[k] + (b[k] || 0));
    for (let i = 0; i < 24; i++) { out.hours[i] += b.hours?.[i] || 0; out.msgHours[i] += b.msgHours?.[i] || 0; }
    for (const [d, v] of Object.entries(b.dayVoice || {})) (out.days[`${mk}-${d}`] ||= { voice: 0, msgs: 0 }).voice += v;
    for (const [d, v] of Object.entries(b.dayMsgs || {})) (out.days[`${mk}-${d}`] ||= { voice: 0, msgs: 0 }).msgs += v;
    if (b.peakUsers > out.peakUsers) { out.peakUsers = b.peakUsers; out.peakAt = b.peakAt; }
    out.streamViewersPeak = Math.max(out.streamViewersPeak, b.streamViewersPeak || 0);
    for (const k of ['plays', 'manual', 'auto', 'minutes']) out.music[k] = r2(out.music[k] + (b.music?.[k] || 0));
    for (const [k, v] of Object.entries(b.music?.tracks || {})) {
      if (out.music.tracks[k]) out.music.tracks[k].n += v.n; else out.music.tracks[k] = { ...v };
    }
    for (const [k, v] of Object.entries(b.music?.artists || {})) out.music.artists[k] = (out.music.artists[k] || 0) + v;
    for (const k of ['videos', 'minutes']) out.watch[k] = r2(out.watch[k] + (b.watch?.[k] || 0));
    for (const [k, v] of Object.entries(b.watch?.titles || {})) {
      if (out.watch.titles[k]) out.watch.titles[k].n += v.n; else out.watch.titles[k] = { ...v };
    }
    for (const [uid, u] of Object.entries(b.users || {})) {
      const o = (out.users[uid] ||= newUser());
      for (const [k, v] of Object.entries(u)) o[k] = k === 'longestMin' ? Math.max(o[k] || 0, v) : r2((o[k] || 0) + v);
    }
  }
  return out;
}

const userCard = (u) => ({ id: u.id, username: u.username, displayName: u.displayName ?? null, color: u.color, avatar: u.avatar ?? null });

export const AWARDS = [
  { id: 'voice', field: 'voiceMin', title: 'Голос сервера', caption: 'больше всех времени в голосовых каналах', unit: 'min' },
  { id: 'night', field: 'night', title: 'Ночная смена', caption: 'самый активный с 00:00 до 05:00', unit: 'score' },
  { id: 'dj', field: 'tracksAdded', title: 'Диджей', caption: 'больше всех поставил треков', unit: 'tracks' },
  { id: 'director', field: 'streamMin', title: 'Режиссёр', caption: 'дольше всех показывал экран', unit: 'min' },
  { id: 'chatter', field: 'msgs', title: 'Болтун', caption: 'больше всех сообщений', unit: 'messages' },
  { id: 'cinephile', field: 'watchMin', title: 'Киноман', caption: 'больше всех смотрел вместе', unit: 'min' },
  { id: 'marathon', field: 'longestMin', title: 'Марафонец', caption: 'самая долгая сессия в голосе', unit: 'min' },
];

function buildBase(server, p) {
  const agg = merge(server.id, p.months);
  const eligible = Object.entries(agg.users)
    .filter(([uid]) => participates(uid) && server.memberIds.includes(uid))
    .map(([uid, u]) => ({ user: findUser(uid), stats: u }));
  const board = (field, n = 5) => eligible.filter((e) => e.stats[field] > 0)
    .sort((a, b) => b.stats[field] - a.stats[field] || a.user.username.localeCompare(b.user.username))
    .slice(0, n).map((e) => ({ user: userCard(e.user), value: Math.round(e.stats[field] * 10) / 10 }));
  const awards = AWARDS.map((a) => {
    const top = board(a.field, 1)[0];
    return top ? { id: a.id, title: a.title, caption: a.caption, unit: a.unit, user: top.user, value: top.value } : null;
  }).filter(Boolean);
  const dayList = Object.entries(agg.days).map(([date, v]) => ({ date, voiceMinutes: Math.round(v.voice), messages: v.msgs, score: v.voice + v.msgs }));
  const busiestDay = dayList.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))[0] || null;
  if (busiestDay) delete busiestDay.score;
  const hourScore = agg.hours.map((m, i) => m + agg.msgHours[i]);
  const bestHour = hourScore.reduce((best, v, i) => (v > hourScore[best] ? i : best), 0);
  const top = (map, n = 5) => Object.values(map).sort((a, b) => b.n - a.n || String(a.t).localeCompare(String(b.t))).slice(0, n);
  const months = data.servers[server.id]?.months || {};
  const available = Object.keys(months).filter((k) => hasActivity(months[k])).sort().reverse();
  const years = [...new Set(available.map((k) => k.slice(0, 4)))];
  return {
    agg,
    pub: {
      period: p.period, kind: p.kind, label: p.label,
      server: { id: server.id, name: server.name, icon: server.icon ?? null },
      empty: !p.months.some((k) => hasActivity(months[k])),
      available: { months: available, years },
      totals: {
        voiceMinutes: Math.round(agg.voiceMin), voiceHours: Math.round(agg.voiceMin / 6) / 10, sessions: agg.sessions,
        messages: agg.msgs, attachments: agg.atts,
        streamMinutes: Math.round(agg.streamMin), streamViewersPeak: agg.streamViewersPeak,
        peakUsers: agg.peakUsers, peakAt: agg.peakAt, newMembers: agg.joins,
        music: { plays: agg.music.plays, manual: agg.music.manual, autoplay: agg.music.auto, minutes: Math.round(agg.music.minutes) },
        watch: { videos: agg.watch.videos, minutes: Math.round(agg.watch.minutes) },
      },
      busiestDay,
      busiestHour: hourScore[bestHour] > 0 ? { hour: bestHour, voiceMinutes: Math.round(agg.hours[bestHour]), messages: agg.msgHours[bestHour] } : null,
      hours: agg.hours.map((m) => Math.round(m)),
      topTracks: top(agg.music.tracks).map((t) => ({ title: t.t, artist: t.a, plays: t.n })),
      topArtists: Object.entries(agg.music.artists).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, plays]) => ({ name, plays })),
      topVideos: top(agg.watch.titles, 3).map((t) => ({ title: t.t, views: t.n })),
      awards,
      leaderboards: { voice: board('voiceMin'), messages: board('msgs'), tracks: board('tracksAdded') },
    },
  };
}

/** Итоги сервера за период глазами участника viewerId (кэш на 15 с / до изменения статистики). */
export function buildRecap(server, viewerId, period) {
  const p = parsePeriod(period);
  if (!p) throw new HttpError(400, 'Период: ГГГГ-ММ или ГГГГ');
  const key = `${server.id}|${p.period}`;
  let c = cache.get(key);
  const r = rev.get(server.id) || 0;
  if (!c || (c.rev !== r && Date.now() - c.at > CACHE_TTL_MS)) {
    const now = statsNow();
    for (const ch of chans.values()) if (ch.serverId === server.id) checkpointChannel(ch, now);
    c = { rev: rev.get(server.id) || 0, at: Date.now(), ...buildBase(server, p) };
    cache.set(key, c);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  const viewer = findUser(viewerId);
  const participate = participates(viewerId);
  const mine = participate ? c.agg.users[viewerId] : null;
  return {
    ...c.pub,
    me: {
      participate,
      stats: mine ? {
        voiceMinutes: Math.round(mine.voiceMin), longestSessionMinutes: Math.round(mine.longestMin), messages: mine.msgs,
        attachments: mine.atts, streamMinutes: Math.round(mine.streamMin), tracksAdded: mine.tracksAdded,
        watchMinutes: Math.round(mine.watchMin), nightScore: Math.round(mine.night),
      } : null,
      user: viewer ? userCard(viewer) : null,
    },
    settings: { announce: announceEnabled(server.id), canManage: can(server, viewerId, PERMS.MANAGE_SERVER) },
    generatedAt: Date.now(),
  };
}

// ------------------------------------------------------------ объявления --
/** Раз в период: «📊 Итоги <месяц> готовы» в первый текстовый канал (и за год — в первую неделю января). */
export function checkAnnouncements(now = statsNow()) {
  if (!post) return 0;
  const d = new Date(now);
  if (d.getDate() === 1 && d.getHours() < ANNOUNCE_HOUR) return 0;
  const prev = monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 15).getTime());
  const prevYear = String(d.getFullYear() - 1);
  const yearTime = d.getMonth() === 0 && d.getDate() <= 7;
  let posted = 0;
  for (const server of db.data.servers) {
    const months = data.servers[server.id]?.months;
    if (!months || !announceEnabled(server.id)) continue;
    const channel = serverChannels(server.id).find((c) => c.type === 'text');
    if (!channel) continue;
    const a = (data.announced[server.id] ||= {});
    if ((!a.month || a.month < prev) && hasActivity(months[prev])) {
      a.month = prev; dirty = true;
      post(server, channel, `📊 Итоги ${MONTHS_GEN[Number(prev.slice(5)) - 1]} готовы — открыть`, { serverId: server.id, period: prev });
      posted++;
    }
    if (yearTime && (!a.year || a.year < prevYear) && Object.keys(months).some((k) => k.startsWith(prevYear + '-') && hasActivity(months[k]))) {
      a.year = prevYear; dirty = true;
      post(server, channel, `📊 Итоги ${prevYear} года готовы — открыть`, { serverId: server.id, period: prevYear });
      posted++;
    }
  }
  if (posted) flushStats();
  return posted;
}

/** Запуск таймеров: запись раз в минуту, проверка объявлений каждые 5 минут. */
export function startStats({ post: postFn } = {}) {
  post = postFn || null;
  while (timers.length) clearInterval(timers.pop());
  const flush = setInterval(() => flushStats(), FLUSH_MS);
  const tick = setInterval(() => { try { checkAnnouncements(); } catch (e) { console.warn('[stats] объявления:', e.message); } }, TICK_MS);
  flush.unref(); tick.unref();
  timers.push(flush, tick);
  setTimeout(() => { try { checkAnnouncements(); } catch { /* */ } }, 5000).unref();
}

// -------------------------------------------------------------------- API --
export function createRecapRouter() {
  const router = express.Router();
  const json = express.json({ limit: '10kb' }); // только на своих маршрутах: роутер стоит перед общим /api
  const memberServer = (req) => {
    if (req.isBot) throw new HttpError(403, 'Недоступно для бота');
    const server = findServer(String(req.params.sid));
    if (!server || !isMember(server, req.user.id)) throw new HttpError(404, 'Сервер не найден');
    return server;
  };

  router.get('/servers/:sid/recap', requireAuth, (req, res) => {
    const server = memberServer(req);
    res.set('Cache-Control', 'private, max-age=15');
    res.json(buildRecap(server, req.user.id, req.query.period));
  });

  router.put('/servers/:sid/recap/settings', requireAuth, json, (req, res) => {
    const server = memberServer(req);
    if (!can(server, req.user.id, PERMS.MANAGE_SERVER)) throw new HttpError(403, 'Недостаточно прав');
    if (typeof req.body?.announce !== 'boolean') throw new HttpError(400, 'announce: true/false');
    setAnnounce(server.id, req.body.announce);
    flushStats();
    res.json({ announce: announceEnabled(server.id) });
  });

  router.get('/me/recap', requireAuth, (req, res) => {
    if (req.isBot) throw new HttpError(403, 'Недоступно для бота');
    res.json({ participate: participates(req.user.id) });
  });

  router.put('/me/recap', requireAuth, json, (req, res) => {
    if (req.isBot) throw new HttpError(403, 'Недоступно для бота');
    if (typeof req.body?.participate !== 'boolean') throw new HttpError(400, 'participate: true/false');
    setParticipation(req.user, req.body.participate);
    res.json({ participate: participates(req.user.id) });
  });

  // Только для тестов (SOZVON_TEST_HOOKS=1): подмена часов статистики, запись, проверка объявлений
  if (process.env.SOZVON_TEST_HOOKS === '1') {
    router.post('/__test/stats', json, (req, res) => {
      const b = req.body || {};
      if (b.now === null) clockOverride = null;
      else if (Number.isFinite(b.now)) clockOverride = b.now;
      cache.clear();
      let announced = 0;
      if (b.announce) announced = checkAnnouncements();
      if (b.flush) flushStats();
      res.json({ now: statsNow(), announced, file: b.dump ? data : undefined });
    });
  }

  router.use((err, _req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON в запросе' });
    next(err);
  });
  return router;
}
