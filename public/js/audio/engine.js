// Звуковой движок «Astra» (docs/SPEC-v2.md §2).
//  - вывод: каждый удалённый поток → MediaStreamSource → GainNode(userVolume×outputVolume) → шина → выход;
//    элементы <audio class="remote-audio"> остаются (muted): Chromium не «прокачивает» удалённый
//    WebRTC-поток в WebAudio, пока поток не привязан к медиа-элементу. Если WebAudio не работает
//    (контекст не запущен) — звук идёт через сами элементы (громкость ≤100 %).
//  - ввод: MicChain (RNNoise / браузерное шумоподавление / гейт / рация), см. mic-chain.js.
//  - настройки читаются только из prefs (подписка), UI вызывает лишь публичный API ниже.

import { prefs } from '../prefs.js';
import { state, subscribe as subscribeState } from '../state.js';
import { toast } from '../ui/toasts.js';
import { MediaError, explainMediaError, ensureMediaApi } from '../voice/media.js';
import { MicChain } from './mic-chain.js';
import { rnnoiseSupported, isRnnoiseLoaded } from './rnnoise.js';

const MIC_RATE = 48000; // RNNoise рассчитан на 48 кГц (кадр 480 сэмплов = 10 мс)
const hasCtxSink = () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const hasElSink = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

function isTypingTarget(t) {
  if (!t || t === window || t === document) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
  }
  return false;
}

class AudioEngine {
  constructor() {
    this.outCtx = null;
    this.micCtx = null;
    this.outBus = null;          // общая шина вывода → destination | элемент с setSinkId
    this.sinkEl = null;
    this.sinkDest = null;
    this.streamMuted = new Set(); // socketId: звук трансляции этого участника выключен у меня
    this.remotes = new Map();    // `${socketId}|${kind}` → { el, stream, socketId, kind, src, gain, target }
    this.voiceChain = null;
    this.voiceMuted = false;
    this.trackListeners = new Set();
    this.gateListeners = new Set();
    this.deviceListeners = new Set();
    this.tests = new Set();
    this.pttKeyDown = false;
    this.pttButton = false;
    this.pttActive = false;
    this.pttTimer = null;
    this.rnnoiseWarned = false;
    this.deviceWarned = false;
    this.permissionSeen = false;
    this.bound = false;
  }

  /* ================= контексты ================= */

