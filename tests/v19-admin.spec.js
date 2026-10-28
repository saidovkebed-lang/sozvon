// v19: админ-панель экземпляра (server/admin/*, docs/ADMIN.md).
// Отдельный сервер на свой порт и свой DATA_DIR (HTTP, без SFU): ADMIN_USERS, фейковый Telegram Bot API,
// фейковый HTTP-прокси (VPN), подмена проверок (ALERT_PROBE_OVERRIDES) и помощник обновления — настоящий
// deploy/self-update.sh над временным git-репозиторием (вместо systemd path-юнита — тестовый крючок).
import { test, expect } from '@playwright/test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { PORT as QA_PORT, ROOT } from './fixtures/env.js';
import { httpAt, connect, connected, ack, waitEvent, waitFor, sleep, uniqueName } from './fixtures/api.js';

test.describe.configure({ mode: 'serial' });

const PORT = QA_PORT + 50;
const TG_PORT = QA_PORT + 51;
const PROXY_PORT = QA_PORT + 52;
const BASE = `http://127.0.0.1:${PORT}`;
const TG_TOKEN = '123456:TEST_alert_token_abcdefghijklmn';
const BACKUP_SECRET = 'BACKUP_SECRET_should_not_leak_42';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp, dataDir, stateDir, overridesFile, server, serverLogs = '';
let tgServer, proxyServer;
const tgMessages = [];
const sockets = [];

