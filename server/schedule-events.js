// «События сервера» (как Scheduled Events в Discord): «Катка в 21:00» — название, описание, время начала
// (хранится в UTC, мс), необязательный голосовой канал. Участники отмечают «Иду» / «Может быть» / «Не иду»;
// идущим и «может быть» — напоминание за 15 минут и в момент начала: «Входящие», push, Telegram-бот.
// Не путать с server/events.js — это внутренняя шина событий для необязательных модулей (Telegram-бот).
//
// db.json: scheduledEvents: [{ id, serverId, title, description, startAt, channelId, authorId, createdAt, updatedAt,
//                              rsvp: { userId: 'going'|'maybe'|'no' }, reminded: { soon, start } }]
//
// Права: создать — любой участник сервера; изменить/удалить — автор или участник с правом «Управлять каналами»
// или «Управлять сервером» (администратор и владелец — всегда). Голосовой канал — только тот, что автор видит.
//
// Планировщик: один таймер (тик раз в 30 с) проходит по событиям из базы — после перезапуска сервера всё
// продолжается само; отправленное помечается в reminded (без дублей). Если сервер лежал во время начала
// дольше START_GRACE — устаревшее напоминание не шлём. Через сутки после начала событие удаляется.
//
// Сокет (ack {ok, error?}):
//   sevent:list   {serverId?}                                           → {events}  (все серверы, если без serverId)
//   sevent:create {serverId, title, description?, startAt, channelId?, tz?} → {event}
//   sevent:update {eventId, title?, description?, startAt?, channelId?}   → {event}
//   sevent:delete {eventId}
//   sevent:rsvp   {eventId, status: 'going'|'maybe'|'no'|null, tz?}      → {event}
// Рассылки: sevent:upsert {event} (каждому участнику — свой вид: canManage, видимость канала), sevent:removed {id, serverId}.
// Тестовые часы (только SOZVON_TEST_HOOKS=1): EVENTS_TICK_MS, EVENTS_REMIND_MIN, EVENTS_KEEP_MIN.
import { db, save, newId } from './db.js';
import { findServer, findChannel, findUser, userServers, isMember, canViewChannel, publicUser } from './model.js';
import { PERMS, can } from './permissions.js';
import { addEventNotification, dropNotifications, livePushSubs, removePushSub } from './inbox.js';
import { sendPush } from './push.js';
import { emit as emitBus } from './events.js';
import { Limiter, waitText } from './rate-limit.js';

const TEST_HOOKS = process.env.SOZVON_TEST_HOOKS === '1';
const testNum = (k, d) => {
  if (!TEST_HOOKS) return d;
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const TICK_MS = testNum('EVENTS_TICK_MS', 30_000);
export const REMIND_MS = Math.round(testNum('EVENTS_REMIND_MIN', 15) * 60_000);
export const KEEP_MS = Math.round(testNum('EVENTS_KEEP_MIN', 24 * 60) * 60_000);
export const LIVE_MS = 2 * 3600_000;          // «идёт сейчас» — столько после начала (дальше — «прошло»)
const START_GRACE_MS = 10 * 60_000;           // напоминание «начинается» позже этого не шлём
const MAX_UPCOMING = 50;                      // предстоящих событий на сервер
const MAX_AHEAD_MS = 366 * 24 * 3600_000;     // не дальше чем через год
const TITLE_MAX = 100;
const DESC_MAX = 1000;
const STATUSES = ['going', 'maybe', 'no'];
const NO_PERM = 'Изменять событие может только его автор или модератор';

export class EventError extends Error {}
const fail = (msg) => { throw new EventError(msg); };
const userRoom = (id) => `user:${id}`;
const serverRoom = (id) => `server:${id}`;

function ensure() {
  if (!Array.isArray(db.data.scheduledEvents)) db.data.scheduledEvents = [];
  return db.data.scheduledEvents;
}
const findEvent = (id) => (typeof id === 'string' ? ensure().find((e) => e.id === id) || null : null);

function cleanText(raw, { max, what, required }) {
  if (raw == null) raw = '';
  if (typeof raw !== 'string') fail(`${what}: введите текст`);
  // описание может быть многострочным, название — одна строка
  let t = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  t = required ? t.replace(/\s+/g, ' ').trim() : t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (required && !t) fail(`${what} не может быть пустым`);
  if (t.length > max) fail(`${what} слишком длинное (максимум ${max} символов)`);
  return t;
}

function cleanStart(v, { prev } = {}) {
  const ms = typeof v === 'string' && v.trim() ? Date.parse(v) : Number(v);
  if (!Number.isFinite(ms)) fail('Укажите дату и время начала');
  const now = Date.now();
  if (ms !== prev && ms < now - 60_000) fail('Время начала уже прошло');
  if (ms > now + MAX_AHEAD_MS) fail('Событие можно назначить не дальше чем на год вперёд');
  return Math.floor(ms);
}

function cleanChannel(server, userId, channelId) {
  if (channelId == null || channelId === '') return null;
  const ch = typeof channelId === 'string' ? findChannel(channelId) : null;
  if (!ch || ch.serverId !== server.id || ch.type !== 'voice' || !canViewChannel(server, ch.id, userId)) fail('Голосовой канал не найден');
  return ch.id;
}

/** Часовой пояс пользователя (для времени в Telegram): только настоящие IANA-зоны */
function rememberTz(user, tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || user.tz === tz) return;
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: tz }); } catch { return; }
  user.tz = tz;
}

