// Сохранённые плейлисты (по серверам) и настройки музыки сервера (автоплей).
//
// db.json:
//   playlists: [{ id, serverId, name, createdBy:userId, createdAt, updatedAt, items:[Item] }]
//   musicSettings: { [serverId]: { autoplay:boolean } }
// Item: { iid, title, artist, duration, trackId?, source?, ref?:{url?, key?, query?} }
//   trackId — трек библиотеки (уже скачан); ref — откуда взять звук, если трека в библиотеке нет
//   (как «ожидающие» элементы очереди: см. server/music-sources.js).
//
// Права: смотреть и включать — USE_MUSIC_BOT; создавать — USE_MUSIC_BOT; менять/удалять —
// создатель (с USE_MUSIC_BOT) или управляющий сервером (MANAGE_SERVER / администратор).
// Бот действует от имени участника: asUserId (только для запросов с токеном бота).
import crypto from 'node:crypto';
import express from 'express';
import { db, save, newId } from './db.js';
import { HttpError, requireAuth } from './auth.js';
import { findServer, findUser, isMember } from './model.js';
import { PERMS, can } from './permissions.js';
import { findTrackRec, findBySource, publicTrack, itemCover } from './music-library.js';
import { parseMusicLink, urlKey, resolveInput } from './music-sources.js';

export const PLAYLIST_LIMITS = Object.freeze({ perServer: 200, items: 500, name: 60 });
const SOURCES = ['youtube', 'soundcloud', 'spotify', 'search'];

const playlists = () => (db.data.playlists ||= []);
const settingsMap = () => (db.data.musicSettings ||= {});
const iidNew = () => 'i' + crypto.randomBytes(5).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- настройки ----------
export function getMusicSettings(serverId) {
  const s = settingsMap()[serverId] || {};
  return { autoplay: !!s.autoplay };
}

export function setMusicSettings(serverId, patch) {
  const cur = { ...getMusicSettings(serverId) };
  if (typeof patch.autoplay === 'boolean') cur.autoplay = patch.autoplay;
  settingsMap()[serverId] = cur;
  save();
  return cur;
}

// ---------- валидация ----------
export function cleanPlaylistName(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Название плейлиста: введите текст');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new HttpError(400, 'Название плейлиста не может быть пустым');
  if (name.length > PLAYLIST_LIMITS.name) throw new HttpError(400, `Название плейлиста слишком длинное (максимум ${PLAYLIST_LIMITS.name} символов)`);
  return name;
}

function cleanRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const out = {};
  const url = str(ref.url, 500);
  if (url) {
    const link = parseMusicLink(url);
    if (!link || link.kind === 'spotify') throw new HttpError(400, 'Некорректная ссылка в элементе плейлиста');
    out.url = link.url;
  }
  const key = str(ref.key, 200);
  if (/^[a-z]+:[^\s]{1,200}$/.test(key)) out.key = key;
  const query = str(ref.query, 200);
  if (query) out.query = query;
  return out.url || out.key || out.query ? out : null;
}

/** Ссылка на YouTube по ключу кэша «youtube:<id>» — чтобы удалённый из библиотеки трек можно было скачать снова */
function refFromSources(sources = []) {
  const yt = sources.find((k) => /^youtube:[A-Za-z0-9_-]{11}$/.test(k));
  if (yt) return { url: `https://www.youtube.com/watch?v=${yt.slice(8)}`, key: yt };
  const sc = sources.find((k) => /^url:soundcloud\.com\//.test(k));
  if (sc) return { url: `https://${sc.slice(4)}`, key: sc };
  return null;
}

function itemFromTrackRec(rec) {
  const it = { iid: iidNew(), trackId: rec.id, title: rec.title || 'Без названия', artist: rec.artist || '', duration: rec.duration || 0 };
  const ref = refFromSources(rec.sources);
  if (ref) { it.ref = ref; it.source = ref.url.includes('soundcloud') ? 'soundcloud' : 'youtube'; }
  return it;
}

/**
 * Элемент плейлиста из запроса: {trackId} — трек библиотеки; иначе «ожидающий» {title, artist, duration, source, ref}
 * (элемент очереди бота). Готовые элементы очереди приходят с id трека библиотеки.
 */
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Некорректный элемент плейлиста');
  const tid = str(raw.trackId, 64) || (!raw.pending ? str(raw.id, 64) : '');
  const rec = tid ? findTrackRec(tid) : null;
  if (rec) return itemFromTrackRec(rec);
  const ref = cleanRef(raw.ref);
  if (!ref) throw new HttpError(400, tid ? 'Трек не найден в библиотеке' : 'Элемент плейлиста без источника');
  const cached = findBySource([ref.key, ref.url && urlKey(ref.url)].filter(Boolean));
  const title = str(raw.title, 200) || 'Без названия';
  const it = {
    iid: iidNew(), title, artist: str(raw.artist, 200),
    duration: Number.isFinite(raw.duration) && raw.duration > 0 ? Math.round(raw.duration * 10) / 10 : 0,
    source: SOURCES.includes(raw.source) ? raw.source : (ref.url ? (parseMusicLink(ref.url)?.kind === 'soundcloud' ? 'soundcloud' : 'youtube') : 'search'),
    ref,
  };
  if (cached) it.trackId = cached.id;
  return it;
}

