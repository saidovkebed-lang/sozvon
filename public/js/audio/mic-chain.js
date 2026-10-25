// Цепочка обработки микрофона:
//   getUserMedia → [RNNoise] → GainNode(inputVolume) → гейт (worklet) → MediaStreamDestination → отправляемый трек
// Один экземпляр — для голосового канала, отдельные — для теста микрофона в настройках.
// Выходной трек (MediaStreamDestination) живёт столько же, сколько цепочка: смена шумоподавления,
// устройства и констрейнтов пересобирает только «голову» графа, поэтому отправляемый трек обычно
// не меняется вовсе. Если меняется (обход WebAudio при остановленном AudioContext) — onTrackChange.

import { prefs } from '../prefs.js';
import { createRnnoiseNode, createGateNode, rnnoiseSupported } from './rnnoise.js';

export const AUTO_THRESHOLD_DB = 20 * Math.log10(0.018); // ≈ -35 dBFS: прежний детектор речи
const HOLD_MS = 450;
const REBUILD_KEYS = new Set(['audio.inputDeviceId', 'audio.noiseSuppression', 'audio.echoCancellation', 'audio.autoGain']);
const GATE_KEYS = new Set(['audio.inputMode', 'audio.sensitivityAuto', 'audio.sensitivityDb']);

export class MicChain {
  /**
   * @param {object} engine  — audioEngine (контекст, getUserMedia, PTT, уведомления об ошибках)
   * @param {object} opts    — { purpose: 'voice'|'test', onLevel(db, open), onGate(open), onTrackChange(track) }
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.opts = opts;
    this.ctx = engine.micContext();
    this.raw = null;            // MediaStream из getUserMedia
    this.constraintKey = '';
    this.source = null;
    this.rnnoise = null;
    this.inGain = null;
    this.gate = null;           // AudioWorkletNode | null (фолбэк — gateGain + анализатор)
    this.gateGain = null;
    this.dest = null;
    this.activeMode = null;     // фактический режим шумоподавления
    this.gateOpen = false;
    this.level = -100;
    this.stopped = false;
    this.queue = Promise.resolve();
    this.outTrack = null;
    this.unsub = prefs.subscribe('audio.', (key) => this.onPref(key));
    this.onCtxState = () => this.updateOutput();
    this.ctx?.addEventListener?.('statechange', this.onCtxState);
  }

  /** Первая сборка. Бросает MediaError, если микрофон недоступен. */
  async start() {
    await this.initNodes();
    await this.build();
    return this;
  }

  get outputTrack() { return this.outTrack; }
  get processedTrack() { return this.dest?.stream.getAudioTracks()[0] || null; }
  get rawTrack() { return this.raw?.getAudioTracks()[0] || null; }

  /** WebAudio-граф реально работает → отправляем обработанный трек, иначе — сырой (лучше, чем тишина). */
  get bypass() { return !this.dest || !this.ctx || this.ctx.state !== 'running'; }

