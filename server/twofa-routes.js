// REST двухфакторной защиты (server/totp.js). Монтируется в /api (server/routes.js).
//   POST /api/login/2fa                 { challenge, code } → { token, user }  (второй шаг входа)
//   GET  /api/me/2fa                    → { enabled, recoveryCodesLeft, enabledAt }
//   POST /api/me/2fa/setup              { password } → { secret, uri, ... }
//   POST /api/me/2fa/enable             { code } → { recoveryCodes, user }
//   POST /api/me/2fa/disable            { password, code } → { user }
//   POST /api/me/2fa/recovery-codes     { password, code } → { recoveryCodes }
//   POST /api/me/sessions/revoke-others → { revoked }  («Выйти на других устройствах»)
import express from 'express';
import { requireAuth, HttpError, createSession } from './auth.js';
import { publicUser } from './model.js';
import { db, save } from './db.js';
import {
  completeLoginChallenge, twoFactorStatus, startEnrollment, confirmEnrollment,
  disableTwoFactor, regenerateRecoveryCodes,
} from './totp.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const noBot = (req) => { if (req.isBot || req.user?.isBot) throw new HttpError(403, 'Недоступно для бота'); };

export function createTwoFactorRouter({ onUserUpdated = () => {}, onSessionsRevoked = () => {} } = {}) {
  const router = express.Router();

  router.post('/login/2fa', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { user } = completeLoginChallenge(req.body?.challenge, req.body?.code, req.ip);
    res.json({ token: createSession(user.id), user: publicUser(user, { self: true }) });
  }));

  router.get('/me/2fa', requireAuth, (req, res) => {
    noBot(req);
    res.set('Cache-Control', 'no-store');
    res.json(twoFactorStatus(req.user));
  });

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
