// Права и роли (SPEC-v3 §1) — те же биты и алгоритм, что server/permissions.js. Только для гейтинга UI:
// окончательное решение всегда принимает сервер.
import { state } from './state.js';

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

export const DEFAULT_EVERYONE = PERMS.CREATE_INVITE | PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES |
  PERMS.ATTACH_FILES | PERMS.CONNECT | PERMS.SPEAK | PERMS.STREAM | PERMS.USE_MUSIC_BOT;

/** Описания для редактора ролей (по-русски, сгруппированы как в Discord). channel — применимо в правах канала. */
export const PERM_GROUPS = [
  {
    title: 'Общие права сервера',
    perms: [
      ['VIEW_CHANNEL', 'Просматривать каналы', 'Видеть текстовые каналы и читать их, видеть голосовые каналы.', 'all'],
      ['MANAGE_CHANNELS', 'Управлять каналами', 'Создавать, переименовывать и удалять каналы, менять их права.', 'all'],
      ['MANAGE_ROLES', 'Управлять ролями', 'Создавать и менять роли ниже своей высшей роли и выдавать их участникам.', 'server'],
      ['MANAGE_SERVER', 'Управлять сервером', 'Менять название, описание, иконку и баннер сервера, создавать новый инвайт.', 'server'],
    ],
  },
  {
    title: 'Участники',
    perms: [
      ['CREATE_INVITE', 'Приглашать участников', 'Видеть и копировать инвайт-код сервера.', 'server'],
      ['KICK_MEMBERS', 'Выгонять участников', 'Удалять участников с сервера. Они смогут вернуться по инвайту.', 'server'],
      ['BAN_MEMBERS', 'Банить участников', 'Блокировать участников навсегда и снимать блокировку.', 'server'],
    ],
  },
  {
    title: 'Текстовые каналы',
    perms: [
      ['SEND_MESSAGES', 'Отправлять сообщения', 'Писать в текстовых каналах.', 'text'],
      ['ATTACH_FILES', 'Прикреплять файлы', 'Загружать картинки и файлы в чат.', 'text'],
      ['MENTION_EVERYONE', 'Упоминать @everyone', 'Сообщения с @everyone и @here подсвечиваются у всех.', 'text'],
      ['MANAGE_MESSAGES', 'Управлять сообщениями', 'Удалять чужие сообщения.', 'text'],
    ],
  },
  {
    title: 'Голосовые каналы',
    perms: [
      ['CONNECT', 'Подключаться', 'Заходить в голосовые каналы.', 'voice'],
      ['SPEAK', 'Говорить', 'Без этого права участник заходит с выключенным микрофоном.', 'voice'],
      ['STREAM', 'Видео и демонстрация', 'Включать камеру и показывать экран.', 'voice'],
      ['MUTE_MEMBERS', 'Отключать микрофон участникам', 'Серверный mute для других участников.', 'voice'],
      ['DEAFEN_MEMBERS', 'Отключать звук участникам', 'Серверный deafen для других участников.', 'voice'],
      ['MOVE_MEMBERS', 'Перемещать участников', 'Переносить участников между голосовыми каналами и отключать их.', 'voice'],
      ['USE_MUSIC_BOT', 'Музыка и «Смотреть вместе»', 'Команды !play, кнопки плеера DJ Бота и включение видео для совместного просмотра.', 'voice'],
    ],
  },
  {
    title: 'Расширенные',
    perms: [
      ['ADMINISTRATOR', 'Администратор', 'Все права и обход прав каналов. Не даёт удалить сервер и передать владение. Выдавайте осторожно.', 'server'],
    ],
  },
];

const has = (mask, bit) => (mask & bit) === bit;

export function sortedRoles(server) {
  return [...(server?.roles || [])].sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
}

export const everyoneRole = (server) => (server?.roles || []).find((r) => r.id === server.id) || null;

export function memberRoleIds(server, userId) {
  return (server?.memberRoles?.[userId] || []).filter((id) => id !== server.id);
}

