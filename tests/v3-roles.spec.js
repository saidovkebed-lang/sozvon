// v3: роли и права (SPEC-v3 §1) — уровень API (Socket.IO). owner: qa
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  ack, makeUser, createServer, textChannel, voiceChannel, waitEvent, collect, sleep, http, startBot,
} from './fixtures/api.js';
import { ROOT, MEDIA_DIR } from './fixtures/env.js';
import { P, DEFAULT_EVERYONE, guild, ok, denied, makeRole, viewOf, setEveryone, closeAll } from './fixtures/v3.js';

const opened = [];
const track = (...us) => { opened.push(...us); return us; };
test.afterEach(() => { closeAll(opened.splice(0)); });

async function g(n = 2) { const r = await guild(n); track(...r.all); return r; }

async function uploadAttachment(user) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(MEDIA_DIR, 'qa-image.png'))], { type: 'image/png' }), 'p.png');
  const r = await http('POST', '/api/attachments', { token: user.token, body: fd });
  expect(r.status).toBe(200);
  return r.json;
}

test.describe('v3 права: модель и отдача клиенту', () => {
  test('PERMS сервера и клиента совпадают с контрактом; DEFAULT_EVERYONE', async () => {
    const srvMod = await import(path.join(ROOT, 'server', 'permissions.js'));
    const cliSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'perms.js'), 'utf8');
    for (const [k, v] of Object.entries(P)) {
      expect(srvMod.PERMS[k], `server PERMS.${k}`).toBe(v);
      // клиент: ищем «KEY: 1 << n» или «KEY: число»
      const m = cliSrc.match(new RegExp(`\\b${k}\\s*:\\s*(1\\s*<<\\s*(\\d+)|\\d+)`));
      expect(m, `public/js/perms.js содержит ${k}`).toBeTruthy();
      const val = m[2] !== undefined ? 1 << Number(m[2]) : Number(m[1]);
      expect(val, `client PERMS.${k}`).toBe(v);
    }
    const def = srvMod.DEFAULT_EVERYONE ?? srvMod.PERMS.DEFAULT_EVERYONE;
    expect(def).toBe(DEFAULT_EVERYONE);
  });

  test('новый сервер: @everyone (id=server.id, position 0, DEFAULT_EVERYONE), пустые memberRoles/bans/overwrites, description, banner', async () => {
    const { srv, owner, members: [b] } = await g(1);
    expect(Array.isArray(srv.roles)).toBe(true);
    const ev = srv.roles.find((r) => r.id === srv.id);
    expect(ev).toMatchObject({ id: srv.id, position: 0, permissions: DEFAULT_EVERYONE });
    expect(srv.memberRoles).toEqual({});
    expect(srv.channelOverwrites).toEqual({});
    expect(srv.description).toBe('');
    expect(srv.banner).toBeNull();
    // bans: владельцу — объект, участнику без BAN_MEMBERS — null
    expect((await viewOf(owner, srv.id)).bans).toEqual({});
    expect((await viewOf(b, srv.id)).bans).toBeNull();
    // бот не в ролях
    const vb = await viewOf(b, srv.id);
    const botId = (await ack(owner.socket, 'bootstrap')).servers.find((s) => s.id === srv.id).memberIds.find((id) => id !== owner.id && id !== b.id);
    expect(vb.memberRoles[botId]).toBeUndefined();
  });

  test('inviteCode только при CREATE_INVITE (иначе null)', async () => {
    const { srv, owner, members: [b] } = await g(1);
    expect((await viewOf(b, srv.id)).inviteCode).toMatch(/^[a-z0-9]{8}$/);
    const upd = waitEvent(b.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.inviteCode === null);
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.CREATE_INVITE);
    await upd;
    expect((await viewOf(b, srv.id)).inviteCode).toBeNull();
    expect((await viewOf(owner, srv.id)).inviteCode).toMatch(/^[a-z0-9]{8}$/);
  });
});

