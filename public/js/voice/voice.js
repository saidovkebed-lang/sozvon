// Управление голосовым подключением: join/leave, mute/deafen, экран, камера.
import { state, notify, getChannel, applyNetConfig } from '../state.js';
import { emit, emitAck, socketId } from '../socket.js';
import { rtc } from './rtc.js';
import { getScreen, getCamera, stopStream } from './media.js';
import { engine as audio } from '../audio/engine.js';
import { toast, toastError } from '../ui/toasts.js';
import { music } from '../music.js';
import { api } from '../api.js';
import { prefs } from '../prefs.js';

/** Качество демонстрации (SPEC-v3 §2.4) */
export const STREAM_QUALITY = {
  '720p30': { label: '720p 30', video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } }, maxBitrate: 2_500_000, maxFramerate: 30, hint: 'detail' },
  '1080p60': { label: '1080p 60', video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 } }, maxBitrate: 6_000_000, maxFramerate: 60, hint: 'motion' },
  source: { label: 'Исходное', video: { frameRate: { ideal: 60, max: 60 } }, maxBitrate: 8_000_000, maxFramerate: 60, hint: 'detail' },
};

function screenParams(q) {
  const Q = STREAM_QUALITY[q] || STREAM_QUALITY['720p30'];
  return { maxBitrate: Q.maxBitrate, maxFramerate: Q.maxFramerate, degradation: Q.maxFramerate >= 60 ? 'maintain-framerate' : 'maintain-resolution' };
}

let joining = false;

function sendState() {
  if (!state.myVoice) return;
  window.sozvonDesktop?.setVoiceState?.({ inVoice: true, muted: !!(state.muted || state.deafened), deafened: !!state.deafened });
  emit('voice:state', {
    muted: state.muted || state.deafened,
    deafened: state.deafened,
    streaming: state.streaming,
    camera: state.camera,
  });
}

export async function joinVoice(channelId) {
  if (joining) return;
  if (state.myVoice?.channelId === channelId) return;
  const ch = getChannel(channelId);
  if (!ch || ch.type !== 'voice') return;
  joining = true;
  // синхронно в жесте пользователя: разблокировать звук
  rtc.prepareAudio();
  music.unlock();
  try {
    if (state.myVoice) await leaveVoice({ silent: true });
    let mic = null;
    try {
      // getUserMedia → [RNNoise] → громкость → гейт → отправляемый трек (настройки из prefs)
      mic = await audio.acquireVoiceMic();
    } catch (e) {
      toast(`${e.message}. Ты подключишься только как слушатель.`, 'error', 6000);
    }
    let res;
    try {
      res = await emitAck('voice:join', { channelId });
    } catch (e) {
      audio.releaseVoiceMic();
      throw e;
    }
    try {
      const cfg = await api.config();
      applyNetConfig(cfg);
    } catch { /* остаёмся на прежнем списке ICE */ }
    await rtc.ensureCert();
    state.myVoice = { channelId, serverId: ch.serverId };
    state.streaming = false;
    state.camera = false;
    state.speaking.clear();
    rtc.start({ iceServers: state.iceServers, mic });
    for (const peer of res.peers || []) {
      if (!peer.isBot && peer.socketId !== socketId()) rtc.connect(peer.socketId);
    }
    sendState();
    if (res.music) music.setState(res.music);
    notify('voice', 'me', 'music');
  } catch (e) {
    toastError(e);
  } finally {
    joining = false;
  }
}

export async function leaveVoice({ silent = false } = {}) {
  if (!state.myVoice) return;
  state.myVoice = null;
  state.serverMuted = false;
  state.serverDeafened = false;
  window.sozvonDesktop?.setVoiceState?.({ inVoice: false, muted: !!state.muted, deafened: !!state.deafened });
  state.streaming = false;
  state.camera = false;
  state.speaking.clear();
  rtc.stop();
  music.refresh();
  notify('voice', 'me', 'music');
  try {
    await emitAck('voice:leave');
  } catch (e) {
    if (!silent) toastError(e);
  }
}

/** Сброс после разрыва сокета (сервер уже убрал нас из голоса) */
export function resetVoice() {
  const was = state.myVoice;
  state.myVoice = null;
  state.serverMuted = false;
  state.serverDeafened = false;
  window.sozvonDesktop?.setVoiceState?.({ inVoice: false, muted: !!state.muted, deafened: !!state.deafened });
  state.streaming = false;
  state.camera = false;
  state.speaking.clear();
  rtc.stop();
  music.refresh();
  notify('voice', 'me', 'music');
  return was;
}

export function toggleMute() {
  if (state.deafened) {
    // снять mute при deafen = снять и deafen
    state.deafened = false;
    state.muted = false;
  } else {
    state.muted = !state.muted;
  }
  applyAudio();
}

let mutedBeforeDeafen = false;
export function toggleDeafen() {
  if (state.deafened) {
    state.deafened = false;
    state.muted = mutedBeforeDeafen;
  } else {
    mutedBeforeDeafen = state.muted;
    state.deafened = true;
    state.muted = true;
  }
  applyAudio();
}

function applyAudio() {
  rtc.applyMute();
  rtc.syncAudio();
  music.refresh();
  sendState();
  notify('me', 'voice');
}

/** Кнопка «Демонстрация»: идёт стрим — остановить, иначе окно выбора качества/источника (ui/stream.js) */
export async function toggleScreen() {
  if (!state.myVoice) return;
  if (state.streaming) { stopScreen(); return; }
  const { openStreamModal } = await import('../ui/stream.js');
  openStreamModal();
}

