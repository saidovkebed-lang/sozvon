// Доменные помощники: поиск сущностей, сериализация для клиента, онлайн-статус.
import crypto from 'node:crypto';
import { db, save, newId } from './db.js';

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
export function publicUser(u) {
  if (!u) return { id: 'deleted', username: 'Удалённый пользователь', color: '#747f8d', isBot: false, online: false };
  return { id: u.id, username: u.username, color: u.color, isBot: !!u.isBot, online: isOnline(u.id) };
}

export function publicChannel(c) {
  return { id: c.id, serverId: c.serverId, name: c.name, type: c.type, position: c.position };
}

export function publicServer(s) {
  return {
    id: s.id, name: s.name, ownerId: s.ownerId, inviteCode: s.inviteCode, icon: s.icon ?? null,
    channels: serverChannels(s.id).map(publicChannel),
    members: s.memberIds.map((id) => publicUser(findUser(id))),
  };
}

export function publicMessage(m) {
  const out = {
    id: m.id, channelId: m.channelId, author: publicUser(findUser(m.authorId)),
    content: m.content, attachments: m.attachments || [], createdAt: m.createdAt,
  };
  if (m.system) out.system = true;
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

export function addMessage({ channelId, authorId, content, attachments = [], system = false }) {
  const msg = { id: newId(), channelId, authorId, content, attachments, createdAt: Date.now() };
  if (system) msg.system = true;
  const list = (db.data.messages[channelId] ||= []);
  list.push(msg);
  if (list.length > MAX_MESSAGES_PER_CHANNEL) list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
  save();
  return msg;
}
