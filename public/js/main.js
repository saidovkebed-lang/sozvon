// Бутстрап приложения «Созвон»
import { $ } from './util.js';
import { state, notify, upsertServer, setUserOnline, getServer, applyNetConfig } from './state.js';
import { api, getToken, setToken } from './api.js';
import * as sock from './socket.js';
import { initAuth, showAuth, hideAuth } from './ui/auth.js';
import { initModals, initConfirm } from './ui/modals.js';
import { initServers } from './ui/servers.js';
import { initSidebar } from './ui/sidebar.js';
import { initChat } from './ui/chat.js';
import { initMembers } from './ui/members.js';
import { initStage } from './ui/voice-stage.js';
import { initMusicPlayer } from './ui/music-player.js';
import { toast } from './ui/toasts.js';
import { selectServer, selectChannel, restoreLast, revalidateSelection } from './nav.js';
import { openServerModal } from './ui/servers.js';
import { initVoiceSocket, resetVoice, joinVoice, leaveVoice } from './voice/voice.js';
import { rtc } from './voice/rtc.js';
import { music } from './music.js';
import { initPwa, maybeShowInstallHint } from './pwa.js';

window.__sozvon = { state, rtc, music, get socket() { return sock.getSocket(); } };

let started = false;
let firstBootstrap = true;
let rejoinChannel = null;

function initUi() {
  if (started) return;
  started = true;
  initModals();
  initConfirm();
  initServers();
  initSidebar();
  initChat(sock.on);
  initMembers();
  initStage();
  initMusicPlayer(sock.on);
  initVoiceSocket(sock.on);
  initSocketEvents();

  $('#btn-logout').addEventListener('click', logout);
  const app = $('#app');
  $('#btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !app.classList.contains('is-nav-open');
    app.classList.toggle('is-nav-open', open);
    $('#btn-menu').setAttribute('aria-expanded', String(open));
  });
  app.addEventListener('click', (e) => {
    // клик по затемнению (::after у .app) или по main закрывает выезжающее меню
    if (app.classList.contains('is-nav-open') && !e.target.closest('#btn-menu, #servers, #sidebar')) {
      app.classList.remove('is-nav-open');
      $('#btn-menu').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.classList.contains('is-nav-open') && !document.querySelector('dialog[open]')) {
      app.classList.remove('is-nav-open');
    }
  });
  window.addEventListener('beforeunload', () => { if (state.myVoice) rtc.stop(); });
}

function initSocketEvents() {
  sock.on('connect', onConnect);
  sock.on('disconnect', (reason) => {
    state.connected = false;
    notify('me');
    if (state.myVoice) {
      rejoinChannel = resetVoice()?.channelId || null;
      if (reason !== 'io client disconnect') toast('Связь с сервером потеряна — переподключаюсь…', 'error');
    }
  });
  sock.on('connect_error', (err) => {
    if (err?.message === 'unauthorized') {
      sock.disconnect();
      setToken(null);
      showAuth('Сессия истекла — войди снова');
    } else if (!state.user) {
      showAuth('Нет связи с сервером…');
    }
  });

  sock.on('server:updated', ({ server }) => {
    if (!server) return;
    upsertServer(server);
    revalidateSelection();
    notify('servers');
  });
  sock.on('server:removed', ({ serverId }) => {
    const srv = getServer(serverId);
    state.servers = state.servers.filter((s) => s.id !== serverId);
    for (const ch of srv?.channels || []) {
      delete state.messages[ch.id];
      delete state.voice[ch.id];
    }
    if (state.myVoice?.serverId === serverId) leaveVoice({ silent: true });
    if (srv && state.currentServerId === serverId) toast(`Сервер «${srv.name}» больше недоступен`, '');
    revalidateSelection();
    notify('servers');
  });
  sock.on('presence', ({ userId, online }) => {
    setUserOnline(userId, online);
    notify('presence');
  });
  sock.on('bot:status', ({ online }) => {
    state.botOnline = !!online;
    for (const s of state.servers) for (const m of s.members) if (m.isBot) m.online = !!online;
    notify('presence', 'music');
  });
}

async function onConnect() {
  state.connected = true;
  let res;
  try {
    res = await sock.emitAck('bootstrap');
  } catch (e) {
    toast(e.message);
    return;
  }
  const rejoin = rejoinChannel;
  rejoinChannel = null;
  state.user = res.user;
  state.servers = res.servers || [];
  state.voice = res.voice || {};
  state.music = {};
  for (const ms of Object.values(res.music || {})) music.setState(ms);
  // при переподключении историю перечитываем
  state.messages = {};
  state.hasMore = {};
  hideAuth();
  if (firstBootstrap) {
    firstBootstrap = false;
    const last = restoreLast();
    const invite = new URLSearchParams(location.search).get('invite');
    if (!invite) maybeShowInstallHint();
    selectServer(getServer(last) ? last : state.servers[0]?.id || null);
    if (invite) {
      history.replaceState(null, '', location.pathname);
      openServerModal('join');
      $('#invite-input').value = invite;
    }
  } else {
    revalidateSelection();
    // перечитать текущий канал
    const ch = state.currentChannelId;
    if (ch) selectChannel(ch);
  }
  notify('servers', 'nav', 'voice', 'me', 'presence', 'music', 'messages');
  if (rejoin) joinVoice(rejoin);
}

function start(token) {
  if (typeof window.io !== 'function') {
    // оболочка открыта из кэша PWA без сети: клиента Socket.IO нет — ждём сеть и перезагружаемся
    showAuth('Нет связи с сервером…');
    window.addEventListener('online', () => location.reload(), { once: true });
    return;
  }
  initUi();
  sock.disconnect();
  sock.connect(token);
}

function logout() {
  if (state.myVoice) leaveVoice({ silent: true });
  setToken(null);
  sock.disconnect();
  location.reload();
}

export function applyConfig(cfg) {
  if (!cfg) return;
  applyNetConfig(cfg);
  state.botOnline = !!cfg.botOnline;
}

async function boot() {
  initPwa();
  initAuth(start);
  try {
    const cfg = await api.config();
    applyConfig(cfg);
  } catch { /* сервер недоступен — сокет переподключится сам */ }
  const token = getToken();
  if (token) start(token);
  else showAuth();
}

boot();