  /** Создать/разбудить AudioContext'ы. Вызывать синхронно в обработчике жеста пользователя. */
  unlock() {
    this.bind();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!this.outCtx) {
        this.outCtx = new AC({ latencyHint: 'interactive' });
        this.outBus = this.outCtx.createGain();
        this.outBus.connect(this.outCtx.destination);
        this.outCtx.addEventListener?.('statechange', () => this.syncRemote());
        this.applySink();
      }
      if (this.outCtx.state !== 'running') this.outCtx.resume().catch(() => {});
    } catch (e) { console.warn('[audio] AudioContext вывода', e); }
    this.micContext();
  }

  micContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this.micCtx) {
      try {
        this.micCtx = new AC({ sampleRate: MIC_RATE, latencyHint: 'interactive' });
      } catch {
        try { this.micCtx = new AC({ latencyHint: 'interactive' }); } catch (e) { console.warn('[audio] AudioContext микрофона', e); }
      }
    }
    if (this.micCtx && this.micCtx.state !== 'running') this.micCtx.resume().catch(() => {});
    return this.micCtx;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    prefs.subscribe('audio.', (key) => this.onPref(key));
    subscribeState(['voice'], () => this.updateGains());
    // keydown — во всплытии: захват клавиши в настройках (ui) гасит событие в capture-фазе на window;
    // keyup — в capture, чтобы отпускание никогда не терялось (иначе рация «залипнет»)
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => { if (this.pttKeyDown) { this.pttKeyDown = false; this.updatePtt(); } });
    // контекст мог остаться «suspended» (вход без жеста) — разбудим при первом же жесте
    const wake = () => {
      for (const c of [this.outCtx, this.micCtx]) if (c && c.state !== 'running' && c.state !== 'closed') c.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', () => this.emitDevices());
    } catch { /* ignore */ }
  }

  onPref(key) {
    if (key === 'audio.outputVolume' || key === 'audio.userVolumes' || key === 'audio.userMuted' || key === 'audio.streamVolumes') {
      this.updateGains();
      for (const t of this.tests) t.updateLoopGain?.();
    } else if (key === 'audio.outputDeviceId') {
      this.applySink();
    } else if (key === 'audio.inputMode' || key === 'audio.pttKey') {
      this.pttKeyDown = false;
      this.updatePtt(true);
    }
  }

  /* ================= вывод: громкость собеседников ================= */

  userIdOf(socketId) {
    const ch = state.myVoice?.channelId;
    const m = ch ? (state.voice[ch] || []).find((x) => x.socketId === socketId) : null;
    return m?.userId || null;
  }

  /** Итоговый коэффициент для пользователя: userVolume × outputVolume / 10000; userMuted/deafen → 0. */
  computeGain(userId) {
    if (state.deafened || state.serverDeafened) return 0;
    if (userId && prefs.isUserMuted(userId)) return 0;
    const uv = userId ? prefs.getUserVolume(userId) : 100;
    const ov = Number(prefs.get('audio.outputVolume'));
    return Math.max(0, (uv * (Number.isFinite(ov) ? ov : 100)) / 10000);
  }

  /** Звук трансляции: своя громкость стримера (0..200 %) × общая громкость; deafen → 0. Голос человека не влияет. */
  computeStreamGain(userId) {
    if (state.deafened || state.serverDeafened) return 0;
    const sv = userId ? prefs.getStreamVolume(userId) : 100;
    const ov = Number(prefs.get('audio.outputVolume'));
    return Math.max(0, (sv * (Number.isFinite(ov) ? ov : 100)) / 10000);
  }

  getUserGain(userId) {
    for (const r of this.remotes.values()) {
      if (r.gain && this.userIdOf(r.socketId) === userId) return r.target;
    }
    return this.computeGain(userId);
  }

  /**
   * Отладка/QA: пиковая амплитуда (0..∞) звука собеседника ПОСЛЕ его GainNode — то, что реально уходит
   * в динамики. Статистика inbound-rtp audioLevel при выводе через WebAudio всегда 0 (Chromium считает её
   * по громкости элемента <audio>, а он заглушён), поэтому для проверок «звук идёт» — этот метод.
   */
  getUserLevel(userId) {
    let peak = 0;
    for (const r of this.remotes.values()) {
      if (!r.gain || this.userIdOf(r.socketId) !== userId) continue;
      if (!r.analyser) {
        r.analyser = this.outCtx.createAnalyser();
        r.analyser.fftSize = 2048;
        r.gain.connect(r.analyser);
        r.buf = new Float32Array(r.analyser.fftSize);
      }
      r.analyser.getFloatTimeDomainData(r.buf);
      for (let i = 0; i < r.buf.length; i++) peak = Math.max(peak, Math.abs(r.buf[i]));
    }
    return peak;
  }

  get webAudioOut() { return !!(this.outCtx && this.outBus && this.outCtx.state === 'running'); }

  /**
   * Синхронизировать удалённые потоки. list: [{ socketId, kind: 'mic'|'screen', stream }]
   * Без аргумента — пересчитать маршрутизацию уже известных потоков.
   */
  syncRemote(list) {
    const box = document.getElementById('remote-audio');
    if (list) {
      const want = new Map(list.map((w) => [`${w.socketId}|${w.kind}`, w]));
      for (const [key, r] of this.remotes) {
        const w = want.get(key);
        if (!w || w.stream !== r.stream) this.dropRemote(key);
        else want.delete(key);
      }
      for (const [key, w] of want) {
        const el = document.createElement('audio');
        el.className = 'remote-audio';
        el.autoplay = true;
        el.muted = true;
        el.dataset.socketId = w.socketId;
        el.dataset.kind = w.kind;
        el.srcObject = w.stream;
        box?.append(el);
        this.remotes.set(key, { el, stream: w.stream, socketId: w.socketId, kind: w.kind, src: null, gain: null, target: 1 });
      }
    }
    for (const r of this.remotes.values()) {
      if (this.webAudioOut && !r.src) {
        try {
          r.src = this.outCtx.createMediaStreamSource(r.stream);
          r.gain = this.outCtx.createGain();
          r.src.connect(r.gain).connect(this.outBus);
        } catch (e) {
          console.warn('[audio] удалённый поток мимо WebAudio', e);
          r.src = null; r.gain = null;
        }
      }
      if (r.el.paused) r.el.play().catch(() => { /* разблокируется жестом */ });
    }
    this.updateGains();
  }

  dropRemote(key) {
    const r = this.remotes.get(key);
    if (!r) return;
    try { r.src?.disconnect(); r.gain?.disconnect(); r.analyser?.disconnect(); } catch { /* ignore */ }
    r.el.srcObject = null;
    r.el.remove();
    this.remotes.delete(key);
  }

  updateGains() {
    const routed = this.webAudioOut;
    for (const r of this.remotes.values()) {
      const uid = this.userIdOf(r.socketId);
      const g = r.kind === 'screen'
        ? (this.streamMuted.has(r.socketId) ? 0 : this.computeStreamGain(uid))
        : this.computeGain(uid);
      r.target = g;
      if (routed && r.gain) {
        r.gain.gain.cancelScheduledValues(this.outCtx.currentTime);
        r.gain.gain.setValueAtTime(r.gain.gain.value, this.outCtx.currentTime);
        r.gain.gain.linearRampToValueAtTime(g, this.outCtx.currentTime + 0.03);
        r.el.muted = true; // звук идёт через WebAudio, элемент только «держит» поток
      } else {
        // фолбэк: сам элемент (≤100 %)
        r.el.volume = Math.min(1, g);
        r.el.muted = g === 0;
      }
    }
  }

  /* ================= устройство вывода ================= */

  async applySink() {
    const id = prefs.get('audio.outputDeviceId');
    const sinkId = !id || id === 'default' ? '' : id;
    const music = document.getElementById('music-audio');
    const setEl = async (el) => {
      if (!el || !hasElSink()) return;
      try { if (el.sinkId !== sinkId) await el.setSinkId(sinkId); } catch (e) { console.warn('[audio] setSinkId', e); }
    };
    setEl(music);
    for (const r of this.remotes.values()) if (!r.gain) setEl(r.el);
    if (!this.outCtx || !this.outBus) return;
    if (hasCtxSink()) {
      try {
        if (this.outCtx.sinkId !== sinkId) await this.outCtx.setSinkId(sinkId);
      } catch (e) {
        console.warn('[audio] устройство вывода недоступно, использую по умолчанию', e);
        try { await this.outCtx.setSinkId(''); } catch { /* ignore */ }
      }
      return;
    }
    if (!hasElSink()) return;
    // нет AudioContext.setSinkId (Firefox): шина → MediaStream → скрытый <audio> с setSinkId
    try { this.outBus.disconnect(); } catch { /* ignore */ }
    if (!sinkId) {
      this.outBus.connect(this.outCtx.destination);
      if (this.sinkEl) { this.sinkEl.pause(); this.sinkEl.srcObject = null; }
      return;
    }
    if (!this.sinkDest) this.sinkDest = this.outCtx.createMediaStreamDestination();
    if (!this.sinkEl) {
      this.sinkEl = document.createElement('audio');
      this.sinkEl.className = 'audio-output';
      this.sinkEl.hidden = true;
      this.sinkEl.autoplay = true;
      document.body.append(this.sinkEl);
    }
    this.outBus.connect(this.sinkDest);
    this.sinkEl.srcObject = this.sinkDest.stream;
    await setEl(this.sinkEl);
    this.sinkEl.play().catch(() => {});
  }

  /* ================= ввод: голосовой канал ================= */

  async getUserMediaAudio({ deviceId, echoCancellation, autoGainControl, noiseSuppression }) {
    ensureMediaApi('getUserMedia');
    const audio = { echoCancellation, autoGainControl, noiseSuppression, channelCount: { ideal: 1 } };
    const useDevice = deviceId && deviceId !== 'default';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: useDevice ? { ...audio, deviceId: { exact: deviceId } } : audio, video: false });
    } catch (e) {
      if (useDevice && (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError')) {
        console.warn('[audio] выбранный микрофон недоступен — беру по умолчанию', e);
        if (!this.deviceWarned) {
          this.deviceWarned = true;
          toast('Выбранный микрофон не найден — используется микрофон по умолчанию', '', 5000);
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        } catch (e2) { throw explainMediaError(e2, 'микрофону'); }
      } else {
        throw explainMediaError(e, 'микрофону');
      }
    }
    if (!this.permissionSeen) { this.permissionSeen = true; this.emitDevices(); }
    return stream;
  }

  rnnoiseFailed(err) {
    console.warn('[audio] RNNoise не загрузился — стандартное шумоподавление', err);
    if (this.rnnoiseWarned) return;
    this.rnnoiseWarned = true;
    toast('ИИ-шумоподавление (RNNoise) не загрузилось — включено стандартное', '', 6000);
  }

  reportMicError(e) {
    toast(e instanceof MediaError ? e.message : `Микрофон: ${e?.message || e}`, 'error', 6000);
  }

  /** Захватить микрофон для голосового канала. → MediaStream с отправляемым треком. Бросает MediaError. */
  async acquireVoiceMic() {
    this.releaseVoiceMic();
    const chain = new MicChain(this, {
      purpose: 'voice',
      onGate: () => this.emitGate(),
      onTrackChange: (t) => { if (this.voiceChain === chain) for (const fn of this.trackListeners) fn(t); },
    });
    this.voiceChain = chain;
    try {
      await chain.start();
    } catch (e) {
      chain.stop();
      if (this.voiceChain === chain) this.voiceChain = null;
      throw e;
    }
    if (this.voiceChain !== chain) { chain.stop(); throw new MediaError('Подключение отменено'); }
    chain.setMuted(this.voiceMuted);
    return new MediaStream([chain.outputTrack]);
  }

  releaseVoiceMic() {
    const c = this.voiceChain;
    this.voiceChain = null;
    if (c) { c.stop(); this.emitGate(); }
  }

  /** rtc подписывается: при смене отправляемого трека → replaceTrack у всех пиров. */
  onOutgoingTrack(fn) { this.trackListeners.add(fn); return () => this.trackListeners.delete(fn); }
  /** «Гейт открыт» голосовой цепочки (без учёта mute — его учитывает rtc). */
  onGateChange(fn) { this.gateListeners.add(fn); return () => this.gateListeners.delete(fn); }
  get voiceGateOpen() { return !!this.voiceChain?.gateOpen; }
  emitGate() { for (const fn of this.gateListeners) { try { fn(this.voiceGateOpen); } catch (e) { console.warn(e); } } }

  setVoiceMuted(muted) {
    this.voiceMuted = !!muted;
    this.voiceChain?.setMuted(this.voiceMuted);
  }

  /* ================= рация ================= */

  onKey(e, down) {
    if (prefs.get('audio.inputMode') !== 'ptt') return;
    if (e.code !== prefs.get('audio.pttKey')) return;
    if (down) {
      if (e.repeat) { if (this.pttKeyDown && !isTypingTarget(e.target)) e.preventDefault(); return; }
      if (isTypingTarget(e.target)) return;
      if (e.target?.closest?.('[data-keybind-capture]')) return; // поле назначения клавиши в настройках
      this.pttKeyDown = true;
      if (e.code === 'Space') e.preventDefault();
    } else {
      if (!this.pttKeyDown) return;
      this.pttKeyDown = false;
    }
    this.updatePtt();
  }

  setPttPressed(pressed) {
    this.pttButton = !!pressed;
    this.updatePtt();
  }

  updatePtt(immediate = false) {
    const want = prefs.get('audio.inputMode') === 'ptt' && (this.pttKeyDown || this.pttButton);
    clearTimeout(this.pttTimer);
    if (want || immediate) {
      this.setPttActive(want);
    } else if (this.pttActive) {
      const delay = Math.max(0, Number(prefs.get('audio.pttReleaseDelay')) || 0);
      this.pttTimer = setTimeout(() => this.setPttActive(false), delay);
    }
  }

  setPttActive(v) {
    if (this.pttActive === v) { this.forEachChain((c) => c.pushGateConfig()); return; }
    this.pttActive = v;
    this.forEachChain((c) => c.pushGateConfig());
  }

  /** Отпустить захваты устройства другими цепочками (они пересоберутся сами по подписке на prefs). */
  releaseCaptures(deviceId, except) {
    this.forEachChain((c) => {
      if (c !== except && c.raw && c.constraintKey && JSON.parse(c.constraintKey).deviceId === deviceId) c.stopRaw();
    });
  }

  forEachChain(fn) {
    if (this.voiceChain) fn(this.voiceChain);
    for (const t of this.tests) fn(t.chain);
  }

  /* ================= публичное: тест микрофона, устройства ================= */

  async startMicTest({ loopback = false, onLevel } = {}) {
    this.unlock(); // синхронно — мы ещё в жесте пользователя
    const test = { chain: null, src: null, gain: null };
    test.chain = new MicChain(this, { purpose: 'test', onLevel });
    this.tests.add(test);
    try {
      await test.chain.start();
    } catch (e) {
      test.chain.stop();
      this.tests.delete(test);
      throw e;
    }
    test.updateLoopGain = () => {
      if (test.gain) test.gain.gain.value = Math.max(0, Number(prefs.get('audio.outputVolume')) || 0) / 100;
    };
    if (loopback && this.outCtx && this.outBus) {
      // слышать себя: обработанный трек (до mute) → выход с учётом громкости вывода
      const connect = () => {
        try { test.src?.disconnect(); } catch { /* ignore */ }
        const track = test.chain.processedTrack || test.chain.rawTrack;
        if (!track) return;
        test.src = this.outCtx.createMediaStreamSource(new MediaStream([track]));
        test.gain ||= this.outCtx.createGain();
        test.updateLoopGain();
        test.src.connect(test.gain).connect(this.outBus);
      };
      try { connect(); } catch (e) { console.warn('[audio] loopback', e); }
      test.chain.opts.onTrackChange = () => { try { connect(); } catch { /* ignore */ } };
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try { test.src?.disconnect(); test.gain?.disconnect(); } catch { /* ignore */ }
      test.chain.stop();
      this.tests.delete(test);
    };
  }

  async listDevices() {
    const hasApi = hasCtxSink() || hasElSink();
    let devices = [];
    try { devices = (await navigator.mediaDevices?.enumerateDevices?.()) || []; } catch { /* ignore */ }
    const build = (kind, noun) => {
      const list = devices.filter((d) => d.kind === kind);
      const def = list.find((d) => d.deviceId === 'default');
      const out = [{ deviceId: 'default', label: def?.label ? `По умолчанию — ${def.label.replace(/^(Default|По умолчанию)\s*-\s*/i, '')}` : 'По умолчанию' }];
      let n = 0;
      for (const d of list) {
        if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
        if (out.some((x) => x.deviceId === d.deviceId)) continue;
        n++;
        out.push({ deviceId: d.deviceId, label: d.label || `${noun} ${n}` });
      }
      return out;
    };
    const inputs = build('audioinput', 'Микрофон');
    const outputs = build('audiooutput', 'Динамики');
    return { inputs, outputs, canSelectOutput: hasApi && outputs.length > 1 };
  }

  onDevicesChange(fn) { this.deviceListeners.add(fn); return () => this.deviceListeners.delete(fn); }
  emitDevices() { for (const fn of this.deviceListeners) { try { fn(); } catch (e) { console.warn(e); } } }

  rnnoiseSupported() { return rnnoiseSupported(); }

  /** Фактический режим шумоподавления (голос, иначе тест микрофона), null — микрофона нет. */
  getNoiseMode() {
    if (this.voiceChain) return this.voiceChain.activeMode;
    for (const t of this.tests) return t.chain.activeMode;
    return null;
  }
}