/** Роли участника (без @everyone), сверху вниз */
export function memberRoles(server, userId) {
  const ids = new Set(memberRoleIds(server, userId));
  return sortedRoles(server).filter((r) => ids.has(r.id));
}

export function isServerOwner(server, userId = state.user?.id) {
  return !!server && !!userId && server.ownerId === userId;
}

/** Администратор экземпляра (js/ui/admin.js): на сервере у него все права, как у владельца */
const isInstanceAdmin = (userId) => !!state.instanceAdmin && !!userId && userId === state.user?.id;

/** Права на сервере (без учёта каналов) */
export function basePermissions(server, userId = state.user?.id) {
  if (!server || !userId) return 0;
  if (isServerOwner(server, userId) || isInstanceAdmin(userId)) return ALL_PERMS;
  // старый сервер без ролей (до миграции) — права по умолчанию
  if (!Array.isArray(server.roles) || !server.roles.length) return DEFAULT_EVERYONE;
  let p = everyoneRole(server)?.permissions ?? DEFAULT_EVERYONE;
  for (const r of memberRoles(server, userId)) p |= r.permissions || 0;
  if (has(p, PERMS.ADMINISTRATOR)) return ALL_PERMS;
  return p;
}

/** Права в канале (Discord-алгоритм overwrites) */
export function channelPermissions(server, channelId, userId = state.user?.id) {
  const base = basePermissions(server, userId);
  if (!channelId || has(base, PERMS.ADMINISTRATOR)) return base;
  const ows = server?.channelOverwrites?.[channelId];
  if (!ows) return base;
  let p = base;
  const ev = ows[server.id];
  if (ev) { p &= ~(ev.deny || 0); p |= (ev.allow || 0); }
  let allow = 0; let deny = 0;
  for (const rid of memberRoleIds(server, userId)) {
    const ow = ows[rid];
    if (ow) { allow |= ow.allow || 0; deny |= ow.deny || 0; }
  }
  p &= ~deny;
  p |= allow;
  return p;
}

/** can(server, 'MANAGE_ROLES') / can(server, 'SEND_MESSAGES', channelId) */
export function can(server, perm, channelId = null, userId = state.user?.id) {
  const bit = typeof perm === 'number' ? perm : PERMS[perm];
  if (!bit) return false;
  return has(channelId ? channelPermissions(server, channelId, userId) : basePermissions(server, userId), bit);
}

/** Позиция высшей роли (владелец — Infinity, @everyone — 0) */
export function highestPosition(server, userId) {
  if (isServerOwner(server, userId) || isInstanceAdmin(userId)) return Infinity;
  const roles = memberRoles(server, userId);
  return roles.length ? (roles[0].position ?? 0) : 0;
}

/** Может ли actor действовать (кик/бан/mute/роли) на target по иерархии */
export function outranks(server, targetId, actorId = state.user?.id) {
  if (!server || !actorId || !targetId || actorId === targetId) return false;
  if (isServerOwner(server, targetId)) return false;
  if (isServerOwner(server, actorId) || isInstanceAdmin(actorId)) return true;
  return highestPosition(server, actorId) > highestPosition(server, targetId);
}

/** Может ли текущий пользователь редактировать/выдавать роль */
export function canManageRole(server, role, actorId = state.user?.id) {
  if (!role || !can(server, 'MANAGE_ROLES', null, actorId)) return false;
  if (isServerOwner(server, actorId) || isInstanceAdmin(actorId)) return true;
  return (role.position ?? 0) < highestPosition(server, actorId);
}

/** Цвет ника: цвет высшей роли с цветом (иначе null) */
export function roleColor(server, userId) {
  for (const r of memberRoles(server, userId)) if (r.color) return r.color;
  return null;
}

/** Высшая hoist-роль участника */
export function hoistRole(server, userId) {
  return memberRoles(server, userId).find((r) => r.hoist) || null;
}

/** Приватный ли канал: @everyone без VIEW_CHANNEL */
export function isPrivateChannel(server, channelId) {
  const ev = server?.channelOverwrites?.[channelId]?.[server.id];
  return !!ev && has(ev.deny || 0, PERMS.VIEW_CHANNEL);
}
