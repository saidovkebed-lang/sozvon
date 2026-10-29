// «Слушает Spotify / Яндекс Музыка / …» — что играет на ПК пользователя (приложение для Windows читает системные
// медиасессии и присылает presence:listening). Хранится только в памяти, пока пользователь в сети: не сохраняется
// в БД, пропадает при отключении сокета, который его прислал, и через 10 минут без обновлений (клиент повторяет
// раз в 30 с, пока играет). Скрывшим (showListening=false) и «невидимкам» — не храним и не рассылаем.
// Рассылка — тем же, кому уходит presence (участники общих серверов), плюс собеседникам по ЛС.
import { titleCoverKey, coverUrl } from './covers.js';

export const LISTENING_TTL_MS = 10 * 60_000;
const MAX_MS = 24 * 3600_000;
const KINDS = new Set(['music', 'player', 'other', 'browser']);
const RATE_N = 8;            // не больше 8 обновлений…
const RATE_WINDOW = 12_000;  // …за 12 с (клиент шлёт не чаще раза в 2 с + повтор раз в 30 с)

export class ListeningError extends Error {}
const bad = (m) => { throw new ListeningError(m); };

function text(v, max, what, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) bad(`${what}: пусто`);
    return '';
  }
  if (typeof v !== 'string') bad(`${what}: должно быть строкой`);
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !s) bad(`${what}: пусто`);
  if (s.length > max) bad(`${what}: не длиннее ${max} символов`);
  return s;
}
function ms(v, what) {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_MS) bad(`${what}: от 0 до 24 часов в мс`);
  return Math.round(v);
}

/**
 * Проверить данные клиента. null/{} без title — «ничего не играет». Ошибка — ListeningError с текстом по-русски.
 * Позиция — на момент получения (часы клиента не используем: у смотрящих свои часы, они пересчитают от своего «сейчас»).
 */
export function cleanListening(p) {
  if (p === null || p === undefined) return null;
  if (typeof p !== 'object' || Array.isArray(p)) bad('Некорректные данные');
  if (p.title === undefined || p.title === null) return null;
  const out = {
    source: text(p.source, 40, 'Источник', { required: true }),
    title: text(p.title, 200, 'Название', { required: true }),
    artist: text(p.artist, 200, 'Исполнитель'),
    album: text(p.album, 200, 'Альбом'),
    durationMs: ms(p.durationMs, 'Длительность'),
    positionMs: ms(p.positionMs, 'Позиция'),
  };
  if (out.durationMs && out.positionMs > out.durationMs + 5000) bad('Позиция больше длительности');
  if (out.durationMs) out.positionMs = Math.min(out.positionMs, out.durationMs);
  if (p.kind !== undefined && p.kind !== null) {
    if (!KINDS.has(p.kind)) bad('Тип источника: music, player, other или browser');
    out.kind = p.kind;
  }
  return out;
}

/** Хранилище: userId → {np, socketId, updatedAt, cover} + ограничение частоты */
export function createListeningStore({ now = () => Date.now() } = {}) {
  const map = new Map();
  const rate = new Map(); // userId → [моменты обновлений]

  function allow(userId) {
    const t = now();
    const list = (rate.get(userId) || []).filter((x) => t - x < RATE_WINDOW);
    if (list.length >= RATE_N) { rate.set(userId, list); return false; }
    list.push(t);
    rate.set(userId, list);
    return true;
  }

  /** Записать; вернуть публичный вид. Обложка — по «t:исполнитель|название» (server/covers.js: ищется один раз и кэшируется) */
  function set(userId, np, socketId) {
    const prev = map.get(userId);
    const same = prev && prev.np.title === np.title && prev.np.artist === np.artist;
    const cover = same ? prev.cover : coverUrl(titleCoverKey(np.artist, np.title), { artist: np.artist, title: np.title });
    map.set(userId, { np, socketId, updatedAt: now(), cover });
    return view(userId);
  }

  /** Публичный вид с позицией «на сейчас» (смотрящий отсчитывает от момента получения) */
  function view(userId) {
    const e = map.get(userId);
    if (!e) return null;
    const elapsed = Math.max(0, now() - e.updatedAt);
    let positionMs = e.np.positionMs + elapsed;
    if (e.np.durationMs) positionMs = Math.min(positionMs, e.np.durationMs);
    return { ...e.np, positionMs, ...(e.cover ? { cover: e.cover } : {}) };
  }

  return {
    allow,
    set,
    view,
    has: (userId) => map.has(userId),
    /** Удалить; true — было что удалять. socketId — только если прислал именно этот сокет */
    clear(userId, socketId = null) {
      const e = map.get(userId);
      if (!e || (socketId && e.socketId !== socketId)) return false;
      map.delete(userId);
      return true;
    },
    /** Просроченные (без обновлений дольше TTL) — удалить и вернуть их userId */
    expire() {
      const t = now();
      const out = [];
      for (const [uid, e] of map) if (t - e.updatedAt > LISTENING_TTL_MS) { map.delete(uid); out.push(uid); }
      for (const [uid, list] of rate) if (!list.some((x) => t - x < RATE_WINDOW)) rate.delete(uid);
      return out;
    },
    userIds: () => [...map.keys()],
  };
}
