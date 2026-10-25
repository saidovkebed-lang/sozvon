// Доменные помощники: поиск сущностей, сериализация для клиента, онлайн-статус.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, save, newId } from './db.js';
import {
  migrateServer, computeChannel, computeBase, has, PERMS,
} from './permissions.js';
import { computeBadges, publicServerTheme, cleanChoice, AVATAR_FRAMES, BANNER_PRESETS } from './cosmetics.js';

export const BOT_USERNAME = 'DJ Бот';
export const MAX_MESSAGES_PER_CHANNEL = 2000;

const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#f47b67', '#3ba55c',
  '#faa61a', '#9b59b6', '#1abc9c', '#e67e22', '#00b0f4', '#ff73fa', '#a3d977'];

export function randomColor() {
  return COLORS[crypto.randomInt(COLORS.length)];
}

// ---------- онлайн ----------
const userSockets = new Map(); // userId -> Set(socketId)
export function addOnlineSocket(userId, socketId) {
  let set = userSockets.get(userId);
  const wasOnline = !!set && set.size > 0;
  if (!set) userSockets.set(userId, (set = new Set()));
  set.add(socketId);
  return !wasOnline;
}
export function removeOnlineSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) { userSockets.delete(userId); return true; }
  return false;
}
export function isOnline(userId) {
  const set = userSockets.get(userId);
  return !!set && set.size > 0;
}
/** Онлайн для других: подключён и не «невидимый». */
export function isVisiblyOnline(userId) {
  if (!isOnline(userId)) return false;
  return findUser(userId)?.status !== 'invisible';
}

// ---------- поиск ----------
export const findUser = (id) => db.data.users.find((u) => u.id === id) || null;
export const findUserByName = (name) => {
  const l = String(name).toLowerCase();
  return db.data.users.find((u) => u.usernameLower === l) || null;
};
export const findServer = (id) => db.data.servers.find((s) => s.id === id) || null;
export const findChannel = (id) => db.data.channels.find((c) => c.id === id) || null;
export const serverChannels = (serverId) =>
  db.data.channels.filter((c) => c.serverId === serverId).sort((a, b) => a.position - b.position);
export const userServers = (userId) => db.data.servers.filter((s) => s.memberIds.includes(userId));
export const isMember = (server, userId) => !!server && server.memberIds.includes(userId);

export function getBotUser() {
  return db.data.users.find((u) => u.isBot) || null;
}

export function ensureBotUser() {
  let bot = getBotUser();
  if (!bot) {
    const taken = findUserByName(BOT_USERNAME);
    if (taken) taken.usernameLower = taken.usernameLower + '_' + taken.id; // крайне маловероятно
    bot = {
      id: newId(), username: BOT_USERNAME, usernameLower: BOT_USERNAME.toLowerCase(),
      passwordHash: null, color: '#43b581', isBot: true, createdAt: Date.now(),
    };
    db.data.users.push(bot);
  }
  // Бот — участник всех серверов
  for (const s of db.data.servers) {
    if (!s.memberIds.includes(bot.id)) s.memberIds.push(bot.id);
  }
  save();
  return bot;
}

// ---------- сериализация ----------
export const USER_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

/** Актуальный кастомный статус (истёкший → null). */
export function activeCustomStatus(u) {
  const cs = u?.customStatus;
  if (!cs || typeof cs !== 'object') return null;
  if (Number.isFinite(cs.expiresAt) && cs.expiresAt <= Date.now()) return null;
  return { emoji: cs.emoji ?? null, text: cs.text ?? '', expiresAt: Number.isFinite(cs.expiresAt) ? cs.expiresAt : null };
}

/**
 * Пользователь для клиента. self=true — смотрит сам пользователь (реальный статус, даже «невидимый»);
 * для других «невидимый» выглядит как offline.
 */
export function publicUser(u, { self = false } = {}) {
  if (!u) {
    return {
      id: 'deleted', username: 'Удалённый пользователь', displayName: null, color: '#747f8d', isBot: false, online: false,
      avatar: null, avatarAnimated: null, banner: null, bannerAnimated: null, bannerColor: null, about: '', pronouns: '',
      status: 'offline', customStatus: null, profileTheme: null, createdAt: null,
      avatarFrame: null, bannerPreset: null, badges: [],
    };
  }
  const connected = isOnline(u.id);
  const status = USER_STATUSES.includes(u.status) ? u.status : 'online';
  const online = self ? connected : connected && status !== 'invisible';
  return {
    id: u.id, username: u.username, displayName: u.displayName ?? null, color: u.color, isBot: !!u.isBot, online,
    avatar: u.avatar ?? null, avatarAnimated: u.avatarAnimated ?? null,
    banner: u.banner ?? null, bannerAnimated: u.bannerAnimated ?? null, bannerColor: u.bannerColor ?? null,
    about: u.about ?? '', pronouns: u.pronouns ?? '',
    status: self ? status : (online ? status : 'offline'),
    customStatus: activeCustomStatus(u),
    profileTheme: u.profileTheme ?? null,
    createdAt: u.createdAt ?? null,
    // Astra 2.0: рамка аватара, анимированный баннер, автоматические значки
    avatarFrame: cleanChoice(u.avatarFrame, AVATAR_FRAMES) || null,
    bannerPreset: cleanChoice(u.bannerPreset, BANNER_PRESETS) || null,
    badges: computeBadges(u),
  };
}

