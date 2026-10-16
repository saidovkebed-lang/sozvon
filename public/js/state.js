// Глобальный стор + подписки по темам (уведомления батчатся в микрозадачу)
export const state = {
  user: null,
  servers: [],             // Server[]
  voice: {},               // channelId -> VoiceMember[]
  music: {},               // channelId -> MusicState (+ _skew)
  botOnline: false,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  relay: false,            // настроен ли TURN на сервере
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