test.describe('v3 роли: CRUD, порядок, выдача', () => {
  test('role:create/update/reorder/delete; валидация; @everyone нельзя удалить/переименовать', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const r1 = await makeRole(owner, srv.id, { name: 'Админы', color: '#ff0000', permissions: P.KICK_MEMBERS });
    expect(r1).toMatchObject({ name: 'Админы', color: '#ff0000', permissions: P.KICK_MEMBERS });
    expect(r1.position).toBeGreaterThan(0);
    expect(typeof r1.hoist).toBe('boolean');
    expect(typeof r1.mentionable).toBe('boolean');
    const r2 = await makeRole(owner, srv.id, { name: 'Модеры' });
    // update
    const upd = waitEvent(b.socket, 'server:updated', (d) => d.server?.roles?.some((r) => r.id === r2.id && r.hoist === true && r.color === '#00ff00'));
    await ok(owner.socket, 'role:update', { serverId: srv.id, roleId: r2.id, color: '#00ff00', hoist: true, mentionable: true, permissions: P.MANAGE_MESSAGES });
    await upd;
    // валидация
    await denied(owner.socket, 'role:create', { serverId: srv.id, name: 'x'.repeat(33) });
    await denied(owner.socket, 'role:update', { serverId: srv.id, roleId: r2.id, color: 'red' });
    await denied(owner.socket, 'role:update', { serverId: srv.id, roleId: r2.id, name: '' });
    await denied(owner.socket, 'role:update', { serverId: srv.id, roleId: srv.id, name: 'все' });
    await denied(owner.socket, 'role:delete', { serverId: srv.id, roleId: srv.id });
    // порядок: сверху вниз [r2, r1] → r2 выше
    await ok(owner.socket, 'role:reorder', { serverId: srv.id, roleIds: [r2.id, r1.id] });
    let v = await viewOf(owner, srv.id);
    const pos = (id) => v.roles.find((r) => r.id === id).position;
    expect(pos(r2.id)).toBeGreaterThan(pos(r1.id));
    expect(pos(r1.id)).toBeGreaterThan(0);
    expect(pos(srv.id)).toBe(0);
    await ok(owner.socket, 'role:reorder', { serverId: srv.id, roleIds: [r1.id, r2.id] });
    v = await viewOf(owner, srv.id);
    expect(pos(r1.id)).toBeGreaterThan(pos(r2.id));
    // выдача и удаление роли чистит memberRoles
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [r1.id, r2.id] });
    v = await viewOf(b, srv.id);
    expect([...v.memberRoles[b.id]].sort()).toEqual([r1.id, r2.id].sort());
    await ok(owner.socket, 'role:delete', { serverId: srv.id, roleId: r1.id });
    v = await viewOf(b, srv.id);
    expect(v.roles.some((r) => r.id === r1.id)).toBe(false);
    expect(v.memberRoles[b.id] || []).toEqual([r2.id]);
    // несуществующая роль в member:roles
    await denied(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: ['nope'] });
  });

  test('без MANAGE_ROLES нельзя создавать/менять роли; с MANAGE_ROLES — только ниже своей высшей', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    await denied(b.socket, 'role:create', { serverId: srv.id, name: 'хак' });
    await denied(b.socket, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: -1 >>> 1 });
    const top = await makeRole(owner, srv.id, { name: 'Топ' });
    const mod = await makeRole(owner, srv.id, { name: 'Мод', permissions: P.MANAGE_ROLES });
    const low = await makeRole(owner, srv.id, { name: 'Низ' });
    await ok(owner.socket, 'role:reorder', { serverId: srv.id, roleIds: [top.id, mod.id, low.id] });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [mod.id] });
    // b может выдать «Низ», но не «Топ» и не свою «Мод»
    await ok(b.socket, 'member:roles', { serverId: srv.id, userId: c.id, roleIds: [low.id] });
    await denied(b.socket, 'member:roles', { serverId: srv.id, userId: c.id, roleIds: [top.id] });
    await denied(b.socket, 'member:roles', { serverId: srv.id, userId: c.id, roleIds: [low.id, mod.id] });
    // b не может трогать роль «Топ»
    await denied(b.socket, 'role:update', { serverId: srv.id, roleId: top.id, name: 'взлом' });
    await denied(b.socket, 'role:delete', { serverId: srv.id, roleId: top.id });
    // и не может снять роли у владельца
    await denied(b.socket, 'member:roles', { serverId: srv.id, userId: owner.id, roleIds: [] });
    // может создать роль (появится ниже его высшей) и менять «Низ»
    const created = await makeRole(b, srv.id, { name: 'От мода' });
    const v = await viewOf(owner, srv.id);
    const pos = (id) => v.roles.find((r) => r.id === id).position;
    expect(pos(created.id)).toBeLessThan(pos(mod.id));
    await ok(b.socket, 'role:update', { serverId: srv.id, roleId: low.id, name: 'Низ2' });
    // нельзя выдать себе права, которых у него нет (эскалация через роль ниже)
    const r = await ack(b.socket, 'role:update', { serverId: srv.id, roleId: low.id, permissions: P.ADMINISTRATOR });
    if (r.ok) {
      // если сервер разрешил — проверим, что это не дало реальной эскалации c (роль ниже b)
      const vv = await viewOf(owner, srv.id);
      expect(vv.roles.find((x) => x.id === low.id).permissions & P.ADMINISTRATOR, 'MANAGE_ROLES не должен позволять выдавать ADMINISTRATOR').toBe(0);
    }
  });
});

