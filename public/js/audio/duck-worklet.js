// AudioWorklet: «звук экрана без голосов звонка» там, где браузер не умеет исключить свой звук из захвата
// (приложение для ПК на Windows: Electron отдаёт только системный loopback — в нём слышно и сам «Astra»).
//
// Вход 0 — захваченный звук экрана (loopback), вход 1 — то, что «Astra» сейчас играет в динамики
// (голоса собеседников, звук чужих трансляций). Пока играет звук звонка, звук экрана приглушается
// (как «приглушение» в Discord): иначе зрители слышат голоса участников второй раз с задержкой
// трансляции — эффект эха / «церковного хора».
//
// Сообщения в процессор: { thresholdDb, depth, holdMs } | 'destroy'
// Из процессора (~10 раз в секунду): { type: 'duck', ducked, refDb, gain }

class SozvonDuckProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.thresholdDb = Number.isFinite(o.thresholdDb) ? o.thresholdDb : -55;
    this.depth = Number.isFinite(o.depth) ? o.depth : 0.05;           // ≈ −26 дБ
    this.holdSec = (Number.isFinite(o.holdMs) ? o.holdMs : 400) / 1000;
    this.env = 0;
    this.gain = 1;
    this.lastAbove = -1e9;
    this.ducked = false;
    this.envCoef = Math.exp(-128 / (sampleRate * 0.01));        // сглаживание уровня ~10 мс
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.004));      // приглушить за ~4 мс
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.15));      // вернуть за ~150 мс
    this.sinceReport = 0;
    this.reportEvery = Math.round(sampleRate / 10);
    this.alive = true;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'destroy' || d?.type === 'destroy') { this.alive = false; return; }
      if (Number.isFinite(d?.thresholdDb)) this.thresholdDb = d.thresholdDb;
      if (Number.isFinite(d?.depth)) this.depth = d.depth;
      if (Number.isFinite(d?.holdMs)) this.holdSec = d.holdMs / 1000;
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const inp = inputs[0] || [];
    const ref = inputs[1] || [];
    const out = outputs[0];
    let ms = 0; let n = 0;
    for (const ch of ref) {
      for (let i = 0; i < ch.length; i++) ms += ch[i] * ch[i];
      n += ch.length;
    }
    ms = n ? ms / n : 0;
    this.env = this.env * this.envCoef + ms * (1 - this.envCoef);
    const db = 10 * Math.log10(this.env + 1e-12);
    if (db > this.thresholdDb) { this.ducked = true; this.lastAbove = currentTime; }
    else if (this.ducked && currentTime - this.lastAbove > this.holdSec) this.ducked = false;

    const target = this.ducked ? this.depth : 1;
    const k = target < this.gain ? this.attack : this.release;
    let g = this.gain;
    for (let c = 0; c < out.length; c++) {
      const o = out[c];
      const src = inp[c] || inp[0];
      g = this.gain;
      for (let i = 0; i < o.length; i++) {
        g += (target - g) * k;
        o[i] = src ? src[i] * g : 0;
      }
    }
    this.gain = g;

    this.sinceReport += out[0]?.length || 128;
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      this.port.postMessage({ type: 'duck', ducked: this.ducked, refDb: Math.max(-120, db), gain: g });
    }
    return true;
  }
}

registerProcessor('sozvon-duck', SozvonDuckProcessor);
