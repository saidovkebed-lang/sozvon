// REST для функций Telegram-бота (монтируется в /api из server/routes.js).
//   POST  /api/password-reset/request   { username } → { ok, message }   (ответ всегда одинаковый)
//   POST  /api/password-reset/check     { token } → { valid, username, needCode }
//   POST  /api/password-reset/complete  { token, password, code? } → { ok }   (все сеансы завершаются)
//   POST  /api/login/telegram           { username } → { challenge, expiresAt }   (ответ всегда одинаковый)
//   POST  /api/login/telegram/status    { challenge } → { pending } | { token, user } | { twoFactor, challenge, methods }
//   GET   /api/me/telegram              → { available, linked, account, bot, notify, passwordless }
//   PATCH /api/me/telegram              { notify?: {dm, mention, everyone, onlyAway}, pauseMinutes?, passwordless?, password? }
//                                       (включить вход без пароля — только с паролем; выключить — без)
import express from 'express';
import { requireAuth, HttpError, createSession } from './auth.js';
import { publicUser, findUserByName } from './model.js';
import { save } from './db.js';
import { Limiter, exempt, waitText } from './rate-limit.js';
import { createLoginChallenge, checkPassword } from './totp.js';
import { startPasswordless, pollPasswordless, telegramAvailable, telegramStatus } from './tg2fa.js';
import { requestReset, checkReset, completeReset } from './pwreset.js';
import { notifySettings, updateNotifySettings } from './tg-settings.js';
import { getMe } from './telegram.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createTelegramRouter({ onUserUpdated = () => {}, onSessionsRevoked = () => {} } = {}) {
  const router = express.Router();
  const pwlessByIp = new Limiter({ limit: 10, windowMs: 10 * 60_000 });
  const badPoll = new Limiter({ limit: 60, windowMs: 10 * 60_000 });
  const limited = (res, lim, ip, what) => {
    if (!ip || exempt(ip)) return;
    const w = lim.blockedFor(ip);
    if (w) { res.set('Retry-After', String(w)); throw new HttpError(429, `${what} Подождите ${waitText(w)} и попробуйте снова.`); }
  };

  /* ---------- сброс пароля ---------- */
  router.post('/password-reset/request', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(requestReset(req.body?.username, { ip: req.ip, ua: req.get('user-agent') || '' }));
    } catch (e) {
      if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
      throw e;
    }
  }));
  router.post('/password-reset/check', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(checkReset(req.body?.token, req.ip));
  }));
  router.post('/password-reset/complete', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { user, revoked } = await completeReset(req.body?.token, { password: req.body?.password, code: req.body?.code }, req.ip);
    onSessionsRevoked(user.id, revoked);
    res.json({ ok: true, username: user.username });
  }));

  /* ---------- вход без пароля ---------- */
  router.post('/login/telegram', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    limited(res, pwlessByIp, req.ip, 'Слишком много запросов входа через Telegram.');
    if (req.ip && !exempt(req.ip)) pwlessByIp.hit(req.ip);
    if (typeof req.body?.username !== 'string' || !req.body.username.trim()) throw new HttpError(400, 'Введите имя пользователя');
    if (!telegramAvailable()) throw new HttpError(503, 'Вход через Telegram не настроен на этом сервере', 'tg_unavailable');
    res.json(startPasswordless(req.body.username.slice(0, 64), { ip: req.ip, ua: req.get('user-agent') || '' }, findUserByName));
  }));

  router.post('/login/telegram/status', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    limited(res, badPoll, req.ip, 'Слишком много попыток.');
    let out;
    try { out = pollPasswordless(req.body?.challenge); } catch (e) {
      if (req.ip && !exempt(req.ip)) badPoll.hit(req.ip);
      throw e;
    }
    if (out.pending) return res.json({ pending: true });
    const { user } = out;
    if (user.totpEnabled === true) {
      // приложение-аутентификатор включено: после «✅ Войти» всё равно нужен код из него (или код восстановления)
      const challenge = createLoginChallenge(user, { ip: req.ip, ua: req.get('user-agent') || '' });
      return res.json({ twoFactor: true, challenge, methods: ['totp', 'recovery'], viaTelegram: true });
    }
    res.json({ token: createSession(user.id), user: publicUser(user, { self: true }) });
  }));

  /* ---------- настройки бота в Astra («Уведомления → Telegram») ---------- */
  const view = async (user) => {
    let bot = null;
    if (telegramAvailable()) {
      // имя бота — из кэша getMe; если Telegram не отвечает, страницу настроек не задерживаем дольше 3 с
      const timeout = new Promise((r) => { setTimeout(() => r(null), 3000).unref?.(); });
      try { bot = (await Promise.race([getMe(), timeout]))?.username || null; } catch { /* Telegram недоступен */ }
    }
    const st = telegramStatus(user);
    return { available: st.available, linked: st.enabled, account: st.account, bot, notify: notifySettings(user), passwordless: st.passwordless };
  };
  const noBot = (req) => { if (req.isBot || req.user?.isBot) throw new HttpError(403, 'Недоступно для бота'); };

  router.get('/me/telegram', requireAuth, wrap(async (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    res.json(await view(req.user));
  }));

  router.patch('/me/telegram', requireAuth, wrap(async (req, res) => {
    noBot(req);
    const b = req.body || {};
    const u = req.user;
    if (b.notify !== undefined || b.pauseMinutes !== undefined) {
      if (b.notify !== undefined && (typeof b.notify !== 'object' || Array.isArray(b.notify) || b.notify === null)) throw new HttpError(400, 'notify: объект');
      try { updateNotifySettings(u, { ...(b.notify || {}), ...(b.pauseMinutes !== undefined ? { pauseMinutes: b.pauseMinutes } : {}) }); } catch (e) { throw new HttpError(400, e.message); }
    }
    if (typeof b.passwordless === 'boolean') {
      if (u.tg2fa !== true) throw new HttpError(400, 'Сначала привяжите Telegram');
      if (b.passwordless && u.tgLogin !== true) await checkPassword(u, b.password); // включить — только с паролем
      u.tgLogin = b.passwordless;
    }
    save();
    onUserUpdated(u, {});
    res.json(await view(u));
  }));

  return router;
}
