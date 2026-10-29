// Настройки Telegram-бота у пользователя (db.json, поле user.tgNotify) и публичный адрес Astra для ссылок.
//   tgNotify: { dm, mention, everyone, onlyAway, pauseUntil }
//     dm / mention / everyone — какие события пересылать в Telegram (по умолчанию: ЛС и упоминания — да,
//                               @everyone — нет, чтобы не заваливать чат);
//     onlyAway  — «только когда я не в Astra» (нет открытой видимой вкладки/окна; как у push), по умолчанию да;
//     pauseUntil — пауза до момента (мс), 0 — без паузы.
// Статус «Не беспокоить» (dnd) выключает пересылку так же, как push.
import { getPublicUrl } from './tunnel.js';

export const NOTIFY_DEFAULTS = { dm: true, mention: true, everyone: false, onlyAway: true, pauseUntil: 0 };
const BOOL_KEYS = ['dm', 'mention', 'everyone', 'onlyAway'];
const MAX_PAUSE_MS = 7 * 24 * 3600_000;

export function notifySettings(user) {
  const n = user?.tgNotify && typeof user.tgNotify === 'object' ? user.tgNotify : {};
  const out = { ...NOTIFY_DEFAULTS };
  for (const k of BOOL_KEYS) if (typeof n[k] === 'boolean') out[k] = n[k];
  const p = Number(n.pauseUntil) || 0;
  out.pauseUntil = p > Date.now() ? p : 0;
  return out;
}

/** Изменить настройки (проверка типов). pauseMinutes: 0 — снять паузу, иначе минут (до 7 дней). */
export function updateNotifySettings(user, patch = {}) {
  const cur = notifySettings(user);
  for (const k of BOOL_KEYS) if (typeof patch[k] === 'boolean') cur[k] = patch[k];
  if (patch.pauseMinutes !== undefined) {
    const m = Number(patch.pauseMinutes);
    if (!Number.isFinite(m) || m < 0) throw new Error('pauseMinutes: число минут');
    cur.pauseUntil = m === 0 ? 0 : Date.now() + Math.min(m * 60_000, MAX_PAUSE_MS);
  }
  user.tgNotify = cur;
  return cur;
}

/** Публичный адрес Astra (PUBLIC_URL или ссылка туннеля) без «/» в конце; '' — неизвестен. */
export function publicBase() {
  const raw = String(process.env.PUBLIC_URL || getPublicUrl() || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? raw : '';
  } catch { return ''; }
}

/** Можно ли дать адрес URL-кнопкой Telegram (только https — http и localhost Telegram отвергает). */
export const urlButtonOk = (url) => /^https:\/\/[^/]+\.[^/]+/.test(String(url || ''));
