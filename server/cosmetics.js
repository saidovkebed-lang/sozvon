// Astra 2.0: оформление профилей и серверов (рамки аватаров, пресеты баннеров, значки, темы серверов).
// Здесь только данные и валидация — без побочных эффектов. Клиентские подписи — public/js/ui/cosmetics.js.
import { db } from './db.js';

/** Рамки аватара (SVG/CSS на клиенте). null — без рамки. */
export const AVATAR_FRAMES = ['orbit', 'nova', 'comet', 'aurora', 'eclipse', 'constellation'];
/** Анимированные пресеты баннера профиля (градиент/туманность). null — картинка или цвет. */
export const BANNER_PRESETS = ['nebula', 'aurora', 'galaxy', 'sunrise', 'deep'];
/** Космические фоны сервера. null — фон по умолчанию. */
export const SERVER_BACKGROUNDS = ['nebula', 'aurora', 'galaxy', 'eclipse', 'deep'];

/** Значки (автоматические, пользователь их не выбирает). */
export const BADGE_RULES = Object.freeze({
  veteranDays: 30,      // «Ветеран» — аккаунту больше N дней
  melomaneTracks: 5,    // «Меломан» — добавил в библиотеку бота не меньше N треков
});

const HEX = /^#[0-9a-f]{6}$/;

export function cleanHex(v) {
  if (v === null || v === undefined || v === '') return null;
  const c = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return HEX.test(c) ? c : undefined; // undefined — ошибка формата
}

/** Значение из списка или null. undefined — недопустимое значение. */
export function cleanChoice(v, list) {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  return typeof v === 'string' && list.includes(v) ? v : undefined;
}

/**
 * Тема сервера { accent, background } | null. Бросает Error с текстом для пользователя.
 * Пустая тема (оба null) хранится как null.
 */
export function cleanServerTheme(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Тема сервера: нужен объект { accent, background }');
  const accent = cleanHex(raw.accent);
  if (accent === undefined) throw new Error('Цвет акцента — в формате #rrggbb');
  const background = cleanChoice(raw.background, SERVER_BACKGROUNDS);
  if (background === undefined) throw new Error('Неизвестный фон сервера');
  return accent || background ? { accent, background } : null;
}

/** Тема сервера для клиента (старые/битые значения — null). */
export function publicServerTheme(s) {
  const t = s?.theme;
  if (!t || typeof t !== 'object') return null;
  const accent = cleanHex(t.accent) || null;
  const background = cleanChoice(t.background, SERVER_BACKGROUNDS) || null;
  return accent || background ? { accent, background } : null;
}

// ---------- «Меломан»: сколько треков добавил пользователь (addedBy — имя пользователя) ----------
let trackCounts = null;   // Map usernameLower -> count
let trackCountsKey = '';
function countsByUser() {
  const tracks = db.data.tracks || [];
  // ключ кэша: длина + последний трек — библиотека меняется редко, публичный профиль считается часто
  const last = tracks[tracks.length - 1];
  const key = `${tracks.length}:${last?.id || ''}:${last?.addedBy || ''}`;
  if (trackCounts && key === trackCountsKey) return trackCounts;
  trackCounts = new Map();
  for (const t of tracks) {
    if (typeof t.addedBy !== 'string' || !t.addedBy) continue;
    const k = t.addedBy.toLowerCase();
    trackCounts.set(k, (trackCounts.get(k) || 0) + 1);
  }
  trackCountsKey = key;
  return trackCounts;
}
export function tracksAddedBy(username) {
  return countsByUser().get(String(username || '').toLowerCase()) || 0;
}

/**
 * Автоматические значки пользователя (порядок = порядок показа).
 * «Основатель» считается на клиенте по контексту (владелец открытого сервера) и здесь — если владеет хоть одним сервером.
 */
export function computeBadges(u, now = Date.now()) {
  if (!u) return [];
  if (u.isBot) return ['bot'];
  const out = [];
  if (db.data.servers.some((s) => s.ownerId === u.id)) out.push('founder');
  if (Number.isFinite(u.createdAt) && now - u.createdAt >= BADGE_RULES.veteranDays * 86_400_000) out.push('veteran');
  if (tracksAddedBy(u.username) >= BADGE_RULES.melomaneTracks) out.push('melomane');
  if (Number.isFinite(u.streamedAt)) out.push('streamer');
  return out;
}

/** Отметить, что пользователь хотя бы раз показывал экран. true — отметка новая (надо разослать профиль). */
export function markStreamed(u) {
  if (!u || u.isBot || Number.isFinite(u.streamedAt)) return false;
  u.streamedAt = Date.now();
  return true;
}
