// v10: управление музыкой — перемотка (!seek, ползунок прогресса), правка очереди (!move, remove/move по qid,
// кнопки и перетаскивание в модалке), удаление треков из библиотеки (DELETE /api/music/:id и права).
// Стенд музыки v2 (tests/start-server-music.js): фейковый yt-dlp, треки PLqaCtl по 14–16 с.
import fs from 'node:fs';
import { test, expect } from './fixtures/ui.js';
import { apiAt, ack, waitEvent, createServer, textChannel, voiceChannel } from './fixtures/api.js';
import { MUSIC_BASE_URL, MUSIC_DATA_DIR } from './fixtures/env.js';
import { ensureMedia } from './fixtures/media.js';

const M = apiAt(MUSIC_BASE_URL, MUSIC_DATA_DIR);
const YT_PL = 'https://www.youtube.com/playlist?list=PLqaCtl';
const YT_VIDEO = 'https://www.youtube.com/watch?v=qaCtl000004';

const sockets = [];
test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } } });

let bot;
test.beforeAll(async () => { bot = await M.startBot(); });
test.afterAll(async () => { await bot?.stop(); });

async function room() {
  const a = await M.makeUser('mc'); sockets.push(a.socket);
  const srv = await createServer(a, 'Музыка v10');
  const ch = textChannel(srv); const vc = voiceChannel(srv);
  expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
  const states = [];
  a.socket.on('music:state', (d) => { if (d.channelId === vc.id) states.push(d); });
  const send = (content) => ack(a.socket, 'message:send', { channelId: ch.id, content });
  const waitState = (pred, ms = 30000) => {
    const last = states[states.length - 1];
    if (last && pred(last)) return Promise.resolve(last);
    return waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && pred(d), ms).catch((e) => {
      const l = states[states.length - 1];
      throw new Error(`${e.message}: ${pred.toString().slice(0, 140)}; последнее: track=${l?.track?.title} pos=${l?.position} paused=${l?.paused} queue=[${(l?.queue || []).map((q) => q.title).join('; ')}]`);
    });
  };
  const waitBot = (re, ms = 20000) => waitEvent(a.socket, 'message:new',
    (d) => d.message?.author?.isBot && d.message.channelId === ch.id && re.test(d.message.content), ms).then((d) => d.message.content);
  const cmd = (command, args = '') => ack(a.socket, 'music:command', { command, args });
  return { a, srv, ch, vc, send, waitState, waitBot, cmd, states };
}

const titles = (s) => (s.queue || []).map((q) => q.title);

test('чат и music:command: !seek, !move, remove/move по qid; qid уникальны', async () => {
  test.setTimeout(120_000);
  const r = await room();
  await r.send(`!play ${YT_PL}`);
  await r.waitState((s) => s.track?.title === 'QA Ctl One' && s.queue.length === 2);
  await r.send(`!play ${YT_VIDEO}`);
  await r.waitState((s) => s.queue.length === 3);
  const reply = r.waitBot(/Пауза/);
  await r.send('!pause');
  await reply;
  let s = await r.waitState((x) => x.paused);
  const seq0 = s.seekSeq;
  expect(typeof seq0).toBe('number');

  // qid: у текущего и у каждого элемента очереди, все разные
  const qids = [s.track.qid, ...s.queue.map((q) => q.qid)];
  expect(qids.every((q) => typeof q === 'string' && q.length > 0)).toBe(true);
  expect(new Set(qids).size).toBe(qids.length);

  // !seek: абсолютное время, m:ss, относительное, мимо
  let p = r.waitBot(/Перемотал/);
  await r.send('!seek 0:08');
  expect(await p).toMatch(/0:08/);
  s = await r.waitState((x) => x.seekSeq > seq0 && Math.abs(x.position - 8) < 0.3);
  expect(s.paused).toBe(true); // пауза сохраняется
  await r.send('!seek +3');
  await r.waitState((x) => Math.abs(x.position - 11) < 0.3);
  await r.send('!seek -30');
  await r.waitState((x) => x.position < 0.3);
  await r.send('!seek 999');
  await r.waitState((x) => Math.abs(x.position - (x.track.duration - 1)) < 0.3); // не дальше конца
  p = r.waitBot(/Укажи время/);
  await r.send('!seek abc');
  await p;
  // из плеера (music:command)
  expect((await r.cmd('seek', '5')).ok).toBe(true);
  await r.waitState((x) => Math.abs(x.position - 5) < 0.3);

  // !move <откуда> <куда>
  p = r.waitBot(/теперь 1-й/);
  await r.send('!move 3 1');
  await p;
  s = await r.waitState((x) => x.queue[0]?.title === 'QA Ctl Four Single');
  expect(titles(s)).toEqual(['QA Ctl Four Single', 'QA Ctl Two', 'QA Ctl Three']);
  p = r.waitBot(/Укажи номера/);
  await r.send('!move 9 1');
  await p;

  // move/remove по qid (как кнопки в модалке)
  const two = s.queue.find((q) => q.title === 'QA Ctl Two').qid;
  expect((await r.cmd('move', `id:${two} 3`)).ok).toBe(true);
  s = await r.waitState((x) => x.queue[2]?.qid === two);
  expect(titles(s)).toEqual(['QA Ctl Four Single', 'QA Ctl Three', 'QA Ctl Two']);
  expect((await r.cmd('remove', `id:${s.queue[1].qid}`)).ok).toBe(true);
  s = await r.waitState((x) => x.queue.length === 2);
  expect(titles(s)).toEqual(['QA Ctl Four Single', 'QA Ctl Two']);
  // уже удалённый qid — без ошибок и без изменений
  expect((await r.cmd('remove', 'id:q-nope')).ok).toBe(true);

  // после перестановки следующий трек — тот, что первым в очереди
  await r.send('!skip');
  await r.waitState((x) => x.track?.title === 'QA Ctl Four Single' && titles(x).join() === 'QA Ctl Two');
  await r.send('!stop');
  await r.waitState((x) => !x.track && !x.queue.length);
});

