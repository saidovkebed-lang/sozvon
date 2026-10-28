// Действия администратора экземпляра, которым нужен Socket.IO (рассылки, голос, комнаты).
// Создаётся в server/realtime.js — туда передаются внутренние функции рассылки; сами проверки прав
// (instanceAdmin + 2FA) делает server/admin/routes.js.
import { db, save } from '../db.js';
import { findUser, serverChannels, findChannel } from '../model.js';
import { findRole, normalizePositions, cleanPerms } from '../permissions.js';
import { dropNotifications } from '../inbox.js';
import { removeMediaUrl } from '../media.js';
import { noteMemberJoined } from '../stats.js';
import { mustChangePassword } from './access.js';

const serverRoom = (id) => `server:${id}`;
const userRoom = (id) => `user:${id}`;

export class OpError extends Error {}
const fail = (m) => { throw new OpError(m); };

export function createAdminOps({
  io, voice, removeMember, permsChanged, emitServerUpdated, emitToViewers, forgetNotifications, mediaInUse,
}) {
  // Заблокированный аккаунт и аккаунт с временным паролем не подключаются (сессии заблокированного удаляются сразу)
  io.use((socket, next) => {
    const u = socket.data.user;
    if (!u || socket.data.isBot) return next();
    if (u.instanceBan) return next(new Error('unauthorized'));
    if (mustChangePassword(u)) return next(new Error('password_change_required'));
    // «был в сети» для списка пользователей админ-панели
    u.lastSeenAt = Date.now();
    socket.once('disconnect', () => { const cur = findUser(u.id); if (cur) { cur.lastSeenAt = Date.now(); save(); } });
    next();
  });

  function deleteServer(server) {
    for (const c of serverChannels(server.id)) {
      if (c.type === 'voice') voice.clearChannel(c.id);
      delete db.data.messages[c.id];
    }
    db.data.channels = db.data.channels.filter((c) => c.serverId !== server.id);
    db.data.servers = db.data.servers.filter((s) => s.id !== server.id);
    dropNotifications((n) => n.serverId === server.id);
    save();
    for (const url of [server.icon, server.banner]) if (url) removeMediaUrl(url, mediaInUse);
    io.to(serverRoom(server.id)).emit('server:removed', { serverId: server.id });
    io.in(serverRoom(server.id)).socketsLeave(serverRoom(server.id));
  }

  function deleteChannel(server, channel) {
    if (channel.type === 'text' && serverChannels(server.id).filter((c) => c.type === 'text').length <= 1) {
      fail('Нельзя удалить последний текстовый канал');
    }
    if (channel.type === 'voice') voice.clearChannel(channel.id);
    delete db.data.messages[channel.id];
    delete server.channelOverwrites?.[channel.id];
    dropNotifications((n) => n.channelId === channel.id);
    db.data.channels = db.data.channels.filter((c) => c.id !== channel.id);
    save();
    emitServerUpdated(server);
  }

  function deleteMessage(channelId, messageId) {
    const list = db.data.messages[channelId] || [];
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) fail('Сообщение не найдено');
    const [msg] = list.splice(idx, 1);
    save();
    emitToViewers(channelId, 'message:deleted', { channelId, messageId });
    forgetNotifications(messageId);
    return msg;
  }

  function targetMember(server, userId) {
    const t = typeof userId === 'string' ? findUser(userId) : null;
    if (!t || !server.memberIds.includes(t.id)) fail('Участник не найден');
    if (t.isBot) fail('С ботом так нельзя');
    return t;
  }

  function kick(server, userId) {
    const t = targetMember(server, userId);
    if (t.id === server.ownerId) fail('Владельца нельзя выгнать — сначала передайте владение');
    removeMember(server, t.id, 'kick');
    return t;
  }

  function ban(server, userId, reason, byId) {
    const t = typeof userId === 'string' ? findUser(userId) : null;
    if (!t) fail('Пользователь не найден');
    if (t.isBot) fail('С ботом так нельзя');
    if (t.id === server.ownerId) fail('Владельца нельзя заблокировать — сначала передайте владение');
    server.bans ||= {};
    server.bans[t.id] = { by: byId, reason: String(reason || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300), at: Date.now() };
    if (server.memberIds.includes(t.id)) removeMember(server, t.id, 'ban');
    else { save(); emitServerUpdated(server); }
    return t;
  }

  function unban(server, userId) {
    if (typeof userId !== 'string' || !server.bans?.[userId]) fail('Этот пользователь не заблокирован');
    delete server.bans[userId];
    save();
    emitServerUpdated(server);
  }

  function transfer(server, userId) {
    const t = targetMember(server, userId);
    if (t.id === server.ownerId) fail('Он уже владелец');
    server.ownerId = t.id;
    permsChanged(server);
    return t;
  }

  function rename(server, name) {
    server.name = name;
    save();
    emitServerUpdated(server);
  }

  function join(server, user) {
    if (!server.memberIds.includes(user.id)) {
      server.memberIds.push(user.id);
      if (server.bans?.[user.id]) delete server.bans[user.id];
      save();
      noteMemberJoined(server.id);
    }
    io.in(userRoom(user.id)).socketsJoin(serverRoom(server.id));
    emitServerUpdated(server);
  }

  function setMemberRoles(server, userId, roleIds) {
    const t = targetMember(server, userId);
    if (!Array.isArray(roleIds) || roleIds.some((id) => typeof id !== 'string')) fail('roleIds: список id ролей');
    const wanted = new Set(roleIds.filter((id) => id !== server.id));
    for (const id of wanted) if (!findRole(server, id)) fail('Роль не найдена');
    const list = server.roles.filter((r) => wanted.has(r.id)).map((r) => r.id);
    if (list.length) server.memberRoles[t.id] = list; else delete server.memberRoles[t.id];
    permsChanged(server);
    return t;
  }

  function updateRole(server, roleId, { name, color, permissions }) {
    const role = findRole(server, roleId);
    if (!role) fail('Роль не найдена');
    const isEveryone = role.id === server.id;
    if (name !== undefined) {
      if (isEveryone) fail('@everyone нельзя переименовать');
      const n = String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
      if (!n || n.length > 32) fail('Название роли: от 1 до 32 символов');
      role.name = n;
    }
    if (color !== undefined && !isEveryone) {
      if (color !== null && !/^#[0-9a-f]{6}$/i.test(String(color))) fail('Цвет роли — в формате #rrggbb');
      role.color = color === null ? null : String(color).toLowerCase();
    }
    if (permissions !== undefined) role.permissions = cleanPerms(permissions);
    permsChanged(server);
    return role;
  }

  function deleteRole(server, roleId) {
    const role = findRole(server, roleId);
    if (!role) fail('Роль не найдена');
    if (role.id === server.id) fail('@everyone удалить нельзя');
    server.roles = server.roles.filter((r) => r.id !== role.id);
    for (const [uid, ids] of Object.entries(server.memberRoles)) {
      const rest = ids.filter((id) => id !== role.id);
      if (rest.length) server.memberRoles[uid] = rest; else delete server.memberRoles[uid];
    }
    for (const [cid, ows] of Object.entries(server.channelOverwrites)) {
      delete ows[role.id];
      if (!Object.keys(ows).length) delete server.channelOverwrites[cid];
    }
    normalizePositions(server);
    permsChanged(server);
    return role;
  }

  /** Отключить все сокеты пользователя (бан аккаунта / принудительный выход / сброс пароля). */
  function disconnectUser(userId) {
    for (const s of io.sockets.sockets.values()) {
      if (!s.data.isBot && s.data.user?.id === userId) {
        s.emit('session:revoked', {});
        s.disconnect(true);
      }
    }
  }

  function liveStats() {
    const humans = voice.allHumans();
    return {
      voice: new Set(humans.map((h) => h.member.userId)).size,
      streams: humans.filter((h) => h.member.streaming || h.member.camera).length,
    };
  }

  return {
    deleteServer, deleteChannel, deleteMessage, kick, ban, unban, transfer, rename, join,
    setMemberRoles, updateRole, deleteRole, disconnectUser, liveStats, findChannel,
  };
}
