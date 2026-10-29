// Сброс пароля через Telegram-бота (только для аккаунтов с привязанным Telegram, server/tg2fa.js).
//
// Запрос (страница входа «Забыли пароль?» или меню бота «🔐 Безопасность» → «🔑 Сбросить пароль»): бот
// присылает одноразовую ссылку <PUBLIC_URL>/reset-password#t=<токен> (кнопкой «🔑 Сброс пароля»):
//   • 15 минут, один раз; хранится только sha256(токена) — в памяти процесса (перезапуск = ссылка недействительна);
//   • новая ссылка отменяет прежнюю; кнопка «⛔ Это не я» отменяет ссылку и пишет событие в журнал безопасности;
//   • токен — во фрагменте (#t=…): браузер не отправляет его на сервер при открытии страницы, он не попадает в
//     журналы nginx и Referer; на сервер он уходит только POST-запросом;
//   • адрес ссылки — только из PUBLIC_URL (или туннеля), НЕ из заголовка Host запроса (иначе подделанный Host
//     привёл бы ссылку со свежим токеном на чужой сайт).
// Ответ на запрос всегда одинаковый — не видно, есть ли такой пользователь и привязан ли у него Telegram.
// Лимиты: 5 запросов с адреса за 15 минут; на аккаунт — общий лимит сообщений бота (30 с / 5 за 15 минут).
// Установка нового пароля: если у пользователя есть приложение-аутентификатор — нужен ещё код из него или код
// восстановления (одного Telegram мало); после смены завершаются ВСЕ сеансы.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, save } from './db.js';
import { HttpError } from './http-error.js';
import { findUserByName } from './model.js';
import { Limiter, exempt, waitText } from './rate-limit.js';
import { sendMessage, editMessageText, answerCallbackQuery } from './telegram.js';
import { checkUserCode } from './totp.js';
import { telegramAvailable, tgLockedFor, tgSendWait, tgNoteSend, uaSummary, maskIp } from './tg2fa.js';
import { publicBase, urlButtonOk } from './tg-settings.js';
import { audit } from './admin/audit.js';

const envMs = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };
const RESET_TTL_MS = () => envMs('PWRESET_TTL_MS', 15 * 60_000);
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const resets = new Map(); // sha256(токен) → { id, userId, exp, pw, chatId, messageId }
const byIp = new Limiter({ limit: 5, windowMs: 15 * 60_000 });
const badTokens = new Limiter({ limit: 20, windowMs: 15 * 60_000 });

export const GENERIC_RESET = 'Если такой аккаунт есть и к нему привязан Telegram, бот Astra пришлёт ссылку для сброса пароля. Ссылка действует 15 минут.';

const findUser = (id) => db.data.users.find((u) => u.id === id) || null;
function dropForUser(userId) {
  for (const [k, r] of resets) if (r.userId === userId) { resets.delete(k); finishMessage(r, '⌛ Ссылка для сброса пароля больше не действует'); }
}
function finishMessage(r, text) {
  if (r?.messageId) editMessageText(r.chatId, r.messageId, text).catch(() => {});
}

/**
 * Отправить ссылку сброса (если возможно). Возвращает true/false только для бота (там пользователь известен);
 * веб-ответ всегда общий. source: 'web' | 'bot'.
 */
export function sendResetLink(user, { ip = null, ua = '', source = 'web' } = {}) {
  if (!user || user.isBot || user.instanceBan || user.tg2fa !== true || !user.tgChatId) return { ok: false, why: 'unlinked' };
  if (!telegramAvailable()) return { ok: false, why: 'unavailable' };
  if (tgLockedFor(user)) return { ok: false, why: 'locked' };
  const wait = tgSendWait(user.id);
  if (wait) return { ok: false, why: 'limited', wait };
  const base = publicBase();
  if (!base) { console.warn('[pwreset] Не задан PUBLIC_URL — ссылку для сброса пароля не из чего собрать'); return { ok: false, why: 'no_url' }; }
  dropForUser(user.id);
  const token = crypto.randomBytes(32).toString('base64url');
  const r = { id: crypto.randomBytes(12).toString('base64url'), userId: user.id, exp: Date.now() + RESET_TTL_MS(), pw: user.passwordHash, chatId: String(user.tgChatId), messageId: null };
  resets.set(hash(token), r);
  tgNoteSend(user.id);
  const link = `${base}/reset-password#t=${token}`;
  const lines = [
    '🔑 Сброс пароля Astra',
    `Аккаунт: ${user.username}`,
    source === 'web' ? `Запрос со страницы входа: ${uaSummary(ua)}, IP ${maskIp(ip)}` : 'Запрос из этого чата (меню бота).',
    'Ссылка действует 15 минут и сработает один раз.',
    ...(user.totpEnabled ? ['Понадобится ещё код из приложения-аутентификатора или код восстановления.'] : []),
    'Если это не вы — нажмите «Это не я»; пароль останется прежним.',
  ];
  const button = urlButtonOk(link);
  if (!button) lines.push('', `Ссылка: ${link}`);
  const kb = [[...(button ? [{ text: '🔑 Сброс пароля', url: link, style: 'primary' }] : []), { text: '⛔ Это не я', callback_data: `rs:${r.id}`, style: 'danger' }]];
  sendMessage(r.chatId, lines.join('\n'), { reply_markup: { inline_keyboard: kb } })
    .then((m) => { r.messageId = m?.message_id ?? null; })
    .catch((err) => console.warn(`[pwreset] Ссылка не отправлена (${user.username}): ${err.message}`));
  audit(user, 'security.password_reset_requested', { type: 'user', id: user.id, name: user.username }, { source, ip: maskIp(ip) }, ip || undefined);
  return { ok: true };
}

