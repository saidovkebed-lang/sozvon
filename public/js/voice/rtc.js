// WebRTC mesh: по RTCPeerConnection на каждого участника голосового канала.
// Perfect negotiation: новичок — impolite (инициатор), существующие участники — polite.

import { emit } from '../socket.js';
import { state } from '../state.js';
import { toast } from '../ui/toasts.js';
import { engine as audio } from '../audio/engine.js';
// Обработка микрофона, шумовой гейт («говорит»), громкость собеседников — в js/audio/engine.js.

class Peer {
  constructor(id, polite, mgr) {
    this.id = id;
    this.polite = polite;
    this.mgr = mgr;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.trackInfo = new Map();     // streamId -> 'screen' | 'camera'
    this.remote = { mic: null, screen: null, camera: null };
    this.senders = { screen: [], camera: [] };
    this.queue = Promise.resolve();
    this.closed = false;
    this.iceRestarts = 0;
    this.warned = false;

    const pc = new RTCPeerConnection({
      iceServers: mgr.iceServers,
      // FORCE_RELAY на сервере: только TURN (прячет IP, обходит строгие NAT/блокировки P2P)
      iceTransportPolicy: state.forceRelay ? 'relay' : 'all',
    });
    this.pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription.toJSON() });
      } catch (e) {
        console.warn('[rtc] negotiation', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ candidate: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        if (this.iceRestarts++ < 2) {
          try { pc.restartIce(); } catch { /* ignore */ }
        } else if (!this.warned) {
          this.warned = true;
          const name = this.mgr.peerName(this.id);
          toast(state.relay
            ? `Не удаётся соединиться с ${name}. Попробуйте перезайти в голосовой канал.`
            : `Не удаётся соединиться с ${name} напрямую — строгий NAT у кого-то из вас (часто мобильный интернет). Владельцу сервера: подключите TURN (README → «Если не слышно друга»).`,
          'error', 10000);
        }
      } else if (pc.connectionState === 'connected') {
        this.iceRestarts = 0;
        // сервер только ретранслирует voice:speaking — новичок не знает, что мы уже говорим
        if (mgr.localSpeaking && state.myVoice) emit('voice:speaking', { speaking: true });
      }
      mgr.changed();
    };
    pc.ontrack = (ev) => this.onTrack(ev);
  }

  send(data) {
    if (!this.closed) emit('voice:signal', { to: this.id, data });
  }

  get connected() { return this.pc.connectionState === 'connected'; }

  addLocalTracks() {
    const { mic, screen, camera } = this.mgr.local;
    if (mic && mic.getAudioTracks()[0]) {
      this.micSender = this.pc.addTrack(mic.getAudioTracks()[0], mic);
    } else if (!this.polite) {
      this.pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    if (screen) this.addStream('screen', screen);
    if (camera) this.addStream('camera', camera);
  }

  addStream(kind, stream) {
    this.removeStream(kind);
    if (this.pendingLocal) return; // добавится вместе с остальными после первого offer
    this.send({ trackInfo: { streamId: stream.id, kind } });
    this.senders[kind] = stream.getTracks().map((t) => this.pc.addTrack(t, stream));
  }

  removeStream(kind) {
    for (const s of this.senders[kind]) {
      try { this.pc.removeTrack(s); } catch { /* ignore */ }
    }
    this.senders[kind] = [];
  }

  onTrack({ track, streams }) {
    const stream = streams[0] || new MediaStream([track]);
    let kind = this.trackInfo.get(stream.id);
    if (!kind) kind = track.kind === 'audio' ? 'mic' : 'camera';
    this.remote[kind] = stream;
    const cleanup = () => {
      if (this.remote[kind] === stream && !stream.getTracks().some((t) => t.readyState === 'live')) {
        this.remote[kind] = null;
      }
      this.mgr.changed();
    };
    stream.onremovetrack = () => {
      if (stream.getTracks().length === 0 && this.remote[kind] === stream) this.remote[kind] = null;
      this.mgr.changed();
    };
    track.addEventListener('ended', cleanup);
    track.addEventListener('mute', () => this.mgr.changed());
    track.addEventListener('unmute', () => this.mgr.changed());
    this.mgr.changed();
  }

  handleSignal(data) {
    this.queue = this.queue.then(() => this.processSignal(data)).catch((e) => console.warn('[rtc] signal', e));
  }

  async processSignal({ description, candidate, trackInfo }) {
    const pc = this.pc;
    if (this.closed) return;
    if (trackInfo) {
      this.trackInfo.set(trackInfo.streamId, trackInfo.kind);
      return;
    }
    if (description) {
      const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      this.isSettingRemoteAnswerPending = description.type === 'answer';
      try {
        await pc.setRemoteDescription(description);
      } finally {
        this.isSettingRemoteAnswerPending = false;
      }
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription.toJSON() });
        if (this.pendingLocal) {
          // polite-сторона добавляет свои треки после первого ответа → чистая повторная negotiation
          this.pendingLocal = false;
          this.addLocalTracks();
        }
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        if (!this.ignoreOffer) console.warn('[rtc] candidate', e);
      }
    }
  }

  close() {
    this.closed = true;
    try { this.pc.close(); } catch { /* ignore */ }
  }
}

