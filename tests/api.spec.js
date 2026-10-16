// Контрактные тесты REST + Socket.IO (SPEC §2–§4)
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  http, registerApi, uniqueName, connect, connected, connectUser, ack, waitEvent, collect,
  makeUser, createServer, textChannel, voiceChannel, sleep, waitFor, startBot,
} from './fixtures/api.js';
import { ensureMedia } from './fixtures/media.js';

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const sockets = [];
function track(...users) { for (const u of users) sockets.push(u.socket || u); return users; }
test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch {} } });

test.describe('REST: auth', () => {
  test('GET /api/config без авторизации', async () => {
    const r = await http('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.iceServers)).toBe(true);
    expect(r.json.iceServers.length).toBeGreaterThan(0);
    expect(typeof r.json.botOnline).toBe('boolean');
  });

  test('регистрация → {token,user}; user по модели', async () => {
    const name = uniqueName('reg');
    const r = await http('POST', '/api/register', { body: { username: name, password: 'pw123456' } });
    expect(r.status).toBe(200);
    expect(typeof r.json.token).toBe('string');
    expect(r.json.token.length).toBeGreaterThanOrEqual(32);
    const u = r.json.user;
    expect(u).toMatchObject({ username: name, isBot: false });
    expect(u.id).toBeTruthy();
    expect(u.color).toMatch(HEX);
    expect(u).not.toHaveProperty('password');
    expect(u).not.toHaveProperty('passwordHash');
  });

  test('регистрация: дубликат без учёта регистра → 400 {error}', async () => {
    const name = uniqueName('dup');
    await registerApi(name);
    const r = await http('POST', '/api/register', { body: { username: name.toUpperCase(), password: 'pw123456' } });
    expect(r.status).toBe(400);
    expect(typeof r.json.error).toBe('string');
    expect(r.json.error).toMatch(/[а-яё]/i);
  });

  test('регистрация: длина username 2–24', async () => {
    const short = await http('POST', '/api/register', { body: { username: 'a', password: 'pw123456' } });
    expect(short.status).toBe(400);
    expect(short.json.error).toBeTruthy();
    const long = await http('POST', '/api/register', { body: { username: 'x'.repeat(25), password: 'pw123456' } });
    expect(long.status).toBe(400);
    const two = await http('POST', '/api/register', { body: { username: 'q' + Math.random().toString(36).slice(2, 3), password: 'pw123456' } });
    expect([200, 400]).toContain(two.status); // 2 символа допустимы (400 только если занято)
    const exact24 = await http('POST', '/api/register', { body: { username: uniqueName('l').padEnd(24, 'z').slice(0, 24), password: 'pw123456' } });
    expect(exact24.status).toBe(200);
  });

  test('регистрация: пустые поля → 400', async () => {
    const r = await http('POST', '/api/register', { body: {} });
    expect(r.status).toBe(400);
    expect(r.json.error).toBeTruthy();
  });

  test('логин: верный → {token,user}; неверный пароль/логин → 401 {error}', async () => {
    const u = await registerApi();
    const ok = await http('POST', '/api/login', { body: { username: u.username, password: u.password } });
    expect(ok.status).toBe(200);
    expect(ok.json.user.id).toBe(u.user.id);
    expect(typeof ok.json.token).toBe('string');
    const okCase = await http('POST', '/api/login', { body: { username: u.username.toUpperCase(), password: u.password } });
    expect(okCase.status).toBe(200);
    const bad = await http('POST', '/api/login', { body: { username: u.username, password: 'wrong-pass' } });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toMatch(/[а-яё]/i);
    const nobody = await http('POST', '/api/login', { body: { username: uniqueName('none'), password: 'x' } });
    expect(nobody.status).toBe(401);
  });

  test('GET /api/me: с токеном → {user}; без/с плохим → 401', async () => {
    const u = await registerApi();
    const me = await http('GET', '/api/me', { token: u.token });
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe(u.user.id);
    expect((await http('GET', '/api/me')).status).toBe(401);
    expect((await http('GET', '/api/me', { token: 'deadbeef' })).status).toBe(401);
  });

  test('бот-пользователь DJ Бот: Authorization: Bot <token> принимается REST', async () => {
    const { botToken } = await import('./fixtures/api.js');
    const r = await http('GET', '/api/music', { token: 'Bot ' + botToken() });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.tracks)).toBe(true);
  });
});