test.describe('v3 права: сообщения', () => {
  test('SEND_MESSAGES: снять у @everyone → ошибка; роль с правом → можно; владелец всегда может', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const ch = textChannel(srv);
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'до' });
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.SEND_MESSAGES);
    await denied(b.socket, 'message:send', { channelId: ch.id, content: 'после' });
    await ok(owner.socket, 'message:send', { channelId: ch.id, content: 'владелец' });
    const speaker = await makeRole(owner, srv.id, { name: 'Говорун', permissions: P.SEND_MESSAGES });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [speaker.id] });
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'с ролью' });
    const h = await ok(b.socket, 'message:history', { channelId: ch.id });
    expect(h.messages.map((m) => m.content)).toEqual(['до', 'владелец', 'с ролью']);
  });

  test('ATTACH_FILES: без права вложение отклоняется, текст проходит', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const ch = textChannel(srv);
    const att = await uploadAttachment(b);
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'файл', attachments: [att] });
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.ATTACH_FILES);
    await denied(b.socket, 'message:send', { channelId: ch.id, content: 'файл2', attachments: [att] });
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'просто текст' });
  });

  test('MANAGE_MESSAGES: без права чужое не удалить; своё — можно; с правом — чужое удаляется', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const ch = textChannel(srv);
    const mo = (await ok(owner.socket, 'message:send', { channelId: ch.id, content: 'от владельца' })).message;
    const mb = (await ok(b.socket, 'message:send', { channelId: ch.id, content: 'от b' })).message;
    await denied(b.socket, 'message:delete', { messageId: mo.id });
    await ok(b.socket, 'message:delete', { messageId: mb.id });
    const mod = await makeRole(owner, srv.id, { name: 'Чистильщик', permissions: P.MANAGE_MESSAGES });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [mod.id] });
    const del = waitEvent(owner.socket, 'message:deleted', (d) => d.messageId === mo.id);
    await ok(b.socket, 'message:delete', { messageId: mo.id });
    await del;
  });

  test('overwrite канала: deny SEND для @everyone в одном канале, allow для роли перекрывает', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    const ch = textChannel(srv);
    const other = (await ok(owner.socket, 'channel:create', { serverId: srv.id, name: 'объявления', type: 'text' })).channel;
    const writer = await makeRole(owner, srv.id, { name: 'Писатель' });
    await ok(owner.socket, 'channel:update', { channelId: other.id, overwrites: {
      [srv.id]: { allow: 0, deny: P.SEND_MESSAGES }, [writer.id]: { allow: P.SEND_MESSAGES, deny: 0 } } });
    expect((await viewOf(owner, srv.id)).channelOverwrites[other.id][srv.id]).toEqual({ allow: 0, deny: P.SEND_MESSAGES });
    await denied(b.socket, 'message:send', { channelId: other.id, content: 'нельзя' });
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'в общем можно' });
    // читать можно
    await ok(b.socket, 'message:history', { channelId: other.id });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: c.id, roleIds: [writer.id] });
    await ok(c.socket, 'message:send', { channelId: other.id, content: 'а с ролью можно' });
    // без MANAGE_CHANNELS менять overwrites нельзя
    await denied(b.socket, 'channel:update', { channelId: other.id, overwrites: {} });
    await denied(b.socket, 'channel:update', { channelId: other.id, name: 'взлом' });
  });
});