export const canManageEvent = (server, ev, userId) => ev.authorId === userId
  || can(server, userId, PERMS.MANAGE_CHANNELS) || can(server, userId, PERMS.MANAGE_SERVER);

/** Событие глазами участника viewerId */
export function publicEvent(ev, viewerId) {
  const server = findServer(ev.serverId);
  const ch = ev.channelId ? findChannel(ev.channelId) : null;
  const channelOk = !!server && !!ch && ch.serverId === server.id && canViewChannel(server, ch.id, viewerId);
  const rsvp = { going: [], maybe: [], no: [] };
  for (const [uid, st] of Object.entries(ev.rsvp || {})) {
    if (rsvp[st] && server?.memberIds.includes(uid)) rsvp[st].push(uid);
  }
  return {
    id: ev.id, serverId: ev.serverId, title: ev.title, description: ev.description || '',
    startAt: ev.startAt, channelId: channelOk ? ch.id : null, channelName: channelOk ? ch.name : null,
    authorId: ev.authorId, author: publicUser(findUser(ev.authorId)),
    createdAt: ev.createdAt, updatedAt: ev.updatedAt || ev.createdAt,
    rsvp, me: ev.rsvp?.[viewerId] || null,
    canManage: !!server && canManageEvent(server, ev, viewerId),
  };
}

/** Видимые события (ещё не удалённые) серверов пользователя, по времени начала */
export function listEventsFor(userId, serverId = null) {
  const ids = new Set(userServers(userId).filter((s) => !serverId || s.id === serverId).map((s) => s.id));
  return ensure().filter((e) => ids.has(e.serverId)).sort((a, b) => a.startAt - b.startAt).map((e) => publicEvent(e, userId));
}

/** Текст напоминания (одинаково для push и Telegram) */
export function reminderText(kind, ev, { now = Date.now() } = {}) {
  if (kind === 'start') return `«${ev.title}» начинается`;
  const min = Math.max(1, Math.round((ev.startAt - now) / 60_000));
  return `«${ev.title}» — через ${min} мин`;
}

