// Плеер одного сервера: очередь, текущий трек, пауза, таймер конца трека, авто-выход.
export const IDLE_LEAVE_MS = Number(process.env.BOT_IDLE_MS) || 2 * 60 * 1000;
// Сколько треков подряд может не скачаться, прежде чем бот перестанет перебирать очередь
export const MAX_FAILS_IN_ROW = Math.max(1, Number(process.env.MUSIC_MAX_FAILS) || 3);
const END_MARGIN_MS = 400; // небольшой запас, чтобы у слушателей трек успел доиграть
let qidSeq = 0;
/** Уникальный id элемента очереди (id трека библиотеки может повторяться: один трек дважды) */
const newQid = () => `q${Date.now().toString(36)}${(++qidSeq).toString(36)}`;
const withQid = (t) => (t && !t.qid ? Object.assign(t, { qid: newQid() }) : t);

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '?:??';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Нормализованное название для «уже играло» (как titleKey в server/music-sources.js) */
export const titleKey = (title) => 't:' + String(title || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const HISTORY_MAX = 150; // ≈ 50 треков: id, название и ключ источника

export function trackLabel(t) {
  if (!t) return '—';
  return t.artist ? `«${t.title}» — ${t.artist}` : `«${t.title}»`;
}

/** Элемент очереди для MusicState: ожидающие (pending) — без url, служебные поля (ref, _p) не уходят */
export function publicItem(t) {
  if (!t) return null;
  if (t.pending) {
    const o = { id: t.id, qid: t.qid, title: t.title, artist: t.artist || '', duration: t.duration || 0, addedBy: t.addedBy || null, pending: true, source: t.source || 'search' };
    if (t.loading) o.loading = true;
    if (t.ref) o.ref = t.ref; // откуда скачать — для «Сохранить очередь как плейлист»
    if (t.autoplay) o.autoplay = true;
    return o;
  }
  const o = { id: t.id, qid: t.qid, title: t.title, artist: t.artist || '', duration: t.duration || 0, url: t.url, addedBy: t.addedBy || null };
  if (t.autoplay) o.autoplay = true;
  return o;
}

/** Ожидающий элемент скачался → готовый трек (qid, кто поставил и метка автоплея сохраняются) */
function asReady(item, track) {
  const t = { ...track, addedBy: item.addedBy || track.addedBy, qid: item.qid };
  if (item.autoplay) t.autoplay = true;
  return t;
}

export class Player {
  /**
   * @param {string} serverId
   * @param {{ emitState(state):void, joinVoice(id):void, leaveVoice(id):void, onIdleLeave(player):void,
   *           fetch?(item):Promise<object>, onTrackError?(player, item, err, info):void }} hooks
   *   fetch — скачать ожидающий элемент (REST /api/music/fetch) → готовый Track.
   *   onQueueEnd(player) — очередь закончилась (автоплей подбирает похожие треки).
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
    this.seekSeq = 0;        // растёт при перемотке — клиенты сразу прыгают на новую позицию
    // автоплей
    this.autoplay = false;   // настройка сервера (db.json musicSettings), бот кэширует
    this.autoplayPaused = false; // не удалось подобрать треки — ждём, пока поставят трек вручную
    this.autoplayBusy = false;
    this.session = 0;        // растёт при stop: ответ автоплея после !stop выбрасывается
    this.history = new Set(); // что уже играло/предлагалось в этой сессии (id, «t:название», ключ источника)
    this.lastPlayed = null;  // затравка для автоплея
  }

  /** Запомнить трек как «уже был» (автоплей его не повторит) */
  remember(t) {
    if (!t) return;
    for (const k of [t.pending ? null : t.id, t.title ? titleKey(t.title) : null, t.ref?.key]) {
      if (!k) continue;
      this.history.delete(k);
      this.history.add(k);
    }
    while (this.history.size > HISTORY_MAX) this.history.delete(this.history.values().next().value);
  }

  /** Куда вставить элементы, поставленные людьми: перед треками автоплея */
  userInsertAt() {
    const i = this.queue.findIndex((t) => t.autoplay);
    return i === -1 ? this.queue.length : i;
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
      autoplay: this.autoplay,
      seekSeq: this.seekSeq,
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
    this.current = withQid(track);
    this.lastPlayed = track;
    this.remember(track);
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
      this.queue[i] = asReady(item, track);
      this.broadcast();
    }, () => { /* ошибку покажем, когда дойдёт очередь */ });
  }

  /** @returns {number} 0 — заиграл (или начал загружаться) сразу, иначе позиция в очереди (1..n) */
  enqueue(track) {
    if (!track.autoplay) this.autoplayPaused = false;
    if (track.autoplay) this.queue.push(withQid(track));
    else this.queue.splice(this.userInsertAt(), 0, withQid(track));
    if (!this.current && !this.loading) { this.next(); return 0; }
    this.broadcast();
    const pos = this.queue.indexOf(track) + 1;
    if (pos === 1) this.prefetch();
    return pos;
  }

  /** Добавить сразу много (плейлист). @returns {boolean} заиграл ли первый сразу */
  enqueueMany(items) {
    const auto = items.length > 0 && items.every((t) => t.autoplay);
    if (!auto) this.autoplayPaused = false;
    this.queue.splice(auto ? this.queue.length : this.userInsertAt(), 0, ...items.map(withQid));
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
      this.hooks.onQueueEnd?.(this);
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
      this.remember(nxt);
      this.start(asReady(nxt, track));
    }, (err) => {
      if (gen !== this.gen) return;
      nxt.loading = false;
      this.loading = null;
      this.fails++;
      let dropped = 0;
      const gaveUp = this.fails >= MAX_FAILS_IN_ROW;
      if (gaveUp) {
        if (nxt.autoplay) this.autoplayPaused = true; // источник недоступен — автоплей не перебирает дальше
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

  /** Перемотка текущего трека на sec секунд (пауза сохраняется). @returns новая позиция или null */
  seek(sec) {
    if (!this.current || !Number.isFinite(sec)) return null;
    const d = this.current.duration;
    const pos = Math.max(0, d > 0 ? Math.min(sec, Math.max(0, d - 1)) : sec);
    this.position = pos;
    this.startedAt = Date.now();
    this.seekSeq++;
    this.scheduleEnd();
    this.broadcast();
    return pos;
  }

  remove(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.queue.length) return null;
    const [t] = this.queue.splice(n - 1, 1);
    this.broadcast();
    if (n === 1) this.prefetch();
    return t;
  }

  /** Номер (1..n) элемента очереди по qid; 0 — это загружаемый сейчас элемент; -1 — нет такого */
  indexOfQid(qid) {
    if (this.loading?.qid === qid) return 0;
    const i = this.queue.findIndex((t) => t.qid === qid);
    return i === -1 ? -1 : i + 1;
  }

  /** Переставить элемент очереди с позиции from на to (1..n). @returns элемент или null */
  move(from, to) {
    const n = this.queue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > n) return null;
    const dst = Math.min(Math.max(1, to), n);
    const [t] = this.queue.splice(from - 1, 1);
    this.queue.splice(dst - 1, 0, t);
    this.broadcast();
    if (from === 1 || dst === 1) this.prefetch();
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
    this.session++;
    this.loading = null;
    this.fails = 0;
    this.history.clear();
    this.lastPlayed = null;
    this.autoplayPaused = false;
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
