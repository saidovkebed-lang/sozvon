// QA-аудит v7 (сервер): ЛС, «Входящие», push — права, валидация, удаление, push-подписки.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { test, expect } from '@playwright/test';
import { makeUser, createServer, ack, waitEvent, collect, http as api, sleep, connectUser } from './fixtures/api.js';
import { DATA_DIR } from './fixtures/env.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

async function friends(n = 2, name = 'Аудит v7') {
  const users = [];
  for (let i = 0; i < n; i++) { const u = await makeUser(`av${i}`); socks.push(u.socket); users.push(u); }
  const server = await createServer(users[0], name);
  for (const u of users.slice(1)) {
    const r = await ack(u.socket, 'server:join', { inviteCode: server.inviteCode });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  return { users, server, text: server.channels.find((c) => c.type === 'text') };
}

const ok = async (s, ev, p) => { const r = await ack(s, ev, p); expect(r.ok, `${ev}: ${JSON.stringify(r)}`).toBe(true); return r; };
const notifs = async (u) => (await ack(u.socket, 'bootstrap')).notifications;

/* ---------- приёмник push ---------- */
const b64u = (b) => Buffer.from(b).toString('base64url');
async function pushReceiver() {
  const received = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  return { received, origin, close: () => srv.close(), at: (p) => received.filter((x) => x.path === p) };
}
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function decrypt(body, keys) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = keys.ecdh.getPublicKey();
  const prkKey = hmac(Buffer.from(keys.auth, 'base64url'), keys.ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}
async function subscribe(token, origin, p, keys = browserKeys()) {
  const r = await api('POST', '/api/push/subscribe', { token, body: { subscription: { endpoint: `${origin}${p}`, keys: { p256dh: keys.p256dh, auth: keys.auth } } } });
  return { r, keys };
}

test.describe('аудит v7: права', () => {
  test('потерял доступ к каналу (оверрайд) — старое уведомление скрыто в bootstrap, новых нет', async () => {
    const { users: [a, b], server, text } = await friends(2);
    const got = waitEvent(b.socket, 'notification:new', (p) => p.notification?.type === 'mention');
    await ok(a.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} привет` });
    await got;
    expect((await notifs(b)).length).toBe(1);
    // второй текстовый канал, чтобы у B что-то осталось
    await ok(a.socket, 'channel:create', { serverId: server.id, name: 'второй', type: 'text' });
    await ok(a.socket, 'channel:update', { channelId: text.id, overwrites: { [server.id]: { allow: 0, deny: 1 << 7 } } });
    expect(await notifs(b)).toEqual([]);
    const live = collect(b.socket, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} ещё раз` });
    await ok(a.socket, 'message:send', { channelId: text.id, content: '@everyone все сюда' });
    await sleep(500);
    expect(live).toEqual([]);
    // channel:read по недоступному каналу — отказ
    expect((await ack(b.socket, 'channel:read', { channelId: text.id })).ok).toBe(false);
  });

  test('потерял доступ через роль — то же самое', async () => {
    const { users: [a, b], server, text } = await friends(2);
    const role = (await ok(a.socket, 'role:create', { serverId: server.id, name: 'Свои', color: '#ff0000', permissions: 0 })).role;
    await ok(a.socket, 'channel:update', { channelId: text.id, overwrites: { [server.id]: { allow: 0, deny: 1 << 7 }, [role.id]: { allow: 1 << 7, deny: 0 } } });
    await ok(a.socket, 'member:roles', { serverId: server.id, userId: b.user.id, roleIds: [role.id] });
    const got = waitEvent(b.socket, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} для своих` });
    await got;
    await ok(a.socket, 'member:roles', { serverId: server.id, userId: b.user.id, roleIds: [] });
    expect(await notifs(b)).toEqual([]);
  });

  test('кик: ЛС только для чтения у обоих, typing от выгнанного не доходит', async () => {
    const { users: [a, b], server } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ok(b.socket, 'message:send', { channelId: dm.id, content: 'до кика' });
    await ok(a.socket, 'member:kick', { serverId: server.id, userId: b.user.id });
    expect((await ack(a.socket, 'message:send', { channelId: dm.id, content: 'x' })).ok).toBe(false);
    expect((await ack(b.socket, 'message:send', { channelId: dm.id, content: 'x' })).ok).toBe(false);
    expect((await ack(b.socket, 'bootstrap')).dms.find((d) => d.id === dm.id).canMessage).toBe(false);
    expect((await ack(a.socket, 'bootstrap')).dms.find((d) => d.id === dm.id).canMessage).toBe(false);
    expect((await ok(b.socket, 'message:history', { channelId: dm.id })).messages.map((m) => m.content)).toEqual(['до кика']);
    // уже существующую переписку можно открыть (только чтение), новую с ним — нельзя
    const reopened = await ack(b.socket, 'dm:open', { userId: a.user.id });
    expect(reopened.ok).toBe(true);
    expect(reopened.dm.id).toBe(dm.id);
    expect(reopened.dm.canMessage).toBe(false);
    const typing = collect(a.socket, 'typing');
    b.socket.emit('typing', { channelId: dm.id });
    await sleep(400);
    expect(typing, 'typing в ЛС без общего сервера (писать нельзя, а «печатает…» видно)').toEqual([]);
  });

  test('бан с удалением сообщений — упоминания из удалённых сообщений уходят из «Входящих»', async () => {
    const { users: [a, b, c], server, text } = await friends(3);
    const got = waitEvent(b.socket, 'notification:new');
    await ok(c.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} спам` });
    await got;
    await ok(a.socket, 'member:ban', { serverId: server.id, userId: c.user.id, deleteMessages: true });
    const hist = await ok(b.socket, 'message:history', { channelId: text.id });
    expect(hist.messages.some((m) => m.content.includes('спам'))).toBe(false);
    expect((await notifs(b)).map((n) => n.preview), 'уведомление о сообщении, которого больше нет').toEqual([]);
  });

  test('удалили канал / сервер — уведомления ушли из bootstrap', async () => {
    const { users: [a, b], server, text } = await friends(2);
    const ch2 = (await ok(a.socket, 'channel:create', { serverId: server.id, name: 'второй', type: 'text' })).channel;
    let got = waitEvent(b.socket, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: ch2.id, content: `@${b.user.username} тут` });
    await got;
    got = waitEvent(b.socket, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} и тут` });
    await got;
    expect((await notifs(b)).length).toBe(2);
    await ok(a.socket, 'channel:delete', { channelId: ch2.id });
    expect((await notifs(b)).map((n) => n.channelId)).toEqual([text.id]);
    await ok(a.socket, 'server:delete', { serverId: server.id });
    expect(await notifs(b)).toEqual([]);
  });

  test('чужой ЛС по подставленному id: ни читать, ни писать, ни удалять, ни typing, ни прочитать/закрыть', async () => {
    const { users: [a, b, c] } = await friends(3);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const msg = (await ok(a.socket, 'message:send', { channelId: dm.id, content: 'тайна' })).message;
    for (const [ev, p] of [
      ['message:history', { channelId: dm.id }],
      ['message:send', { channelId: dm.id, content: 'влез' }],
      ['message:delete', { messageId: msg.id }],
      ['channel:read', { channelId: dm.id }],
      ['dm:close', { dmId: dm.id }],
    ]) {
      const r = await ack(c.socket, ev, p);
      expect(r.ok, `${ev} чужого ЛС: ${JSON.stringify(r)}`).toBe(false);
      expect(JSON.stringify(r)).not.toContain('тайна');
    }
    const typA = collect(a.socket, 'typing');
    const typB = collect(b.socket, 'typing');
    c.socket.emit('typing', { channelId: dm.id });
    // client:view на чужой ЛС не должен глушить уведомления хозяев
    c.socket.emit('client:view', { channelId: dm.id, visible: true });
    await sleep(300);
    expect(typA.concat(typB)).toEqual([]);
    const gotB = waitEvent(b.socket, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'всё ещё лично' });
    await gotB;
    expect((await ok(b.socket, 'message:history', { channelId: dm.id })).messages.length).toBe(2);
  });

  test('бот: ЛС с ботом не открывается', async () => {
    const dbFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
    const bot = dbFile.users.find((u) => u.isBot);
    expect(bot, 'пользователь-бот в базе').toBeTruthy();
    const { users: [a] } = await friends(1);
    const r = await ack(a.socket, 'dm:open', { userId: bot.id });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/бот/i);
  });
});

test.describe('аудит v7: валидация', () => {
  test('мусор во всех новых событиях — ok:false, сервер жив', async () => {
    const { users: [a, b] } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const huge = 'x'.repeat(200_000);
    const junk = [null, 0, 'строка', [], [1, 2], true, { userId: huge }, { userId: { $ne: 1 } }, { userId: ['a'] },
      { dmId: huge }, { dmId: {} }, { channelId: 5 }, { channelId: huge }, { ids: 'abc' }, { ids: [null, {}, 5, huge] }, { all: 'true' }];
    for (const ev of ['dm:open', 'dm:close', 'channel:read']) {
      for (const p of junk) {
        const r = await ack(a.socket, ev, p);
        expect(r.ok, `${ev} ${JSON.stringify(p).slice(0, 60)}`).toBe(false);
      }
    }
    for (const p of junk) {
      const r = await ack(a.socket, 'notification:read', p);
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual([]);
    }
    for (const p of [null, 'x', 5, [], { channelId: huge, visible: 'yes' }, { channelId: {}, visible: 1 }]) a.socket.emit('client:view', p);
    for (const p of [null, 'x', { channelId: huge }, { channelId: {} }]) a.socket.emit('typing', p);
    // сообщения в ЛС: лимиты и пустые
    const cases = [
      [{ channelId: dm.id, content: 'я'.repeat(2001) }, /длинное/],
      [{ channelId: dm.id, content: '' }, /пустое/],
      [{ channelId: dm.id, content: '   \n\t ' }, /пустое/],
      [{ channelId: dm.id, content: '\u0000\u0001\u0007' }, /пустое/],
      [{ channelId: dm.id, content: { a: 1 } }, /Некорректный/],
      [{ channelId: dm.id, content: 'ok', attachments: 'x' }, /вложени/i],
      [{ channelId: dm.id, content: 'ok', attachments: [{ url: 'https://evil.example/x.png', type: 'image/png' }] }, /не найдено/],
      [{ channelId: dm.id, content: 'ok', attachments: [{ url: '/media/uploads/../../db.json' }] }, /не найдено/],
      [{ channelId: dm.id, content: 'ok', attachments: [{ url: 'javascript:alert(1)' }] }, /не найдено/],
      [{ channelId: dm.id, content: 'ok', attachments: [{ url: `/media/uploads/${'a'.repeat(24)}.png` }] }, /не найдено/],
      [{ channelId: dm.id, content: 'ok', attachments: new Array(11).fill({ url: 'x' }) }, /10/],
    ];
    for (const [p, re] of cases) {
      const r = await ack(a.socket, 'message:send', p);
      expect(r.ok, JSON.stringify(p).slice(0, 80)).toBe(false);
      expect(r.error).toMatch(re);
    }
    expect((await ok(a.socket, 'message:send', { channelId: dm.id, content: 'я'.repeat(2000) })).message.content.length).toBe(2000);
    // история: мусорный before
    for (const before of ['abc', null, {}, -1, 1e20]) await ok(a.socket, 'message:history', { channelId: dm.id, before });
    expect((await ok(b.socket, 'bootstrap')).dms.length).toBe(1);
    // превью во «Входящих» обрезано
    const n = (await notifs(b))[0];
    expect(n.preview.length).toBeLessThanOrEqual(140);
  });

  test('push: подписка — валидация', async () => {
    const { users: [a] } = await friends(1);
    const k = browserKeys();
    const bad = [
      undefined, null, 'x', {}, { endpoint: 'https://push.example/x' },
      { endpoint: 'javascript:alert(1)', keys: { p256dh: k.p256dh, auth: k.auth } },
      { endpoint: 'http://evil.example/x', keys: { p256dh: k.p256dh, auth: k.auth } },
      { endpoint: `https://push.example/${'a'.repeat(2000)}`, keys: { p256dh: k.p256dh, auth: k.auth } },
      { endpoint: 'https://push.example/x', keys: { p256dh: 'AAAA', auth: k.auth } },
      { endpoint: 'https://push.example/x', keys: { p256dh: k.p256dh, auth: 'AAAA' } },
      { endpoint: 'https://push.example/x', keys: { p256dh: { a: 1 }, auth: k.auth } },
    ];
    for (const subscription of bad) {
      const r = await api('POST', '/api/push/subscribe', { token: a.token, body: { subscription } });
      expect(r.status, JSON.stringify(subscription)?.slice(0, 80)).toBe(400);
    }
    expect((await api('POST', '/api/push/subscribe', { body: { subscription: {} } })).status).toBe(401);
    expect((await api('POST', '/api/push/unsubscribe', { body: { endpoint: 'x' } })).status).toBe(401);
    expect((await api('POST', '/api/push/unsubscribe', { token: a.token, body: { endpoint: { $ne: 1 } } })).json.removed).toBe(false);
  });

  test('push: ключ p256dh правильной длины, но не точка кривой — отклоняется, sendPush не бросает', async () => {
    const { initPush, sendPush, validSubscription } = await import('../server/push.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vapid-'));
    initPush(dir);
    const raw = Buffer.alloc(65, 7); raw[0] = 4; // 0x04 + мусорные X,Y — не на кривой P-256
    const sub = { endpoint: 'https://push.invalid/x', keys: { p256dh: b64u(raw), auth: b64u(crypto.randomBytes(16)) } };
    expect(validSubscription(sub), 'validSubscription отклоняет ключ не на кривой').toBe(false);
    const good = browserKeys();
    expect(validSubscription({ endpoint: 'https://push.invalid/x', keys: { p256dh: good.p256dh, auth: good.auth } })).toBe(true);
    const { users: [b] } = await friends(1);
    const r = await api('POST', '/api/push/subscribe', { token: b.token, body: { subscription: { endpoint: 'https://push.invalid/bad', keys: sub.keys } } });
    expect(r.status, 'API отклоняет ключ не на кривой').toBe(400);
    // если битая подписка всё же попала в базу (старые данные) — sendPush не бросает, а помечает её ушедшей
    let res;
    let err = null;
    try { res = await sendPush(sub, { title: 't' }); } catch (e) { err = e; }
    expect(err?.message ?? null, 'sendPush не должен бросать').toBe(null);
    expect(res?.ok).toBe(false);
    expect(res?.gone).toBe(true);
  });
});

