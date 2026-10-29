// v23: второй фактор через Telegram-бота владельца (server/telegram.js, server/tg2fa.js, public/js/ui/two-factor.js,
// public/js/ui/auth.js). Фейковый Telegram Bot API — локальный HTTP-сервер (TELEGRAM_API): getMe, sendMessage,
// editMessageText, answerCallbackQuery и getUpdates (тест сам кладёт обновления: /start <токен>, callback_query).
// Сервер A — основной (HTTP, TRUST_PROXY=1: адрес клиента из X-Forwarded-For); сервер B — «Telegram недоступен
// напрямую» (TELEGRAM_API — закрытый порт, запросы идут через фейковый VPN-прокси SPOTIFY_PROXY) и ADMIN_ALLOW_TG_2FA=0.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { PORT as QA_PORT, ROOT } from './fixtures/env.js';
import { httpAt, connect, connected, ack, waitFor, sleep, uniqueName } from './fixtures/api.js';
import { openSection } from './fixtures/v2.js';

test.describe.configure({ mode: 'serial' });

const A_PORT = QA_PORT + 60;
const TG_PORT = QA_PORT + 61;
const B_PORT = QA_PORT + 62;
const PROXY_PORT = QA_PORT + 63;
const DEAD_PORT = QA_PORT + 64; // никто не слушает: «api.telegram.org недоступен напрямую»
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
const TOKEN_A = '777001:TEST_tg2fa_SECRET_aaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '777002:TEST_tg2fa_SECRET_bbbbbbbbbbbbbbbbbbbb';
const SECRET_PARTS = ['TEST_tg2fa_SECRET_aaaa', 'TEST_tg2fa_SECRET_bbbb'];
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let tmp;
const servers = {};
const responses = []; // все ответы API — проверка «токен бота не утекает»
const sockets = [];

