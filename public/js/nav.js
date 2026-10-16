// Навигация: выбор сервера/канала, загрузка истории
import { state, notify, getServer, getChannel } from './state.js';
import { emitAck } from './socket.js';
import { lsGet, lsSet } from './util.js';
import { toastError } from './ui/toasts.js';

const LAST_KEY = 'sozvon.last';

function saveLast() {
  lsSet(LAST_KEY, JSON.stringify({ serverId: state.currentServerId, channels: state.lastChannel }));
}

export function restoreLast() {
  try {
    const v = JSON.parse(lsGet(LAST_KEY, 'null'));
    if (v && typeof v === 'object') {
      state.lastChannel = v.channels && typeof v.channels === 'object' ? v.channels : {};
      return v.serverId || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function selectServer(serverId) {
  const server = getServer(serverId);
  if (!server) {
    state.currentServerId = null;
    state.currentChannelId = null;
    saveLast();
    notify('nav');
    return;
  }
  state.currentServerId = server.id;
  const remembered = server.channels.find((c) => c.id === state.lastChannel[server.id]);
  const firstText = sortedChannels(server).find((c) => c.type === 'text');
  const ch = remembered || firstText || sortedChannels(server)[0];
  selectChannel(ch ? ch.id : null);
}

export function sortedChannels(server) {
  return [...(server?.channels || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export function selectChannel(channelId) {
  const ch = channelId ? getChannel(channelId) : null;
  state.currentChannelId = ch ? ch.id : null;
  if (ch) {
    state.currentServerId = ch.serverId;
    state.lastChannel[ch.serverId] = ch.id;
    if (ch.type === 'text' && !state.messages[ch.id]) loadHistory(ch.id);
  }
  saveLast();
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

function mergeSorted(a, b) {
  return [...a, ...b].sort((x, y) => x.createdAt - y.createdAt);
}

/** После server:updated / server:removed: проверить, что текущий выбор валиден */
export function revalidateSelection() {
  const server = getServer();
  if (!server) {
    const first = state.servers[0];
    selectServer(first ? first.id : null);
    return;
  }
  if (!getChannel(state.currentChannelId)) selectServer(server.id);
}
