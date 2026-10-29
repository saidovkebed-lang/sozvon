// Эквалайзер музыки бота — у каждого слушателя свой (prefs 'music.eq').
//
// Пока эквалайзер выключен или «Ровно» (все полосы и предусиление 0 дБ), звук НЕ обрабатывается:
// <audio id="music-audio"> играет сам, как раньше (громкость — element.volume, deafen — element.muted,
// устройство вывода — element.setSinkId в audio/engine.js).
//
// При первом «не ровном» включении строится граф WebAudio:
//   #music-audio → MediaElementSource → предусиление → 10 BiquadFilter (32 Гц…16 кГц) → громкость → MediaStreamDestination
//   → скрытый <audio id="music-eq-out"> (setSinkId = выбранное устройство вывода).
// Выход через <audio>, а не ctx.destination: так звук музыки, как и голоса (audio/engine.js), остаётся опорным
// сигналом эхоподавления браузера и идёт в то же устройство вывода. createMediaElementSource необратим —
// после него #music-audio сам больше не звучит (слышен только один путь); если потом выбрать «Ровно»,
// фильтры обходятся (источник → громкость), обработки нет.
//
// Громкость музыки и deafen при активном графе: element.volume = 1, громкость/заглушение — узел громкости
// (и muted у #music-eq-out). Синхронизация (music.js) по-прежнему управляет только #music-audio.
import { prefs } from '../prefs.js';

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LIMIT = 12; // ±дБ на полосу
export const EQ_PREAMP_MIN = -12;
export const EQ_PREAMP_MAX = 6;
export const EQ_PRESETS = [
  { id: 'flat', name: 'Ровно', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
  { id: 'bass', name: 'Бас', gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0], preamp: -5 },
  { id: 'voice', name: 'Голос', gains: [-4, -3, -2, 0, 2, 4, 4, 3, 1, -1], preamp: -3 },
  { id: 'electronic', name: 'Электроника', gains: [5, 4, 2, 0, -2, 0, 1, 2, 4, 5], preamp: -4 },
  { id: 'rock', name: 'Рок', gains: [5, 4, 3, 1, -1, -1, 1, 3, 4, 4], preamp: -4 },
  { id: 'pop', name: 'Поп', gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2], preamp: -3 },
  { id: 'bassLight', name: 'Лёгкий бас-буст', gains: [3, 3, 2, 1, 0, 0, 0, 0, 0, 0], preamp: -2 },
];
export const EQ_DEFAULT = Object.freeze({ on: false, preset: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 });

const clampDb = (v, min, max) => {
  const n = Math.round(Number(v) * 2) / 2; // шаг 0,5 дБ
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};

/** Нормализовать значение prefs 'music.eq' */
export function normEq(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const gains = EQ_BANDS.map((_, i) => clampDb(Array.isArray(v.gains) ? v.gains[i] : 0, -EQ_LIMIT, EQ_LIMIT));
  const preset = EQ_PRESETS.some((p) => p.id === v.preset) || v.preset === 'custom' ? v.preset : 'flat';
  return { on: !!v.on, preset, gains, preamp: clampDb(v.preamp ?? 0, EQ_PREAMP_MIN, EQ_PREAMP_MAX) };
}

/** «Ровно»: обработка не нужна */
export const isFlat = (eq) => !eq.on || (eq.preamp === 0 && eq.gains.every((g) => g === 0));

const hasElSink = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
const dbToGain = (db) => 10 ** (db / 20);

class MusicEq {
  constructor() {
    this.el = null;
    this.ctx = null;
    this.src = null;      // MediaElementAudioSourceNode — есть, значит #music-audio «захвачен» графом
    this.pre = null;
    this.filters = [];
    this.vol = null;
    this.dest = null;
    this.outEl = null;
    this.routed = 'none'; // 'none' — без графа; 'bypass' — граф без фильтров; 'eq' — с фильтрами
    this.volume = 0.7;
    this.muted = false;
    this.building = null;
    this.waitingGesture = false;
    this.onBlocked = null; // music.js: воспроизведение #music-eq-out заблокировано политикой автозапуска
    this.error = null;
  }