test.describe('v3 права: приватный канал', () => {
  test('deny VIEW_CHANNEL у @everyone + allow роли: канал не виден, история/typing/сообщения не приходят; роль открывает', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    const vip = await makeRole(owner, srv.id, { name: 'VIP' });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: c.id, roleIds: [vip.id] });
    const secret = (await ok(owner.socket, 'channel:create', { serverId: srv.id, name: 'секрет', type: 'text' })).channel;
    const secretVoice = (await ok(owner.socket, 'channel:create', { serverId: srv.id, name: 'тайная', type: 'voice' })).channel;
    const ow = { [srv.id]: { allow: 0, deny: P.VIEW_CHANNEL }, [vip.id]: { allow: P.VIEW_CHANNEL, deny: 0 } };
    const updB = waitEvent(b.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.channelOverwrites?.[secretVoice.id]);
    const updC = waitEvent(c.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.channelOverwrites?.[secretVoice.id]);
    await ok(owner.socket, 'channel:update', { channelId: secret.id, overwrites: ow });
    await ok(owner.socket, 'channel:update', { channelId: secretVoice.id, overwrites: ow });
    const sb = (await updB).server; const sc = (await updC).server;
    expect(sb.channels.map((x) => x.id)).not.toContain(secret.id);
    expect(sb.channels.map((x) => x.id)).not.toContain(secretVoice.id);
    expect(sc.channels.map((x) => x.id)).toEqual(expect.arrayContaining([secret.id, secretVoice.id]));
    expect((await viewOf(b, srv.id)).channels.map((x) => x.id)).not.toContain(secret.id);
    // история и отправка
    await denied(b.socket, 'message:history', { channelId: secret.id });
    await denied(b.socket, 'message:send', { channelId: secret.id, content: 'я тут' });
    await denied(b.socket, 'voice:join', { channelId: secretVoice.id });
    // сообщения и typing не утекают
    const gotB = collect(b.socket, 'message:new'); const typB = collect(b.socket, 'typing');
    const vmB = collect(b.socket, 'voice:members');
    const inC = waitEvent(c.socket, 'message:new', (d) => d.message?.channelId === secret.id);
    const typC = waitEvent(c.socket, 'typing', (d) => d.channelId === secret.id);
    owner.socket.emit('typing', { channelId: secret.id });
    await ok(owner.socket, 'message:send', { channelId: secret.id, content: 'тайна' });
    await ok(c.socket, 'voice:join', { channelId: secretVoice.id });
    await inC; await typC;
    await sleep(700);
    expect(gotB.filter((d) => d.message?.channelId === secret.id)).toEqual([]);
    expect(typB.filter((d) => d.channelId === secret.id)).toEqual([]);
    expect(vmB.filter((d) => d.channelId === secretVoice.id), 'voice:members приватного канала не уходят b').toEqual([]);
    expect((await ack(b.socket, 'bootstrap')).voice?.[secretVoice.id], 'bootstrap.voice без приватного канала').toBeUndefined();
    await ok(c.socket, 'voice:leave');
    // выдали роль → канал появился, история доступна
    const appear = waitEvent(b.socket, 'server:updated', (d) => d.server?.channels?.some((x) => x.id === secret.id));
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [vip.id] });
    await appear;
    const h = await ok(b.socket, 'message:history', { channelId: secret.id });
    expect(h.messages.map((m) => m.content)).toContain('тайна');
  });

  test('ADMINISTRATOR и владелец игнорируют overwrites; ADMINISTRATOR может всё, кроме удаления/передачи', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    const admin = await makeRole(owner, srv.id, { name: 'Админ', permissions: P.ADMINISTRATOR });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [admin.id] });
    const secret = (await ok(owner.socket, 'channel:create', { serverId: srv.id, name: 'закрытый', type: 'text' })).channel;
    await ok(owner.socket, 'channel:update', { channelId: secret.id, overwrites: { [srv.id]: { allow: 0, deny: P.VIEW_CHANNEL | P.SEND_MESSAGES } } });
    await ok(owner.socket, 'message:send', { channelId: secret.id, content: 'владелец пишет' });
    expect((await viewOf(b, srv.id)).channels.map((x) => x.id)).toContain(secret.id);
    await ok(b.socket, 'message:send', { channelId: secret.id, content: 'админ пишет' });
    expect((await viewOf(c, srv.id)).channels.map((x) => x.id)).not.toContain(secret.id);
    // админ: переименование, описание, каналы, бан-лист виден
    await ok(b.socket, 'server:update', { serverId: srv.id, name: 'Переименован', description: 'описание' });
    const v = await viewOf(c, srv.id);
    expect(v).toMatchObject({ name: 'Переименован', description: 'описание' });
    expect((await viewOf(b, srv.id)).bans).toEqual({});
    await ok(b.socket, 'channel:create', { serverId: srv.id, name: 'от-админа', type: 'text' });
    // но не удаление сервера и не передача владения
    await denied(b.socket, 'server:delete', { serverId: srv.id });
    await denied(b.socket, 'server:transfer', { serverId: srv.id, userId: b.id });
    // и не кик владельца
    await denied(b.socket, 'member:kick', { serverId: srv.id, userId: owner.id });
  });
});