test.describe('Socket.IO: подключение и bootstrap', () => {
  test('неверный токен → connect_error "unauthorized"', async () => {
    const s = connect('bad-token');
    sockets.push(s);
    const err = await connected(s).then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err.message).toBe('unauthorized');
  });

  test('bootstrap → {ok,user,servers,voice,music}', async () => {
    const u = await registerApi();
    const s = await connectUser(u.token);
    sockets.push(s);
    const b = await ack(s, 'bootstrap');
    expect(b.ok).toBe(true);
    expect(b.user.id).toBe(u.user.id);
    expect(b.user.online).toBe(true);
    expect(Array.isArray(b.servers)).toBe(true);
    expect(typeof b.voice).toBe('object');
    expect(typeof b.music).toBe('object');
  });
});

test.describe('Socket.IO: серверы, инвайты, права', () => {
  test('server:create → 2 канала, inviteCode, члены: владелец + DJ Бот', async () => {
    const a = await makeUser('own'); track(a);
    const srv = await createServer(a, 'Тестовый');
    expect(srv.name).toBe('Тестовый');
    expect(srv.ownerId).toBe(a.user.id);
    expect(srv.inviteCode).toMatch(/^[a-z0-9]{8}$/);
    expect(srv.icon).toBeNull();
    const names = srv.channels.map((c) => [c.name, c.type]);
    expect(names).toEqual(expect.arrayContaining([['общий', 'text'], ['Голосовой', 'voice']]));
    expect(srv.channels).toHaveLength(2);
    for (const c of srv.channels) {
      expect(c.serverId).toBe(srv.id);
      expect(typeof c.position).toBe('number');
    }
    const owner = srv.members.find((m) => m.id === a.user.id);
    expect(owner).toBeTruthy();
    const bot = srv.members.find((m) => m.isBot);
    expect(bot).toBeTruthy();
    expect(bot.username).toBe('DJ Бот');
    // bootstrap после создания содержит сервер
    const b = await ack(a.socket, 'bootstrap');
    expect(b.servers.map((s) => s.id)).toContain(srv.id);
  });

  test('server:create: пустое имя → ok:false', async () => {
    const a = await makeUser(); track(a);
    const r = await ack(a.socket, 'server:create', { name: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test('server:join по инвайту; server:updated владельцу; presence; неверный код', async () => {
    const a = await makeUser('own'); const b = await makeUser('inv'); track(a, b);
    const srv = await createServer(a);
    const upd = waitEvent(a.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.members.some((m) => m.id === b.user.id));
    const j = await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    expect(j.ok).toBe(true);
    expect(j.server.id).toBe(srv.id);
    const bm = j.server.members.find((m) => m.id === b.user.id);
    expect(bm.online).toBe(true);
    expect(j.server.members.find((m) => m.id === a.user.id).online).toBe(true);
    await upd;
    const bad = await ack(b.socket, 'server:join', { inviteCode: 'zzzzzzzz' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/[а-яё]/i);
    // повторный join — не дублирует участника
    const again = await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    if (again.ok) expect(again.server.members.filter((m) => m.id === b.user.id)).toHaveLength(1);
    // presence offline при отключении B
    const pres = waitEvent(a.socket, 'presence', (d) => d.userId === b.user.id && d.online === false);
    b.socket.disconnect();
    await pres;
  });

  test('права владельца: не-владелец не может rename/delete/channel:create/channel:delete', async () => {
    const a = await makeUser('own'); const b = await makeUser('mem'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const tc = textChannel(srv);
    for (const [ev, p] of [
      ['server:rename', { serverId: srv.id, name: 'hack' }],
      ['server:delete', { serverId: srv.id }],
      ['channel:create', { serverId: srv.id, name: 'hack', type: 'text' }],
      ['channel:delete', { channelId: tc.id }],
    ]) {
      const r = await ack(b.socket, ev, p);
      expect(r.ok, `${ev} не-владельцем должен быть запрещён`).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });

  test('владелец: rename, channel:create/delete, нельзя удалить последний текстовый, нельзя выйти', async () => {
    const a = await makeUser('own'); const b = await makeUser('mem'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const upd = waitEvent(b.socket, 'server:updated', (d) => d.server?.name === 'Новое имя');
    expect((await ack(a.socket, 'server:rename', { serverId: srv.id, name: 'Новое имя' })).ok).toBe(true);
    await upd;
    const cc = await ack(a.socket, 'channel:create', { serverId: srv.id, name: 'музыка', type: 'voice' });
    expect(cc.ok).toBe(true);
    expect(cc.channel).toMatchObject({ name: 'музыка', type: 'voice', serverId: srv.id });
    const ct = await ack(a.socket, 'channel:create', { serverId: srv.id, name: 'флуд', type: 'text' });
    expect(ct.ok).toBe(true);
    const badType = await ack(a.socket, 'channel:create', { serverId: srv.id, name: 'x', type: 'video' });
    expect(badType.ok).toBe(false);
    expect((await ack(a.socket, 'channel:delete', { channelId: cc.channel.id })).ok).toBe(true);
    expect((await ack(a.socket, 'channel:delete', { channelId: ct.channel.id })).ok).toBe(true);
    const last = await ack(a.socket, 'channel:delete', { channelId: textChannel(srv).id });
    expect(last.ok, 'последний текстовый канал удалить нельзя').toBe(false);
    const leave = await ack(a.socket, 'server:leave', { serverId: srv.id });
    expect(leave.ok, 'владелец не может выйти').toBe(false);
  });

  test('server:leave участника → server:removed ему; server:delete → server:removed всем', async () => {
    const a = await makeUser('own'); const b = await makeUser('mem'); const c = await makeUser('mem'); track(a, b, c);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    await ack(c.socket, 'server:join', { inviteCode: srv.inviteCode });
    const removedB = waitEvent(b.socket, 'server:removed', (d) => d.serverId === srv.id);
    const updA = waitEvent(a.socket, 'server:updated', (d) => d.server?.id === srv.id && !d.server.members.some((m) => m.id === b.user.id));
    expect((await ack(b.socket, 'server:leave', { serverId: srv.id })).ok).toBe(true);
    await removedB; await updA;
    const bb = await ack(b.socket, 'bootstrap');
    expect(bb.servers.map((s) => s.id)).not.toContain(srv.id);
    // B больше не может писать в канал
    const send = await ack(b.socket, 'message:send', { channelId: textChannel(srv).id, content: 'я вышел' });
    expect(send.ok).toBe(false);
    const removedC = waitEvent(c.socket, 'server:removed', (d) => d.serverId === srv.id);
    const removedA = waitEvent(a.socket, 'server:removed', (d) => d.serverId === srv.id);
    expect((await ack(a.socket, 'server:delete', { serverId: srv.id })).ok).toBe(true);
    await removedC; await removedA;
  });
});

test.describe('Socket.IO: сообщения', () => {
  test('message:send → message:new участникам; модель Message', async () => {
    const a = await makeUser('own'); const b = await makeUser('mem'); const out = await makeUser('out'); track(a, b, out);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const ch = textChannel(srv);
    const outsider = collect(out.socket, 'message:new');
    const got = waitEvent(b.socket, 'message:new', (d) => d.message?.content === 'привет, мир');
    const r = await ack(a.socket, 'message:send', { channelId: ch.id, content: 'привет, мир' });
    expect(r.ok).toBe(true);
    const m = r.message;
    expect(m).toMatchObject({ channelId: ch.id, content: 'привет, мир' });
    expect(m.id).toBeTruthy();
    expect(m.author.id).toBe(a.user.id);
    expect(m.author.username).toBe(a.username);
    expect(Array.isArray(m.attachments)).toBe(true);
    expect(Math.abs(m.createdAt - Date.now())).toBeLessThan(60_000);
    const ev = await got;
    expect(ev.message.id).toBe(m.id);
    await sleep(300);
    expect(outsider, 'не-участник не должен получать сообщения').toHaveLength(0);
    // не-участник не может писать / читать историю
    expect((await ack(out.socket, 'message:send', { channelId: ch.id, content: 'x' })).ok).toBe(false);
    expect((await ack(out.socket, 'message:history', { channelId: ch.id })).ok).toBe(false);
  });

  test('валидация: пустое / > 2000 символов → ok:false; ровно 2000 — ok', async () => {
    const a = await makeUser(); track(a);
    const ch = textChannel(await createServer(a));
    expect((await ack(a.socket, 'message:send', { channelId: ch.id, content: '' })).ok).toBe(false);
    expect((await ack(a.socket, 'message:send', { channelId: ch.id, content: '   ' })).ok).toBe(false);
    expect((await ack(a.socket, 'message:send', { channelId: ch.id, content: 'я'.repeat(2001) })).ok).toBe(false);
    expect((await ack(a.socket, 'message:send', { channelId: ch.id, content: 'я'.repeat(2000) })).ok).toBe(true);
  });

  test('message:history: ≤50, по возрастанию, пагинация before', async () => {
    const a = await makeUser(); track(a);
    const ch = textChannel(await createServer(a));
    // Сервер ограничивает 25 сообщений / 10 с на сокет (анти-флуд, вне SPEC) —
    // шлём 60 сообщений через 3 сокета одного пользователя по 20.
    const extra = [await connectUser(a.token), await connectUser(a.token)];
    sockets.push(...extra);
    const senders = [a.socket, ...extra];
    for (let i = 1; i <= 60; i++) {
      const r = await ack(senders[Math.floor((i - 1) / 20)], 'message:send', { channelId: ch.id, content: `msg ${i}` });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (i % 20 === 0) await sleep(5);
    }
    const h = await ack(a.socket, 'message:history', { channelId: ch.id });
    expect(h.ok).toBe(true);
    expect(h.messages.length).toBe(50);
    const times = h.messages.map((m) => m.createdAt);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(h.messages.at(-1).content).toBe('msg 60');
    expect(h.messages[0].content).toBe('msg 11');
    const older = await ack(a.socket, 'message:history', { channelId: ch.id, before: h.messages[0].createdAt });
    expect(older.ok).toBe(true);
    const contents = older.messages.map((m) => m.content);
    expect(contents).toContain('msg 1');
    expect(contents).not.toContain('msg 11');
    expect(contents.at(-1)).toBe('msg 10');
  });

  test('message:delete: автор — да, чужой — нет, владелец сервера — да; message:deleted рассылается', async () => {
    const a = await makeUser('own'); const b = await makeUser('mem'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const ch = textChannel(srv);
    const ma = (await ack(a.socket, 'message:send', { channelId: ch.id, content: 'от A' })).message;
    const mb = (await ack(b.socket, 'message:send', { channelId: ch.id, content: 'от B' })).message;
    const mb2 = (await ack(b.socket, 'message:send', { channelId: ch.id, content: 'от B 2' })).message;
    expect((await ack(b.socket, 'message:delete', { messageId: ma.id })).ok, 'B не может удалить сообщение A').toBe(false);
    const del = waitEvent(a.socket, 'message:deleted', (d) => d.messageId === mb.id && d.channelId === ch.id);
    expect((await ack(b.socket, 'message:delete', { messageId: mb.id })).ok).toBe(true);
    await del;
    expect((await ack(a.socket, 'message:delete', { messageId: mb2.id })).ok, 'владелец удаляет чужое').toBe(true);
    const h = await ack(a.socket, 'message:history', { channelId: ch.id });
    const ids = h.messages.map((m) => m.id);
    expect(ids).toContain(ma.id);
    expect(ids).not.toContain(mb.id);
    expect(ids).not.toContain(mb2.id);
  });

  test('typing → остальным участникам, не отправителю', async () => {
    const a = await makeUser('own'); const b = await makeUser('mem'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const ch = textChannel(srv);
    const selfTyping = collect(b.socket, 'typing');
    const got = waitEvent(a.socket, 'typing', (d) => d.channelId === ch.id && d.user?.id === b.user.id);
    b.socket.emit('typing', { channelId: ch.id });
    await got;
    await sleep(200);
    expect(selfTyping).toHaveLength(0);
  });

  test('вложения: upload → Attachment, файл отдаётся; вложение в сообщении; без файла/без auth → ошибка', async () => {
    const a = await makeUser(); track(a);
    const ch = textChannel(await createServer(a));
    const { image } = ensureMedia();
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(image)], { type: 'image/png' }), 'картинка.png');
    const up = await http('POST', '/api/attachments', { token: a.token, body: fd });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ type: 'image/png', size: fs.statSync(image).size });
    expect(up.json.url).toMatch(/^\/media\/uploads\//);
    expect(up.json.name).toBeTruthy();
    const file = await http('GET', up.json.url, { raw: true });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).length).toBe(fs.statSync(image).size);
    const m = await ack(a.socket, 'message:send', { channelId: ch.id, content: '', attachments: [up.json] });
    expect(m.ok, 'сообщение только с вложением допустимо').toBe(true);
    expect(m.message.attachments).toHaveLength(1);
    expect(m.message.attachments[0].url).toBe(up.json.url);
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('x')]), 'x.txt');
    expect((await http('POST', '/api/attachments', { body: fd2 })).status).toBe(401);
    const empty = await http('POST', '/api/attachments', { token: a.token, body: new FormData() });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBeTruthy();
  });

  test('вложения: > 25 МБ → ошибка {error}', async () => {
    const a = await registerApi();
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(26 * 1024 * 1024, 1)], { type: 'application/octet-stream' }), 'big.bin');
    const r = await http('POST', '/api/attachments', { token: a.token, body: fd });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.json.error).toBeTruthy();
  });
});