export const engine = new AudioEngine();
engine.bind();

/** Публичный API (docs/SPEC-v2.md §2). */
export const audioEngine = {
  startMicTest: (opts) => engine.startMicTest(opts),
  listDevices: () => engine.listDevices(),
  rnnoiseSupported: () => engine.rnnoiseSupported(),
  setPttPressed: (pressed) => engine.setPttPressed(pressed),
  // дополнительно
  onDevicesChange: (fn) => engine.onDevicesChange(fn),
  getNoiseMode: () => engine.getNoiseMode(),
  /** Звук демонстрации экрана участника: выключить/включить только у себя */
  setStreamAudioMuted: (socketId, muted) => {
    if (muted) engine.streamMuted.add(socketId); else engine.streamMuted.delete(socketId);
    engine.updateGains();
  },
  isStreamAudioMuted: (socketId) => engine.streamMuted.has(socketId),
};

/** Отладка для QA: window.__sozvon.audio */
export const audioDebug = {
  getUserGain: (userId) => engine.getUserGain(userId),
  getUserLevel: (userId) => engine.getUserLevel(userId),
  getNoiseMode: () => engine.getNoiseMode(),
  isRnnoiseLoaded: () => isRnnoiseLoaded(),
  engine,
};

// main.js создаёт window.__sozvon после вычисления импортов — дополняем его следующей микрозадачей
queueMicrotask(() => {
  try {
    window.__sozvon = window.__sozvon || {};
    if (!window.__sozvon.audio) window.__sozvon.audio = audioDebug;
  } catch { /* ignore */ }
});
