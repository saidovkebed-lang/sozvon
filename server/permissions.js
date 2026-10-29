// Права и роли (SPEC-v3 §1). Битовая маска (number ≤ 2^30), алгоритм как в Discord.
import { db } from './db.js';
import { isActiveAdmin } from './admin/access.js';

export const PERMS = Object.freeze({
  ADMINISTRATOR: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  MANAGE_CHANNELS: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  BAN_MEMBERS: 1 << 5,
  CREATE_INVITE: 1 << 6,
  VIEW_CHANNEL: 1 << 7,
  SEND_MESSAGES: 1 << 8,
  ATTACH_FILES: 1 << 9,
  MANAGE_MESSAGES: 1 << 10,
  MENTION_EVERYONE: 1 << 11,
  CONNECT: 1 << 12,
  SPEAK: 1 << 13,
  STREAM: 1 << 14,
  MUTE_MEMBERS: 1 << 15,
  DEAFEN_MEMBERS: 1 << 16,
  MOVE_MEMBERS: 1 << 17,
  USE_MUSIC_BOT: 1 << 18,
});

export const ALL_PERMS = Object.values(PERMS).reduce((a, b) => a | b, 0);

export const DEFAULT_EVERYONE = PERMS.CREATE_INVITE | PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES
  | PERMS.ATTACH_FILES | PERMS.CONNECT | PERMS.SPEAK | PERMS.STREAM | PERMS.USE_MUSIC_BOT;

/** Нормализовать маску: целое, только известные биты. */
export function cleanPerms(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n) & ALL_PERMS;
}

export const has = (perms, bit) => (perms & bit) === bit;

const isBotUser = (userId) => !!db.data.users.find((u) => u.id === userId && u.isBot);

export const everyoneRole = (server) => server.roles?.find((r) => r.id === server.id) || null;
export const findRole = (server, roleId) => server.roles?.find((r) => r.id === roleId) || null;

/** Роли участника (без @everyone), существующие. */
export function memberRoleList(server, userId) {
  const ids = server.memberRoles?.[userId] || [];
  return ids.map((id) => findRole(server, id)).filter((r) => r && r.id !== server.id);
}

/** Позиция высшей роли участника. Владелец — Infinity, без ролей — 0 (@everyone). */
export function highestPosition(server, userId) {
  if (server.ownerId === userId || isActiveAdmin(userId)) return Infinity; // администратор экземпляра — выше всех ролей
  let max = 0;
  for (const r of memberRoleList(server, userId)) if (r.position > max) max = r.position;
  return max;
}

/** Права участника на сервере (без учёта каналов). */
export function computeBase(server, userId) {
  if (!server) return 0;
  if (server.ownerId === userId || isBotUser(userId)) return ALL_PERMS;
  if (isActiveAdmin(userId)) return ALL_PERMS; // администратор экземпляра
  let perms = everyoneRole(server)?.permissions ?? DEFAULT_EVERYONE;
  for (const r of memberRoleList(server, userId)) perms |= r.permissions;
  if (has(perms, PERMS.ADMINISTRATOR)) return ALL_PERMS;
  return perms & ALL_PERMS;
}

/** Права участника в канале: base → overwrite @everyone → overwrites ролей (deny, затем allow). */
export function computeChannel(server, channelId, userId) {
  const base = computeBase(server, userId);
  if (base === ALL_PERMS && (server.ownerId === userId || isBotUser(userId) || has(base, PERMS.ADMINISTRATOR))) return ALL_PERMS;
  const ows = server.channelOverwrites?.[channelId];
  if (!ows) return base;
  let perms = base;
  const ev = ows[server.id];
  if (ev) perms = (perms & ~ev.deny) | ev.allow;
  let allow = 0, deny = 0;
  for (const r of memberRoleList(server, userId)) {
    const ow = ows[r.id];
    if (ow) { allow |= ow.allow; deny |= ow.deny; }
  }
  perms = (perms & ~deny) | allow;
  return perms & ALL_PERMS;
}