/**
 * Начать демонстрацию: quality '720p30'|'1080p60'|'source', audio — звук экрана,
 * sourceId — выбранный источник в приложении для ПК (мост window.sozvonDesktop).
 */
export async function startScreen({ quality = prefs.get('stream.quality'), audio: withAudio = prefs.get('stream.audio'), sourceId = null } = {}) {
  if (!state.myVoice || state.streaming) return false;
  const Q = STREAM_QUALITY[quality] || STREAM_QUALITY['720p30'];
  try {
    const D = window.sozvonDesktop;
    if (sourceId && D?.selectScreenSource) {
      const ok = await D.selectScreenSource(sourceId, { audio: !!withAudio });
      if (ok === false) { toast('Не удалось выбрать источник — попробуйте ещё раз'); return false; }
    }
    const stream = await getScreen({ video: Q.video, audio: !!withAudio });
    if (!state.myVoice) { stopStream(stream); return false; }
    if (stream.audioFallback) toast('Звук экрана недоступен на этом компьютере — трансляция идёт без звука. Совет: показывайте отдельное окно или вкладку браузера со звуком.', '', 7000);
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      try { vt.contentHint = Q.hint; } catch { /* ignore */ }
      vt.addEventListener('ended', () => { if (rtc.local.screen === stream) stopScreen(); });
    }
    state.streaming = true;
    state.streamQuality = quality;
    rtc.setScreenParams(screenParams(quality));
    sendState();
    rtc.setLocalStream('screen', stream);
    notify('me', 'voice');
    return true;
  } catch (e) {
    if (e.cancelled) toast(e.message, '', 2500); else toastError(e);
    return false;
  }
}

/** Сменить качество идущей демонстрации на лету */
export async function setStreamQuality(quality) {
  const Q = STREAM_QUALITY[quality];
  if (!Q) return;
  state.streamQuality = quality;
  rtc.setScreenParams(screenParams(quality));
  const vt = rtc.local.screen?.getVideoTracks()[0];
  if (vt) {
    try { vt.contentHint = Q.hint; } catch { /* ignore */ }
    try { await vt.applyConstraints(Q.video); } catch { /* браузер может не уметь — битрейт уже применён */ }
  }
}

export function stopScreen() {
  if (!state.streaming && !rtc.local.screen) return;
  state.streaming = false;
  rtc.setLocalStream('screen', null);
  sendState();
  notify('me', 'voice');
}

export async function toggleCamera() {
  if (!state.myVoice) return;
  if (state.camera) { stopCamera(); return; }
  try {
    const stream = await getCamera();
    if (!state.myVoice) { stopStream(stream); return; }
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (rtc.local.camera === stream) stopCamera(); });
    state.camera = true;
    sendState();
    rtc.setLocalStream('camera', stream);
    notify('me', 'voice');
  } catch (e) {
    toastError(e);
  }
}

export function stopCamera() {
  if (!state.camera && !rtc.local.camera) return;
  state.camera = false;
  rtc.setLocalStream('camera', null);
  sendState();
  notify('me', 'voice');
}

function syncServerVoice() {
  const ch = state.myVoice?.channelId;
  const me = ch ? (state.voice[ch] || []).find((m) => m.socketId === socketId()) : null;
  const sm = !!me?.serverMute;
  const sd = !!me?.serverDeafen;
  if (sm !== state.serverMuted || sd !== state.serverDeafened) {
    const was = state.serverMuted || state.serverDeafened;
    state.serverMuted = sm;
    state.serverDeafened = sd;
    rtc.applyMute();
    rtc.syncAudio();
    music.refresh();
    if (sm || sd) toast(sd ? 'Модератор отключил вам звук на сервере' : 'Модератор отключил вам микрофон на сервере', '', 4000);
    else if (was) toast('Модератор вернул вам микрофон и звук', 'ok', 3000);
    notify('me');
  }
}

export function initVoiceSocket(on) {
  on('voice:moved', ({ channelId } = {}) => {
    if (!channelId) {
      if (state.myVoice) { resetVoice(); emit('voice:leave'); toast('Модератор отключил вас от голосового канала', '', 4000); }
      return;
    }
    const ch = getChannel(channelId);
    if (!ch) return;
    toast(`Вас переместили в «${ch.name}»`, '', 3500);
    resetVoice();
    joinVoice(channelId);
  });
  on('voice:members', ({ channelId, members }) => {
    state.voice[channelId] = members || [];
    if (state.myVoice?.channelId === channelId) {
      const ids = new Set(state.voice[channelId].map((m) => m.socketId));
      for (const id of Array.from(rtc.peers.keys())) if (!ids.has(id)) rtc.removePeer(id);
      // сервер выкинул нас из канала
      if (socketId() && !ids.has(socketId()) && !joining) resetVoice();
      syncServerVoice();
    }
    notify('voice');
  });
  on('voice:peer-joined', () => { notify('voice'); });
  on('voice:peer-left', ({ socketId: id }) => {
    rtc.removePeer(id);
    state.speaking.delete(id);
    notify('voice');
  });
  on('voice:signal', ({ from, data }) => rtc.handleSignal(from, data));
  on('voice:speaking', ({ socketId: id, speaking }) => {
    if (speaking) state.speaking.add(id); else state.speaking.delete(id);
    notify('speaking');
  });
  rtc.onLocalSpeaking = (v) => {
    const me = socketId();
    if (!me) return;
    if (v) state.speaking.add(me); else state.speaking.delete(me);
    notify('speaking');
  };
}
