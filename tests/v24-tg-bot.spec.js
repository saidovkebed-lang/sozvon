// v24: Telegram-бот Astra с меню (server/tgbot.js), уведомления и ответы из Telegram, сброс пароля
// (server/pwreset.js), вход без пароля (server/tg2fa.js, server/tg-routes.js), приглашения, служебное меню
// владельца (обновление/бэкап через root-помощника, cookies YouTube файлом, новые пользователи),
// deploy/backup.sh telegram-chat-id через admin.sock и определение поддержки цветных кнопок.
// Фейковый Telegram Bot API (как в v23) + getFile/скачивание файла, deleteMessage, setMyCommands, setChatMenuButton.
import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { PORT as QA_PORT, ROOT } from './fixtures/env.js';
import { httpAt, connect, connected, ack, waitFor, waitEvent, sleep, uniqueName } from './fixtures/api.js';
import { openSection } from './fixtures/v2.js';

test.describe.configure({ mode: 'serial' });

const A_PORT = QA_PORT + 70;
const TG_PORT = QA_PORT + 71;
const A = `http://127.0.0.1:${A_PORT}`;
const PUBLIC = 'https://astra.example';
const TOKEN = '888001:TEST_tgbot_SECRET_aaaaaaaaaaaaaaaaaaaaa';
const OTHER_TOKEN = '888002:TEST_tgbot_SECRET_cccccccccccccccccccc';
const PROXY_SECRET = 'SECRETPROXYPW';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp;
let astra = null;
const responses = [];
const sockets = [];

