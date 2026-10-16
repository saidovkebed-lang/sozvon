// Управление голосовым подключением: join/leave, mute/deafen, экран, камера.
import { state, notify, getChannel, applyNetConfig } from '../state.js';
import { emit, emitAck, socketId } from '../socket.js';
import { rtc } from './rtc.js';
import { getMic, getScreen, getCamera, stopStream } from './media.js';
import { toast, toastError } from '../ui/toasts.js';
import { music } from '../music.js';
import { api } from '../api.js';

let joining = false;

function sendState() {
  if (!state.myVoice) return;
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
      mic = await getMic();
    } catch (e) {
      toast(`${e.message}. Ты подключишься только как слушатель.`, 'error', 6000);
    }
    let res;
    try {
      res = await emitAck('voice:join', { channelId });
    } catch (e) {
      stopStream(mic);
      throw e;
    }
    try {
      const cfg = await api.config();
      applyNetConfig(cfg);
    } catch { /* остаёмся на прежнем списке ICE */ }
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

export async function toggleScreen() {
  if (!state.myVoice) return;
  if (state.streaming) { stopScreen(); return; }
  try {
    const stream = await getScreen();
    if (!state.myVoice) { stopStream(stream); return; }
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      try { vt.contentHint = 'detail'; } catch { /* ignore */ }
      vt.addEventListener('ended', () => { if (rtc.local.screen === stream) stopScreen(); });
    }
    state.streaming = true;
    sendState();
    rtc.setLocalStream('screen', stream);
    notify('me', 'voice');
  } catch (e) {
    if (e.cancelled) toast(e.message, '', 2500); else toastError(e);
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

export function initVoiceSocket(on) {
  on('voice:members', ({ channelId, members }) => {
    state.voice[channelId] = members || [];
    if (state.myVoice?.channelId === channelId) {
      const ids = new Set(state.voice[channelId].map((m) => m.socketId));
      for (const id of Array.from(rtc.peers.keys())) if (!ids.has(id)) rtc.removePeer(id);
      // сервер выкинул нас из канала
      if (socketId() && !ids.has(socketId()) && !joining) resetVoice();
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