test.describe('Socket.IO: голос', () => {
  async function voiceSetup() {
    const a = await makeUser('va'); const b = await makeUser('vb'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    return { a, b, srv, vc: voiceChannel(srv) };
  }

  test('voice:join → peers без себя; peer-joined; voice:members; signal relay; state; speaking; leave', async () => {
    const { a, b, srv, vc } = await voiceSetup();
    const membersA = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.length === 1);
    const ja = await ack(a.socket, 'voice:join', { channelId: vc.id });
    expect(ja.ok).toBe(true);
    expect(ja.peers).toEqual([]);
    expect('music' in ja).toBe(true);
    const vm = (await membersA).members[0];
    expect(vm).toMatchObject({ socketId: a.socket.id, userId: a.user.id, username: a.username, isBot: false, muted: false, deafened: false, streaming: false, camera: false });
    expect(vm.color).toMatch(HEX);

    const joined = waitEvent(a.socket, 'voice:peer-joined', (d) => d.peer?.socketId === b.socket.id);
    const jb = await ack(b.socket, 'voice:join', { channelId: vc.id });
    expect(jb.ok).toBe(true);
    expect(jb.peers.map((p) => p.socketId)).toEqual([a.socket.id]);
    expect((await joined).peer.userId).toBe(b.user.id);

    // bootstrap отражает voice
    const boot = await ack(a.socket, 'bootstrap');
    expect((boot.voice[vc.id] || []).map((m) => m.socketId).sort()).toEqual([a.socket.id, b.socket.id].sort());

    // relay
    const sig = waitEvent(a.socket, 'voice:signal', (d) => d.from === b.socket.id && d.data?.description?.type === 'offer');
    b.socket.emit('voice:signal', { to: a.socket.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
    await sig;
    const cand = waitEvent(b.socket, 'voice:signal', (d) => d.from === a.socket.id && d.data?.candidate);
    a.socket.emit('voice:signal', { to: b.socket.id, data: { candidate: { candidate: 'c', sdpMid: '0' } } });
    await cand;

    // mute отражается в voice:members
    const muted = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.find((m) => m.socketId === a.socket.id)?.muted === true);
    a.socket.emit('voice:state', { muted: true });
    await muted;
    const live = waitEvent(a.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.find((m) => m.socketId === b.socket.id)?.streaming === true);
    b.socket.emit('voice:state', { streaming: true });
    await live;

    // speaking
    const spk = waitEvent(b.socket, 'voice:speaking', (d) => d.socketId === a.socket.id && d.speaking === true);
    a.socket.emit('voice:speaking', { speaking: true });
    await spk;

    // leave
    const left = waitEvent(a.socket, 'voice:peer-left', (d) => d.socketId === b.socket.id);
    expect((await ack(b.socket, 'voice:leave')).ok).toBe(true);
    await left;
    void srv;
  });

  test('только один голосовой канал; отключение сокета = выход', async () => {
    const { a, b, srv, vc } = await voiceSetup();
    const vc2 = (await ack(a.socket, 'channel:create', { serverId: srv.id, name: 'второй', type: 'voice' })).channel;
    await ack(a.socket, 'voice:join', { channelId: vc.id });
    await ack(b.socket, 'voice:join', { channelId: vc.id });
    const leftOnMove = waitEvent(b.socket, 'voice:peer-left', (d) => d.socketId === a.socket.id);
    const r = await ack(a.socket, 'voice:join', { channelId: vc2.id });
    expect(r.ok).toBe(true);
    expect(r.peers).toEqual([]);
    await leftOnMove;
    const boot = await ack(b.socket, 'bootstrap');
    expect((boot.voice[vc.id] || []).map((m) => m.socketId)).toEqual([b.socket.id]);
    expect((boot.voice[vc2.id] || []).map((m) => m.socketId)).toEqual([a.socket.id]);
    const gone = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc2.id && d.members.length === 0);
    a.socket.disconnect();
    await gone;
  });

  test('voice:join в текстовый / чужой канал → ok:false', async () => {
    const { a, srv } = await voiceSetup();
    const out = await makeUser('out'); track(out);
    expect((await ack(a.socket, 'voice:join', { channelId: textChannel(srv).id })).ok).toBe(false);
    expect((await ack(out.socket, 'voice:join', { channelId: voiceChannel(srv).id })).ok).toBe(false);
  });
});