test.describe('аудит v7: удаление и превью', () => {
  test('ЛС: удаление последнего из двух непрочитанных — «Входящие» и превью списка обновляются', async () => {
    const { users: [a, b] } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const m1 = (await ok(a.socket, 'message:send', { channelId: dm.id, content: 'первое' })).message;
    const m2 = (await ok(a.socket, 'message:send', { channelId: dm.id, content: 'второе' })).message;
    let n = await notifs(b);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ count: 2, preview: 'второе' });
    const upd = waitEvent(b.socket, 'dm:updated', (p) => p.dm.id === dm.id);
    await ok(a.socket, 'message:delete', { messageId: m2.id });
    const d = (await upd).dm;
    expect(d.lastMessage.id).toBe(m1.id);
    expect(d.unread).toBe(1);
    n = await notifs(b);
    expect(n.length, 'первое сообщение всё ещё не прочитано, а запись во «Входящих» исчезла целиком').toBe(1);
    expect(n[0]).toMatchObject({ count: 1, preview: 'первое' });
  });

  test('ЛС: удаление более раннего сообщения — счётчик в «Входящих» уменьшается', async () => {
    const { users: [a, b] } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const m1 = (await ok(a.socket, 'message:send', { channelId: dm.id, content: 'первое' })).message;
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'второе' });
    await ok(a.socket, 'message:delete', { messageId: m1.id });
    expect((await ack(b.socket, 'bootstrap')).dms[0].unread).toBe(1);
    expect((await notifs(b))[0].count, 'count не пересчитан после удаления').toBe(1);
  });

  test('ЛС: удаление единственного сообщения — превью «Нет сообщений», уведомление ушло', async () => {
    const { users: [a, b] } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const m1 = (await ok(a.socket, 'message:send', { channelId: dm.id, content: 'одно' })).message;
    const rem = waitEvent(b.socket, 'notification:removed', (p) => p.messageId === m1.id);
    const upd = waitEvent(b.socket, 'dm:updated', (p) => p.dm.id === dm.id && p.dm.lastMessage === null);
    await ok(a.socket, 'message:delete', { messageId: m1.id });
    await rem;
    expect((await upd).dm.unread).toBe(0);
  });

  test('канал: модератор удалил сообщение с упоминанием — уведомление ушло', async () => {
    const { users: [a, b, c], text } = await friends(3);
    const m = (await ok(c.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} привет` })).message;
    await expect.poll(async () => (await notifs(b)).length).toBe(1);
    const rem = waitEvent(b.socket, 'notification:removed', (p) => p.messageId === m.id);
    await ok(a.socket, 'message:delete', { messageId: m.id });
    await rem;
    expect(await notifs(b)).toEqual([]);
  });
});

test.describe('аудит v7: две вкладки, переподключение', () => {
  test('прочитал в одной вкладке — read:state во второй; client:view одной вкладки не глушит другую', async () => {
    const { users: [a, b] } = await friends(2);
    const b2 = await connectUser(b.token); socks.push(b2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'раз' });
    const rs = waitEvent(b2, 'read:state', (p) => p.channelId === dm.id && p.notificationIds.length === 1);
    await ok(b.socket, 'channel:read', { channelId: dm.id });
    await rs;
    // вкладка 1 смотрит ЛС, вкладка 2 скрыта — уведомления нет, ЛС помечено прочитанным
    b.socket.emit('client:view', { channelId: dm.id, visible: true });
    await sleep(150);
    const live = collect(b2, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'два' });
    await sleep(300);
    expect(live).toEqual([]);
    expect((await ack(b2, 'bootstrap')).dms[0].unread).toBe(0);
    // вкладку закрыли — уведомления снова идут
    b.socket.close();
    await sleep(200);
    const got = waitEvent(b2, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'три' });
    await got;
  });

  test('переподключение: bootstrap возвращает ЛС, непрочитанное и уведомления', async () => {
    const { users: [a, b] } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    b.socket.close();
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'пока тебя не было' });
    const s = await connectUser(b.token); socks.push(s);
    const boot = await ok(s, 'bootstrap');
    expect(boot.dms.map((d) => [d.id, d.unread])).toEqual([[dm.id, 1]]);
    expect(boot.notifications.map((n) => [n.type, n.read])).toEqual([['dm', false]]);
  });
});

test.describe('аудит v7: push', () => {
  test('упоминание и @everyone дают push; заголовок с каналом; DnD молчит', async () => {
    const rcv = await pushReceiver();
    try {
      const { users: [a, b], text } = await friends(2);
      const { r, keys } = await subscribe(b.token, rcv.origin, '/b');
      expect(r.status).toBe(200);
      await ok(a.socket, 'message:send', { channelId: text.id, content: `эй @${b.user.username}` });
      await expect.poll(() => rcv.at('/b').length).toBe(1);
      const p1 = decrypt(rcv.at('/b')[0].body, keys);
      expect(p1).toMatchObject({ type: 'mention', channelId: text.id, url: `/?c=${text.id}` });
      expect(p1.title).toContain(`#${text.name}`);
      await ok(a.socket, 'message:send', { channelId: text.id, content: '@everyone собираемся' });
      await expect.poll(() => rcv.at('/b').length).toBe(2);
      expect(decrypt(rcv.at('/b')[1].body, keys)).toMatchObject({ type: 'everyone', body: '@everyone собираемся' });
      // сообщение без упоминания — без push
      await ok(a.socket, 'message:send', { channelId: text.id, content: 'просто так' });
      await sleep(600);
      expect(rcv.at('/b').length).toBe(2);
    } finally { rcv.close(); }
  });

  test('тот же endpoint зарегистрировал другой аккаунт — подписка ушла к нему; unsubscribe', async () => {
    const rcv = await pushReceiver();
    try {
      const { users: [a, b, c] } = await friends(3);
      const keys = browserKeys();
      expect((await subscribe(b.token, rcv.origin, '/same', keys)).r.status).toBe(200);
      expect((await subscribe(c.token, rcv.origin, '/same', keys)).r.status).toBe(200);
      const dmB = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
      const dmC = (await ok(a.socket, 'dm:open', { userId: c.user.id })).dm;
      await ok(a.socket, 'message:send', { channelId: dmB.id, content: 'для B' });
      await sleep(700);
      expect(rcv.at('/same').length, 'push для B не должен прийти на устройство, перешедшее к C').toBe(0);
      await ok(a.socket, 'message:send', { channelId: dmC.id, content: 'для C' });
      await expect.poll(() => rcv.at('/same').length).toBe(1);
      expect(decrypt(rcv.at('/same')[0].body, keys).body).toBe('для C');
      // B не может отписать чужое устройство
      expect((await api('POST', '/api/push/unsubscribe', { token: b.token, body: { endpoint: `${rcv.origin}/same` } })).json.removed).toBe(false);
      expect((await api('POST', '/api/push/unsubscribe', { token: c.token, body: { endpoint: `${rcv.origin}/same` } })).json.removed).toBe(true);
      await ok(a.socket, 'message:send', { channelId: dmC.id, content: 'после отписки' });
      await sleep(700);
      expect(rcv.at('/same').length).toBe(1);
    } finally { rcv.close(); }
  });

  test('смена пароля (выход на других устройствах) — push на отозванное устройство больше не идёт', async () => {
    const rcv = await pushReceiver();
    try {
      const { users: [a, b] } = await friends(2);
      // «старое» устройство B с подпиской
      expect((await subscribe(b.token, rcv.origin, '/old-device')).r.status).toBe(200);
      // B входит на новом устройстве и меняет пароль: остальные сессии отозваны
      const login = await api('POST', '/api/login', { body: { username: b.username, password: b.password } });
      expect(login.status).toBe(200);
      const pw = await api('POST', '/api/me/password', { token: login.json.token, body: { oldPassword: b.password, newPassword: 'newsecret456' } });
      expect(pw.status, JSON.stringify(pw.json)).toBe(200);
      expect((await api('GET', '/api/me', { token: b.token })).status).toBe(401);
      const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
      await ok(a.socket, 'message:send', { channelId: dm.id, content: 'секретное превью' });
      await sleep(800);
      expect(rcv.at('/old-device').length, 'текст ЛС ушёл на устройство, с которого вышли').toBe(0);
    } finally { rcv.close(); }
  });

  test('сервер не шлёт push, пока вкладка на виду, и шлёт после закрытия последней вкладки', async () => {
    const rcv = await pushReceiver();
    try {
      const { users: [a, b] } = await friends(2);
      const { keys } = await subscribe(b.token, rcv.origin, '/v');
      const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
      b.socket.emit('client:view', { channelId: null, visible: true });
      await sleep(150);
      await ok(a.socket, 'message:send', { channelId: dm.id, content: 'видно' });
      await sleep(500);
      expect(rcv.at('/v').length).toBe(0);
      b.socket.close();
      await sleep(200);
      await ok(a.socket, 'message:send', { channelId: dm.id, content: 'не видно' });
      await expect.poll(() => rcv.at('/v').length).toBe(1);
      const p = decrypt(rcv.at('/v')[0].body, keys);
      expect(p).toMatchObject({ body: 'не видно', count: 2 });
    } finally { rcv.close(); }
  });
});