test.describe('v3 server:update', () => {
  test('MANAGE_SERVER: name/description(≤300)/regenerateInvite; без права — отказ', async () => {
    const { srv, owner, members: [b] } = await g(1);
    await denied(b.socket, 'server:update', { serverId: srv.id, name: 'взлом' });
    await denied(b.socket, 'server:update', { serverId: srv.id, regenerateInvite: true });
    await denied(b.socket, 'server:rename', { serverId: srv.id, name: 'взлом' });
    await ok(owner.socket, 'server:update', { serverId: srv.id, description: 'д'.repeat(300) });
    await denied(owner.socket, 'server:update', { serverId: srv.id, description: 'д'.repeat(301) });
    const before = (await viewOf(owner, srv.id)).inviteCode;
    await ok(owner.socket, 'server:update', { serverId: srv.id, regenerateInvite: true });
    const after = (await viewOf(owner, srv.id)).inviteCode;
    expect(after).toMatch(/^[a-z0-9]{8}$/);
    expect(after).not.toBe(before);
    // старый инвайт больше не работает
    const x = await makeUser('x'); track(x);
    await denied(x.socket, 'server:join', { inviteCode: before });
    await ok(x.socket, 'server:join', { inviteCode: after });
    // роль с MANAGE_SERVER
    const mgr = await makeRole(owner, srv.id, { name: 'Менеджер', permissions: P.MANAGE_SERVER });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [mgr.id] });
    await ok(b.socket, 'server:update', { serverId: srv.id, name: 'От менеджера' });
    await ok(b.socket, 'server:rename', { serverId: srv.id, name: 'Через rename' });
    await denied(b.socket, 'channel:create', { serverId: srv.id, name: 'нет', type: 'text' });
  });
});

