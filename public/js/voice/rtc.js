// WebRTC mesh: по RTCPeerConnection на каждого участника голосового канала.
// Perfect negotiation: новичок — impolite (инициатор), существующие участники — polite.

import { emit } from '../socket.js';
import { state } from '../state.js';
import { toast } from '../ui/toasts.js';
import { engine as audio } from '../audio/engine.js';
import { prefs } from '../prefs.js';
// Обработка микрофона, шумовой гейт («говорит»), громкость собеседников — в js/audio/engine.js.

/**
 * Видео (трансляции и камера) — стартовый и минимальный битрейт в SDP (x-google-*, читает Chromium).
 * Без этого WebRTC стартует с ~300 кбит/с и разгоняется десятки секунд: всё это время трансляция
 * идёт «мылом» и в уменьшенном разрешении. Потолок задаёт applyEncodings (maxBitrate по качеству).
 */
export const VIDEO_START_KBPS = 2500;
export const VIDEO_MIN_KBPS = 600;
export function tuneVideoSdp(desc) {
  if (!desc?.sdp || !/m=video/.test(desc.sdp)) return desc;
  const out = [];
  let inVideo = false; let pts = new Set(); let fmtpSeen = new Set(); let section = [];
  const flush = () => {
    if (inVideo) {
      for (const pt of pts) {
        if (fmtpSeen.has(pt)) continue;
        // у VP8 строки fmtp обычно нет — добавляем сразу после rtpmap
        const i = section.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
        if (i >= 0) section.splice(i + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${VIDEO_START_KBPS};x-google-min-bitrate=${VIDEO_MIN_KBPS}`);
      }
    }
    out.push(...section);
    section = []; pts = new Set(); fmtpSeen = new Set();
  };
  const lines = desc.sdp.split(/\r\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('m=')) { flush(); inVideo = line.startsWith('m=video'); }
    if (inVideo) {
      const rm = line.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i);
      if (rm) pts.add(rm[1]);
      const fm = line.match(/^a=fmtp:(\d+) (.*)$/);
      if (fm && pts.has(fm[1])) {
        fmtpSeen.add(fm[1]);
        if (!/x-google-start-bitrate/.test(fm[2])) {
          section.push(`a=fmtp:${fm[1]} ${fm[2]};x-google-start-bitrate=${VIDEO_START_KBPS};x-google-min-bitrate=${VIDEO_MIN_KBPS}`);
          continue;
        }
      }
    }
    section.push(line);
  }
  flush();
  return { type: desc.type, sdp: out.join('\r\n') + '\r\n' };
}

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
    // Трансляция по запросу: стример шлёт видео/звук экрана только тем, кто нажал «Смотреть»
    this.screenWatched = false; // этот собеседник смотрит МОЮ трансляцию
    this.screenTracks = [];

    const pc = new RTCPeerConnection({
      iceServers: mgr.iceServers,
      // FORCE_RELAY на сервере: только TURN (прячет IP, обходит строгие NAT/блокировки P2P)
      iceTransportPolicy: state.forceRelay ? 'relay' : 'all',
      // Один сертификат DTLS на весь звонок: по его отпечатку считается код конфиденциальности
      ...(mgr.cert ? { certificates: [mgr.cert] } : {}),
    });
    this.pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription.toJSON() });
        this.applyEncodings();
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
        this.applyEncodings();
        // сервер только ретранслирует voice:speaking — новичок не знает, что мы уже говорим
        if (mgr.localSpeaking && state.myVoice) emit('voice:speaking', { speaking: true });
        // после переподключения напоминаем стримеру, что смотрим его трансляцию
        if (mgr.watching.has(this.id)) this.send({ watch: true });
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
    if (kind === 'screen') {
      this.preferH264();
      this.screenTracks = stream.getTracks();
      // не смотрит — ничего не кодируем и не отправляем (без пересогласования соединения)
      if (!this.screenWatched) for (const s of this.senders.screen) s.replaceTrack(null).catch(() => {});
      this.applyEncodings();
    }
  }

  /**
   * Демонстрация экрана — предпочесть H.264: его кодирует видеокарта (NVENC/Quick Sync/AMF),
   * а VP8 по умолчанию кодируется процессором. Если H.264 недоступен — остаётся как было.
   */
  preferH264() {
    try {
      const caps = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
      const h264 = caps.filter((c) => /h264/i.test(c.mimeType));
      if (!h264.length) return;
      // сначала профиль с packetization-mode=1 (совместимый), затем остальные H.264, затем прочие кодеки
      h264.sort((a, b) => /packetization-mode=1/.test(b.sdpFmtpLine || '') - /packetization-mode=1/.test(a.sdpFmtpLine || ''));
      const rest = caps.filter((c) => !/h264/i.test(c.mimeType));
      for (const s of this.senders.screen) {
        if (s.track?.kind !== 'video') continue;
        const t = this.pc.getTransceivers().find((x) => x.sender === s);
        t?.setCodecPreferences?.([...h264, ...rest]);
      }
    } catch (e) { console.warn('[rtc] H.264', e); }
  }

  /** Собеседник начал/перестал смотреть мою трансляцию */
  setScreenWatched(on) {
    this.screenWatched = !!on;
    this.senders.screen.forEach((s, i) => {
      s.replaceTrack(on ? this.screenTracks[i] || null : null).catch((e) => console.warn('[rtc] replaceTrack', e));
    });
    if (on) this.applyEncodings();
    this.mgr.screenViewersChanged();
  }

  /** v3 §2.4: битрейт/частота кадров демонстрации (RTCRtpSender.setParameters) */
  applyEncodings() {
    const want = this.mgr.screenParams;
    if (!want) return;
    for (const sender of this.senders.screen) {
      if (sender.track?.kind !== 'video') continue;
      let p;
      try { p = sender.getParameters(); } catch { continue; }
      if (!p.encodings || !p.encodings.length) continue; // до negotiation encodings пусты — применим позже
      const e = p.encodings[0];
      if (e.maxBitrate === want.maxBitrate && e.maxFramerate === want.maxFramerate) continue;
      e.maxBitrate = want.maxBitrate;
      e.maxFramerate = want.maxFramerate;
      if (want.degradation) p.degradationPreference = want.degradation;
      sender.setParameters(p).catch((err) => {
        // degradationPreference поддерживается не везде — повтор без него
        if (p.degradationPreference) {
          delete p.degradationPreference;
          sender.setParameters(p).catch((e2) => console.warn('[rtc] setParameters', e2));
        } else console.warn('[rtc] setParameters', err);
      });
    }
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
    if (kind === 'screen' && prefs.get('stream.autoWatch') && !this.mgr.watching.has(this.id)) this.mgr.setWatching(this.id, true);
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

  async processSignal({ description, candidate, trackInfo, watch }) {
    const pc = this.pc;
    if (this.closed) return;
    if (typeof watch === 'boolean') {
      this.setScreenWatched(watch);
      return;
    }
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
        await pc.setRemoteDescription(tuneVideoSdp(description));
      } finally {
        this.isSettingRemoteAnswerPending = false;
      }
      if (description.type === 'answer') this.applyEncodings();
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription.toJSON() });
        this.applyEncodings();
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
    this.watching = new Set(); // socketId стримеров, чью трансляцию я смотрю
    this.peers = new Map();
    this.local = { mic: null, screen: null, camera: null };
    this.iceServers = [];
    this.listeners = new Set();
    this.localSpeaking = false;
    this.screenParams = null;   // { maxBitrate, maxFramerate, degradation } — качество демонстрации
    this.lastViewers = 0;
    this.onScreenViewers = null; // (n) => void — число зрителей моей трансляции изменилось
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

  /** Сертификат DTLS (ECDSA P-256) — один на сессию; ждём его перед первым соединением */
  async ensureCert() {
    if (this.cert && this.cert.expires > Date.now() + 3600e3) return this.cert;
    try {
      this.cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    } catch (e) {
      console.warn('[rtc] сертификат', e);
      this.cert = null;
    }
    return this.cert;
  }

  /**
   * Код конфиденциальности звонка (как «Voice Privacy Code» в Discord).
   * Голос шифруется DTLS-SRTP сквозным образом: ключи согласуют сами браузеры, сервер и TURN
   * видят только шифротекст. Подменить ключи мог бы лишь сигнальный сервер, подставив свои
   * отпечатки сертификатов — тогда коды у участников разойдутся. Совпали у всех → подмены нет.
   * Возвращает { code: '12345 67890 …', peers } или null, пока не все соединения установлены.
   */
  async privacyCode() {
    if (!this.cert) return null;
    const fps = new Set();
    const own = this.cert.getFingerprints?.().find((f) => f.algorithm === 'sha-256')?.value;
    if (!own) return null;
    fps.add(own.toUpperCase());
    let peers = 0;
    for (const p of this.peers.values()) {
      const sdp = p.pc.remoteDescription?.sdp || '';
      const m = sdp.match(/a=fingerprint:sha-256 ([0-9A-F:]+)/i);
      if (!m || !p.connected) return null;
      fps.add(m[1].toUpperCase());
      peers += 1;
    }
    const key = [...fps].sort().join('|');
    if (this.codeCache?.key === key) return this.codeCache.value;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    const groups = [];
    for (let i = 0; i < 12; i += 2) groups.push(String(((hash[i] << 8) | hash[i + 1]) % 100000).padStart(5, '0'));
    const value = { code: groups.join(' '), peers };
    this.codeCache = { key, value };
    return value;
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
    this.watching.clear();
    this.local.mic = mic || null;
    this.applyMute();
    this.changed();
  }

  stop() {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.watching.clear();
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

  /** Зритель: смотреть / выйти из трансляции участника */
  setWatching(socketId, on) {
    if (on) this.watching.add(socketId); else this.watching.delete(socketId);
    this.peers.get(socketId)?.send({ watch: !!on });
    this.changed();
  }

  isWatching(socketId) { return this.watching.has(socketId); }

  /** Сколько собеседников смотрит мою трансляцию */
  screenViewers() {
    let n = 0;
    for (const p of this.peers.values()) if (p.screenWatched && !p.closed) n++;
    return n;
  }

  screenViewersChanged() {
    const n = this.screenViewers();
    if (n === this.lastViewers) return;
    this.lastViewers = n;
    try { this.onScreenViewers?.(n); } catch (e) { console.error(e); }
  }

  removePeer(socketId) {
    this.watching.delete(socketId);
    const p = this.peers.get(socketId);
    if (!p) return;
    p.close();
    this.peers.delete(socketId);
    this.screenViewersChanged();
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

  /** Задать качество демонстрации для всех текущих и будущих пиров */
  setScreenParams(params) {
    this.screenParams = params || null;
    for (const p of this.peers.values()) p.applyEncodings();
  }

  /** Отладка (qa): encodings[0] всех видеосендеров демонстрации */
  screenEncodings() {
    const out = [];
    for (const p of this.peers.values()) {
      for (const s of p.senders.screen) {
        if (s.track?.kind !== 'video') continue;
        try { out.push({ peer: p.id, ...(s.getParameters().encodings?.[0] || {}) }); } catch { /* ignore */ }
      }
    }
    return out;
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
    audio.setVoiceMuted(state.muted || state.deafened || state.serverMuted || state.serverDeafened);
    this.updateSpeaking();
  }

  /** «Говорит» = гейт открыт (или зажата рация) и не muted/deafened. */
  updateSpeaking() {
    this.setLocalSpeaking(!!this.local.mic && !state.muted && !state.deafened && !state.serverMuted && !state.serverDeafened && audio.voiceGateOpen);
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
