// Dev-проверка прав и граничных случаев: node server/__dev__/edge.mjs https://localhost:3311
import { io } from 'socket.io-client';
import https from 'node:https';
import assert from 'node:assert/strict';
const BASE = process.argv[2];
const agent = new https.Agent({ rejectUnauthorized: false });
const api = (p, body, token, form) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = https.request(new URL(p, BASE), { method: 'POST', agent, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } }, (res) => {
    let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve(JSON.parse(buf)));
  });
  req.on('error', reject); req.write(data); req.end();
});
const connect = (token) => new Promise((res, rej) => { const s = io(BASE, { auth: { token }, rejectUnauthorized: false, transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const waitFor = (s, ev, pred = () => true, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout ' + ev)), ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } }; s.on(ev, h);
});
const x = Math.random().toString(36).slice(2, 6);
const A = await api('/api/register', { username: 'own_' + x, password: 'pass1234' });
const B = await api('/api/register', { username: 'gst_' + x, password: 'pass1234' });
const a = await connect(A.token), b = await connect(B.token);
const { server } = await emit(a, 'server:create', { name: '  Проверка   прав  ' });
assert.equal(server.name, 'Проверка прав');
await emit(b, 'server:join', { inviteCode: server.inviteCode });
const [text, vch] = server.channels;
const ok = (r, m) => { assert.ok(r.ok, JSON.stringify(r)); console.log('✔', m); };
const no = (r, m) => { assert.equal(r.ok, false); console.log('✔', m, '→', r.error); };
no(await emit(a, 'server:leave', { serverId: server.id }), 'владелец не может выйти');
no(await emit(b, 'channel:create', { serverId: server.id, name: 'x', type: 'text' }), 'не владелец создаёт канал');
no(await emit(a, 'channel:create', { serverId: server.id, name: 'x', type: 'video' }), 'неверный тип');
no(await emit(a, 'channel:create', { serverId: server.id, name: '', type: 'text' }), 'пустое имя');
const upd = waitFor(b, 'server:updated', (d) => d.server.channels.length === 3);
const ch = await emit(a, 'channel:create', { serverId: server.id, name: 'мемы', type: 'text' }); ok(ch, 'channel:create мемы, position ' + ch.channel.position);
await upd; console.log('✔ server:updated у гостя');
no(await emit(b, 'channel:delete', { channelId: ch.channel.id }), 'не владелец удаляет канал');
ok(await emit(a, 'channel:delete', { channelId: ch.channel.id }), 'channel:delete');
no(await emit(a, 'channel:delete', { channelId: text.id }), 'последний текстовый');
no(await emit(a, 'voice:join', { channelId: text.id }), 'voice:join в текстовый');
no(await emit(a, 'message:send', { channelId: vch.id, content: 'hi' }), 'сообщение в голосовой');
no(await emit(a, 'message:send', { channelId: text.id, content: 'x'.repeat(2001) }), '2001 символ');
no(await emit(a, 'message:send', { channelId: text.id, content: '', attachments: [{ url: '/media/uploads/../../db.json' }] }), 'поддельное вложение');
const m = await emit(b, 'message:send', { channelId: text.id, content: 'гость пишет' });
const del = waitFor(b, 'message:deleted');
ok(await emit(a, 'message:delete', { messageId: m.message.id }), 'владелец удаляет чужое');
await del; console.log('✔ message:deleted');
ok(await emit(a, 'server:rename', { serverId: server.id, name: 'Новое имя' }), 'rename');
// второй сокет того же пользователя → только в одном канале
const a2 = await connect(A.token);
await emit(a, 'voice:join', { channelId: vch.id });
const mem = waitFor(b, 'voice:members', (d) => d.members.length === 1 && d.members[0].socketId === a2.id);
await emit(a2, 'voice:join', { channelId: vch.id });
await mem; console.log('✔ вторая вкладка заменила первую в голосе');
// server:leave гостя
const rem = waitFor(b, 'server:removed');
ok(await emit(b, 'server:leave', { serverId: server.id }), 'гость вышел'); await rem; console.log('✔ server:removed гостю');
no(await emit(b, 'message:history', { channelId: text.id }), 'история после выхода');
const rem2 = waitFor(a2, 'server:removed');
no(await emit(b, 'server:delete', { serverId: server.id }), 'чужое удаление');
ok(await emit(a, 'server:delete', { serverId: server.id }), 'server:delete'); await rem2; console.log('✔ server:removed всем');
const boot = await emit(a, 'bootstrap'); assert.ok(!boot.servers.some((s) => s.id === server.id)); console.log('✔ bootstrap без удалённого');
a.close(); a2.close(); b.close(); console.log('\nEDGE: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'); process.exit(0);