const api = (method, url, opts = {}) => httpAt(BASE, method, url, opts);
async function register(prefix = 'u') {
  const username = uniqueName(prefix).slice(0, 20);
  const r = await api('POST', '/api/register', { body: { username, password: 'secret123' } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { username, password: 'secret123', token: r.json.token, id: r.json.user.id };
}
async function sock(token) {
  const s = connect(token, { base: BASE });
  sockets.push(s);
  return connected(s);
}
function control(body) {
  const token = fs.readFileSync(path.join(dataDir, 'admin-control.token'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dataDir, 'admin.sock'), path: '/admin', method: 'POST', headers: { 'x-admin-token': token, 'content-type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const setOverrides = (o) => fs.writeFileSync(overridesFile, JSON.stringify(o));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

function startProxy() {
  return new Promise((resolve) => {
    proxyServer = net.createServer((c) => {
      c.once('data', (d) => {
        if (String(d).startsWith('CONNECT ')) c.end('HTTP/1.1 200 Connection established\r\n\r\n');
        else c.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
      c.on('error', () => {});
    }).listen(PROXY_PORT, '127.0.0.1', resolve);
  });
}

let admin; // главный администратор (выдан через admin.sock, как admin.sh grant)
let appRepo, newCommitSubject;

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-admin-'));
  dataDir = path.join(tmp, 'lib', 'sozvon');
  stateDir = path.join(tmp, 'lib', 'sozvon-state');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  overridesFile = path.join(tmp, 'probe-overrides.json');
  setOverrides({});

  // фейковый Telegram Bot API
  tgServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      tgMessages.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: tgMessages.length } }));
    });
  });
  await new Promise((r) => tgServer.listen(TG_PORT, '127.0.0.1', r));
  await startProxy();

  // git: origin (2 коммита) и «установка» на первом коммите
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README'), 'v1\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Первая версия');
  const origin = path.join(tmp, 'origin.git');
  git(tmp, 'clone', '-q', '--bare', work, origin);
  appRepo = path.join(tmp, 'app');
  git(tmp, 'clone', '-q', origin, appRepo);
  newCommitSubject = 'Новая функция для теста обновления';
  fs.writeFileSync(path.join(work, 'README'), 'v2\n');
  git(work, 'commit', '-q', '-am', newCommitSubject);
  git(work, 'push', '-q', origin, 'main');
  // фейковый update.sh: печатает шаги и переводит «установку» на свежий код
  const fakeUpdate = path.join(tmp, 'fake-update.sh');
  fs.writeFileSync(fakeUpdate, `#!/usr/bin/env bash
set -e
echo "  ✓ Код: скачиваю"
git -C "$APP_DIR" fetch -q origin main
git -C "$APP_DIR" reset -q --hard FETCH_HEAD
echo "  ✓ Зависимости обновлены"
echo "  ✓ Astra перезапущена и отвечает"
`);

  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test',
      PORT: String(PORT), HOST: '127.0.0.1', HTTPS: '0', SFU: '0', DATA_DIR: dataDir,
      ADMIN_USERS: 'envboss', ALERT_INTERVAL_MS: '0',
      ALERT_TELEGRAM_TOKEN: TG_TOKEN, ALERT_TELEGRAM_CHAT_ID: '4242', ALERT_TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`,
      BACKUP_TELEGRAM_TOKEN: BACKUP_SECRET, BACKUP_PASSPHRASE: BACKUP_SECRET,
      ALERT_PROBE_OVERRIDES: overridesFile, SPOTIFY_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
      SOZVON_STATE_DIR: stateDir,
      // «path-юнит» в тесте: сервер сам запускает настоящий помощник deploy/self-update.sh
      SOZVON_UPDATE_HELPER_CMD: path.join(ROOT, 'deploy', 'self-update.sh'),
      SELF_UPDATE_ALLOW_NONROOT: '1', APP_DIR: appRepo, STATE_DIR: stateDir, SELF_UPDATE_LOCK: path.join(tmp, 'self-update.lock'),
      SELF_UPDATE_CMD: fakeUpdate, SOZVON_BRANCH: 'main',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLogs += d; });
  server.stderr.on('data', (d) => { serverLogs += d; });
  await waitFor(async () => (await api('GET', '/api/config')).status === 200, { timeout: 20000, message: 'admin test server up' })
    .catch((e) => { throw new Error(e.message + '\n' + serverLogs); });

  admin = await register('ivan');
});

test.afterAll(async () => {
  for (const s of sockets) s.close();
  server?.kill('SIGTERM');
  await new Promise((r) => (server ? server.once('exit', r) : r()));
  tgServer?.close();
  proxyServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('не-админ: 403 на /api/admin/*, без сессии — 401; /api/admin/me — admin:false', async () => {
  const alice = await register('alice');
  expect((await api('GET', '/api/admin/servers')).status).toBe(401);
  const r = await api('GET', '/api/admin/servers', { token: alice.token });
  expect(r.status).toBe(403);
  expect(r.json.code).toBe('not_admin');
  for (const [m, u] of [['GET', '/api/admin/users'], ['GET', '/api/admin/health'], ['POST', '/api/admin/update/run'], ['POST', `/api/admin/users/${alice.id}/admin`]]) {
    expect((await api(m, u, { token: alice.token, body: m === 'POST' ? { grant: true, confirm: true } : undefined })).status, `${m} ${u}`).toBe(403);
  }
  expect((await api('GET', '/api/admin/me', { token: alice.token })).json).toMatchObject({ admin: false, active: false });
  // бот не бывает администратором
  const botToken = fs.readFileSync(path.join(dataDir, 'bot-token.txt'), 'utf8').trim();
  expect((await api('GET', '/api/admin/servers', { token: `Bot ${botToken}` })).status).toBe(403);
});

test('admin.sock (как admin.sh): grant; 2FA обязательна по умолчанию, require-2fa off открывает панель', async ({ page }) => {
  const g = await control({ cmd: 'grant', username: admin.username });
  expect(g.status).toBe(200);
  expect(g.json.admins.map((a) => a.username)).toContain(admin.username);
  expect((await control({ cmd: 'grant', username: 'DJ Бот' })).status).toBe(400); // бот — никогда
  expect((await control({ cmd: 'grant', username: 'нет-такого' })).status).toBe(404);

  // без 2FA (user.totpEnabled) — отказ с понятным текстом
  expect((await api('GET', '/api/admin/me', { token: admin.token })).json).toMatchObject({ admin: true, active: false, require2fa: true, totpEnabled: false });
  const denied = await api('GET', '/api/admin/servers', { token: admin.token });
  expect(denied.status).toBe(403);
  expect(denied.json.code).toBe('admin_2fa_required');
  expect(denied.json.error).toBe('Включите двухфакторную защиту, чтобы открыть админ-панель');

  // UI: пункт меню есть, панель показывает требование 2FA и кнопку настроек безопасности
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), admin.token);
  await page.goto(BASE);
  await page.locator('#me-avatar').click();
  await page.locator('[data-action="admin-panel"]').click();
  await expect(page.locator('#admin-2fa-gate')).toContainText('Включите двухфакторную защиту, чтобы открыть админ-панель');
  await expect(page.locator('#admin-open-security')).toBeVisible();

  // root выключает требование (тестовый обход / осознанный выбор владельца)
  const off = await control({ cmd: 'require-2fa', value: 'off' });
  expect(off.json.require2fa).toBe(false);
  expect((await api('GET', '/api/admin/me', { token: admin.token })).json.active).toBe(true);
  expect((await api('GET', '/api/admin/servers', { token: admin.token })).status).toBe(200);
});

test('deploy/admin.sh grant/list/revoke против временного DATA_DIR (нужен root)', async () => {
  test.skip(!isRoot, 'admin.sh работает только от root');
  const script = path.join(ROOT, 'deploy', 'admin.sh');
  const env = { ...process.env, DATA_DIR: dataDir, ADMIN_SERVICE: 'astra-test-nonexistent' };
  const carol = await register('carol');
  let r = spawnSync('bash', [script, 'grant', carol.username], { env, encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('теперь администратор');
  r = spawnSync('bash', [script, 'list'], { env, encoding: 'utf8' });
  expect(r.stdout).toContain(carol.username);
  expect(r.stdout).toContain(admin.username);
  r = spawnSync('bash', [script, 'revoke', carol.username], { env, encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect((await api('GET', '/api/admin/me', { token: carol.token })).json.admin).toBe(false);
  r = spawnSync('bash', [script, 'grant', 'DJ Бот'], { env, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Бот не может быть администратором');

  // сервер остановлен (нет admin.sock) — правка db.json напрямую, атомарно
  const offline = path.join(tmp, 'offline');
  fs.mkdirSync(offline);
  fs.writeFileSync(path.join(offline, 'db.json'), JSON.stringify({ users: [{ id: 'x1', username: 'Petya', usernameLower: 'petya' }, { id: 'b', username: 'DJ Бот', usernameLower: 'dj бот', isBot: true }] }));
  r = spawnSync('bash', [script, 'grant', 'petya'], { env: { ...env, DATA_DIR: offline }, encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const db = JSON.parse(fs.readFileSync(path.join(offline, 'db.json'), 'utf8'));
  expect(db.users[0].instanceAdmin).toBe(true);
  expect(fs.readFileSync(path.join(offline, 'admin-audit.jsonl'), 'utf8')).toContain('admin.grant');
});

test('права администратора на чужом сервере: просмотр, удаление сообщения, кик, переименование, вход, удаление', async () => {
  const bob = await register('bob');
  const bobS = await sock(bob.token);
  const created = await ack(bobS, 'server:create', { name: 'Сервер Боба' });
  expect(created.ok).toBe(true);
  const srv = created.server;
  const text = srv.channels.find((c) => c.type === 'text');
  const voiceCh = srv.channels.find((c) => c.type === 'voice');
  const sent = await ack(bobS, 'message:send', { channelId: text.id, content: 'секрет Боба' });
  const dave = await register('dave');
  const daveS = await sock(dave.token);
  expect((await ack(daveS, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);

  // список и карточка сервера (администратор не участник)
  const list = await api('GET', '/api/admin/servers?q=' + encodeURIComponent('Боба'), { token: admin.token });
  expect(list.status).toBe(200);
  const row = list.json.servers.find((s) => s.id === srv.id);
  expect(row).toMatchObject({ name: 'Сервер Боба', members: 2, channels: { text: 1, voice: 1 } });
  expect(row.owner.username).toBe(bob.username);
  const detail = await api('GET', `/api/admin/servers/${srv.id}`, { token: admin.token });
  expect(detail.json.isMember).toBe(false);
  expect(detail.json.server.inviteCode).toBe(srv.inviteCode);
  expect(detail.json.members.map((m) => m.username).sort()).toEqual([bob.username, dave.username].sort());
  const msgs = await api('GET', `/api/admin/channels/${text.id}/messages`, { token: admin.token });
  expect(msgs.json.messages.map((m) => m.content)).toContain('секрет Боба');

  // удалить сообщение — участники получают message:deleted
  const del = waitEvent(bobS, 'message:deleted', (d) => d.messageId === sent.message.id);
  expect((await api('DELETE', `/api/admin/messages/${sent.message.id}`, { token: admin.token })).status).toBe(200);
  await del;

  // кик
  const removed = waitEvent(daveS, 'server:removed', (d) => d.serverId === srv.id);
  expect((await api('POST', `/api/admin/servers/${srv.id}/members/${dave.id}/kick`, { token: admin.token })).status).toBe(200);
  expect((await removed).reason).toBe('kick');
  // владельца нельзя выгнать
  expect((await api('POST', `/api/admin/servers/${srv.id}/members/${bob.id}/kick`, { token: admin.token })).status).toBe(400);

  // переименовать
  const upd = waitEvent(bobS, 'server:updated', (d) => d.server.id === srv.id && d.server.name === 'Переименован админом');
  expect((await api('PATCH', `/api/admin/servers/${srv.id}`, { token: admin.token, body: { name: 'Переименован админом' } })).status).toBe(200);
  await upd;

  // войти как участник: дальше обычные действия через сокет — со всеми правами (как владелец)
  const adminS = await sock(admin.token);
  expect((await api('POST', `/api/admin/servers/${srv.id}/join`, { token: admin.token })).status).toBe(200);
  const boot = await ack(adminS, 'bootstrap');
  const mine = boot.servers.find((s) => s.id === srv.id);
  expect(mine.bans).not.toBeNull(); // видит баны — право BAN_MEMBERS
  expect((await ack(adminS, 'channel:create', { serverId: srv.id, name: 'от-админа', type: 'text' })).ok).toBe(true);
  expect((await ack(adminS, 'voice:join', { channelId: voiceCh.id })).ok).toBe(true);
  await ack(adminS, 'voice:leave');
  const bobMsg = await ack(bobS, 'message:send', { channelId: text.id, content: 'ещё одно' });
  expect((await ack(adminS, 'message:delete', { messageId: bobMsg.message.id })).ok).toBe(true);
  expect((await ack(adminS, 'member:ban', { serverId: srv.id, userId: dave.id, reason: 'тест' })).ok).toBe(true);
  expect((await api('DELETE', `/api/admin/servers/${srv.id}/bans/${dave.id}`, { token: admin.token })).status).toBe(200);
  // а владелец сервера не может выгнать администратора экземпляра? Может — он владелец.
  // Передача владения
  expect((await api('POST', `/api/admin/servers/${srv.id}/transfer`, { token: admin.token, body: { userId: admin.id } })).status).toBe(200);
  expect((await api('POST', `/api/admin/servers/${srv.id}/transfer`, { token: admin.token, body: { userId: bob.id } })).status).toBe(200);

  // удаление сервера — только с точным названием
  expect((await api('DELETE', `/api/admin/servers/${srv.id}`, { token: admin.token, body: { confirmName: 'неверно' } })).status).toBe(400);
  const gone = waitEvent(bobS, 'server:removed', (d) => d.serverId === srv.id);
  expect((await api('DELETE', `/api/admin/servers/${srv.id}`, { token: admin.token, body: { confirmName: 'Переименован админом' } })).status).toBe(200);
  await gone;
  expect((await api('GET', `/api/admin/servers/${srv.id}`, { token: admin.token })).status).toBe(404);

  // ЛС администратору недоступны: id ЛС как канал — 404
  const dm = await ack(bobS, 'dm:open', { userId: admin.id }).catch(() => null);
  if (dm?.ok) expect((await api('GET', `/api/admin/channels/${dm.dm.id}/messages`, { token: admin.token })).status).toBe(404);
});

test('бан аккаунта: сеансы отключаются, вход запрещён; разбан возвращает вход', async () => {
  const eve = await register('eve');
  const eveS = await sock(eve.token);
  const disc = new Promise((r) => eveS.once('disconnect', r));
  const r = await api('POST', `/api/admin/users/${eve.id}/ban`, { token: admin.token, body: { reason: 'спам' } });
  expect(r.status).toBe(200);
  expect(r.json.user.flags.banned).toBe(true);
  await disc;
  expect((await api('GET', '/api/me', { token: eve.token })).status).toBe(401);
  const login = await api('POST', '/api/login', { body: { username: eve.username, password: eve.password } });
  expect(login.status).toBe(403);
  expect(login.json.error).toContain('заблокирован');
  expect(login.json.token).toBeUndefined();
  // переподключение старым токеном — отказ
  const again = connect(eve.token, { base: BASE });
  sockets.push(again);
  await expect(connected(again)).rejects.toThrow(/unauthorized/);
  // себя и администратора — нельзя
  expect((await api('POST', `/api/admin/users/${admin.id}/ban`, { token: admin.token })).status).toBe(400);
  expect((await api('POST', `/api/admin/users/${eve.id}/unban`, { token: admin.token })).status).toBe(200);
  expect((await api('POST', '/api/login', { body: { username: eve.username, password: eve.password } })).status).toBe(200);
});

test('принудительный выход: все сеансы отозваны', async () => {
  const frank = await register('frank');
  const second = await api('POST', '/api/login', { body: { username: frank.username, password: frank.password } });
  const fs1 = await sock(frank.token);
  const disc = new Promise((r) => fs1.once('disconnect', r));
  const r = await api('POST', `/api/admin/users/${frank.id}/logout`, { token: admin.token });
  expect(r.json.sessions).toBe(2);
  await disc;
  expect((await api('GET', '/api/me', { token: frank.token })).status).toBe(401);
  expect((await api('GET', '/api/me', { token: second.json.token })).status).toBe(401);
  expect((await api('POST', '/api/login', { body: { username: frank.username, password: frank.password } })).status).toBe(200);
});

test('сброс пароля: временный пароль показывается один раз и требует смены (API + UI)', async ({ page }) => {
  const gina = await register('gina');
  const r = await api('POST', `/api/admin/users/${gina.id}/reset-password`, { token: admin.token, body: {} });
  expect(r.status).toBe(200);
  const temp = r.json.tempPassword;
  expect(temp).toMatch(/^[A-Za-z0-9]{12}$/);
  expect(r.json.user.flags.mustChangePassword).toBe(true);
  expect((await api('GET', '/api/me', { token: gina.token })).status).toBe(401); // старые сеансы отозваны
  expect((await api('POST', '/api/login', { body: { username: gina.username, password: gina.password } })).status).toBe(401);
  const login = await api('POST', '/api/login', { body: { username: gina.username, password: temp } });
  expect(login.status).toBe(200);
  expect(login.json.mustChangePassword).toBe(true);
  const tok = login.json.token;
  const blocked = await api('GET', '/api/music', { token: tok });
  expect(blocked.status).toBe(403);
  expect(blocked.json.code).toBe('password_change_required');
  const s = connect(tok, { base: BASE });
  sockets.push(s);
  await expect(connected(s)).rejects.toThrow(/password_change_required/);
  // журнал аудита не содержит временный пароль
  expect(fs.readFileSync(path.join(dataDir, 'admin-audit.jsonl'), 'utf8')).not.toContain(temp);

  // UI: вход с временным паролем → окно смены пароля → приложение
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), tok);
  await page.goto(BASE);
  const dlg = page.locator('#modal-temp-password');
  await expect(dlg).toBeVisible();
  await dlg.locator('#temp-old-password').fill(temp);
  await dlg.locator('#temp-new-password').fill('новыйпароль1');
  await dlg.locator('#temp-confirm-password').fill('новыйпароль1');
  await dlg.locator('button[type="submit"]').click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#app')).toBeVisible();
  expect((await api('GET', '/api/music', { token: tok })).status).toBe(200);
  expect((await api('POST', '/api/login', { body: { username: gina.username, password: 'новыйпароль1' } })).json.mustChangePassword).toBeUndefined();
});

test('права администратора: выдать/снять; последнего и заданного в ADMIN_USERS снять нельзя', async () => {
  // сейчас единственный администратор — ivan
  const self = await api('POST', `/api/admin/users/${admin.id}/admin`, { token: admin.token, body: { grant: false } });
  expect(self.status).toBe(400);
  expect(self.json.error).toContain('последнего администратора');
  const hank = await register('hank');
  expect((await api('POST', `/api/admin/users/${hank.id}/admin`, { token: admin.token, body: { grant: true } })).json.user.flags.admin).toBe(true);
  expect((await api('GET', '/api/admin/me', { token: hank.token })).json.admin).toBe(true);
  expect((await api('POST', `/api/admin/users/${hank.id}/admin`, { token: admin.token, body: { grant: false } })).json.user.flags.admin).toBe(false);
  expect((await api('GET', '/api/admin/servers', { token: hank.token })).status).toBe(403);
  // ADMIN_USERS: envboss — администратор без флага, снять из панели нельзя
  const reg = await api('POST', '/api/register', { body: { username: 'envboss', password: 'secret123' } });
  expect(reg.status).toBe(200);
  const bossTok = reg.json.token;
  const me = await api('GET', '/api/admin/me', { token: bossTok });
  expect(me.json.admin).toBe(true);
  const users = await api('GET', '/api/admin/users?q=envboss', { token: admin.token });
  const bossRow = users.json.users.find((u) => u.username === 'envboss');
  expect(bossRow.flags).toMatchObject({ admin: true, envAdmin: true });
  const rev = await api('POST', `/api/admin/users/${bossRow.id}/admin`, { token: admin.token, body: { grant: false } });
  expect(rev.status).toBe(400);
  expect(rev.json.error).toContain('ADMIN_USERS');
});

test('журнал аудита: кто, что, над кем, когда', async () => {
  const r = await api('GET', '/api/admin/audit?limit=500', { token: admin.token });
  expect(r.status).toBe(200);
  const actions = r.json.entries.map((e) => e.action);
  for (const a of ['admin.grant', 'settings.require2fa', 'server.rename', 'member.kick', 'message.delete', 'server.join', 'server.delete', 'user.ban', 'user.unban', 'user.logout', 'user.reset_password', 'admin.revoke', 'channel.read']) {
    expect(actions, a).toContain(a);
  }
  const kick = r.json.entries.find((e) => e.action === 'member.kick');
  expect(kick.actor.username).toBe(admin.username);
  expect(kick.target.type).toBe('server');
  expect(typeof kick.at).toBe('number');
  expect(r.json.entries.find((e) => e.action === 'admin.grant' && e.actor.username.startsWith('root'))).toBeTruthy();
  const raw = fs.readFileSync(path.join(dataDir, 'admin-audit.jsonl'), 'utf8');
  expect(raw.trim().split('\n').every((l) => JSON.parse(l).at)).toBe(true);
});

test('состояние сервера: форма ответа, без секретов', async () => {
  fs.writeFileSync(path.join(stateDir, 'backup-status.json'), JSON.stringify({ time: new Date(Date.now() - 3600_000).toISOString(), result: 'ok', ok: true, file: 'astra-x.tar.zst', size: 1234, telegram: 'выключено', error: '' }));
  const r = await api('GET', '/api/admin/health?fresh=1', { token: admin.token });
  expect(r.status).toBe(200);
  const x = r.json.health;
  expect(x.system.memory.pct).toBeGreaterThan(0);
  expect(x.system.disks).toHaveLength(2);
  expect(x.system.disks[0].pct).toBeGreaterThan(0);
  expect(x.system.load).toHaveLength(3);
  expect(x.process.node).toBe(process.version);
  expect(x.version.version).toBeTruthy();
  expect(typeof x.live.online).toBe('number');
  expect(x.sfu).toMatchObject({ enabled: false });
  expect(x.music.ytdlp).toHaveProperty('installed');
  expect(x.vpn).toMatchObject({ configured: true, ok: true, proxy: `127.0.0.1:${PROXY_PORT}` });
  expect(x.backup).toMatchObject({ known: true, ok: true, file: 'astra-x.tar.zst' });
  expect(Array.isArray(x.errors.recent)).toBe(true);
  expect(r.json.alerts.telegram).toMatchObject({ configured: true, source: 'ALERT_TELEGRAM_*' });
  // секреты не утекают
  const text = JSON.stringify(r.json);
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const someToken = Object.keys(db.sessions)[0];
  for (const secret of [TG_TOKEN, BACKUP_SECRET, someToken, fs.readFileSync(path.join(dataDir, 'bot-token.txt'), 'utf8').trim(), fs.readFileSync(path.join(dataDir, 'admin-control.token'), 'utf8').trim()]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/\$2[aby]\$/); // хэши паролей
  // ошибки в журнале скрывают похожее на токены
  const users = await api('GET', '/api/admin/users', { token: admin.token });
  expect(JSON.stringify(users.json)).not.toMatch(/passwordHash|\$2[aby]\$/);
});

test('оповещения в Telegram: одно на инцидент, «восстановлено», выключатели, тестовая кнопка', async () => {
  const msgs = () => tgMessages.map((m) => m.body.text);
  tgMessages.length = 0;
  let run = await api('POST', '/api/admin/alerts/run', { token: admin.token });
  expect(run.status).toBe(200);
  expect(run.json.active).toEqual([]);
  expect(tgMessages).toHaveLength(0);

  // VPN-прокси упал (настоящая проверка CONNECT)
  await new Promise((r) => proxyServer.close(r));
  run = await api('POST', '/api/admin/alerts/run', { token: admin.token });
  expect(run.json.active.map((a) => a.key)).toEqual(['vpn']);
  expect(tgMessages).toHaveLength(1);
  expect(tgMessages[0].url).toBe(`/bot${TG_TOKEN}/sendMessage`);
  expect(tgMessages[0].body.chat_id).toBe('4242');
  expect(msgs()[0]).toContain('VPN-прокси');
  // повторная проверка — без повторного сообщения
  await api('POST', '/api/admin/alerts/run', { token: admin.token });
  expect(tgMessages).toHaveLength(1);

  // диск и старая резервная копия (подмена проверок)
  setOverrides({ diskPct: 96, backup: { ok: true, ageHours: 50 } });
  run = await api('POST', '/api/admin/alerts/run', { token: admin.token });
  expect(run.json.active.map((a) => a.key).sort()).toEqual(['backup', 'disk', 'vpn']);
  expect(tgMessages).toHaveLength(3);
  expect(msgs().some((t) => /Диск .* 96 %/.test(t))).toBe(true);

  // восстановление
  await startProxy();
  setOverrides({});
  fs.writeFileSync(path.join(stateDir, 'backup-status.json'), JSON.stringify({ time: new Date().toISOString(), result: 'ok', ok: true }));
  run = await api('POST', '/api/admin/alerts/run', { token: admin.token });
  expect(run.json.active).toEqual([]);
  const rec = msgs().slice(3);
  expect(rec).toHaveLength(3);
  expect(rec.every((t) => t.startsWith('✅'))).toBe(true);

  // выключатель: диск не проверяется
  const patch = await api('PATCH', '/api/admin/alerts', { token: admin.token, body: { toggles: { disk: false } } });
  expect(patch.json.alerts.find((a) => a.key === 'disk').enabled).toBe(false);
  setOverrides({ diskPct: 99, sfu: { enabled: true, wasReady: true, ready: false }, errors5min: 50 });
  run = await api('POST', '/api/admin/alerts/run', { token: admin.token });
  expect(run.json.active.map((a) => a.key).sort()).toEqual(['errors', 'sfu']);
  expect(msgs().slice(6).some((t) => t.includes('Диск'))).toBe(false);
  setOverrides({});
  await api('POST', '/api/admin/alerts/run', { token: admin.token });
  await api('PATCH', '/api/admin/alerts', { token: admin.token, body: { toggles: { disk: true } } });

  // тестовое уведомление
  const before = tgMessages.length;
  expect((await api('POST', '/api/admin/alerts/test', { token: admin.token })).status).toBe(200);
  expect(tgMessages).toHaveLength(before + 1);
  expect(msgs().at(-1)).toContain('тестовое уведомление');
  // состояние сохраняется на диск
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'alerts-state.json'), 'utf8')).active).toEqual({});
});

test('обновление: проверка (git fetch помощником), запуск, журнал, «Обновлено до …», защита от повторов', async ({ page }) => {
  let st = await api('GET', '/api/admin/update', { token: admin.token });
  expect(st.json.helperInstalled).toBe(true);
  expect(st.json.current.version).toBeTruthy();
  // ожидающий запрос — второй отклоняется
  fs.writeFileSync(path.join(dataDir, 'update-request'), 'check\n');
  expect((await api('POST', '/api/admin/update/check', { token: admin.token })).status).toBe(409);
  fs.rmSync(path.join(dataDir, 'update-request'));

  expect((await api('POST', '/api/admin/update/check', { token: admin.token })).status).toBe(200);
  st = await waitFor(async () => {
    const r = await api('GET', '/api/admin/update', { token: admin.token });
    return r.json.check?.checkedAt && !r.json.pending ? r : null;
  }, { timeout: 20000, message: 'update-check.json' });
  expect(st.json.check.behind).toBe(1);
  expect(st.json.check.notes.join('\n')).toContain(newCommitSubject);
  expect(fs.existsSync(path.join(dataDir, 'update-request'))).toBe(false); // помощник удалил запрос

  expect((await api('POST', '/api/admin/update/run', { token: admin.token, body: {} })).status).toBe(400); // нужно подтверждение

  // UI: раздел «Обновить Astra» → кнопка → «Обновлено до …»
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), admin.token);
  await page.goto(BASE);
  await page.locator('#me-avatar').click();
  await page.locator('[data-action="admin-panel"]').click();
  await page.locator('#admin-tab-update').click();
  await expect(page.locator('#admin-update-check')).toContainText('Доступно обновление');
  await page.locator('#admin-update-run').click();
  await page.locator('#admin-ask-ok').click();
  const newShort = (await new Promise((r) => r(execFileSync('git', ['rev-parse', '--short', 'FETCH_HEAD'], { cwd: appRepo, encoding: 'utf8' })))).trim();
  await expect(page.locator('#admin-update-done')).toContainText(`Обновлено до ${newShort}`, { timeout: 20000 });
  await expect(page.locator('#admin-update-log')).toContainText('Зависимости обновлены');

  st = await api('GET', '/api/admin/update', { token: admin.token });
  expect(st.json.status).toMatchObject({ state: 'done', exitCode: 0, to: newShort });
  const log = await api('GET', '/api/admin/update/log?offset=0', { token: admin.token });
  expect(log.json.text).toContain('Astra перезапущена');
  // файлы результата — в каталоге состояния, не в DATA_DIR
  expect(fs.existsSync(path.join(stateDir, 'update.log'))).toBe(true);
  expect(fs.existsSync(path.join(dataDir, 'update.log'))).toBe(false);
  const audit = await api('GET', '/api/admin/audit', { token: admin.token });
  expect(audit.json.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['update.check', 'update.run']));
});

test('помощник обновления игнорирует чужое содержимое запроса и ссылки', async () => {
  const script = path.join(ROOT, 'deploy', 'self-update.sh');
  const env = { ...process.env, SELF_UPDATE_ALLOW_NONROOT: '1', DATA_DIR: path.join(tmp, 'hostile'), APP_DIR: appRepo, STATE_DIR: path.join(tmp, 'hostile-state'), SELF_UPDATE_LOCK: path.join(tmp, 'h.lock'), SELF_UPDATE_CMD: '/bin/false' };
  fs.mkdirSync(env.DATA_DIR);
  const marker = path.join(tmp, 'pwned');
  fs.writeFileSync(path.join(env.DATA_DIR, 'update-request'), `update; touch ${marker}\n$(touch ${marker})`);
  let r = spawnSync('bash', [script], { env, encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('Неизвестный запрос');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path.join(env.DATA_DIR, 'update-request'))).toBe(false);
  // символическая ссылка вместо файла — игнорируется и удаляется (цель не трогается)
  const target = path.join(tmp, 'target.txt');
  fs.writeFileSync(target, 'update');
  fs.symlinkSync(target, path.join(env.DATA_DIR, 'update-request'));
  r = spawnSync('bash', [script], { env, encoding: 'utf8' });
  expect(r.stdout).toContain('ссылка');
  expect(fs.readFileSync(target, 'utf8')).toBe('update');
  expect(fs.existsSync(path.join(env.STATE_DIR, 'update-status.json'))).toBe(false);
});

test('UI: админ-панель — пункт меню только у админа, серверы, пользователи, состояние, журнал', async ({ page, browser }) => {
  const owner = await register('olga');
  const os1 = await sock(owner.token);
  const srv = (await ack(os1, 'server:create', { name: 'Ольгин сервер' })).server;
  await ack(os1, 'message:send', { channelId: srv.channels.find((c) => c.type === 'text').id, content: 'привет из UI' });

  // обычному пользователю пункта нет
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(BASE);
  await p2.evaluate((t) => localStorage.setItem('sozvon.token', t), owner.token);
  await p2.goto(BASE);
  await expect(p2.locator('#app')).toBeVisible();
  await sleep(500);
  await p2.locator('#me-avatar').click();
  await expect(p2.locator('.status-menu')).toBeVisible();
  await expect(p2.locator('[data-action="admin-panel"]')).toHaveCount(0);
  await ctx2.close();

  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), admin.token);
  await page.goto(BASE);
  await page.locator('#me-avatar').click();
  await page.locator('[data-action="admin-panel"]').click();
  const panel = page.locator('#admin-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('#admin-servers-list')).toContainText('Ольгин сервер');
  await page.locator('#admin-servers-search').fill('Ольгин');
  await page.locator(`#admin-servers-list [data-server-id="${srv.id}"]`).click();
  await expect(page.locator('#admin-server-detail')).toContainText('Ольгин сервер');
  await page.screenshot({ path: 'tests/screens-qa/v19-admin-server.png' });
  await page.locator('#admin-server-channels [data-action="messages"]').first().click();
  await expect(page.locator('#admin-messages')).toContainText('привет из UI');
  await page.locator('#admin-messages [data-action="delete-message"]').first().click();
  await expect(page.locator('#admin-messages')).not.toContainText('привет из UI');

  await page.locator('#admin-tab-users').click();
  await page.locator('#admin-users-search').fill(owner.username);
  await page.locator(`#admin-users-list [data-user-id="${owner.id}"]`).click();
  await expect(page.locator('#admin-user-servers')).toContainText('Ольгин сервер');

  await page.locator('#admin-tab-health').click();
  await expect(page.locator('#admin-health')).toContainText('Память');
  await expect(page.locator('#admin-health')).toContainText('VPN-прокси');
  await page.screenshot({ path: 'tests/screens-qa/v19-admin-health.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: 'tests/screens-qa/v19-admin-health-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator('#admin-tab-alerts').click();
  await expect(page.locator('#admin-alert-toggles input')).toHaveCount(9);

  await page.locator('#admin-tab-audit').click();
  await expect(page.locator('#admin-audit')).toContainText('удалил сообщение');
  await page.screenshot({ path: 'tests/screens-qa/v19-admin-audit.png' });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});