export function createScheduleEvents(io, { hasVisibleClient = () => false } = {}) {
  const editLimiter = new Limiter({ limit: 30, windowMs: 10 * 60_000 });
  const rsvpLimiter = new Limiter({ limit: 60, windowMs: 60_000 });
  // проверка — до действия, счёт — только удачных (ошибка ввода попытку не тратит)
  const limit = (lim, key) => {
    const w = lim.blockedFor(key);
    if (w) fail(`Слишком часто — подождите ${waitText(w)}`);
  };

  // ---------- рассылки ----------
  function emitUpsert(ev) {
    const server = findServer(ev.serverId);
    if (!server) return;
    for (const id of server.memberIds) {
      if (findUser(id)?.isBot) continue;
      io.to(userRoom(id)).emit('sevent:upsert', { event: publicEvent(ev, id) });
    }
  }
  function emitRemoved(ev) {
    io.to(serverRoom(ev.serverId)).emit('sevent:removed', { id: ev.id, serverId: ev.serverId });
  }
  function removeEvent(ev) {
    const list = ensure();
    const i = list.indexOf(ev);
    if (i >= 0) list.splice(i, 1);
    // напоминания об удалённом событии из «Входящих» убираем
    const touched = dropNotifications((n) => n.type === 'event' && n.eventId === ev.id);
    for (const uid of touched) io.to(userRoom(uid)).emit('notification:removed', { eventId: ev.id });
    save();
    emitRemoved(ev);
  }

  // ---------- напоминания ----------
  function remind(ev, kind) {
    const server = findServer(ev.serverId);
    if (!server) return 0;
    const ch = ev.channelId ? findChannel(ev.channelId) : null;
    let sent = 0;
    for (const [uid, st] of Object.entries(ev.rsvp || {})) {
      if (st !== 'going' && st !== 'maybe') continue;
      const u = findUser(uid);
      if (!u || u.isBot || !isMember(server, uid)) continue;
      const channelOk = !!ch && ch.serverId === server.id && canViewChannel(server, ch.id, uid);
      const view = { ...ev, channelId: channelOk ? ch.id : null };
      const n = addEventNotification(uid, { kind, event: view });
      io.to(userRoom(uid)).emit('notification:new', { notification: n });
      const active = hasVisibleClient(uid);
      const info = {
        kind, eventId: ev.id, title: ev.title, startAt: ev.startAt, rsvp: st,
        serverId: server.id, serverName: server.name,
        channelId: channelOk ? ch.id : null, channelName: channelOk ? ch.name : null,
        text: reminderText(kind, ev),
      };
      // Telegram-бот (server/tgbot.js) сам проверит настройки пользователя, DND и «только когда меня нет в Astra»
      emitBus('event-reminder', uid, info, { active });
      sent++;
      if (u.status === 'dnd' || active) continue;
      const subs = livePushSubs(uid);
      if (!subs.length) continue;
      const payload = {
        title: `${server.name} · событие`,
        body: `${info.text}${info.channelName ? ` · 🔊 ${info.channelName}` : ''}`,
        tag: `sozvon-event-${ev.id}`, type: 'event', eventId: ev.id,
        url: `/?event=${encodeURIComponent(ev.id)}`, joinChannelId: info.channelId,
        icon: typeof server.icon === 'string' && server.icon.startsWith('/') && !server.icon.startsWith('//') ? server.icon : undefined,
      };
      for (const sub of subs) {
        sendPush(sub, payload).then((r) => { if (r.gone) removePushSub(uid, sub.endpoint); }).catch((e) => console.warn('[push]', e?.message || e));
      }
    }
    return sent;
  }

  /** Один проход планировщика: напоминания, уборка прошедших и событий удалённых серверов */
  function tick(now = Date.now()) {
    let changed = false;
    for (const ev of [...ensure()]) {
      if (!findServer(ev.serverId)) { removeEvent(ev); continue; }
      if (now >= ev.startAt + KEEP_MS) { removeEvent(ev); continue; }
      const r = (ev.reminded ||= { soon: false, start: false });
      // сначала помечаем (и сохраняем), потом шлём — после перезапуска повторов не будет
      if (!r.soon && now >= ev.startAt - REMIND_MS) {
        r.soon = true;
        changed = true;
        if (now < ev.startAt) remind(ev, 'soon');
      }
      if (!r.start && now >= ev.startAt) {
        r.start = true;
        changed = true;
        if (now - ev.startAt <= START_GRACE_MS) remind(ev, 'start');
      }
    }
    if (changed) save();
  }

  const timer = setInterval(() => {
    try { tick(); } catch (err) { console.error('[schedule-events] tick:', err); }
  }, TICK_MS);
  timer.unref();
  // после старта — сразу (восстановление из базы), не дожидаясь первого интервала
  setTimeout(() => { try { tick(); } catch (err) { console.error('[schedule-events] tick:', err); } }, Math.min(TICK_MS, 2000)).unref();

  // ---------- сокеты ----------
  function attach(socket, user) {
    const on = (event, handler) => socket.on(event, async (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = {}; }
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!findUser(user.id) || !db.data.sessions[socket.data.token]) fail('Сессия недействительна');
        const res = await handler(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
        reply({ ok: true, ...(res || {}) });
      } catch (err) {
        if (!(err instanceof EventError)) console.error(`[schedule-events] ${event}:`, err);
        reply({ ok: false, error: err instanceof EventError ? err.message : 'Внутренняя ошибка сервера' });
      }
    });
    const memberServer = (serverId) => {
      const server = typeof serverId === 'string' ? findServer(serverId) : null;
      if (!server || !isMember(server, user.id)) fail('Сервер не найден');
      return server;
    };
    const eventFor = (eventId) => {
      const ev = findEvent(eventId);
      const server = ev && findServer(ev.serverId);
      if (!ev || !server || !isMember(server, user.id)) fail('Событие не найдено');
      return { ev, server };
    };

    on('sevent:list', ({ serverId }) => {
      if (serverId != null) memberServer(serverId);
      return { events: listEventsFor(user.id, serverId || null) };
    });

    on('sevent:create', ({ serverId, title, description, startAt, channelId, tz }) => {
      const server = memberServer(serverId);
      limit(editLimiter, user.id);
      const now = Date.now();
      const upcoming = ensure().filter((e) => e.serverId === server.id && e.startAt > now).length;
      if (upcoming >= MAX_UPCOMING) fail(`На сервере уже ${MAX_UPCOMING} предстоящих событий — удалите лишние`);
      const ev = {
        id: newId(), serverId: server.id,
        title: cleanText(title, { max: TITLE_MAX, what: 'Название', required: true }),
        description: cleanText(description, { max: DESC_MAX, what: 'Описание' }),
        startAt: cleanStart(startAt),
        channelId: cleanChannel(server, user.id, channelId),
        authorId: user.id, createdAt: now, updatedAt: now,
        rsvp: { [user.id]: 'going' }, reminded: { soon: false, start: false },
      };
      rememberTz(user, tz);
      ensure().push(ev);
      editLimiter.hit(user.id);
      save();
      emitUpsert(ev);
      return { event: publicEvent(ev, user.id) };
    });

    on('sevent:update', (p) => {
      const { ev, server } = eventFor(p.eventId);
      if (!canManageEvent(server, ev, user.id)) fail(NO_PERM);
      limit(editLimiter, user.id);
      const next = {
        title: p.title !== undefined ? cleanText(p.title, { max: TITLE_MAX, what: 'Название', required: true }) : ev.title,
        description: p.description !== undefined ? cleanText(p.description, { max: DESC_MAX, what: 'Описание' }) : ev.description,
        startAt: p.startAt !== undefined ? cleanStart(p.startAt, { prev: ev.startAt }) : ev.startAt,
        channelId: p.channelId !== undefined ? (p.channelId === ev.channelId ? ev.channelId : cleanChannel(server, user.id, p.channelId)) : ev.channelId,
      };
      if (next.startAt !== ev.startAt) {
        // перенесли — напоминания заново (по новому времени)
        ev.reminded = { soon: false, start: false };
      }
      Object.assign(ev, next, { updatedAt: Date.now() });
      editLimiter.hit(user.id);
      save();
      emitUpsert(ev);
      return { event: publicEvent(ev, user.id) };
    });

    on('sevent:delete', ({ eventId }) => {
      const { ev, server } = eventFor(eventId);
      if (!canManageEvent(server, ev, user.id)) fail(NO_PERM);
      limit(editLimiter, user.id);
      editLimiter.hit(user.id);
      removeEvent(ev);
    });

    on('sevent:rsvp', ({ eventId, status, tz }) => {
      const { ev } = eventFor(eventId);
      if (user.isBot) fail('Недоступно для бота');
      if (status !== null && !STATUSES.includes(status)) fail('Ответ: «Иду», «Может быть» или «Не иду»');
      limit(rsvpLimiter, user.id);
      ev.rsvp ||= {};
      if (status === null) delete ev.rsvp[user.id]; else ev.rsvp[user.id] = status;
      rsvpLimiter.hit(user.id);
      rememberTz(user, tz);
      save();
      emitUpsert(ev);
      return { event: publicEvent(ev, user.id) };
    });
  }

  return { attach, tick, listFor: listEventsFor, remind };
}