test.describe('v3 модерация: кик, бан, иерархия', () => {
  test('кик: server:removed {reason:"kick"}, можно вернуться по инвайту; без KICK_MEMBERS — отказ', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    await denied(c.socket, 'member:kick', { serverId: srv.id, userId: b.id });
    const removed = waitEvent(b.socket, 'server:removed', (d) => d.serverId === srv.id);
    await ok(owner.socket, 'member:kick', { serverId: srv.id, userId: b.id, reason: 'тест' });
    expect(await removed).toMatchObject({ serverId: srv.id, reason: 'kick' });
    expect((await viewOf(owner, srv.id)).memberIds).not.toContain(b.id);
    expect(await viewOf(b, srv.id)).toBeNull();
    await denied(b.socket, 'message:send', { channelId: textChannel(srv).id, content: 'я ещё тут?' });
    await ok(b.socket, 'server:join', { inviteCode: srv.inviteCode });
  });

  test('иерархия: модератор кикает рядового, но не админа выше и не владельца', async () => {
    const { srv, owner, members: [admin, mod, plain] } = await g(3);
    const rAdmin = await makeRole(owner, srv.id, { name: 'Админ', permissions: P.KICK_MEMBERS | P.BAN_MEMBERS });
    const rMod = await makeRole(owner, srv.id, { name: 'Модер', permissions: P.KICK_MEMBERS | P.BAN_MEMBERS | P.MUTE_MEMBERS | P.MOVE_MEMBERS });
    await ok(owner.socket, 'role:reorder', { serverId: srv.id, roleIds: [rAdmin.id, rMod.id] });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: admin.id, roleIds: [rAdmin.id] });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: mod.id, roleIds: [rMod.id] });
    await denied(mod.socket, 'member:kick', { serverId: srv.id, userId: admin.id });
    await denied(mod.socket, 'member:ban', { serverId: srv.id, userId: admin.id });
    await denied(mod.socket, 'member:kick', { serverId: srv.id, userId: owner.id });
    await denied(admin.socket, 'member:kick', { serverId: srv.id, userId: owner.id });
    // равные по роли тоже не могут
    const mod2 = await makeUser('mod2'); track(mod2);
    await ok(mod2.socket, 'server:join', { inviteCode: srv.inviteCode });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: mod2.id, roleIds: [rMod.id] });
    await denied(mod.socket, 'member:kick', { serverId: srv.id, userId: mod2.id });
    // ниже — можно
    await ok(mod.socket, 'member:kick', { serverId: srv.id, userId: plain.id });
    await ok(admin.socket, 'member:kick', { serverId: srv.id, userId: mod.id });
    // бота кикнуть нельзя
    const botId = (await viewOf(owner, srv.id)).memberIds.find((id) => ![owner.id, admin.id, mod2.id].includes(id));
    await denied(owner.socket, 'member:kick', { serverId: srv.id, userId: botId });
  });

  test('бан: server:removed {reason:"ban"}, «Вы заблокированы на этом сервере» по инвайту, bans видны только BAN_MEMBERS, deleteMessages, разбан', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    const ch = textChannel(srv);
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'спам 1' });
    await ok(b.socket, 'message:send', { channelId: ch.id, content: 'спам 2' });
    await ok(c.socket, 'message:send', { channelId: ch.id, content: 'нормальное' });
    await denied(c.socket, 'member:ban', { serverId: srv.id, userId: b.id });
    const removed = waitEvent(b.socket, 'server:removed', (d) => d.serverId === srv.id);
    await ok(owner.socket, 'member:ban', { serverId: srv.id, userId: b.id, reason: 'спам', deleteMessages: true });
    expect(await removed).toMatchObject({ serverId: srv.id, reason: 'ban' });
    const vo = await viewOf(owner, srv.id);
    expect(vo.memberIds).not.toContain(b.id);
    expect(vo.bans[b.id]).toMatchObject({ by: owner.id, reason: 'спам' });
    expect(typeof vo.bans[b.id].at).toBe('number');
    expect((await viewOf(c, srv.id)).bans).toBeNull();
    const h = await ok(owner.socket, 'message:history', { channelId: ch.id });
    expect(h.messages.map((m) => m.content)).toEqual(['нормальное']);
    await denied(b.socket, 'server:join', { inviteCode: srv.inviteCode }, /Вы заблокированы на этом сервере/);
    // разбан: без права нельзя
    await denied(c.socket, 'member:unban', { serverId: srv.id, userId: b.id });
    await ok(owner.socket, 'member:unban', { serverId: srv.id, userId: b.id });
    expect((await viewOf(owner, srv.id)).bans[b.id]).toBeUndefined();
    await ok(b.socket, 'server:join', { inviteCode: srv.inviteCode });
  });

  test('передача владения: только владелец; новый владелец может всё, бывший — нет', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    await denied(b.socket, 'server:transfer', { serverId: srv.id, userId: b.id });
    const outsider = await makeUser('out'); track(outsider);
    await denied(owner.socket, 'server:transfer', { serverId: srv.id, userId: outsider.id });
    const upd = waitEvent(c.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.ownerId === b.id);
    await ok(owner.socket, 'server:transfer', { serverId: srv.id, userId: b.id });
    await upd;
    await denied(owner.socket, 'server:delete', { serverId: srv.id });
    await denied(owner.socket, 'server:update', { serverId: srv.id, name: 'уже не мой' });
    await ok(b.socket, 'server:update', { serverId: srv.id, name: 'теперь мой' });
    // бывший владелец теперь может выйти
    await ok(owner.socket, 'server:leave', { serverId: srv.id });
    await ok(b.socket, 'server:delete', { serverId: srv.id });
  });
});

