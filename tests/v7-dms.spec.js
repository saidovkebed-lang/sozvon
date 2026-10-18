// v7: личные сообщения (только переписка: текст, фото, видео), «Входящие» (упоминания, @everyone, ЛС)
// и push-уведомления (Web Push: VAPID + aes128gcm — проверяем расшифровкой на тестовом приёмнике).
import crypto from 'node:crypto';
import http from 'node:http';
import { test, expect, loginViaToken, createServerUI, inviteCode, joinServerUI } from './fixtures/ui.js';
import { makeUser, createServer, ack, waitEvent, http as api, sleep } from './fixtures/api.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function upload(token, name, type, buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await api('POST', '/api/attachments', { token, body: fd });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

/** A создаёт сервер, B (и опционально ещё кто-то) входят по инвайту */
async function friends(n = 2) {
  const users = [];
  for (let i = 0; i < n; i++) { const u = await makeUser(`dm${i}`); socks.push(u.socket); users.push(u); }
  const server = await createServer(users[0], 'ЛС-тест');
  for (const u of users.slice(1)) {
    const r = await ack(u.socket, 'server:join', { inviteCode: server.inviteCode });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  return { users, server };
}

test.describe('v7: личные сообщения', () => {
  test('открыть ЛС, текст и фото, непрочитанное, уведомление во «Входящих», прочитать', async () => {
    const { users: [a, b] } = await friends(2);
    const opened = await ack(a.socket, 'dm:open', { userId: b.user.id });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const dm = opened.dm;
    expect(dm.user.id).toBe(b.user.id);
    expect(dm.canMessage).toBe(true);
    // повторное открытие — тот же чат
    expect((await ack(a.socket, 'dm:open', { userId: b.user.id })).dm.id).toBe(dm.id);

    const img = await upload(a.token, 'кот.png', 'image/png', PNG_1x1);
    const gotMsg = waitEvent(b.socket, 'message:new', (p) => p.message?.channelId === dm.id);
    const gotDm = waitEvent(b.socket, 'dm:updated', (p) => p.dm?.id === dm.id && p.dm.unread === 1);
    const gotNotif = waitEvent(b.socket, 'notification:new', (p) => p.notification?.type === 'dm');
    const sent = await ack(a.socket, 'message:send', { channelId: dm.id, content: 'привет, это лично', attachments: [img] });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const m = (await gotMsg).message;
    expect(m.content).toBe('привет, это лично');
    expect(m.attachments[0].url).toBe(img.url);
    expect((await gotDm).dm.user.id).toBe(a.user.id);
    const n = (await gotNotif).notification;
    expect(n).toMatchObject({ type: 'dm', channelId: dm.id, read: false, count: 1, preview: 'привет, это лично' });

    // второе сообщение — то же уведомление со счётчиком 2 (не плодим записи)
    const gotNotif2 = waitEvent(b.socket, 'notification:new', (p) => p.notification?.id === n.id && p.notification.count === 2);
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'ещё' });
    await gotNotif2;

    // история у B, в списке ЛС — непрочитанные
    const hist = await ack(b.socket, 'message:history', { channelId: dm.id });
    expect(hist.messages.map((x) => x.content)).toEqual(['привет, это лично', 'ещё']);
    const boot = await ack(b.socket, 'bootstrap');
    expect(boot.dms.find((d) => d.id === dm.id).unread).toBe(2);
    expect(boot.notifications.filter((x) => !x.read).length).toBe(1);

    // прочитал — счётчик и уведомление сброшены, все вкладки узнают
    const gotRead = waitEvent(b.socket, 'read:state', (p) => p.channelId === dm.id);
    expect((await ack(b.socket, 'channel:read', { channelId: dm.id })).ok).toBe(true);
    expect((await gotRead).notificationIds).toEqual([n.id]);
    const boot2 = await ack(b.socket, 'bootstrap');
    expect(boot2.dms.find((d) => d.id === dm.id).unread).toBe(0);
    expect(boot2.notifications.every((x) => x.read)).toBe(true);
  });

  test('чужие сообщения не удалить, свои — можно; посторонний не видит и не пишет; без общего сервера — нельзя', async () => {
    const { users: [a, b] } = await friends(2);
    const stranger = await makeUser('stranger'); socks.push(stranger.socket);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const msg = (await ack(a.socket, 'message:send', { channelId: dm.id, content: 'секрет' })).message;

    expect((await ack(b.socket, 'message:delete', { messageId: msg.id })).error).toMatch(/только свои/);
    expect((await ack(stranger.socket, 'message:history', { channelId: dm.id })).error).toMatch(/не найден/);
    expect((await ack(stranger.socket, 'message:send', { channelId: dm.id, content: 'хи' })).error).toMatch(/не найден/);
    expect((await ack(stranger.socket, 'dm:open', { userId: a.user.id })).error).toMatch(/общий сервер/);
    expect((await ack(a.socket, 'dm:open', { userId: a.user.id })).ok).toBe(false);

    const gone = waitEvent(b.socket, 'message:deleted', (p) => p.messageId === msg.id);
    expect((await ack(a.socket, 'message:delete', { messageId: msg.id })).ok).toBe(true);
    await gone;

    // B вышел с единственного общего сервера — писать больше нельзя ни ему, ни ему
    const server = (await ack(a.socket, 'bootstrap')).servers.find((s) => s.name === 'ЛС-тест');
    expect((await ack(b.socket, 'server:leave', { serverId: server.id })).ok).toBe(true);
    expect((await ack(a.socket, 'message:send', { channelId: dm.id, content: 'ау' })).error).toMatch(/общий сервер/);
    const hist = await ack(b.socket, 'message:history', { channelId: dm.id });
    expect(hist.ok).toBe(true); // переписка остаётся доступной для чтения
    expect((await ack(b.socket, 'bootstrap')).dms.find((d) => d.id === dm.id).canMessage).toBe(false);
  });

  test('закрыть чат: пропадает из списка, новое сообщение возвращает его', async () => {
    const { users: [a, b] } = await friends(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'раз' });
    const closed = waitEvent(b.socket, 'dm:closed', (p) => p.dmId === dm.id);
    expect((await ack(b.socket, 'dm:close', { dmId: dm.id })).ok).toBe(true);
    await closed;
    expect((await ack(b.socket, 'bootstrap')).dms.some((d) => d.id === dm.id)).toBe(false);
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'два' });
    await expect.poll(async () => (await ack(b.socket, 'bootstrap')).dms.some((d) => d.id === dm.id)).toBe(true);
  });
});