/* ---------------- фейковый Telegram Bot API ---------------- */
const bots = {};
function bot(token = TOKEN) {
  bots[token] ||= { updates: [], nextUpdate: 1, sent: [], edits: [], answers: [], deleted: [], commands: [], menuButtons: [], calls: [], msgId: 1000, rejectStyle: false, styleRejections: 0, files: {}, getFile: [] };
  return bots[token];
}
const hasStyleField = (body) => JSON.stringify(body?.reply_markup || {}).includes('"style"');
let tgServer;
function startFakeTelegram() {
  tgServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const file = req.url.match(/^\/file\/bot([^/]+)\/documents\/([\w-]+)\.txt$/);
      if (file) {
        const f = bot(file[1]).files[file[2]];
        if (!f) { res.statusCode = 404; return res.end('nope'); }
        res.setHeader('content-type', 'text/plain');
        return res.end(f.content);
      }
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) { res.statusCode = 404; return res.end('{"ok":false}'); }
      const [, token, method] = m;
      const st = bot(token);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      // backup.sh шлёт form-data/urlencoded через curl — тело не JSON
      st.calls.push({ method, body, ua: String(req.headers['user-agent'] || '') });
      const reply = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      const styleReject = () => {
        st.styleRejections++;
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: can\'t parse inline keyboard button: unknown field "style"' }));
      };
      if (method === 'getMe') return reply({ id: 888, is_bot: true, first_name: 'Astra', username: 'astra_v24_bot' });
      if (method === 'sendMessage') {
        if (st.rejectStyle && hasStyleField(body)) return styleReject();
        const msg = { message_id: ++st.msgId, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text, reply_markup: body.reply_markup };
        st.sent.push(msg);
        return reply(msg);
      }
      if (method === 'editMessageText') {
        if (st.rejectStyle && hasStyleField(body)) return styleReject();
        st.edits.push(body);
        return reply({ message_id: body.message_id, text: body.text });
      }
      if (method === 'answerCallbackQuery') { st.answers.push(body); return reply(true); }
      if (method === 'deleteMessage') { st.deleted.push(body); return reply(true); }
      if (method === 'setMyCommands') { st.commands.push(body); return reply(true); }
      if (method === 'setChatMenuButton') { st.menuButtons.push(body); return reply(true); }
      if (method === 'getFile') {
        st.getFile.push(body.file_id);
        const f = st.files[body.file_id];
        if (!f) return reply({ file_id: body.file_id });
        return reply({ file_id: body.file_id, file_size: f.declared ?? f.content.length, file_path: `documents/${body.file_id}.txt` });
      }
      if (method === 'getUpdates') {
        const offset = Number(body.offset) || 0;
        st.updates = st.updates.filter((u) => u.update_id >= offset);
        const until = Date.now() + 700;
        while (!st.updates.length && Date.now() < until) await sleep(40);
        return reply(st.updates.slice());
      }
      return reply(true);
    });
  });
  return new Promise((r) => tgServer.listen(TG_PORT, '127.0.0.1', r));
}
const pushUpd = (token, upd) => { const st = bot(token); st.updates.push({ update_id: st.nextUpdate++, ...upd }); };
let tgMsgSeq = 1;
function sendText(chatId, text, { token = TOKEN, replyTo = null, username = 'tg_user' } = {}) {
  const message = { message_id: ++tgMsgSeq, date: 0, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Тест', username } };
  if (replyTo) message.reply_to_message = { message_id: replyTo, chat: { id: chatId, type: 'private' } };
  pushUpd(token, { message });
  return message;
}
function sendDoc(chatId, fileId, { name = 'cookies.txt', size, token = TOKEN } = {}) {
  const message = { message_id: ++tgMsgSeq, date: 0, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Тест' }, document: { file_id: fileId, file_unique_id: fileId, file_name: name, file_size: size } };
  pushUpd(token, { message });
  return message;
}
function pressData(chatId, msgId, data, { fromChat = chatId, token = TOKEN } = {}) {
  pushUpd(token, { callback_query: { id: `cq${Math.random()}`, from: { id: fromChat, is_bot: false, first_name: 'X' }, message: { message_id: msgId, chat: { id: chatId, type: 'private' } }, data } });
}
const allButtons = (kb) => (kb?.inline_keyboard || []).flat();
const btnBy = (msg, re) => allButtons(msg.reply_markup).find((b) => re.test(b.text));
function press(chatId, msg, re, opts) {
  const b = btnBy(msg, re);
  if (!b) throw new Error(`нет кнопки ${re} в ${JSON.stringify(msg.reply_markup)}`);
  pressData(chatId, msg.message_id, b.callback_data, opts);
}
const sentTo = (chatId, token = TOKEN) => bot(token).sent.filter((m) => m.chat.id === chatId);
async function nextMsg(chatId, after, re, { timeout = 10000, token = TOKEN } = {}) {
  return waitFor(() => sentTo(chatId, token).slice(after).find((m) => re.test(m.text)) || null, { timeout, message: `сообщение ${re} в чат ${chatId}` });
}
/** Текущий вид сообщения (последняя правка или оригинал) */
function view(msg, token = TOKEN) {
  const e = bot(token).edits.filter((x) => x.message_id === msg.message_id && Number(x.chat_id) === msg.chat.id).at(-1);
  return e ? { message_id: msg.message_id, chat: msg.chat, text: e.text, reply_markup: e.reply_markup } : msg;
}
async function waitView(msg, re, timeout = 10000) {
  return waitFor(() => { const v = view(msg); return re.test(v.text) ? v : null; }, { timeout, message: `правка ${re}` });
}
async function lastAnswer(after, timeout = 8000) {
  return waitFor(() => bot().answers[after] || null, { timeout, message: 'answerCallbackQuery' });
}

/* ---------------- Astra ---------------- */
function writeExec(file, text) { fs.writeFileSync(file, text, { mode: 0o755 }); return file; }

async function startAstra() {
  const dataDir = path.join(tmp, 'A');
  fs.mkdirSync(dataDir, { recursive: true });
  const s = { dataDir, logs: '', base: A };
  s.child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(A_PORT), HOST: '127.0.0.1', HTTPS: '0', SFU: '0', DATA_DIR: dataDir,
      TRUST_PROXY: '1', ALERT_INTERVAL_MS: '0', PUBLIC_URL: PUBLIC,
      TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`, TELEGRAM_PROXY: 'off',
      ADMIN_USERS: 'v24boss', TG2FA_RESEND_GAP_MS: '300', TGBOT_BATCH_MS: '700', TGBOT_STATE_POLL_MS: '250',
      SOZVON_UPDATE_HELPER_CMD: path.join(tmp, 'helper.sh'), SOZVON_STATE_DIR: path.join(tmp, 'state'), HELPER_LOG: path.join(tmp, 'helper-req'),
      YTDLP_PATH: path.join(tmp, 'yt-dlp'), YTDLP_PROXY: `http://px:${PROXY_SECRET}@127.0.0.1:9`, YTDLP_JS_RUNTIME: 'off',
      ADMIN_CERT_FILE: '', SPOTIFY_PROXY: '', YTDLP_COOKIES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.child.stdout.on('data', (d) => { s.logs += d; });
  s.child.stderr.on('data', (d) => { s.logs += d; });
  await waitFor(async () => (await httpAt(s.base, 'GET', '/api/config').catch(() => ({}))).status === 200, { timeout: 20000, message: 'Astra up' })
    .catch((e) => { throw new Error(e.message + '\n' + s.logs); });
  astra = s;
  return s;
}
async function stopAstra() {
  if (!astra) return;
  astra.child.kill('SIGTERM');
  await new Promise((r) => (astra.child.exitCode !== null ? r() : astra.child.once('exit', r)));
}

let ipSeq = 0;
async function api(method, url, { token, body, ip } = {}) {
  const r = await httpAt(A, method, url, { token, body, headers: { 'X-Forwarded-For': ip || `10.24.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0' } });
  responses.push(JSON.stringify(r.json));
  return r;
}
async function register(prefix, name) {
  const username = name || uniqueName(prefix).slice(0, 20);
  const r = await api('POST', '/api/register', { body: { username, password: 'secret123' } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { username, password: 'secret123', token: r.json.token, id: r.json.user.id };
}
let chatSeq = 7770000;
async function link(u, { passwordless } = {}) {
  u.chat = ++chatSeq;
  const n = sentTo(u.chat).length;
  const l = await api('POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: u.password, ...(passwordless === undefined ? {} : { passwordless }) } });
  expect(l.status, JSON.stringify(l.json)).toBe(200);
  sendText(u.chat, `/start ${new URL(l.json.link).searchParams.get('start')}`, { username: `tg_${u.username}`.slice(0, 30) });
  const st = await waitFor(async () => { const r = await api('GET', '/api/me/2fa/telegram/link', { token: u.token }); return r.json.linked ? r.json : null; }, { message: 'привязка' });
  u.recovery = st.recoveryCodes;
  u.menu = await nextMsg(u.chat, n, /^☰ Astra/);
  return u;
}
const readDb = () => JSON.parse(fs.readFileSync(path.join(astra.dataDir, 'db.json'), 'utf8'));
const dbUser = (id) => readDb().users.find((x) => x.id === id);
async function sock(u) { const s = await connected(connect(u.token, { base: A })); sockets.push(s); return s; }

/* TOTP (RFC 6238) для тестов */
function b32decode(s) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of s.toUpperCase().replace(/[\s=]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totpNow(secret, offset = 0) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = mac[19] & 15;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
async function enableTotp(u) {
  const s = await api('POST', '/api/me/2fa/setup', { token: u.token, body: { password: u.password } });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const e = await api('POST', '/api/me/2fa/enable', { token: u.token, body: { code: totpNow(s.json.secret) } });
  expect(e.status, JSON.stringify(e.json)).toBe(200);
  u.secret = s.json.secret;
  if (e.json.recoveryCodes) u.recovery = e.json.recoveryCodes;
  return u;
}

const GOOD_COOKIES = ['# Netscape HTTP Cookie File', '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSAPISID\tabcDEF123/xyz',
  '.youtube.com\tTRUE\t/\tTRUE\t1999999999\t__Secure-3PSID\tsecretsid', '.google.com\tTRUE\t/\tTRUE\t1999999999\tNID\t1', ''].join('\n');

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-v24-'));
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  // фейковый yt-dlp: «работает», если в --cookies есть SAPISID и нет маркера BADPROBE
  writeExec(path.join(tmp, 'yt-dlp'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo 2025.12.01; exit 0; fi
ck=""; prev=""
for a in "$@"; do [ "$prev" = "--cookies" ] && ck=$a; prev=$a; done
if [ -n "$ck" ] && grep -q SAPISID "$ck" && ! grep -q BADPROBE "$ck"; then echo dQw4w9WgXcQ; exit 0; fi
echo "ERROR: [youtube] Sign in to confirm you're not a bot" >&2; exit 1
`);
  // фейковый root-помощник (вместо systemd path-юнита): копирует запрос как есть и пишет итоги
  writeExec(path.join(tmp, 'helper.sh'), `#!/usr/bin/env bash
REQ="$DATA_DIR/update-request"
copy="$HELPER_LOG.$(date +%s%N)"
cp "$REQ" "$copy" 2>/dev/null; rm -f "$REQ"
word=$(tr -dc 'a-z' < "$copy")
now() { date +%s%3N; }
S="$SOZVON_STATE_DIR"
case "$word" in
  check) sleep 0.3; printf '{"current":"aaa1111aaa1111aaa1111aaa1111aaa1111aaa1","latest":"bbb2222bbb2222bbb2222bbb2222bbb2222bbb2","behind":2,"notes":["bbb2222 Новая функция","ccc3333 Исправление"],"checkedAt":%s}' "$(now)" > "$S/update-check.json" ;;
  update) st=$(now); printf '{"state":"running","kind":"update","startedAt":%s,"from":"aaa1111"}' "$st" > "$S/update-status.json"; sleep "\${HELPER_UPDATE_DELAY:-0.5}"
    printf '{"state":"done","kind":"update","startedAt":%s,"finishedAt":%s,"from":"aaa1111","to":"bbb2222","exitCode":0}' "$st" "$(now)" > "$S/update-status.json" ;;
  backup) st=$(now); printf '{"state":"running","startedAt":%s}' "$st" > "$S/backup-run.json"; sleep 0.3
    printf '{"time":"%s","result":"ok","ok":true,"file":"astra-20261029-1200.tar.zst","size":1048576,"telegram":"выключено","error":""}' "$(date -Is)" > "$S/backup-status.json"
    printf '{"state":"done","startedAt":%s,"finishedAt":%s,"exitCode":0}' "$st" "$(now)" > "$S/backup-run.json" ;;
esac
`);
  await startFakeTelegram();
  await startAstra();
});

test.afterAll(async () => {
  for (const s of sockets) s.close();
  await stopAstra();
  tgServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('опрос постоянный; команды и кнопка меню; меню непривязанного чата; «Помощь» правит то же сообщение', async () => {
  await waitFor(() => bot().calls.some((c) => c.method === 'getUpdates') || null, { message: 'getUpdates без ожидающих запросов' });
  await waitFor(() => bot().commands.length && bot().menuButtons.length ? true : null, { message: 'setMyCommands + setChatMenuButton' });
  expect(bot().commands[0].commands.map((c) => c.command)).toEqual(['menu', 'help', 'cancel']);
  expect(bot().commands[0].commands[0].description).toBe('☰ Меню');
  expect(bot().menuButtons[0].menu_button).toEqual({ type: 'commands' });

  const stranger = 4440101;
  sendText(stranger, 'привет');
  sendText(stranger, '/start');
  const m = await nextMsg(stranger, 0, /Это бот Astra/);
  expect(m.text).toContain('Привязать Telegram');
  expect(sentTo(stranger).filter((x) => /Это бот Astra/.test(x.text))).toHaveLength(1); // «привет» — без ответа
  const open = btnBy(m, /Открыть Astra/);
  expect(open.url).toBe(PUBLIC);
  press(stranger, m, /Помощь/);
  const help = await waitView(m, /Бот Astra умеет/);
  expect(btnBy(help, /Назад/)).toBeTruthy();
  expect(sentTo(stranger)).toHaveLength(1); // навигация — правкой, без новых сообщений
});

test('привязка: галочка «вход без пароля», главное меню (2 колонки, широкие кнопки, цвет), навигация и «‹ Назад»', async () => {
  const u = await link(await register('v24menu'));
  await waitFor(() => dbUser(u.id).tgLogin === true || null, { message: 'tgLogin' });
  const menu = u.menu;
  expect(menu.text).toContain(`☰ Astra · ${u.username}`);
  const rows = menu.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text));
  expect(rows[0]).toEqual(['💬 Уведомления', '🔐 Безопасность']);
  expect(rows[1]).toEqual(['🎟 Пригласить друга']);
  expect(rows[2]).toEqual(['🌐 Открыть Astra', '❓ Помощь']);
  expect(rows.flat().some((t) => /Управление сервером/.test(t))).toBe(false);
  expect(btnBy(menu, /Пригласить/).style).toBe('primary');
  // /menu — новое сообщение; навигация — правки того же сообщения
  const n = sentTo(u.chat).length;
  sendText(u.chat, '/menu');
  const m2 = await nextMsg(u.chat, n, /^☰ Astra/);
  press(u.chat, m2, /Уведомления/);
  const nv = await waitView(m2, /Уведомления в Telegram/);
  expect(nv.text).toContain('✅ личные сообщения');
  expect(nv.text).toContain('▫️ @everyone');
  press(u.chat, nv, /Назад/);
  await waitView(m2, /^☰ Astra/);
  press(u.chat, view(m2), /Безопасность/);
  const sv = await waitView(m2, /Безопасность/);
  expect(sv.text).toContain('Вход без пароля через Telegram: включён');
  expect(sentTo(u.chat).length).toBe(n + 1);
  // привязка без галочки — вход без пароля выключен
  const u2 = await link(await register('v24nopw'), { passwordless: false });
  await waitFor(() => dbUser(u2.id).tgLogin === false || null, { message: 'tgLogin выкл' });
});

let alice, bob, srv, textCh;
test('уведомления: ЛС и упоминание → Telegram (не в Astra), ответ reply и кнопкой «↩️ Ответить», отказ по правам', async () => {
  alice = await link(await register('v24ali'));
  bob = await register('v24bob');
  const sb = await sock(bob);
  srv = (await ack(sb, 'server:create', { name: 'Друзья v24' })).server;
  textCh = srv.channels.find((c) => c.type === 'text');
  const sa = await sock(alice);
  expect((await ack(sa, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  // Alice в Astra на виду — в Telegram не дублируем
  sa.emit('client:view', { channelId: null, visible: true });
  const dm = (await ack(sb, 'dm:open', { userId: alice.id })).dm;
  let n = sentTo(alice.chat).length;
  await ack(sb, 'message:send', { channelId: dm.id, content: 'пока ты здесь' });
  await sleep(800);
  expect(sentTo(alice.chat).slice(n).filter((m) => /Личные сообщения/.test(m.text))).toHaveLength(0);
  sa.close();
  await sleep(300);
  // ЛС → Telegram
  n = sentTo(alice.chat).length;
  await ack(sb, 'message:send', { channelId: dm.id, content: 'Привет из Astra!' });
  const note = await nextMsg(alice.chat, n, /Личные сообщения/);
  expect(note.text.split('\n')[0]).toBe(`💬 Личные сообщения · ${bob.username}`);
  expect(note.text).toContain('Привет из Astra!');
  expect(btnBy(note, /Ответить/).callback_data).toMatch(/^rp:[A-Za-z0-9_-]{12}$/);
  expect(btnBy(note, /Открыть/).url).toBe(`${PUBLIC}/?c=${encodeURIComponent(dm.id)}`);
  // ответ reply → сообщение от Alice в ЛС
  const got = waitEvent(sb, 'message:new', (p) => p.message.channelId === dm.id && p.message.content === 'Ответ из Telegram');
  n = sentTo(alice.chat).length;
  sendText(alice.chat, 'Ответ из Telegram', { replyTo: note.message_id });
  const msg = await got;
  expect(msg.message.author.id).toBe(alice.id);
  expect((await nextMsg(alice.chat, n, /Отправлено/)).text).toBe(`✅ Отправлено: ЛС с ${bob.username}`);
  // фото в ответ — только текст
  n = sentTo(alice.chat).length;
  pushUpd(TOKEN, { message: { message_id: ++tgMsgSeq, chat: { id: alice.chat, type: 'private' }, from: { id: alice.chat, is_bot: false }, photo: [{ file_id: 'p1' }], reply_to_message: { message_id: note.message_id } } });
  await nextMsg(alice.chat, n, /только текстом/);

  // упоминание в канале → кнопка «↩️ Ответить» → следующее сообщение уходит в канал
  n = sentTo(alice.chat).length;
  await ack(sb, 'message:send', { channelId: textCh.id, content: `@${alice.username} глянь` });
  const mention = await nextMsg(alice.chat, n, /Друзья v24/);
  expect(mention.text.split('\n').slice(0, 3)).toEqual([`🔔 Друзья v24 · #${textCh.name}`, `${bob.username} упомянул(а) вас:`, `@${alice.username} глянь`]);
  press(alice.chat, mention, /Ответить/);
  await nextMsg(alice.chat, n, /Напишите ответ/);
  const got2 = waitEvent(sb, 'message:new', (p) => p.message.channelId === textCh.id && p.message.content === 'Иду!');
  n = sentTo(alice.chat).length;
  sendText(alice.chat, 'Иду!');
  await got2;
  expect((await nextMsg(alice.chat, n, /Отправлено/)).text).toBe(`✅ Отправлено: «Друзья v24» · #${textCh.name}`);

  // отказ по правам: запрет писать в канал для @everyone
  expect((await ack(sb, 'channel:update', { channelId: textCh.id, overwrites: { [srv.id]: { allow: 0, deny: 1 << 8 } } })).ok).toBe(true);
  n = sentTo(alice.chat).length;
  sendText(alice.chat, 'а теперь?', { replyTo: mention.message_id });
  expect((await nextMsg(alice.chat, n, /Не отправлено/)).text).toBe('⛔ Не отправлено: Нет права писать в этот канал');
  expect((await ack(sb, 'channel:update', { channelId: textCh.id, overwrites: {} })).ok).toBe(true);
  // подделанная кнопка ответа (чужой ref) — отказ
  const before = bot().answers.length;
  pressData(alice.chat, mention.message_id, 'rp:AAAAAAAAAAAA');
  expect((await lastAnswer(before)).text).toBe('Уведомление устарело — ответьте в Astra');
});

test('настройки уведомлений: переключатели в боте и в Astra, пауза, «Не беспокоить», @everyone', async () => {
  const sb = sockets.find((s) => s.connected && s.auth?.token === bob.token) || await sock(bob);
  const dm = (await ack(sb, 'dm:open', { userId: alice.id })).dm;
  const relayed = async (content, expectIt) => {
    const n = sentTo(alice.chat).length;
    await ack(sb, 'message:send', { channelId: dm.id, content });
    if (expectIt) return nextMsg(alice.chat, n, new RegExp(content));
    await sleep(700);
    expect(sentTo(alice.chat).slice(n).filter((m) => m.text.includes(content))).toHaveLength(0);
    return null;
  };
  // выключить ЛС кнопкой в боте
  let n = sentTo(alice.chat).length;
  sendText(alice.chat, '/menu');
  const menu = await nextMsg(alice.chat, n, /^☰ Astra/);
  press(alice.chat, menu, /Уведомления/);
  let v = await waitView(menu, /Уведомления в Telegram/);
  press(alice.chat, v, /ЛС/);
  v = await waitView(menu, /▫️ личные сообщения/);
  expect((await api('GET', '/api/me/telegram', { token: alice.token })).json.notify.dm).toBe(false);
  await relayed('тихое ЛС', false);
  // включить в Astra
  const p = await api('PATCH', '/api/me/telegram', { token: alice.token, body: { notify: { dm: true } } });
  expect(p.json).toMatchObject({ linked: true, notify: { dm: true, mention: true, everyone: false, onlyAway: true }, passwordless: true, bot: 'astra_v24_bot' });
  await relayed('громкое ЛС', true);
  // пауза 1 ч в боте → тишина; снять паузу
  press(alice.chat, v, /Пауза 1 ч/);
  v = await waitView(menu, /Пауза до/);
  await relayed('ЛС на паузе', false);
  press(alice.chat, v, /Снять паузу/);
  await waitFor(() => !/Пауза до/.test(view(menu).text) || null, { message: 'пауза снята' });
  // «Не беспокоить» — не пересылаем
  await api('PATCH', '/api/me', { token: alice.token, body: { status: 'dnd' } });
  await relayed('ЛС в DND', false);
  await api('PATCH', '/api/me', { token: alice.token, body: { status: 'online' } });
  await relayed('ЛС после DND', true);
  // @everyone по умолчанию выключен; включаем через API
  n = sentTo(alice.chat).length;
  await ack(sb, 'message:send', { channelId: textCh.id, content: '@everyone сбор' });
  await sleep(700);
  expect(sentTo(alice.chat).slice(n).filter((m) => m.text.includes('сбор'))).toHaveLength(0);
  await api('PATCH', '/api/me/telegram', { token: alice.token, body: { notify: { everyone: true } } });
  await ack(sb, 'message:send', { channelId: textCh.id, content: '@everyone второй сбор' });
  const ev = await nextMsg(alice.chat, n, /второй сбор/);
  expect(ev.text).toContain(`${bob.username} (@everyone):`);
  expect((await api('PATCH', '/api/me/telegram', { token: alice.token, body: { notify: 'x' } })).status).toBe(400);
});

test('сброс пароля: одинаковый ответ, ссылка во фрагменте, одноразовая, сеансы завершены; «Это не я»; из меню бота', async () => {
  const u = await link(await register('v24rst'));
  const plain = await register('v24plain');
  const r1 = await api('POST', '/api/password-reset/request', { body: { username: 'нет_такого_v24' } });
  const r2 = await api('POST', '/api/password-reset/request', { body: { username: plain.username } });
  const n = sentTo(u.chat).length;
  const r3 = await api('POST', '/api/password-reset/request', { body: { username: u.username } });
  expect(r1.status).toBe(200);
  expect(r2.json).toEqual(r1.json);
  expect(r3.json).toEqual(r1.json);
  const msg = await nextMsg(u.chat, n, /Сброс пароля Astra/);
  expect(msg.text).toContain('Firefox, Linux');
  const b = btnBy(msg, /Сброс пароля/);
  expect(b.style).toBe('primary');
  expect(b.url).toMatch(/^https:\/\/astra\.example\/reset-password#t=[A-Za-z0-9_-]{43}$/);
  expect(btnBy(msg, /Это не я/).callback_data).toMatch(/^rs:/);
  const token = b.url.split('#t=')[1];
  expect((await api('POST', '/api/password-reset/check', { body: { token } })).json).toEqual({ valid: true, username: u.username, needCode: false });
  expect((await api('POST', '/api/password-reset/check', { body: { token: 'x'.repeat(43) } })).json.code).toBe('reset_invalid');
  const done = await api('POST', '/api/password-reset/complete', { body: { token, password: 'newpass456' } });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect((await api('GET', '/api/me', { token: u.token })).status).toBe(401); // все сеансы завершены
  expect((await api('POST', '/api/password-reset/complete', { body: { token, password: 'again789' } })).json.code).toBe('reset_invalid');
  // Telegram привязан — это 2FA: новый пароль принят, второй шаг — код восстановления
  const login = await api('POST', '/api/login', { body: { username: u.username, password: 'newpass456' } });
  expect(login.json.twoFactor).toBe(true);
  const fin = await api('POST', '/api/login/2fa', { body: { challenge: login.json.challenge, code: u.recovery[0] } });
  expect(typeof fin.json.token).toBe('string');
  await nextMsg(u.chat, n, /Пароль Astra для .* изменён/);
  await waitFor(() => bot().edits.some((e) => e.message_id === msg.message_id && /Пароль изменён/.test(e.text)) || null, { message: 'правка ✅' });
  u.token = fin.json.token;
  u.password = 'newpass456';

  // «Это не я» — ссылка отменена
  await sleep(400);
  const n2 = sentTo(u.chat).length;
  await api('POST', '/api/password-reset/request', { body: { username: u.username } });
  const msg2 = await nextMsg(u.chat, n2, /Сброс пароля Astra/);
  const token2 = btnBy(msg2, /Сброс пароля/).url.split('#t=')[1];
  press(u.chat, msg2, /Это не я/);
  await waitFor(() => bot().edits.some((e) => e.message_id === msg2.message_id && /отменена/.test(e.text)) || null, { message: 'отмена' });
  expect((await api('POST', '/api/password-reset/check', { body: { token: token2 } })).json.code).toBe('reset_invalid');

  // из меню бота: «🔐 Безопасность» → «🔑 Сбросить пароль»
  await sleep(400);
  const n3 = sentTo(u.chat).length;
  sendText(u.chat, '/menu');
  const menu = await nextMsg(u.chat, n3, /^☰ Astra/);
  press(u.chat, menu, /Безопасность/);
  const sv = await waitView(menu, /Безопасность/);
  press(u.chat, sv, /Сбросить пароль/);
  const fromBot = await nextMsg(u.chat, n3, /Сброс пароля Astra/);
  expect(fromBot.text).toContain('Запрос из этого чата');

  // лимит запросов с одного адреса — 5 за 15 минут
  for (let i = 0; i < 5; i++) await api('POST', '/api/password-reset/request', { body: { username: 'x' + i }, ip: '198.51.100.24' });
  const lim = await api('POST', '/api/password-reset/request', { body: { username: 'x9' }, ip: '198.51.100.24' });
  expect(lim.status).toBe(429);
});

test('сброс пароля с приложением-аутентификатором: нужен код (TOTP или восстановления)', async () => {
  const u = await enableTotp(await link(await register('v24rtotp')));
  const n = sentTo(u.chat).length;
  await api('POST', '/api/password-reset/request', { body: { username: u.username } });
  const msg = await nextMsg(u.chat, n, /Сброс пароля Astra/);
  expect(msg.text).toContain('приложения-аутентификатора');
  const token = btnBy(msg, /Сброс пароля/).url.split('#t=')[1];
  expect((await api('POST', '/api/password-reset/check', { body: { token } })).json.needCode).toBe(true);
  expect((await api('POST', '/api/password-reset/complete', { body: { token, password: 'newpass456' } })).json.code).toBe('totp_required');
  expect((await api('POST', '/api/password-reset/complete', { body: { token, password: 'newpass456', code: '000000' } })).json.code).toBe('totp_invalid');
  const ok = await api('POST', '/api/password-reset/complete', { body: { token, password: 'newpass456', code: u.recovery[0] } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  const s1 = await api('POST', '/api/login', { body: { username: u.username, password: 'newpass456' } });
  expect(s1.json.twoFactor).toBe(true);
});

test('вход без пароля: только по включённой настройке, одинаковый ответ, «✅ Войти», TOTP всё равно, «Это не я»', async () => {
  const u = await link(await register('v24pwl'));
  const off = await link(await register('v24pwoff'), { passwordless: false });
  // неизвестный и выключенный — тот же ответ, сообщений нет
  const nOff = sentTo(off.chat).length;
  const a1 = await api('POST', '/api/login/telegram', { body: { username: 'нет_такого_v24' } });
  const a2 = await api('POST', '/api/login/telegram', { body: { username: off.username } });
  expect(Object.keys(a1.json).sort()).toEqual(['challenge', 'expiresAt']);
  expect(Object.keys(a2.json).sort()).toEqual(['challenge', 'expiresAt']);
  expect((await api('POST', '/api/login/telegram/status', { body: { challenge: a2.json.challenge } })).json).toEqual({ pending: true });
  await sleep(500);
  expect(sentTo(off.chat).slice(nOff).filter((m) => /без пароля/.test(m.text))).toHaveLength(0);

  const n = sentTo(u.chat).length;
  const s = await api('POST', '/api/login/telegram', { body: { username: u.username }, ip: '89.108.11.22' });
  const msg = await nextMsg(u.chat, n, /Вход в Astra без пароля/);
  expect(msg.text).toContain('89.108.*.*');
  expect(msg.text).not.toContain('11.22');
  expect(allButtons(msg.reply_markup).map((b) => [b.text, b.style])).toEqual([['✅ Войти', 'success'], ['⛔ Это не я', 'danger']]);
  expect((await api('POST', '/api/login/telegram/status', { body: { challenge: s.json.challenge } })).json).toEqual({ pending: true });
  // нажатие из чужого чата — не принимается
  press(u.chat, msg, /Войти/, { fromChat: 4449998 });
  await sleep(600);
  expect((await api('POST', '/api/login/telegram/status', { body: { challenge: s.json.challenge } })).json).toEqual({ pending: true });
  press(u.chat, msg, /Войти/);
  const done = await waitFor(async () => { const r = await api('POST', '/api/login/telegram/status', { body: { challenge: s.json.challenge } }); return r.json.token ? r.json : null; }, { message: 'вход' });
  expect(done.user.username).toBe(u.username);
  expect((await api('POST', '/api/login/telegram/status', { body: { challenge: s.json.challenge } })).json.code).toBe('challenge_invalid'); // одноразово

  // с приложением-аутентификатором: после «✅ Войти» — второй шаг с кодом
  u.token = done.token;
  await enableTotp(u);
  await sleep(400);
  const n2 = sentTo(u.chat).length;
  const s2 = await api('POST', '/api/login/telegram', { body: { username: u.username } });
  const msg2 = await nextMsg(u.chat, n2, /без пароля/);
  press(u.chat, msg2, /Войти/);
  const step = await waitFor(async () => { const r = await api('POST', '/api/login/telegram/status', { body: { challenge: s2.json.challenge } }); return r.json.twoFactor ? r.json : null; }, { message: 'второй шаг' });
  expect(step.methods).toEqual(['totp', 'recovery']);
  expect(step.token).toBeUndefined();
  const fin = await api('POST', '/api/login/2fa', { body: { challenge: step.challenge, code: totpNow(u.secret, 1) } });
  expect(fin.status, JSON.stringify(fin.json)).toBe(200);

  // «Это не я»: отказ, блокировка Telegram-входа на 15 минут, событие в журнале
  await sleep(400);
  const n3 = sentTo(u.chat).length;
  const s3 = await api('POST', '/api/login/telegram', { body: { username: u.username } });
  const msg3 = await nextMsg(u.chat, n3, /без пароля/);
  press(u.chat, msg3, /Это не я/);
  const den = await waitFor(async () => { const r = await api('POST', '/api/login/telegram/status', { body: { challenge: s3.json.challenge } }); return r.status === 401 ? r : null; }, { message: 'отказ' });
  expect(den.json.code).toBe('challenge_denied');
  await nextMsg(u.chat, n3, /Пароль при этом не вводился/);
  await waitFor(() => dbUser(u.id).tgLockUntil > Date.now() || null, { message: 'tgLockUntil сохранён' });
  const n4 = sentTo(u.chat).length;
  await api('POST', '/api/login/telegram', { body: { username: u.username } });
  await sleep(600);
  expect(sentTo(u.chat).slice(n4).filter((m) => /без пароля/.test(m.text))).toHaveLength(0);
  const audit = fs.readFileSync(path.join(astra.dataDir, 'admin-audit.jsonl'), 'utf8');
  expect(audit).toContain('security.tg_pwless_denied');

  // включить из бота нельзя, выключить — можно; в Astra включение — только с паролем
  const p = await link(await register('v24pwtog'));
  const n5 = sentTo(p.chat).length;
  sendText(p.chat, '/menu');
  const menu = await nextMsg(p.chat, n5, /^☰ Astra/);
  press(p.chat, menu, /Безопасность/);
  const sv = await waitView(menu, /Безопасность/);
  press(p.chat, sv, /Выключить вход без пароля/);
  await waitView(menu, /Вход без пароля через Telegram: выключен/);
  expect(btnBy(view(menu), /как включить/)).toBeTruthy();
  await waitFor(() => dbUser(p.id).tgLogin === false || null, { message: 'tgLogin выкл' });
  expect((await api('PATCH', '/api/me/telegram', { token: p.token, body: { passwordless: true } })).status).toBe(400);
  expect((await api('PATCH', '/api/me/telegram', { token: p.token, body: { passwordless: true, password: p.password } })).json.passwordless).toBe(true);
});

test('приглашение: список серверов с правом, ссылка /invite/<код>, «Поделиться»; чужой сервер — отказ', async () => {
  const n = sentTo(alice.chat).length;
  sendText(alice.chat, '/menu');
  const menu = await nextMsg(alice.chat, n, /^☰ Astra/);
  press(alice.chat, menu, /Пригласить/);
  const list = await waitView(menu, /Выберите сервер/);
  press(alice.chat, list, /Друзья v24/);
  const inv = await waitView(menu, /Приглашение на «Друзья v24»/);
  expect(inv.text).toContain(`Ссылка: ${PUBLIC}/invite/${srv.inviteCode}`);
  const share = btnBy(inv, /Поделиться/).url;
  expect(share.startsWith('https://t.me/share/url?url=')).toBe(true);
  expect(decodeURIComponent(share)).toContain(`${PUBLIC}/invite/${srv.inviteCode}`);
  // подделанная кнопка: сервер, где Alice не участник
  const carol = await register('v24car');
  const sc = await sock(carol);
  const other = (await ack(sc, 'server:create', { name: 'Чужой' })).server;
  const before = bot().answers.length;
  pressData(alice.chat, menu.message_id, `iv:${other.id}`);
  expect((await lastAnswer(before)).text).toBe('Нет доступа к этому серверу');
  expect(view(menu).text).not.toContain(other.inviteCode);
  const r = await fetch(`${A}/invite/${srv.inviteCode}`, { redirect: 'manual' });
  expect(r.status).toBe(302);
  expect(r.headers.get('location')).toBe(`/?invite=${srv.inviteCode}`);
});

let boss;
test('«Управление сервером»: только администратору; подделка кнопок и команд отклоняется; состояние без секретов', async () => {
  // не администратор: кнопки нет, подделанные callback и /status — отказ
  const before = bot().answers.length;
  pressData(alice.chat, alice.menu.message_id, 'as');
  expect((await lastAnswer(before)).text).toBe('Недоступно');
  let n = sentTo(alice.chat).length;
  sendText(alice.chat, '/status');
  expect((await nextMsg(alice.chat, n, /недоступна/)).text).toBe('Команда недоступна.');
  await sleep(300);
  expect(sentTo(alice.chat).slice(n).some((m) => /Состояние Astra/.test(m.text))).toBe(false);

  boss = await link(await register('v24boss', 'v24boss'));
  expect(btnBy(boss.menu, /Управление сервером/)).toBeTruthy();
  await waitFor(() => bot().commands.some((c) => c.scope?.chat_id === boss.chat && c.commands.some((x) => x.command === 'status')) || null, { message: 'команды администратора в его чате' });
  press(boss.chat, boss.menu, /Управление сервером/);
  const adm = await waitView(boss.menu, /Управление сервером/);
  press(boss.chat, adm, /Состояние/);
  const st = await waitView(boss.menu, /📊 Состояние Astra/, 20000);
  for (const re of [/Версия:/, /RAM/, /В сети:/, /VPN-прокси:/, /Cookies YouTube:/, /Бэкап:/]) expect(st.text).toMatch(re);
  for (const secret of [PROXY_SECRET, TOKEN, 'TEST_tgbot_SECRET', String(boss.chat)]) expect(st.text).not.toContain(secret);
  n = sentTo(boss.chat).length;
  sendText(boss.chat, '/vpn');
  await nextMsg(boss.chat, n, /VPN-прокси/, { timeout: 15000 });
  const audit = fs.readFileSync(path.join(astra.dataDir, 'admin-audit.jsonl'), 'utf8');
  expect(audit).toContain('"action":"tgbot.status"');
  expect(audit).toContain('"action":"tgbot.vpn_check"');
  expect(audit).not.toContain(String(boss.chat));
});

test('обновление и бэкап: файл-запрос с фиксированным словом, подтверждение, итог приходит и после перезапуска', async () => {
  const reqs = () => fs.readdirSync(tmp).filter((f) => f.startsWith('helper-req.')).sort().map((f) => fs.readFileSync(path.join(tmp, f), 'utf8'));
  let n = sentTo(boss.chat).length;
  sendText(boss.chat, '/update');
  const upd = await nextMsg(boss.chat, n, /Проверяю обновления|Доступно новых/);
  const ready = await waitView(upd, /Доступно новых коммитов: 2/);
  expect(ready.text).toContain('bbb2222 Новая функция');
  expect(reqs()).toEqual(['check\n']);
  press(boss.chat, ready, /Обновить/);
  await waitView(upd, /Обновление запущено/);
  await waitFor(() => reqs().length === 2 || null, { message: 'запрос update' });
  expect(reqs()[1]).toBe('update\n');
  // сервер перезапускается во время обновления: итог досылает новый процесс (DATA_DIR/telegram-bot.json)
  await stopAstra();
  expect(JSON.parse(fs.readFileSync(path.join(astra.dataDir, 'telegram-bot.json'), 'utf8')).pending).toHaveLength(1);
  await startAstra();
  const fin = await nextMsg(boss.chat, n, /Обновлено до/, { timeout: 15000 });
  expect(fin.text).toBe('✅ Обновлено до bbb2222 (было aaa1111). Astra перезапущена.');
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(astra.dataDir, 'telegram-bot.json'), 'utf8')).pending.length === 0 || null, { message: 'ожидание снято' });

  n = sentTo(boss.chat).length;
  sendText(boss.chat, '/backup');
  const bk = await nextMsg(boss.chat, n, /Сделать резервную копию/);
  expect(reqs()).toHaveLength(2); // без подтверждения — ничего не запущено
  press(boss.chat, bk, /Сделать бэкап/);
  const res = await nextMsg(boss.chat, n, /Бэкап готов/, { timeout: 15000 });
  expect(res.text).toContain('astra-20261029-1200.tar.zst');
  expect(reqs()[2]).toBe('backup\n');
  for (const r of reqs()) expect(['check\n', 'update\n', 'backup\n']).toContain(r);
  const audit = fs.readFileSync(path.join(astra.dataDir, 'admin-audit.jsonl'), 'utf8');
  for (const a of ['tgbot.update_check', 'tgbot.update', 'tgbot.backup']) expect(audit).toContain(`"action":"${a}"`);
});

test('deploy/self-update.sh: слово backup запускает backup.sh now, итог в backup-run.json; мусор в запросе игнорируется', async () => {
  const dir = path.join(tmp, 'su');
  const dataDir = path.join(dir, 'data');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(dataDir, { recursive: true });
  const fakeBackup = writeExec(path.join(dir, 'fake-backup.sh'), `#!/usr/bin/env bash
echo "args: $*" >> "${dir}/backup-args.log"
printf '{"time":"%s","result":"ok","ok":true,"file":"astra-x.tar.zst","size":10}' "$(date -Is)" > "$SOZVON_STATE_DIR/backup-status.json"
`);
  const env = { ...process.env, SELF_UPDATE_ALLOW_NONROOT: '1', DATA_DIR: dataDir, APP_DIR: dir, STATE_DIR: stateDir, SELF_UPDATE_LOCK: path.join(dir, 'lock'), SELF_UPDATE_CMD: '/bin/false', SELF_UPDATE_BACKUP_CMD: fakeBackup };
  fs.writeFileSync(path.join(dataDir, 'update-request'), 'backup\n');
  const r = spawnSync('bash', [path.join(ROOT, 'deploy', 'self-update.sh')], { env, encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(fs.readFileSync(path.join(dir, 'backup-args.log'), 'utf8').trim()).toBe('args: now');
  expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'backup-run.json'), 'utf8'))).toMatchObject({ state: 'done', exitCode: 0 });
  expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'backup-status.json'), 'utf8')).file).toBe('astra-x.tar.zst');
  expect(fs.existsSync(path.join(dataDir, 'update-request'))).toBe(false);
  // «backup; touch …» — не слово backup: ничего не запускается
  const marker = path.join(dir, 'pwned');
  fs.rmSync(path.join(dir, 'backup-args.log'));
  fs.writeFileSync(path.join(dataDir, 'update-request'), `backup; touch ${marker}\n$(touch ${marker})`);
  const r2 = spawnSync('bash', [path.join(ROOT, 'deploy', 'self-update.sh')], { env, encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout).toContain('Неизвестный запрос');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path.join(dir, 'backup-args.log'))).toBe(false);
});