/** POST /api/password-reset/request — ответ всегда общий. */
export function requestReset(username, { ip, ua }) {
  if (ip && !exempt(ip)) {
    const w = byIp.blockedFor(ip);
    if (w) throw Object.assign(new HttpError(429, `Слишком много запросов. Подождите ${waitText(w)} и попробуйте снова.`), { retryAfter: w });
    byIp.hit(ip);
  }
  const name = typeof username === 'string' ? username.trim().replace(/\s+/g, ' ').slice(0, 64) : '';
  if (!name) throw new HttpError(400, 'Введите имя пользователя');
  const user = findUserByName(name);
  if (user) sendResetLink(user, { ip, ua, source: 'web' });
  return { ok: true, message: GENERIC_RESET };
}

function lookup(token, ip) {
  const limitIp = ip && !exempt(ip);
  if (limitIp) {
    const w = badTokens.blockedFor(ip);
    if (w) throw Object.assign(new HttpError(429, `Слишком много попыток. Подождите ${waitText(w)}.`), { retryAfter: w });
  }
  const r = typeof token === 'string' && token.length >= 20 && token.length <= 100 ? resets.get(hash(token)) : null;
  const user = r && findUser(r.userId);
  if (!r || r.exp <= Date.now() || !user || user.passwordHash !== r.pw || user.tg2fa !== true || user.instanceBan) {
    if (limitIp) badTokens.hit(ip);
    throw new HttpError(400, 'Ссылка для сброса пароля недействительна или устарела. Запросите новую.', 'reset_invalid');
  }
  return { r, user };
}

/** POST /api/password-reset/check — для страницы сброса: { username, needCode }. */
export function checkReset(token, ip) {
  const { user } = lookup(token, ip);
  return { valid: true, username: user.username, needCode: user.totpEnabled === true };
}

/** POST /api/password-reset/complete — новый пароль (+ код, если есть приложение). Возвращает отозванные сеансы. */
export async function completeReset(token, { password, code } = {}, ip) {
  const { r, user } = lookup(token, ip);
  if (typeof password !== 'string' || password.length < 4) throw new HttpError(400, 'Пароль должен быть не короче 4 символов');
  if (password.length > 128) throw new HttpError(400, 'Пароль слишком длинный (максимум 128 символов)');
  // одного Telegram мало, если включено приложение-аутентификатор: код из него или код восстановления
  if (user.totpEnabled === true) checkUserCode(user, code, { ip, allowRecovery: true, status: 403, tg: null });
  const newHash = await bcrypt.hash(password, 10);
  // повторная проверка после await: ссылка одноразовая (два одновременных запроса)
  if (!resets.has(hash(token)) || user.passwordHash !== r.pw) throw new HttpError(400, 'Ссылка для сброса пароля уже использована.', 'reset_invalid');
  resets.delete(hash(token));
  user.passwordHash = newHash;
  delete user.mustChangePassword;
  const revoked = [];
  for (const [t, s] of Object.entries(db.data.sessions)) {
    if (s.userId === user.id) { delete db.data.sessions[t]; revoked.push(t); }
  }
  save();
  dropForUser(user.id);
  finishMessage(r, '✅ Пароль изменён по ссылке из этого сообщения');
  if (user.tgChatId) {
    sendMessage(user.tgChatId, `✅ Пароль Astra для «${user.username}» изменён (${maskIp(ip)}). Все сеансы завершены — войдите с новым паролем.\nЕсли это были не вы — срочно сбросьте пароль снова и проверьте настройки безопасности.`).catch(() => {});
  }
  audit(user, 'security.password_reset', { type: 'user', id: user.id, name: user.username }, { sessions: revoked.length, ip: maskIp(ip) }, ip || undefined);
  return { user, revoked };
}

/** Кнопка «⛔ Это не я» под ссылкой (callback rs:<id>). true — обработано. */
export async function handleResetCallback(q, chatId) {
  const m = String(q.data || '').match(/^rs:([A-Za-z0-9_-]{16})$/);
  if (!m) return false;
  let found = null;
  for (const [k, r] of resets) if (r.id === m[1]) found = [k, r];
  const user = found && findUser(found[1].userId);
  if (!found || !user || String(user.tgChatId) !== chatId || found[1].chatId !== chatId) {
    await answerCallbackQuery(q.id, 'Ссылка уже недействительна').catch(() => {});
    return true;
  }
  resets.delete(found[0]);
  finishMessage(found[1], '⛔ Ссылка для сброса пароля отменена');
  audit(user, 'security.password_reset_denied', { type: 'user', id: user.id, name: user.username }, null);
  await answerCallbackQuery(q.id, 'Ссылка отменена').catch(() => {});
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of resets) if (r.exp <= now) { resets.delete(k); finishMessage(r, '⌛ Ссылка для сброса пароля истекла'); }
}, 30_000).unref();
