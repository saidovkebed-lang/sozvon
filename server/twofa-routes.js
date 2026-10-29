// REST двухфакторной защиты (server/totp.js). Монтируется в /api (server/routes.js).
//   POST /api/login/2fa                 { challenge, code } → { token, user }  (второй шаг входа)
//   GET  /api/me/2fa                    → { enabled, recoveryCodesLeft, enabledAt }
//   POST /api/me/2fa/setup              { password } → { secret, uri, ... }
//   POST /api/me/2fa/enable             { code } → { recoveryCodes, user }
//   POST /api/me/2fa/disable            { password, code } → { user }
//   POST /api/me/2fa/recovery-codes     { password, code } → { recoveryCodes }
//   POST /api/me/sessions/revoke-others → { revoked }  («Выйти на других устройствах»)
// Telegram (server/tg2fa.js):
//   POST /api/login/2fa/status          { challenge } → { token, user } (нажато «Это я») | { pending, telegram }
//   POST /api/login/2fa/resend          { challenge } → { telegram }  (не чаще 1 раза в 30 с и 5 раз за 15 минут)
//   POST /api/me/2fa/telegram/link      { password, passwordless? } → { link, bot, expiresAt }  (ссылка t.me/<бот>?start=…, 10 минут;
//                                       passwordless — «Вход без пароля через Telegram», по умолчанию true)
//   GET  /api/me/2fa/telegram/link      → { linked, pending, recoveryCodes? }    (опрос во время привязки)
//   DELETE /api/me/2fa/telegram/link    — отменить ссылку
//   POST /api/me/2fa/telegram/code      → { telegram }  (код для действия в настройках)
//   POST /api/me/2fa/telegram/unlink    { password, code } → { user }
import express from 'express';
import { requireAuth, HttpError, createSession } from './auth.js';
import { publicUser } from './model.js';
import { db, save } from './db.js';
import {
  completeLoginChallenge, pollLoginChallenge, twoFactorStatus, startEnrollment, confirmEnrollment,
  disableTwoFactor, regenerateRecoveryCodes,
} from './totp.js';
import {
  initTelegram2FA, loginCompleted, loginTelegramState, resendLoginTelegram, deniedError,
  startLink, cancelLink, linkStatus, telegramStatus, sendActionCode, unlinkTelegram,
} from './tg2fa.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const noBot = (req) => { if (req.isBot || req.user?.isBot) throw new HttpError(403, 'Недоступно для бота'); };

export function createTwoFactorRouter({ onUserUpdated = () => {}, onSessionsRevoked = () => {}, dataDir = null } = {}) {
  const router = express.Router();
  initTelegram2FA({ dataDir, onUserUpdated });

  router.post('/login/2fa', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const challenge = req.body?.challenge;
    const { user } = completeLoginChallenge(challenge, req.body?.code, req.ip);
    loginCompleted(challenge);
    res.json({ token: createSession(user.id), user: publicUser(user, { self: true }) });
  }));

  // опрос экрана входа: подтверждено ли «Это я» в Telegram, дошёл ли код
  router.post('/login/2fa/status', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const challenge = req.body?.challenge;
    const { done } = pollLoginChallenge(challenge, req.ip, { whyInvalid: deniedError });
    if (done) {
      loginCompleted(challenge);
      return res.json({ token: createSession(done.user.id), user: publicUser(done.user, { self: true }) });
    }
    res.json({ pending: true, telegram: loginTelegramState(challenge) });
  }));

  router.post('/login/2fa/resend', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ telegram: resendLoginTelegram(req.body?.challenge) }); // 429 tg_resend_limited / tg_locked (Retry-After)
  }));

  router.get('/me/2fa', requireAuth, (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    res.json({ ...twoFactorStatus(req.user), telegram: telegramStatus(req.user) });
  });

  router.post('/me/2fa/telegram/link', requireAuth, wrap(async (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    res.json(await startLink(req.user, req.body?.password, { passwordless: req.body?.passwordless !== false }));
  }));

  router.get('/me/2fa/telegram/link', requireAuth, (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    const st = linkStatus(req.user);
    res.json(st.linked ? { ...st, user: publicUser(req.user, { self: true }) } : st);
  });

  router.delete('/me/2fa/telegram/link', requireAuth, (req, res) => {
    noBot(req);
    cancelLink(req.user);
    res.json({ ok: true });
  });

  router.post('/me/2fa/telegram/code', requireAuth, wrap(async (req, res) => {
    noBot(req);
    res.json({ telegram: sendActionCode(req.user) });
  }));

  router.post('/me/2fa/telegram/unlink', requireAuth, wrap(async (req, res) => {
    noBot(req);
    await unlinkTelegram(req.user, req.body || {}, req.ip);
    onUserUpdated(req.user, {});
    res.json({ user: publicUser(req.user, { self: true }) });
  }));

  router.post('/me/2fa/setup', requireAuth, wrap(async (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    res.json(await startEnrollment(req.user, req.body?.password));
  }));

  router.post('/me/2fa/enable', requireAuth, wrap(async (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    const { recoveryCodes } = confirmEnrollment(req.user, req.body?.code, req.ip);
    onUserUpdated(req.user, {});
    res.json({ recoveryCodes, user: publicUser(req.user, { self: true }) });
  }));

  router.post('/me/2fa/disable', requireAuth, wrap(async (req, res) => {
    noBot(req);
    await disableTwoFactor(req.user, req.body || {}, req.ip);
    onUserUpdated(req.user, {});
    res.json({ user: publicUser(req.user, { self: true }) });
  }));

  router.post('/me/2fa/recovery-codes', requireAuth, wrap(async (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    res.json(await regenerateRecoveryCodes(req.user, req.body || {}, req.ip));
  }));

  router.post('/me/sessions/revoke-others', requireAuth, (req, res) => {
    noBot(req);
    const revoked = [];
    for (const [token, s] of Object.entries(db.data.sessions)) {
      if (s.userId === req.user.id && token !== req.token) { delete db.data.sessions[token]; revoked.push(token); }
    }
    if (revoked.length) save();
    onSessionsRevoked(req.user.id, revoked);
    res.json({ revoked: revoked.length });
  });

  return router;
}
