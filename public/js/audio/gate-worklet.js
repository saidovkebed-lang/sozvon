// AudioWorklet: шумовой гейт + измеритель уровня для цепочки микрофона.
// Работает в аудиопотоке, поэтому не тормозит в фоновой вкладке (setInterval там душится до 1 Гц).
//
// Сообщения в процессор (port.postMessage):
//   { mode: 'auto' | 'manual' | 'ptt' | 'open', thresholdDb, holdMs, pttOpen }
// Сообщения из процессора:
//   { type: 'level', db, open }   — ~20 раз в секунду (db — пик сглаженного RMS за интервал)
//   { type: 'gate', open }        — сразу при открытии/закрытии гейта

class SozvonGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.mode = o.mode || 'auto';
    this.thresholdDb = Number.isFinite(o.thresholdDb) ? o.thresholdDb : -35;
    this.holdSec = (Number.isFinite(o.holdMs) ? o.holdMs : 450) / 1000;
    this.pttOpen = !!o.pttOpen;
    this.open = false;
    this.gain = 0;
    this.env = 0;                 // сглаженный средний квадрат
    this.lastAbove = -1e9;
    this.peakDb = -100;
    this.sinceReport = 0;
    this.reportEvery = Math.round(sampleRate / 20);
    this.envCoef = Math.exp(-128 / (sampleRate * 0.02));   // ~20 мс на блок 128 сэмплов
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.003)); // 3 мс
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.04)); // 40 мс
    this.alive = true;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d === 'destroy' || d.type === 'destroy') { this.alive = false; return; }
      if (d.mode) this.mode = d.mode;
      if (Number.isFinite(d.thresholdDb)) this.thresholdDb = d.thresholdDb;
      if (Number.isFinite(d.holdMs)) this.holdSec = d.holdMs / 1000;
      if ('pttOpen' in d) this.pttOpen = !!d.pttOpen;
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const inp = inputs[0];
    const out = outputs[0];
    const n = out[0]?.length || 128;
    let ms = 0;
    if (inp && inp[0]) {
      const ch = inp[0];
      for (let i = 0; i < ch.length; i++) ms += ch[i] * ch[i];
      ms /= ch.length || 1;
    }
    this.env = this.env * this.envCoef + ms * (1 - this.envCoef);
    const db = Math.max(-100, 10 * Math.log10(this.env + 1e-12));
    if (db > this.peakDb) this.peakDb = db;

    let open = this.open;
    if (this.mode === 'ptt') open = this.pttOpen;
    else if (this.mode === 'open') open = true;
    else if (db > this.thresholdDb) { open = true; this.lastAbove = currentTime; }
    else if (open && currentTime - this.lastAbove > this.holdSec) open = false;
    if (open !== this.open) {
      this.open = open;
      this.port.postMessage({ type: 'gate', open });
    }

    const target = open ? 1 : 0;
    const k = target > this.gain ? this.attack : this.release;
    for (let c = 0; c < out.length; c++) {
      const o = out[c];
      const src = inp && (inp[c] || inp[0]);
      let g = this.gain;
      for (let i = 0; i < o.length; i++) {
        g += (target - g) * k;
        o[i] = src ? src[i] * g : 0;
      }
      if (c === out.length - 1) this.gain = g;
    }

    this.sinceReport += n;
    if (this.sinceReport >= this.reportEvery) {
      this.port.postMessage({ type: 'level', db: this.peakDb, open: this.open });
      this.sinceReport = 0;
      this.peakDb = -100;
    }
    return true;
  }
}

registerProcessor('sozvon-gate', SozvonGateProcessor);
