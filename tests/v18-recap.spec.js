// v18: «Astra Итоги» — сбор статистики (server/stats.js), API /api/servers/:sid/recap, отказ от участия,
// ЛС не считаются, права, объявления раз в период, UI-слайды и PNG-карточка (public/js/ui/recap.js).
// Стенд музыки (tests/start-server-music.js, SOZVON_TEST_HOOKS=1): часы статистики подменяются через
// POST /api/__test/stats {now}, музыку играет «фейковый бот» (сокет с токеном бота шлёт bot:music-state),
// «Смотреть вместе» — настоящий поток с фейковым yt-dlp (qaWatch0001).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/ui.js';
import { apiAt, ack, waitEvent, createServer, textChannel, voiceChannel, connected, botToken, sleep } from './fixtures/api.js';
import { MUSIC_BASE_URL, MUSIC_DATA_DIR, MEDIA_DIR } from './fixtures/env.js';

const M = apiAt(MUSIC_BASE_URL, MUSIC_DATA_DIR);
const MIN = 60_000;
const sockets = [];
const S = {}; // общее состояние сценария

const hook = async (body) => {
  const r = await M.http('POST', '/api/__test/stats', { body });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const clock = (ms) => hook({ now: ms });
const recap = (who, sid, period) => M.http('GET', `/api/servers/${sid}/recap${period ? `?period=${period}` : ''}`, { token: who.token });
const send = (who, channelId, content, attachments) => ack(who.socket, 'message:send', { channelId, content, ...(attachments ? { attachments } : {}) });
const at = (y, mo, d, hh, mm = 0) => new Date(y, mo - 1, d, hh, mm).getTime();

async function user(prefix) { const u = await M.makeUser(prefix); sockets.push(u.socket); return u; }

test.describe.serial('Astra Итоги', () => {
  test.afterAll(async () => {
    await M.http('POST', '/api/__test/stats', { body: { now: null } }).catch(() => {});
    while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } }
  });

  test('сбор: голос, трансляция, сообщения, музыка, «Смотреть вместе», новые участники; отказ от участия; ЛС не считаются', async () => {
    test.setTimeout(120_000);
    const T0 = at(2026, 9, 12, 23, 0);
    await clock(T0);
    const a = await user('rca'); const b = await user('rcb'); const c = await user('rcc');
    const srv = await createServer(a, 'Итоги QA');
    for (const u of [b, c]) expect((await ack(u.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
    const ch = textChannel(srv); const vc = voiceChannel(srv);
    Object.assign(S, { a, b, c, srv, ch, vc });

    // ---- голос: a и b с 23:00, c с 01:00; b уходит в 02:00; a показывает экран 02:00–02:30; a и c уходят в 03:00
    expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    expect((await ack(b.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    await clock(T0 + 120 * MIN);
    expect((await ack(c.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    await clock(T0 + 180 * MIN);
    expect((await ack(b.socket, 'voice:leave')).ok).toBe(true);
    let st = waitEvent(a.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.userId === a.user.id && m.streaming));
    a.socket.emit('voice:state', { streaming: true });
    await st;
    await clock(T0 + 210 * MIN);
    st = waitEvent(a.socket, 'voice:members', (d) => d.channelId === vc.id && d.members.some((m) => m.userId === a.user.id && !m.streaming));
    a.socket.emit('voice:state', { streaming: false });
    await st;
    await clock(T0 + 240 * MIN); // 03:00 13 сентября
    expect((await ack(a.socket, 'voice:leave')).ok).toBe(true);
    expect((await ack(c.socket, 'voice:leave')).ok).toBe(true);

    // ---- сообщения в 03:00: b×3 (одно с вложением), a×1, c×2; ЛС a→b не считается
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(path.join(MEDIA_DIR, 'qa-image.png'))], { type: 'image/png' }), 'qa.png');
    const att = (await M.http('POST', '/api/attachments', { token: b.token, body: fd })).json;
    expect((await send(b, ch.id, 'секретный текст итогов', [att])).ok).toBe(true);
    for (const [u, n] of [[b, 2], [a, 1], [c, 2]]) for (let i = 0; i < n; i++) expect((await send(u, ch.id, `привет ${i}`)).ok).toBe(true);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    for (let i = 0; i < 5; i++) expect((await send(a, dm.id, `личное ${i}`)).ok).toBe(true);

    // ---- музыка (фейковый бот): 4 трека по 4/4/4/3 минуты, последний — автоплей
    const bot = await connected(M.connect(botToken(MUSIC_DATA_DIR), { bot: true }));
    sockets.push(bot);
    const track = (qid, title, artist, addedBy, extra = {}) => ({ id: 'id-' + qid, qid, title, artist, duration: 240, url: '/media/music/x.mp3', addedBy, ...extra });
    const music = (t, paused = false) => ack(bot, 'bot:music-state', { channelId: vc.id, track: t, queue: [], paused, position: 0, updatedAt: Date.now() });
    expect((await music(track('q1', 'Song A', 'Artist X', b.username))).ok).toBe(true);
    await music(track('q1', 'Song A', 'Artist X', b.username)); // тот же трек ещё раз — не новое проигрывание
    await clock(T0 + 244 * MIN);
    await music(track('q2', 'Song B', 'Artist X', b.username));
    await clock(T0 + 248 * MIN);
    await music(track('q3', 'Song A', 'Artist X', a.username));
    await clock(T0 + 252 * MIN);
    await music(track('q4', 'Auto Song', 'Artist Y', 'автоплей', { autoplay: true }));
    await clock(T0 + 255 * MIN);
    await music(null);
    bot.disconnect();

    // ---- «Смотреть вместе» 14 сентября 20:00: a и c в канале, c уходит через 10 мин, a останавливает через 25
    const W = at(2026, 9, 14, 20, 0);
    await clock(W);
    expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    expect((await ack(c.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    const playing = waitEvent(a.socket, 'watch:state', (d) => d.channelId === vc.id && d.video?.title === 'QA Watch One', 30000);
    expect((await ack(a.socket, 'watch:start', { url: 'https://www.youtube.com/watch?v=qaWatch0001' })).ok).toBe(true);
    await playing;
    await clock(W + 10 * MIN);
    expect((await ack(c.socket, 'voice:leave')).ok).toBe(true);
    await clock(W + 25 * MIN);
    expect((await ack(a.socket, 'watch:control', { action: 'stop' })).ok).toBe(true);
    expect((await ack(a.socket, 'voice:leave')).ok).toBe(true);

    // ---- c отказывается от участия: пропадает из рейтингов, его новые сообщения — только в общем счёте
    expect((await M.http('GET', '/api/me/recap', { token: c.token })).json).toEqual({ participate: true });
    const off = await M.http('PUT', '/api/me/recap', { token: c.token, body: { participate: false } });
    expect(off.status).toBe(200);
    expect(off.json.participate).toBe(false);
    for (let i = 0; i < 2; i++) expect((await send(c, ch.id, `ещё ${i}`)).ok).toBe(true);
    await hook({ flush: true });

    // ---- проверка агрегатов
    const r = await recap(a, srv.id, '2026-09');
    expect(r.status).toBe(200);
    const d = r.json;
    expect(d).toMatchObject({ period: '2026-09', kind: 'month', label: 'Сентябрь 2026', empty: false, server: { id: srv.id, name: 'Итоги QA' } });
    expect(d.available.months).toContain('2026-09');
    expect(d.available.years).toContain('2026');
    expect(d.totals).toEqual({
      voiceMinutes: 575, voiceHours: 9.6, sessions: 5, messages: 8, attachments: 1,
      streamMinutes: 30, streamViewersPeak: 1, peakUsers: 3, peakAt: T0 + 120 * MIN, newMembers: 2,
      music: { plays: 4, manual: 3, autoplay: 1, minutes: 15 },
      watch: { videos: 1, minutes: 25 },
    });
    expect(d.busiestDay).toEqual({ date: '2026-09-13', voiceMinutes: 420, messages: 6 });
    expect(d.busiestHour).toEqual({ hour: 1, voiceMinutes: 180, messages: 0 });
    expect(d.hours[23]).toBe(120); expect(d.hours[0]).toBe(120); expect(d.hours[1]).toBe(180); expect(d.hours[2]).toBe(120); expect(d.hours[20]).toBe(35);
    expect(d.topTracks).toEqual([
      { title: 'Song A', artist: 'Artist X', plays: 2 },
      { title: 'Auto Song', artist: 'Artist Y', plays: 1 },
      { title: 'Song B', artist: 'Artist X', plays: 1 },
    ]);
    expect(d.topArtists).toEqual([{ name: 'Artist X', plays: 3 }, { name: 'Artist Y', plays: 1 }]);
    expect(d.topVideos).toEqual([{ title: 'QA Watch One', views: 1 }]);
    const award = Object.fromEntries(d.awards.map((x) => [x.id, [x.user.id, x.value]]));
    expect(award).toEqual({
      voice: [a.user.id, 265], night: [a.user.id, 181], dj: [b.user.id, 2], director: [a.user.id, 30],
      chatter: [b.user.id, 3], cinephile: [a.user.id, 25], marathon: [a.user.id, 240],
    });
    expect(d.awards.find((x) => x.id === 'voice').title).toBe('Голос сервера');
    expect(d.awards.find((x) => x.id === 'night').title).toBe('Ночная смена');
    expect(d.leaderboards.voice.map((x) => [x.user.id, x.value])).toEqual([[a.user.id, 265], [b.user.id, 180]]);
    expect(d.leaderboards.messages.map((x) => [x.user.id, x.value])).toEqual([[b.user.id, 3], [a.user.id, 1]]);
    expect(JSON.stringify(d)).not.toContain(c.user.id); // отказавшегося нет нигде, кроме общих сумм
    expect(d.me).toMatchObject({ participate: true, stats: { voiceMinutes: 265, longestSessionMinutes: 240, messages: 1, tracksAdded: 1, streamMinutes: 30, watchMinutes: 25 } });
    expect(d.settings).toEqual({ announce: true, canManage: true });

    const rc = (await recap(c, srv.id, '2026-09')).json;
    expect(rc.me).toMatchObject({ participate: false, stats: null });
    expect(rc.settings.canManage).toBe(false);
    // год = сумма месяцев
    const y = (await recap(b, srv.id, '2026')).json;
    expect(y).toMatchObject({ period: '2026', kind: 'year', label: '2026 год' });
    expect(y.totals.voiceMinutes).toBe(575);
    expect(y.totals.messages).toBe(8);
    // пустой месяц
    const e = (await recap(b, srv.id, '2026-08')).json;
    expect(e.empty).toBe(true);
    expect(e.awards).toEqual([]);

    // файл статистики: без текста сообщений, без ЛС, отказавшегося нет в личных записях
    const raw = fs.readFileSync(path.join(MUSIC_DATA_DIR, 'stats.json'), 'utf8');
    expect(raw).not.toContain('секретный текст');
    expect(raw).not.toContain('личное');
    expect(raw).not.toContain(dm.id);
    expect(raw).not.toContain(c.user.id);
    const file = JSON.parse(raw);
    expect(Object.keys(file.servers[srv.id].months)).toEqual(['2026-09']);

    // c снова участвует — с этого момента его считают (прошлое не возвращается)
    expect((await M.http('PUT', '/api/me/recap', { token: c.token, body: { participate: true } })).json.participate).toBe(true);
  });

  test('API: права, валидация, бот, кэш-заголовки, настройки объявлений', async () => {
    const { a, b, srv } = S;
    const outsider = await user('rco');
    expect((await recap(outsider, srv.id, '2026-09')).status).toBe(404);
    expect((await M.http('GET', `/api/servers/${srv.id}/recap`)).status).toBe(401);
    expect((await M.http('GET', '/api/servers/nope/recap', { token: a.token })).status).toBe(404);
    for (const p of ['2026-13', '26-01', 'abc', '2026-1']) expect((await recap(a, srv.id, p)).status, p).toBe(400);
    expect((await M.http('GET', `/api/servers/${srv.id}/recap`, { token: 'Bot ' + botToken(MUSIC_DATA_DIR) })).status).toBe(403);
    const ok = await recap(b, srv.id);
    expect(ok.status).toBe(200);
    expect(ok.json.kind).toBe('month');
    expect(ok.headers.get('cache-control')).toMatch(/private/);
    // настройки объявлений: только MANAGE_SERVER
    const set = (who, body) => M.http('PUT', `/api/servers/${srv.id}/recap/settings`, { token: who.token, body });
    expect((await set(b, { announce: false })).status).toBe(403);
    expect((await set(a, { announce: 'нет' })).status).toBe(400);
    expect((await set(a, { announce: false })).json).toEqual({ announce: false });
    expect((await recap(a, srv.id, '2026-09')).json.settings.announce).toBe(false);
    expect((await set(a, { announce: true })).json).toEqual({ announce: true });
    expect((await M.http('PUT', '/api/me/recap', { token: a.token, body: { participate: 1 } })).status).toBe(400);
  });

  test('объявления: 1-го после 10:00 — один раз за месяц; в начале января — за год; выключенные не объявляются', async () => {
    test.setTimeout(60_000);
    await clock(at(2026, 9, 20, 12, 0));
    const o2 = await user('rca2'); const o3 = await user('rca3');
    const s2 = await createServer(o2, 'Объявления'); const s3 = await createServer(o3, 'Тишина');
    expect((await send(o2, textChannel(s2).id, 'активность')).ok).toBe(true);
    expect((await send(o3, textChannel(s3).id, 'активность')).ok).toBe(true);
    expect((await M.http('PUT', `/api/servers/${s3.id}/recap/settings`, { token: o3.token, body: { announce: false } })).status).toBe(200);
    const got2 = []; const got3 = [];
    o2.socket.on('message:new', (m) => { if (m.message.recap) got2.push(m.message); });
    o3.socket.on('message:new', (m) => { if (m.message.recap) got3.push(m.message); });

    await clock(at(2026, 10, 1, 9, 0));
    expect((await hook({ announce: true })).announced).toBe(0); // ночью/утром 1-го ещё рано
    await clock(at(2026, 10, 1, 12, 0));
    expect((await hook({ announce: true })).announced).toBeGreaterThanOrEqual(1);
    await expect.poll(() => got2.length).toBe(1);
    expect(got2[0].content).toBe('📊 Итоги сентября готовы — открыть');
    expect(got2[0].recap).toEqual({ serverId: s2.id, period: '2026-09' });
    expect(got2[0].system).toBe(true);
    expect(got2[0].author.isBot).toBe(true);
    expect(got2[0].channelId).toBe(textChannel(s2).id);
    // повторная проверка (и через день) — без дублей
    expect((await hook({ announce: true })).announced).toBe(0);
    await clock(at(2026, 10, 2, 15, 0));
    expect((await hook({ announce: true })).announced).toBe(0);

    // год — в первую неделю января; декабрь пуст — за месяц ничего
    await clock(at(2027, 1, 3, 12, 0));
    expect((await hook({ announce: true })).announced).toBeGreaterThanOrEqual(1);
    await expect.poll(() => got2.length).toBe(2);
    expect(got2[1].content).toBe('📊 Итоги 2026 года готовы — открыть');
    expect(got2[1].recap).toEqual({ serverId: s2.id, period: '2026' });
    expect((await hook({ announce: true })).announced).toBe(0);
    await sleep(300);
    expect(got3).toEqual([]);
    const file = JSON.parse(fs.readFileSync(path.join(MUSIC_DATA_DIR, 'stats.json'), 'utf8'));
    expect(file.announced[s2.id]).toEqual({ month: '2026-09', year: '2026' });
    expect(file.settings[s3.id]).toEqual({ announce: false });
    // история хранит объявление с кнопкой
    const hist = await ack(o2.socket, 'message:history', { channelId: textChannel(s2).id });
    expect(hist.messages.filter((m) => m.recap).map((m) => m.recap.period)).toEqual(['2026-09', '2026']);
    await clock(null);
  });

  async function pageFor(makePage, who, opts = {}) {
    const page = await makePage(opts);
    await page.goto(MUSIC_BASE_URL + '/');
    await page.evaluate((t) => localStorage.setItem('sozvon.token', t), who.token);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    return page;
  }

  test('UI: объявление → слайды, стрелки/кнопки/касание, PNG скачать и отправить в канал; кнопка в шапке и выбор периода', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { a, srv, ch } = S;
    await clock(at(2026, 10, 1, 12, 0));
    await hook({ announce: true }); // объявление для сервера сценария (было выключено во время прошлой проверки)
    await clock(null);
    const page = await pageFor(makePage, a, { name: 'A' });
    await page.locator(`.server-icon[data-server-id="${srv.id}"]`).click();
    await page.locator(`a.channel[data-channel-id="${ch.id}"]`).click();
    const open = page.locator('[data-recap-period="2026-09"]').last();
    await expect(open).toBeVisible();
    await open.click();
    const ov = page.locator('#recap');
    await expect(ov).toBeVisible();
    await expect(ov).toHaveAttribute('role', 'dialog');
    await expect(ov).toHaveAttribute('data-slide', 'intro');
    await expect(ov.locator('.recap-slide')).toContainText('Сентябрь 2026');
    await expect(ov.locator('.recap-period')).toHaveValue('2026-09');
    // стрелки
    await page.keyboard.press('ArrowRight');
    await expect(ov).toHaveAttribute('data-slide', 'hours');
    await expect(ov.locator('.recap-big')).toHaveText('9,6 ч');
    await page.keyboard.press('ArrowRight');
    await expect(ov).toHaveAttribute('data-slide', 'messages');
    await page.keyboard.press('ArrowLeft');
    await expect(ov).toHaveAttribute('data-slide', 'hours');
    // кнопка и касание
    await ov.locator('.recap-nav--next').click();
    await expect(ov).toHaveAttribute('data-slide', 'messages');
    const box = await ov.locator('.recap-stage').boundingBox();
    await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.9);
    await expect(ov).toHaveAttribute('data-slide', 'hours');
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);
    await expect(ov).toHaveAttribute('data-slide', 'messages');
    await page.keyboard.press('ArrowRight');
    await expect(ov).toHaveAttribute('data-slide', 'day');
    await expect(ov.locator('.recap-big')).toHaveText('13 сентября');
    // награды
    const kinds = [];
    for (let i = 0; i < 20; i++) {
      kinds.push(await ov.getAttribute('data-slide'));
      if (kinds[kinds.length - 1] === 'share') break;
      await page.keyboard.press('ArrowRight');
    }
    for (const k of ['award-voice', 'award-night', 'award-dj', 'award-director', 'award-chatter', 'award-cinephile', 'award-marathon', 'music', 'watch', 'streams', 'joins', 'me', 'share']) expect(kinds).toContain(k);
    await page.keyboard.press('Home');
    await expect(ov).toHaveAttribute('data-slide', 'intro');
    await page.keyboard.press('End');
    await expect(ov).toHaveAttribute('data-slide', 'share');
    await expect(ov.locator('.recap-counter')).toHaveText(`${kinds.length + 3} / ${kinds.length + 3}`) // + intro, hours, messages;
    await expect(ov.locator('#recap-participate')).toBeChecked();
    await expect(ov.locator('#recap-announce')).toBeChecked();
    await expect(ov.locator('.recap-card-preview')).toHaveAttribute('data-ready', '1');
    const size = await ov.locator('.recap-card-preview').evaluate((img) => [img.naturalWidth, img.naturalHeight]);
    expect(size).toEqual([1080, 1350]);
    // скачать PNG
    const [dl] = await Promise.all([page.waitForEvent('download'), ov.locator('[data-recap-action="download"]').click()]);
    expect(dl.suggestedFilename()).toBe('astra-itogi-2026-09.png');
    const png = fs.readFileSync(await dl.path());
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // отправить в канал
    const posted = waitEvent(a.socket, 'message:new', (d) => d.message.channelId === ch.id && d.message.attachments?.[0]?.type === 'image/png', 15000);
    await ov.locator('[data-recap-action="post"]').click();
    const msg = (await posted).message;
    expect(msg.content).toBe('📊 Итоги «Итоги QA» — Сентябрь 2026');
    const img = Buffer.from(await (await fetch(MUSIC_BASE_URL + msg.attachments[0].url)).arrayBuffer());
    expect([...img.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await expect(ov.locator('.recap-share-status')).toHaveText('Отправлено!');
    // Esc — закрыть
    await page.keyboard.press('Escape');
    await expect(ov).toHaveCount(0);

    // кнопка «Итоги» в шапке сервера, переключатель месяца/года
    await page.locator('#btn-recap').click();
    await expect(ov).toBeVisible();
    await expect(ov.locator('.recap-period option[value="2026-09"]')).toHaveCount(1);
    await ov.locator('.recap-period').selectOption('2026');
    await expect(ov.locator('.recap-slide')).toContainText('2026 год');
    await ov.locator('[data-recap-action="close"]').click();
    await expect(ov).toHaveCount(0);
  });

  test('UI: телефон и «меньше движения» — без анимаций, без горизонтальной прокрутки', async ({ makePage }) => {
    const { a, srv } = S;
    const page = await pageFor(makePage, a, { name: 'mobile', viewport: { width: 390, height: 844 }, context: { reducedMotion: 'reduce', hasTouch: true, isMobile: true } });
    await page.evaluate((sid) => import('/js/ui/recap.js').then((m) => m.openRecap(sid, '2026-09')), srv.id);
    const ov = page.locator('#recap');
    await expect(ov).toHaveAttribute('data-slide', 'intro');
    await ov.locator('.recap-nav--next').tap();
    await expect(ov).toHaveAttribute('data-slide', 'hours');
    expect(await ov.locator('.recap-slide.is-animated').count()).toBe(0);
    const overflow = await page.evaluate(() => {
      const r = document.querySelector('#recap');
      return { page: document.documentElement.scrollWidth - innerWidth, recap: r.scrollWidth - r.clientWidth };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.recap).toBeLessThanOrEqual(0);
    await expect(ov.locator('.recap-nav--prev')).toBeVisible();
    await page.keyboard.press('End');
    const shareOverflow = await page.evaluate(() => document.querySelector('.recap-stage').scrollWidth - document.querySelector('.recap-stage').clientWidth);
    expect(shareOverflow).toBeLessThanOrEqual(0);
  });
});