test.describe('v3 права: голос', () => {
  test('CONNECT: без права voice:join отклоняется', async () => {
    const { srv, owner, members: [b] } = await g(1);
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.CONNECT);
    await denied(b.socket, 'voice:join', { channelId: voiceChannel(srv).id });
    await ok(owner.socket, 'voice:join', { channelId: voiceChannel(srv).id });
  });

  test('SPEAK: без права вход с серверным mute, клиент сам его не снимет', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const vc = voiceChannel(srv);
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.SPEAK);
    const vm = waitEvent(owner.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.userId === b.id));
    await ok(b.socket, 'voice:join', { channelId: vc.id });
    const me = (await vm).members.find((m) => m.userId === b.id);
    expect(me.serverMute, 'serverMute у вошедшего без SPEAK').toBe(true);
    b.socket.emit('voice:state', { muted: false });
    await sleep(500);
    const snap = (await ack(owner.socket, 'bootstrap')).voice[vc.id].find((m) => m.userId === b.id);
    expect(snap.serverMute).toBe(true);
  });

  test('STREAM: без права streaming/camera=true не применяются; с правом — применяются', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const vc = voiceChannel(srv);
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.STREAM);
    await ok(b.socket, 'voice:join', { channelId: vc.id });
    const states = collect(owner.socket, 'voice:members');
    let r = await b.socket.timeout(1500).emitWithAck('voice:state', { streaming: true, camera: true }).catch(() => null);
    if (r) expect(r.ok, 'ack voice:state без STREAM').toBe(false);
    await sleep(600);
    const snap = (await ack(owner.socket, 'bootstrap')).voice[vc.id].find((m) => m.userId === b.id);
    expect(snap).toMatchObject({ streaming: false, camera: false });
    expect(states.flatMap((d) => d.members).filter((m) => m.userId === b.id && (m.streaming || m.camera))).toEqual([]);
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE);
    const on = waitEvent(owner.socket, 'voice:members', (d) => d.members.some((m) => m.userId === b.id && m.streaming));
    b.socket.emit('voice:state', { streaming: true });
    await on;
  });

  test('member:voice: серверный mute/deafen, перемещение (voice:moved), отключение; без прав и против старших — отказ', async () => {
    const { srv, owner, members: [b, c] } = await g(2);
    const vc = voiceChannel(srv);
    const vc2 = (await ok(owner.socket, 'channel:create', { serverId: srv.id, name: 'Второй', type: 'voice' })).channel;
    await ok(b.socket, 'voice:join', { channelId: vc.id });
    await ok(c.socket, 'voice:join', { channelId: vc.id });
    await denied(c.socket, 'member:voice', { serverId: srv.id, userId: b.id, serverMute: true });
    const muted = waitEvent(c.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.userId === b.id && m.serverMute === true && m.serverDeafen === true));
    await ok(owner.socket, 'member:voice', { serverId: srv.id, userId: b.id, serverMute: true, serverDeafen: true });
    await muted;
    const unmuted = waitEvent(c.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.userId === b.id && m.serverMute === false && m.serverDeafen === false));
    await ok(owner.socket, 'member:voice', { serverId: srv.id, userId: b.id, serverMute: false, serverDeafen: false });
    await unmuted;
    // перемещение
    const moved = waitEvent(b.socket, 'voice:moved', () => true);
    await ok(owner.socket, 'member:voice', { serverId: srv.id, userId: b.id, moveTo: vc2.id });
    expect(await moved).toMatchObject({ channelId: vc2.id });
    // отключение c
    const gone = waitEvent(owner.socket, 'voice:members', (d) => d.channelId === vc.id && !d.members.some((m) => m.userId === c.id));
    await ok(owner.socket, 'member:voice', { serverId: srv.id, userId: c.id, moveTo: null });
    await gone;
    // роль с MUTE_MEMBERS, но не может трогать владельца
    const rm = await makeRole(owner, srv.id, { name: 'Глушитель', permissions: P.MUTE_MEMBERS | P.DEAFEN_MEMBERS | P.MOVE_MEMBERS });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: c.id, roleIds: [rm.id] });
    await ok(owner.socket, 'voice:join', { channelId: vc.id });
    await denied(c.socket, 'member:voice', { serverId: srv.id, userId: owner.id, serverMute: true });
    await denied(c.socket, 'member:voice', { serverId: srv.id, userId: owner.id, moveTo: null });
    // нельзя переместить в канал, куда цель/модератор не может зайти, или в несуществующий
    await denied(owner.socket, 'member:voice', { serverId: srv.id, userId: owner.id, moveTo: textChannel(srv).id });
  });
});

