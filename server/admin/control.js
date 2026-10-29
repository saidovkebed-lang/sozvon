// Локальный канал управления для root (deploy/admin.sh): HTTP поверх unix-сокета DATA_DIR/admin.sock.
// Сокет и токен (DATA_DIR/admin-control.token) — права 600, владелец sozvon: подключиться может только сам
// сервис и root. Изменения вносит работающий сервер — db.json не правится «из-под» него и не портится.
// Снаружи (по сети) этот канал недоступен: TCP-порта нет.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { save } from '../db.js';
import { findUserByName, findUser } from '../model.js';
import { isEnvAdmin, isInstanceAdmin, listAdmins, updateSettings, admin2faRequired } from './access.js';
import { audit } from './audit.js';

const ROOT_ACTOR = { id: null, username: 'root (admin.sh)' };

function findTarget(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  return findUserByName(n) || findUser(n);
}

export function adminList() {
  return listAdmins().map((u) => ({
    id: u.id, username: u.username, flag: u.instanceAdmin === true, env: isEnvAdmin(u), totpEnabled: u.totpEnabled === true, tg2fa: u.tg2fa === true,
  }));
}

/** Выполнить команду admin.sh. Возвращает {status, body}. */
export function controlCommand(body) {
  const cmd = String(body?.cmd || '');
  if (cmd === 'list') return { status: 200, body: { ok: true, admins: adminList(), require2fa: admin2faRequired() } };
  if (cmd === 'require-2fa') {
    const v = String(body.value || '');
    if (!['on', 'off', 'default'].includes(v)) return { status: 400, body: { ok: false, error: 'require-2fa: on | off | default' } };
    updateSettings({ require2fa: v === 'default' ? null : v === 'on' });
    audit(ROOT_ACTOR, 'settings.require2fa', null, { value: v });
    return { status: 200, body: { ok: true, require2fa: admin2faRequired() } };
  }
  if (cmd === 'grant' || cmd === 'revoke') {
    const u = findTarget(body.username);
    if (!u) return { status: 404, body: { ok: false, error: `Пользователь «${String(body.username || '').slice(0, 40)}» не найден` } };
    if (u.isBot) return { status: 400, body: { ok: false, error: 'Бот не может быть администратором' } };
    if (cmd === 'grant') {
      u.instanceAdmin = true;
      save();
      audit(ROOT_ACTOR, 'admin.grant', { type: 'user', id: u.id, name: u.username });
      return { status: 200, body: { ok: true, user: u.username, admins: adminList(), require2fa: admin2faRequired(), totpEnabled: u.totpEnabled === true } };
    }
    if (!u.instanceAdmin && isEnvAdmin(u)) return { status: 400, body: { ok: false, error: `${u.username} указан в ADMIN_USERS (/etc/sozvon.env) — уберите его оттуда и перезапустите sozvon` } };
    delete u.instanceAdmin;
    save();
    audit(ROOT_ACTOR, 'admin.revoke', { type: 'user', id: u.id, name: u.username });
    return { status: 200, body: { ok: true, user: u.username, admins: adminList(), stillAdmin: isInstanceAdmin(u) } };
  }
  return { status: 400, body: { ok: false, error: 'Команды: list | grant ИМЯ | revoke ИМЯ | require-2fa on|off|default' } };
}

export function startControl(dataDir) {
  const sockPath = process.env.ADMIN_CONTROL_SOCKET || path.join(dataDir, 'admin.sock');
  const tokenFile = path.join(dataDir, 'admin-control.token');
  let token;
  try {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
  } catch (err) {
    console.warn('[admin] Канал управления выключен (токен не записан):', err.message);
    return null;
  }
  const want = Buffer.from(token);
  const srv = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body) + '\n'); };
    const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(401, { ok: false, error: 'Неверный токен' });
    if (req.method !== 'POST' || req.url !== '/admin') return send(404, { ok: false, error: 'Не найдено' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; if (raw.length > 10_000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, error: 'Нужен JSON' }); }
      try {
        const r = controlCommand(body);
        send(r.status, r.body);
      } catch (err) {
        console.error('[admin] Команда admin.sh:', err);
        send(500, { ok: false, error: 'Внутренняя ошибка' });
      }
    });
  });
  try { if (fs.lstatSync(sockPath).isSocket()) fs.unlinkSync(sockPath); } catch { /* нет старого сокета */ }
  srv.on('error', (err) => console.warn('[admin] Канал управления (admin.sock) недоступен:', err.message));
  srv.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
  });
  srv.unref();
  const cleanup = () => { try { fs.unlinkSync(sockPath); } catch { /* ignore */ } };
  process.once('exit', cleanup);
  return { close() { srv.close(); cleanup(); }, socket: sockPath, tokenFile };
}

