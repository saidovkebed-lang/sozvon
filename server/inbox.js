// Личные сообщения (1 на 1, только текст и вложения) и «Входящие» (упоминания, @everyone, ЛС),
// метки прочитанного и подписки на push. Хранится в db.json:
//   dms:           [{ id, userIds: [a, b], createdAt, lastAt, hidden: { userId: true } }]
//   readState:     { userId: { channelId|dmId: ts } }
//   notifications: { userId: [{ id, type, channelId, serverId, messageId, authorId, preview, count, createdAt, read }] }
//   pushSubs:      { userId: [{ endpoint, keys: {p256dh, auth}, createdAt, ua }] }
import crypto from 'node:crypto';
import { db, save, newId } from './db.js';
import { findUser, findServer, findChannel, publicUser, publicMessage } from './model.js';

const MAX_NOTIFICATIONS = 100;
const MAX_PUSH_SUBS = 10;
const PREVIEW_LEN = 140;

function ensure() {
  const d = db.data;
  if (!Array.isArray(d.dms)) d.dms = [];
  if (!d.readState || typeof d.readState !== 'object') d.readState = {};
  if (!d.notifications || typeof d.notifications !== 'object') d.notifications = {};
  if (!d.pushSubs || typeof d.pushSubs !== 'object') d.pushSubs = {};
  return d;
}

// ---------- ЛС ----------
export const findDm = (id) => (typeof id === 'string' ? ensure().dms.find((d) => d.id === id) || null : null);
export const isDmMember = (dm, userId) => !!dm && dm.userIds.includes(userId);
export const dmOther = (dm, userId) => dm.userIds.find((id) => id !== userId) || userId;
export const userDms = (userId) => ensure().dms.filter((d) => d.userIds.includes(userId));

/** Есть ли общий сервер (писать в ЛС можно только тем, с кем вы на одном сервере) */
export function sharesServer(a, b) {
  return db.data.servers.some((s) => s.memberIds.includes(a) && s.memberIds.includes(b));
}

export function getOrCreateDm(a, b) {
  const d = ensure();
  let dm = d.dms.find((x) => x.userIds.includes(a) && x.userIds.includes(b));
  if (!dm) {
    dm = { id: newId(), userIds: [a, b], createdAt: Date.now(), lastAt: Date.now(), hidden: {} };
    d.dms.push(dm);
    save();
  }
  return dm;
}

export function readAt(userId, channelId) {
  return ensure().readState[userId]?.[channelId] || 0;
}

export function setRead(userId, channelId, at = Date.now()) {
  const rs = (ensure().readState[userId] ||= {});
  if ((rs[channelId] || 0) >= at) return false;
  rs[channelId] = at;
  save();
  return true;
}

export function dmUnread(dm, userId) {
  const since = readAt(userId, dm.id);
  const list = db.data.messages[dm.id] || [];
  let n = 0;
  for (let i = list.length - 1; i >= 0 && n < 100; i--) {
    const m = list[i];
    if (m.createdAt <= since) break;
    if (m.authorId !== userId) n++;
  }
  return n;
}

/** ЛС глазами пользователя viewerId */
export function publicDm(dm, viewerId) {
  const other = findUser(dmOther(dm, viewerId));
  const list = db.data.messages[dm.id] || [];
  const last = list[list.length - 1];
  return {
    id: dm.id,
    user: publicUser(other),
    lastMessage: last ? publicMessage(last) : null,
    lastAt: dm.lastAt || dm.createdAt,
    unread: dmUnread(dm, viewerId),
    canMessage: !!other && !other.isBot && sharesServer(viewerId, other.id),
    hidden: !!dm.hidden?.[viewerId],
  };
}

export function listDms(userId) {
  return userDms(userId)
    .filter((d) => !d.hidden?.[userId])
    .map((d) => publicDm(d, userId))
    .sort((x, y) => y.lastAt - x.lastAt);
}

// ---------- «Входящие» ----------
function preview(msg) {
  let t = String(msg.content || '').replace(/\s+/g, ' ').trim();
  if (!t && msg.attachments?.length) {
    const a = msg.attachments;
    const kind = a.every((x) => String(x.type).startsWith('image/')) ? 'Фото' : a.every((x) => String(x.type).startsWith('video/')) ? 'Видео' : 'Файл';
    t = `📎 ${kind}${a.length > 1 ? ` (${a.length})` : ''}`;
  }
  return t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN - 1) + '…' : t;
}

export function publicNotification(n) {
  const ch = n.serverId ? findChannel(n.channelId) : null;
  const srv = n.serverId ? findServer(n.serverId) : null;
  return {
    id: n.id, type: n.type, channelId: n.channelId, serverId: n.serverId || null,
    serverName: srv?.name || null, channelName: ch?.name || null,
    messageId: n.messageId, author: publicUser(findUser(n.authorId)),
    preview: n.preview, count: n.count || 1, createdAt: n.createdAt, read: !!n.read,
  };
}

/**
 * Откуда пришло уведомление — одинаково для push и «Входящих».
 * Сервер: «Сервер · #канал», тело «Автор: текст»; ЛС: «Личные сообщения · Автор», тело — текст.
 */
export function notificationText(n, authorName = 'Кто-то') {
  const text = n.preview || 'Новое сообщение';
  if (n.type === 'dm') return { title: `Личные сообщения · ${authorName}`, body: text, source: 'Личные сообщения' };
  const source = `${n.serverName || 'Сервер'} · #${n.channelName || 'канал'}`;
  const how = n.type === 'everyone' ? ' (@everyone)' : ' упомянул(а) вас';
  return { title: source, body: `${authorName}${how}: ${text}`, source };
}