test.describe('v3 права: музыкальный бот', () => {
  let bot;
  test.beforeAll(async () => {
    const cfg = await http('GET', '/api/config');
    if (!cfg.json.botOnline) bot = await startBot();
  });
  test.afterAll(async () => { await bot?.stop(); });

  test('USE_MUSIC_BOT: без права music:command и !-команда → «Нет права управлять музыкой»', async () => {
    const { srv, owner, members: [b] } = await g(1);
    const vc = voiceChannel(srv); const ch = textChannel(srv);
    await setEveryone(owner, srv.id, DEFAULT_EVERYONE & ~P.USE_MUSIC_BOT);
    await ok(b.socket, 'voice:join', { channelId: vc.id });
    await denied(b.socket, 'music:command', { command: 'queue', args: '' }, /Нет права управлять музыкой/);
    const sys = waitEvent(b.socket, 'message:new', (d) => d.message?.system === true && d.message.channelId === ch.id);
    await ok(b.socket, 'message:send', { channelId: ch.id, content: '!queue' });
    expect((await sys).message.content).toMatch(/Нет права управлять музыкой/);
    // владелец может
    await ok(owner.socket, 'voice:join', { channelId: vc.id });
    await ok(owner.socket, 'music:command', { command: 'queue', args: '' });
  });
});
