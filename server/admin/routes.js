// REST админ-панели экземпляра: /api/admin/*. Подключается в server/index.js ДО основного /api.
// Кроме /api/admin этот роутер:
//   • не пускает заблокированные аккаунты (вход и уже выданные токены),
//   • для аккаунта с временным паролем (сброшен администратором) разрешает только смену пароля.
// Все /api/admin/* (кроме /api/admin/me): сессия + администратор экземпляра + 2FA (requireAdmin2FA),
// ограничение частоты, запись в журнал аудита. ЛС, хэши паролей, токены и секреты не отдаются никогда.
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { db, save } from '../db.js';
import { HttpError, requireAuth } from '../auth.js';
import { findUser, findServer, findChannel, serverChannels, publicServer, publicMessage, isOnline, userServers } from '../model.js';
import { Limiter } from '../rate-limit.js';
import {
  isInstanceAdmin, isEnvAdmin, requireAdmin2FA, admin2faRequired, listAdmins, mustChangePassword,
} from './access.js';
import { audit, readAudit } from './audit.js';
import { collectHealth } from './health.js';
import { alertsInfo, setToggles, sendTelegram, runChecks, telegramConfig } from './alerts.js';
import { updateState, requestUpdate, readUpdateLog, UpdateError } from './update.js';
import { OpError } from './ops.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MSG_2FA = 'Включите двухфакторную защиту, чтобы открыть админ-панель';

function cleanName(raw, max = 50) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Название: введите текст');
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, 'Название не может быть пустым');
  if (n.length > max) throw new HttpError(400, `Название слишком длинное (максимум ${max} символов)`);
  return n;
}

/** Временный пароль: 12 символов без похожих (0/O, 1/l/I). */
function tempPassword() {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}

/** Удалить все сессии пользователя. Возвращает удалённые токены. */
function revokeSessions(userId) {
  const tokens = [];
  for (const [t, s] of Object.entries(db.data.sessions)) if (s.userId === userId) { delete db.data.sessions[t]; tokens.push(t); }
  save();
  return tokens;
}

const brief = (u) => (u ? { id: u.id, username: u.username, displayName: u.displayName ?? null, avatar: u.avatar ?? null, color: u.color } : null);

function lastActivity(server) {
  let last = server.createdAt || 0;
  for (const c of serverChannels(server.id)) {
    const list = db.data.messages[c.id];
    const m = list?.[list.length - 1];
    if (m && m.createdAt > last) last = m.createdAt;
  }
  return last || null;
}

function serverRow(s) {
  const chans = serverChannels(s.id);
  return {
    id: s.id, name: s.name, icon: s.icon ?? null, createdAt: s.createdAt ?? null, lastActivity: lastActivity(s),
    owner: brief(findUser(s.ownerId)),
    members: s.memberIds.filter((id) => !findUser(id)?.isBot).length,
    channels: { text: chans.filter((c) => c.type === 'text').length, voice: chans.filter((c) => c.type === 'voice').length },
    bans: Object.keys(s.bans || {}).length,
  };
}

function userRow(u) {
  const sessions = Object.values(db.data.sessions).filter((s) => s.userId === u.id);
  return {
    id: u.id, username: u.username, displayName: u.displayName ?? null, avatar: u.avatar ?? null, color: u.color,
    createdAt: u.createdAt ?? null, online: isOnline(u.id),
    lastSeen: isOnline(u.id) ? Date.now() : (u.lastSeenAt || sessions.reduce((m, s) => Math.max(m, s.createdAt || 0), 0) || null),
    servers: userServers(u.id).length, sessions: sessions.length,
    flags: {
      admin: isInstanceAdmin(u), envAdmin: isEnvAdmin(u), banned: !!u.instanceBan,
      mustChangePassword: mustChangePassword(u), totpEnabled: u.totpEnabled === true,
    },
    ban: u.instanceBan ? { at: u.instanceBan.at, reason: u.instanceBan.reason || '', by: brief(findUser(u.instanceBan.by)) } : null,
  };
}

const match = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