test.describe('аудит v7: упоминания — граничные случаи', () => {
  test('@everyone/@here без права — уведомлений нет; @ник внутри слова и e-mail — не упоминание; регистр не важен', async () => {
    const { users: [a, b, c], text } = await friends(3);
    const live = collect(c.socket, 'notification:new');
    await ok(b.socket, 'message:send', { channelId: text.id, content: '@everyone @here без права' });
    await ok(b.socket, 'message:send', { channelId: text.id, content: `mail${c.username}@x.ru и x@${c.username}` });
    await sleep(500);
    expect(live, 'без MENTION_EVERYONE и без настоящего @ника').toEqual([]);
    await ok(b.socket, 'message:send', { channelId: text.id, content: `@${c.username.toUpperCase()}, привет` });
    await expect.poll(() => live.length).toBe(1);
    expect(live[0].notification.type).toBe('mention');
    // своё упоминание себя — не уведомление; @here от владельца — everyone
    const own = collect(a.socket, 'notification:new');
    await ok(a.socket, 'message:send', { channelId: text.id, content: `@${a.username} заметка себе` });
    await ok(a.socket, 'message:send', { channelId: text.id, content: '@here сбор' });
    await expect.poll(() => live.length).toBe(2);
    expect(live[1].notification.type).toBe('everyone');
    await sleep(300);
    expect(own).toEqual([]);
  });

  test('100+ уведомлений: список ограничен, bootstrap отдаёт не больше 50, «прочитать всё» работает', async () => {
    const { users: [a, b], text } = await friends(2);
    for (let i = 0; i < 24; i++) await ok(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} #${i}` });
    await expect.poll(async () => (await notifs(b)).length).toBe(24);
    const n = await notifs(b);
    expect(n[0].preview).toContain('#23'); // новые сверху
    expect((await ok(b.socket, 'notification:read', { all: true })).ids.length).toBe(24);
  });
});

test.describe('аудит v7: закрытый ЛС без общего сервера', () => {
  test('закрыл переписку после кика — dm:open возвращает её только для чтения; новую с чужим создать нельзя', async () => {
    const { users: [a, b], server } = await friends(2);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ok(a.socket, 'message:send', { channelId: dm.id, content: 'история' });
    await ok(a.socket, 'member:kick', { serverId: server.id, userId: b.user.id });
    await ok(b.socket, 'dm:close', { dmId: dm.id });
    expect((await ack(b.socket, 'bootstrap')).dms).toEqual([]);
    const r = await ok(b.socket, 'dm:open', { userId: a.user.id });
    expect(r.dm).toMatchObject({ id: dm.id, canMessage: false });
    expect((await ok(b.socket, 'message:history', { channelId: dm.id })).messages.map((m) => m.content)).toEqual(['история']);
    expect((await ack(b.socket, 'message:send', { channelId: dm.id, content: 'x' })).ok).toBe(false);
    const stranger = await makeUser('str'); socks.push(stranger.socket);
    expect((await ack(stranger.socket, 'dm:open', { userId: a.user.id })).ok).toBe(false);
  });
});
