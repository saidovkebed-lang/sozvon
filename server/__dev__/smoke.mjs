// Dev-проверка сервера: node server/__dev__/smoke.mjs https://localhost:3311 [--bot]
import { io } from 'socket.io-client';
import https from 'node:https';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'https://localhost:3311';
const WITH_BOT = process.argv.includes('--bot');
const agent = new https.Agent({ rejectUnauthorized: false });

async function api(method, p, body, token) {
  const u = new URL(p, BASE);
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(u, {
      method, agent,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const connect = (token) => new Promise((resolve, reject) => {
  const s = io(BASE, { auth: { token }, rejectUnauthorized: false, transports: ['websocket'] });
  s.on('connect', () => resolve(s));
  s.on('connect_error', (e) => reject(e));
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const waitFor = (s, ev, pred = () => true, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { s.off(ev, h); reject(new Error('timeout ' + ev)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } };
  s.on(ev, h);
});
const log = (...a) => console.log('✔', ...a);

const suffix = Math.random().toString(36).slice(2, 6);
const a = await api('POST', '/api/register', { username: 'alice_' + suffix, password: 'pass1234' });
const b = await api('POST', '/api/register', { username: 'bob_' + suffix, password: 'pass1234' });
assert.equal(a.status, 200); assert.equal(b.status, 200);
log('register x2');

// неверный токен
await connect('nope').then(() => assert.fail('должен быть отказ'), (e) => { assert.equal(e.message, 'unauthorized'); log('connect_error unauthorized'); });

const sa = await connect(a.body.token);
const sb = await connect(b.body.token);
const boot = await emit(sa, 'bootstrap');
assert.ok(boot.ok); assert.equal(boot.user.id, a.body.user.id);
log('bootstrap', JSON.stringify({ servers: boot.servers.length, voice: boot.voice, music: boot.music }));

const created = await emit(sa, 'server:create', { name: 'Тестовый' });
assert.ok(created.ok, JSON.stringify(created));
const srv = created.server;
assert.deepEqual(srv.channels.map((c) => [c.name, c.type]), [['общий', 'text'], ['Голосовой', 'voice']]);
assert.ok(srv.members.some((m) => m.isBot && m.username === 'DJ Бот'));
assert.match(srv.inviteCode, /^[a-z0-9]{8}$/);
log('server:create', srv.inviteCode, srv.members.map((m) => m.username).join(','));

const updA = waitFor(sa, 'server:updated', (d) => d.server.members.length === 3);
const joined = await emit(sb, 'server:join', { inviteCode: srv.inviteCode.toUpperCase() });
assert.ok(joined.ok, JSON.stringify(joined));
await updA;
assert.ok(joined.server.members.find((m) => m.id === a.body.user.id).online);
log('server:join + server:updated, alice online для bob');

const badJoin = await emit(sb, 'server:join', { inviteCode: 'zzzzzzzz' });
assert.equal(badJoin.ok, false); log('server:join неверный код →', badJoin.error);
const notOwner = await emit(sb, 'server:rename', { serverId: srv.id, name: 'x' });
assert.equal(notOwner.ok, false); log('server:rename не владельцем →', notOwner.error);

const text = srv.channels.find((c) => c.type === 'text');
const vch = srv.channels.find((c) => c.type === 'voice');
const typingB = waitFor(sb, 'typing');
sa.emit('typing', { channelId: text.id });
const ty = await typingB; assert.equal(ty.user.id, a.body.user.id); log('typing relay');

const newB = waitFor(sb, 'message:new');
const sent = await emit(sa, 'message:send', { channelId: text.id, content: 'Привет, Боб!' });
assert.ok(sent.ok); const got = await newB; assert.equal(got.message.content, 'Привет, Боб!');
log('message:send → message:new');
const empty = await emit(sa, 'message:send', { channelId: text.id, content: '   ' });
assert.equal(empty.ok, false); log('пустое сообщение →', empty.error);
const hist = await emit(sb, 'message:history', { channelId: text.id });
assert.ok(hist.ok); assert.equal(hist.messages.length, 1); log('message:history', hist.messages.length);
const delOther = await emit(sb, 'message:delete', { messageId: sent.message.id });
assert.equal(delOther.ok, false); log('удаление чужого →', delOther.error);

// голос
const membersEv = waitFor(sb, 'voice:members', (d) => d.channelId === vch.id && d.members.length === 1);
const ja = await emit(sa, 'voice:join', { channelId: vch.id });
assert.ok(ja.ok); assert.deepEqual(ja.peers, []); await membersEv;
const peerJoined = waitFor(sa, 'voice:peer-joined');
const jb = await emit(sb, 'voice:join', { channelId: vch.id });
assert.ok(jb.ok); assert.equal(jb.peers.length, 1); assert.equal(jb.peers[0].socketId, sa.id);
const pj = await peerJoined; assert.equal(pj.peer.socketId, sb.id);
log('voice:join x2, peers/peer-joined ok');

const sig = waitFor(sa, 'voice:signal');
sb.emit('voice:signal', { to: sa.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
const s1 = await sig; assert.equal(s1.from, sb.id); assert.equal(s1.data.description.type, 'offer');
log('voice:signal relay');
const st = waitFor(sb, 'voice:members', (d) => d.members.find((m) => m.socketId === sa.id)?.muted);
sa.emit('voice:state', { muted: true }); await st; log('voice:state muted → voice:members');
const spk = waitFor(sb, 'voice:speaking'); sa.emit('voice:speaking', { speaking: true });
assert.equal((await spk).socketId, sa.id); log('voice:speaking');

if (!WITH_BOT) {
  // бот офлайн → системное сообщение
  const sys = waitFor(sb, 'message:new', (d) => d.message.system);
  await emit(sa, 'message:send', { channelId: text.id, content: '!play qa' });
  const sm = await sys; log('бот офлайн → system:', sm.message.content, '| автор', sm.message.author.username);
  const mc = await emit(sa, 'music:command', { command: 'skip' });
  assert.equal(mc.ok, false); log('music:command офлайн →', mc.error);
} else {
  const cfg = await api('GET', '/api/config'); assert.equal(cfg.body.botOnline, true); log('config botOnline=true');
  const stateEv = waitFor(sb, 'music:state', (d) => d.track, 15000);
  const botMembers = waitFor(sb, 'voice:members', (d) => d.channelId === vch.id && d.members.some((m) => m.isBot), 15000);
  const reply = waitFor(sb, 'message:new', (d) => d.message.author.isBot && !d.message.system, 15000);
  await emit(sa, 'message:send', { channelId: text.id, content: '!play ' + (process.env.Q || 'sine') });
  const ms = await stateEv;
  log('music:state', JSON.stringify({ title: ms.track.title, url: ms.track.url, duration: ms.track.duration, paused: ms.paused, skew: ms.serverNow - Date.now() }));
  const bm = await botMembers; log('voice:members с ботом:', bm.members.map((m) => m.username + (m.isBot ? '(бот)' : '')).join(', '));
  log('ответ бота:', (await reply).message.content);

  const paused = waitFor(sb, 'music:state', (d) => d.paused);
  assert.ok((await emit(sa, 'music:command', { command: 'pause' })).ok);
  const p = await paused; log('music:command pause → paused, position', p.position.toFixed(2));
  const resumed = waitFor(sb, 'music:state', (d) => !d.paused && d.track);
  await emit(sa, 'message:send', { channelId: text.id, content: '!play' });
  await resumed; log('!play без аргументов при паузе → resume');

  const qreply = waitFor(sb, 'message:new', (d) => d.message.author.isBot && /очеред/i.test(d.message.content), 5000);
  await emit(sa, 'message:send', { channelId: text.id, content: '!queue' });
  log('!queue →', (await qreply).message.content.replace(/\n/g, ' | '));

  // все люди выходят → бот выходит
  const botLeft = waitFor(sb, 'voice:members', (d) => d.channelId === vch.id && d.members.length === 0, 8000);
  await emit(sa, 'voice:leave');
  await emit(sb, 'voice:leave');
  await botLeft; log('все вышли → bot:voice-empty → бот покинул канал');
}

const left = waitFor(sa, 'presence', (d) => d.userId === b.body.user.id && d.online === false);
sb.close(); await left; log('presence offline');
sa.close();
console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(0);