// ---------- доступ ----------
function canEdit(server, pl, userId) {
  if (!server || !userId) return false;
  if (can(server, userId, PERMS.MANAGE_SERVER)) return true;
  return pl.createdBy === userId && can(server, userId, PERMS.USE_MUSIC_BOT);
}

function publicPlaylist(pl, server, userId, { withItems = false } = {}) {
  const author = findUser(pl.createdBy);
  const out = {
    id: pl.id, serverId: pl.serverId, name: pl.name,
    createdBy: { id: pl.createdBy, username: author?.username || 'удалённый пользователь' },
    count: pl.items.length,
    duration: Math.round(pl.items.reduce((s, it) => s + (it.duration || 0), 0)),
    createdAt: pl.createdAt, updatedAt: pl.updatedAt,
    canEdit: canEdit(server, pl, userId),
  };
  if (withItems) {
    out.items = pl.items.map((it) => ({
      iid: it.iid, title: it.title, artist: it.artist, duration: it.duration,
      ready: !!(it.trackId && findTrackRec(it.trackId)),
      source: it.source || (it.trackId ? 'library' : 'search'),
      ...(it.ref?.url ? { url: it.ref.url } : {}),
      ...((c) => (c ? { cover: c } : {}))(itemCover({ trackId: it.trackId, title: it.title, artist: it.artist, ref: it.ref, pending: !it.trackId })),
    }));
  }
  return out;
}

const listFor = (serverId) => playlists().filter((p) => p.serverId === serverId);
const findByName = (serverId, name) => listFor(serverId).find((p) => p.name.toLowerCase() === name.toLowerCase()) || null;

/**
 * Элементы для очереди бота: готовые треки библиотеки или «ожидающие» (скачаются перед воспроизведением).
 * @returns {{items:object[], missing:number}}
 */
export function playItems(pl) {
  const items = [];
  let missing = 0;
  for (const it of pl.items) {
    const rec = it.trackId ? findTrackRec(it.trackId) : null;
    if (rec) { items.push(publicTrack(rec)); continue; }
    if (!it.ref) { missing++; continue; }
    const cached = findBySource([it.ref.key, it.ref.url && urlKey(it.ref.url)].filter(Boolean));
    if (cached) { items.push(cached); continue; }
    items.push({
      pending: true, id: 'p-' + crypto.randomBytes(5).toString('hex'), title: it.title, artist: it.artist || '',
      duration: it.duration || 0, source: it.source && it.source !== 'library' ? it.source : 'search', ref: { ...it.ref },
    });
    const cover = itemCover(items[items.length - 1]);
    if (cover) items[items.length - 1].cover = cover;
  }
  return { items, missing };
}

// ---------- REST ----------
/**
 *   GET    /api/servers/:sid/playlists                    → {playlists, limits}
 *   POST   /api/servers/:sid/playlists {name, items?, replace?} → {playlist}
 *   GET    /api/servers/:sid/playlists/:pid               → {playlist (с items)}
 *   PATCH  /api/servers/:sid/playlists/:pid {name?, move?:{iid,to}} → {playlist}
 *   DELETE /api/servers/:sid/playlists/:pid               → {ok}
 *   POST   /api/servers/:sid/playlists/:pid/items {trackId | item | items | url} → {playlist, added}
 *   DELETE /api/servers/:sid/playlists/:pid/items/:iid    → {playlist}
 *   GET    /api/servers/:sid/playlists/:pid/play          → {playlist, items, missing} (для бота)
 *   GET/PUT /api/servers/:sid/music-settings {autoplay}   → {settings}
 * После каждого изменения — onChanged(serverId) (сокет-событие music:playlists / music:settings).
 */
