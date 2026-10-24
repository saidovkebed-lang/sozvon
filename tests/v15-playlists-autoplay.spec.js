// v15: сохранённые плейлисты сервера (REST, права, лимиты, !playlist/!pl, «Сохранить очередь», вкладка «Плейлисты»)
// и автоплей (радио-микс YouTube RD<id> через фейковый yt-dlp, без повторов, настройка сохраняется, ошибка — один раз).
// Стенд музыки v2 (tests/start-server-music.js). Видео qaAuto000NN — по 8 с (tests/fixtures/fake-yt-dlp.mjs).
import fs from 'node:fs';
import { test, expect } from './fixtures/ui.js';
import { apiAt, ack, waitEvent, createServer, textChannel, voiceChannel, sleep } from './fixtures/api.js';
import { MUSIC_BASE_URL, MUSIC_DATA_DIR, YTDLP_LOG } from './fixtures/env.js';
import { ensureMedia } from './fixtures/media.js';

const M = apiAt(MUSIC_BASE_URL, MUSIC_DATA_DIR);
const YT_PL = 'https://www.youtube.com/playlist?list=PLqaPls';
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const P = { USE_MUSIC_BOT: 1 << 18 };
const DEFAULT_EVERYONE = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 12) | (1 << 13) | (1 << 14) | P.USE_MUSIC_BOT;

const sockets = [];
test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } } });

let bot;
test.beforeAll(async () => { bot = await M.startBot(); });
test.afterAll(async () => { await bot?.stop(); });

const pl = (sid) => `/api/servers/${sid}/playlists`;

async function room(name = 'Музыка v15') {
  const a = await M.makeUser('pl'); sockets.push(a.socket);
  const srv = await createServer(a, name);
  const ch = textChannel(srv); const vc = voiceChannel(srv);
  expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
  const states = [];
  const botMsgs = [];
  a.socket.on('music:state', (d) => { if (d.channelId === vc.id) states.push(d); });
  a.socket.on('message:new', (d) => { if (d.message?.author?.isBot && d.message.channelId === ch.id) botMsgs.push(d.message.content); });
  const send = (content) => ack(a.socket, 'message:send', { channelId: ch.id, content });
  const waitState = (pred, ms = 30000) => {
    const last = states[states.length - 1];
    if (last && pred(last)) return Promise.resolve(last);
    return waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && pred(d), ms).catch((e) => {
      const l = states[states.length - 1];
      throw new Error(`${e.message}: ${pred.toString().slice(0, 160)}; последнее: track=${l?.track?.title} queue=[${(l?.queue || []).map((q) => q.title + (q.autoplay ? '*' : '')).join('; ')}]`);
    });
  };
  const waitBot = (re, ms = 20000) => {
    const seen = botMsgs.find((m) => re.test(m));
    if (seen) { botMsgs.splice(botMsgs.indexOf(seen), 1); return Promise.resolve(seen); }
    return waitEvent(a.socket, 'message:new',
      (d) => d.message?.author?.isBot && d.message.channelId === ch.id && re.test(d.message.content), ms).then((d) => {
      const i = botMsgs.indexOf(d.message.content); if (i !== -1) botMsgs.splice(i, 1);
      return d.message.content;
    }).catch((e) => { throw new Error(`${e.message}: ждал ${re}; бот писал: ${botMsgs.slice(-5).join(' | ')}`); });
  };
  const say = async (content, re, ms) => { const p = waitBot(re, ms); await send(content); return p; };
  const cmd = (command, args = '') => ack(a.socket, 'music:command', { command, args });
  return { a, srv, ch, vc, send, say, waitState, waitBot, cmd, states, botMsgs };
}

async function upload(who, name = 'qa-v15.mp3') {
  const { upload: file } = ensureMedia();
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), name);
  const r = await M.http('POST', '/api/music/upload', { token: who.token, body: fd });
  expect(r.status).toBe(200);
  return r.json.track;
}

