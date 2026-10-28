// Socket.IO: события клиентов и бота. Права — server/permissions.js (SPEC-v3 §1).
import fs from 'node:fs';
import path from 'node:path';
import { db, save, newId } from './db.js';
import { userByToken, checkBotToken } from './auth.js';
import {
  findServer, findChannel, findUser, serverChannels, userServers, isMember, getBotUser,
  publicServer, publicChannel, publicMessage, publicUser, addMessage, generateInviteCode,
  addOnlineSocket, removeOnlineSocket, isVisiblyOnline, canViewChannel, activeCustomStatus,
} from './model.js';
import {
  PERMS, has, computeBase, computeChannel, canActOn, canGrant, cleanPerms, findRole,
  highestPosition, normalizePositions, newServerFields,
} from './permissions.js';
import { createVoice } from './voice.js';
import { createWatch } from './watch.js';
import { isOwnMediaUrl, removeMediaUrl } from './media.js';
import {
  findDm, isDmMember, dmOther, getOrCreateDm, userDms, publicDm, listDms, sharesServer, setRead,
  addNotification, listNotifications, markNotificationsRead, dropNotifications, notificationText,
  livePushSubs, removePushSub, forgetMessage, dropPushSubsForSessions,
} from './inbox.js';
import { sendPush, pushPublicKey } from './push.js';
import { observeStats, noteMemberJoined, startStats } from './stats.js';
import { cleanServerTheme, markStreamed } from './cosmetics.js';
import { createAdminOps } from './admin/ops.js';

const serverRoom = (id) => `server:${id}`;
const userRoom = (id) => `user:${id}`;

export const BOT_COMMANDS = ['play', 'skip', 'stop', 'pause', 'resume', 'queue', 'np', 'remove', 'move', 'seek', 'shuffle', 'help', 'leave', 'playlist', 'pl', 'autoplay'];
const BOT_OFFLINE_TEXT = 'Музыкальный бот не запущен. Запустите: npm run bot';
const NO_MUSIC_PERM = 'Нет права управлять музыкой';
const NO_PERM = 'Недостаточно прав';
const HIERARCHY = 'Нельзя действовать на участника с ролью не ниже вашей';
const MAX_ROLES = 50;
const MOVE_GRANT_MS = 30_000;

class WsError extends Error {}
const fail = (msg) => { throw new WsError(msg); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

function cleanName(raw, { min = 1, max = 50, what = 'Название' } = {}) {
  if (typeof raw !== 'string') fail(`${what}: введите текст`);
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < min) fail(`${what} не может быть пустым`);
  if (name.length > max) fail(`${what} слишком длинное (максимум ${max} символов)`);
  return name;
}

function cleanColor(v) {
  if (v === null || v === '') return null;
  const c = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^#[0-9a-f]{6}$/.test(c)) fail('Цвет роли — в формате #rrggbb');
  return c;
}

/** Медиа сервера используется ещё где-то? (чтобы не удалить общий файл) */
function mediaInUse(url) {
  return db.data.servers.some((s) => s.icon === url || s.banner === url)
    || db.data.users.some((u) => u.avatar === url || u.avatarAnimated === url || u.banner === url || u.bannerAnimated === url);
}

