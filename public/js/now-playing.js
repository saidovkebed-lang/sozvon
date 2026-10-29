// «Слушает Spotify / Яндекс Музыка / …» — сторона отправителя (только приложение для ПК на Windows).
// Мост window.sozvonDesktop: setMediaWatch(on) запускает помощник (системные медиасессии Windows),
// onMedia(sessions) приносит сессии. Здесь выбираем, что показывать (public/js/media-sources.js: pickSession),
// и шлём серверу presence:listening — при изменении (не чаще раза в 2 с), повтор раз в 30 с, пока играет,
// null на паузе/остановке/выключении. Включено, пока user.showListening (настройка «Показывать, что я слушаю»).
// Дополнительно (prefs): activity.browsers — учитывать браузеры (по умолчанию нет), activity.hiddenSources —
// выключенные источники {sourceId: true}. В браузере модуль ничего не делает.
import { state, subscribe } from './state.js';
import { prefs } from './prefs.js';
import { emitAck, socketId } from './socket.js';
import { normalizeSession, pickSession, listSources, trackKey, livePosition } from './media-sources.js';

const MIN_GAP_MS = 2000;
const RESYNC_MS = 30_000;
const JUMP_MS = 3000;

const bridge = () => (window.sozvonDesktop?.isDesktop && window.sozvonDesktop.mediaWatch ? window.sozvonDesktop : null);
/** Есть ли «что играет на ПК» в этом клиенте (приложение для Windows с помощником) */
export const mediaAvailable = () => !!bridge();

let sessions = [];        // нормализованные сессии из последнего сообщения помощника
let watching = false;
let sent = null;          // что ушло серверу последним: {key, np} | null
let sentSocket = null;
let lastSentAt = 0;
let flushTimer = null;
let inflight = false;
const listeners = new Set();

/** Источники, о которых сейчас сообщает Windows: [{id, name, category, playing}] */
export const currentSources = () => listSources(sessions);
/** Подписка на изменение списка источников (для настроек); возвращает отписку */
export function onSourcesChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const enabled = () => !!state.user && state.user.showListening !== false && state.user.status !== 'invisible';

function opts() {
  return { browsers: !!prefs.get('activity.browsers'), hidden: prefs.get('activity.hiddenSources') || {}, prevKey: sent?.key || '' };
}

/** Что сейчас надо показывать: {key, np} | null */
function current(now = Date.now()) {
  if (!watching || !enabled()) return null;
  const t = pickSession(sessions.map((s) => ({ ...s })), { ...opts(), now });
  if (!t) return null;
  return {
    key: trackKey(t),
    np: {
      source: t.source.name.slice(0, 40), kind: t.source.category,
      title: t.title, artist: t.artist, album: t.album,
      durationMs: t.durationMs, positionMs: Math.round(livePosition(t, now)), at: now,
    },
  };
}

function changed(cur) {
  if (sentSocket !== socketId()) { // переподключились — сервер забыл (он сбрасывает при отключении сокета)
    if (cur) return true;
    sent = null;
    return false;
  }
  if (!cur || !sent) return !!cur !== !!sent;
  if (cur.key !== sent.key) return true;
  if (!cur.np.durationMs) return false; // без длины прогресса нет — и перемотку не ловим
  // перемотка: позиция ушла от ожидаемой
  const expect = livePosition({ ...sent.np, playing: true }, cur.np.at);
  return Math.abs(cur.np.positionMs - expect) > JUMP_MS;
}

function schedule(force = false) {
  if (!force && !changed(current())) return;
  if (flushTimer) return;
  const wait = Math.max(0, lastSentAt + MIN_GAP_MS - Date.now());
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, wait);
}

async function flush() {
  if (!state.connected) return;
  if (inflight) { schedule(true); return; }
  const cur = current();
  // ничего не играло и не играет (или сервер уже забыл после переподключения) — слать незачем
  if (!cur && (!sent || sentSocket !== socketId())) { sent = null; return; }
  inflight = true;
  lastSentAt = Date.now();
  const sock = socketId();
  try {
    await emitAck('presence:listening', cur ? cur.np : {});
    sent = cur;
    sentSocket = sock;
  } catch (e) {
    console.warn('[now-playing]', e?.message || e);
  } finally {
    inflight = false;
  }
  if (changed(current())) schedule();
}

function onMedia(list) {
  const now = Date.now();
  // плеер не сообщил, на какой момент позиция (updatedAt = 0): считаем её от первого раза, когда её увидели, —
  // иначе каждый повтор помощника (раз в 5 с) «отматывал» бы трек назад
  const prev = new Map(sessions.map((s) => [s.raw, s]));
  sessions = (Array.isArray(list) ? list : []).map((s) => {
    const t = normalizeSession(s, now);
    if (!t) return null;
    t.raw = `${s.app}|${s.artist}|${s.title}|${s.positionMs}|${s.updatedAt}|${s.playing}`;
    const p = !s.updatedAt ? prev.get(t.raw) : null;
    if (p) { t.at = p.at; t.positionMs = p.positionMs; }
    return t;
  }).filter(Boolean);
  for (const fn of listeners) { try { fn(); } catch (e) { console.warn('[now-playing]', e); } }
  schedule();
}

function apply() {
  const b = bridge();
  if (!b) return;
  const want = enabled() && state.connected;
  if (want !== watching) {
    watching = want;
    try { b.setMediaWatch(want); } catch { /* ignore */ }
    if (!want) { sessions = []; for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }
  }
  schedule();
}

export function initNowPlaying() {
  const b = bridge();
  if (!b) return;
  try { b.onMedia(onMedia); } catch (e) { console.warn('[now-playing]', e); return; }
  subscribe(['me', 'presence'], apply);
  prefs.subscribe('activity.', () => schedule(true));
  // повтор, пока играет: сервер забывает через 10 минут без обновлений, а позиция у смотрящих уплывает
  setInterval(() => { if (sent && Date.now() - lastSentAt >= RESYNC_MS - 500) schedule(true); }, 5000);
  apply();
}
