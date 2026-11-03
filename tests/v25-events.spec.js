// v25: «События сервера» (server/schedule-events.js, public/js/ui/events.js): создание и лимиты, RSVP вживую
// у другого участника, права на изменение/удаление, напоминания (in-app, «Входящие», Telegram с «Подключиться»),
// уборка прошедших, сохранение и отсутствие дублей после перезапуска сервера.
// Свой экземпляр Astra (как в v24) с ускоренными часами событий (SOZVON_TEST_HOOKS=1: тик 0,5 с, напоминание
// за 15 с, удаление через 30 с после начала) и фейковым Telegram Bot API.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PORT as QA_PORT, ROOT } from './fixtures/env.js';
import { httpAt, connect, connected, ack, waitFor, waitEvent, sleep, uniqueName } from './fixtures/api.js';

test.describe.configure({ mode: 'serial' });

const A_PORT = QA_PORT + 75;
const TG_PORT = QA_PORT + 76;
const A = `http://127.0.0.1:${A_PORT}`;
const PUBLIC = 'https://astra.example';
const TOKEN = '888025:TEST_events_SECRET_aaaaaaaaaaaaaaaaaaa';
const REMIND_MS = 15_000;
const RESULTS = path.join(ROOT, 'tests', '.results');

let tmp;
let astra = null;
const sockets = [];