export function createPlaylistRouter({ onChanged = () => {}, onSettings = () => {} } = {}) {
  const router = express.Router();

  /** Кто действует: человек по токену или участник, от имени которого пишет бот (asUserId) */
  function actor(req, server) {
    let userId = req.user.id;
    if (req.isBot) {
      const as = typeof req.body?.asUserId === 'string' ? req.body.asUserId : (typeof req.query.asUserId === 'string' ? req.query.asUserId : '');
      if (as) {
        if (!findUser(as)) throw new HttpError(400, 'Пользователь не найден');
        userId = as;
      }
    }
    if (!req.isBot || userId !== req.user.id) {
      if (!isMember(server, userId)) throw new HttpError(404, 'Сервер не найден');
      if (!can(server, userId, PERMS.USE_MUSIC_BOT)) throw new HttpError(403, 'Нет права управлять музыкой');
    }
    return userId;
  }

  function ctx(req) {
    const server = findServer(String(req.params.sid));
    if (!server) throw new HttpError(404, 'Сервер не найден');
    const userId = actor(req, server);
    return { server, userId };
  }

  function getPl(req, server) {
    const pl = playlists().find((p) => p.id === String(req.params.pid) && p.serverId === server.id);
    if (!pl) throw new HttpError(404, 'Плейлист не найден');
    return pl;
  }

  function requireEdit(server, pl, userId) {
    if (!canEdit(server, pl, userId)) throw new HttpError(403, 'Менять плейлист может его автор или администратор сервера');
  }

  const touch = (pl) => { pl.updatedAt = Date.now(); save(); };
  const room = (len) => PLAYLIST_LIMITS.items - len;

  router.get('/servers/:sid/playlists', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    const list = listFor(server.id).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    res.json({ playlists: list.map((p) => publicPlaylist(p, server, userId)), limits: PLAYLIST_LIMITS });
  });

  router.post('/servers/:sid/playlists', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    const name = cleanPlaylistName(req.body?.name);
    const raw = req.body?.items;
    if (raw !== undefined && !Array.isArray(raw)) throw new HttpError(400, 'items: нужен массив');
    const src = (raw || []).slice(0, 2000);
    const items = [];
    let skipped = 0;
    for (const r of src) {
      if (items.length >= PLAYLIST_LIMITS.items) { skipped++; continue; }
      try { items.push(cleanItem(r)); } catch { skipped++; }
    }
    if (raw?.length && !items.length) throw new HttpError(400, 'Ни один трек не удалось сохранить');
    const existing = findByName(server.id, name);
    if (existing) {
      if (!req.body?.replace) throw new HttpError(409, `Плейлист «${existing.name}» уже есть`);
      requireEdit(server, existing, userId);
      existing.items = items;
      touch(existing);
      onChanged(server.id);
      return res.json({ playlist: publicPlaylist(existing, server, userId, { withItems: true }), replaced: true, skipped: skipped + Math.max(0, (raw?.length || 0) - src.length) });
    }
    if (listFor(server.id).length >= PLAYLIST_LIMITS.perServer) {
      throw new HttpError(400, `На сервере уже ${PLAYLIST_LIMITS.perServer} плейлистов — удалите ненужные`);
    }
    const now = Date.now();
    const pl = { id: newId(), serverId: server.id, name, createdBy: userId, createdAt: now, updatedAt: now, items };
    playlists().push(pl);
    save();
    onChanged(server.id);
    res.json({ playlist: publicPlaylist(pl, server, userId, { withItems: true }), skipped: skipped + Math.max(0, (raw?.length || 0) - src.length) });
  });

  router.get('/servers/:sid/playlists/:pid', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    res.json({ playlist: publicPlaylist(getPl(req, server), server, userId, { withItems: true }) });
  });

  router.patch('/servers/:sid/playlists/:pid', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    const pl = getPl(req, server);
    requireEdit(server, pl, userId);
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = cleanPlaylistName(body.name);
      const other = findByName(server.id, name);
      if (other && other !== pl) throw new HttpError(409, `Плейлист «${other.name}» уже есть`);
      pl.name = name;
    }
    if (body.move !== undefined) {
      const iid = str(body.move?.iid, 40);
      const to = Number(body.move?.to);
      const from = pl.items.findIndex((it) => it.iid === iid);
      if (from === -1) throw new HttpError(404, 'Трек не найден в плейлисте');
      if (!Number.isInteger(to) || to < 1) throw new HttpError(400, 'move.to — номер позиции (1..n)');
      const [it] = pl.items.splice(from, 1);
      pl.items.splice(Math.min(to, pl.items.length + 1) - 1, 0, it);
    }
    touch(pl);
    onChanged(server.id);
    res.json({ playlist: publicPlaylist(pl, server, userId, { withItems: true }) });
  });

  router.delete('/servers/:sid/playlists/:pid', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    const pl = getPl(req, server);
    requireEdit(server, pl, userId);
    db.data.playlists = playlists().filter((p) => p !== pl);
    save();
    onChanged(server.id);
    res.json({ ok: true });
  });

  router.post('/servers/:sid/playlists/:pid/items', requireAuth, wrap(async (req, res) => {
    const { server, userId } = ctx(req);
    const pl = getPl(req, server);
    requireEdit(server, pl, userId);
    const body = req.body || {};
    let add = [];
    if (typeof body.url === 'string' && body.url.trim()) {
      if (room(pl.items.length) <= 0) throw new HttpError(400, `В плейлисте уже ${PLAYLIST_LIMITS.items} треков`);
      // ссылка/запрос: одиночный трек скачивается в библиотеку, плейлист/альбом — «ожидающие» элементы
      const r = await resolveInput(body.url.trim().slice(0, 1000), { addedBy: findUser(userId)?.username || null });
      add = r.track ? [{ trackId: r.track.id }] : (r.items || []);
    } else if (Array.isArray(body.items)) add = body.items.slice(0, PLAYLIST_LIMITS.items);
    else if (body.item) add = [body.item];
    else if (body.trackId) add = [{ trackId: body.trackId }];
    else throw new HttpError(400, 'Укажите трек (trackId), элемент очереди (item) или ссылку (url)');
    const fresh = getPl(req, server); // пока качалось, плейлист могли удалить
    const free = room(fresh.items.length);
    if (free <= 0) throw new HttpError(400, `В плейлисте уже ${PLAYLIST_LIMITS.items} треков`);
    const items = [];
    for (const r of add) {
      if (items.length >= free) break;
      items.push(add.length === 1 ? cleanItem(r) : (() => { try { return cleanItem(r); } catch { return null; } })());
    }
    const ok = items.filter(Boolean);
    if (!ok.length) throw new HttpError(400, 'Не удалось добавить трек');
    fresh.items.push(...ok);
    touch(fresh);
    onChanged(server.id);
    res.json({ playlist: publicPlaylist(fresh, server, userId, { withItems: true }), added: ok.length, truncated: add.length > ok.length });
  }));

  router.delete('/servers/:sid/playlists/:pid/items/:iid', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    const pl = getPl(req, server);
    requireEdit(server, pl, userId);
    const before = pl.items.length;
    pl.items = pl.items.filter((it) => it.iid !== String(req.params.iid));
    if (pl.items.length === before) throw new HttpError(404, 'Трек не найден в плейлисте');
    touch(pl);
    onChanged(server.id);
    res.json({ playlist: publicPlaylist(pl, server, userId, { withItems: true }) });
  });

  router.get('/servers/:sid/playlists/:pid/play', requireAuth, (req, res) => {
    const { server, userId } = ctx(req);
    const pl = getPl(req, server);
    const { items, missing } = playItems(pl);
    res.json({ playlist: publicPlaylist(pl, server, userId), items, missing });
  });

  router.get('/servers/:sid/music-settings', requireAuth, (req, res) => {
    const { server } = ctx(req);
    res.json({ settings: getMusicSettings(server.id) });
  });

  router.put('/servers/:sid/music-settings', requireAuth, (req, res) => {
    const { server } = ctx(req);
    const body = req.body || {};
    if (body.autoplay !== undefined && typeof body.autoplay !== 'boolean') throw new HttpError(400, 'autoplay: true или false');
    const settings = setMusicSettings(server.id, body);
    onSettings(server.id, settings);
    res.json({ settings });
  });

  return router;
}
