// Голосовые комнаты: участники, relay WebRTC-сигналов, состояние музыки на канал.
import { findChannel } from './model.js';

const voiceRoom = (channelId) => `voice:${channelId}`;
const botSocketId = (channelId) => `bot-${channelId}`;

// Поля пользователя в карточке голосового участника
const userFields = (u) => ({
  username: u.username, displayName: u.displayName ?? null, color: u.color,
  avatar: u.avatar ?? null, avatarAnimated: u.avatarAnimated ?? null,
});

export function createVoice(io, { getBotSocket, emitToViewers }) {
  const rooms = new Map();        // channelId -> Map(socketId -> VoiceMember)
  const socketChannel = new Map(); // socketId -> channelId (только люди)
  const musicStates = new Map();  // channelId -> MusicState (без serverNow)

  const members = (channelId) => [...(rooms.get(channelId)?.values() || [])].map((m) => ({ ...m }));
  const humans = (channelId) => members(channelId).filter((m) => !m.isBot);

  function broadcastMembers(channelId, serverId) {
    const sid = serverId || findChannel(channelId)?.serverId;
    if (!sid) return;
    emitToViewers(channelId, 'voice:members', { channelId, members: members(channelId) });
  }

  function musicFor(channelId) {
    const st = musicStates.get(channelId);
    return st ? { ...st, serverNow: Date.now() } : null;
  }

  function snapshotFor(channelIds) {
    const voice = {}, music = {};
    for (const id of channelIds) {
      voice[id] = members(id);
      const m = musicFor(id);
      if (m) music[id] = m;
    }
    return { voice, music };
  }

  function userVoiceChannel(userId) {
    for (const [channelId, room] of rooms) {
      for (const m of room.values()) if (!m.isBot && m.userId === userId) return channelId;
    }
    return null;
  }

  function botChannelOnServer(serverId) {
    for (const [channelId, room] of rooms) {
      if (room.has(botSocketId(channelId)) && findChannel(channelId)?.serverId === serverId) return channelId;
    }
    return null;
  }

  function checkEmpty(channelId) {
    if (humans(channelId).length > 0) return;
    const room = rooms.get(channelId);
    const botHere = room?.has(botSocketId(channelId));
    const st = musicStates.get(channelId);
    const bot = getBotSocket();
    if (bot && (botHere || st?.track || st?.queue?.length)) bot.emit('bot:voice-empty', { channelId });
    if (room && room.size === 0) rooms.delete(channelId);
  }

  // Удалить участника по socketId (сокет может быть уже отключён)
  function removeSocket(socketId, { notify = true } = {}) {
    const channelId = socketChannel.get(socketId);
    if (!channelId) return null;
    socketChannel.delete(socketId);
    const room = rooms.get(channelId);
    room?.delete(socketId);
    const s = io.sockets.sockets.get(socketId);
    s?.leave(voiceRoom(channelId));
    if (notify) {
      io.to(voiceRoom(channelId)).emit('voice:peer-left', { socketId });
      broadcastMembers(channelId);
      checkEmpty(channelId);
    }
    return channelId;
  }

  function join(socket, user, channel, { serverMute = false, serverDeafen = false } = {}) {
    removeSocket(socket.id);
    // Пользователь — только в одном голосовом канале (даже из разных вкладок)
    for (const [sid, chId] of [...socketChannel]) {
      const m = rooms.get(chId)?.get(sid);
      if (m && m.userId === user.id) removeSocket(sid);
    }
    let room = rooms.get(channel.id);
    if (!room) rooms.set(channel.id, (room = new Map()));
    const member = {
      socketId: socket.id, userId: user.id, ...userFields(user), isBot: false,
      muted: false, deafened: false, streaming: false, camera: false,
      serverMute: !!serverMute, serverDeafen: !!serverDeafen,
    };
    const peers = members(channel.id);
    room.set(socket.id, member);
    socketChannel.set(socket.id, channel.id);
    socket.join(voiceRoom(channel.id));
    socket.to(voiceRoom(channel.id)).emit('voice:peer-joined', { peer: { ...member } });
    broadcastMembers(channel.id, channel.serverId);
    return { peers, music: musicFor(channel.id) };
  }

  // allowStream=false — нет права STREAM: включить экран/камеру нельзя (выключить можно)
  function updateState(socket, patch, { allowStream = true } = {}) {
    const channelId = socketChannel.get(socket.id);
    const m = channelId && rooms.get(channelId)?.get(socket.id);
    if (!m) return;
    let changed = false;
    for (const key of ['muted', 'deafened', 'streaming', 'camera']) {
      if (typeof patch?.[key] !== 'boolean' || m[key] === patch[key]) continue;
      if ((key === 'streaming' || key === 'camera') && patch[key] && !allowStream) continue;
      m[key] = patch[key]; changed = true;
    }
    if (changed) broadcastMembers(channelId);
  }

  /** Серверный mute/deafen участника (по socketId). */
  function setModeration(socketId, { serverMute, serverDeafen }) {
    const channelId = socketChannel.get(socketId);
    const m = channelId && rooms.get(channelId)?.get(socketId);
    if (!m) return false;
    let changed = false;
    if (typeof serverMute === 'boolean' && m.serverMute !== serverMute) { m.serverMute = serverMute; changed = true; }
    if (typeof serverDeafen === 'boolean' && m.serverDeafen !== serverDeafen) { m.serverDeafen = serverDeafen; changed = true; }
    if (changed) broadcastMembers(channelId);
    return changed;
  }

  /** Все люди в голосовых каналах: [{socketId, channelId, member}]. */
  function allHumans() {
    const out = [];
    for (const [sid, channelId] of socketChannel) {
      const m = rooms.get(channelId)?.get(sid);
      if (m) out.push({ socketId: sid, channelId, member: { ...m } });
    }
    return out;
  }

  function speaking(socket, flag) {
    const channelId = socketChannel.get(socket.id);
    if (!channelId) return;
    socket.to(voiceRoom(channelId)).emit('voice:speaking', { socketId: socket.id, speaking: !!flag });
  }

  function signal(socket, payload) {
    const to = payload?.to;
    if (typeof to !== 'string' || payload.data === undefined || payload.data === null) return;
    const channelId = socketChannel.get(socket.id);
    if (!channelId || socketChannel.get(to) !== channelId) return; // только внутри одного канала
    io.to(to).emit('voice:signal', { from: socket.id, data: payload.data });
  }

  // ---------- бот ----------
  function botJoin(channel, botUser) {
    // одна голосовая комната бота на сервер
    const prev = botChannelOnServer(channel.serverId);
    if (prev && prev !== channel.id) botLeave(prev);
    let room = rooms.get(channel.id);
    if (!room) rooms.set(channel.id, (room = new Map()));
    const id = botSocketId(channel.id);
    if (room.has(id)) return;
    const member = {
      socketId: id, userId: botUser.id, ...userFields(botUser), isBot: true,
      muted: false, deafened: false, streaming: false, camera: false, serverMute: false, serverDeafen: false,
    };
    room.set(id, member);
    io.to(voiceRoom(channel.id)).emit('voice:peer-joined', { peer: { ...member } });
    broadcastMembers(channel.id, channel.serverId);
  }

  function botLeave(channelId) {
    const room = rooms.get(channelId);
    const id = botSocketId(channelId);
    if (!room?.has(id)) return;
    room.delete(id);
    if (room.size === 0) rooms.delete(channelId);
    io.to(voiceRoom(channelId)).emit('voice:peer-left', { socketId: id });
    broadcastMembers(channelId);
  }

  function setMusicState(state, serverId) {
    musicStates.set(state.channelId, state);
    emitToViewers(state.channelId, 'music:state', { ...state, serverNow: Date.now() }, serverId);
  }

  // Бот отключился: убрать его из всех каналов и остановить музыку у всех
  function botGone() {
    for (const channelId of [...rooms.keys()]) botLeave(channelId);
    for (const [channelId, st] of musicStates) {
      const ch = findChannel(channelId);
      musicStates.delete(channelId);
      if (ch && (st.track || st.queue?.length)) {
        emitToViewers(channelId, 'music:state', {
          channelId, track: null, queue: [], paused: false, position: 0, updatedAt: Date.now(), serverNow: Date.now(),
        }, ch.serverId);
      }
    }
  }

  // Канал удаляется: всех выкинуть, состояние забыть
  function clearChannel(channelId) {
    const room = rooms.get(channelId);
    if (room) {
      for (const sid of [...room.keys()]) {
        if (room.get(sid).isBot) continue;
        socketChannel.delete(sid);
        io.sockets.sockets.get(sid)?.leave(voiceRoom(channelId));
      }
      const hadBot = room.has(botSocketId(channelId));
      rooms.delete(channelId);
      if (hadBot || musicStates.get(channelId)?.track) getBotSocket()?.emit('bot:voice-empty', { channelId });
    }
    musicStates.delete(channelId);
  }

  // Пользователь вышел с сервера: выкинуть из голосовых каналов этого сервера
  function kickUserFromServer(userId, serverId) {
    for (const [sid, chId] of [...socketChannel]) {
      const m = rooms.get(chId)?.get(sid);
      if (m?.userId === userId && findChannel(chId)?.serverId === serverId) removeSocket(sid);
    }
  }

  // Пользователь сменил профиль (цвет, имя, аватар) — обновить карточки в голосовых каналах
  function updateUser(user) {
    const f = userFields(user);
    for (const [channelId, room] of rooms) {
      let changed = false;
      for (const m of room.values()) {
        if (m.isBot || m.userId !== user.id) continue;
        for (const [k, v] of Object.entries(f)) if (m[k] !== v) { m[k] = v; changed = true; }
      }
      if (changed) broadcastMembers(channelId);
    }
  }

  return {
    updateUser,
    members, humans, broadcastMembers, musicFor, snapshotFor, userVoiceChannel, botChannelOnServer,
    join, leave: (socket) => removeSocket(socket.id), removeSocket, updateState, speaking, signal,
    botJoin, botLeave, setMusicState, botGone, clearChannel, kickUserFromServer, setModeration, allHumans,
    channelOf: (socketId) => socketChannel.get(socketId) || null,
  };
}