test('cookies YouTube файлом: проверка, запись 600, проба yt-dlp, удаление сообщения; неверный и большой файлы отклоняются', async () => {
  const st = bot();
  st.files.good = { content: Buffer.from(GOOD_COOKIES) };
  st.files.nosapi = { content: Buffer.from('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tPREF\tf1=1\n') };
  st.files.notcookies = { content: Buffer.from('hello world, not cookies') };
  st.files.liar = { content: Buffer.alloc(1100 * 1024, 65), declared: 100 }; // getFile врёт о размере
  st.files.badprobe = { content: Buffer.from(GOOD_COOKIES + '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tBADPROBE\t1\n') };
  const target = path.join(astra.dataDir, 'cookies.txt');

  // через кнопку «🍪 Загрузить cookies»
  let n = sentTo(boss.chat).length;
  sendText(boss.chat, '/menu');
  const menu = await nextMsg(boss.chat, n, /^☰ Astra/);
  press(boss.chat, menu, /Управление сервером/);
  press(boss.chat, await waitView(menu, /Управление сервером/), /Cookies/);
  const ck = await waitView(menu, /Cookies YouTube/);
  expect(ck.text).toContain('Файла нет');
  press(boss.chat, ck, /Загрузить cookies/);
  await waitView(menu, /Отправьте файл cookies.txt/);
  const doc = sendDoc(boss.chat, 'good', { size: GOOD_COOKIES.length });
  const ok = await nextMsg(boss.chat, n, /Cookies обновлены, YouTube работает/, { timeout: 20000 });
  expect(ok.text).toContain(target);
  expect(fs.readFileSync(target, 'utf8')).toBe(GOOD_COOKIES);
  expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  await waitFor(() => st.deleted.some((d) => d.message_id === doc.message_id && Number(d.chat_id) === boss.chat) || null, { message: 'deleteMessage' });

  // без кнопки: документ с «cookie» в имени от администратора
  n = sentTo(boss.chat).length;
  sendDoc(boss.chat, 'nosapi', { name: 'cookies (1).txt' });
  expect((await nextMsg(boss.chat, n, /Файл не принят/)).text).toContain('SAPISID');
  sendDoc(boss.chat, 'notcookies', { name: 'my-cookies.txt' });
  await nextMsg(boss.chat, n, /не cookies.txt в формате Netscape/);
  const getFileBefore = st.getFile.length;
  sendDoc(boss.chat, 'good', { name: 'cookies.txt', size: 2 * 1024 * 1024 });
  await nextMsg(boss.chat, n, /больше 1 МБ/);
  expect(st.getFile.length).toBe(getFileBefore); // слишком большой — даже не скачиваем
  sendDoc(boss.chat, 'liar', { name: 'cookies.txt' });
  await waitFor(() => sentTo(boss.chat).slice(n).filter((m) => /больше 1 МБ/.test(m.text)).length === 2 || null, { message: 'обрыв скачивания > 1 МБ' });
  expect(fs.readFileSync(target, 'utf8')).toBe(GOOD_COOKIES); // плохие файлы не записаны
  sendDoc(boss.chat, 'badprobe', { name: 'cookies.txt' });
  const warn = await nextMsg(boss.chat, n, /проверка YouTube не прошла/, { timeout: 20000 });
  expect(warn.text).toContain('не бот');
  // не администратор — документ не принимается
  const n2 = sentTo(alice.chat).length;
  sendDoc(alice.chat, 'good', { name: 'cookies.txt' });
  await nextMsg(alice.chat, n2, /только текст/);
  const audit = fs.readFileSync(path.join(astra.dataDir, 'admin-audit.jsonl'), 'utf8');
  expect(audit).toContain('"action":"tgbot.cookies_upload"');
  expect(audit).not.toContain('secretsid');
  // состояние учитывает файл cookies из DATA_DIR
  n = sentTo(boss.chat).length;
  sendText(boss.chat, '/status');
  const first = await nextMsg(boss.chat, n, /Собираю состояние|Состояние Astra/);
  const s = await waitView(first, /📊 Состояние Astra/, 20000);
  expect(s.text).toMatch(/Cookies YouTube: 0 дн\./);
});

