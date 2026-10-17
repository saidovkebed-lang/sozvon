// v3: миграция данных старого (до v3) формата — SPEC-v3 §1.2, §5.1. owner: qa
// Фикстура tests/fixtures/v3-legacy/data создана СТАРЫМ кодом (коммит 28bc738) скриптом
// tests/fixtures/v3-legacy/make-legacy.mjs: реальные db.json + uploads/ прод-формата.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { httpAt, connect, connected, ack, uniqueName } from './fixtures/api.js';
import { P, DEFAULT_EVERYONE, startStandalone, MIGRATION_PORT, LEGACY_DIR, ok, denied } from './fixtures/v3.js';

test.describe.configure({ mode: 'serial' });

const dataDir = path.join(os.tmpdir(), `sozvon-qa-migration-${MIGRATION_PORT}`);
const legacy = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'db.json'), 'utf8'));
let srv; const sockets = [];

async function login(base, username) {
  const r = await httpAt(base, 'POST', '/api/login', { body: { username, password: 'legacy123' } });
  expect(r.status, `login ${username}: ${JSON.stringify(r.json)}`).toBe(200);
  const socket = await connected(connect(r.json.token, { base }));
  sockets.push(socket);
  return { ...r.json, socket, token: r.json.token };
}

test.beforeAll(async () => {
  // старый формат действительно старый
  expect(legacy.servers.every((s) => !('roles' in s) && !('memberRoles' in s))).toBe(true);
  expect(legacy.users.every((u) => !('avatar' in u) && !('displayName' in u))).toBe(true);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.cpSync(LEGACY_DIR, dataDir, { recursive: true });
  srv = await startStandalone({ port: MIGRATION_PORT, dataDir });
});
test.afterAll(async () => {
  for (const s of sockets) s.close();
  await srv?.stop();
});

test('старт на старом db.json: вход, серверы, история, вложение — всё на месте; @everyone = DEFAULT_EVERYONE', async () => {
  const base = srv.base;
  const owner = await login(base, 'legacy_owner');
  expect(owner.user).toMatchObject({ username: 'legacy_owner', color: '#e5484d' });
  // новые поля профиля — пустые по умолчанию
  expect(owner.user.displayName ?? null).toBeNull();
  expect(owner.user.avatar ?? null).toBeNull();
  expect(owner.user.avatarAnimated ?? null).toBeNull();
  expect(owner.user.banner ?? null).toBeNull();
  expect(owner.user.about ?? '').toBe('');
  expect(owner.user.customStatus ?? null).toBeNull();
  const boot = await ack(owner.socket, 'bootstrap');
  expect(boot.ok).toBe(true);
  const old = legacy.servers.find((s) => s.name === 'Старый сервер');
  const s = boot.servers.find((x) => x.id === old.id);
  expect(s, 'старый сервер на месте').toBeTruthy();
  expect(s.ownerId).toBe(old.ownerId);
  expect(s.inviteCode).toBe(old.inviteCode);
  expect(s.memberIds.sort()).toEqual([...old.memberIds].sort());
  expect(s.channels.map((c) => c.name).sort()).toEqual(['Голосовой', 'мемы', 'общий']);
  expect(s.roles).toHaveLength(1);
  expect(s.roles[0]).toMatchObject({ id: s.id, position: 0, permissions: DEFAULT_EVERYONE });
  expect(s.memberRoles).toEqual({});
  expect(s.channelOverwrites).toEqual({});
  expect(s.bans).toEqual({});
  expect(s.description).toBe('');
  expect(s.banner).toBeNull();
  // история и вложение
  const text = s.channels.find((c) => c.name === 'общий');
  const h = await ack(owner.socket, 'message:history', { channelId: text.id });
  expect(h.messages.map((m) => m.content)).toEqual(['Привет из старой версии', 'Сообщение участника до миграции', 'картинка']);
  const att = h.messages[2].attachments[0];
  const img = await httpAt(base, 'GET', att.url, { raw: true });
  expect(img.status).toBe(200);
  expect(img.headers.get('content-type')).toMatch(/image\/png/);
  // автор старого сообщения — publicUser нового формата
  expect(h.messages[1].author.username).toBe('legacy_member');
});