  get supported() { return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext); }
  /** Звук музыки идёт через граф (element.volume должен быть 1) */
  get active() { return !!this.src; }

  init(el) {
    this.el = el;
    prefs.subscribe('music.eq', () => this.apply());
    prefs.subscribe('audio.outputDeviceId', () => this.applySink());
    this.apply();
  }

  setVolume(v01) {
    this.volume = Math.min(1, Math.max(0, Number(v01) || 0));
    this.update();
  }

  setMuted(m) {
    if (this.muted === !!m) return;
    this.muted = !!m;
    this.update();
  }

  /** Применить настройки: построить граф (если ещё нет и звук не «ровный») и переключить маршрут */
  apply() {
    const eq = normEq(prefs.get('music.eq'));
    if (!this.src) {
      if (isFlat(eq) || !this.el) return;
      this.build();
      return;
    }
    this.route(eq);
  }

  build() {
    if (this.building || this.src) return this.building;
    this.building = this.doBuild().finally(() => { this.building = null; });
    return this.building;
  }

  async doBuild() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.error = 'Браузер не поддерживает Web Audio — эквалайзер недоступен'; return; }
    try {
      if (!this.ctx) this.ctx = new AC({ latencyHint: 'playback' });
    } catch (e) { this.error = 'Не удалось запустить обработку звука'; console.warn('[eq]', e); return; }
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    }
    // без жеста пользователя контекст не запустится; «захватывать» элемент в остановленный граф нельзя —
    // музыка бы замолчала. Ждём клика/клавиши, а пока музыка играет без эквалайзера.
    if (ctx.state !== 'running') { this.waitGesture(); return; }
    const eq = normEq(prefs.get('music.eq'));
    if (isFlat(eq) || this.src) return;
    try {
      this.src = ctx.createMediaElementSource(this.el);
    } catch (e) {
      this.error = 'Не удалось подключить эквалайзер к плееру';
      console.warn('[eq] createMediaElementSource', e);
      return;
    }
    this.pre = ctx.createGain();
    this.filters = EQ_BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    this.vol = ctx.createGain();
    this.dest = ctx.createMediaStreamDestination();
    let node = this.pre;
    for (const f of this.filters) { node.connect(f); node = f; }
    node.connect(this.vol);
    this.vol.connect(this.dest);
    const out = document.createElement('audio');
    out.id = 'music-eq-out';
    out.hidden = true;
    out.autoplay = true;
    out.srcObject = this.dest.stream;
    document.body.append(out);
    this.outEl = out;
    this.el.volume = 1; // громкость теперь — узел vol
    this.applySink();
    this.route(eq);
    this.kick();
  }

  waitGesture() {
    if (this.waitingGesture) return;
    this.waitingGesture = true;
    const go = () => {
      document.removeEventListener('pointerdown', go, true);
      document.removeEventListener('keydown', go, true);
      this.waitingGesture = false;
      this.ctx?.resume().catch(() => {});
      this.apply();
    };
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  }

  route(eq) {
    if (!this.src) return;
    const flat = isFlat(eq);
    try { this.src.disconnect(); } catch { /* не был подключён */ }
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(flat ? 0 : eq.gains[i], t, 0.02));
    this.pre.gain.setTargetAtTime(flat ? 1 : dbToGain(eq.preamp), t, 0.02);
    if (flat) { this.src.connect(this.vol); this.routed = 'bypass'; } else { this.src.connect(this.pre); this.routed = 'eq'; }
    this.update();
  }

  update() {
    if (!this.src) { this.routed = 'none'; return; }
    if (this.el && this.el.volume !== 1) this.el.volume = 1;
    const g = this.muted ? 0 : this.volume;
    try { this.vol.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015); } catch { this.vol.gain.value = g; }
    if (this.outEl) this.outEl.muted = this.muted;
  }

  /** В жесте пользователя («Включить звук», вход в канал): запустить контекст и выход */
  kick() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (this.waitingGesture) this.apply();
    const out = this.outEl;
    if (!out || !out.paused) return;
    out.play().catch((e) => {
      if (e?.name === 'NotAllowedError') this.onBlocked?.();
    });
  }

  async applySink() {
    const out = this.outEl;
    if (!out || !hasElSink()) return;
    const id = prefs.get('audio.outputDeviceId');
    const sinkId = !id || id === 'default' ? '' : id;
    try { if (out.sinkId !== sinkId) await out.setSinkId(sinkId); } catch (e) { console.warn('[eq] setSinkId', e); }
  }

  /** Для отладки и тестов */
  info() {
    return {
      graph: !!this.src,
      routed: this.routed,
      ctxState: this.ctx?.state || null,
      volume: this.vol ? Math.round(this.vol.gain.value * 1000) / 1000 : null,
      targetVolume: this.muted ? 0 : this.volume,
      muted: this.muted,
      outMuted: this.outEl ? this.outEl.muted : null,
      outSink: this.outEl ? (this.outEl.sinkId ?? null) : null,
      elementVolume: this.el ? this.el.volume : null,
      gains: this.filters.map((f) => Math.round(f.gain.value * 10) / 10),
      preamp: this.pre ? Math.round(this.pre.gain.value * 1000) / 1000 : null,
      outputs: document.querySelectorAll('#music-eq-out').length,
      waitingGesture: this.waitingGesture,
      error: this.error,
    };
  }
}

export const musicEq = new MusicEq();
if (typeof window !== 'undefined') window.__astraMusicEq = musicEq;
