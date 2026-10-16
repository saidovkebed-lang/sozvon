// Socket.IO: события клиентов и бота.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, newId } from './db.js';
import { userByToken, checkBotToken } from './auth.js';
import {
  findServer, findChannel, findUser, serverChannels, userServers, isMember, getBotUser,
  publicServer, publicChannel, publicMessage, publicUser, addMessage, generateInviteCode,
  addOnlineSocket, removeOnlineSocket,
} from './model.js';
import { createVoice } from './voice.js';

const serverRoom = (id) => `server:${id}`;
const userRoom = (id) => `user:${id}`;

export const BOT_COMMANDS = ['play', 'skip', 'stop', 'pause', 'resume', 'queue', 'np', 'remove', 'shuffle', 'help', 'leave'];
const BOT_OFFLINE_TEXT = 'Музыкальный бот не запущен. Запустите: npm run bot';

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

export function attachRealtime(io, { uploadsDir }) {
  let botSocket = null;
  const voice = createVoice(io, { getBotSocket: () => botSocket });
  const isBotOnline = () => !!botSocket?.connected;

  function emitPresence(userId, online) {
    const rooms = userServers(userId).map((s) => serverRoom(s.id));
    if (rooms.length) io.to(rooms).emit('presence', { userId, online });
  }
  const emitServerUpdated = (server) => io.to(serverRoom(server.id)).emit('server:updated', { server: publicServer(server) });

  function requireServerMember(serverId, user) {
    const server = typeof serverId === 'string' ? findServer(serverId) : null;
    if (!server || !isMember(server, user.id)) fail('Сервер не найден');
    return server;
  }
  function requireOwner(serverId, user) {
    const server = requireServerMember(serverId, user);
    if (server.ownerId !== user.id) fail('Это может сделать только владелец сервера');
    return server;
  }
  function requireChannel(channelId, user, type) {
    const channel = typeof channelId === 'string' ? findChannel(channelId) : null;
    const server = channel && findServer(channel.serverId);
    if (!channel || !isMember(server, user.id)) fail('Канал не найден');
    if (type && channel.type !== type) fail(type === 'text' ? 'Это не текстовый канал' : 'Это не голосовой канал');
    return { channel, server };
  }

  function sendSystem(channel, content) {
    const bot = getBotUser();
    const msg = addMessage({ channelId: channel.id, authorId: bot.id, content, system: true });
    io.to(serverRoom(channel.serverId)).emit('message:new', { message: publicMessage(msg) });
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
    next();
  });

  io.on('connection', (socket) => {
    if (socket.data.isBot) return onBot(socket);
    const user = socket.data.user;
    const limiter = { count: 0, reset: Date.now() + 10_000 };

    socket.join(userRoom(user.id));
    for (const s of userServers(user.id)) socket.join(serverRoom(s.id));
    if (addOnlineSocket(user.id, socket.id)) emitPresence(user.id, true);

    // обёртка: ack обязателен, ошибки → {ok:false,error}
    const on = (event, handler) => socket.on(event, async (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = {}; }
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!findUser(user.id)) fail('Сессия недействительна');
        const res = await handler(isObj(payload) ? payload : {});
        reply({ ok: true, ...(res || {}) });
      } catch (err) {
        if (!(err instanceof WsError)) console.error(`[ws] ${event}:`, err);
        reply({ ok: false, error: err instanceof WsError ? err.message : 'Внутренняя ошибка сервера' });
      }
    });

    on('bootstrap', () => {
      const servers = userServers(user.id);
      const voiceIds = servers.flatMap((s) => serverChannels(s.id).filter((c) => c.type === 'voice').map((c) => c.id));
      const { voice: v, music } = voice.snapshotFor(voiceIds);
      return { user: publicUser(user), servers: servers.map(publicServer), voice: v, music };
    });

    on('server:create', ({ name }) => {
      const clean = cleanName(name, { max: 50, what: 'Название сервера' });
      if (userServers(user.id).filter((s) => s.ownerId === user.id).length >= 50) fail('Слишком много серверов');
      const bot = getBotUser();
      const server = {
        id: newId(), name: clean, ownerId: user.id, inviteCode: generateInviteCode(), icon: null,
        memberIds: [user.id, bot.id], createdAt: Date.now(),
      };
      db.data.servers.push(server);
      db.data.channels.push(
        { id: newId(), serverId: server.id, name: 'общий', type: 'text', position: 0 },
        { id: newId(), serverId: server.id, name: 'Голосовой', type: 'voice', position: 1 },
      );
      save();
      io.in(userRoom(user.id)).socketsJoin(serverRoom(server.id));
      emitServerUpdated(server);
      return { server: publicServer(server) };
    });

    on('server:join', ({ inviteCode }) => {
      const code = str(inviteCode).trim().toLowerCase().replace(/^.*\//, '');
      if (!/^[a-z0-9]{8}$/.test(code)) fail('Инвайт-код — 8 латинских букв и цифр');
      const server = db.data.servers.find((s) => s.inviteCode === code);
      if (!server) fail('Сервер с таким кодом не найден');
      if (!server.memberIds.includes(user.id)) {
        server.memberIds.push(user.id);
        save();
      }
      io.in(userRoom(user.id)).socketsJoin(serverRoom(server.id));
      emitServerUpdated(server);
      return { server: publicServer(server) };
    });

    on('server:leave', ({ serverId }) => {
      const server = requireServerMember(serverId, user);
      if (server.ownerId === user.id) fail('Владелец не может выйти с сервера — его можно только удалить');
      voice.kickUserFromServer(user.id, server.id);
      server.memberIds = server.memberIds.filter((id) => id !== user.id);
      save();
      io.to(userRoom(user.id)).emit('server:removed', { serverId: server.id });
      io.in(userRoom(user.id)).socketsLeave(serverRoom(server.id));
      emitServerUpdated(server);
    });

    on('server:delete', ({ serverId }) => {
      const server = requireOwner(serverId, user);
      const channels = serverChannels(server.id);
      for (const c of channels) {
        if (c.type === 'voice') voice.clearChannel(c.id);
        delete db.data.messages[c.id];
      }
      db.data.channels = db.data.channels.filter((c) => c.serverId !== server.id);
      db.data.servers = db.data.servers.filter((s) => s.id !== server.id);
      save();
      io.to(serverRoom(server.id)).emit('server:removed', { serverId: server.id });
      io.in(serverRoom(server.id)).socketsLeave(serverRoom(server.id));
    });

    on('server:rename', ({ serverId, name }) => {
      const server = requireOwner(serverId, user);
      server.name = cleanName(name, { max: 50, what: 'Название сервера' });
      save();
      emitServerUpdated(server);
    });

    on('channel:create', ({ serverId, name, type }) => {
      const server = requireOwner(serverId, user);
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
      const server = requireOwner(channel.serverId, user);
      if (channel.type === 'text' && serverChannels(server.id).filter((c) => c.type === 'text').length <= 1) {
        fail('Нельзя удалить последний текстовый канал');
      }
      if (channel.type === 'voice') voice.clearChannel(channel.id);
      delete db.data.messages[channel.id];
      db.data.channels = db.data.channels.filter((c) => c.id !== channel.id);
      save();
      emitServerUpdated(server);
    });

    on('message:history', ({ channelId, before }) => {
      const { channel } = requireChannel(channelId, user, 'text');
      let list = db.data.messages[channel.id] || [];
      if (Number.isFinite(before)) list = list.filter((m) => m.createdAt < before);
      return { messages: list.slice(-50).map(publicMessage) };
    });

    on('message:send', ({ channelId, content, attachments }) => {
      const { channel, server } = requireChannel(channelId, user, 'text');
      if (content !== undefined && content !== null && typeof content !== 'string') fail('Некорректный текст сообщения');
      const text = str(content).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (text.length > 2000) fail('Сообщение слишком длинное (максимум 2000 символов)');
      const atts = validateAttachments(attachments);
      if (!text && atts.length === 0) fail('Нельзя отправить пустое сообщение');
      const now = Date.now();
      if (now > limiter.reset) { limiter.count = 0; limiter.reset = now + 10_000; }
      if (++limiter.count > 25) fail('Слишком много сообщений подряд — подождите пару секунд');

      const msg = addMessage({ channelId: channel.id, authorId: user.id, content: text, attachments: atts });
      const message = publicMessage(msg);
      io.to(serverRoom(server.id)).emit('message:new', { message });

      const cmd = text.match(/^!([\p{L}\d]+)(?:\s+([\s\S]*))?$/u);
      if (cmd) {
        const command = cmd[1].toLowerCase();
        const args = (cmd[2] || '').trim();
        if (isBotOnline()) forwardCommand({ command, args, user, serverId: server.id, textChannelId: channel.id });
        else setTimeout(() => sendSystem(channel, BOT_OFFLINE_TEXT), 50);
      }
      return { message };
    });

    on('message:delete', ({ messageId }) => {
      if (typeof messageId !== 'string') fail('Сообщение не найдено');
      for (const [channelId, list] of Object.entries(db.data.messages)) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx === -1) continue;
        const channel = findChannel(channelId);
        const server = channel && findServer(channel.serverId);
        if (!isMember(server, user.id)) fail('Сообщение не найдено');
        if (list[idx].authorId !== user.id && server.ownerId !== user.id) fail('Удалять можно только свои сообщения');
        list.splice(idx, 1);
        save();
        io.to(serverRoom(server.id)).emit('message:deleted', { channelId, messageId });
        return;
      }
      fail('Сообщение не найдено');
    });

    socket.on('typing', (payload) => {
      try {
        const { channel } = requireChannel(payload?.channelId, user, 'text');
        socket.to(serverRoom(channel.serverId)).emit('typing', { channelId: channel.id, user: publicUser(user) });
      } catch { /* молча игнорируем */ }
    });

    on('voice:join', ({ channelId }) => {
      const { channel } = requireChannel(channelId, user, 'voice');
      return voice.join(socket, user, channel);
    });

    on('voice:leave', () => { voice.leave(socket); });

    socket.on('voice:state', (payload) => { if (isObj(payload)) voice.updateState(socket, payload); });
    socket.on('voice:signal', (payload) => { if (isObj(payload)) voice.signal(socket, payload); });
    socket.on('voice:speaking', (payload) => { if (isObj(payload)) voice.speaking(socket, payload.speaking); });

    on('music:command', ({ command, args }) => {
      const cmd = str(command).trim().toLowerCase();
      if (!BOT_COMMANDS.includes(cmd)) fail('Неизвестная команда');
      if (args !== undefined && args !== null && typeof args !== 'string') fail('Некорректные аргументы');
      if (!isBotOnline()) fail('Музыкальный бот не запущен');
      const vc = voice.channelOf(socket.id) || voice.userVoiceChannel(user.id);
      const channel = vc && findChannel(vc);
      if (!channel) fail('Зайди в голосовой канал');
      forwardCommand({ command: cmd, args: str(args).trim().slice(0, 500), user, serverId: channel.serverId, textChannelId: null });
    });

    socket.on('disconnect', () => {
      voice.leave(socket);
      if (removeOnlineSocket(user.id, socket.id)) emitPresence(user.id, false);
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
    if (addOnlineSocket(bot.id, socket.id)) emitPresence(bot.id, true);
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
      io.to(serverRoom(channel.serverId)).emit('message:new', { message: publicMessage(msg) });
    });

    botOn('bot:voice-join', ({ channelId }) => {
      voice.botJoin(channelOfType(channelId, 'voice'), bot);
    });

    botOn('bot:voice-leave', ({ channelId }) => {
      if (typeof channelId === 'string') voice.botLeave(channelId);
    });

    botOn('bot:music-state', (st) => {
      const channel = channelOfType(st.channelId, 'voice');
      const cleanTrack = (t) => (isObj(t) ? {
        id: str(t.id).slice(0, 64), title: str(t.title).slice(0, 200), artist: str(t.artist).slice(0, 200),
        duration: Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 0,
        url: str(t.url).slice(0, 500), addedBy: typeof t.addedBy === 'string' ? t.addedBy.slice(0, 50) : null,
      } : null);
      const state = {
        channelId: channel.id,
        track: cleanTrack(st.track),
        queue: Array.isArray(st.queue) ? st.queue.slice(0, 500).map(cleanTrack).filter(Boolean) : [],
        paused: !!st.paused,
        position: Number.isFinite(st.position) && st.position >= 0 ? st.position : 0,
        updatedAt: Number.isFinite(st.updatedAt) ? st.updatedAt : Date.now(),
      };
      voice.setMusicState(state, channel.serverId);
    });

    socket.on('disconnect', () => {
      if (removeOnlineSocket(bot.id, socket.id)) emitPresence(bot.id, false);
      if (botSocket?.id !== socket.id) return; // заменён новым экземпляром
      botSocket = null;
      voice.botGone();
      io.emit('bot:status', { online: false });
      console.log('[bot] DJ Бот отключился');
    });
  }

  return { isBotOnline };
}
