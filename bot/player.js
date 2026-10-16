// Плеер одного сервера: очередь, текущий трек, пауза, таймер конца трека, авто-выход.
export const IDLE_LEAVE_MS = Number(process.env.BOT_IDLE_MS) || 2 * 60 * 1000;
const END_MARGIN_MS = 400; // небольшой запас, чтобы у слушателей трек успел доиграть

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '?:??';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function trackLabel(t) {
  if (!t) return '—';
  return t.artist ? `«${t.title}» — ${t.artist}` : `«${t.title}»`;
}

export class Player {
  /**
   * @param {string} serverId
   * @param {{ emitState(state):void, joinVoice(id):void, leaveVoice(id):void, onIdleLeave(player):void }} hooks
   */
  constructor(serverId, hooks) {
    this.serverId = serverId;
    this.hooks = hooks;
    this.voiceChannelId = null;
    this.textChannelId = null; // последний канал, где с ботом говорили
    this.current = null;
    this.queue = [];
    this.paused = false;
    this.position = 0;       // сек на момент startedAt
    this.startedAt = 0;      // ms, когда position был актуален
    this.endTimer = null;
    this.idleTimer = null;
  }

  get active() { return !!this.voiceChannelId; }
  get busy() { return !!this.current || this.queue.length > 0; }

  elapsed() {
    if (!this.current) return 0;
    if (this.paused) return this.position;
    return this.position + (Date.now() - this.startedAt) / 1000;
  }

  state() {
    return {
      channelId: this.voiceChannelId,
      track: this.current,
      queue: this.queue,
      paused: this.paused,
      position: Math.max(0, Math.round(this.elapsed() * 1000) / 1000),
      updatedAt: Date.now(),
    };
  }

  broadcast() {
    if (this.voiceChannelId) this.hooks.emitState(this.state());
  }

  join(channelId) {
    if (this.voiceChannelId === channelId) return;
    if (this.voiceChannelId) this.hooks.leaveVoice(this.voiceChannelId);
    this.voiceChannelId = channelId;
    this.hooks.joinVoice(channelId);
  }

  // ---------- таймеры ----------
  clearEnd() { if (this.endTimer) { clearTimeout(this.endTimer); this.endTimer = null; } }
  clearIdle() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }

  scheduleEnd() {
    this.clearEnd();
    const d = this.current?.duration;
    if (!d || d <= 0 || this.paused) return; // длительность неизвестна — играет до !skip
    const left = Math.max(0, (d - this.elapsed()) * 1000) + END_MARGIN_MS;
    this.endTimer = setTimeout(() => { this.endTimer = null; this.next(); }, left);
  }

  scheduleIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy || !this.active) return;
      this.hooks.onIdleLeave(this);
      this.stop();
    }, IDLE_LEAVE_MS);
  }

  // ---------- управление ----------
  start(track) {
    this.clearIdle();
    this.current = track;
    this.paused = false;
    this.position = 0;
    this.startedAt = Date.now();
    this.scheduleEnd();
    this.broadcast();
  }

  /** @returns {number} 0 — заиграл сразу, иначе позиция в очереди (1..n) */
  enqueue(track) {
    if (!this.current) { this.start(track); return 0; }
    this.queue.push(track);
    this.broadcast();
    return this.queue.length;
  }

  next() {
    this.clearEnd();
    const nxt = this.queue.shift();
    if (nxt) { this.start(nxt); return nxt; }
    this.current = null;
    this.paused = false;
    this.position = 0;
    this.startedAt = Date.now();
    this.broadcast();
    this.scheduleIdle();
    return null;
  }

  pause() {
    if (!this.current || this.paused) return false;
    this.position = this.elapsed();
    this.paused = true;
    this.startedAt = Date.now();
    this.clearEnd();
    this.broadcast();
    return true;
  }

  resume() {
    if (!this.current || !this.paused) return false;
    this.paused = false;
    this.startedAt = Date.now();
    this.scheduleEnd();
    this.broadcast();
    return true;
  }

  remove(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.queue.length) return null;
    const [t] = this.queue.splice(n - 1, 1);
    this.broadcast();
    return t;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.broadcast();
    return this.queue.length;
  }

  /** Очистить всё и выйти из голосового канала */
  stop({ notifyServer = true } = {}) {
    this.clearEnd();
    this.clearIdle();
    this.current = null;
    this.queue = [];
    this.paused = false;
    this.position = 0;
    const ch = this.voiceChannelId;
    if (ch && notifyServer) {
      this.hooks.emitState({ channelId: ch, track: null, queue: [], paused: false, position: 0, updatedAt: Date.now() });
      this.hooks.leaveVoice(ch);
    }
    this.voiceChannelId = null;
  }

  /** Сокет отвалился — сервер уже забыл про нас, просто чистим таймеры */
  reset() { this.stop({ notifyServer: false }); }
}
