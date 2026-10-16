// v2 §4: музыка по ссылкам Spotify / YouTube — на отдельном стенде (tests/start-server-music.js):
// фейковый yt-dlp (tests/fixtures/fake-yt-dlp.mjs, лог вызовов в YTDLP_LOG) и фейковый Spotify embed.
import fs from 'node:fs';
import { test, expect } from './fixtures/ui.js';
import { apiAt, ack, waitEvent, createServer, textChannel, voiceChannel, sleep } from './fixtures/api.js';
import { MUSIC_BASE_URL, MUSIC_DATA_DIR, YTDLP_LOG } from './fixtures/env.js';

const M = apiAt(MUSIC_BASE_URL, MUSIC_DATA_DIR);
const SP_THREE = 'https://open.spotify.com/playlist/qaThree000000000000000?si=0123abcd';
const SP_FAIL = 'https://open.spotify.com/intl-de/playlist/qaWithFail000000000000';
const SP_TOP50 = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const SP_ALBUM = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy';
const SP_TRACK_URI = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
const YT_PL = 'https://www.youtube.com/playlist?list=PLqaThree';
const YT_PL_FAIL = 'https://www.youtube.com/playlist?list=PLqaWithFail';
const YT_VIDEO = 'https://www.youtube.com/watch?v=qaVid000004';

function ytCalls() {
  try { return fs.readFileSync(YTDLP_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

const sockets = [];
test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } } });

let bot;
test.beforeAll(async () => { bot = await M.startBot(); });
test.afterAll(async () => { await bot?.stop(); });

async function room() {
  const a = await M.makeUser('mz'); sockets.push(a.socket);
  const srv = await createServer(a, 'Музыка v2');
  const ch = textChannel(srv); const vc = voiceChannel(srv);
  expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
  const states = [];
  a.socket.on('music:state', (d) => { if (d.channelId === vc.id) states.push(d); });
  const botMsgs = [];
  a.socket.on('message:new', (d) => { if (d.message?.author?.isBot && d.message.channelId === ch.id) botMsgs.push(d.message.content); });
  const send = (content) => ack(a.socket, 'message:send', { channelId: ch.id, content });
  const waitState = (pred, ms = 30000) => {
    const last = states[states.length - 1];
    if (last && pred(last)) return Promise.resolve(last);
    return waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && pred(d), ms).catch((e) => {
      const l = states[states.length - 1];
      throw new Error(`${e.message}: условие ${pred.toString().slice(0, 120)}; последнее состояние: track=${l?.track?.title} queue=${l?.queue?.length} [${(l?.queue || []).slice(0, 3).map((q) => q.title + (q.pending ? '(p)' : '')).join('; ')}]; бот: ${botMsgs.slice(-4).join(' || ')}`);
    });
  };
  const waitBot = (re, ms = 30000) => {
    const hit = botMsgs.find((m) => re.test(m));
    if (hit) return Promise.resolve(hit);
    return waitEvent(a.socket, 'message:new', (d) => d.message?.author?.isBot && d.message.channelId === ch.id && re.test(d.message.content), ms).then((d) => d.message.content);
  };
  return { a, srv, ch, vc, send, waitState, waitBot, states, botMsgs };
}

const title = (s) => (s.track ? s.track.title : '');
function expectPending(items, label) {
  for (const q of items) {
    expect(q.pending, `${label}: pending:true у «${q.title}»`).toBe(true);
    expect(q.url, `${label}: у ожидающего нет url`).toBeUndefined();
    expect(typeof q.title).toBe('string');
    expect(q.title.length).toBeGreaterThan(0);
  }
}

