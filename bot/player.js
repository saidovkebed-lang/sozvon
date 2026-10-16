// Плеер одного сервера: очередь, текущий трек, пауза, таймер конца трека, авто-выход.
export const IDLE_LEAVE_MS = Number(process.env.BOT_IDLE_MS) || 2 * 60 * 1000;
// Сколько треков подряд может не скачаться, прежде чем бот перестанет перебирать очередь
export const MAX_FAILS_IN_ROW = Math.max(1, Number(process.env.MUSIC_MAX_FAILS) || 3);
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

/** Элемент очереди для MusicState: ожидающие (pending) — без url, служебные поля (ref, _p) не уходят */
export function publicItem(t) {
  if (!t) return null;
  if (t.pending) {
    const o = { id: t.id, title: t.title, artist: t.artist || '', duration: t.duration || 0, addedBy: t.addedBy || null, pending: true, source: t.source || 'search' };
    if (t.loading) o.loading = true;
    return o;
  }
  return { id: t.id, title: t.title, artist: t.artist || '', duration: t.duration || 0, url: t.url, addedBy: t.addedBy || null };
}

export class Player {
  /**
   * @param {string} serverId
   * @param {{ emitState(state):void, joinVoice(id):void, leaveVoice(id):void, onIdleLeave(player):void,
   *           fetch?(item):Promise<object>, onTrackError?(player, item, err, info):void }} hooks
   *   fetch — скачать ожидающий элемент (REST /api/music/fetch) → готовый Track.
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
    this.loading = null;     // ожидающий элемент, который качается, чтобы заиграть прямо сейчас
    this.gen = 0;            // поколение: skip/stop во время загрузки делают её результат неактуальным
    this.fails = 0;          // неудачных загрузок подряд
  }

  get active() { return !!this.voiceChannelId; }
  get busy() { return !!this.current || this.queue.length > 0 || !!this.loading; }

  elapsed() {
    if (!this.current) return 0;
    if (this.paused) return this.position;
    return this.position + (Date.now() - this.startedAt) / 1000;
  }

  state() {
    return {
      channelId: this.voiceChannelId,
      track: publicItem(this.current),
      // загружаемый элемент показываем первым в очереди с loading:true
      queue: [...(this.loading ? [this.loading] : []), ...this.queue].map(publicItem),
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
    this.prefetch();
  }

  // ---------- ожидающие элементы ----------
  fetchFor(item) {
    if (!item._p) {
      item._p = this.hooks.fetch ? Promise.resolve().then(() => this.hooks.fetch(item)) : Promise.reject(new Error('загрузка недоступна'));
      item._p.catch(() => {}); // ошибку обработает тот, кто ждёт
    }
    return item._p;
  }

  /** Предзагрузка: следующий ожидающий элемент качается, пока играет текущий */
  prefetch() {
    const item = this.queue[0];
    if (!item?.pending || !this.current) return;
    this.fetchFor(item).then((track) => {
      const i = this.queue.indexOf(item);
      if (i === -1) return; // уже убрали/начали играть
      this.queue[i] = { ...track, addedBy: item.addedBy || track.addedBy };
      this.broadcast();
    }, () => { /* ошибку покажем, когда дойдёт очередь */ });
  }

  /** @returns {number} 0 — заиграл (или начал загружаться) сразу, иначе позиция в очереди (1..n) */
  enqueue(track) {
    this.queue.push(track);
    if (!this.current && !this.loading) { this.next(); return 0; }
    this.broadcast();
    if (this.queue.length === 1) this.prefetch();
    return this.queue.length;
  }

  /** Добавить сразу много (плейлист). @returns {boolean} заиграл ли первый сразу */
  enqueueMany(items) {
    this.queue.push(...items);
    if (!this.current && !this.loading) { this.next(); return true; }
    this.broadcast();
    this.prefetch();
    return false;
  }

  /** Следующий трек (skip/конец трека). Ожидающий элемент сначала скачивается. @returns элемент или null */
  next() {
    this.clearEnd();
    const gen = ++this.gen;
    if (this.loading) { this.loading.loading = false; this.loading = null; }
    const nxt = this.queue.shift();
    if (nxt && !nxt.pending) { this.start(nxt); return nxt; }
    this.current = null;
    this.paused = false;
    this.position = 0;
    this.startedAt = Date.now();
    if (!nxt) {
      this.broadcast();
      this.scheduleIdle();
      return null;
    }
    this.clearIdle();
    nxt.loading = true;
    this.loading = nxt;
    this.broadcast();
    this.fetchFor(nxt).then((track) => {
      if (gen !== this.gen) return; // пропустили/остановили, пока качалось (файл остался в кэше)
      nxt.loading = false;
      this.loading = null;
      this.fails = 0;
      this.start({ ...track, addedBy: nxt.addedBy || track.addedBy });
    }, (err) => {
      if (gen !== this.gen) return;
      nxt.loading = false;
      this.loading = null;
      this.fails++;
      let dropped = 0;
      const gaveUp = this.fails >= MAX_FAILS_IN_ROW;
      if (gaveUp) {
        // источник, похоже, недоступен целиком — не перебираем оставшиеся сотни треков
        const before = this.queue.length;
        this.queue = this.queue.filter((t) => !t.pending);
        dropped = before - this.queue.length;
        this.fails = 0;
      }
      this.hooks.onTrackError?.(this, nxt, err, { gaveUp, dropped, hasNext: this.queue.length > 0 });
      this.next();
    });
    return nxt;
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
    this.gen++;
    this.loading = null;
    this.fails = 0;
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
