// Навигация: выбор сервера/канала, загрузка истории
import { state, notify, getServer, getChannel, getDm } from './state.js';
import { emit, emitAck } from './socket.js';
import { lsGet, lsSet } from './util.js';
import { toastError } from './ui/toasts.js';

const LAST_KEY = 'sozvon.last';

function saveLast() {
  lsSet(LAST_KEY, JSON.stringify({ serverId: state.currentServerId, channels: state.lastChannel, dm: state.lastDm }));
}

export function restoreLast() {
  try {
    const v = JSON.parse(lsGet(LAST_KEY, 'null'));
    if (v && typeof v === 'object') {
      state.lastChannel = v.channels && typeof v.channels === 'object' ? v.channels : {};
      state.lastDm = typeof v.dm === 'string' ? v.dm : null;
      return v.serverId || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function selectServer(serverId, { auto = false } = {}) {
  const server = getServer(serverId);
  if (!server) {
    // «Главная» — личные сообщения: последний открытый чат или список
    if (state.lastDm && getDm(state.lastDm)) { selectChannel(state.lastDm, { auto }); return; }
    state.currentServerId = null;
    state.currentChannelId = null;
    saveLast();
    reportView();
    notify('nav');
    return;
  }
  state.currentServerId = server.id;
  const remembered = server.channels.find((c) => c.id === state.lastChannel[server.id]);
  const firstText = sortedChannels(server).find((c) => c.type === 'text');
  const ch = remembered || firstText || sortedChannels(server)[0];
  selectChannel(ch ? ch.id : null, { auto });
}

export function sortedChannels(server) {
  return [...(server?.channels || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** auto: канал открыт сам (восстановление после перезагрузки) — не считать его прочитанным,
 *  чтобы упоминания, пришедшие офлайн, остались во «Входящих» */
export function selectChannel(channelId, { auto = false } = {}) {
  const ch = channelId ? getChannel(channelId) : null;
  state.currentChannelId = ch ? ch.id : null;
  if (ch?.dm) {
    state.currentServerId = null;
    state.lastDm = ch.id;
    if (!state.messages[ch.id]) loadHistory(ch.id);
  } else if (ch) {
    state.currentServerId = ch.serverId;
    state.lastChannel[ch.serverId] = ch.id;
    if (ch.type === 'text' && !state.messages[ch.id]) loadHistory(ch.id);
  }
  saveLast();
  reportView();
  if (ch?.type === 'text' && !auto) markRead(ch.id);
  document.getElementById('app')?.classList.remove('is-nav-open');
  notify('nav');
}

const loading = new Set();
export async function loadHistory(channelId, before) {
  if (loading.has(channelId)) return false;
  loading.add(channelId);
  notify('messages');
  try {
    const res = await emitAck('message:history', before ? { channelId, before } : { channelId });
    const msgs = res.messages || [];
    const existing = state.messages[channelId] || [];
    const ids = new Set(existing.map((m) => m.id));
    const fresh = msgs.filter((m) => !ids.has(m.id));
    state.messages[channelId] = before ? [...fresh, ...existing] : mergeSorted(existing, fresh);
    state.hasMore[channelId] = msgs.length >= 50;
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    loading.delete(channelId);
    notify(before ? 'history' : 'messages');
  }
}

export const isLoading = (channelId) => loading.has(channelId);

/* ---------- прочитанное ---------- */
const pageVisible = () => document.visibilityState === 'visible' && document.hasFocus();

/** Сообщить серверу, что открыто и видно ли окно (нужно, чтобы не слать push о том, что вы и так видите) */
export function reportView() {
  if (!state.connected) return;
  emit('client:view', { channelId: state.currentChannelId, visible: pageVisible() });
}

const lastRead = new Map(); // channelId -> время последнего channel:read (не чаще раза в секунду)
/** Отметить канал/ЛС прочитанным (уведомления о нём уйдут из «Входящих», счётчик ЛС обнулится) */
export function markRead(channelId = state.currentChannelId, { force = false } = {}) {
  if (!channelId || !state.connected || !pageVisible()) return;
  const dm = getDm(channelId);
  const hasUnread = (dm && dm.unread) || state.notifications.some((n) => !n.read && n.channelId === channelId);
  if (!hasUnread && !force) return;
  const now = Date.now();
  if (now - (lastRead.get(channelId) || 0) < 1000) return;
  lastRead.set(channelId, now);
  if (dm) { dm.unread = 0; notify('dms'); }
  emitAck('channel:read', { channelId }).catch(() => {});
}

export function initReadTracking() {
  const onFocus = () => { reportView(); markRead(); };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', reportView);
  document.addEventListener('visibilitychange', onFocus);
}

function mergeSorted(a, b) {
  return [...a, ...b].sort((x, y) => x.createdAt - y.createdAt);
}

/** После server:updated / server:removed: проверить, что текущий выбор валиден */
export function revalidateSelection() {
  if (getChannel(state.currentChannelId)?.dm) return;
  const server = getServer();
  if (!server) {
    if (!state.currentServerId && !state.currentChannelId) return; // «Главная»: список ЛС
    const first = state.servers[0];
    selectServer(first ? first.id : null);
    return;
  }
  if (!getChannel(state.currentChannelId)) selectServer(server.id);
}