export const can = (server, userId, bit) => has(computeBase(server, userId), bit);
export const canIn = (server, channelId, userId, bit) => has(computeChannel(server, channelId, userId), bit);

/** Может ли actor действовать (кик/бан/роли/mute/move) на target: высшая роль target НИЖЕ высшей роли actor. */
export function canActOn(server, actorId, targetId) {
  if (targetId === server.ownerId) return false;
  if (actorId === server.ownerId || isActiveAdmin(actorId)) return true;
  return highestPosition(server, targetId) < highestPosition(server, actorId);
}

/** Есть ли у actor все добавляемые биты (нельзя выдать права, которых нет у себя). */
export function canGrant(server, actorId, bits) {
  const mine = computeBase(server, actorId);
  return (bits & ~mine) === 0;
}

/** Пересчитать позиции ролей: @everyone 0, остальные 1..n по текущему порядку. */
export function normalizePositions(server) {
  const rest = server.roles.filter((r) => r.id !== server.id).sort((a, b) => a.position - b.position);
  rest.forEach((r, i) => { r.position = i + 1; });
  const ev = everyoneRole(server);
  if (ev) ev.position = 0;
  server.roles = [...(ev ? [ev] : []), ...rest];
}

// ---------------------------------------------------------------- миграция --
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Идемпотентная миграция сервера к формату v3. true — что-то изменилось. */
export function migrateServer(server) {
  let changed = false;
  if (!Array.isArray(server.roles)) { server.roles = []; changed = true; }
  if (!everyoneRole(server)) {
    server.roles.unshift({
      id: server.id, name: '@everyone', color: null, permissions: DEFAULT_EVERYONE,
      position: 0, hoist: false, mentionable: false,
    });
    changed = true;
  }
  for (const r of server.roles) {
    const fixed = cleanPerms(r.permissions);
    if (fixed !== r.permissions) { r.permissions = fixed; changed = true; }
    if (typeof r.hoist !== 'boolean') { r.hoist = false; changed = true; }
    if (typeof r.mentionable !== 'boolean') { r.mentionable = false; changed = true; }
    if (r.color === undefined) { r.color = null; changed = true; }
    if (!Number.isFinite(r.position)) { r.position = r.id === server.id ? 0 : 1; changed = true; }
  }
  if (!isPlainObj(server.memberRoles)) { server.memberRoles = {}; changed = true; }
  if (!isPlainObj(server.bans)) { server.bans = {}; changed = true; }
  if (!isPlainObj(server.channelOverwrites)) { server.channelOverwrites = {}; changed = true; }
  if (typeof server.description !== 'string') { server.description = ''; changed = true; }
  if (server.banner === undefined) { server.banner = null; changed = true; }
  if (server.icon === undefined) { server.icon = null; changed = true; }
  if (!Array.isArray(server.memberIds)) { server.memberIds = []; changed = true; }
  if (server.ownerId && !server.memberIds.includes(server.ownerId)) { server.memberIds.unshift(server.ownerId); changed = true; }
  // мусор: роли участников, которых нет на сервере / несуществующие роли
  for (const [uid, ids] of Object.entries(server.memberRoles)) {
    const ok = Array.isArray(ids) ? ids.filter((id) => id !== server.id && findRole(server, id)) : [];
    if (!server.memberIds.includes(uid) || ok.length === 0) { delete server.memberRoles[uid]; changed = true; }
    else if (ok.length !== ids.length) { server.memberRoles[uid] = ok; changed = true; }
  }
  return changed;
}

export function newServerFields(serverId) {
  return {
    roles: [{ id: serverId, name: '@everyone', color: null, permissions: DEFAULT_EVERYONE, position: 0, hoist: false, mentionable: false }],
    memberRoles: {}, bans: {}, channelOverwrites: {}, description: '', banner: null,
  };
}