export function createAdminRouter({ realtime }) {
  const ops = () => realtime.adminOps;
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  // ---------- вход: заблокированный аккаунт не получает сессию; временный пароль — флаг в ответе ----------
  router.use((req, res, next) => {
    if (req.method !== 'POST' || !/^\/login(\/|$)/.test(req.path)) return next();
    const orig = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body.token === 'string') {
        const u = findUser(db.data.sessions[body.token]?.userId);
        if (u?.instanceBan) {
          delete db.data.sessions[body.token];
          save();
          res.status(403);
          return orig({ error: 'Аккаунт заблокирован администратором', code: 'account_banned' });
        }
        if (u && mustChangePassword(u)) return orig({ ...body, mustChangePassword: true });
      }
      return orig(body);
    };
    next();
  });

  // ---------- заблокированные токены и обязательная смена временного пароля ----------
  const ALLOWED_WITH_TEMP = new Set(['GET /me', 'POST /me/password', 'GET /config', 'GET /admin/me', 'GET /app/latest', 'GET /push/key', 'POST /push/unsubscribe']);
  router.use((req, res, next) => {
    const [scheme, value] = String(req.get('authorization') || '').split(' ');
    if (!/^bearer$/i.test(scheme || '')) return next();
    const s = db.data.sessions[value];
    const u = s && findUser(s.userId);
    if (!u || u.isBot) return next();
    if (u.instanceBan) {
      delete db.data.sessions[value];
      save();
      return res.status(401).json({ error: 'Аккаунт заблокирован администратором', code: 'account_banned' });
    }
    if (mustChangePassword(u) && !ALLOWED_WITH_TEMP.has(`${req.method} ${req.path}`)) {
      return res.status(403).json({ error: 'Сначала смените временный пароль', code: 'password_change_required' });
    }
    next();
  });

  // ---------- статус для клиента (любой вошедший) ----------
  router.get('/admin/me', requireAuth, (req, res) => {
    const admin = !req.isBot && isInstanceAdmin(req.user);
    res.json({
      admin,
      active: admin && requireAdmin2FA(req.user),
      require2fa: admin ? admin2faRequired() : undefined,
      totpEnabled: admin ? req.user.totpEnabled === true : undefined,
      mustChangePassword: mustChangePassword(req.user),
    });
  });

  // ---------- защита /admin/* ----------
  const readLimit = new Limiter({ limit: 600, windowMs: 5 * 60_000 });
  const writeLimit = new Limiter({ limit: 120, windowMs: 5 * 60_000 });
  const probeLimit = new Limiter({ limit: 60, windowMs: 5 * 60_000 });
  router.use('/admin', requireAuth, (req, res, next) => {
    if (req.isBot || !isInstanceAdmin(req.user)) {
      const k = `x:${req.user?.id}`;
      if (probeLimit.blockedFor(k)) return res.status(429).json({ error: 'Слишком много запросов' });
      probeLimit.hit(k);
      return res.status(403).json({ error: 'Нет доступа', code: 'not_admin' });
    }
    if (!requireAdmin2FA(req.user)) return res.status(403).json({ error: MSG_2FA, code: 'admin_2fa_required' });
    const lim = req.method === 'GET' ? readLimit : writeLimit;
    const key = req.user.id;
    const wait = lim.blockedFor(key);
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'Слишком много действий подряд — подождите немного' }); }
    lim.hit(key);
    next();
  });

  const act = (req, action, target, details) => audit(req.user, action, target, details, req.ip);
  const T = {
    server: (s) => ({ type: 'server', id: s.id, name: s.name }),
    user: (u) => ({ type: 'user', id: u.id, name: u.username }),
    channel: (c) => ({ type: 'channel', id: c.id, name: c.name }),
  };
  function getServer(id) {
    const s = findServer(String(id));
    if (!s) throw new HttpError(404, 'Сервер не найден');
    return s;
  }
  function getUser(id) {
    const u = findUser(String(id));
    if (!u) throw new HttpError(404, 'Пользователь не найден');
    if (u.isBot) throw new HttpError(400, 'С ботом так нельзя');
    return u;
  }
  /** Ошибки действий (OpError) → 400 */
  const run = (fn) => { try { return fn(); } catch (e) { if (e instanceof OpError) throw new HttpError(400, e.message); throw e; } };

  // ================= серверы =================
  router.get('/admin/servers', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const list = db.data.servers.filter((s) => match(q, s.name, s.id, findUser(s.ownerId)?.username)).map(serverRow)
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    res.json({ servers: list, total: db.data.servers.length });
  });

  router.get('/admin/servers/:id', (req, res) => {
    const s = getServer(req.params.id);
    const pub = publicServer(s, req.user.id); // администратор видит все каналы, инвайт и баны
    res.json({
      server: (() => { const row = serverRow(s); return { ...pub, ...row, members: undefined, memberCount: row.members }; })(),
      members: s.memberIds.map((id) => findUser(id)).filter((u) => u && !u.isBot).map((u) => ({
        ...brief(u), online: isOnline(u.id), roles: [...(s.memberRoles?.[u.id] || [])], owner: u.id === s.ownerId,
      })),
      channels: serverChannels(s.id).map((c) => ({ id: c.id, name: c.name, type: c.type, position: c.position, messages: (db.data.messages[c.id] || []).length })),
      isMember: s.memberIds.includes(req.user.id),
    });
  });

  router.patch('/admin/servers/:id', (req, res) => {
    const s = getServer(req.params.id);
    const name = cleanName(req.body?.name);
    const old = s.name;
    run(() => ops().rename(s, name));
    act(req, 'server.rename', T.server(s), { from: old, to: name });
    res.json({ server: serverRow(s) });
  });

  router.post('/admin/servers/:id/transfer', (req, res) => {
    const s = getServer(req.params.id);
    const prev = s.ownerId;
    const t = run(() => ops().transfer(s, String(req.body?.userId || '')));
    act(req, 'server.transfer', T.server(s), { from: findUser(prev)?.username || prev, to: t.username });
    res.json({ server: serverRow(s) });
  });

  router.delete('/admin/servers/:id', (req, res) => {
    const s = getServer(req.params.id);
    if (req.body?.confirmName !== s.name) throw new HttpError(400, 'Для удаления введите название сервера точно');
    run(() => ops().deleteServer(s));
    act(req, 'server.delete', T.server(s), { members: s.memberIds.length });
    res.json({ ok: true });
  });

  router.post('/admin/servers/:id/join', (req, res) => {
    const s = getServer(req.params.id);
    const already = s.memberIds.includes(req.user.id);
    run(() => ops().join(s, req.user));
    if (!already) act(req, 'server.join', T.server(s));
    res.json({ ok: true, server: publicServer(s, req.user.id) });
  });

  router.post('/admin/servers/:id/members/:uid/kick', (req, res) => {
    const s = getServer(req.params.id);
    const t = run(() => ops().kick(s, req.params.uid));
    act(req, 'member.kick', T.server(s), { user: t.username });
    res.json({ ok: true });
  });

  router.post('/admin/servers/:id/members/:uid/ban', (req, res) => {
    const s = getServer(req.params.id);
    const reason = String(req.body?.reason || '').slice(0, 300);
    const t = run(() => ops().ban(s, req.params.uid, reason, req.user.id));
    act(req, 'member.ban', T.server(s), { user: t.username, reason });
    res.json({ ok: true });
  });

  router.delete('/admin/servers/:id/bans/:uid', (req, res) => {
    const s = getServer(req.params.id);
    run(() => ops().unban(s, req.params.uid));
    act(req, 'member.unban', T.server(s), { user: findUser(req.params.uid)?.username || req.params.uid });
    res.json({ ok: true });
  });

  router.put('/admin/servers/:id/members/:uid/roles', (req, res) => {
    const s = getServer(req.params.id);
    const t = run(() => ops().setMemberRoles(s, req.params.uid, req.body?.roleIds));
    act(req, 'member.roles', T.server(s), { user: t.username, roles: (s.memberRoles[t.id] || []).length });
    res.json({ ok: true, roles: [...(s.memberRoles[t.id] || [])] });
  });

  router.patch('/admin/servers/:id/roles/:rid', (req, res) => {
    const s = getServer(req.params.id);
    const b = req.body || {};
    const role = run(() => ops().updateRole(s, req.params.rid, { name: b.name, color: b.color, permissions: b.permissions }));
    act(req, 'role.update', T.server(s), { role: role.name });
    res.json({ role: { ...role } });
  });

  router.delete('/admin/servers/:id/roles/:rid', (req, res) => {
    const s = getServer(req.params.id);
    const role = run(() => ops().deleteRole(s, req.params.rid));
    act(req, 'role.delete', T.server(s), { role: role.name });
    res.json({ ok: true });
  });

  // ---------- каналы и сообщения (только каналы серверов; ЛС сюда не попадают) ----------
  function serverChannel(id) {
    const c = findChannel(String(id));
    const s = c && findServer(c.serverId);
    if (!c || !s) throw new HttpError(404, 'Канал не найден');
    return { c, s };
  }

  router.get('/admin/channels/:id/messages', (req, res) => {
    const { c, s } = serverChannel(req.params.id);
    if (c.type !== 'text') throw new HttpError(400, 'Это не текстовый канал');
    let list = db.data.messages[c.id] || [];
    const before = Number(req.query.before);
    if (Number.isFinite(before)) list = list.filter((m) => m.createdAt < before);
    act(req, 'channel.read', T.channel(c), { server: s.name });
    res.json({ messages: list.slice(-50).map(publicMessage) });
  });

  router.delete('/admin/channels/:id', (req, res) => {
    const { c, s } = serverChannel(req.params.id);
    run(() => ops().deleteChannel(s, c));
    act(req, 'channel.delete', T.channel(c), { server: s.name });
    res.json({ ok: true });
  });

  router.delete('/admin/messages/:id', (req, res) => {
    const id = String(req.params.id);
    for (const c of db.data.channels) { // только каналы серверов
      const m = (db.data.messages[c.id] || []).find((x) => x.id === id);
      if (!m) continue;
      run(() => ops().deleteMessage(c.id, id));
      act(req, 'message.delete', T.channel(c), { server: findServer(c.serverId)?.name, author: findUser(m.authorId)?.username || null });
      return res.json({ ok: true });
    }
    throw new HttpError(404, 'Сообщение не найдено');
  });

  // ================= пользователи =================
  router.get('/admin/users', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const list = db.data.users.filter((u) => !u.isBot && match(q, u.username, u.displayName, u.id)).map(userRow)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    res.json({ users: list, total: db.data.users.filter((u) => !u.isBot).length });
  });

  router.get('/admin/users/:id', (req, res) => {
    const u = getUser(req.params.id);
    res.json({
      user: userRow(u),
      servers: userServers(u.id).map((s) => ({ id: s.id, name: s.name, icon: s.icon ?? null, owner: s.ownerId === u.id })),
    });
  });

  router.post('/admin/users/:id/ban', (req, res) => {
    const u = getUser(req.params.id);
    if (u.id === req.user.id) throw new HttpError(400, 'Нельзя заблокировать себя');
    if (isInstanceAdmin(u)) throw new HttpError(400, 'Сначала снимите с него права администратора');
    const reason = String(req.body?.reason || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    u.instanceBan = { at: Date.now(), by: req.user.id, reason };
    const tokens = revokeSessions(u.id);
    realtime.disconnectSessions(u.id, tokens);
    ops().disconnectUser(u.id);
    act(req, 'user.ban', T.user(u), { reason, sessions: tokens.length });
    res.json({ user: userRow(u) });
  });

  router.post('/admin/users/:id/unban', (req, res) => {
    const u = getUser(req.params.id);
    if (!u.instanceBan) throw new HttpError(400, 'Аккаунт не заблокирован');
    delete u.instanceBan;
    save();
    act(req, 'user.unban', T.user(u));
    res.json({ user: userRow(u) });
  });

  router.post('/admin/users/:id/logout', (req, res) => {
    const u = getUser(req.params.id);
    const tokens = revokeSessions(u.id);
    realtime.disconnectSessions(u.id, tokens);
    ops().disconnectUser(u.id);
    act(req, 'user.logout', T.user(u), { sessions: tokens.length });
    res.json({ ok: true, sessions: tokens.length });
  });

  router.post('/admin/users/:id/reset-password', wrap(async (req, res) => {
    const u = getUser(req.params.id);
    if (u.id === req.user.id) throw new HttpError(400, 'Свой пароль меняйте в настройках');
    const pass = tempPassword();
    const hash = await bcrypt.hash(pass, 10);
    u.passwordHash = hash;
    u.mustChangePassword = { hash, at: Date.now(), by: req.user.id };
    let totpReset = false;
    if (req.body?.resetTotp === true) { // потерян телефон с 2FA: поля модуля 2FA (user.totp*)
      for (const k of Object.keys(u)) if (/^totp/i.test(k)) { delete u[k]; totpReset = true; }
    }
    const tokens = revokeSessions(u.id);
    realtime.disconnectSessions(u.id, tokens);
    ops().disconnectUser(u.id);
    act(req, 'user.reset_password', T.user(u), { sessions: tokens.length, totpReset });
    res.set('Cache-Control', 'no-store');
    res.json({ tempPassword: pass, user: userRow(u) }); // показывается администратору один раз, нигде не хранится
  }));

  router.post('/admin/users/:id/admin', (req, res) => {
    const u = getUser(req.params.id);
    const grant = req.body?.grant === true;
    if (grant) {
      if (u.instanceBan) throw new HttpError(400, 'Аккаунт заблокирован');
      u.instanceAdmin = true;
    } else {
      if (!u.instanceAdmin && isEnvAdmin(u)) throw new HttpError(400, 'Этот администратор задан в ADMIN_USERS (/etc/sozvon.env) — снять права можно только там');
      if (!isInstanceAdmin(u)) throw new HttpError(400, 'Он не администратор');
      const others = listAdmins().filter((a) => a.id !== u.id);
      if (!others.length) throw new HttpError(400, 'Нельзя снять права с последнего администратора');
      delete u.instanceAdmin;
    }
    save();
    act(req, grant ? 'admin.grant' : 'admin.revoke', T.user(u));
    res.json({ user: userRow(u) });
  });

  // ================= журнал, состояние, оповещения, обновление =================
  router.get('/admin/audit', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    res.json({ entries: readAudit(limit) });
  });

  router.get('/admin/health', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ health: await collectHealth({ fresh: req.query.fresh === '1' }), alerts: alertsInfo(), update: updateState() });
  }));

  router.get('/admin/alerts', (_req, res) => res.json(alertsInfo()));

  router.patch('/admin/alerts', (req, res) => {
    const t = setToggles(req.body?.toggles || {});
    act(req, 'alerts.toggles', null, t);
    res.json(alertsInfo());
  });

  router.post('/admin/alerts/test', wrap(async (req, res) => {
    if (!telegramConfig().configured) throw new HttpError(400, 'Telegram не настроен: задайте ALERT_TELEGRAM_TOKEN и ALERT_TELEGRAM_CHAT_ID (или BACKUP_TELEGRAM_*) в /etc/sozvon.env и перезапустите sozvon');
    try {
      await sendTelegram(`🔔 Astra: тестовое уведомление из админ-панели (${req.user.username}). Оповещения работают.`);
    } catch (err) { throw new HttpError(502, err.message); }
    act(req, 'alerts.test');
    res.json({ ok: true });
  }));

  router.post('/admin/alerts/run', wrap(async (req, res) => {
    res.json(await runChecks());
  }));

  router.get('/admin/update', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(updateState()); });

  router.get('/admin/update/log', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(readUpdateLog(Number(req.query.offset) || 0));
  });

  for (const kind of ['check', 'run']) {
    router.post(`/admin/update/${kind}`, (req, res) => {
      if (kind === 'run' && req.body?.confirm !== true) throw new HttpError(400, 'Подтвердите обновление');
      try {
        const st = requestUpdate(kind === 'run' ? 'update' : 'check');
        act(req, kind === 'run' ? 'update.run' : 'update.check', null, { from: st.current?.short || null });
        res.json(st);
      } catch (e) {
        if (e instanceof UpdateError) throw new HttpError(409, e.message);
        throw e;
      }
    });
  }

  router.use('/admin', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON в запросе' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('[admin]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return router;
}