test.describe('Бот офлайн', () => {
  test('music:command → ok:false "Музыкальный бот не запущен"', async () => {
    const cfg = await http('GET', '/api/config');
    test.skip(cfg.json.botOnline === true, 'бот уже запущен кем-то');
    const a = await makeUser(); track(a);
    const srv = await createServer(a);
    await ack(a.socket, 'voice:join', { channelId: voiceChannel(srv).id });
    const r = await ack(a.socket, 'music:command', { command: 'skip', args: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Музыкальный бот не запущен');
  });

  test('!play при офлайн-боте → сообщение сохраняется + системный ответ от DJ Бот', async () => {
    const a = await makeUser(); track(a);
    const srv = await createServer(a);
    const ch = textChannel(srv);
    const sys = waitEvent(a.socket, 'message:new', (d) => d.message?.system === true);
    const r = await ack(a.socket, 'message:send', { channelId: ch.id, content: '!play lofi' });
    expect(r.ok).toBe(true);
    const m = (await sys).message;
    expect(m.content).toContain('Музыкальный бот не запущен. Запустите: npm run bot');
    expect(m.author.isBot).toBe(true);
    expect(m.author.username).toBe('DJ Бот');
    expect(m.channelId).toBe(ch.id);
    const h = await ack(a.socket, 'message:history', { channelId: ch.id });
    expect(h.messages.map((x) => x.content)).toContain('!play lofi');
  });
});

test.describe('Музыкальная библиотека (REST)', () => {
  test('GET /api/music содержит предзагруженные треки; upload mp3 → track; Range → 206', async () => {
    const a = await registerApi();
    const lib = await http('GET', '/api/music', { token: a.token });
    expect(lib.status).toBe(200);
    const titles = lib.json.tracks.map((t) => `${t.title} ${t.artist} ${t.url}`).join('\n');
    expect(titles).toMatch(/440/);
    const { upload } = ensureMedia();
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(upload)], { type: 'audio/mpeg' }), 'qa-upload-550.mp3');
    const up = await http('POST', '/api/music/upload', { token: a.token, body: fd });
    expect(up.status).toBe(200);
    const t = up.json.track;
    expect(t.id).toBeTruthy();
    expect(t.url).toMatch(/^\/media\/music\//);
    expect(t.title).toBe('QA Upload Tone');
    expect(t.artist).toBe('QA Uploader');
    expect(t.duration).toBeGreaterThan(10);
    expect(t.duration).toBeLessThan(14);
    const lib2 = await http('GET', '/api/music', { token: a.token });
    expect(lib2.json.tracks.map((x) => x.id)).toContain(t.id);
    const range = await http('GET', t.url, { raw: true, headers: { Range: 'bytes=0-99' } });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).length).toBe(100);
    // не-аудио
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
    const bad = await http('POST', '/api/music/upload', { token: a.token, body: fd2 });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBeTruthy();
    expect((await http('GET', '/api/music')).status).toBe(401);
  });

  test('POST /api/music/import: некорректный url → 400 {error}', async () => {
    const a = await registerApi();
    const r = await http('POST', '/api/music/import', { token: a.token, body: { url: 'not a url' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBeTruthy();
  });
});

test.describe('Бот онлайн (дочерний процесс)', () => {
  let bot;
  test.beforeAll(async () => { bot = await startBot(); });
  test.afterAll(async () => { await bot?.stop(); });

  test('bot:status; !play → бот в голосе, music:state; !skip; !stop; music:command', async () => {
    test.setTimeout(90_000);
    const cfg = await http('GET', '/api/config');
    expect(cfg.json.botOnline).toBe(true);
    const a = await makeUser('dj'); const b = await makeUser('dl'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const ch = textChannel(srv); const vc = voiceChannel(srv);

    // не в голосе
    const notInVoice = waitEvent(a.socket, 'message:new', (d) => d.message?.author?.isBot && /зайди в голосовой канал/i.test(d.message.content), 10000);
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!play 440' });
    await notInVoice;

    await ack(a.socket, 'voice:join', { channelId: vc.id });
    await ack(b.socket, 'voice:join', { channelId: vc.id });
    const botIn = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.isBot), 10000);
    const st = waitEvent(b.socket, 'music:state', (d) => d.channelId === vc.id && d.track && /440/.test(d.track.title + d.track.url), 10000);
    // ставим два трека в очередь
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!play qa sine 440' });
    const botMember = (await botIn).members.find((m) => m.isBot);
    expect(botMember.username).toBe('DJ Бот');
    const s1 = await st;
    expect(s1.paused).toBe(false);
    expect(s1.track.url).toMatch(/^\/media\/music\//);
    expect(typeof s1.serverNow).toBe('number');
    expect(typeof s1.updatedAt).toBe('number');
    expect(Math.abs(s1.serverNow - Date.now())).toBeLessThan(5000);
    expect(s1.track.duration).toBeGreaterThan(25);
    const q = waitEvent(b.socket, 'music:state', (d) => d.channelId === vc.id && d.queue?.length >= 1, 10000);
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!play 660' });
    expect((await q).queue[0].title + (await q).queue[0].url).toMatch(/660/);

    // bootstrap/voice:join содержат music
    const boot = await ack(b.socket, 'bootstrap');
    expect(boot.music[vc.id]?.track).toBeTruthy();

    // pause через кнопку плеера (music:command)
    const paused = waitEvent(b.socket, 'music:state', (d) => d.channelId === vc.id && d.paused === true, 10000);
    expect((await ack(b.socket, 'music:command', { command: 'pause', args: '' })).ok).toBe(true);
    await paused;
    const resumed = waitEvent(b.socket, 'music:state', (d) => d.channelId === vc.id && d.paused === false, 10000);
    expect((await ack(b.socket, 'music:command', { command: 'resume', args: '' })).ok).toBe(true);
    await resumed;

    // !skip → следующий трек 660
    const skipped = waitEvent(b.socket, 'music:state', (d) => d.channelId === vc.id && d.track && /660/.test(d.track.title + d.track.url), 10000);
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!skip' });
    await skipped;

    // !stop → track null, бот выходит
    const stopped = waitEvent(b.socket, 'music:state', (d) => d.channelId === vc.id && d.track === null, 10000);
    const botOut = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc.id && !d.members.some((m) => m.isBot), 10000);
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!stop' });
    const s3 = await stopped;
    expect(s3.queue).toEqual([]);
    await botOut;
  });

  test('бот выходит, когда в голосовом канале не осталось людей (bot:voice-empty)', async () => {
    test.setTimeout(60_000);
    const a = await makeUser('dj'); const b = await makeUser('ob'); track(a, b);
    const srv = await createServer(a);
    await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode });
    const ch = textChannel(srv); const vc = voiceChannel(srv);
    await ack(a.socket, 'voice:join', { channelId: vc.id });
    const botIn = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.isBot), 10000);
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!play 880' });
    await botIn;
    const botOut = waitEvent(b.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.length === 0, 10000);
    await ack(a.socket, 'voice:leave');
    await botOut;
  });

  test('!help и !np отвечают в чат от DJ Бот', async () => {
    const a = await makeUser('dj'); track(a);
    const srv = await createServer(a);
    const ch = textChannel(srv);
    const help = waitEvent(a.socket, 'message:new', (d) => d.message?.author?.isBot && d.message.content.includes('play'), 10000);
    await ack(a.socket, 'message:send', { channelId: ch.id, content: '!help' });
    await help;
  });
});