/* ---------------- фейковый Telegram Bot API ---------------- */
const bots = {}; // токен → состояние
function bot(token) {
  bots[token] ||= { updates: [], nextUpdate: 1, sent: [], edits: [], answers: [], calls: [], msgId: 100, failSend: false, conflictOnce: false };
  return bots[token];
}
let tgServer;
function startFakeTelegram() {
  tgServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) { res.statusCode = 404; return res.end('{"ok":false}'); }
      const [, token, method] = m;
      const st = bot(token);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      st.calls.push({ method, body });
      const reply = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return reply({ id: 777, is_bot: true, first_name: 'Astra', username: 'astra_test_bot' });
      if (method === 'sendMessage') {
        if (st.failSend) { req.socket.destroy(); return undefined; } // «Telegram недоступен»
        const msg = { message_id: ++st.msgId, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text, reply_markup: body.reply_markup };
        st.sent.push(msg);
        return reply(msg);
      }
      if (method === 'editMessageText') { st.edits.push(body); return reply({ message_id: body.message_id, text: body.text }); }
      if (method === 'answerCallbackQuery') { st.answers.push(body); return reply(true); }
      if (method === 'getUpdates') {
        if (st.conflictOnce) {
          st.conflictOnce = false;
          res.statusCode = 409;
          return res.end(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }));
        }
        const offset = Number(body.offset) || 0;
        st.updates = st.updates.filter((u) => u.update_id >= offset);
        const until = Date.now() + 800; // вместо 25 с — быстрее для тестов
        while (!st.updates.length && Date.now() < until) await sleep(40);
        return reply(st.updates.slice());
      }
      return reply(true);
    });
  });
  return new Promise((r) => tgServer.listen(TG_PORT, '127.0.0.1', r));
}
const push = (token, upd) => { const st = bot(token); st.updates.push({ update_id: st.nextUpdate++, ...upd }); };
const startCmd = (token, chatId, text, username = 'tg_user') => push(token, {
  message: { message_id: 1, date: 0, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Тест', username } },
});
function press(token, chatId, msg, which, { fromChat = chatId } = {}) {
  const btn = msg.reply_markup.inline_keyboard[0][which === 'ok' ? 0 : 1];
  push(token, { callback_query: { id: `cq${Math.random()}`, from: { id: fromChat, is_bot: false, first_name: 'X' }, message: { message_id: msg.message_id, chat: { id: fromChat, type: 'private' } }, data: btn.callback_data } });
}
const sentTo = (token, chatId) => bot(token).sent.filter((m) => m.chat.id === chatId);
async function nextMessage(token, chatId, after, re = /Код: \d{6}/) {
  return waitFor(() => sentTo(token, chatId).slice(after).find((m) => re.test(m.text)) || null, { timeout: 10000, message: `сообщение в чат ${chatId}` });
}
const codeOf = (msg) => msg.text.match(/Код: (\d{6})/)[1];
const editsOf = (token, msg) => bot(token).edits.filter((e) => e.message_id === msg.message_id && Number(e.chat_id) === msg.chat.id).map((e) => e.text);

/* ---------------- фейковый VPN-прокси (CONNECT → фейковый Telegram) ---------------- */
let proxyServer;
const proxyLog = [];
function startProxy() {
  proxyServer = net.createServer((c) => {
    c.once('data', (d) => {
      const line = String(d).split('\r\n')[0];
      proxyLog.push(line);
      if (!line.startsWith('CONNECT ')) { c.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const up = net.connect(TG_PORT, '127.0.0.1', () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => c.destroy());
    });
    c.on('error', () => {});
  });
  return new Promise((r) => proxyServer.listen(PROXY_PORT, '127.0.0.1', r));
}

/* ---------------- серверы Astra ---------------- */
async function startAstra(name, port, env) {
  const dataDir = path.join(tmp, name);
  fs.mkdirSync(dataDir, { recursive: true });
  const s = { name, dataDir, logs: '', base: `http://127.0.0.1:${port}` };
  s.child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', HTTPS: '0', SFU: '0', DATA_DIR: dataDir,
      TRUST_PROXY: '1', ALERT_INTERVAL_MS: '0', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.child.stdout.on('data', (d) => { s.logs += d; });
  s.child.stderr.on('data', (d) => { s.logs += d; });
  await waitFor(async () => (await httpAt(s.base, 'GET', '/api/config').catch(() => ({}))).status === 200, { timeout: 20000, message: `${name} up` })
    .catch((e) => { throw new Error(e.message + '\n' + s.logs); });
  servers[name] = s;
  return s;
}

let ipSeq = 0;
async function api(base, method, url, { token, body, ip, ua = UA_WIN } = {}) {
  const r = await httpAt(base, method, url, { token, body, headers: { 'X-Forwarded-For': ip || `10.23.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`, 'User-Agent': ua } });
  responses.push(JSON.stringify(r.json));
  return r;
}
async function register(base, prefix = 'tg') {
  const username = uniqueName(prefix).slice(0, 20);
  const r = await api(base, 'POST', '/api/register', { body: { username, password: 'secret123' } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { username, password: 'secret123', token: r.json.token, id: r.json.user.id };
}

let chatSeq = 5550000;
/** Привязать Telegram: ссылка → /start <токен> → опрос статуса. Возвращает коды восстановления. */
async function link(base, botToken, u) {
  u.chat = ++chatSeq;
  const l = await api(base, 'POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: u.password } });
  expect(l.status, JSON.stringify(l.json)).toBe(200);
  const startToken = new URL(l.json.link).searchParams.get('start');
  startCmd(botToken, u.chat, `/start ${startToken}`);
  const st = await waitFor(async () => {
    const r = await api(base, 'GET', '/api/me/2fa/telegram/link', { token: u.token });
    return r.json.linked ? r.json : null;
  }, { timeout: 10000, message: 'привязка Telegram' });
  u.recovery = st.recoveryCodes;
  return st;
}
async function loginStep1(base, u, opts = {}) {
  const r = await api(base, 'POST', '/api/login', { body: { username: u.username, password: u.password }, ...opts });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.twoFactor).toBe(true);
  return r.json;
}
const readDb = (s) => JSON.parse(fs.readFileSync(path.join(s.dataDir, 'db.json'), 'utf8'));

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-tg2fa-'));
  await startFakeTelegram();
  await startProxy();
  await startAstra('A', A_PORT, {
    TELEGRAM_BOT_TOKEN: TOKEN_A, TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`, TELEGRAM_PROXY: 'off',
    ADMIN_USERS: 'tgboss', TG2FA_RESEND_GAP_MS: '1200',
  });
  await startAstra('B', B_PORT, {
    // токен — через запасную цепочку (как бот резервных копий), Bot API напрямую недоступен → VPN-прокси
    BACKUP_TELEGRAM_TOKEN: TOKEN_B, BACKUP_TELEGRAM_API: `http://127.0.0.1:${DEAD_PORT}`, SPOTIFY_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
    ADMIN_USERS: 'tgboss2', ADMIN_ALLOW_TG_2FA: '0', TG2FA_LINK_TTL_MS: '1500', TG2FA_CODE_TTL_MS: '2500', TG2FA_RESEND_GAP_MS: '500',
  });
});

test.afterAll(async () => {
  for (const s of sockets) s.close();
  for (const s of Object.values(servers)) {
    s.child.kill('SIGTERM');
    await new Promise((r) => (s.child.exitCode !== null ? r() : s.child.once('exit', r)));
  }
  tgServer?.close();
  proxyServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('привязка: пароль, ссылка t.me/<бот>?start=…, неверный токен игнорируется, ответ бота, коды восстановления один раз', async () => {
  const u = await register(A, 'tglink');
  // опрос не идёт, пока нечего ждать (бот общий с резервными копиями)
  expect(bot(TOKEN_A).calls.filter((c) => c.method === 'getUpdates')).toHaveLength(0);
  let st = await api(A, 'GET', '/api/me/2fa', { token: u.token });
  expect(st.json).toMatchObject({ enabled: false, telegram: { available: true, enabled: false } });
  expect((await api(A, 'POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: 'wrong' } })).status).toBe(400);
  expect((await api(A, 'POST', '/api/me/2fa/telegram/link', { token: u.token, body: {} })).status).toBe(400);
  const l = await api(A, 'POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: u.password } });
  expect(l.status).toBe(200);
  expect(l.json.link).toMatch(/^https:\/\/t\.me\/astra_test_bot\?start=[A-Za-z0-9_-]{32}$/);
  expect(l.json.bot).toBe('astra_test_bot');
  expect(l.json.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
  const startToken = new URL(l.json.link).searchParams.get('start');

  // чужой/неверный токен — без привязки и без ответа
  const stranger = 4440001;
  startCmd(TOKEN_A, stranger, `/start ${'x'.repeat(32)}`);
  startCmd(TOKEN_A, stranger, '/start');
  startCmd(TOKEN_A, stranger, 'привет');
  await waitFor(() => bot(TOKEN_A).updates.length === 0 || null, { timeout: 8000, message: 'обновления прочитаны' });
  await sleep(300);
  expect(sentTo(TOKEN_A, stranger)).toHaveLength(0);
  expect((await api(A, 'GET', '/api/me/2fa/telegram/link', { token: u.token })).json).toMatchObject({ linked: false, pending: true });

  u.chat = ++chatSeq;
  startCmd(TOKEN_A, u.chat, `/start ${startToken}`, 'ivan_tg');
  const done = await waitFor(async () => {
    const r = await api(A, 'GET', '/api/me/2fa/telegram/link', { token: u.token });
    return r.json.linked ? r.json : null;
  }, { timeout: 10000, message: 'привязка' });
  expect(done.recoveryCodes).toHaveLength(10);
  expect(done.user.tg2faEnabled).toBe(true);
  // коды выдаются один раз
  expect((await api(A, 'GET', '/api/me/2fa/telegram/link', { token: u.token })).json.recoveryCodes).toBeUndefined();
  await waitFor(() => sentTo(TOKEN_A, u.chat).length || null, { timeout: 5000, message: 'ответ бота' });
  expect(sentTo(TOKEN_A, u.chat)[0].text).toBe(`Аккаунт Astra «${u.username}» привязан. Здесь будут приходить коды входа.`);
  // опрос остановился (ждать нечего); тот же токен второй раз (другой чат, пока идёт чужая привязка) — не сработает
  await waitFor(async () => {
    const before = bot(TOKEN_A).calls.length;
    await sleep(1500);
    return bot(TOKEN_A).calls.length === before || null;
  }, { timeout: 10000, message: 'опрос остановлен' });
  const u2 = await register(A, 'tglink2');
  expect((await api(A, 'POST', '/api/me/2fa/telegram/link', { token: u2.token, body: { password: u2.password } })).status).toBe(200);
  startCmd(TOKEN_A, 4440002, `/start ${startToken}`);
  await waitFor(() => bot(TOKEN_A).updates.length === 0 || null, { timeout: 8000, message: 'обновления прочитаны' });
  await sleep(300);
  expect(sentTo(TOKEN_A, 4440002)).toHaveLength(0);
  expect((await api(A, 'GET', '/api/me/2fa/telegram/link', { token: u2.token })).json.linked).toBe(false);
  expect((await api(A, 'DELETE', '/api/me/2fa/telegram/link', { token: u2.token })).status).toBe(200);
  await waitFor(() => readDb(servers.A).users.find((x) => x.id === u.id).tgChatId === String(u.chat) || null, { message: 'db.json сохранён' });

  st = await api(A, 'GET', '/api/me/2fa', { token: u.token });
  expect(st.json).toMatchObject({ enabled: true, totpEnabled: false, recoveryCodesLeft: 10, telegram: { enabled: true, account: '@ivan_tg' } });
  expect(JSON.stringify(st.json)).not.toContain(String(u.chat));
  const me = await api(A, 'GET', '/api/me', { token: u.token });
  expect(me.json.user).toMatchObject({ tg2faEnabled: true, totpEnabled: false });
  expect(JSON.stringify(me.json)).not.toContain(String(u.chat));
  // повторная привязка — отказ; offset сохранён на диск
  expect((await api(A, 'POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: u.password } })).status).toBe(400);
  expect(JSON.parse(fs.readFileSync(path.join(servers.A.dataDir, 'telegram-offset.json'), 'utf8')).offset).toBeGreaterThan(1);
});

test('просроченная ссылка не привязывает; Telegram напрямую недоступен — всё идёт через VPN-прокси', async () => {
  const u = await register(B, 'tgexp');
  const before = proxyLog.length;
  const l = await api(B, 'POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: u.password } });
  expect(l.status, JSON.stringify(l.json)).toBe(200); // getMe — через прокси
  expect(proxyLog.length).toBeGreaterThan(before);
  expect(proxyLog.at(-1)).toBe(`CONNECT 127.0.0.1:${DEAD_PORT} HTTP/1.1`);
  await sleep(1700); // TG2FA_LINK_TTL_MS=1500
  startCmd(TOKEN_B, 6660001, `/start ${new URL(l.json.link).searchParams.get('start')}`);
  await sleep(1500);
  expect((await api(B, 'GET', '/api/me/2fa/telegram/link', { token: u.token })).json.linked).toBe(false);
  expect(sentTo(TOKEN_B, 6660001)).toHaveLength(0);
  // свежая ссылка — привязка и коды через прокси
  await link(B, TOKEN_B, u);
  const s1 = await loginStep1(B, u);
  const msg = await nextMessage(TOKEN_B, u.chat, 0);
  const ok = await api(B, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code: codeOf(msg) } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(bot(TOKEN_B).calls.map((c) => c.method)).toEqual(expect.arrayContaining(['getMe', 'getUpdates', 'sendMessage']));
  // код истекает: сообщение правится на «⌛ Код истёк» (TG2FA_CODE_TTL_MS=2500)
  await sleep(600);
  const s2 = await loginStep1(B, u);
  const msg2 = await nextMessage(TOKEN_B, u.chat, sentTo(TOKEN_B, u.chat).indexOf(msg) + 1);
  await waitFor(() => editsOf(TOKEN_B, msg2).includes('⌛ Код истёк') || null, { timeout: 15000, message: '⌛ Код истёк' });
  const late = await api(B, 'POST', '/api/login/2fa', { body: { challenge: s2.challenge, code: codeOf(msg2) } });
  expect(late.status).toBe(401);
});

test('вход: код из Telegram (6 цифр, устройство и IP с маской, кнопки), неверный код, одноразовость, «✅ Вход подтверждён»', async () => {
  const u = await register(A, 'tgcode');
  await link(A, TOKEN_A, u);
  const n = sentTo(TOKEN_A, u.chat).length;
  const s1 = await loginStep1(A, u, { ip: '89.108.77.66' });
  expect(s1.methods).toEqual(['telegram', 'recovery']);
  expect(['sending', 'sent']).toContain(s1.telegram.state);
  const msg = await nextMessage(TOKEN_A, u.chat, n);
  expect(msg.text).toMatch(/^🔐 Вход в Astra\nКод: \d{6}\nУстройство: Chrome, Windows, IP 89\.108\.\*\.\*\nЕсли это не вы — нажмите «Это не я» и смените пароль\.$/);
  expect(msg.text).not.toContain('77.66');
  const kb = msg.reply_markup.inline_keyboard[0];
  expect(kb.map((b) => b.text)).toEqual(['✅ Это я', '⛔ Это не я']);
  for (const b of kb) {
    expect(b.callback_data).toMatch(/^(ok|no):[A-Za-z0-9_-]{22}$/);
    expect(b.callback_data).not.toContain(u.id);
  }
  const code = codeOf(msg);
  const bad = String((Number(code) + 1) % 1e6).padStart(6, '0');
  const r1 = await api(A, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code: bad } });
  expect([r1.status, r1.json.code, r1.json.error]).toEqual([401, 'totp_invalid', 'Неверный код']);
  const st = await api(A, 'POST', '/api/login/2fa/status', { body: { challenge: s1.challenge } });
  expect(st.json).toMatchObject({ pending: true, telegram: { state: 'sent' } });
  const ok = await api(A, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(typeof ok.json.token).toBe('string');
  await waitFor(() => editsOf(TOKEN_A, msg).includes('✅ Вход подтверждён') || null, { timeout: 5000, message: 'правка ✅' });
  // тот же код ко второму входу не подходит (привязан к своему шагу и одноразовый)
  const s2 = await loginStep1(A, u);
  const again = await api(A, 'POST', '/api/login/2fa', { body: { challenge: s2.challenge, code } });
  expect(again.json.code).toBe('totp_invalid');
});

test('вход кнопкой «✅ Это я»: чужой чат игнорируется, экран входа получает сессию опросом', async () => {
  const u = await register(A, 'tgok');
  await link(A, TOKEN_A, u);
  const n = sentTo(TOKEN_A, u.chat).length;
  const s1 = await loginStep1(A, u);
  const msg = await nextMessage(TOKEN_A, u.chat, n);
  // нажатие из другого чата (переслали сообщение) — отказ
  const answersBefore = bot(TOKEN_A).answers.length;
  press(TOKEN_A, u.chat, msg, 'ok', { fromChat: 4449999 });
  await waitFor(() => bot(TOKEN_A).answers.length > answersBefore || null, { timeout: 8000, message: 'answerCallbackQuery' });
  expect(bot(TOKEN_A).answers.at(-1).text).toBe('Запрос не найден или устарел');
  expect((await api(A, 'POST', '/api/login/2fa/status', { body: { challenge: s1.challenge } })).json.pending).toBe(true);
  press(TOKEN_A, u.chat, msg, 'ok');
  const done = await waitFor(async () => {
    const r = await api(A, 'POST', '/api/login/2fa/status', { body: { challenge: s1.challenge } });
    return r.json.token ? r.json : null;
  }, { timeout: 10000, message: 'вход по кнопке' });
  expect(done.user.username).toBe(u.username);
  expect((await api(A, 'GET', '/api/me', { token: done.token })).status).toBe(200);
  expect(editsOf(TOKEN_A, msg)).toContain('✅ Вход подтверждён');
  expect(bot(TOKEN_A).answers.at(-1).text).toBe('Вход подтверждён');
  // второй шаг одноразовый
  expect((await api(A, 'POST', '/api/login/2fa/status', { body: { challenge: s1.challenge } })).json.code).toBe('challenge_invalid');
});

test('«⛔ Это не я»: вход отменён, Telegram-коды заблокированы на 15 минут, совет в боте, событие в журнале; код восстановления работает', async () => {
  const u = await register(A, 'tgno');
  await link(A, TOKEN_A, u);
  const n = sentTo(TOKEN_A, u.chat).length;
  const s1 = await loginStep1(A, u, { ip: '203.0.113.9' });
  const msg = await nextMessage(TOKEN_A, u.chat, n);
  press(TOKEN_A, u.chat, msg, 'no');
  const denied = await waitFor(async () => {
    const r = await api(A, 'POST', '/api/login/2fa/status', { body: { challenge: s1.challenge } });
    return r.status === 401 ? r : null;
  }, { timeout: 10000, message: 'отказ' });
  expect(denied.json.code).toBe('challenge_denied');
  expect(editsOf(TOKEN_A, msg)).toContain('⛔ Вход отклонён');
  const advice = await nextMessage(TOKEN_A, u.chat, n, /приостановлен/);
  expect(advice.text).toContain('приостановлен на 15 минут');
  expect(advice.text).toContain('203.0.*.*');
  // код из отклонённого сообщения больше не подходит
  expect((await api(A, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code: codeOf(msg) } })).json.code).toBe('challenge_invalid');
  // новый вход: Telegram заблокирован, код не отправляется
  const sentBefore = sentTo(TOKEN_A, u.chat).length;
  const s2 = await loginStep1(A, u);
  expect(s2.telegram.state).toBe('locked');
  expect((await api(A, 'POST', '/api/login/2fa/resend', { body: { challenge: s2.challenge } })).json.code).toBe('tg_locked');
  await sleep(500);
  expect(sentTo(TOKEN_A, u.chat)).toHaveLength(sentBefore);
  const viaRecovery = await api(A, 'POST', '/api/login/2fa', { body: { challenge: s2.challenge, code: u.recovery[0] } });
  expect(viaRecovery.status).toBe(200);
  const auditLog = fs.readFileSync(path.join(servers.A.dataDir, 'admin-audit.jsonl'), 'utf8');
  const ev = auditLog.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.action === 'security.tg_login_denied' && e.actor?.id === u.id);
  expect(ev).toBeTruthy();
  expect(JSON.stringify(ev)).not.toContain(String(u.chat));
  const st = await api(A, 'GET', '/api/me/2fa', { token: viaRecovery.json.token });
  expect(st.json.telegram.lockedFor).toBeGreaterThan(800);
});

test('повторная отправка: не чаще раза в 30 с (в тесте 1,2 с) и не больше 5 за 15 минут; старый код истекает', async () => {
  const u = await register(A, 'tgresend');
  await link(A, TOKEN_A, u);
  const n = sentTo(TOKEN_A, u.chat).length;
  const s1 = await loginStep1(A, u);
  const first = await nextMessage(TOKEN_A, u.chat, n);
  const tooSoon = await api(A, 'POST', '/api/login/2fa/resend', { body: { challenge: s1.challenge } });
  expect(tooSoon.status).toBe(429);
  expect(tooSoon.json.code).toBe('tg_resend_limited');
  expect(Number(tooSoon.headers.get('retry-after'))).toBeGreaterThan(0);
  let last = first;
  for (let i = 2; i <= 5; i++) {
    await sleep(1300);
    const r = await api(A, 'POST', '/api/login/2fa/resend', { body: { challenge: s1.challenge } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const m = await nextMessage(TOKEN_A, u.chat, sentTo(TOKEN_A, u.chat).indexOf(last) + 1);
    await waitFor(() => editsOf(TOKEN_A, last).some((t) => t.startsWith('⌛')) || null, { timeout: 5000, message: 'старое сообщение — ⌛' });
    last = m;
  }
  await sleep(1300);
  const sixth = await api(A, 'POST', '/api/login/2fa/resend', { body: { challenge: s1.challenge } });
  expect(sixth.status).toBe(429);
  expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(60);
  // первый код больше не подходит, последний — подходит
  expect((await api(A, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code: codeOf(first) } })).json.code).toBe('totp_invalid');
  expect((await api(A, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code: codeOf(last) } })).status).toBe(200);
});

test('отвязка: пароль + код из Telegram (код «для действия»); без кода — отказ; бот сообщает; вход снова без 2FA', async () => {
  const u = await register(A, 'tgunl');
  await link(A, TOKEN_A, u);
  expect((await api(A, 'POST', '/api/me/2fa/telegram/unlink', { token: u.token, body: { password: u.password } })).json.code).toBe('totp_required');
  expect((await api(A, 'POST', '/api/me/2fa/telegram/unlink', { token: u.token, body: { password: u.password, code: '123456' } })).json.code).toBe('totp_invalid');
  const n = sentTo(TOKEN_A, u.chat).length;
  const sc = await api(A, 'POST', '/api/me/2fa/telegram/code', { token: u.token });
  expect(sc.status, JSON.stringify(sc.json)).toBe(200);
  const msg = await nextMessage(TOKEN_A, u.chat, n);
  expect(msg.text).toContain('Подтверждение действия');
  expect(msg.reply_markup).toBeUndefined();
  // код «для действия» не подходит ко входу (привязан к назначению)
  const s1 = await loginStep1(A, u);
  expect((await api(A, 'POST', '/api/login/2fa', { body: { challenge: s1.challenge, code: codeOf(msg) } })).json.code).toBe('totp_invalid');
  expect((await api(A, 'POST', '/api/me/2fa/telegram/unlink', { token: u.token, body: { password: 'wrong', code: codeOf(msg) } })).status).toBe(400);
  const off = await api(A, 'POST', '/api/me/2fa/telegram/unlink', { token: u.token, body: { password: u.password, code: codeOf(msg) } });
  expect(off.status, JSON.stringify(off.json)).toBe(200);
  expect(off.json.user.tg2faEnabled).toBe(false);
  await nextMessage(TOKEN_A, u.chat, n, /отвязан/);
  const dbU = await waitFor(() => { const x = readDb(servers.A).users.find((y) => y.id === u.id); return x.tgChatId === undefined ? x : null; }, { message: 'db.json сохранён' });
  expect(dbU.totpRecovery).toBeUndefined();
  const login = await api(A, 'POST', '/api/login', { body: { username: u.username, password: u.password } });
  expect(typeof login.json.token).toBe('string');
});

test('другие пользователи не видят chat id и флаг Telegram', async () => {
  const owner = await register(A, 'tgown');
  const other = await register(A, 'tgoth');
  const so = await connected(connect(owner.token, { base: A })); sockets.push(so);
  const sx = await connected(connect(other.token, { base: A })); sockets.push(sx);
  const srv = (await ack(so, 'server:create', { name: 'tg2fa' })).server;
  expect((await ack(sx, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const updates = [];
  sx.on('user:updated', (p) => updates.push(p));
  await link(A, TOKEN_A, owner);
  await waitFor(() => updates.some((p) => p.user?.id === owner.id) || null, { timeout: 5000, message: 'user:updated' });
  const chat = String(owner.chat);
  for (const p of updates) {
    expect(JSON.stringify(p)).not.toContain(chat);
    expect('tg2faEnabled' in p.user).toBe(false);
  }
  const view = await ack(sx, 'bootstrap');
  expect(JSON.stringify(view)).not.toContain(chat);
  const m = (view.servers || []).flatMap((s) => s.members || []).find((x) => x.id === owner.id);
  expect(m).toBeTruthy();
  expect('tg2faEnabled' in m).toBe(false);
});

test('админ-панель: разблокировка кодом из Telegram и кнопкой «Это я»; с ADMIN_ALLOW_TG_2FA=0 Telegram не засчитывается', async () => {
  // сервер A: tgboss — администратор (ADMIN_USERS), 2FA только Telegram
  const r = await api(A, 'POST', '/api/register', { body: { username: 'tgboss', password: 'secret123' } });
  const boss = { username: 'tgboss', password: 'secret123', token: r.json.token, id: r.json.user.id };
  expect((await api(A, 'GET', '/api/admin/me', { token: boss.token })).json).toMatchObject({ admin: true, active: false });
  await link(A, TOKEN_A, boss);
  expect((await api(A, 'GET', '/api/admin/me', { token: boss.token })).json).toMatchObject({ admin: true, active: true, unlocked: false, tg2faEnabled: true, allowTg2fa: true });
  expect((await api(A, 'GET', '/api/admin/servers', { token: boss.token })).json.code).toBe('admin_unlock_required');
  let n = sentTo(TOKEN_A, boss.chat).length;
  const t1 = await api(A, 'POST', '/api/admin/unlock/telegram', { token: boss.token });
  expect(t1.status, JSON.stringify(t1.json)).toBe(200);
  const msg = await nextMessage(TOKEN_A, boss.chat, n);
  expect(msg.text.split('\n')[0]).toBe('🔐 Открыть админ-панель Astra');
  // код «админ-панели» не годится для чужого сеанса и для входа
  const ok = await api(A, 'POST', '/api/admin/unlock', { token: boss.token, body: { code: codeOf(msg) } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect((await api(A, 'GET', '/api/admin/servers', { token: boss.token })).status).toBe(200);
  await waitFor(() => editsOf(TOKEN_A, msg).some((t) => t.startsWith('✅')) || null, { timeout: 5000, message: '✅' });

  // новый сеанс (вход кнопкой) → разблокировка кнопкой «Это я»
  n = sentTo(TOKEN_A, boss.chat).length;
  await sleep(1300); // лимит отправки в тесте — 1,2 с
  const s1 = await loginStep1(A, boss);
  const lm = await nextMessage(TOKEN_A, boss.chat, n);
  press(TOKEN_A, boss.chat, lm, 'ok');
  const sess = await waitFor(async () => (await api(A, 'POST', '/api/login/2fa/status', { body: { challenge: s1.challenge } })).json.token || null, { timeout: 10000, message: 'вход' });
  expect((await api(A, 'GET', '/api/admin/servers', { token: sess })).json.code).toBe('admin_unlock_required');
  await sleep(1300);
  n = sentTo(TOKEN_A, boss.chat).length;
  const t2 = await api(A, 'POST', '/api/admin/unlock/telegram', { token: sess });
  expect(t2.status, JSON.stringify(t2.json)).toBe(200);
  const am = await nextMessage(TOKEN_A, boss.chat, n);
  // чужой сеанс не может забрать подтверждение
  expect((await api(A, 'POST', '/api/admin/unlock', { token: boss.token, body: { tgRequest: t2.json.requestId } })).json.ok).toBe(false);
  expect((await api(A, 'POST', '/api/admin/unlock', { token: sess, body: { tgRequest: t2.json.requestId } })).json).toMatchObject({ ok: false, pending: true });
  press(TOKEN_A, boss.chat, am, 'ok');
  const un = await waitFor(async () => {
    const x = await api(A, 'POST', '/api/admin/unlock', { token: sess, body: { tgRequest: t2.json.requestId } });
    return x.json.ok ? x : null;
  }, { timeout: 10000, message: 'разблокировка кнопкой' });
  expect(un.json.until).toBeGreaterThan(Date.now());
  expect((await api(A, 'GET', '/api/admin/servers', { token: sess })).status).toBe(200);
  const audit = fs.readFileSync(path.join(servers.A.dataDir, 'admin-audit.jsonl'), 'utf8');
  expect(audit).toContain('"method":"telegram"');
  // список пользователей админки: флаг есть, chat id — нет
  const users = await api(A, 'GET', '/api/admin/users', { token: sess });
  expect(JSON.stringify(users.json)).not.toContain(String(boss.chat));

  // сервер B: ADMIN_ALLOW_TG_2FA=0 — только приложение-аутентификатор
  const r2 = await api(B, 'POST', '/api/register', { body: { username: 'tgboss2', password: 'secret123' } });
  const boss2 = { username: 'tgboss2', password: 'secret123', token: r2.json.token, id: r2.json.user.id };
  await link(B, TOKEN_B, boss2);
  expect((await api(B, 'GET', '/api/admin/me', { token: boss2.token })).json).toMatchObject({ admin: true, active: false, allowTg2fa: false });
  expect((await api(B, 'POST', '/api/admin/unlock/telegram', { token: boss2.token })).json.code).toBe('admin_2fa_required');
  expect((await api(B, 'POST', '/api/admin/unlock', { token: boss2.token, body: { code: '123456' } })).json.code).toBe('admin_2fa_required');
  expect((await api(B, 'GET', '/api/admin/servers', { token: boss2.token })).json.code).toBe('admin_2fa_required');
});

test('интерфейс: привязка в настройках (живое обновление), вход кнопкой «Это я», Telegram недоступен → код восстановления', async ({ page, browser }) => {
  const u = await register(A, 'tgui');
  await page.goto(A);
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), u.token);
  await page.goto(A);
  await expect(page.locator('#app')).toBeVisible();
  const acc = await openSection(page, 'account');
  const box = acc.locator('#settings-2fa');
  await expect(box.locator('#twofa-status')).toHaveAttribute('data-enabled', 'false');
  await expect(box.locator('#twofa-enable')).toBeVisible(); // приложение-аутентификатор
  await box.locator('#twofa-tg-enable').click();
  await box.locator('#twofa-tg-password').fill(u.password);
  await box.locator('#twofa-tg-submit').click();
  await expect(box.locator('#twofa-tg-qr svg')).toBeVisible();
  await expect(box.locator('#twofa-tg-note')).toContainText('Облачный пароль');
  const href = await box.locator('#twofa-tg-open').getAttribute('href');
  expect(href).toMatch(/^https:\/\/t\.me\/astra_test_bot\?start=/);
  u.chat = ++chatSeq;
  startCmd(TOKEN_A, u.chat, `/start ${new URL(href).searchParams.get('start')}`);
  await expect(box.locator('#twofa-recovery-list li')).toHaveCount(10, { timeout: 15000 });
  const codes = (await box.locator('#twofa-recovery-list li').allInnerTexts()).map((t) => t.trim());
  await box.locator('#twofa-done').click();
  await expect(box.locator('#twofa-status')).toHaveAttribute('data-enabled', 'true');
  await expect(box.locator('#twofa-method-tg')).toHaveAttribute('data-enabled', 'true');
  await expect(box.locator('#twofa-method-tg')).toContainText('@tg_user');
  await expect(page.locator('#settings-password-2fa')).toBeVisible();
  await page.screenshot({ path: path.join(ROOT, 'tests', '.results', 'v23-settings-telegram.png') });

  // вход в новом браузере: пароль → «Это я» в боте → приложение открывается само
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const p2 = await ctx.newPage();
  await p2.goto(A);
  if (await p2.locator('#auth-toggle').innerText() === 'Войти') await p2.locator('#auth-toggle').click();
  await p2.locator('#auth-username').fill(u.username);
  await p2.locator('#auth-password').fill(u.password);
  const n = sentTo(TOKEN_A, u.chat).length;
  await p2.locator('#auth-submit').click();
  await expect(p2.locator('#auth-2fa-form')).toBeVisible();
  await expect(p2.locator('#auth-2fa-label')).toHaveText('Код из Telegram');
  await expect(p2.locator('#auth-2fa-tg-text')).toContainText('Код отправлен в Telegram');
  await expect(p2.locator('#auth-2fa-resend')).toBeVisible();
  await p2.screenshot({ path: path.join(ROOT, 'tests', '.results', 'v23-login-telegram.png') });
  const msg = await nextMessage(TOKEN_A, u.chat, n);
  press(TOKEN_A, u.chat, msg, 'ok');
  await expect(p2.locator('#app')).toBeVisible({ timeout: 15000 });
  await ctx.close();

  // Telegram недоступен: экран входа говорит об этом и предлагает код восстановления
  bot(TOKEN_A).failSend = true;
  try {
    const ctx3 = await browser.newContext();
    const p3 = await ctx3.newPage();
    await p3.goto(A);
    if (await p3.locator('#auth-toggle').innerText() === 'Войти') await p3.locator('#auth-toggle').click();
    await p3.locator('#auth-username').fill(u.username);
    await p3.locator('#auth-password').fill(u.password);
    await sleep(1300);
    await p3.locator('#auth-submit').click();
    await expect(p3.locator('#auth-2fa-tg-text')).toContainText('Telegram недоступен', { timeout: 15000 });
    await expect(p3.locator('#auth-2fa-label')).toHaveText('Код восстановления');
    await p3.locator('#auth-2fa-code').fill(codes[0]);
    await p3.locator('#auth-2fa-submit').click();
    await expect(p3.locator('#app')).toBeVisible();
    await ctx3.close();
  } finally { bot(TOKEN_A).failSend = false; }
});

test('токен бота не попадает в ответы API и журналы (в т. ч. при ошибках getUpdates)', async () => {
  // 409 от getUpdates (кто-то ещё читает обновления этого бота) — опрос продолжается с паузой
  bot(TOKEN_A).conflictOnce = true;
  const u = await register(A, 'tgleak');
  await link(A, TOKEN_A, u);
  await waitFor(() => /Приём обновлений: Telegram ответил ошибкой: Conflict/.test(servers.A.logs) || null, { timeout: 10000, message: 'лог 409' });
  for (const s of Object.values(servers)) {
    for (const secret of [TOKEN_A, TOKEN_B, ...SECRET_PARTS]) expect(s.logs, `журнал ${s.name}`).not.toContain(secret);
  }
  const all = responses.join('\n');
  for (const secret of [TOKEN_A, TOKEN_B, ...SECRET_PARTS]) expect(all).not.toContain(secret);
  // chat id в журналах тоже не пишется
  expect(servers.A.logs).not.toContain(String(u.chat));
});