/* ---------------- фейковый Telegram Bot API (как в v24, только нужное) ---------------- */
const tg = { updates: [], nextUpdate: 1, sent: [], msgId: 1000 };
let tgServer;
function startFakeTelegram() {
  tgServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) { res.statusCode = 404; return res.end('{"ok":false}'); }
      const method = m[2];
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const reply = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return reply({ id: 888, is_bot: true, first_name: 'Astra', username: 'astra_v25_bot' });
      if (method === 'sendMessage') {
        const msg = { message_id: ++tg.msgId, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text, reply_markup: body.reply_markup, at: Date.now() };
        tg.sent.push(msg);
        return reply(msg);
      }
      if (method === 'editMessageText') return reply({ message_id: body.message_id, text: body.text });
      if (method === 'getUpdates') {
        const offset = Number(body.offset) || 0;
        tg.updates = tg.updates.filter((u) => u.update_id >= offset);
        const until = Date.now() + 700;
        while (!tg.updates.length && Date.now() < until) await sleep(40);
        return reply(tg.updates.slice());
      }
      return reply(true);
    });
  });
  return new Promise((r) => tgServer.listen(TG_PORT, '127.0.0.1', r));
}
let tgMsgSeq = 1;
function sendText(chatId, text) {
  const message = { message_id: ++tgMsgSeq, date: 0, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Тест' } };
  tg.updates.push({ update_id: tg.nextUpdate++, message });
}
const sentTo = (chatId) => tg.sent.filter((m) => m.chat.id === chatId);
const buttons = (msg) => (msg?.reply_markup?.inline_keyboard || []).flat();

/* ---------------- Astra ---------------- */
async function startAstra() {
  const dataDir = path.join(tmp, 'A');
  fs.mkdirSync(dataDir, { recursive: true });
  const s = { dataDir, logs: '' };
  s.child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(A_PORT), HOST: '127.0.0.1', HTTPS: '0', SFU: '0', DATA_DIR: dataDir,
      TRUST_PROXY: '1', ALERT_INTERVAL_MS: '0', PUBLIC_URL: PUBLIC,
      TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`, TELEGRAM_PROXY: 'off',
      SOZVON_TEST_HOOKS: '1', EVENTS_TICK_MS: '500', EVENTS_REMIND_MIN: String(REMIND_MS / 60_000), EVENTS_KEEP_MIN: '0.5',
      YTDLP_PATH: path.join(tmp, 'no-yt-dlp'), ADMIN_CERT_FILE: '', SPOTIFY_PROXY: '', YTDLP_COOKIES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.child.stdout.on('data', (d) => { s.logs += d; });
  s.child.stderr.on('data', (d) => { s.logs += d; });
  astra = s;
  await waitFor(async () => (await httpAt(A, 'GET', '/api/config').catch(() => ({}))).status === 200, { timeout: 40000, message: 'Astra up' })
    .catch((e) => { throw new Error(e.message + '\n' + s.logs); });
  return s;
}
async function stopAstra() {
  if (!astra || astra.child.exitCode !== null) return;
  for (const s of sockets.splice(0)) s.close();
  astra.child.kill('SIGTERM');
  await new Promise((r) => (astra.child.exitCode !== null ? r() : astra.child.once('exit', r)));
}

let ipSeq = 0;
const api = (method, url, { token, body } = {}) => httpAt(A, method, url, { token, body, headers: { 'X-Forwarded-For': `10.25.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}` } });
async function register(prefix) {
  const username = uniqueName(prefix).slice(0, 20);
  const r = await api('POST', '/api/register', { body: { username, password: 'secret123' } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { username, password: 'secret123', token: r.json.token, id: r.json.user.id };
}
async function sock(u) { const s = await connected(connect(u.token, { base: A })); sockets.push(s); u.s = s; return s; }
async function user(prefix) { const u = await register(prefix); await sock(u); return u; }
let chatSeq = 7790000;
async function linkTg(u) {
  u.chat = ++chatSeq;
  const l = await api('POST', '/api/me/2fa/telegram/link', { token: u.token, body: { password: u.password } });
  expect(l.status, JSON.stringify(l.json)).toBe(200);
  sendText(u.chat, `/start ${new URL(l.json.link).searchParams.get('start')}`);
  await waitFor(async () => (await api('GET', '/api/me/2fa/telegram/link', { token: u.token })).json.linked || null, { message: 'привязка Telegram' });
  return u;
}
const readDb = () => JSON.parse(fs.readFileSync(path.join(astra.dataDir, 'db.json'), 'utf8'));
/** db.json пишется с задержкой ~300 мс — ждём нужного состояния */
const dbWait = (fn, message = 'db.json') => waitFor(() => { try { return fn(readDb()); } catch { return null; } }, { message });
const okAck = async (s, ev, p) => { const r = await ack(s, ev, p); expect(r.ok, JSON.stringify(r)).toBe(true); return r; };
const failAck = async (s, ev, p, re) => { const r = await ack(s, ev, p); expect(r.ok, JSON.stringify(r)).toBe(false); if (re) expect(r.error).toMatch(re); return r; };

/** Страница Astra под пользователем (токен в localStorage) */
async function openPage(browser, u, { viewport = { width: 1280, height: 860 }, timezoneId } = {}) {
  const ctx = await browser.newContext({ viewport, timezoneId, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(A);
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), u.token);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  page.ctx = ctx;
  return page;
}

async function selectSrv(p, id, name) {
  await expect.poll(() => p.evaluate((sid) => window.__sozvon.state.servers.some((s) => s.id === sid), id)).toBe(true);
  await p.evaluate((sid) => { if (window.__sozvon.state.currentServerId !== sid) document.querySelector(`[data-server-id="${sid}"]`)?.click(); }, id);
  await expect(p.locator('#server-name')).toHaveText(name);
}

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-v25-'));
  fs.mkdirSync(RESULTS, { recursive: true });
  await startFakeTelegram();
  await startAstra();
});

test.afterAll(async () => {
  await stopAstra();
  tgServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let alice, bob, srv, voice, text;
test('создание: поля, валидация, живая рассылка, лимиты (50 предстоящих, частота)', async () => {
  alice = await user('v25ali');
  bob = await user('v25bob');
  srv = (await okAck(alice.s, 'server:create', { name: 'Друзья v25' })).server;
  voice = srv.channels.find((c) => c.type === 'voice');
  text = srv.channels.find((c) => c.type === 'text');
  await okAck(bob.s, 'server:join', { inviteCode: srv.inviteCode });

  const startAt = Date.now() + 3 * 3600_000;
  const live = waitEvent(bob.s, 'sevent:upsert', (d) => d.event?.title === 'Катка');
  const { event } = await okAck(alice.s, 'sevent:create', { serverId: srv.id, title: '  Катка  ', description: 'CS2, 5 на 5\nберём пиццу', startAt, channelId: voice.id, tz: 'Europe/Moscow' });
  expect(event).toMatchObject({ title: 'Катка', description: 'CS2, 5 на 5\nберём пиццу', startAt, channelId: voice.id, channelName: voice.name, authorId: alice.id, me: 'going', canManage: true });
  expect(event.rsvp.going).toEqual([alice.id]);
  const seen = (await live).event;
  expect(seen).toMatchObject({ id: event.id, me: null, canManage: false, channelId: voice.id });
  // хранится в UTC (мс), часовой пояс автора запомнен
  expect((await dbWait((d) => d.scheduledEvents?.find((e) => e.id === event.id))).startAt).toBe(startAt);
  await waitFor(() => readDb().users.find((u) => u.id === alice.id).tz === 'Europe/Moscow' || null, { message: 'tz' });
  // список и бутстрап
  expect((await okAck(bob.s, 'sevent:list', { serverId: srv.id })).events.map((e) => e.id)).toEqual([event.id]);
  expect((await okAck(bob.s, 'bootstrap')).scheduledEvents.map((e) => e.id)).toContain(event.id);

  // валидация
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: '   ', startAt }, /пустым/);
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'x'.repeat(101), startAt }, /максимум 100/);
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'ok', description: 'x'.repeat(1001), startAt }, /максимум 1000/);
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'ok', startAt: Date.now() - 3600_000 }, /прошло/);
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'ok', startAt: Date.now() + 400 * 86400_000 }, /год/);
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'ok', startAt: 'завтра' }, /дату/);
  await failAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'ok', startAt, channelId: text.id }, /Голосовой канал/);
  const stranger = await user('v25str');
  await failAck(stranger.s, 'sevent:create', { serverId: srv.id, title: 'чужой', startAt }, /не найден/);
  await failAck(stranger.s, 'sevent:rsvp', { eventId: event.id, status: 'going' }, /не найдено/);
  await failAck(bob.s, 'sevent:rsvp', { eventId: event.id, status: 'yes' }, /Иду/);

  // лимиты на отдельном сервере: частота (30 правок за 10 мин на человека) и 50 предстоящих событий
  const lim = await user('v25lim');
  const s2 = (await okAck(lim.s, 'server:create', { name: 'Лимиты v25' })).server;
  const carl = await user('v25carl');
  await okAck(carl.s, 'server:join', { inviteCode: s2.inviteCode });
  for (let i = 0; i < 30; i++) await okAck(lim.s, 'sevent:create', { serverId: s2.id, title: `Событие ${i}`, startAt: startAt + i * 60_000 });
  await failAck(lim.s, 'sevent:create', { serverId: s2.id, title: 'лишнее', startAt }, /Слишком часто/);
  for (let i = 0; i < 20; i++) await okAck(carl.s, 'sevent:create', { serverId: s2.id, title: `Карл ${i}`, startAt: startAt + i * 60_000 });
  await failAck(carl.s, 'sevent:create', { serverId: s2.id, title: 'пятьдесят первое', startAt }, /50 предстоящих/);
  expect((await okAck(carl.s, 'sevent:list', { serverId: s2.id })).events).toHaveLength(50);
});

test('права: изменить/удалить — автор и модераторы (владелец, «Управлять каналами»), остальные — нет', async () => {
  const startAt = Date.now() + 5 * 3600_000;
  const mod = await user('v25mod');
  await okAck(mod.s, 'server:join', { inviteCode: srv.inviteCode });
  const role = (await okAck(alice.s, 'role:create', { serverId: srv.id, name: 'Модер', permissions: 1 << 3 })).role; // MANAGE_CHANNELS
  await okAck(alice.s, 'member:roles', { serverId: srv.id, userId: mod.id, roleIds: [role.id] });

  const a1 = (await okAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'Событие Алисы', startAt })).event;
  const b1 = (await okAck(bob.s, 'sevent:create', { serverId: srv.id, title: 'Событие Боба', startAt })).event;
  const b2 = (await okAck(bob.s, 'sevent:create', { serverId: srv.id, title: 'Ещё одно Боба', startAt })).event;
  // участник без прав — только своё
  await failAck(bob.s, 'sevent:update', { eventId: a1.id, title: 'взлом' }, /автор или модератор/);
  await failAck(bob.s, 'sevent:delete', { eventId: a1.id }, /автор или модератор/);
  expect((await okAck(bob.s, 'sevent:list', { serverId: srv.id })).events.find((e) => e.id === a1.id).canManage).toBe(false);
  const upd = (await okAck(bob.s, 'sevent:update', { eventId: b1.id, title: 'Событие Боба (перенос)', startAt: startAt + 3600_000, channelId: voice.id })).event;
  expect(upd).toMatchObject({ title: 'Событие Боба (перенос)', startAt: startAt + 3600_000, channelId: voice.id });
  // модератор с «Управлять каналами» и владелец — чужое тоже
  expect((await okAck(mod.s, 'sevent:list', { serverId: srv.id })).events.find((e) => e.id === b1.id).canManage).toBe(true);
  const gone = waitEvent(bob.s, 'sevent:removed', (d) => d.id === b1.id);
  await okAck(mod.s, 'sevent:delete', { eventId: b1.id });
  await gone;
  await okAck(alice.s, 'sevent:delete', { eventId: b2.id });
  await okAck(bob.s, 'sevent:delete', { eventId: (await okAck(bob.s, 'sevent:create', { serverId: srv.id, title: 'своё', startAt })).event.id });
  await okAck(alice.s, 'sevent:delete', { eventId: a1.id });
  await dbWait((d) => d.scheduledEvents.filter((e) => e.serverId === srv.id).map((e) => e.title).join() === 'Катка', 'остались только «Катка»');
});

test('интерфейс: создание в своём часовом поясе, RSVP вживую у другого, кнопки прав, мобильная ширина', async ({ browser }) => {
  const pa = await openPage(browser, alice, { timezoneId: 'Europe/Moscow' });
  const pb = await openPage(browser, bob, { viewport: { width: 390, height: 820 }, timezoneId: 'Asia/Novosibirsk' });
  for (const p of [pa, pb]) await selectSrv(p, srv.id, 'Друзья v25');
  // кнопка в шапке со счётчиком ближайших (уже есть «Катка»)
  await expect(pa.locator('#btn-events')).toBeVisible();
  await expect(pa.locator('#btn-events .badge-count')).toHaveText('1');

  // Боб держит окно событий открытым — новое событие появится вживую
  await pb.locator('#btn-events').click();
  await expect(pb.locator('#modal-events')).toBeVisible();
  await expect(pb.locator('.event-card')).toHaveCount(1);

  // Алиса (Москва) создаёт «Рейд» на завтра 21:00
  const tomorrow = new Date(Date.now() + 86400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }); // YYYY-MM-DD
  const [y, mo, d] = tomorrow.split('-').map(Number);
  const expectUtc = Date.UTC(y, mo - 1, d, 18, 0); // 21:00 МСК = 18:00 UTC
  await pa.locator('#btn-events').click();
  await pa.locator('#btn-event-new').click();
  await expect(pa.locator('#event-form')).toBeVisible();
  await pa.locator('#event-title').fill('Рейд');
  await pa.locator('#event-description').fill('Собираемся в голосовом');
  await pa.locator('#event-date').fill(tomorrow);
  await pa.locator('#event-time').fill('21:00');
  await pa.locator('#event-channel').selectOption(voice.id);
  await pa.screenshot({ path: path.join(RESULTS, 'v25-events-form.png') });
  await pa.locator('#event-form-submit').click();
  await expect(pa.locator('#event-form')).toBeHidden();
  const card = (p) => p.locator('.event-card').filter({ has: p.locator('.event-card__title', { hasText: 'Рейд' }) });
  await expect(card(pa)).toBeVisible();
  await expect(card(pa).locator('.event-card__time')).toHaveText('Завтра в 21:00');
  await expect(card(pa).locator('[data-rsvp="going"]')).toHaveAttribute('aria-pressed', 'true'); // автор идёт
  const stored = await dbWait((d) => d.scheduledEvents.find((e) => e.title === 'Рейд'));
  expect(stored.startAt).toBe(expectUtc);
  expect(stored.channelId).toBe(voice.id);

  // у Боба (Новосибирск, +4 ч к Москве) — вживую, в его поясе
  await expect(card(pb)).toBeVisible();
  await expect(card(pb).locator('.event-card__time')).toContainText('01:00');
  await expect(card(pb).locator('.event-card__channel')).toContainText(voice.name);
  await expect(card(pb).locator('.event-card__author')).toContainText(alice.username);
  await expect(card(pb).locator('[data-event-delete]')).toHaveCount(0); // чужое — без кнопок управления
  await expect(card(pa).locator('[data-event-delete]')).toHaveCount(1);
  await expect(card(pa).locator('.event-card__count')).toHaveAttribute('data-going', '1');

  // Боб: «Иду» → у Алисы вживую 2 идущих и аватар Боба; «Может быть» → счётчики меняются
  await card(pb).locator('[data-rsvp="going"]').click();
  await expect(card(pb).locator('[data-rsvp="going"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card(pa).locator('.event-card__count')).toHaveAttribute('data-going', '2');
  await expect(card(pa).locator('.event-card__avatars .avatar')).toHaveCount(2);
  await card(pb).locator('[data-rsvp="maybe"]').click();
  await expect(card(pa).locator('.event-card__count')).toHaveAttribute('data-going', '1');
  await expect(card(pa).locator('.event-card__count')).toHaveAttribute('data-maybe', '1');
  await expect(card(pa).locator('.event-card__count')).toContainText('может быть: 1');
  await expect(pb.locator('#btn-events .badge-count')).toHaveText('2');
  // мобильная ширина: без горизонтальной прокрутки, кнопки RSVP в одну строку на всю ширину
  const scroll = await pb.evaluate(() => ({ doc: document.documentElement.scrollWidth, w: document.documentElement.clientWidth, dlg: document.querySelector('#modal-events').scrollWidth, dlgW: document.querySelector('#modal-events').clientWidth }));
  expect(scroll.doc).toBeLessThanOrEqual(scroll.w);
  expect(scroll.dlg).toBeLessThanOrEqual(scroll.dlgW);
  await pb.screenshot({ path: path.join(RESULTS, 'v25-events-mobile.png') });
  await pa.screenshot({ path: path.join(RESULTS, 'v25-events-desktop.png') });

  // Алиса меняет время — у Боба вживую; удаляет — у Боба карточка исчезает
  await card(pa).locator('[data-event-edit]').click();
  await expect(pa.locator('#event-title')).toHaveValue('Рейд');
  await pa.locator('#event-time').fill('22:30');
  await pa.locator('#event-form-submit').click();
  await expect(card(pb).locator('.event-card__time')).toContainText('02:30');
  await card(pa).locator('[data-event-delete]').click();
  await pa.locator('#confirm-ok').click();
  await expect(card(pb)).toHaveCount(0);
  await expect(pb.locator('#btn-events .badge-count')).toHaveText('1');

  expect(pa.errors, pa.errors.join('\n')).toEqual([]);
  expect(pb.errors, pb.errors.join('\n')).toEqual([]);
  await pa.ctx.close();
  await pb.ctx.close();
});

test('напоминания: за 15 мин и в начале — in-app с «Подключиться», «Входящие», Telegram (с настройкой), уборка', async ({ browser }) => {
  test.setTimeout(120_000);
  await linkTg(alice);
  const carol = await linkTg(await user('v25car'));
  const dave = await linkTg(await user('v25dav'));
  for (const u of [carol, dave]) await okAck(u.s, 'server:join', { inviteCode: srv.inviteCode });
  // Кэрол отключила напоминания о событиях в Telegram (в Astra — переключатель «События серверов»)
  const p = await api('PATCH', '/api/me/telegram', { token: carol.token, body: { notify: { events: false } } });
  expect(p.status).toBe(200);
  expect(p.json.notify).toMatchObject({ events: false, dm: true });
  expect((await api('GET', '/api/me/telegram', { token: alice.token })).json.notify.events).toBe(true);

  const pb = await openPage(browser, bob, { viewport: { width: 390, height: 820 } });
  await selectSrv(pb, srv.id, 'Друзья v25');
  const startAt = Date.now() + REMIND_MS + 9000;
  const ev = (await okAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'Катка в 21:00', startAt, channelId: voice.id })).event;
  await okAck(bob.s, 'sevent:rsvp', { eventId: ev.id, status: 'maybe' });
  await okAck(carol.s, 'sevent:rsvp', { eventId: ev.id, status: 'going' });
  await okAck(dave.s, 'sevent:rsvp', { eventId: ev.id, status: 'no' });
  const aliceNotes = [];
  alice.s.on('notification:new', (d) => aliceNotes.push(d.notification));
  const removed = waitEvent(alice.s, 'sevent:removed', (d) => d.id === ev.id, 80_000);

  // «скоро»: у Боба (вкладка на виду) — карточка-напоминание с «Подключиться»
  const rem = pb.locator('#event-reminder[data-kind="soon"]');
  await expect(rem).toBeVisible({ timeout: 20_000 });
  await expect(rem).toContainText('Катка в 21:00');
  await expect(rem).toContainText(/через \d+ мин/);
  await expect(rem.locator('[data-event-join]')).toBeVisible();
  await pb.screenshot({ path: path.join(RESULTS, 'v25-events-reminder-mobile.png') });
  // Telegram: Алисе (идёт, не в Astra) — с кнопкой «Подключиться» на голосовой канал
  const soonMsg = await waitFor(() => sentTo(alice.chat).find((m) => /Скоро событие/.test(m.text)) || null, { timeout: 10_000, message: 'TG: скоро' });
  expect(soonMsg.text).toContain('«Катка в 21:00» — через');
  expect(soonMsg.text).toContain(`🔊 ${voice.name}`);
  expect(buttons(soonMsg)[0]).toMatchObject({ text: '🎧 Подключиться', url: `${PUBLIC}/?join=${voice.id}` });
  // в момент начала
  const startMsg = await waitFor(() => sentTo(alice.chat).find((m) => /Событие начинается/.test(m.text)) || null, { timeout: 20_000, message: 'TG: начало' });
  expect(startMsg.text).toContain('«Катка в 21:00» начинается');
  await expect(pb.locator('#event-reminder[data-kind="start"]')).toBeVisible({ timeout: 5000 });
  // «Входящие»: одно уведомление на событие (начало заменило «скоро»), без дублей
  expect(aliceNotes.map((n) => n.kind)).toEqual(['soon', 'start']);
  const boot = await okAck(alice.s, 'bootstrap');
  const inbox = boot.notifications.filter((n) => n.eventId === ev.id);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ type: 'event', kind: 'start', serverId: srv.id, channelId: voice.id, preview: 'Катка в 21:00' });
  // Кэрол (выключила события в Telegram) и Дэйв («Не иду») — в Telegram ничего
  await sleep(1500);
  expect(sentTo(carol.chat).filter((m) => /событи/i.test(m.text))).toHaveLength(0);
  expect(sentTo(dave.chat).filter((m) => /событи/i.test(m.text))).toHaveLength(0);
  expect(sentTo(alice.chat).filter((m) => /Катка в 21:00/.test(m.text))).toHaveLength(2);
  const dn = (await okAck(dave.s, 'bootstrap')).notifications.filter((n) => n.eventId === ev.id);
  expect(dn).toHaveLength(0);

  // «Входящие» в интерфейсе: запись о событии с «Подключиться»; карточка — «Подключиться» входит в голос
  await pb.locator('#btn-inbox').click();
  const item = pb.locator(`.inbox-item--event[data-event-id="${ev.id}"]`);
  await expect(item).toBeVisible();
  await expect(item).toContainText('событие начинается');
  await expect(item.locator('[data-event-join]')).toBeVisible();
  await pb.keyboard.press('Escape');
  await pb.locator('#event-reminder [data-event-join]').click();
  await expect.poll(() => pb.evaluate(() => window.__sozvon.state.myVoice?.channelId || null), { timeout: 15_000 }).toBe(voice.id);

  // прошедшее событие убирается (здесь — через 30 с после начала) у всех
  await removed;
  await dbWait((d) => !d.scheduledEvents.find((e) => e.id === ev.id), 'событие удалено из базы');
  expect((await okAck(alice.s, 'bootstrap')).notifications.filter((n) => n.eventId === ev.id)).toHaveLength(0);
  expect(pb.errors, pb.errors.join('\n')).toEqual([]);
  await pb.ctx.close();
});

test('перезапуск сервера: события и ответы сохраняются, напоминания приходят после рестарта и без дублей', async () => {
  test.setTimeout(120_000);
  const startAt = Date.now() + REMIND_MS + 12_000;
  const ev = (await okAck(alice.s, 'sevent:create', { serverId: srv.id, title: 'После рестарта', startAt, channelId: voice.id })).event;
  await okAck(bob.s, 'sevent:rsvp', { eventId: ev.id, status: 'maybe' });
  await sleep(500);
  await stopAstra();
  await startAstra();
  for (const u of [alice, bob]) await sock(u);
  const list = (await okAck(bob.s, 'sevent:list', { serverId: srv.id })).events;
  const got = list.find((e) => e.id === ev.id);
  expect(got).toMatchObject({ title: 'После рестарта', startAt, channelId: voice.id, me: 'maybe' });
  expect(got.rsvp).toMatchObject({ going: [alice.id], maybe: [bob.id] });
  // напоминания — уже из нового процесса (часы восстановлены из базы)
  await waitFor(() => sentTo(alice.chat).find((m) => /Скоро событие/.test(m.text) && m.text.includes('После рестарта')) || null, { timeout: 25_000, message: 'TG: скоро после рестарта' });
  await waitFor(() => sentTo(alice.chat).find((m) => /Событие начинается/.test(m.text) && m.text.includes('После рестарта')) || null, { timeout: 25_000, message: 'TG: начало после рестарта' });
  await waitFor(() => readDb().scheduledEvents.find((e) => e.id === ev.id)?.reminded?.start || null, { message: 'reminded.start в базе' });
  // ещё один рестарт сразу после начала — повторно не шлёт
  await stopAstra();
  await startAstra();
  await sock(alice);
  await sleep(2500);
  const mine = sentTo(alice.chat).filter((m) => m.text.includes('После рестарта'));
  expect(mine.map((m) => (/Скоро/.test(m.text) ? 'soon' : 'start'))).toEqual(['soon', 'start']);
  const notes = (await okAck(alice.s, 'bootstrap')).notifications.filter((n) => n.eventId === ev.id);
  expect(notes).toHaveLength(1);
});