test.describe('Импорт по прямой ссылке', () => {
  let srv; let base;
  test.beforeAll(async () => {
    const httpMod = await import('node:http');
    const { upload } = ensureMedia();
    srv = httpMod.createServer((req, res) => {
      if (req.url === '/tone.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(fs.readFileSync(upload)); }
      else if (req.url === '/page.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  test.afterAll(() => srv?.close());

  test('прямая ссылка на mp3 → {track}; 404 и html → 400 {error}', async () => {
    const a = await registerApi();
    const ok = await http('POST', '/api/music/import', { token: a.token, body: { url: `${base}/tone.mp3` } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.track.url).toMatch(/^\/media\/music\//);
    expect(ok.json.track.duration).toBeGreaterThan(10);
    const file = await http('GET', ok.json.track.url, { raw: true });
    expect(file.status).toBe(200);
    const nf = await http('POST', '/api/music/import', { token: a.token, body: { url: `${base}/missing.mp3` } });
    expect(nf.status).toBe(400);
    expect(nf.json.error).toBeTruthy();
    const html = await http('POST', '/api/music/import', { token: a.token, body: { url: `${base}/page.html` } });
    expect(html.status).toBe(400);
    expect(html.json.error).toMatch(/[а-яё]/i);
  });
});

test.describe('Бот: остальные команды и автопереход', () => {
  let bot;
  test.beforeAll(async () => { bot = await startBot(); });
  test.afterAll(async () => { await bot?.stop(); });

  async function room() {
    const a = await makeUser('dj'); track(a);
    const srv = await createServer(a);
    const ch = textChannel(srv); const vc = voiceChannel(srv);
    await ack(a.socket, 'voice:join', { channelId: vc.id });
    const say = async (content, re) => {
      const p = waitEvent(a.socket, 'message:new', (d) => d.message?.author?.isBot && d.message.channelId === ch.id && (!re || re.test(d.message.content)), 10000);
      await ack(a.socket, 'message:send', { channelId: ch.id, content });
      return (await p).message.content;
    };
    return { a, srv, ch, vc, say };
  }

  test('!queue, !np, !remove, !shuffle, !pause/!play (resume), !leave', async () => {
    test.setTimeout(60_000);
    const { a, vc, say } = await room();
    await say('!play 440', /440/);
    await say('!play 660', /660/);
    await say('!play 880', /880/);
    const q = await say('!queue', /660/);
    expect(q).toMatch(/880/);
    expect(await say('!np', /440/)).toBeTruthy();
    const removed = waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && d.queue.length === 1, 10000);
    await say('!remove 1');
    expect((await removed).queue[0].title).toMatch(/880/);
    await say('!shuffle');
    const paused = waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && d.paused === true, 10000);
    await say('!pause');
    const ps = await paused;
    expect(ps.position).toBeGreaterThanOrEqual(0);
    const resumed = waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && d.paused === false && d.track, 10000);
    await say('!play');
    const rs = await resumed;
    expect(rs.track.title).toMatch(/440/);
    expect(Math.abs(rs.position - ps.position), 'позиция сохраняется при паузе').toBeLessThan(1.5);
    const gone = waitEvent(a.socket, 'voice:members', (d) => d.channelId === vc.id && !d.members.some((m) => m.isBot), 10000);
    await say('!leave');
    await gone;
  });

  test('неизвестная команда → подсказка; play без результата → «ничего не нашёл»', async () => {
    const { say } = await room();
    expect(await say('!blabla')).toMatch(/help/);
    expect(await say('!play zzzz-no-such-track-qqq')).toMatch(/[Нн]ичего не нашёл|не найден/);
  });

  test('конец трека по duration → следующий из очереди, затем track:null', async () => {
    test.setTimeout(60_000);
    const { a, vc, say } = await room();
    await say('!play QA Upload Tone', /QA Upload Tone/); // 12 с, загружен ранее в тестах библиотеки
    await say('!play QA UI Upload', /QA UI Upload/).catch(() => {}); // может отсутствовать при изолированном запуске
    const next = waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && (d.track === null || !/QA Upload Tone/.test(d.track.title)), 20000);
    const st = await next;
    if (st.track) {
      expect(st.position).toBeLessThan(2);
    }
    await say('!stop');
  });

  test('bot:status приходит клиентам при остановке и запуске бота', async () => {
    test.setTimeout(60_000);
    const a = await makeUser(); track(a);
    const off = waitEvent(a.socket, 'bot:status', (d) => d.online === false, 15000);
    await bot.stop();
    await off;
    const on = waitEvent(a.socket, 'bot:status', (d) => d.online === true, 20000);
    bot = await startBot();
    await on;
  });
});

test.describe('Голос: один пользователь — один голосовой канал', () => {
  test('второй сокет того же пользователя заходит в голос → первый выбывает', async () => {
    const a = await makeUser('two'); const obs = await makeUser('obs'); track(a, obs);
    const srv = await createServer(a);
    await ack(obs.socket, 'server:join', { inviteCode: srv.inviteCode });
    const vc = voiceChannel(srv);
    const vc2 = (await ack(a.socket, 'channel:create', { serverId: srv.id, name: 'второй', type: 'voice' })).channel;
    const s2 = await connectUser(a.token); sockets.push(s2);
    expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    expect((await ack(s2, 'voice:join', { channelId: vc2.id })).ok).toBe(true);
    await sleep(500);
    const boot = await ack(obs.socket, 'bootstrap');
    const all = Object.values(boot.voice).flat().filter((m) => m.userId === a.user.id);
    expect(all.map((m) => m.socketId), 'пользователь должен быть только в одном голосовом канале').toEqual([s2.id]);
  });
});