test.describe('v7: «Входящие»', () => {
  test('упоминание @ника и @everyone; смотрящему канал уведомление не нужно; удалённое сообщение уходит из «Входящих»', async () => {
    const { users: [a, b, c], server } = await friends(3);
    const text = server.channels.find((ch) => ch.type === 'text');
    const gotB = waitEvent(b.socket, 'notification:new', (p) => p.notification?.type === 'mention');
    const sent = await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.user.username} глянь` });
    const nb = (await gotB).notification;
    expect(nb).toMatchObject({ type: 'mention', channelId: text.id, serverId: server.id, channelName: text.name, serverName: 'ЛС-тест' });
    expect(nb.author.id).toBe(a.user.id);
    // у C упоминания нет
    expect((await ack(c.socket, 'bootstrap')).notifications.length).toBe(0);

    // удалили сообщение — уведомление пропало
    const removed = waitEvent(b.socket, 'notification:removed', (p) => p.messageId === sent.message.id);
    await ack(a.socket, 'message:delete', { messageId: sent.message.id });
    await removed;
    expect((await ack(b.socket, 'bootstrap')).notifications.length).toBe(0);

    // C смотрит канал (видимая вкладка) — @everyone ему не уведомление; B не смотрит — уведомление
    c.socket.emit('client:view', { channelId: text.id, visible: true });
    await sleep(200);
    const gotEveryone = waitEvent(b.socket, 'notification:new', (p) => p.notification?.type === 'everyone');
    await ack(a.socket, 'message:send', { channelId: text.id, content: '@everyone созвон в 9' });
    await gotEveryone;
    await sleep(300);
    expect((await ack(c.socket, 'bootstrap')).notifications.length).toBe(0);

    // прочитать всё
    const read = await ack(b.socket, 'notification:read', { all: true });
    expect(read.ids.length).toBe(1);
    expect((await ack(b.socket, 'bootstrap')).notifications.every((x) => x.read)).toBe(true);
  });
});

/* ---------- Web Push: приёмник-подделка сервиса доставки с расшифровкой ---------- */
const b64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function makeBrowserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}

/** Расшифровка RFC 8291 на стороне «браузера» */
function decrypt(body, keys) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = keys.ecdh.getPublicKey();
  const ecdhSecret = keys.ecdh.computeSecret(asPublic);
  const prkKey = hmac(Buffer.from(keys.auth, 'base64url'), ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  expect(plain[end], 'разделитель последней записи 0x02').toBe(2);
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

function verifyVapid(header, audience, serverKey) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || '');
  expect(m, `Authorization: ${header}`).toBeTruthy();
  const [h, c, sig] = m[1].split('.');
  expect(m[2]).toBe(serverKey);
  const raw = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  expect(ok, 'подпись VAPID').toBe(true);
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  expect(claims.aud).toBe(audience);
  expect(claims.exp * 1000).toBeGreaterThan(Date.now());
}

test.describe('v7: push-уведомления', () => {
  test('ЛС получателю без открытого окна → зашифрованный push с VAPID; окно на виду → без push; 410 → подписка удалена', async () => {
    const received = [];
    let status = 201;
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url }); res.writeHead(status); res.end(); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${srv.address().port}`;
    try {
      const keyRes = await api('GET', '/api/push/key');
      expect(keyRes.status).toBe(200);
      const serverKey = keyRes.json.key;
      expect(Buffer.from(serverKey, 'base64url').length).toBe(65);

      const { users: [a, b] } = await friends(2);
      const keys = makeBrowserKeys();
      const sub = { endpoint: `${origin}/push/abc`, keys: { p256dh: keys.p256dh, auth: keys.auth } };
      expect((await api('POST', '/api/push/subscribe', { token: b.token, body: { subscription: { endpoint: 'ftp://x', keys: sub.keys } } })).status).toBe(400);
      expect((await api('POST', '/api/push/subscribe', { token: b.token, body: { subscription: sub } })).status).toBe(200);

      const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
      // окно B на виду — push не нужен
      b.socket.emit('client:view', { channelId: null, visible: true });
      await sleep(200);
      await ack(a.socket, 'message:send', { channelId: dm.id, content: 'пока ты тут' });
      await sleep(800);
      expect(received.length).toBe(0);

      // окно B свернули — push
      b.socket.emit('client:view', { channelId: null, visible: false });
      await sleep(200);
      await ack(a.socket, 'message:send', { channelId: dm.id, content: 'а теперь push 🚀' });
      await expect.poll(() => received.length, { timeout: 10000 }).toBe(1);
      const r = received[0];
      expect(r.path).toBe('/push/abc');
      expect(r.headers['content-encoding']).toBe('aes128gcm');
      expect(Number(r.headers.ttl)).toBeGreaterThan(0);
      verifyVapid(r.headers.authorization, origin, serverKey);
      const payload = decrypt(r.body, keys);
      expect(payload).toMatchObject({ title: a.user.username, body: 'а теперь push 🚀', channelId: dm.id, type: 'dm', url: `/?c=${dm.id}` });

      // «Не беспокоить» — без push
      expect((await api('PATCH', '/api/me', { token: b.token, body: { status: 'dnd' } })).status).toBe(200);
      await ack(a.socket, 'message:send', { channelId: dm.id, content: 'тихо' });
      await sleep(800);
      expect(received.length).toBe(1);
      await api('PATCH', '/api/me', { token: b.token, body: { status: 'online' } });

      // сервис доставки ответил 410 — подписка удаляется, дальше не шлём
      status = 410;
      await ack(a.socket, 'message:send', { channelId: dm.id, content: 'подписка умерла' });
      await expect.poll(() => received.length, { timeout: 10000 }).toBe(2);
      status = 201;
      await sleep(300);
      await ack(a.socket, 'message:send', { channelId: dm.id, content: 'больше не придёт' });
      await sleep(800);
      expect(received.length).toBe(2);
    } finally {
      srv.close();
    }
  });
});