export function publicChannel(c) {
  return { id: c.id, serverId: c.serverId, name: c.name, type: c.type, position: c.position };
}

function publicBans(s) {
  const out = {};
  for (const [uid, b] of Object.entries(s.bans || {})) {
    const u = findUser(uid);
    out[uid] = {
      by: b.by ?? null, reason: b.reason ?? '', at: b.at ?? null,
      user: u ? { id: u.id, username: u.username, displayName: u.displayName ?? null, avatar: u.avatar ?? null, color: u.color }
        : { id: uid, username: 'Удалённый пользователь', displayName: null, avatar: null, color: '#747f8d' },
    };
  }
  return out;
}

/** Видит ли пользователь канал. */
export const canViewChannel = (server, channelId, userId) =>
  has(computeChannel(server, channelId, userId), PERMS.VIEW_CHANNEL);

/** Сервер глазами пользователя viewerId: без невидимых каналов, inviteCode/bans — по правам. */
export function publicServer(s, viewerId) {
  const base = computeBase(s, viewerId);
  const channels = serverChannels(s.id).filter((c) => canViewChannel(s, c.id, viewerId));
  const visible = new Set(channels.map((c) => c.id));
  const overwrites = {};
  for (const [cid, ow] of Object.entries(s.channelOverwrites || {})) if (visible.has(cid)) overwrites[cid] = ow;
  return {
    id: s.id, name: s.name, ownerId: s.ownerId,
    inviteCode: has(base, PERMS.CREATE_INVITE) ? s.inviteCode : null,
    icon: s.icon ?? null, banner: s.banner ?? null, description: s.description ?? '',
    theme: publicServerTheme(s),
    channels: channels.map(publicChannel),
    members: s.memberIds.map((id) => publicUser(findUser(id), { self: id === viewerId })),
    roles: (s.roles || []).map((r) => ({ ...r })),
    memberRoles: Object.fromEntries(Object.entries(s.memberRoles || {}).map(([k, v]) => [k, [...v]])),
    channelOverwrites: overwrites,
    bans: has(base, PERMS.BAN_MEMBERS) ? publicBans(s) : null,
  };
}

export function publicMessage(m) {
  const out = {
    id: m.id, channelId: m.channelId, author: publicUser(findUser(m.authorId)),
    content: m.content, attachments: m.attachments || [], createdAt: m.createdAt,
  };
  if (m.system) out.system = true;
  if (m.mentionEveryone) out.mentionEveryone = true;
  if (m.recap) out.recap = { serverId: m.recap.serverId, period: m.recap.period }; // «Astra Итоги»
  return out;
}

// ---------- мутации ----------
export function generateInviteCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!db.data.servers.some((s) => s.inviteCode === code)) return code;
  }
}

export function addMessage({ channelId, authorId, content, attachments = [], system = false, mentionEveryone = false }) {
  const msg = { id: newId(), channelId, authorId, content, attachments, createdAt: Date.now() };
  if (system) msg.system = true;
  if (mentionEveryone) msg.mentionEveryone = true;
  const list = (db.data.messages[channelId] ||= []);
  list.push(msg);
  if (list.length > MAX_MESSAGES_PER_CHANNEL) list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
  save();
  return msg;
}

// ---------- миграция данных (v1/v2 → v3) ----------
export const DB_VERSION = 3;

/** Идемпотентная миграция пользователя. true — изменился. */
export function migrateUser(u) {
  let changed = false;
  const defaults = {
    displayName: null, avatar: null, avatarAnimated: null, banner: null, bannerAnimated: null, bannerColor: null,
    about: '', pronouns: '', status: 'online', customStatus: null, profileTheme: null,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (u[k] === undefined) { u[k] = v; changed = true; }
  }
  if (!USER_STATUSES.includes(u.status)) { u.status = 'online'; changed = true; }
  if (!Number.isFinite(u.createdAt)) { u.createdAt = Date.now(); changed = true; }
  return changed;
}

/**
 * Миграция всей базы при старте. Перед первым изменением сохраняет копию db.json
 * (db.json.pre-v3-<время>). Повторный запуск ничего не меняет.
 */
export function migrateDb() {
  const d = db.data;
  let changed = false;
  for (const u of d.users) if (migrateUser(u)) changed = true;
  for (const s of d.servers) if (migrateServer(s)) changed = true;
  if ((d.version || 1) < DB_VERSION) changed = true;
  if (!changed) return false;
  if (db.file && fs.existsSync(db.file) && (d.version || 1) < DB_VERSION) {
    const backup = `${db.file}.pre-v3-${Date.now()}`;
    try { fs.copyFileSync(db.file, backup); console.log(`[db] Миграция к v3. Копия старой базы: ${backup}`); } catch (err) {
      console.error('[db] Не удалось сохранить копию перед миграцией:', err.message);
    }
  }
  d.version = DB_VERSION;
  save();
  return true;
}