test('новые пользователи: регистрация и вход на сервер — одно сообщение администратору; переключатель', async () => {
  const n = sentTo(boss.chat).length;
  const newbie = await register('v24new');
  const sn = await sock(newbie);
  expect((await ack(sn, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const m = await nextMsg(boss.chat, n, /Новый пользователь/);
  expect(m.text).toBe(`🆕 Новый пользователь\n• @${newbie.username} — зарегистрировался и зашёл на «Друзья v24» по приглашению`);
  // выключить в меню
  const n2 = sentTo(boss.chat).length;
  sendText(boss.chat, '/menu');
  const menu = await nextMsg(boss.chat, n2, /^☰ Astra/);
  press(boss.chat, menu, /Управление сервером/);
  const adm = await waitView(menu, /Управление сервером/);
  press(boss.chat, adm, /Новые: вкл/);
  await waitFor(() => btnBy(view(menu), /Новые: выкл/) || null, { message: 'выкл' });
  await register('v24new2');
  await sleep(1500);
  expect(sentTo(boss.chat).slice(n2).filter((x) => /Новый пользователь/.test(x.text))).toHaveLength(0);
});

test('deploy/backup.sh telegram-chat-id: при работающем сервере chat id — через admin.sock, без getUpdates', async () => {
  test.skip(!isRoot, 'backup.sh работает только от root');
  const chat = 5550042;
  sendText(chat, '/start', { username: 'owner_tg' });
  await nextMsg(chat, 0, /Это бот Astra/);
  const env = {
    ...process.env, DATA_DIR: astra.dataDir, SOZVON_ENV_FILE: path.join(tmp, 'no-such.env'), BACKUP_TELEGRAM_TOKEN: TOKEN,
    BACKUP_TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`, TELEGRAM_PROXY: 'off', BACKUP_CHAT_WAIT: '2', BACKUP_DIR: path.join(tmp, 'bk'),
  };
  const curlCalls = () => bot().calls.filter((c) => /curl/i.test(c.ua) && c.method === 'getUpdates').length;
  // асинхронно: фейковый Telegram живёт в этом же процессе (spawnSync заблокировал бы его)
  const run = (e) => new Promise((resolve) => {
    const p = spawn('bash', [path.join(ROOT, 'deploy', 'backup.sh'), 'telegram-chat-id'], { env: e });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const r = await run(env);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout.trim().split('\n').at(-1)).toBe(String(chat));
  expect(r.stderr).toContain('без getUpdates');
  expect(curlCalls()).toBe(0);
  // другой бот — сервер его не опрашивает: getUpdates можно
  pushUpd(OTHER_TOKEN, { message: { message_id: 1, chat: { id: 6660042, type: 'private' }, from: { id: 6660042 }, text: '/start' } });
  const r2 = await run({ ...env, BACKUP_TELEGRAM_TOKEN: OTHER_TOKEN });
  expect(r2.status, r2.stdout + r2.stderr).toBe(0);
  expect(r2.stdout.trim().split('\n').at(-1)).toBe('6660042');
  expect(bot(OTHER_TOKEN).calls.filter((c) => c.method === 'getUpdates' && /curl/i.test(c.ua))).toHaveLength(1);
  expect(curlCalls()).toBe(0);
});

test('интерфейс: «Войти через Telegram», «Забыли пароль?», страница сброса, «Уведомления → Telegram»', async ({ page, browser }) => {
  const u = await link(await register('v24ui'));
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto(A);
  if (await page.locator('#auth-toggle').innerText() === 'Войти') await page.locator('#auth-toggle').click();
  await expect(page.locator('#auth-alt')).toBeVisible();
  // вход без пароля
  await page.locator('#auth-tg-login').click();
  await expect(page.locator('#auth-tglogin-form')).toBeVisible();
  await page.locator('#auth-tglogin-username').fill(u.username);
  let n = sentTo(u.chat).length;
  await page.locator('#auth-tglogin-submit').click();
  await expect(page.locator('#auth-tglogin-status')).toContainText('«✅ Войти»');
  await page.screenshot({ path: path.join(ROOT, 'tests', '.results', 'v24-login-telegram.png') });
  const msg = await nextMsg(u.chat, n, /без пароля/);
  press(u.chat, msg, /Войти/);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  // настройки: «Уведомления» → «Telegram»
  const panel = await openSection(page, 'notifications');
  const box = panel.locator('#settings-telegram');
  await expect(box.locator('#tg-settings-status')).toHaveAttribute('data-state', 'linked');
  await expect(box.locator('#tg-notify-dm')).toBeChecked();
  await box.locator('#tg-notify-dm').click({ force: true });
  await waitFor(() => dbUser(u.id).tgNotify?.dm === false || null, { message: 'dm выкл' });
  await expect(box.locator('#tg-passwordless')).toBeChecked();
  await page.screenshot({ path: path.join(ROOT, 'tests', '.results', 'v24-settings-telegram.png') });

  // «Забыли пароль?» → ссылка из бота → страница сброса
  const ctx = await browser.newContext({ viewport: { width: 390, height: 820 } });
  const p2 = await ctx.newPage();
  await p2.goto(A);
  if (await p2.locator('#auth-toggle').innerText() === 'Войти') await p2.locator('#auth-toggle').click();
  await p2.locator('#auth-forgot').click();
  await p2.locator('#auth-forgot-username').fill(u.username);
  await sleep(400);
  n = sentTo(u.chat).length;
  await p2.locator('#auth-forgot-submit').click();
  await expect(p2.locator('#auth-forgot-status')).toContainText('Если такой аккаунт есть');
  const rm = await nextMsg(u.chat, n, /Сброс пароля Astra/);
  const url = btnBy(rm, /Сброс пароля/).url.replace(PUBLIC, A);
  await p2.goto(url);
  await expect(p2.locator('#reset-form')).toBeVisible();
  expect(new URL(p2.url()).hash).toBe(''); // токен убран из адресной строки
  await expect(p2.locator('#reset-subtitle')).toContainText(u.username);
  await p2.locator('#reset-password').fill('brandnew1');
  await p2.locator('#reset-password2').fill('brandnew1');
  await p2.screenshot({ path: path.join(ROOT, 'tests', '.results', 'v24-reset-password.png') });
  await p2.locator('#reset-submit').click();
  await expect(p2.locator('#reset-title')).toHaveText('Пароль изменён');
  await ctx.close();
  // сеанс первой вкладки завершён
  await waitFor(async () => (await api('POST', '/api/login', { body: { username: u.username, password: 'brandnew1' } })).json.twoFactor || null, { message: 'новый пароль' });
});

test('цветные кнопки: Bot API отвергает style → повтор без него и запоминание; токен и chat id не в журналах', async () => {
  bot().rejectStyle = true;
  const n = sentTo(alice.chat).length;
  sendText(alice.chat, '/menu');
  const m = await nextMsg(alice.chat, n, /^☰ Astra/);
  expect(JSON.stringify(m.reply_markup)).not.toContain('"style"');
  expect(bot().styleRejections).toBe(1);
  sendText(alice.chat, '/menu');
  await waitFor(() => sentTo(alice.chat).slice(n).filter((x) => /^☰ Astra/.test(x.text)).length === 2 || null, { message: 'второе меню' });
  expect(bot().styleRejections).toBe(1); // больше не пробуем
  expect(astra.logs).toContain('не принимает цветные кнопки');
  bot().rejectStyle = false;
  for (const secret of [TOKEN, 'TEST_tgbot_SECRET', PROXY_SECRET]) {
    expect(astra.logs).not.toContain(secret);
    expect(responses.join('\n')).not.toContain(secret);
  }
  for (const u of [alice, boss]) expect(astra.logs).not.toContain(String(u.chat));
});