test('после миграции: владелец может всё, участник — права @everyone по умолчанию, инвайт работает', async () => {
  const base = srv.base;
  const owner = await login(base, 'legacy_owner');
  const member = await login(base, 'legacy_member');
  const lurker = await login(base, 'legacy_lurker');
  const old = legacy.servers.find((s) => s.name === 'Старый сервер');
  const text = legacy.channels.find((c) => c.serverId === old.id && c.name === 'общий');
  const voice = legacy.channels.find((c) => c.serverId === old.id && c.type === 'voice');
  // участник: писать, голос, видеть инвайт; но не управлять
  await ok(member.socket, 'message:send', { channelId: text.id, content: 'после миграции' });
  await ok(member.socket, 'voice:join', { channelId: voice.id });
  await ok(member.socket, 'voice:leave');
  const mv = (await ack(member.socket, 'bootstrap')).servers.find((x) => x.id === old.id);
  expect(mv.inviteCode).toBe(old.inviteCode);
  expect(mv.bans).toBeNull();
  await denied(member.socket, 'server:update', { serverId: old.id, name: 'взлом' });
  await denied(member.socket, 'role:create', { serverId: old.id, name: 'взлом' });
  // владелец: роли, настройки, модерация
  const role = (await ok(owner.socket, 'role:create', { serverId: old.id, name: 'Ветераны', color: '#5865f2', permissions: P.MANAGE_MESSAGES })).role;
  await ok(owner.socket, 'member:roles', { serverId: old.id, userId: member.user.id, roleIds: [role.id] });
  await ok(owner.socket, 'server:update', { serverId: old.id, description: 'мигрирован' });
  await ok(owner.socket, 'channel:create', { serverId: old.id, name: 'новый', type: 'text' });
  // новый участник по старому инвайту
  await ok(lurker.socket, 'server:join', { inviteCode: old.inviteCode });
  await ok(owner.socket, 'member:kick', { serverId: old.id, userId: lurker.user.id });
  // сервер участника: он владелец
  const own2 = legacy.servers.find((s) => s.name === 'Сервер участника');
  await ok(member.socket, 'server:update', { serverId: own2.id, name: 'Сервер участника 2' });
  // новый пользователь регистрируется как раньше
  const r = await httpAt(base, 'POST', '/api/register', { body: { username: uniqueName('new'), password: 'secret123' } });
  expect(r.status).toBe(200);
});

test('миграция идемпотентна: перезапуск сохраняет роли/изменения, @everyone не дублируется; db.json на диске в новом формате', async () => {
  await srv.stop();
  for (const s of sockets.splice(0)) s.close();
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const old = legacy.servers.find((s) => s.name === 'Старый сервер');
  const ds = disk.servers.find((s) => s.id === old.id);
  expect(ds.roles.filter((r) => r.id === old.id)).toHaveLength(1);
  expect(ds.roles.map((r) => r.name)).toContain('Ветераны');
  srv = await startStandalone({ port: MIGRATION_PORT, dataDir });
  const owner = await login(srv.base, 'legacy_owner');
  const s = (await ack(owner.socket, 'bootstrap')).servers.find((x) => x.id === old.id);
  expect(s.roles.filter((r) => r.position === 0)).toHaveLength(1);
  expect(s.roles.find((r) => r.id === old.id).permissions).toBe(DEFAULT_EVERYONE);
  expect(s.roles.map((r) => r.name)).toContain('Ветераны');
  expect(s.description).toBe('мигрирован');
  const member = legacy.users.find((u) => u.username === 'legacy_member');
  expect(s.memberRoles[member.id]).toHaveLength(1);
  // прежние пароли работают
  await login(srv.base, 'legacy_member');
});