class RtcManager {
  constructor() {
    this.peers = new Map();
    this.local = { mic: null, screen: null, camera: null };
    this.iceServers = [];
    this.listeners = new Set();
    this.localSpeaking = false;
    // смена отправляемого трека (пересборка цепочки микрофона) → replaceTrack у всех пиров, без перезахода
    audio.onOutgoingTrack((track) => this.replaceMicTrack(track));
    audio.onGateChange(() => this.updateSpeaking());
  }

  get audioCtx() { return audio.outCtx; }

  onChange(fn) { this.listeners.add(fn); }

  changed() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => {
      this._pending = false;
      this.syncAudio();
      for (const fn of this.listeners) {
        try { fn(); } catch (e) { console.warn('[rtc] listener', e); }
      }
    });
  }

  /** Вызывать синхронно в обработчике клика (разблокирует AudioContext) */
  prepareAudio() {
    audio.unlock();
  }

  start({ iceServers, mic }) {
    // микрофон уже захвачен движком (audio/engine.js) — не освобождаем его здесь
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    for (const k of ['screen', 'camera']) {
      this.local[k]?.getTracks().forEach((t) => t.stop());
      this.local[k] = null;
    }
    this.iceServers = iceServers || [];
    this.local.mic = mic || null;
    this.applyMute();
    this.changed();
  }

  stop() {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    audio.releaseVoiceMic();
    this.local.mic = null;
    this.setLocalSpeaking(false);
    for (const k of ['screen', 'camera']) {
      this.local[k]?.getTracks().forEach((t) => t.stop());
      this.local[k] = null;
    }
    this.changed();
  }

  /** Новичок подключается к существующему участнику (impolite) */
  connect(socketId) {
    if (this.peers.has(socketId)) return this.peers.get(socketId);
    const p = new Peer(socketId, false, this);
    this.peers.set(socketId, p);
    p.addLocalTracks();
    this.changed();
    return p;
  }

  handleSignal(from, data) {
    if (!state.myVoice || !data) return;
    let p = this.peers.get(from);
    if (!p) {
      // первый сигнал от неизвестного → polite
      p = new Peer(from, true, this);
      this.peers.set(from, p);
      p.pendingLocal = true;
      p.handleSignal(data);
      this.changed();
      return;
    }
    p.handleSignal(data);
  }

  peerName(socketId) {
    const members = state.myVoice ? state.voice[state.myVoice.channelId] || [] : [];
    return members.find((m) => m.socketId === socketId)?.username || 'участником';
  }

  removePeer(socketId) {
    const p = this.peers.get(socketId);
    if (!p) return;
    p.close();
    this.peers.delete(socketId);
    this.changed();
  }

  setLocalStream(kind, stream) {
    const old = this.local[kind];
    if (old && old !== stream) old.getTracks().forEach((t) => t.stop());
    this.local[kind] = stream || null;
    for (const p of this.peers.values()) {
      if (stream) p.addStream(kind, stream); else p.removeStream(kind);
    }
    this.changed();
  }

  /** Новый отправляемый трек микрофона → replaceTrack у всех пиров (pc не пересоздаётся). */
  replaceMicTrack(track) {
    if (!track || !this.local.mic) return;
    if (this.local.mic.getAudioTracks()[0] === track) return;
    this.local.mic = new MediaStream([track]);
    for (const p of this.peers.values()) {
      if (p.micSender) p.micSender.replaceTrack(track).catch((e) => console.warn('[rtc] replaceTrack', e));
    }
    this.applyMute();
  }

  applyMute() {
    audio.setVoiceMuted(state.muted || state.deafened);
    this.updateSpeaking();
  }

  /** «Говорит» = гейт открыт (или зажата рация) и не muted/deafened. */
  updateSpeaking() {
    this.setLocalSpeaking(!!this.local.mic && !state.muted && !state.deafened && audio.voiceGateOpen);
  }

  /* ---------- удалённое аудио ---------- */
  syncAudio() {
    const list = [];
    for (const p of this.peers.values()) {
      for (const kind of ['mic', 'screen']) {
        const st = p.remote[kind];
        if (st && st.getAudioTracks().length) list.push({ socketId: p.id, kind, stream: st });
      }
    }
    audio.syncRemote(list);
  }

  setLocalSpeaking(v) {
    if (this.localSpeaking === v) return;
    this.localSpeaking = v;
    if (state.myVoice) emit('voice:speaking', { speaking: v });
    this.onLocalSpeaking?.(v);
  }
}

export const rtc = new RtcManager();