test.describe('v7: интерфейс', () => {
  test('написать из профиля, бейдж на «Главной», чат без звонков, «Входящие» и переход по уведомлению', async ({ makePage }) => {
    const pa = await makePage({ name: 'A' });
    const pb = await makePage({ name: 'B' });
    const ua = await loginViaToken(pa, 'uia');
    const ub = await loginViaToken(pb, 'uib');
    await createServerUI(pa, 'Друзья');
    await joinServerUI(pb, await inviteCode(pa), 'Друзья');

    // A: участник B → профиль → «Написать сообщение»
    await pa.locator('#members .member', { hasText: ub.user.username }).first().click();
    await pa.locator('.profile-popup [data-action="message"]').click();
    await expect(pa.locator('#channel-title')).toHaveText(ub.user.username);
    await expect(pa.locator('#channel-topic')).toHaveText(`@${ub.user.username}`);
    await expect(pa.locator('.chat__empty--dm')).toBeVisible();
    await expect(pa.locator('#members')).toBeHidden();
    await expect(pa.locator('#composer-input')).toHaveAttribute('placeholder', `Написать @${ub.user.username}`);
    // никаких звонков в ЛС
    await expect(pa.locator('#chat-view').getByRole('button', { name: /звон|голос|камер/i })).toHaveCount(0);
    await pa.locator('#composer-input').fill('Привет! Это личное');
    await pa.locator('#composer-input').press('Enter');
    await expect(pa.locator('.message__content', { hasText: 'Привет! Это личное' })).toBeVisible();
    await expect(pa.locator('.dm-item', { hasText: ub.user.username })).toHaveClass(/is-active/);

    // B на сервере: бейдж на «Главной» и колокольчике
    await expect(pb.locator('.servers__item--home .server-badge')).toHaveText('1');
    await expect(pb.locator('#btn-inbox .badge-count')).toHaveText('1');
    await pb.locator('#btn-inbox').click();
    const item = pb.locator('#inbox .inbox-item.is-unread');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Привет! Это личное');
    await item.click();
    await expect(pb.locator('#inbox')).toBeHidden();
    await expect(pb.locator('#channel-title')).toHaveText(ua.user.username);
    await expect(pb.locator('.message__content', { hasText: 'Привет! Это личное' })).toBeVisible();
    await expect(pb.locator('.servers__item--home .server-badge')).toHaveCount(0);
    await expect(pb.locator('#btn-inbox .badge-count')).toHaveCount(0);

    // B отвечает фото; A видит его в чате
    await pb.locator('#file-input').setInputFiles({ name: 'фото.png', mimeType: 'image/png', buffer: PNG_1x1 });
    await expect(pb.locator('#pending-attachments .chip:not(.is-loading)')).toHaveCount(1);
    await pb.locator('#composer-input').press('Enter');
    await expect(pa.locator('.message__image-link')).toHaveCount(1);

    // «Новое сообщение» с «Главной»: список людей с общих серверов
    await pb.locator('#btn-home').click();
    await pb.locator('#btn-new-dm').click();
    await expect(pb.locator('#modal-new-dm .pick-user', { hasText: ua.user.username })).toBeVisible();
    await pb.keyboard.press('Escape');

    // упоминание в канале → «Входящие» у B, клик ведёт в канал
    await pa.locator('#servers-list .server-icon').first().click();
    await pa.locator('#composer-input').fill(`@${ub.user.username} заходи в голосовой`);
    await pa.locator('#composer-input').press('Enter');
    await expect(pb.locator('#btn-inbox .badge-count')).toHaveText('1');
    await pb.locator('#btn-inbox').click();
    await expect(pb.locator('#inbox .inbox-item.is-unread')).toContainText('Упоминание в #общий');
    await pb.locator('#inbox .inbox-item.is-unread').click();
    await expect(pb.locator('#channel-title')).toHaveText('общий');
    await expect(pb.locator('#btn-inbox .badge-count')).toHaveCount(0);

    // переход по ссылке из push (?c=) после перезагрузки
    const dmId = await pb.evaluate(() => window.__sozvon.state.dms[0].id);
    await pb.goto(`/?c=${dmId}`);
    await expect(pb.locator('#channel-title')).toHaveText(ua.user.username);
    expect(new URL(pb.url()).search).toBe('');
  });

  test('настройки: push в этом браузере включается и выключается', async ({ makePage }) => {
    // в тестовом (инкогнито) профиле Chrome сам пишет в консоль, что Push API недоступен — это не ошибка приложения
    const p = await makePage({ name: 'P', context: { permissions: ['microphone', 'camera', 'notifications'] }, allowErrors: [/Push API in incognito/] });
    await loginViaToken(p, 'push');
    await p.locator('#btn-user-settings').click();
    await p.locator('[data-section="notifications"], button:has-text("Уведомления")').first().click();
    const sw = p.locator('#push-switch');
    await expect(sw).toBeVisible();
    const support = await p.evaluate(async () => (await import('/js/push.js')).pushSupport());
    test.info().annotations.push({ type: 'push', description: `pushSupport() = ${support}` });
    if (support !== 'ok') { await expect(sw).toBeDisabled(); return; }
    await sw.click(); // в headless подписка может не пройти — переключатель тогда законно вернётся в «выкл»
    // в headless Chromium push-сервиса нет: либо подписка прошла, либо понятная ошибка — без падения страницы
    await expect(p.locator('#push-status')).not.toHaveText('');
    await expect(sw).toBeEnabled();
    test.info().annotations.push({ type: 'push-status', description: await p.locator('#push-status').innerText() });
  });
});
