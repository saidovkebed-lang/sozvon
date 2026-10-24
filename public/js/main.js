// Бутстрап приложения «Astra»
import { $, initAvatarHover } from './util.js';
import { state, notify, upsertServer, setUserOnline, getServer, applyNetConfig, applyUserUpdate } from './state.js';
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
import { initWatch } from './ui/watch.js';
import { toast } from './ui/toasts.js';
import { selectServer, selectChannel, restoreLast, revalidateSelection, reportView, initReadTracking } from './nav.js';
import { initDms } from './ui/dms.js';
import { initInbox } from './ui/inbox.js';
import { initPush, syncPushSubscription, disablePush } from './push.js';
import { openServerModal } from './ui/servers.js';
import { initVoiceSocket, resetVoice, joinVoice, leaveVoice } from './voice/voice.js';
import { rtc } from './voice/rtc.js';
import { music } from './music.js';
import { initPwa, maybeShowInstallHint } from './pwa.js';
import { initAppearance } from './ui/appearance.js';
import { initSounds } from './ui/sounds.js';
import { initNotifications } from './ui/notifications.js';
import { initKeybinds } from './ui/keybinds.js';
import { initUserSettings, closeUserSettings } from './ui/user-settings.js';
import { initContextMenu, closeMenu } from './ui/context-menu.js';
import { initServerSettings } from './ui/server-settings.js';
import { initModActions } from './ui/mod-actions.js';
import { initProfile, closeProfile } from './ui/profile.js';
import { initPing, measureNow } from './ping.js';
import { initStream } from './ui/stream.js';
import { initDesktop } from './desktop.js';
import { initAuthDownload } from './download.js';
import { setDndCheck } from './ui/sounds.js';
import { toggleMute, toggleDeafen } from './voice/voice.js';
import { audioEngine } from './audio/engine.js';
import * as perms from './perms.js';

// тема/масштаб уже выставлены /js/theme-boot.js до отрисовки; дальше — по подписке на prefs
initAppearance();

window.__sozvon = Object.assign(window.__sozvon || {}, { state, rtc, music, perms });
Object.defineProperty(window.__sozvon, 'socket', { get: () => sock.getSocket(), configurable: true });

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
  initWatch(sock.on);
  initVoiceSocket(sock.on);
  initSounds();
  initNotifications(sock.on);
  initKeybinds();
  initUserSettings({ logout });
  initContextMenu();
  initServerSettings();
  initModActions();
  initProfile();
  initPing();
  initStream();
  initAvatarHover();
  setDndCheck(() => state.user?.status === 'dnd');
  initDesktop({ toggleMute, toggleDeafen, setPttPressed: (p) => audioEngine.setPttPressed(p) });
  initDms(sock.on);
  initInbox(sock.on);
  initPush();
  initReadTracking();
  initSocketEvents();
  // клик по push-уведомлению, когда Astra уже открыт: service worker просит открыть чат
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'sozvon:open' && typeof e.data.channelId === 'string') openFromLink(e.data.channelId);
  });

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

/** Открыть канал/ЛС по ссылке из уведомления (?c=…), если он доступен */
function openFromLink(channelId) {
  if (!channelId) return false;
  const known = state.servers.some((s) => s.channels.some((c) => c.id === channelId)) || state.dms.some((d) => d.id === channelId);
  if (!known) return false;
  selectChannel(channelId);
  return true;
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
    // Сервер сам закрыл соединение (например, пароль сменили в другой вкладке): socket.io в этом случае
    // не переподключается — делаем это сами; при отозванной сессии придёт connect_error 'unauthorized'
    // и откроется экран входа, иначе просто восстановится связь.
    if (reason === 'io server disconnect') setTimeout(() => { if (!sock.connected) sock.connect(); }, 300);
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
  sock.on('server:removed', ({ serverId, reason }) => {
    const srv = getServer(serverId);
    state.servers = state.servers.filter((s) => s.id !== serverId);
    for (const ch of srv?.channels || []) {
      delete state.messages[ch.id];
      delete state.voice[ch.id];
    }
    if (state.myVoice?.serverId === serverId) leaveVoice({ silent: true });
    if (srv && reason === 'ban') toast(`Вас забанили на сервере «${srv.name}»`, 'error', 7000);
    else if (srv && reason === 'kick') toast(`Вас выгнали с сервера «${srv.name}»`, 'error', 7000);
    else if (srv && state.currentServerId === serverId) toast(`Сервер «${srv.name}» больше недоступен`, '');
    revalidateSelection();
    notify('servers');
  });
  sock.on('user:updated', ({ user } = {}) => { applyUserUpdate(user); });
  sock.on('presence', ({ userId, online, status }) => {
    setUserOnline(userId, online, status);
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
  state.dms = res.dms || [];
  state.notifications = res.notifications || [];
  state.pushKey = res.pushKey || null;
  state.voice = res.voice || {};
  state.music = {};
  for (const ms of Object.values(res.music || {})) music.setState(ms);
  // при переподключении историю перечитываем
  state.messages = {};
  state.hasMore = {};
  hideAuth();
  measureNow();
  if (firstBootstrap) {
    firstBootstrap = false;
    const last = restoreLast();
    const params = new URLSearchParams(location.search);
    const invite = params.get('invite');
    const link = params.get('c');
    if (link) history.replaceState(null, '', location.pathname);
    if (!invite) maybeShowInstallHint();
    if (!openFromLink(link)) selectServer(getServer(last) ? last : (last === null && state.lastDm ? null : state.servers[0]?.id || null), { auto: true });
    if (invite) {
      history.replaceState(null, '', location.pathname);
      openServerModal('join');
      $('#invite-input').value = invite;
    }
  } else {
    revalidateSelection();
    // перечитать текущий канал
    const ch = state.currentChannelId;
    if (ch) selectChannel(ch, { auto: true });
  }
  reportView();
  syncPushSubscription();
  notify('servers', 'nav', 'voice', 'me', 'presence', 'music', 'messages', 'dms', 'inbox');
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

async function logout() {
  await disablePush({ silent: true }).catch(() => {}); // уведомления этого аккаунта на устройство больше не нужны
  closeMenu(false);
  closeProfile(false);
  closeUserSettings();
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
  initAuthDownload($('#btn-download-app'));
  try {
    const cfg = await api.config();
    applyConfig(cfg);
  } catch { /* сервер недоступен — сокет переподключится сам */ }
  const token = getToken();
  if (token) start(token);
  else showAuth();
}

boot();