test.describe('v2 музыка: Spotify', () => {
  test('!play <spotify playlist> → очередь с pending → играет первый → !skip → второй', async () => {
    test.setTimeout(120_000);
    const r = await room();
    const before = ytCalls().length;
    await r.send(`!play ${SP_THREE}`);
    const added = await r.waitBot(/Добавил в очередь \d+ трек/);
    expect(added).toMatch(/Добавил в очередь 3 трек/);
    expect(added).toContain('QA Spotify Three');

    // сначала — очередь из ожидающих элементов (до скачивания первого)
    const withPending = await r.waitState((s) => (s.queue || []).some((q) => q.pending));
    expectPending(withPending.queue.filter((q) => q.pending), 'spotify');
    const allTitles = r.states.flatMap((s) => [title(s), ...(s.queue || []).map((q) => q.title)]).join(' | ');
    expect(allTitles).toContain('Nicole Kidman');
    const pend = withPending.queue.find((q) => q.title === 'Nicole Kidman');
    expect(pend.source).toBe('spotify');
    expect(pend.artist).toContain('ADÉLA');
    expect(pend.duration).toBeGreaterThanOrEqual(180);

    // играет первый трек плейлиста
    const s1 = await r.waitState((s) => /expectations/i.test(title(s)), 60000);
    expect(s1.track.url).toMatch(/^\/media\/music\//);
    expect(s1.track.pending).toBeFalsy();
    // выбран результат поиска с длительностью в пределах ±15 с (223.9 с у Spotify), а не «1 hour loop» (+60 с)
    expect(Math.abs(s1.track.duration - 224)).toBeLessThanOrEqual(15);
    expect(s1.queue.length).toBe(2);
    expect(s1.queue.every((q) => q.pending || q.url), 'элементы очереди: pending без url или готовые').toBe(true);
    const calls = ytCalls().slice(before);
    const searches = calls.filter((c) => c.argv.some((x) => /^ytsearch\d+:/.test(x)));
    expect(searches.length, 'поиск через ytsearchN:').toBeGreaterThan(0);
    expect(searches[0].argv.find((x) => /^ytsearch/.test(x))).toMatch(/Olivia Rodrigo.*expectations/i);
    expect(calls.some((c) => c.result === 'download'), 'скачивание первого трека').toBe(true);

    // медиа реально отдаётся
    const media = await M.http('GET', s1.track.url, { raw: true });
    expect(media.status).toBe(200);

    await r.send('!skip');
    const s2 = await r.waitState((s) => /Nicole Kidman/.test(title(s)), 60000);
    expect(s2.track.url).toMatch(/^\/media\/music\//);
    expect(s2.queue.length).toBe(1);
    await r.send('!stop');
    await r.waitState((s) => s.track === null);
  });

  test('реальная embed-страница: плейлист 50 треков, альбом, трек по spotify: URI', async () => {
    test.setTimeout(120_000);
    const r = await room();
    const n50 = ytCalls().length;
    await r.send(`!play ${SP_TOP50}`);
    expect(await r.waitBot(/Добавил в очередь \d+ трек/)).toMatch(/Добавил в очередь 50 трек/);
    const s = await r.waitState((x) => (x.queue || []).length + (x.track ? 1 : 0) >= 50 && x.track, 60000);
    expect(s.queue.length).toBe(49);
    expectPending(s.queue.slice(2).filter((q) => q.pending), 'top50');
    expect(s.queue.filter((q) => q.pending).length, 'большинство элементов ждут (ленивая очередь)').toBeGreaterThan(40);
    await sleep(1500);
    const searches50 = ytCalls().slice(n50).filter((c) => c.argv.some((x) => /^(yt|sc)search/.test(x)));
    expect(searches50.length, 'ленивая очередь: ищется текущий + предзагрузка следующего, не весь плейлист').toBeLessThanOrEqual(4);
    await r.send('!stop');
    await r.waitState((x) => x.track === null);
    // после !stop новые поиски/скачивания для выброшенной очереди не запускаются
    await sleep(800);
    const afterStop = ytCalls().length;
    await sleep(2500);
    expect(ytCalls().slice(afterStop), 'после !stop yt-dlp больше не вызывается').toEqual([]);

    await r.send(`!play ${SP_ALBUM}`);
    expect(await r.waitBot(/Добавил в очередь 18 трек/)).toBeTruthy();
    await r.waitState((x) => /Global Warming/.test(title(x)), 60000);
    await r.send('!stop');
    await r.waitState((x) => x.track === null);

    const before = ytCalls().length;
    await r.send(`!play ${SP_TRACK_URI}`);
    const st = await r.waitState((x) => /Never Gonna Give You Up/i.test(title(x)), 60000);
    expect(Math.abs(st.track.duration - 214)).toBeLessThanOrEqual(15);
    expect(ytCalls().length).toBeGreaterThan(before);
    await r.send('!stop');
    await r.waitState((x) => x.track === null);
    // повтор того же Spotify-трека — из кэша, без yt-dlp
    const before2 = ytCalls().length;
    await r.send('!play https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    await r.waitState((x) => /Never Gonna Give You Up/i.test(title(x)), 30000);
    await sleep(500);
    // (фоновые предзагрузки прошлых очередей не считаем — только поиск/скачивание этого трека)
    expect(ytCalls().slice(before2).filter((c) => /Never Gonna/i.test(JSON.stringify(c.argv) + (c.title || ''))), 'повтор Spotify-трека не вызывает yt-dlp').toEqual([]);
    await r.send('!stop');
  });

  test('ошибка одного трека Spotify-плейлиста → сообщение и следующий', async () => {
    test.setTimeout(120_000);
    const r = await room();
    await r.send(`!play ${SP_FAIL}`);
    await r.waitBot(/Добавил в очередь 3 трек/);
    await r.waitState((s) => /expectations/i.test(title(s)), 60000);
    await r.send('!skip');
    const err = await r.waitBot(/Не получилось включить/, 60000);
    expect(err).toContain('QA FAIL Song Nobody Has');
    await r.waitState((s) => /Stop The Wedding/i.test(title(s)), 60000);
    await r.send('!stop');
  });

  test('несуществующий плейлист Spotify → понятная ошибка, бот не падает', async () => {
    const r = await room();
    await r.send('!play https://open.spotify.com/playlist/00000000000000000000zz');
    const msg = await r.waitBot(/Spotify|плейлист|не удалось|не получилось|не найден/i);
    expect(msg).not.toMatch(/undefined|TypeError|\[object/);
    expect((await M.http('GET', '/api/config')).json.botOnline).toBe(true);
  });
});

test.describe('v2 музыка: YouTube', () => {
  test('!play <youtube playlist> → 3 трека, pending, играет первый, !skip → второй', async () => {
    test.setTimeout(120_000);
    const r = await room();
    const before = ytCalls().length;
    await r.send(`!play ${YT_PL}`);
    expect(await r.waitBot(/Добавил в очередь \d+ трек/)).toMatch(/Добавил в очередь 3 трек/);
    const s1 = await r.waitState((s) => title(s) === 'QA Tube One', 60000);
    expect(s1.queue.map((q) => q.title)).toEqual(['QA Tube Two', 'QA Tube Three']);
    const pendingSeen = r.states.flatMap((s) => s.queue || []).filter((q) => q.pending);
    expect(pendingSeen.length, 'элементы плейлиста были pending').toBeGreaterThan(0);
    expectPending(pendingSeen, 'youtube');
    expect(pendingSeen[0].source).toBe('youtube');
    const pl = ytCalls().slice(before).find((c) => c.argv.some((x) => x.includes('list=PLqaThree')));
    expect(pl.argv, 'плейлист разбирается через -J --flat-playlist').toEqual(expect.arrayContaining(['-J', '--flat-playlist']));
    await r.send('!skip');
    await r.waitState((s) => title(s) === 'QA Tube Two', 60000);
    await r.send('!stop');
  });

  test('повтор того же видео не вызывает yt-dlp; youtu.be и shorts — тот же кэш', async () => {
    test.setTimeout(90_000);
    const r = await room();
    const before = ytCalls().length;
    await r.send(`!play ${YT_VIDEO}`);
    const s = await r.waitState((x) => title(x) === 'QA Tube Four Single', 60000);
    expect(s.track.url).toMatch(/^\/media\/music\//);
    const first = ytCalls().slice(before);
    expect(first.filter((c) => c.result === 'download' && c.id === 'qaVid000004').length, 'первый раз — одно скачивание').toBe(1);
    await r.send('!stop');
    await r.waitState((x) => x.track === null);

    for (const url of [YT_VIDEO, 'https://youtu.be/qaVid000004', 'https://www.youtube.com/shorts/qaVid000004', 'https://music.youtube.com/watch?v=qaVid000004&si=x']) {
      const n = ytCalls().length;
      await r.send(`!play ${url}`);
      await r.waitState((x) => title(x) === 'QA Tube Four Single', 30000);
      await sleep(300);
      expect(ytCalls().slice(n).filter((c) => c.argv.some((x) => x.includes('qaVid000004'))), `повтор ${url} не вызывает yt-dlp`).toEqual([]);
      await r.send('!stop');
      await r.waitState((x) => x.track === null);
    }
    // в библиотеке один экземпляр
    const lib = await M.http('GET', '/api/music', { token: r.a.token });
    const tracks = lib.json.tracks || lib.json;
    expect(tracks.filter((t) => t.title === 'QA Tube Four Single')).toHaveLength(1);
  });

  test('ошибка одного видео плейлиста → «Не получилось включить» и следующий', async () => {
    test.setTimeout(120_000);
    const r = await room();
    await r.send(`!play ${YT_PL_FAIL}`);
    await r.waitBot(/Добавил в очередь 3 трек/);
    await r.waitState((s) => title(s) === 'QA Tube One', 60000);
    await r.send('!skip');
    const err = await r.waitBot(/Не получилось включить/, 60000);
    expect(err).toContain('QA Tube Broken');
    expect(err).toMatch(/Video unavailable|недоступ/i);
    await r.waitState((s) => title(s) === 'QA Tube Three', 60000);
    await r.send('!stop');
  });

  test('текстовый поиск без совпадения в библиотеке → yt-dlp ytsearch; ничего не нашёл → понятный ответ', async () => {
    test.setTimeout(90_000);
    const r = await room();
    const n = ytCalls().length;
    await r.send('!play Rick Astley Never Gonna Give You Up');
    await r.waitState((x) => /Never Gonna Give You Up/i.test(title(x)), 60000);
    await r.send('!stop');
    await r.waitState((x) => x.track === null);
    await r.send('!play zzqx nothing matches this qa query');
    await r.waitBot(/Ничего не нашёл/i, 60000);
    const searches = ytCalls().slice(n).flatMap((c) => c.argv).filter((x) => /^(yt|sc)search\d*:/.test(x));
    expect(searches.some((x) => x.startsWith('ytsearch')), 'искали на YouTube').toBe(true);
    expect(searches.some((x) => x.startsWith('scsearch')), 'и на SoundCloud (MUSIC_SEARCH_SOURCES)').toBe(true);
  });
});

test.describe('v2 музыка: UI с ожидающими элементами', () => {
  test('плеер показывает трек из Spotify-плейлиста, очередь с pending не ломает UI', async ({ makePage }) => {
    test.setTimeout(120_000);
    const page = await makePage();
    const reg = await M.registerApi();
    await page.goto(MUSIC_BASE_URL + '/');
    await page.evaluate((t) => localStorage.setItem('sozvon.token', t), reg.token);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await page.locator('#btn-add-server').click();
    const modal = page.locator('#modal-server');
    await modal.locator('input:not([type=hidden]):not([type=file])').locator('visible=true').first().fill('UI музыка');
    await modal.locator('.btn--primary').locator('visible=true').first().click();
    await page.locator('a.channel[data-type="voice"]').first().click();
    await page.waitForTimeout(300);
    const join = page.locator('#voice-join button');
    if (await join.isVisible().catch(() => false)) await join.first().click();
    await expect(page.locator('#voice-panel')).toBeVisible();
    await page.locator('a.channel[data-type="text"]').first().click();
    await page.locator('#composer-input').fill(`!play ${SP_THREE}`);
    await page.locator('#composer-input').press('Enter');
    await expect(page.locator('#music-player')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#music-player .music-player__title')).toContainText(/expectations/i, { timeout: 60000 });
    await expect.poll(() => page.evaluate(() => { const a = document.querySelector('audio#music-audio'); return a && !a.paused && a.currentTime > 0; }),
      { timeout: 20000 }).toBe(true);
    // громкость бота из контекстного меню → prefs audio.musicVolume и громкость плеера
    const botRow = page.locator('.voice-users .voice-user').filter({ has: page.locator('.badge--bot') });
    await expect(botRow).toHaveCount(1);
    await botRow.click({ button: 'right' });
    const mv = page.locator('.context-menu').locator('visible=true').locator('input[type=range][data-action="music-volume"]');
    await expect(mv).toBeVisible();
    await expect(page.locator('.context-menu').locator('visible=true').locator('[data-action="user-volume"]')).toHaveCount(0);
    await mv.fill('30');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sozvon.prefs') || '{}')['audio.musicVolume'])).toBe(30);
    await expect(page.locator('#music-volume')).toHaveValue('30');
    const before = await page.evaluate(() => document.querySelector('#music-audio').volume);
    await mv.fill('90');
    await expect.poll(() => page.evaluate(() => document.querySelector('#music-audio').volume), { message: 'громкость плеера растёт' }).toBeGreaterThan(before);
    await page.keyboard.press('Escape');
    await page.locator('#composer-input').fill('!stop');
    await page.locator('#composer-input').press('Enter');
    await expect(page.locator('#music-player')).toBeHidden({ timeout: 15000 });
  });
});
