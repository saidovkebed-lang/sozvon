// Глобальный стор + подписки по темам (уведомления батчатся в микрозадачу)
export const state = {
  user: null,
  servers: [],             // Server[]
  voice: {},               // channelId -> VoiceMember[]
  music: {},               // channelId -> MusicState (+ _skew)
  botOnline: false,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  relay: false,            // настроен ли TURN на сервере
  forceRelay: false,       // сервер требует ходить только через TURN (iceTransportPolicy: 'relay')
  publicUrl: null,         // публичная ссылка (npm run share)
  currentServerId: null,
  currentChannelId: null,
  lastChannel: {},         // serverId -> channelId
  messages: {},            // channelId -> Message[]
  hasMore: {},             // channelId -> boolean
  typing: {},              // channelId -> { userId: {user, until} }
  speaking: new Set(),     // socketId
  myVoice: null,           // { channelId, serverId }
  muted: false,
  deafened: false,
  streaming: false,
  camera: false,
  connected: false,
};

const subs = new Map();
const pending = new Set();
let scheduled = false;

export function subscribe(topics, fn) {
  for (const t of [].concat(topics)) {
    if (!subs.has(t)) subs.set(t, new Set());
    subs.get(t).add(fn);
  }
}

export function notify(...topics) {
  topics.forEach((t) => pending.add(t));
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const fns = new Set();
    for (const t of pending) subs.get(t)?.forEach((f) => fns.add(f));
    pending.clear();
    for (const f of fns) {
      try { f(); } catch (e) { console.warn('[render]', e); }
    }
  });
}

/** Сетевая часть GET /api/config (ICE/TURN, публичная ссылка). Вызывается при старте и перед voice:join. */
export function applyNetConfig(cfg) {
  if (!cfg) return;
  if (Array.isArray(cfg.iceServers)) state.iceServers = cfg.iceServers;
  state.relay = !!cfg.relay;
  state.forceRelay = !!cfg.forceRelay;
  state.publicUrl = cfg.publicUrl || null;
}

/* ---------- селекторы ---------- */
export const getServer = (id = state.currentServerId) => state.servers.find((s) => s.id === id) || null;

export function getChannel(id = state.currentChannelId) {
  for (const s of state.servers) {
    const c = s.channels.find((ch) => ch.id === id);
    if (c) return c;
  }
  return null;
}

export const isOwner = (server = getServer()) => !!server && !!state.user && server.ownerId === state.user.id;

export function upsertServer(server) {
  const i = state.servers.findIndex((s) => s.id === server.id);
  if (i >= 0) state.servers[i] = server; else state.servers.push(server);
}

export function setUserOnline(userId, online) {
  for (const s of state.servers) {
    for (const m of s.members) if (m.id === userId) m.online = online;
  }
}

export function musicElapsed(ms) {
  if (!ms || !ms.track) return 0;
  const skew = ms._skew || 0;
  const el = ms.position + (ms.paused ? 0 : (Date.now() + skew - ms.updatedAt) / 1000);
  return Math.max(0, el);
}

/** user:updated {user} — обновить пользователя везде: я, участники серверов, голос, авторы сообщений. */
export function applyUserUpdate(user) {
  if (!user || !user.id) return false;
  const pick = (o) => {
    if (!o || o.id !== user.id) return;
    if (user.color) o.color = user.color;
    if (user.username) o.username = user.username;
  };
  if (state.user?.id === user.id) state.user = { ...state.user, ...user };
  for (const s of state.servers) for (const m of s.members || []) pick(m);
  for (const list of Object.values(state.voice)) {
    for (const m of list || []) {
      if (m.userId === user.id) {
        if (user.color) m.color = user.color;
        if (user.username) m.username = user.username;
      }
    }
  }
  for (const list of Object.values(state.messages)) for (const msg of list || []) pick(msg.author);
  notify('me', 'servers', 'voice', 'presence', 'messages');
  return true;
}
