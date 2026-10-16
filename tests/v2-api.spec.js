// v2 §4: профиль — PATCH /api/me (цвет), POST /api/me/password (смена пароля)
import { test, expect } from '@playwright/test';
import {
  http, registerApi, makeUser, createServer, ack, connect, connected, waitEvent, uniqueName, sleep,
} from './fixtures/api.js';

/** Ждём, что другой участник узнал о новом цвете: user:updated {user} (рекомендовано SPEC-v2 §4)
 *  или server:updated, где у участника обновлён цвет. */
function waitColorBroadcast(socket, userId, color, ms = 8000) {
  const c = color.toLowerCase();
  return Promise.race([
    waitEvent(socket, 'user:updated', (d) => d?.user?.id === userId && String(d.user.color).toLowerCase() === c, ms).then((d) => ({ via: 'user:updated', d })),
    waitEvent(socket, 'server:updated', (d) => (d?.server?.members || []).some((m) => (m.id === userId || m.user?.id === userId) && String(m.color ?? m.user?.color).toLowerCase() === c), ms).then((d) => ({ via: 'server:updated', d })),
  ]);
}

test.describe('v2 REST: PATCH /api/me (цвет аватара)', () => {
  test('валидный цвет → {user} с новым цветом; GET /api/me отдаёт его; другой участник получает обновление', async () => {
    const a = await makeUser('col');
    const b = await makeUser('colb');
    const outsider = await makeUser('colx');
    const server = await createServer(a, 'Цвета');
    const j = await ack(b.socket, 'server:join', { inviteCode: server.inviteCode });
    expect(j.ok, JSON.stringify(j)).toBe(true);

    const gotOutsider = [];
    outsider.socket.on('user:updated', (d) => gotOutsider.push(d));

    const color = '#12ab9f';
    const bcast = waitColorBroadcast(b.socket, a.user.id, color);
    const r = await http('PATCH', '/api/me', { token: a.token, body: { color } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.user, 'ответ {user}').toBeTruthy();
    expect(r.json.user.id).toBe(a.user.id);
    expect(r.json.user.color.toLowerCase()).toBe(color);
    expect(r.json.user.passwordHash, 'не утекает хэш пароля').toBeUndefined();

    const me = await http('GET', '/api/me', { token: a.token });
    expect(me.json.user.color.toLowerCase()).toBe(color);

    const ev = await bcast;
    test.info().annotations.push({ type: 'broadcast', description: ev.via });
    // Участник без общих серверов не получает событие
    await sleep(500);
    expect(gotOutsider.filter((d) => d?.user?.id === a.user.id), 'посторонний не получает user:updated').toHaveLength(0);

    // Цвет сохраняется в bootstrap нового подключения у другого участника
    const s2 = await connected(connect(b.token));
    const boot = await ack(s2, 'bootstrap');
    const srv = boot.servers.find((s) => s.id === server.id);
    const m = srv.members.find((x) => (x.id || x.user?.id) === a.user.id);
    expect(String(m.color ?? m.user?.color).toLowerCase()).toBe(color);
    for (const s of [a.socket, b.socket, outsider.socket, s2]) s.close();
  });

  test('валидация цвета: мусор → 400 {error} по-русски, цвет не меняется; без токена → 401', async () => {
    const a = await registerApi(uniqueName('colv'));
    const before = (await http('GET', '/api/me', { token: a.token })).json.user.color;
    for (const bad of ['red', '#12345', '#1234567', '#gg0000', '12ab9f', '', 123, null, 'url(javascript:1)', '#fff;x']) {
      const r = await http('PATCH', '/api/me', { token: a.token, body: { color: bad } });
      expect(r.status, `color=${JSON.stringify(bad)} → ${r.status} ${JSON.stringify(r.json)}`).toBe(400);
      expect(typeof r.json.error).toBe('string');
      expect(r.json.error, 'ошибка по-русски').toMatch(/[а-яё]/i);
    }
    expect((await http('GET', '/api/me', { token: a.token })).json.user.color).toBe(before);
    const un = await http('PATCH', '/api/me', { body: { color: '#123456' } });
    expect(un.status).toBe(401);
    // нельзя сменить чужие поля через PATCH
    const r = await http('PATCH', '/api/me', { token: a.token, body: { color: '#ABCDEF', username: 'hacker', isBot: true } });
    expect([200, 400]).toContain(r.status);
    const me = (await http('GET', '/api/me', { token: a.token })).json.user;
    expect(me.username).toBe(a.username);
    expect(me.isBot).toBe(false);
  });
});

test.describe('v2 REST: POST /api/me/password', () => {
  test('неверный старый → 401/400; короткий новый → 400; успех → другие сессии разлогинены, текущая жива', async () => {
    const username = uniqueName('pw');
    const reg = await registerApi(username, 'oldpass1');
    const login2 = await http('POST', '/api/login', { body: { username, password: 'oldpass1' } });
    expect(login2.status).toBe(200);
    const tokenA = reg.token; // текущая сессия
    const tokenB = login2.json.token; // вторая сессия
    const sockB = await connected(connect(tokenB));

    const wrong = await http('POST', '/api/me/password', { token: tokenA, body: { oldPassword: 'nope-nope', newPassword: 'newpass22' } });
    expect([400, 401], JSON.stringify(wrong.json)).toContain(wrong.status);
    expect(wrong.json.error).toMatch(/[а-яё]/i);
    // токен A всё ещё жив после неверной попытки (401 — не повод разлогинить)
    expect((await http('GET', '/api/me', { token: tokenA })).status).toBe(200);

    const short = await http('POST', '/api/me/password', { token: tokenA, body: { oldPassword: 'oldpass1', newPassword: '1' } });
    expect(short.status, JSON.stringify(short.json)).toBe(400);
    expect(short.json.error).toMatch(/[а-яё]/i);
    const missing = await http('POST', '/api/me/password', { token: tokenA, body: {} });
    expect([400, 401]).toContain(missing.status);
    const noauth = await http('POST', '/api/me/password', { body: { oldPassword: 'oldpass1', newPassword: 'newpass22' } });
    expect(noauth.status).toBe(401);
    // после неудачных попыток старый пароль всё ещё работает
    expect((await http('POST', '/api/login', { body: { username, password: 'oldpass1' } })).status).toBe(200);

    const ok = await http('POST', '/api/me/password', { token: tokenA, body: { oldPassword: 'oldpass1', newPassword: 'newpass22' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.ok).toBe(true);

    expect((await http('GET', '/api/me', { token: tokenA })).status, 'текущая сессия жива').toBe(200);
    expect((await http('GET', '/api/me', { token: tokenB })).status, 'вторая сессия разлогинена').toBe(401);
    // новое подключение сокета со старым токеном отклоняется
    const sB2 = connect(tokenB);
    await expect(connected(sB2, 5000)).rejects.toThrow();
    sB2.close();
    // уже открытый сокет второй сессии отключается сервером (контракт music: «их сокеты отключаются»)
    await expect.poll(() => sockB.connected, { message: 'сокет второй сессии отключён', timeout: 5000 }).toBe(false);
    sockB.close();

    expect((await http('POST', '/api/login', { body: { username, password: 'oldpass1' } })).status, 'старый пароль не подходит').toBe(401);
    const relog = await http('POST', '/api/login', { body: { username, password: 'newpass22' } });
    expect(relog.status, 'вход с новым паролем').toBe(200);
    expect(relog.json.user.username).toBe(username);
  });
});