test('UI: ползунок перемотки (мышь и клавиатура), очередь: ниже/убрать/перетащить, удаление из библиотеки', async ({ makePage }) => {
  test.setTimeout(150_000);
  const page = await makePage();
  const reg = await M.registerApi();
  await page.goto(MUSIC_BASE_URL + '/');
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), reg.token);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#btn-add-server').click();
  const modal = page.locator('#modal-server');
  await modal.locator('input:not([type=hidden]):not([type=file])').locator('visible=true').first().fill('UI v10');
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
  await expect(page.locator('#music-player .music-player__title')).toHaveText('QA Ctl One', { timeout: 60000 });
  await say(`!play ${YT_VIDEO}`);
  await expect(page.locator('#music-queue-badge')).toHaveText('3', { timeout: 60000 });
  await say('!pause');
  await expect(page.locator('#music-player')).toHaveClass(/is-paused/, { timeout: 15000 });

  const elapsed = () => page.evaluate(() => {
    const ch = window.__sozvon?.state?.myVoice?.channelId;
    const ms = ch && window.__sozvon.state.music[ch];
    return ms ? ms.position : -1;
  });
  const audioTime = () => page.evaluate(() => document.querySelector('#music-audio').currentTime);

  // клик на 75 % полосы → перемотка (на паузе тоже), звук прыгает сразу
  const prog = page.locator('#music-progress');
  await expect(prog).toHaveAttribute('role', 'slider');
  await expect(prog).toHaveAttribute('aria-disabled', 'false');
  const box = await prog.boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect.poll(elapsed, { timeout: 10000 }).toBeGreaterThan(9.5);
  expect(await elapsed()).toBeLessThan(11.5); // 75 % от 14 с ≈ 10.5
  await expect.poll(audioTime, { timeout: 10000 }).toBeGreaterThan(9.5);
  // перетаскивание: тянем к началу
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 5 });
  await expect(page.locator('#music-seek-tip')).toBeVisible();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('#music-seek-tip')).toBeHidden();
  await expect.poll(elapsed, { timeout: 10000 }).toBeLessThan(3);
  expect(await elapsed()).toBeGreaterThan(1);
  await expect.poll(audioTime, { timeout: 10000 }).toBeLessThan(3);
  // клавиатура: → +5 с, Home — в начало
  const before = await elapsed();
  await prog.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(elapsed, { timeout: 10000 }).toBeGreaterThan(before + 4);
  await page.keyboard.press('Home');
  await expect.poll(elapsed, { timeout: 10000 }).toBeLessThan(0.5);

  // очередь: кнопка в плеере открывает модалку с очередью
  await page.locator('#btn-music-queue').click();
  const mm = page.locator('#modal-music');
  await expect(mm).toBeVisible();
  const items = mm.locator('.queue-list .queue-item');
  await expect(items).toHaveCount(3);
  const order = () => items.locator('.queue-item__title').allInnerTexts();
  expect(await order()).toEqual(['QA Ctl Two', 'QA Ctl Three', 'QA Ctl Four Single']);
  // «ниже» у первого
  await items.nth(0).hover();
  await items.nth(0).locator('[data-q="down"]').click();
  await expect.poll(order, { timeout: 10000 }).toEqual(['QA Ctl Three', 'QA Ctl Two', 'QA Ctl Four Single']);
  await expect(items.nth(0).locator('[data-q="up"]')).toBeDisabled();
  await expect(items.nth(2).locator('[data-q="down"]')).toBeDisabled();
  // перетащить последний наверх
  await items.nth(2).dragTo(items.nth(0), { targetPosition: { x: 40, y: 4 } });
  await expect.poll(order, { timeout: 10000 }).toEqual(['QA Ctl Four Single', 'QA Ctl Three', 'QA Ctl Two']);
  // убрать средний
  await items.nth(1).hover();
  await items.nth(1).locator('[data-q="remove"]').click();
  await expect.poll(order, { timeout: 10000 }).toEqual(['QA Ctl Four Single', 'QA Ctl Two']);
  await expect(page.locator('#music-queue-badge')).toHaveText('2');

  // библиотека: свой трек можно удалить (с подтверждением), чужие — нет
  const lib = mm.locator('#track-list');
  await expect(lib.locator('.track').first()).toBeVisible({ timeout: 15000 });
  const { upload } = ensureMedia();
  const resp = page.waitForResponse((r) => r.url().endsWith('/api/music/upload') && r.request().method() === 'POST');
  await page.locator('#music-file-input').setInputFiles({ name: 'qa-v10-ui.mp3', mimeType: 'audio/mpeg', buffer: fs.readFileSync(upload) });
  const { track } = await (await resp).json();
  const row = lib.locator(`.track[data-track-id="${track.id}"]`);
  await expect(row.locator('[data-delete]')).toBeVisible({ timeout: 15000 });
  // трек, скачанный другим пользователем (первый тест), удалить нельзя
  const others = (await M.http('GET', '/api/music', { token: reg.token })).json.tracks.filter((t) => !t.canDelete);
  if (others.length) await expect(lib.locator(`.track[data-track-id="${others[0].id}"] [data-delete]`)).toHaveCount(0);
  await row.locator('[data-delete]').click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await page.locator('#modal-confirm .modal__footer [data-close]').click(); // «Отмена»
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await expect(mm).toBeVisible();
  await expect(row).toHaveCount(1);
  await row.locator('[data-delete]').click();
  await page.locator('#confirm-ok').click();
  await expect(row).toHaveCount(0, { timeout: 15000 });
  expect((await M.http('GET', '/api/music', { token: reg.token })).json.tracks.some((t) => t.id === track.id)).toBe(false);

  await page.keyboard.press('Escape');
  await say('!stop');
  await expect(page.locator('#music-player')).toBeHidden({ timeout: 15000 });
});