test('REST: создание/переименование/удаление, треки (библиотека, ожидающий, ссылка), порядок, права, лимиты, событие', async () => {
  test.setTimeout(120_000);
  const owner = await M.makeUser('own'); sockets.push(owner.socket);
  const author = await M.makeUser('aut'); sockets.push(author.socket);
  const other = await M.makeUser('oth'); sockets.push(other.socket);
  const stranger = await M.makeUser('str'); sockets.push(stranger.socket);
  const srv = await createServer(owner, 'Плейлисты REST');
  for (const u of [author, other]) expect((await ack(u.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const H = (who, method, url, body) => M.http(method, url, { token: who.token, body });

  // валидация
  expect((await H(author, 'POST', pl(srv.id), { name: '   ' })).status).toBe(400);
  expect((await H(author, 'POST', pl(srv.id), { name: 'x'.repeat(61) })).status).toBe(400);
  expect((await H(author, 'POST', pl(srv.id), { name: 42 })).status).toBe(400);
  // событие music:playlists участникам сервера
  const ev = waitEvent(other.socket, 'music:playlists', (d) => d.serverId === srv.id);
  const created = await H(author, 'POST', pl(srv.id), { name: 'Вечерний' });
  expect(created.status).toBe(200);
  await ev;
  const p1 = created.json.playlist;
  expect(p1).toMatchObject({ name: 'Вечерний', count: 0, canEdit: true });
  expect(p1.createdBy.username).toBe(author.username);
  expect((await H(other, 'POST', pl(srv.id), { name: 'вечерний' })).status).toBe(409); // имя уникально без учёта регистра
  // чужой сервер — 404, без права музыки — 403
  expect((await H(stranger, 'GET', pl(srv.id))).status).toBe(404);
  expect((await H(stranger, 'GET', `${pl(srv.id)}/${p1.id}`)).status).toBe(404);

  // треки: из библиотеки, «ожидающий» (ссылка YouTube), по ссылке (скачивается)
  const t = await upload(author);
  let r = await H(author, 'POST', `${pl(srv.id)}/${p1.id}/items`, { trackId: t.id });
  expect(r.status).toBe(200);
  r = await H(author, 'POST', `${pl(srv.id)}/${p1.id}/items`, {
    item: { pending: true, title: 'QA Auto Ten', artist: 'QA Auto', duration: 8, source: 'youtube', ref: { url: yt('qaAuto00010'), key: 'youtube:qaAuto00010' } },
  });
  expect(r.status).toBe(200);
  r = await H(author, 'POST', `${pl(srv.id)}/${p1.id}/items`, { url: yt('qaPls000004') });
  expect(r.status).toBe(200);
  expect(r.json.added).toBe(1);
  let items = r.json.playlist.items;
  expect(items.map((i) => i.title)).toEqual([t.title, 'QA Auto Ten', 'QA Pls Four Single']);
  expect(items[2].ready).toBe(true);
  expect((await H(author, 'POST', `${pl(srv.id)}/${p1.id}/items`, { trackId: 'nope' })).status).toBe(400);
  expect((await H(author, 'POST', `${pl(srv.id)}/${p1.id}/items`, { item: { title: 'x', ref: { url: 'javascript:alert(1)' } } })).status).toBe(400);
  // порядок и удаление
  r = await H(author, 'PATCH', `${pl(srv.id)}/${p1.id}`, { move: { iid: items[2].iid, to: 1 } });
  expect(r.json.playlist.items.map((i) => i.title)).toEqual(['QA Pls Four Single', t.title, 'QA Auto Ten']);
  r = await H(author, 'DELETE', `${pl(srv.id)}/${p1.id}/items/${items[0].iid}`);
  expect(r.json.playlist.items.map((i) => i.title)).toEqual(['QA Pls Four Single', 'QA Auto Ten']);
  expect(r.json.playlist.count).toBe(2);

  // права: другой участник видит, но не меняет; владелец сервера (админ) — может
  const list = (await H(other, 'GET', pl(srv.id))).json.playlists;
  expect(list.find((x) => x.id === p1.id).canEdit).toBe(false);
  expect((await H(other, 'PATCH', `${pl(srv.id)}/${p1.id}`, { name: 'Мой' })).status).toBe(403);
  expect((await H(other, 'DELETE', `${pl(srv.id)}/${p1.id}`)).status).toBe(403);
  expect((await H(other, 'POST', `${pl(srv.id)}/${p1.id}/items`, { trackId: t.id })).status).toBe(403);
  r = await H(owner, 'PATCH', `${pl(srv.id)}/${p1.id}`, { name: 'Вечерний (админ)' });
  expect(r.status).toBe(200);
  expect(r.json.playlist.name).toBe('Вечерний (админ)');
  // элементы для бота: готовые — треки библиотеки, остальные — ожидающие со ссылкой
  r = await H(other, 'GET', `${pl(srv.id)}/${p1.id}/play`);
  expect(r.status).toBe(200);
  expect(r.json.items[0].url).toMatch(/^\/media\/music\//);
  expect(r.json.items[1]).toMatchObject({ pending: true, title: 'QA Auto Ten', ref: { url: yt('qaAuto00010') } });

  // без USE_MUSIC_BOT у @everyone: участник не видит и не создаёт; автор не может менять свой
  expect((await ack(owner.socket, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: DEFAULT_EVERYONE & ~P.USE_MUSIC_BOT })).ok).toBe(true);
  expect((await H(other, 'GET', pl(srv.id))).status).toBe(403);
  expect((await H(other, 'POST', pl(srv.id), { name: 'Нельзя' })).status).toBe(403);
  expect((await H(author, 'DELETE', `${pl(srv.id)}/${p1.id}`)).status).toBe(403);
  expect((await H(owner, 'GET', pl(srv.id))).status).toBe(200);
  expect((await ack(owner.socket, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: DEFAULT_EVERYONE })).ok).toBe(true);
  expect((await H(author, 'DELETE', `${pl(srv.id)}/${p1.id}`)).status).toBe(200);
  expect((await H(author, 'GET', `${pl(srv.id)}/${p1.id}`)).status).toBe(404);

  // лимит треков: 500 (лишнее не сохраняется), потом добавить нельзя
  const many = Array.from({ length: 501 }, (_, i) => ({ pending: true, title: `Песня ${i}`, artist: 'QA', source: 'search', ref: { query: `QA - Песня ${i}` } }));
  r = await H(author, 'POST', pl(srv.id), { name: 'Большой', items: many });
  expect(r.status).toBe(200);
  expect(r.json.playlist.count).toBe(500);
  expect(r.json.skipped).toBe(1);
  expect((await H(author, 'POST', `${pl(srv.id)}/${r.json.playlist.id}/items`, { trackId: t.id })).status).toBe(400);
  // лимит плейлистов: 200 на сервер
  const srv2 = await createServer(owner, 'Плейлисты лимит');
  for (let i = 0; i < 200; i++) {
    const x = await H(owner, 'POST', pl(srv2.id), { name: `П${i}` });
    if (x.status !== 200) throw new Error(`плейлист ${i}: ${x.status} ${JSON.stringify(x.json)}`);
  }
  r = await H(owner, 'POST', pl(srv2.id), { name: 'Лишний' });
  expect(r.status).toBe(400);
  expect(r.json.error).toMatch(/200/);
  expect((await H(owner, 'GET', pl(srv2.id))).json.playlists.length).toBe(200);
});

test('бот: !playlist save, !playlist list, !pl <часть названия>, !playlist shuffle, не найден', async () => {
  test.setTimeout(120_000);
  const r = await room('Плейлисты бот');
  await r.send(`!play ${YT_PL}`);
  await r.waitState((s) => s.track?.title === 'QA Pls One' && s.queue.length === 2);
  // в MusicState у ожидающих элементов есть ref (для «Сохранить очередь» в интерфейсе)
  const st = r.states[r.states.length - 1];
  expect(st.queue.filter((q) => q.pending).every((q) => q.ref?.url || q.ref?.key)).toBe(true);
  expect(await r.say('!playlist save Вечеринка', /Сохранил плейлист «Вечеринка»/)).toMatch(/3 трека/);
  const { playlists } = (await M.http('GET', pl(r.srv.id), { token: r.a.token })).json;
  expect(playlists).toHaveLength(1);
  expect(playlists[0]).toMatchObject({ name: 'Вечеринка', count: 3, canEdit: true });
  expect(playlists[0].createdBy.username).toBe(r.a.username);
  // повторное сохранение — обновляет
  expect(await r.say('!playlist save вечеринка', /Обновил плейлист/)).toMatch(/3 трека/);
  expect(await r.say('!playlist list', /Плейлисты сервера/)).toMatch(/Вечеринка — 3 трека/);
  await r.say('!stop', /Остановил/);
  await r.waitState((s) => !s.track && !s.queue.length);

  expect(await r.say('!pl вечер', /Плейлист «Вечеринка»/)).toMatch(/включаю 3 трека/);
  await r.waitState((s) => s.track?.title === 'QA Pls One' && s.queue.length === 2);
  expect(await r.say('!playlist shuffle Вечеринка', /вперемешку/)).toMatch(/добавил в очередь 3 трека/);
  await r.waitState((s) => s.queue.length === 5);
  expect(await r.say('!playlist нет-такого', /не найден/)).toMatch(/!playlist list/);
  await r.say('!stop', /Остановил/);
});

test('UI: вкладка «Плейлисты» — создать, «Сейчас играет», «+» из библиотеки, сохранить очередь, включить, перемешать; автоплей-кнопка', async ({ makePage }) => {
  test.setTimeout(150_000);
  const page = await makePage();
  const reg = await M.registerApi();
  await page.goto(MUSIC_BASE_URL + '/');
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), reg.token);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#btn-add-server').click();
  const modal = page.locator('#modal-server');
  await modal.locator('input:not([type=hidden]):not([type=file])').locator('visible=true').first().fill('UI v15');
  await modal.locator('.btn--primary').locator('visible=true').first().click();
  await page.locator('a.channel[data-type="voice"]').first().click();
  await page.waitForTimeout(300);
  const join = page.locator('#voice-join button');
  if (await join.isVisible().catch(() => false)) await join.first().click();
  await expect(page.locator('#voice-panel')).toBeVisible();
  await page.locator('a.channel[data-type="text"]').first().click();
  const say = async (text) => {
    await page.locator('#composer-input').fill(text);
    await page.locator('#composer-input').press('Enter');
  };
  await say(`!play ${YT_PL}`);
  await expect(page.locator('#music-player .music-player__title')).toHaveText('QA Pls One', { timeout: 60000 });
  await expect(page.locator('#music-queue-badge')).toHaveText('2', { timeout: 30000 });
  await say('!pause'); // трек не должен закончиться, пока работаем с плейлистами
  await expect(page.locator('#music-player')).toHaveClass(/is-paused/, { timeout: 15000 });
  const sid = await page.evaluate(() => window.__sozvon.state.currentServerId);

  // автоплей: кнопка в плеере переключает настройку сервера
  const ap = page.locator('#btn-music-autoplay');
  await expect(ap).toHaveAttribute('aria-pressed', 'false');
  await ap.click();
  await expect(ap).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
  expect((await M.http('GET', `/api/servers/${sid}/music-settings`, { token: reg.token })).json.settings.autoplay).toBe(true);
  await ap.click();
  await expect(ap).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 });

  // создать плейлист и добавить играющий трек
  await page.locator('#btn-music-library').click();
  const mm = page.locator('#modal-music');
  await expect(mm).toBeVisible();
  await mm.locator('[data-music-tab="playlists"]').click();
  await expect(mm.locator('#music-panel-playlists')).toBeVisible();
  await expect(mm.locator('#music-panel-library')).toBeHidden();
  await mm.locator('#pl-name-input').fill('UI плейлист');
  await mm.locator('#form-pl-create button[type=submit]').click();
  await expect(mm.locator('#pl-detail-name')).toHaveText('UI плейлист', { timeout: 15000 });
  await mm.locator('#btn-pl-add-current').click();
  await expect(mm.locator('#pl-items .queue-item')).toHaveCount(1, { timeout: 15000 });
  await expect(mm.locator('#pl-items .queue-item__title')).toHaveText('QA Pls One');
  // по ссылке
  await mm.locator('#pl-url-input').fill(yt('qaPls000004'));
  await mm.locator('#form-pl-add-url button').click();
  await expect(mm.locator('#pl-items .queue-item')).toHaveCount(2, { timeout: 30000 });
  // порядок: второй выше
  await mm.locator('#pl-items .queue-item').nth(1).hover();
  await mm.locator('#pl-items .queue-item').nth(1).locator('[data-p="up"]').click();
  await expect.poll(() => mm.locator('#pl-items .queue-item__title').allInnerTexts(), { timeout: 10000 }).toEqual(['QA Pls Four Single', 'QA Pls One']);
  // переименовать
  await mm.locator('#btn-pl-rename').click();
  await mm.locator('#pl-rename-input').fill('UI мой плейлист');
  await mm.locator('#form-pl-rename button[type=submit]').click();
  await expect(mm.locator('#pl-detail-name')).toHaveText('UI мой плейлист');

  // «+» у трека в очереди → выбор плейлиста
  await mm.locator('#music-queue .queue-item').first().hover();
  await mm.locator('#music-queue .queue-item').first().locator('[data-q="playlist"]').click();
  const pick = page.locator('#modal-pl-pick');
  await expect(pick).toBeVisible();
  await pick.locator('.pl-pick', { hasText: 'UI мой плейлист' }).click();
  await expect(pick).toBeHidden({ timeout: 15000 });
  await expect(mm.locator('#pl-items .queue-item')).toHaveCount(3, { timeout: 15000 }); // событие music:playlists обновило вид
  await expect(mm.locator('#pl-items .queue-item__title').nth(2)).toHaveText('QA Pls Two');

  // назад к списку; сохранить очередь как плейлист
  await mm.locator('#btn-pl-back').click();
  await mm.locator('#pl-name-input').fill('UI очередь');
  await mm.locator('#btn-pl-save-queue').click();
  const row = mm.locator('#pl-list .playlist', { hasText: 'UI очередь' });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row.locator('.track__artist')).toContainText('3 трека');

  // «+» в библиотеке → новый плейлист из окна выбора
  await mm.locator('[data-music-tab="library"]').click();
  const libRow = mm.locator('#track-list .track').filter({ hasText: 'QA Pls One' }).first();
  await expect(libRow).toBeVisible({ timeout: 15000 });
  await libRow.locator('[data-add-pl]').click();
  await expect(pick).toBeVisible();
  await pick.locator('#pl-pick-name').fill('UI из библиотеки');
  await pick.locator('#form-pl-pick-new button').click();
  await expect(pick).toBeHidden({ timeout: 15000 });
  const lists = (await M.http('GET', pl(sid), { token: reg.token })).json.playlists;
  expect(lists.map((x) => [x.name, x.count])).toEqual(expect.arrayContaining([['UI из библиотеки', 1], ['UI очередь', 3], ['UI мой плейлист', 3]]));

  // включить плейлист и вперемешку
  await page.keyboard.press('Escape');
  await expect(mm).toBeHidden();
  await say('!stop');
  await expect(page.locator('#music-player')).toBeHidden({ timeout: 15000 });
  await page.locator('#btn-open-music').click();
  await expect(mm).toBeVisible();
  await expect(mm.locator('#music-panel-library')).toBeVisible(); // после закрытия — снова «Библиотека»
  await mm.locator('[data-music-tab="playlists"]').click();
  const mine = mm.locator('#pl-list .playlist', { hasText: 'UI мой плейлист' });
  await expect(mine).toBeVisible({ timeout: 15000 });
  await mine.locator('[data-pl-play]').click();
  await expect(page.locator('#music-player .music-player__title')).toHaveText('QA Pls Four Single', { timeout: 60000 });
  await expect(page.locator('#music-queue-badge')).toHaveText('2', { timeout: 30000 });
  await mine.locator('[data-pl-shuffle]').click();
  await expect(page.locator('#music-queue-badge')).toHaveText('5', { timeout: 30000 });
  // удалить плейлист
  await mine.locator('[data-pl-open]').click();
  await mm.locator('#btn-pl-delete').click();
  await page.locator('#confirm-ok').click();
  await expect(mm.locator('#pl-list .playlist', { hasText: 'UI мой плейлист' })).toHaveCount(0, { timeout: 15000 });
  // элемент автоплея в очереди помечен «авто» (состояние как от бота)
  await page.evaluate(() => {
    const m = window.__sozvon.music;
    const ms = { ...m.currentState(), serverNow: undefined };
    ms.queue = [...ms.queue, { id: 'p-qaauto', qid: 'qauto1', title: 'QA Auto Fake', artist: 'QA Auto', pending: true, source: 'youtube', autoplay: true, addedBy: 'автоплей' }];
    m.setState(ms);
  });
  const autoItem = mm.locator('#music-queue .queue-item', { hasText: 'QA Auto Fake' });
  await expect(autoItem.locator('.queue-item__auto')).toHaveText('авто');
  await expect(autoItem.locator('.queue-item__meta')).not.toContainText('добавил');
  await page.keyboard.press('Escape');
  await say('!stop');
  await expect(page.locator('#music-player')).toBeHidden({ timeout: 15000 });
});