  async initNodes() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.inGain = ctx.createGain();
      this.inGain.gain.value = prefs.get('audio.inputVolume') / 100;
      this.dest = ctx.createMediaStreamDestination();
      try { this.dest.channelCount = 1; } catch { /* ignore */ }
      try {
        this.gate = await createGateNode(ctx, { ...this.gateConfig(), holdMs: HOLD_MS });
        this.gate.port.onmessage = (e) => this.onGateMessage(e.data);
        this.inGain.connect(this.gate).connect(this.dest);
      } catch (e) {
        console.warn('[audio] гейт-worklet недоступен, упрощённый режим', e);
        this.gate = null;
        this.gateGain = ctx.createGain();
        this.gateGain.gain.value = 0;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.inGain.connect(this.analyser);
        this.inGain.connect(this.gateGain).connect(this.dest);
        this.startFallbackMeter();
      }
    } catch (e) {
      console.warn('[audio] WebAudio недоступен — микрофон без обработки', e);
      this.inGain = null;
      this.dest = null;
    }
  }

  gateConfig() {
    const ptt = prefs.get('audio.inputMode') === 'ptt';
    const auto = prefs.get('audio.sensitivityAuto');
    return {
      mode: ptt ? 'ptt' : (auto ? 'auto' : 'manual'),
      thresholdDb: auto ? AUTO_THRESHOLD_DB : Number(prefs.get('audio.sensitivityDb')),
      pttOpen: this.engine.pttActive,
    };
  }

  pushGateConfig() {
    if (this.gate) this.gate.port.postMessage(this.gateConfig());
    this.updateOutput();
  }

  onPref(key) {
    if (this.stopped) return;
    if (key === 'audio.noiseSuppression' && prefs.get(key) === 'rnnoise' && this.engine.rnnoiseDisabled) {
      // пользователь снова выбрал нейросеть — даём ещё одну попытку (и снова предупредим, если не выйдет)
      this.engine.rnnoiseDisabled = false;
      this.engine.rnnoiseWarned = false;
    }
    if (REBUILD_KEYS.has(key)) this.rebuild();
    else if (key === 'audio.inputVolume' && this.inGain) {
      const v = Math.max(0, Math.min(200, Number(prefs.get('audio.inputVolume')) || 0)) / 100;
      this.inGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    } else if (GATE_KEYS.has(key)) this.pushGateConfig();
  }

  onGateMessage(d) {
    if (!d) return;
    if (d.type === 'level') {
      this.level = d.db;
      this.setGate(d.open);
      try { this.opts.onLevel?.(d.db, d.open); } catch (e) { console.warn('[audio] onLevel', e); }
    } else if (d.type === 'gate') this.setGate(d.open);
  }

  setGate(open) {
    if (this.gateOpen === open) return;
    this.gateOpen = open;
    this.opts.onGate?.(open);
    if (this.bypass) this.updateOutput(); // при обходе гейт/рация реализуются через track.enabled
  }

  /** Упрощённый гейт без AudioWorklet: анализатор + setInterval (как старый детектор речи). */
  startFallbackMeter() {
    const buf = new Float32Array(this.analyser.fftSize);
    let lastAbove = 0;
    this.meterTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const db = Math.max(-100, 10 * Math.log10(sum / buf.length + 1e-12));
      const cfg = this.gateConfig();
      const now = performance.now();
      let open = this.gateOpen;
      if (cfg.mode === 'ptt') open = cfg.pttOpen;
      else if (db > cfg.thresholdDb) { open = true; lastAbove = now; }
      else if (open && now - lastAbove > HOLD_MS) open = false;
      this.gateGain.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? 0.003 : 0.03);
      this.onGateMessage({ type: 'level', db, open });
    }, 50);
  }

  /** Пересобрать «голову» графа (последовательно, без гонок). */
  rebuild() {
    this.queue = this.queue.then(() => this.build()).catch((e) => {
      console.warn('[audio] пересборка микрофона', e);
      this.engine.reportMicError?.(e);
    });
    return this.queue;
  }

  async build() {
    if (this.stopped) return;
    let mode = prefs.get('audio.noiseSuppression');
    if (!['rnnoise', 'standard', 'off'].includes(mode)) mode = 'standard';
    let rn = null;
    if (mode === 'rnnoise') {
      if (!this.ctx || !this.inGain) {
        mode = 'standard';
      } else if (this.engine.rnnoiseDisabled) {
        mode = 'standard'; // в этой сессии модель уже ломалась — не мучаем микрофон повторно
      } else if (this.ctx.sampleRate !== 48000) {
        // RNNoise обучен на 48 кГц (кадр 480 = 10 мс); браузер ресемплирует микрофон в частоту контекста,
        // и если создать контекст на 48 кГц не дали — модель на другой частоте только испортит голос
        this.engine.rnnoiseFailed(new Error(`AudioContext ${this.ctx.sampleRate} Гц вместо 48000`));
        mode = 'standard';
      } else if (!rnnoiseSupported()) {
        this.engine.rnnoiseFailed(new Error('AudioWorklet/WebAssembly не поддерживаются'));
        mode = 'standard';
      } else {
        try {
          rn = await createRnnoiseNode(this.ctx);
        } catch (e) {
          this.engine.rnnoiseFailed(e);
          mode = 'standard';
        }
      }
    }
    if (this.stopped) { rn?.destroy(); return; }

    const constraints = {
      deviceId: prefs.get('audio.inputDeviceId'),
      echoCancellation: !!prefs.get('audio.echoCancellation'),
      autoGainControl: !!prefs.get('audio.autoGain'),
      noiseSuppression: mode === 'standard',
    };
    const key = JSON.stringify(constraints);
    let oldRaw = null;
    if (key !== this.constraintKey || !this.rawTrack || this.rawTrack.readyState !== 'live') {
      let fresh;
      // Chromium отдаёт новому захвату того же устройства обработку (NS/EC/AGC) уже открытого захвата —
      // при смене обработки сначала отпускаем старый захват (и чужие захваты того же устройства, напр. теста)
      const prev = this.constraintKey ? JSON.parse(this.constraintKey) : null;
      if (prev && prev.deviceId === constraints.deviceId) {
        this.stopRaw();
        this.engine.releaseCaptures?.(constraints.deviceId, this);
      }
      try {
        fresh = await this.engine.getUserMediaAudio(constraints);
      } catch (e) {
        // устройство могло быть занято нашим же старым захватом — отпускаем и пробуем ещё раз
        if (!this.raw) { rn?.destroy(); throw e; }
        this.stopRaw();
        fresh = await this.engine.getUserMediaAudio(constraints);
      }
      if (this.stopped) { fresh.getTracks().forEach((t) => t.stop()); rn?.destroy(); return; }
      oldRaw = this.raw;
      this.raw = fresh;
      this.constraintKey = key;
      const t = this.rawTrack;
      t?.addEventListener('ended', () => {
        if (!this.stopped && this.raw === fresh) {
          console.warn('[audio] микрофон отключился — переподключаю');
          this.constraintKey = '';
          this.rebuild();
        }
      });
    }

    // перестроить голову графа
    this.stopWatchdog();
    try { this.source?.disconnect(); } catch { /* ignore */ }
    if (this.rnnoise) { try { this.rnnoise.disconnect(); } catch { /* ignore */ } this.rnnoise.destroy(); }
    this.source = null;
    this.rnnoise = null;
    if (this.ctx && this.inGain && this.raw) {
      try {
        this.source = this.ctx.createMediaStreamSource(this.raw);
        if (rn) {
          this.source.connect(rn).connect(this.inGain);
          this.rnnoise = rn;
          this.startWatchdog(rn);
        } else {
          this.source.connect(this.inGain);
        }
      } catch (e) {
        console.warn('[audio] не удалось подключить микрофон к WebAudio — без обработки', e);
        rn?.destroy();
        if (mode === 'rnnoise') mode = 'standard';
        this.dest = null; // → bypass навсегда
      }
    } else {
      rn?.destroy();
    }
    this.activeMode = mode;
    oldRaw?.getTracks().forEach((t) => t.stop());
    this.updateOutput();
  }

  /**
   * Сторож RNNoise: worklet мог упасть (processorerror) или так и не загрузить модель внутри
   * аудиопотока — тогда он молча отдаёт тишину, и собеседники вас не слышат. Если на входе звук есть,
   * а на выходе модели — сплошные нули ~1,5 с, переключаемся на стандартное шумоподавление.
   */
  startWatchdog(rn) {
    const ctx = this.ctx;
    const fail = (why) => {
      if (this.rnnoise !== rn || this.stopped) return;
      this.stopWatchdog();
      this.engine.rnnoiseDisabled = true;
      this.engine.rnnoiseFailed(new Error(why));
      this.rebuild();
    };
    rn.onprocessorerror = () => fail('ошибка в AudioWorklet RNNoise');
    try {
      const pre = ctx.createAnalyser();
      const post = ctx.createAnalyser();
      // окно ~0,7 с: короткие звуки между опросами не теряются
      pre.fftSize = 32768; post.fftSize = 32768;
      this.source.connect(pre);
      rn.connect(post);
      const a = new Float32Array(pre.fftSize);
      const b = new Float32Array(post.fftSize);
      let silent = 0; let checks = 0;
      this.watch = { pre, post, timer: setInterval(() => {
        if (ctx.state !== 'running') return;
        pre.getFloatTimeDomainData(a);
        post.getFloatTimeDomainData(b);
        let inE = 0; let outMax = 0;
        for (let i = 0; i < a.length; i++) { inE += a[i] * a[i]; outMax = Math.max(outMax, Math.abs(b[i])); }
        const hasInput = inE / a.length > 1e-8; // > −80 дБFS
        if (hasInput && outMax === 0) silent++; else if (hasInput) silent = 0;
        if (silent >= 6) fail('RNNoise выдаёт тишину'); // ~1,5 с звука на входе и ни одного сэмпла на выходе
        else if (++checks > 80 && silent === 0) this.stopWatchdog(); // ~20 с работы — модель исправна
      }, 250) };
    } catch (e) { console.warn('[audio] сторож RNNoise', e); }
  }

  stopWatchdog() {
    const w = this.watch;
    if (!w) return;
    this.watch = null;
    clearInterval(w.timer);
    try { w.pre.disconnect(); w.post.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(w.pre); } catch { /* ignore */ }
    try { this.rnnoise?.disconnect(w.post); } catch { /* ignore */ }
  }

  /** Выбрать отправляемый трек и его enabled (mute / рация в режиме обхода). */
  updateOutput() {
    if (this.stopped) return;
    const next = this.bypass ? this.rawTrack : this.processedTrack;
    if (next !== this.outTrack) {
      // сырой трек питает и граф — не выключать его, если он больше не отправляется
      if (this.outTrack && this.outTrack !== this.rawTrack) this.outTrack.enabled = true;
      this.outTrack = next;
      this.opts.onTrackChange?.(next);
    }
    this.applyEnabled();
  }

  applyEnabled() {
    const t = this.outTrack;
    if (!t) return;
    let enabled = !this.muted;
    // без WebAudio гейт не режет звук — рация хотя бы через enabled
    if (this.bypass && prefs.get('audio.inputMode') === 'ptt') enabled = enabled && this.engine.pttActive;
    t.enabled = enabled;
    if (t !== this.rawTrack && this.rawTrack) this.rawTrack.enabled = true;
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.applyEnabled();
  }

  stopRaw() {
    this.raw?.getTracks().forEach((t) => t.stop());
    this.raw = null;
    this.constraintKey = '';
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.unsub();
    clearInterval(this.meterTimer);
    this.stopWatchdog();
    this.ctx?.removeEventListener?.('statechange', this.onCtxState);
    for (const n of [this.source, this.rnnoise, this.inGain, this.gate, this.gateGain, this.analyser]) {
      try { n?.disconnect(); } catch { /* ignore */ }
    }
    this.rnnoise?.destroy();
    try { this.gate?.port.postMessage({ type: 'destroy' }); } catch { /* ignore */ }
    this.stopRaw();
    this.processedTrack?.stop();
    this.gateOpen = false;
  }
}