test('DELETE /api/music/:id: автор — да; чужой — 403; админ сервера, где состоит автор, — да; файл удаляется', async () => {
  const { upload } = ensureMedia();
  const up = async (who) => {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(upload)], { type: 'audio/mpeg' }), 'qa-v10-delete.mp3');
    const r = await M.http('POST', '/api/music/upload', { token: who.token, body: fd });
    expect(r.status).toBe(200);
    return r.json.track;
  };
  const author = await M.makeUser('au'); sockets.push(author.socket);
  const stranger = await M.makeUser('st'); sockets.push(stranger.socket);
  const admin = await M.makeUser('ad'); sockets.push(admin.socket);
  const strangerSrv = await createServer(stranger, 'Чужой'); // свой сервер есть, но автора там нет
  expect(strangerSrv.id).toBeTruthy();

  const t1 = await up(author);
  const list = async (who) => (await M.http('GET', '/api/music', { token: who.token })).json.tracks;
  expect((await list(author)).find((t) => t.id === t1.id).canDelete).toBe(true);
  expect((await list(stranger)).find((t) => t.id === t1.id).canDelete).toBe(false);
  expect((await M.http('DELETE', `/api/music/${t1.id}`, { token: stranger.token })).status).toBe(403);
  expect((await M.http('DELETE', '/api/music/nope000000', { token: author.token })).status).toBe(404);

  const file = `${MUSIC_DATA_DIR}/music/${decodeURIComponent(t1.url.split('/').pop())}`;
  expect(fs.existsSync(file)).toBe(true);
  const del = await M.http('DELETE', `/api/music/${t1.id}`, { token: author.token });
  expect(del.status).toBe(200);
  expect(fs.existsSync(file)).toBe(false);
  expect((await list(author)).some((t) => t.id === t1.id)).toBe(false);

  // администратор (владелец) сервера, где состоит автор
  const srv = await createServer(admin, 'Админский');
  expect((await ack(author.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const t2 = await up(author);
  expect((await list(admin)).find((t) => t.id === t2.id).canDelete).toBe(true);
  expect((await M.http('DELETE', `/api/music/${t2.id}`, { token: admin.token })).status).toBe(200);
  expect((await list(author)).some((t) => t.id === t2.id)).toBe(false);
});