test('автоплей: очередь кончилась → треки из микса RD<id> (авто), без повторов, свои треки — перед автоплеем; настройка сохраняется', async () => {
  test.setTimeout(150_000);
  const r = await room('Автоплей');
  expect(await r.say('!autoplay', /Автоплей выключен/)).toBeTruthy();
  expect(await r.say('!autoplay on', /Автоплей включён/)).toBeTruthy();
  expect((await M.http('GET', `/api/servers/${r.srv.id}/music-settings`, { token: r.a.token })).json.settings.autoplay).toBe(true);
  expect(await r.say('!autoplay maybe', /!autoplay on или !autoplay off/)).toBeTruthy();

  await r.send(`!play ${yt('qaAuto00001')}`);
  await r.waitState((s) => s.track?.title === 'QA Auto One' && s.autoplay === true);
  const msg1 = await r.waitBot(/🔁 Автоплей: «/, 30000);
  for (const t of ['Two', 'Three', 'Four', 'Five']) expect(msg1).toContain(`QA Auto ${t}`);
  expect(msg1).not.toContain('QA Auto One');
  expect(msg1).not.toContain('QA Auto Six'); // 4 трека за раз
  const s1 = await r.waitState((s) => s.queue.filter((q) => q.autoplay).length >= 3);
  expect(s1.queue.every((q) => q.autoplay)).toBe(true);
  // мешок микса запрошен с --yes-playlist
  const calls = fs.readFileSync(YTDLP_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(calls.some((c) => c.argv.includes('https://www.youtube.com/watch?v=qaAuto00001&list=RDqaAuto00001') && c.argv.includes('--yes-playlist'))).toBe(true);

  // свой трек встаёт перед треками автоплея
  await r.send(`!play ${yt('qaPls000004')}`);
  const waiting = (x) => x.queue.filter((q) => !q.loading); // загружаемый сейчас элемент — не часть очереди
  let s = await r.waitState((x) => waiting(x)[0]?.title === 'QA Pls Four Single' && !waiting(x)[0].autoplay);
  expect(waiting(s).slice(1).every((q) => q.autoplay)).toBe(true);
  expect((await r.cmd('remove', `id:${waiting(s)[0].qid}`)).ok).toBe(true);

  // доигрывает до Two, остальное убираем → !skip → новая порция по миксу Two без повторов
  s = await r.waitState((x) => x.track?.title === 'QA Auto Two' && x.track.autoplay === true, 40000);
  for (const q of s.queue) expect((await r.cmd('remove', `id:${q.qid}`)).ok).toBe(true);
  await r.waitState((x) => x.track?.title === 'QA Auto Two' && x.queue.length === 0);
  await r.send('!skip');
  const msg2 = await r.waitBot(/🔁 Автоплей: «/, 30000);
  for (const t of ['Seven', 'Eight', 'Nine', 'Ten']) expect(msg2).toContain(`QA Auto ${t}`);
  for (const t of ['One', 'Two', 'Three']) expect(msg2).not.toContain(`QA Auto ${t}»`);
  s = await r.waitState((x) => x.track?.title === 'QA Auto Seven' || x.queue.some((q) => q.title === 'QA Auto Seven'));

  // выключить → сохранено; после перезапуска бота настройка та же
  expect(await r.say('!autoplay off', /Автоплей выключен/)).toBeTruthy();
  await r.waitState((x) => x.autoplay === false);
  expect((await M.http('GET', `/api/servers/${r.srv.id}/music-settings`, { token: r.a.token })).json.settings.autoplay).toBe(false);
  await r.say('!autoplay on', /Автоплей включён/);
  await r.say('!stop', /Остановил/);
  await bot.stop();
  bot = await M.startBot();
  expect(await r.say('!autoplay', /Автоплей (включён|выключен)/, 20000)).toMatch(/Автоплей включён/);
  await r.say('!autoplay off', /Автоплей выключен/);
});

test('автоплей: затравка не с YouTube → поиск; ошибка микса → одно сообщение и пауза; !stop — тишина', async () => {
  test.setTimeout(120_000);
  // REST: трек без YouTube-id — сначала поиск «исполнитель название», потом микс найденного
  const u = await M.makeUser('sim'); sockets.push(u.socket);
  const sim = await M.http('POST', '/api/music/similar', { token: u.token, body: { seed: { title: 'QA Auto Three', artist: 'QA Auto' }, exclude: ['t:qa auto four'], count: 4 } });
  expect(sim.status).toBe(200);
  expect(sim.json.seed).toEqual({ videoId: 'qaAuto00003', via: 'search' });
  expect(sim.json.items.map((i) => i.title)).toEqual(['QA Auto Two', 'QA Auto Five', 'QA Auto Six']);
  expect(sim.json.items.every((i) => i.pending && i.autoplay && i.ref.url.startsWith('https://www.youtube.com/watch?v='))).toBe(true);
  expect((await M.http('POST', '/api/music/similar', { token: u.token, body: {} })).status).toBe(400);

  const r = await room('Автоплей ошибка');
  await r.say('!autoplay on', /Автоплей включён/);
  await r.send(`!play ${yt('qaAutoNoMix')}`);
  await r.waitState((s) => s.track?.title === 'QA Auto Lonely');
  const err = await r.waitBot(/Автоплей: не получилось подобрать/, 30000);
  expect(err).toMatch(/на паузе/);
  await sleep(2500);
  expect(r.botMsgs.filter((m) => /Автоплей: не получилось/.test(m))).toHaveLength(0); // больше не повторяет
  expect(await r.say('!autoplay', /Автоплей включён/)).toMatch(/на паузе/);
  // после !stop автоплей ничего не добавляет
  await r.send(`!play ${yt('qaAuto00001')}`);
  await r.waitState((s) => s.track?.title === 'QA Auto One');
  await r.say('!stop', /Остановил/);
  await sleep(6000);
  expect(r.botMsgs.filter((m) => /🔁 Автоплей: «/.test(m))).toHaveLength(0);
  const last = r.states[r.states.length - 1];
  expect(last.track).toBeNull();
  expect(last.queue).toHaveLength(0);
  await r.say('!autoplay off', /Автоплей выключен/);
});