/**
 * Новое уведомление. type: 'mention' | 'everyone' | 'dm'. Для ЛС непрочитанное уведомление по тому же чату
 * обновляется (счётчик), а не плодится. Возвращает публичный вид.
 */
export function addNotification(userId, { type, channelId, serverId = null, message }) {
  const d = ensure();
  const list = (d.notifications[userId] ||= []);
  let n = type === 'dm' ? list.find((x) => x.type === 'dm' && x.channelId === channelId && !x.read) : null;
  if (n) {
    list.splice(list.indexOf(n), 1);
    n.messageIds = [...(n.messageIds || [n.messageId]), message.id].slice(-100);
    n.count = n.messageIds.length;
    n.messageId = message.id;
    n.authorId = message.authorId;
    n.preview = preview(message);
    n.createdAt = message.createdAt;
  } else {
    n = { id: newId(), type, channelId, serverId, messageId: message.id, messageIds: [message.id], authorId: message.authorId, preview: preview(message), count: 1, createdAt: message.createdAt, read: false };
  }
  list.push(n);
  if (list.length > MAX_NOTIFICATIONS) list.splice(0, list.length - MAX_NOTIFICATIONS);
  save();
  return publicNotification(n);
}

export function listNotifications(userId, limit = 50) {
  const list = ensure().notifications[userId] || [];
  return list.slice(-limit).reverse().map(publicNotification);
}

/** Отметить прочитанными: { ids } | { channelId } | { all: true }. Возвращает id изменённых. */
export function markNotificationsRead(userId, { ids, channelId, all } = {}) {
  const list = ensure().notifications[userId] || [];
  const want = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  const changed = [];
  for (const n of list) {
    if (n.read) continue;
    if (all || (want && want.has(n.id)) || (channelId && n.channelId === channelId)) { n.read = true; changed.push(n.id); }
  }
  if (changed.length) save();
  return changed;
}

/** Убрать уведомления о канале/сообщении (канал удалён, сообщение удалено, доступ потерян) */
export function dropNotifications(pred) {
  const d = ensure();
  const touched = [];
  for (const [uid, list] of Object.entries(d.notifications)) {
    const keep = list.filter((n) => !pred(n, uid));
    if (keep.length !== list.length) { d.notifications[uid] = keep; touched.push(uid); }
  }
  if (touched.length) save();
  return touched;
}

/**
 * Сообщение удалено: уведомления о нём убираются; у схлопнутого уведомления о ЛС — только это сообщение
 * (счётчик и превью — по оставшимся). Возвращает { removed: [{userId, id}], updated: [{userId, notification}] }.
 */
export function forgetMessage(messageId) {
  const d = ensure();
  const removed = [];
  const updated = [];
  for (const [uid, list] of Object.entries(d.notifications)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const ids = n.messageIds || [n.messageId];
      if (!ids.includes(messageId)) continue;
      const rest = ids.filter((id) => id !== messageId);
      const msgs = d.messages[n.channelId] || [];
      const last = rest.length ? msgs.filter((m) => rest.includes(m.id)).pop() : null;
      if (!last) { list.splice(i, 1); removed.push({ userId: uid, id: n.id }); continue; }
      n.messageIds = rest;
      n.count = rest.length;
      n.messageId = last.id;
      n.authorId = last.authorId;
      n.preview = preview(last);
      n.createdAt = last.createdAt;
      updated.push({ userId: uid, notification: publicNotification(n) });
    }
  }
  if (removed.length || updated.length) save();
  return { removed, updated };
}

// ---------- push-подписки ----------
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
export const pushSubsOf = (userId) => ensure().pushSubs[userId] || [];

/** Подписка привязана к сессии (token): выход/смена пароля в другом месте — push туда больше не идёт */
export function addPushSub(userId, sub, ua = '', token = '') {
  const d = ensure();
  // одна подписка может принадлежать только одному аккаунту (сменили аккаунт в браузере)
  for (const [uid, list] of Object.entries(d.pushSubs)) {
    if (uid !== userId) d.pushSubs[uid] = list.filter((s) => s.endpoint !== sub.endpoint);
  }
  const list = (d.pushSubs[userId] ||= []).filter((s) => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, session: token ? tokenHash(token) : null, createdAt: Date.now(), ua: String(ua).slice(0, 200) });
  if (list.length > MAX_PUSH_SUBS) list.splice(0, list.length - MAX_PUSH_SUBS);
  d.pushSubs[userId] = list;
  save();
}

export function removePushSub(userId, endpoint) {
  const d = ensure();
  const list = d.pushSubs[userId] || [];
  const keep = list.filter((s) => s.endpoint !== endpoint);
  if (keep.length === list.length) return false;
  d.pushSubs[userId] = keep;
  save();
  return true;
}

/** Сессии отозваны (смена пароля): их подписки удаляются */
export function dropPushSubsForSessions(userId, tokens) {
  const d = ensure();
  const list = d.pushSubs[userId] || [];
  if (!list.length || !tokens?.length) return 0;
  const gone = new Set(tokens.map(tokenHash));
  const keep = list.filter((s) => !s.session || !gone.has(s.session));
  if (keep.length === list.length) return 0;
  d.pushSubs[userId] = keep;
  save();
  return list.length - keep.length;
}

/** Подписки, чья сессия ещё жива (и старые без привязки) */
export function livePushSubs(userId) {
  const subs = pushSubsOf(userId);
  if (!subs.some((s) => s.session)) return subs;
  const live = new Set(Object.keys(db.data.sessions || {}).filter((t) => db.data.sessions[t]?.userId === userId).map(tokenHash));
  return subs.filter((s) => !s.session || live.has(s.session));
}