export function attachRealtime(io, { uploadsDir, dataDir = path.dirname(uploadsDir), sfu = null }) {
  let botSocket = null;
  const isBotOnline = () => !!botSocket?.connected;
  const moveGrants = new Map(); // userId -> {channelId, until}: можно зайти без CONNECT (перемещён модератором)

  // ---------- рассылки с учётом прав ----------
  /** Событие участникам сервера, которые видят канал. except — socketId отправителя. */
  function emitToViewers(channelId, event, payload, serverIdHint, { except } = {}) {
    observeStats(channelId, event, payload, serverIdHint); // «Astra Итоги» (server/stats.js): только счётчики
    const channel = findChannel(channelId);
    const server = findServer(channel?.serverId || serverIdHint);
    if (!server) return;
    if (!channel) { // канал удалён — без фильтра
      (except ? io.to(serverRoom(server.id)).except(except) : io.to(serverRoom(server.id))).emit(event, payload);
      return;
    }
    const humans = server.memberIds.filter((id) => !findUser(id)?.isBot);
    const viewers = humans.filter((id) => canViewChannel(server, channel.id, id));
    let target = viewers.length === humans.length ? io.to(serverRoom(server.id)) : (viewers.length ? io.to(viewers.map(userRoom)) : null);
    if (!target) return;
    if (except) target = target.except(except);
    target.emit(event, payload);
  }

  // onLeave: участник ушёл из голосового канала — закрыть его трансляцию/просмотр в SFU
  const voice = createVoice(io, { getBotSocket: () => botSocket, emitToViewers, onLeave: (sid) => sfu?.removePeer(sid) });
  const watch = createWatch(io, { voice, emitToViewers, dataDir }); // «Смотреть вместе» (server/watch.js)

  function emitPresence(userId) {
    const rooms = userServers(userId).map((s) => serverRoom(s.id));
    if (!rooms.length) return;
    const u = findUser(userId);
    const online = isVisiblyOnline(userId);
    io.to(rooms).except(userRoom(userId)).emit('presence', { userId, online, status: online ? (u?.status || 'online') : 'offline' });
    io.to(userRoom(userId)).emit('presence', { userId, online: true, status: u?.status || 'online' });
  }

  /** server:updated каждому участнику — персонально (каналы/инвайт/баны по его правам). */
  function emitServerUpdated(server) {
    for (const id of server.memberIds) {
      if (findUser(id)?.isBot) continue;
      io.to(userRoom(id)).emit('server:updated', { server: publicServer(server, id) });
    }
  }

  // ---------- проверки ----------
  function requireServerMember(serverId, user) {
    const server = typeof serverId === 'string' ? findServer(serverId) : null;
    if (!server || !isMember(server, user.id)) fail('Сервер не найден');
    return server;
  }
  function requirePerm(serverId, user, bit, msg = NO_PERM) {
    const server = requireServerMember(serverId, user);
    if (!has(computeBase(server, user.id), bit)) fail(msg);
    return server;
  }
  function requireOwnerOnly(serverId, user) {
    const server = requireServerMember(serverId, user);
    if (server.ownerId !== user.id) fail('Это может сделать только владелец сервера');
    return server;
  }
  /** Канал, видимый пользователю; perms — права в канале. */
  function requireChannel(channelId, user, type) {
    const channel = typeof channelId === 'string' ? findChannel(channelId) : null;
    const server = channel && findServer(channel.serverId);
    if (!channel || !isMember(server, user.id)) fail('Канал не найден');
    const perms = computeChannel(server, channel.id, user.id);
    if (!has(perms, PERMS.VIEW_CHANNEL)) fail('Нет доступа к этому каналу');
    if (type && channel.type !== type) fail(type === 'text' ? 'Это не текстовый канал' : 'Это не голосовой канал');
    return { channel, server, perms };
  }
  function requireTargetMember(server, userId) {
    const target = typeof userId === 'string' ? findUser(userId) : null;
    if (!target || !server.memberIds.includes(target.id)) fail('Участник не найден');
    if (target.isBot) fail('С ботом так нельзя');
    return target;
  }

  function sendSystem(channel, content) {
    const bot = getBotUser();
    const msg = addMessage({ channelId: channel.id, authorId: bot.id, content, system: true });
    emitToViewers(channel.id, 'message:new', { message: publicMessage(msg) });
  }

  // «Astra Итоги»: объявление «📊 Итоги … готовы — открыть» (системное сообщение с кнопкой)
  startStats({
    post(server, channel, content, recap) {
      const msg = addMessage({ channelId: channel.id, authorId: getBotUser().id, content, system: true });
      msg.recap = recap;
      save();
      emitToViewers(channel.id, 'message:new', { message: publicMessage(msg) });
    },
  });

  // ---------- уведомления: «Входящие» и push ----------
  const userSocketsOf = (userId) => [...(io.sockets.adapter.rooms.get(userRoom(userId)) || [])]
    .map((id) => io.sockets.sockets.get(id)).filter(Boolean);
  /** Пользователь сейчас смотрит этот канал/ЛС (вкладка видима) */
  const isViewing = (userId, channelId) => userSocketsOf(userId).some((s) => s.data.view?.visible && s.data.view.channelId === channelId);
  /** Хоть одна вкладка/окно на виду — push не нужен, хватит уведомления внутри приложения */
  const hasVisibleClient = (userId) => userSocketsOf(userId).some((s) => s.data.view?.visible);
  const nameOf = (u) => (u?.displayName || u?.username || 'Кто-то');

  /** Новое уведомление во «Входящие» + push на устройства, где Astra сейчас не открыт */
  function notifyUser(userId, { type, channelId, serverId = null, message }) {
    const target = findUser(userId);
    if (!target || target.isBot) return;
    const n = addNotification(userId, { type, channelId, serverId, message });
    io.to(userRoom(userId)).emit('notification:new', { notification: n });
    if (target.status === 'dnd' || hasVisibleClient(userId)) return;
    const subs = livePushSubs(userId);
    if (!subs.length) return;
    const author = findUser(message.authorId);
    const { title, body, source } = notificationText(n, nameOf(author));
    const srvIcon = type === 'dm' ? null : findServer(serverId)?.icon;
    const payload = {
      title, body, tag: `sozvon-${channelId}`, channelId,
      url: `/?c=${encodeURIComponent(channelId)}`, count: n.count, type,
      source: { kind: type === 'dm' ? 'dm' : 'server', label: source, serverName: n.serverName, channelName: n.channelName, author: nameOf(author) },
      // иконка сервера (только свой файл), у ЛС — аватар автора
      icon: [type === 'dm' ? author?.avatar : srvIcon].find((u) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//')) || undefined,
    };
    for (const sub of subs) {
      sendPush(sub, payload).then((r) => { if (r.gone) removePushSub(userId, sub.endpoint); }).catch((e) => console.warn('[push]', e?.message || e));
    }
  }

  /** Упоминания в канале сервера: @ник, @everyone/@here (если у автора есть право) */
  function notifyMentions(server, channel, msg) {
    const text = msg.content || '';
    for (const id of server.memberIds) {
      if (id === msg.authorId) continue;
      const u = findUser(id);
      if (!u || u.isBot || !canViewChannel(server, channel.id, id) || isViewing(id, channel.id)) continue;
      let type = null;
      if (msg.mentionEveryone) type = 'everyone';
      else {
        const esc = u.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|[^\\p{L}\\p{N}_@])@${esc}(?![\\p{L}\\p{N}_])`, 'iu').test(text)) type = 'mention';
      }
      if (type) notifyUser(id, { type, channelId: channel.id, serverId: server.id, message: msg });
    }
  }

  /** Уведомление всё ещё про доступный канал/ЛС */
  function canSeeNotification(n, userId) {
    if (n.type === 'dm') return isDmMember(findDm(n.channelId), userId);
    const server = findServer(n.serverId);
    return !!server && isMember(server, userId) && !!findChannel(n.channelId) && canViewChannel(server, n.channelId, userId);
  }

  /** ЛС, доступный пользователю */
  function requireDm(dmId, user) {
    const dm = findDm(dmId);
    if (!dm || !isDmMember(dm, user.id)) fail('Чат не найден');
    return dm;
  }

  /** Сообщение удалено — «Входящие» у всех, кого касалось */
  function forgetNotifications(messageId) {
    const { removed, updated } = forgetMessage(messageId);
    for (const r of removed) io.to(userRoom(r.userId)).emit('notification:removed', { id: r.id, messageId });
    for (const u of updated) io.to(userRoom(u.userId)).emit('notification:new', { notification: u.notification });
  }

  function validateAttachments(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) fail('Некорректные вложения');
    if (list.length > 10) fail('Не больше 10 вложений в сообщении');
    return list.map((a) => {
      if (!isObj(a)) fail('Некорректное вложение');
      const url = str(a.url);
      const m = url.match(/^\/media\/uploads\/([a-f0-9]{24}(?:\.[a-z0-9]{1,10})?)$/);
      if (!m || !fs.existsSync(path.join(uploadsDir, m[1]))) fail('Вложение не найдено — загрузите файл заново');
      return {
        url,
        name: str(a.name).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || m[1],
        type: str(a.type).slice(0, 100) || 'application/octet-stream',
        size: Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0,
      };
    });
  }

  function forwardCommand({ command, args, user, serverId, textChannelId }) {
    const vc = voice.userVoiceChannel(user.id);
    const voiceChannelId = vc && findChannel(vc)?.serverId === serverId ? vc : null;
    botSocket.emit('bot:command', {
      command, args, userId: user.id, username: user.username, serverId, textChannelId, voiceChannelId,
    });
  }

  // ---------- голос и права ----------
  const modOf = (server, userId) => server.voiceModeration?.[userId] || { mute: false, deafen: false };

  /** serverMute/serverDeafen для участника канала: модерация + принудительный mute без SPEAK. */
  function voiceFlags(server, channelId, userId) {
    const mod = modOf(server, userId);
    const speak = has(computeChannel(server, channelId, userId), PERMS.SPEAK);
    return { serverMute: !!mod.mute || !speak, serverDeafen: !!mod.deafen };
  }

  function disconnectFromVoice(socketId, channelId = null) {
    voice.removeSocket(socketId);
    io.to(socketId).emit('voice:moved', { channelId });
  }

  /** После изменения прав/ролей: выкинуть из невидимых голосовых каналов, обновить серверный mute. */
  function enforceVoice(server) {
    for (const { socketId, channelId, member } of voice.allHumans()) {
      const ch = findChannel(channelId);
      if (!ch || ch.serverId !== server.id) continue;
      if (!server.memberIds.includes(member.userId) || !canViewChannel(server, channelId, member.userId)) {
        disconnectFromVoice(socketId, null);
        continue;
      }
      voice.setModeration(socketId, voiceFlags(server, channelId, member.userId));
    }
  }

  /** Убрать участника с сервера (кик/бан). */
  function removeMember(server, userId, reason) {
    voice.kickUserFromServer(userId, server.id);
    server.memberIds = server.memberIds.filter((id) => id !== userId);
    delete server.memberRoles[userId];
    if (server.voiceModeration) delete server.voiceModeration[userId];
    save();
    io.to(userRoom(userId)).emit('server:removed', reason ? { serverId: server.id, reason } : { serverId: server.id });
    io.in(userRoom(userId)).socketsLeave(serverRoom(server.id));
    emitServerUpdated(server);
  }

  /** Сервер изменился в части прав: всем — новая картина, голос — пересчитать. */
  function permsChanged(server) {
    save();
    emitServerUpdated(server);
    enforceVoice(server);
  }

  // ---------- авторизация ----------
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    if (auth.botToken !== undefined) {
      if (checkBotToken(auth.botToken) && getBotUser()) { socket.data.isBot = true; socket.data.user = getBotUser(); return next(); }
      return next(new Error('unauthorized'));
    }
    const user = userByToken(auth.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    socket.data.token = auth.token;
    next();
  });

  io.on('connection', (socket) => {
    if (socket.data.isBot) return onBot(socket);
    const user = socket.data.user;
    const limiter = { count: 0, reset: Date.now() + 10_000 };

    socket.join(userRoom(user.id));
    for (const s of userServers(user.id)) socket.join(serverRoom(s.id));
    socket.data.view = { channelId: null, visible: false };
    if (addOnlineSocket(user.id, socket.id) && user.status !== 'invisible') emitPresence(user.id);
    watch.attach(socket, user);

    // обёртка: ack обязателен, ошибки → {ok:false,error}
    const on = (event, handler) => socket.on(event, async (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = {}; }
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!findUser(user.id) || !db.data.sessions[socket.data.token]) fail('Сессия недействительна');
        const res = await handler(isObj(payload) ? payload : {});
        reply({ ok: true, ...(res || {}) });
      } catch (err) {
        if (!(err instanceof WsError)) console.error(`[ws] ${event}:`, err);
        reply({ ok: false, error: err instanceof WsError ? err.message : 'Внутренняя ошибка сервера' });
      }
    });

    // Пинг (SPEC-v3 §3): emit('ping:rtt', {t}?, ack) → {now, t?}
    socket.on('ping:rtt', (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = undefined; }
      if (typeof ack !== 'function') return;
      const out = { now: Date.now() };
      if (isObj(payload) && Number.isFinite(payload.t)) out.t = payload.t;
      ack(out);
    });

    on('bootstrap', () => {
      const servers = userServers(user.id);
      const voiceIds = servers.flatMap((s) => serverChannels(s.id)
        .filter((c) => c.type === 'voice' && canViewChannel(s, c.id, user.id)).map((c) => c.id));
      const { voice: v, music } = voice.snapshotFor(voiceIds);
      return {
        user: publicUser(user, { self: true }), servers: servers.map((s) => publicServer(s, user.id)), voice: v, music,
        dms: listDms(user.id),
        notifications: listNotifications(user.id).filter((n) => canSeeNotification(n, user.id)),
        pushKey: pushPublicKey(),
      };
    });

    // ---------- серверы ----------
    on('server:create', ({ name }) => {
      const clean = cleanName(name, { max: 50, what: 'Название сервера' });
      if (userServers(user.id).filter((s) => s.ownerId === user.id).length >= 50) fail('Слишком много серверов');
      const bot = getBotUser();
      const id = newId();
      const server = {
        id, name: clean, ownerId: user.id, inviteCode: generateInviteCode(), icon: null,
        memberIds: [user.id, bot.id], createdAt: Date.now(), ...newServerFields(id),
      };
      db.data.servers.push(server);
      db.data.channels.push(
        { id: newId(), serverId: server.id, name: 'общий', type: 'text', position: 0 },
        { id: newId(), serverId: server.id, name: 'Голосовой', type: 'voice', position: 1 },
      );
      save();
      io.in(userRoom(user.id)).socketsJoin(serverRoom(server.id));
      emitServerUpdated(server);
      return { server: publicServer(server, user.id) };
    });

    on('server:join', ({ inviteCode }) => {
      const code = str(inviteCode).trim().toLowerCase().replace(/^.*\//, '');
      if (!/^[a-z0-9]{8}$/.test(code)) fail('Инвайт-код — 8 латинских букв и цифр');
      const server = db.data.servers.find((s) => s.inviteCode === code);
      if (!server) fail('Сервер с таким кодом не найден');
      if (server.bans?.[user.id]) fail('Вы заблокированы на этом сервере');
      if (!server.memberIds.includes(user.id)) {
        server.memberIds.push(user.id);
        save();
        noteMemberJoined(server.id);
      }
      io.in(userRoom(user.id)).socketsJoin(serverRoom(server.id));
      emitServerUpdated(server);
      return { server: publicServer(server, user.id) };
    });

    on('server:leave', ({ serverId }) => {
      const server = requireServerMember(serverId, user);
      if (server.ownerId === user.id) fail('Владелец не может выйти с сервера — его можно только удалить');
      removeMember(server, user.id, null);
    });

    on('server:delete', ({ serverId }) => {
      const server = requireOwnerOnly(serverId, user);
      const channels = serverChannels(server.id);
      for (const c of channels) {
        if (c.type === 'voice') voice.clearChannel(c.id);
        delete db.data.messages[c.id];
      }
      db.data.channels = db.data.channels.filter((c) => c.serverId !== server.id);
      db.data.servers = db.data.servers.filter((s) => s.id !== server.id);
      dropNotifications((n) => n.serverId === server.id);
      save();
      for (const url of [server.icon, server.banner]) removeMediaUrl(url, mediaInUse);
      io.to(serverRoom(server.id)).emit('server:removed', { serverId: server.id });
      io.in(serverRoom(server.id)).socketsLeave(serverRoom(server.id));
    });

    on('server:rename', ({ serverId, name }) => {
      const server = requirePerm(serverId, user, PERMS.MANAGE_SERVER);
      server.name = cleanName(name, { max: 50, what: 'Название сервера' });
      save();
      emitServerUpdated(server);
    });

    on('server:update', (p) => {
      const server = requirePerm(p.serverId, user, PERMS.MANAGE_SERVER);
      const patch = {};
      if ('name' in p) patch.name = cleanName(p.name, { max: 50, what: 'Название сервера' });
      if ('description' in p) {
        if (p.description !== null && typeof p.description !== 'string') fail('Описание: нужен текст');
        const d = str(p.description).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
        if ([...d].length > 300) fail('Описание: не больше 300 символов');
        patch.description = d;
      }
      for (const [key, dir] of [['icon', 'icons'], ['banner', 'banners']]) {
        if (!(key in p)) continue;
        if (p[key] === null) patch[key] = null;
        else if (!isOwnMediaUrl(p[key], [dir])) fail(key === 'icon' ? 'Иконка не найдена — загрузите её заново' : 'Баннер не найден — загрузите его заново');
        else patch[key] = p[key];
      }
      if (p.regenerateInvite === true) patch.inviteCode = generateInviteCode();
      // Astra 2.0: тема сервера — акцент #rrggbb и космический фон из пресетов (null — по умолчанию)
      if ('theme' in p) {
        try { patch.theme = cleanServerTheme(p.theme); } catch (e) { fail(e.message); }
      }
      if (!Object.keys(patch).length) fail('Нет изменений');
      const old = { icon: server.icon, banner: server.banner };
      Object.assign(server, patch);
      save();
      for (const k of ['icon', 'banner']) if (k in patch && old[k] && old[k] !== server[k]) removeMediaUrl(old[k], mediaInUse);
      emitServerUpdated(server);
      return { server: publicServer(server, user.id) };
    });

    on('server:transfer', ({ serverId, userId }) => {
      const server = requireOwnerOnly(serverId, user);
      const target = requireTargetMember(server, userId);
      if (target.id === user.id) fail('Вы уже владелец');
      server.ownerId = target.id;
      permsChanged(server);
      return { server: publicServer(server, user.id) };
    });

    // ---------- каналы ----------
    on('channel:create', ({ serverId, name, type }) => {
      const server = requirePerm(serverId, user, PERMS.MANAGE_CHANNELS);
      if (type !== 'text' && type !== 'voice') fail('Тип канала: text или voice');
      const channels = serverChannels(server.id);
      if (channels.length >= 50) fail('Слишком много каналов на сервере (максимум 50)');
      const clean = cleanName(name, { max: 32, what: 'Название канала' });
      const channel = {
        id: newId(), serverId: server.id, name: clean, type,
        position: channels.reduce((m, c) => Math.max(m, c.position), -1) + 1,
      };
      db.data.channels.push(channel);
      save();
      emitServerUpdated(server);
      return { channel: publicChannel(channel) };
    });

    on('channel:delete', ({ channelId }) => {
      const channel = typeof channelId === 'string' ? findChannel(channelId) : null;
      if (!channel) fail('Канал не найден');
      const server = requirePerm(channel.serverId, user, PERMS.MANAGE_CHANNELS);
      if (channel.type === 'text' && serverChannels(server.id).filter((c) => c.type === 'text').length <= 1) {
        fail('Нельзя удалить последний текстовый канал');
      }
      if (channel.type === 'voice') voice.clearChannel(channel.id);
      delete db.data.messages[channel.id];
      delete server.channelOverwrites[channel.id];
      dropNotifications((n) => n.channelId === channel.id);
      db.data.channels = db.data.channels.filter((c) => c.id !== channel.id);
      save();
      emitServerUpdated(server);
    });

    on('channel:update', ({ channelId, name, overwrites }) => {
      const channel = typeof channelId === 'string' ? findChannel(channelId) : null;
      if (!channel) fail('Канал не найден');
      const server = requirePerm(channel.serverId, user, PERMS.MANAGE_CHANNELS);
      let clean = null, ows = null;
      if (name !== undefined) clean = cleanName(name, { max: 32, what: 'Название канала' });
      if (overwrites !== undefined) {
        if (!isObj(overwrites)) fail('Права канала: нужен объект {roleId: {allow, deny}}');
        ows = {};
        let granted = 0;
        for (const [roleId, ow] of Object.entries(overwrites)) {
          if (!findRole(server, roleId)) fail('Роль не найдена');
          if (!isObj(ow)) fail('Права канала: нужен объект {allow, deny}');
          const allow = cleanPerms(ow.allow), deny = cleanPerms(ow.deny) & ~cleanPerms(ow.allow);
          granted |= allow;
          if (allow || deny) ows[roleId] = { allow, deny };
        }
        if (!canGrant(server, user.id, granted)) fail('Нельзя разрешить права, которых нет у вас');
      }
      if (clean === null && ows === null) fail('Нет изменений');
      if (clean !== null) channel.name = clean;
      if (ows !== null) {
        if (Object.keys(ows).length) server.channelOverwrites[channel.id] = ows;
        else delete server.channelOverwrites[channel.id];
      }
      permsChanged(server);
      return { channel: publicChannel(channel) };
    });

    // ---------- роли ----------
    function requireRoleManager(serverId) {
      const server = requirePerm(serverId, user, PERMS.MANAGE_ROLES);
      return { server, myPos: highestPosition(server, user.id) };
    }

    on('role:create', ({ serverId, name, color, permissions }) => {
      const { server } = requireRoleManager(serverId);
      if (server.roles.length >= MAX_ROLES + 1) fail(`Не больше ${MAX_ROLES} ролей на сервере`);
      const perms = permissions === undefined ? 0 : cleanPerms(permissions);
      if (!canGrant(server, user.id, perms)) fail('Нельзя выдать роли права, которых нет у вас');
      const role = {
        id: newId(), name: name === undefined ? 'новая роль' : cleanName(name, { max: 32, what: 'Название роли' }),
        color: color === undefined ? null : cleanColor(color), permissions: perms,
        position: 0.5, hoist: false, mentionable: false,
      };
      server.roles.push(role); // новая роль — сразу над @everyone
      normalizePositions(server);
      permsChanged(server);
      return { role: { ...role }, server: publicServer(server, user.id) };
    });

    on('role:update', (p) => {
      const { server, myPos } = requireRoleManager(p.serverId);
      const role = findRole(server, p.roleId);
      if (!role) fail('Роль не найдена');
      const isEveryone = role.id === server.id;
      if (!isEveryone && role.position >= myPos) fail('Можно менять только роли ниже вашей высшей роли');
      const patch = {};
      if (p.name !== undefined) {
        if (isEveryone) fail('@everyone нельзя переименовать');
        patch.name = cleanName(p.name, { max: 32, what: 'Название роли' });
      }
      if (p.color !== undefined) { if (isEveryone) fail('У @everyone нет цвета'); patch.color = cleanColor(p.color); }
      if (p.hoist !== undefined) { if (typeof p.hoist !== 'boolean') fail('hoist: true/false'); if (!isEveryone) patch.hoist = p.hoist; }
      if (p.mentionable !== undefined) { if (typeof p.mentionable !== 'boolean') fail('mentionable: true/false'); if (!isEveryone) patch.mentionable = p.mentionable; }
      if (p.permissions !== undefined) {
        const perms = cleanPerms(p.permissions);
        const added = perms & ~role.permissions;
        if (!canGrant(server, user.id, added)) fail('Нельзя выдать роли права, которых нет у вас');
        patch.permissions = perms;
      }
      if (!Object.keys(patch).length) fail('Нет изменений');
      Object.assign(role, patch);
      permsChanged(server);
      return { role: { ...role }, server: publicServer(server, user.id) };
    });

    on('role:delete', ({ serverId, roleId }) => {
      const { server, myPos } = requireRoleManager(serverId);
      const role = findRole(server, roleId);
      if (!role) fail('Роль не найдена');
      if (role.id === server.id) fail('@everyone удалить нельзя');
      if (role.position >= myPos) fail('Можно удалять только роли ниже вашей высшей роли');
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
      return { server: publicServer(server, user.id) };
    });

    on('role:reorder', ({ serverId, roleIds }) => {
      const { server, myPos } = requireRoleManager(serverId);
      const rest = server.roles.filter((r) => r.id !== server.id);
      if (!Array.isArray(roleIds) || roleIds.length !== rest.length || new Set(roleIds).size !== rest.length
        || !roleIds.every((id) => rest.some((r) => r.id === id))) fail('Нужен полный список ролей (кроме @everyone) сверху вниз');
      const n = rest.length;
      const newPos = new Map(roleIds.map((id, i) => [id, n - i]));
      if (myPos !== Infinity) {
        for (const r of rest) {
          // роли не ниже вашей не двигаются; свои роли нельзя поднять до/выше своей
          if (r.position >= myPos && newPos.get(r.id) !== r.position) fail('Можно переставлять только роли ниже вашей высшей роли');
          if (r.position < myPos && newPos.get(r.id) >= myPos) fail('Нельзя поднять роль выше своей');
        }
      }
      for (const r of rest) r.position = newPos.get(r.id);
      normalizePositions(server);
      permsChanged(server);
      return { server: publicServer(server, user.id) };
    });

    // ---------- участники ----------
    on('member:roles', ({ serverId, userId, roleIds }) => {
      const { server, myPos } = requireRoleManager(serverId);
      const target = requireTargetMember(server, userId);
      if (target.id !== user.id && !canActOn(server, user.id, target.id)) fail(HIERARCHY);
      if (!Array.isArray(roleIds) || roleIds.some((id) => typeof id !== 'string')) fail('roleIds: список id ролей');
      const wanted = new Set(roleIds.filter((id) => id !== server.id));
      for (const id of wanted) if (!findRole(server, id)) fail('Роль не найдена');
      const current = new Set(server.memberRoles[target.id] || []);
      for (const id of new Set([...wanted, ...current])) {
        if (wanted.has(id) === current.has(id)) continue; // не меняется
        if (findRole(server, id).position >= myPos) fail('Можно выдавать и снимать только роли ниже вашей высшей роли');
      }
      const list = server.roles.filter((r) => wanted.has(r.id)).map((r) => r.id);
      if (list.length) server.memberRoles[target.id] = list; else delete server.memberRoles[target.id];
      permsChanged(server);
      return { server: publicServer(server, user.id) };
    });

    on('member:kick', ({ serverId, userId }) => {
      const server = requirePerm(serverId, user, PERMS.KICK_MEMBERS);
      const target = requireTargetMember(server, userId);
      if (target.id === user.id) fail('Нельзя выгнать себя — выйдите с сервера');
      if (!canActOn(server, user.id, target.id)) fail(HIERARCHY);
      removeMember(server, target.id, 'kick');
    });

    on('member:ban', ({ serverId, userId, reason, deleteMessages }) => {
      const server = requirePerm(serverId, user, PERMS.BAN_MEMBERS);
      const target = typeof userId === 'string' ? findUser(userId) : null;
      if (!target) fail('Пользователь не найден');
      if (target.isBot) fail('С ботом так нельзя');
      if (target.id === user.id) fail('Нельзя заблокировать себя');
      if (!canActOn(server, user.id, target.id)) fail(HIERARCHY);
      server.bans[target.id] = { by: user.id, reason: str(reason).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300), at: Date.now() };
      if (deleteMessages === true) {
        for (const c of serverChannels(server.id)) {
          const list = db.data.messages[c.id];
          if (!list) continue;
          const removed = list.filter((m) => m.authorId === target.id);
          if (!removed.length) continue;
          db.data.messages[c.id] = list.filter((m) => m.authorId !== target.id);
          for (const m of removed) {
            emitToViewers(c.id, 'message:deleted', { channelId: c.id, messageId: m.id });
            forgetNotifications(m.id);
          }
        }
      }
      if (server.memberIds.includes(target.id)) removeMember(server, target.id, 'ban');
      else { save(); emitServerUpdated(server); }
    });

    on('member:unban', ({ serverId, userId }) => {
      const server = requirePerm(serverId, user, PERMS.BAN_MEMBERS);
      if (typeof userId !== 'string' || !server.bans[userId]) fail('Этот пользователь не заблокирован');
      delete server.bans[userId];
      save();
      emitServerUpdated(server);
    });

    on('member:voice', ({ serverId, userId, serverMute, serverDeafen, moveTo }) => {
      const server = requireServerMember(serverId, user);
      const target = requireTargetMember(server, userId);
      const base = computeBase(server, user.id);
      if (serverMute !== undefined && typeof serverMute !== 'boolean') fail('serverMute: true/false');
      if (serverDeafen !== undefined && typeof serverDeafen !== 'boolean') fail('serverDeafen: true/false');
      if (serverMute !== undefined && !has(base, PERMS.MUTE_MEMBERS)) fail(NO_PERM);
      if (serverDeafen !== undefined && !has(base, PERMS.DEAFEN_MEMBERS)) fail(NO_PERM);
      if (moveTo !== undefined && !has(base, PERMS.MOVE_MEMBERS)) fail(NO_PERM);
      if (serverMute === undefined && serverDeafen === undefined && moveTo === undefined) fail('Нет изменений');
      if (target.id !== user.id && !canActOn(server, user.id, target.id)) fail(HIERARCHY);

      const inVoice = voice.allHumans().filter((h) => h.member.userId === target.id && findChannel(h.channelId)?.serverId === server.id);
      let dest = null;
      if (moveTo !== undefined && moveTo !== null) {
        dest = typeof moveTo === 'string' ? findChannel(moveTo) : null;
        if (!dest || dest.serverId !== server.id || dest.type !== 'voice') fail('Голосовой канал не найден');
        if (!canViewChannel(server, dest.id, user.id) || !canViewChannel(server, dest.id, target.id)) fail('Нет доступа к этому каналу');
      }
      if (moveTo !== undefined && !inVoice.length) fail('Участник не в голосовом канале');

      if (serverMute !== undefined || serverDeafen !== undefined) {
        server.voiceModeration ||= {};
        const mod = { ...modOf(server, target.id) };
        if (serverMute !== undefined) mod.mute = serverMute;
        if (serverDeafen !== undefined) mod.deafen = serverDeafen;
        if (mod.mute || mod.deafen) server.voiceModeration[target.id] = mod;
        else delete server.voiceModeration[target.id];
        save();
        for (const h of inVoice) voice.setModeration(h.socketId, voiceFlags(server, h.channelId, target.id));
      }
      if (moveTo !== undefined) {
        for (const h of inVoice) {
          if (dest && h.channelId === dest.id) continue;
          if (dest) moveGrants.set(target.id, { channelId: dest.id, until: Date.now() + MOVE_GRANT_MS });
          disconnectFromVoice(h.socketId, dest ? dest.id : null);
        }
      }
    });

    // ---------- сообщения ----------
    on('message:history', ({ channelId, before }) => {
      const dm = findDm(channelId);
      const { channel } = dm ? { channel: requireDm(channelId, user) } : requireChannel(channelId, user, 'text');
      let list = db.data.messages[channel.id] || [];
      if (Number.isFinite(before)) list = list.filter((m) => m.createdAt < before);
      return { messages: list.slice(-50).map(publicMessage) };
    });

    const cleanText = (content) => {
      if (content !== undefined && content !== null && typeof content !== 'string') fail('Некорректный текст сообщения');
      const text = str(content).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (text.length > 2000) fail('Сообщение слишком длинное (максимум 2000 символов)');
      return text;
    };
    const rateLimit = () => {
      const now = Date.now();
      if (now > limiter.reset) { limiter.count = 0; limiter.reset = now + 10_000; }
      if (++limiter.count > 25) fail('Слишком много сообщений подряд — подождите пару секунд');
    };

    /** Сообщение в ЛС: только текст и вложения; писать можно, пока есть общий сервер */
    function sendDm(dm, content, attachments) {
      const other = findUser(dmOther(dm, user.id));
      if (!other || other.isBot) fail('Собеседник недоступен');
      if (!sharesServer(user.id, other.id)) fail('Писать можно только тем, с кем у вас есть общий сервер');
      const text = cleanText(content);
      const atts = validateAttachments(attachments);
      if (!text && atts.length === 0) fail('Нельзя отправить пустое сообщение');
      rateLimit();
      const msg = addMessage({ channelId: dm.id, authorId: user.id, content: text, attachments: atts });
      dm.lastAt = msg.createdAt;
      if (dm.hidden) dm.hidden = {}; // новое сообщение возвращает чат в список у обоих
      setRead(user.id, dm.id, msg.createdAt);
      save();
      const message = publicMessage(msg);
      for (const uid of dm.userIds) {
        io.to(userRoom(uid)).emit('dm:updated', { dm: publicDm(dm, uid) });
        io.to(userRoom(uid)).emit('message:new', { message });
      }
      if (isViewing(other.id, dm.id)) setRead(other.id, dm.id, msg.createdAt);
      else notifyUser(other.id, { type: 'dm', channelId: dm.id, message: msg });
      return { message };
    }

    on('message:send', ({ channelId, content, attachments }) => {
      const dm = findDm(channelId);
      if (dm) return sendDm(requireDm(channelId, user), content, attachments);
      const { channel, server, perms } = requireChannel(channelId, user, 'text');
      if (!has(perms, PERMS.SEND_MESSAGES)) fail('Нет права писать в этот канал');
      const text = cleanText(content);
      const atts = validateAttachments(attachments);
      if (atts.length && !has(perms, PERMS.ATTACH_FILES)) fail('Нет права прикреплять файлы в этом канале');
      if (!text && atts.length === 0) fail('Нельзя отправить пустое сообщение');
      rateLimit();

      const mentionEveryone = /(^|[^\p{L}\p{N}_@])@(everyone|here)(?![\p{L}\p{N}_])/u.test(text) && has(perms, PERMS.MENTION_EVERYONE);
      const msg = addMessage({ channelId: channel.id, authorId: user.id, content: text, attachments: atts, mentionEveryone });
      const message = publicMessage(msg);
      emitToViewers(channel.id, 'message:new', { message });
      setRead(user.id, channel.id, msg.createdAt);
      notifyMentions(server, channel, msg);

      const cmd = text.match(/^!([\p{L}\d]+)(?:\s+([\s\S]*))?$/u);
      if (cmd) {
        const command = cmd[1].toLowerCase();
        const args = (cmd[2] || '').trim();
        if (!has(perms, PERMS.USE_MUSIC_BOT)) setTimeout(() => sendSystem(channel, NO_MUSIC_PERM), 50);
        else if (isBotOnline()) forwardCommand({ command, args, user, serverId: server.id, textChannelId: channel.id });
        else setTimeout(() => sendSystem(channel, BOT_OFFLINE_TEXT), 50);
      }
      return { message };
    });

    on('message:delete', ({ messageId }) => {
      if (typeof messageId !== 'string') fail('Сообщение не найдено');
      for (const [channelId, list] of Object.entries(db.data.messages)) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx === -1) continue;
        const dm = findDm(channelId);
        if (dm) {
          if (!isDmMember(dm, user.id)) fail('Сообщение не найдено');
          if (list[idx].authorId !== user.id) fail('Удалять можно только свои сообщения');
          list.splice(idx, 1);
          save();
          forgetNotifications(messageId);
          for (const uid of dm.userIds) {
            io.to(userRoom(uid)).emit('message:deleted', { channelId, messageId });
            io.to(userRoom(uid)).emit('dm:updated', { dm: publicDm(dm, uid) });
          }
          return;
        }
        const channel = findChannel(channelId);
        const server = channel && findServer(channel.serverId);
        if (!isMember(server, user.id)) fail('Сообщение не найдено');
        const perms = computeChannel(server, channelId, user.id);
        if (!has(perms, PERMS.VIEW_CHANNEL)) fail('Сообщение не найдено');
        if (list[idx].authorId !== user.id && !has(perms, PERMS.MANAGE_MESSAGES)) fail('Удалять можно только свои сообщения');
        list.splice(idx, 1);
        save();
        emitToViewers(channelId, 'message:deleted', { channelId, messageId });
        forgetNotifications(messageId);
        return;
      }
      fail('Сообщение не найдено');
    });

    socket.on('typing', (payload) => {
      try {
        const dm = findDm(payload?.channelId);
        if (dm) {
          if (!isDmMember(dm, user.id) || !sharesServer(user.id, dmOther(dm, user.id))) return;
          io.to(userRoom(dmOther(dm, user.id))).emit('typing', { channelId: dm.id, user: publicUser(user) });
          return;
        }
        const { channel, perms } = requireChannel(payload?.channelId, user, 'text');
        if (!has(perms, PERMS.SEND_MESSAGES)) return;
        emitToViewers(channel.id, 'typing', { channelId: channel.id, user: publicUser(user) }, null, { except: socket.id });
      } catch { /* молча игнорируем */ }
    });

    // ---------- ЛС, «Входящие», прочитанное ----------
    on('dm:open', ({ userId }) => {
      const other = typeof userId === 'string' ? findUser(userId) : null;
      if (!other || other.id === user.id) fail('Пользователь не найден');
      if (other.isBot) fail('Боту нельзя писать в личку');
      // уже существующую переписку можно открыть и без общего сервера (только чтение — писать запретит sendDm)
      const existing = userDms(user.id).find((d) => d.userIds.includes(other.id));
      if (!existing && !sharesServer(user.id, other.id)) fail('Писать можно только тем, с кем у вас есть общий сервер');
      const dm = existing || getOrCreateDm(user.id, other.id);
      if (dm.hidden?.[user.id]) { delete dm.hidden[user.id]; save(); }
      const pub = publicDm(dm, user.id);
      io.to(userRoom(user.id)).emit('dm:updated', { dm: pub });
      return { dm: pub };
    });

    on('dm:close', ({ dmId }) => {
      const dm = requireDm(dmId, user);
      (dm.hidden ||= {})[user.id] = true;
      setRead(user.id, dm.id);
      markNotificationsRead(user.id, { channelId: dm.id });
      save();
      io.to(userRoom(user.id)).emit('dm:closed', { dmId: dm.id });
    });

    /** Канал/ЛС прочитан: метка + уведомления о нём — прочитаны (все вкладки узнают) */
    on('channel:read', ({ channelId }) => {
      const dm = findDm(channelId);
      if (dm) requireDm(channelId, user); else requireChannel(channelId, user, 'text');
      const at = Date.now();
      setRead(user.id, channelId, at);
      const ids = markNotificationsRead(user.id, { channelId });
      io.to(userRoom(user.id)).emit('read:state', { channelId, at, notificationIds: ids });
    });

    on('notification:read', ({ ids, all }) => {
      const changed = markNotificationsRead(user.id, all === true ? { all: true } : { ids: Array.isArray(ids) ? ids.slice(0, 200) : [] });
      if (changed.length) io.to(userRoom(user.id)).emit('read:state', { notificationIds: changed });
      return { ids: changed };
    });

    /** Что открыто в этой вкладке и видна ли она — чтобы не слать push/уведомления о том, что человек и так видит */
    socket.on('client:view', (payload) => {
      if (!isObj(payload)) return;
      socket.data.view = { channelId: typeof payload.channelId === 'string' ? payload.channelId.slice(0, 64) : null, visible: payload.visible === true };
    });

    // ---------- голос ----------
    on('voice:join', ({ channelId }) => {
      const { channel, server, perms } = requireChannel(channelId, user, 'voice');
      const grant = moveGrants.get(user.id);
      const moved = grant && grant.channelId === channel.id && grant.until > Date.now();
      if (moved) moveGrants.delete(user.id);
      if (!has(perms, PERMS.CONNECT) && !moved) fail('Нет права подключаться к этому каналу');
      return voice.join(socket, user, channel, voiceFlags(server, channel.id, user.id));
    });

    on('voice:leave', () => { voice.leave(socket); });

    socket.on('voice:state', (payload) => {
      if (!isObj(payload)) return;
      const chId = voice.channelOf(socket.id);
      const ch = chId && findChannel(chId);
      const server = ch && findServer(ch.serverId);
      const allowStream = !!server && has(computeChannel(server, ch.id, user.id), PERMS.STREAM);
      voice.updateState(socket, payload, { allowStream });
      // значок «Стример»: первая трансляция экрана
      if (payload.streaming === true && allowStream && markStreamed(findUser(user.id))) {
        save();
        emitUserUpdated(findUser(user.id));
      }
    });
    socket.on('voice:signal', (payload) => { if (isObj(payload)) voice.signal(socket, payload); });
    socket.on('voice:speaking', (payload) => { if (isObj(payload)) voice.speaking(socket, payload.speaking); });
    // SFU трансляций экрана (server/sfu.js): производить — право STREAM, смотреть — участник того же голосового канала
    sfu?.attach({
      on, fail, socket,
      channelOf: () => voice.channelOf(socket.id),
      canStream: (chId) => {
        const ch = findChannel(chId);
        const server = ch && findServer(ch.serverId);
        return !!server && isMember(server, user.id) && has(computeChannel(server, ch.id, user.id), PERMS.STREAM);
      },
    });

    on('music:command', ({ command, args }) => {
      const cmd = str(command).trim().toLowerCase();
      if (!BOT_COMMANDS.includes(cmd)) fail('Неизвестная команда');
      if (args !== undefined && args !== null && typeof args !== 'string') fail('Некорректные аргументы');
      const vc = voice.channelOf(socket.id) || voice.userVoiceChannel(user.id);
      const channel = vc && findChannel(vc);
      const server = channel && findServer(channel.serverId);
      if (server && !has(computeChannel(server, channel.id, user.id), PERMS.USE_MUSIC_BOT)) fail(NO_MUSIC_PERM);
      if (!isBotOnline()) fail('Музыкальный бот не запущен');
      if (!channel) fail('Зайди в голосовой канал');
      forwardCommand({ command: cmd, args: str(args).trim().slice(0, 500), user, serverId: channel.serverId, textChannelId: null });
    });

    socket.on('disconnect', () => {
      voice.leave(socket);
      if (removeOnlineSocket(user.id, socket.id) && findUser(user.id)?.status !== 'invisible') emitPresence(user.id);
    });
  });

  // ---------- бот ----------
  function onBot(socket) {
    const bot = socket.data.user;
    if (botSocket && botSocket.id !== socket.id) {
      console.log('[bot] Подключился новый экземпляр бота — старый отключаю');
      const old = botSocket;
      botSocket = null;
      old.disconnect(true);
      voice.botGone(); // новый экземпляр начинает с чистого листа
    }
    botSocket = socket;
    socket.join('bot');
    if (addOnlineSocket(bot.id, socket.id)) emitPresence(bot.id);
    io.emit('bot:status', { online: true });
    console.log('[bot] DJ Бот подключён');

    const botOn = (event, handler) => socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        handler(isObj(payload) ? payload : {});
        reply({ ok: true });
      } catch (err) {
        if (!(err instanceof WsError)) console.error(`[bot] ${event}:`, err);
        reply({ ok: false, error: err.message });
      }
    });

    const channelOfType = (id, type) => {
      const c = typeof id === 'string' ? findChannel(id) : null;
      if (!c || c.type !== type) fail(type === 'text' ? 'Текстовый канал не найден' : 'Голосовой канал не найден');
      return c;
    };

    botOn('bot:say', ({ channelId, content }) => {
      const channel = channelOfType(channelId, 'text');
      const text = str(content).trim().slice(0, 2000);
      if (!text) fail('Пустое сообщение');
      const msg = addMessage({ channelId: channel.id, authorId: bot.id, content: text });
      emitToViewers(channel.id, 'message:new', { message: publicMessage(msg) });
    });

    botOn('bot:voice-join', ({ channelId }) => {
      voice.botJoin(channelOfType(channelId, 'voice'), bot);
    });

    botOn('bot:voice-leave', ({ channelId }) => {
      if (typeof channelId === 'string') voice.botLeave(channelId);
    });

    botOn('bot:music-state', (st) => {
      const channel = channelOfType(st.channelId, 'voice');
      const cleanTrack = (t) => {
        if (!isObj(t)) return null;
        const out = {
          id: str(t.id).slice(0, 64), title: str(t.title).slice(0, 200), artist: str(t.artist).slice(0, 200),
          ...(typeof t.qid === 'string' && t.qid ? { qid: t.qid.slice(0, 40) } : {}),
          duration: Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 0,
          addedBy: typeof t.addedBy === 'string' ? t.addedBy.slice(0, 50) : null,
        };
        if (t.pending) {
          // «ожидающий» элемент очереди (ещё не скачан): без url
          out.pending = true;
          out.source = ['youtube', 'soundcloud', 'spotify', 'search'].includes(t.source) ? t.source : 'search';
          if (t.loading) out.loading = true;
          // откуда скачать (для «Сохранить очередь как плейлист» / «В плейлист» в интерфейсе)
          if (isObj(t.ref)) {
            const ref = {};
            if (/^https?:\/\//.test(str(t.ref.url))) ref.url = str(t.ref.url).slice(0, 500);
            if (/^[a-z]+:[^\s]{1,200}$/.test(str(t.ref.key))) ref.key = str(t.ref.key);
            if (str(t.ref.query)) ref.query = str(t.ref.query).slice(0, 200);
            if (Object.keys(ref).length) out.ref = ref;
          }
        } else {
          out.url = str(t.url).slice(0, 500);
        }
        if (t.autoplay === true) out.autoplay = true; // добавлен автоплеем
        return out;
      };
      const state = {
        channelId: channel.id,
        track: isObj(st.track) && !st.track.pending ? cleanTrack(st.track) : null,
        queue: Array.isArray(st.queue) ? st.queue.slice(0, 500).map(cleanTrack).filter(Boolean) : [],
        paused: !!st.paused,
        autoplay: !!st.autoplay,
        seekSeq: Number.isInteger(st.seekSeq) && st.seekSeq >= 0 ? st.seekSeq : 0,
        position: Number.isFinite(st.position) && st.position >= 0 ? st.position : 0,
        updatedAt: Number.isFinite(st.updatedAt) ? st.updatedAt : Date.now(),
      };
      voice.setMusicState(state, channel.serverId);
    });

    socket.on('disconnect', () => {
      if (removeOnlineSocket(bot.id, socket.id)) emitPresence(bot.id);
      if (botSocket?.id !== socket.id) return; // заменён новым экземпляром
      botSocket = null;
      voice.botGone();
      io.emit('bot:status', { online: false });
      console.log('[bot] DJ Бот отключился');
    });
  }

  // ---------- профиль ----------
  // user:updated {user} — самому (все вкладки, реальный статус) и всем, кто делит с ним сервер (публичный вид)
  function emitUserUpdated(userRec, { statusChanged = false } = {}) {
    const others = userServers(userRec.id).map((s) => serverRoom(s.id));
    io.to(userRoom(userRec.id)).emit('user:updated', { user: publicUser(userRec, { self: true }) });
    if (others.length) io.to(others).except(userRoom(userRec.id)).emit('user:updated', { user: publicUser(userRec) });
    voice.updateUser(userRec);
    if (statusChanged) emitPresence(userRec.id);
  }

  // Истёкшие кастомные статусы — сбросить и разослать
  const sweep = setInterval(() => {
    let changed = false;
    for (const u of db.data.users) {
      if (u.customStatus && !activeCustomStatus(u)) {
        u.customStatus = null;
        changed = true;
        emitUserUpdated(u);
      }
    }
    if (changed) save();
  }, 30_000);
  sweep.unref();

  // Смена пароля: сокеты удалённых сессий отключаем (при переподключении — connect_error 'unauthorized')
  function disconnectSessions(userId, tokens) {
    if (!tokens?.length) return;
    dropPushSubsForSessions(userId, tokens); // push на устройства с отозванными сессиями больше не идёт
    const set = new Set(tokens);
    for (const s of io.sockets.sockets.values()) {
      if (!s.data.isBot && s.data.user?.id === userId && set.has(s.data.token)) s.disconnect(true);
    }
  }

  // Плейлисты/настройки музыки сервера изменились (REST, server/music-playlists.js)
  function emitMusicPlaylists(serverId) {
    io.to(serverRoom(serverId)).emit('music:playlists', { serverId });
  }
  function emitMusicSettings(serverId, settings) {
    io.to(serverRoom(serverId)).emit('music:settings', { serverId, ...settings });
    botSocket?.emit('bot:music-settings', { serverId, ...settings });
  }

  // Админ-панель экземпляра (server/admin/): действия над любым сервером/пользователем с рассылками
  const adminOps = createAdminOps({ io, voice, removeMember, permsChanged, emitServerUpdated, emitToViewers, forgetNotifications, mediaInUse });

  return { isBotOnline, emitUserUpdated, disconnectSessions, emitServerUpdated, emitMusicPlaylists, emitMusicSettings, watch, adminOps };
}

