// v21: обложки треков (server/covers.js), эквалайзер музыки (public/js/audio/music-eq.js), «Сейчас слушает» /
// «Слушать вместе» (public/js/ui/listening.js).
// Обложки ищутся у фейкового сервера (tests/fixtures/fake-covers.js): миниатюры, Deezer, iTunes — без интернета.
// Стенд музыки v2 (tests/start-server-music.js); свои видео qaCov0000NN и плейлист PLqaCov (fake-yt-dlp).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { test, expect } from './fixtures/ui.js';
import { apiAt, ack, waitEvent, createServer, textChannel, voiceChannel, sleep } from './fixtures/api.js';
import { MUSIC_BASE_URL, MUSIC_DATA_DIR, COVERS_FAKE_BASE, COVERS_LOG } from './fixtures/env.js';

const M = apiAt(MUSIC_BASE_URL, MUSIC_DATA_DIR);
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const COVER_RE = /^\/media\/covers\/[a-f0-9]{20}\.jpg$/;
const P = { VIEW_CHANNEL: 1 << 7, CONNECT: 1 << 12, USE_MUSIC_BOT: 1 << 18 };
const DEFAULT_EVERYONE = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 12) | (1 << 13) | (1 << 14) | P.USE_MUSIC_BOT;

const sockets = [];
test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } } });

const coverLog = () => {
  try { return fs.readFileSync(COVERS_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
/** Размер JPEG по маркеру SOF */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
const rnd = () => Math.random().toString(36).slice(2, 8);

/* =====================================================================================
   1. Модуль обложек (в процессе теста): порядок источников, кэш, отрицательный кэш, лимит, выключение, раздача
   ===================================================================================== */
test.describe('обложки: server/covers.js', () => {
  let C;
  let dir;
  let cdir;
  let srv;
  let base;
  const saved = {};
  const ENV = {
    COVERS_DEEZER_BASE: `${COVERS_FAKE_BASE}/deezer`, COVERS_ITUNES_BASE: `${COVERS_FAKE_BASE}/itunes`,
    COVERS_IMAGE_HOSTS: '127.0.0.1', COVERS_MIN_INTERVAL_MS: '0', COVERS: '1', COVERS_MAX_PER_HOUR: '1000', COVERS_PROXY: '',
  };
  test.beforeAll(async () => {
    for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; process.env[k] = ENV[k]; }
    C = await import('../server/covers.js');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-covers-'));
    cdir = C.initCovers(dir); // DATA_DIR/covers
    const app = express();
    app.get('/media/covers/:file', C.serveCover);
    srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  test.afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((r) => srv?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test.beforeEach(() => { for (const k of Object.keys(ENV)) process.env[k] = ENV[k]; C._resetCoversForTests(); });

  const idOf = (url) => url.match(/([a-f0-9]{20})\.jpg$/)[1];
  const stored = (id) => fs.readFileSync(path.join(cdir, `${id}.jpg`));

  test('порядок: миниатюра источника → Deezer → iTunes; результат 300×300 JPEG, повтор — из кэша', async () => {
    const tag = rnd();
    // 1) своя миниатюра: Deezer/iTunes не спрашиваем
    const u1 = C.coverUrl(`youtube:qaU1${tag}`, { artist: 'QA', title: `qadeezerhit thumb ${tag}`, thumbs: [`${COVERS_FAKE_BASE}/img/thumb-u1-${tag}.jpg`] });
    expect(u1).toMatch(COVER_RE);
    expect(await C.ensureCover(idOf(u1), C.coverInfo(idOf(u1)))).toBe('hit');
    let log = coverLog().filter((l) => l.path.includes(tag) || l.q.includes(tag));
    expect(log.map((l) => l.path)).toEqual([`/img/thumb-u1-${tag}.jpg`]);
    expect(jpegSize(stored(idOf(u1)))).toEqual({ w: 300, h: 300 });
    // повтор — с диска, без запросов
    expect(await C.ensureCover(idOf(u1), C.coverInfo(idOf(u1)))).toBe('cached');
    expect(coverLog().filter((l) => l.path.includes(tag) || l.q.includes(tag))).toHaveLength(1);

    // 2) миниатюра не открылась (404) → Deezer
    const t2 = rnd();
    const u2 = C.coverUrl(`youtube:qaU2${t2}`, { artist: 'QA Artist', title: `Song qadeezerhit ${t2} (Official Video)`, thumbs: [`${COVERS_FAKE_BASE}/img/missing-${t2}.jpg`] });
    expect(await C.ensureCover(idOf(u2), C.coverInfo(idOf(u2)))).toBe('hit');
    log = coverLog().filter((l) => l.path.includes(t2) || l.q.includes(t2));
    expect(log.map((l) => l.path)).toEqual([`/img/missing-${t2}.jpg`, '/deezer/search', `/img/deezer-qa-artist-song-qadeezerhit-${t2}.jpg`]);
    // мусор из названия не уходит в поиск, исполнитель — уходит
    expect(log[1].q).toBe(`qa artist song qadeezerhit ${t2}`);

    // 3) Deezer пусто → iTunes, artworkUrl100 → 600x600bb
    const t3 = rnd();
    const u3 = C.coverUrl(C.titleCoverKey('QA', `qaituneshit ${t3}`), { artist: 'QA', title: `qaituneshit ${t3}` });
    expect(await C.ensureCover(idOf(u3), C.coverInfo(idOf(u3)))).toBe('hit');
    log = coverLog().filter((l) => l.path.includes(t3) || l.q.includes(t3));
    expect(log.map((l) => l.path)).toEqual(['/deezer/search', '/itunes/search', `/img/itunes-qa-qaituneshit-${t3}/600x600bb.jpg`]);

    // 4) Deezer нашёл другого исполнителя → не берём, iTunes; Deezer 500 → iTunes; «не картинка» → iTunes
    for (const mark of ['qadeezerwrong', 'qadeezerfail', 'qabadimage']) {
      const t = rnd();
      const u = C.coverUrl(C.titleCoverKey('QA Real', `${mark} ${t}`), { artist: 'QA Real', title: `${mark} ${t}` });
      expect(await C.ensureCover(idOf(u), C.coverInfo(idOf(u))), mark).toBe('hit');
      const paths = coverLog().filter((l) => l.path.includes(t) || l.q.includes(t)).map((l) => l.path);
      expect(paths[paths.length - 1], mark).toBe(`/img/itunes-qa-real-${mark}-${t}/600x600bb.jpg`);
    }
    // редирект миниатюры на неразрешённый хост не выполняется → дальше Deezer
    const t5 = rnd();
    const u5 = C.coverUrl(`youtube:qaU5${t5}`, { artist: 'QA', title: `qadeezerhit redir ${t5}`, thumbs: [`${COVERS_FAKE_BASE}/img/redirect-${t5}.jpg`] });
    expect(await C.ensureCover(idOf(u5), C.coverInfo(idOf(u5)))).toBe('hit');
    expect(coverLog().filter((l) => l.path.includes(t5) || l.q.includes(t5)).map((l) => l.path))
      .toEqual([`/img/redirect-${t5}.jpg`, '/deezer/search', `/img/deezer-qa-qadeezerhit-redir-${t5}.jpg`]);
    expect(coverLog().some((l) => l.path === '/img/after-redirect.jpg')).toBe(false);
    // чужой хост миниатюры не запрашивается (только COVERS_IMAGE_HOSTS)
    expect(C.allowedImageUrl('https://example.com/x.jpg')).toBe(false);
    expect(C.allowedImageUrl(`${COVERS_FAKE_BASE}/img/x.jpg`)).toBe(true);
    process.env.COVERS_IMAGE_HOSTS = '';
    expect(C.allowedImageUrl('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe(true); // по умолчанию — CDN источников
    expect(C.allowedImageUrl('https://evil.example/i.ytimg.com.jpg')).toBe(false);
  });

  test('нет обложки — отрицательный кэш (без повторных запросов); лимит запросов; поиск по названию', async () => {
    const t = rnd();
    const u = C.coverUrl(C.titleCoverKey('QA', `qanohit ${t}`), { artist: 'QA', title: `qanohit ${t}` });
    const id = idOf(u);
    expect(await C.ensureCover(id, C.coverInfo(id))).toBe('miss');
    expect(fs.existsSync(path.join(cdir, `${id}.miss`))).toBe(true);
    const n = coverLog().filter((l) => l.q.includes(t)).length;
    expect(n).toBe(2); // Deezer + iTunes
    expect(await C.ensureCover(id, C.coverInfo(id))).toBe('miss');
    expect(coverLog().filter((l) => l.q.includes(t)).length).toBe(n);
    // HTTP: 204 (картинки нет), а не 404 — <img> не пишет ошибку в консоль
    const r = await fetch(`${base}${u}`);
    expect(r.status).toBe(204);

    // лимит: не больше COVERS_MAX_PER_HOUR запросов к API, дальше — без сети, «нет» ненадолго
    C._resetCoversForTests();
    process.env.COVERS_MAX_PER_HOUR = '2';
    const t2 = rnd();
    const a = C.coverUrl(C.titleCoverKey('', `qanohit a ${t2}`), { title: `qanohit a ${t2}` });
    const b = C.coverUrl(C.titleCoverKey('', `qanohit b ${t2}`), { title: `qanohit b ${t2}` });
    await C.ensureCover(idOf(a), C.coverInfo(idOf(a)));
    await C.ensureCover(idOf(b), C.coverInfo(idOf(b)));
    expect(C.coverStats.apiCalls).toBe(2);
    expect(C.coverStats.limited).toBeGreaterThanOrEqual(2);
    expect(coverLog().filter((l) => l.q.includes(t2)).length).toBe(2);
    const miss = JSON.parse(fs.readFileSync(path.join(cdir, `${idOf(b)}.miss`), 'utf8'));
    expect(miss.until - Date.now()).toBeLessThan(16 * 60_000); // ошибка/лимит — помним 15 минут, а не сутки

    // разбор названий для поиска
    expect(C.searchTerms('', 'Artist - Song (Official Music Video) [HD]')).toEqual({ artist: 'Artist', title: 'Song' });
    expect(C.searchTerms('Chan, Other', 'Track feat. Someone')).toEqual({ artist: 'Chan', title: 'Track' });
  });

  test('раздача: 200 image/jpeg с nosniff/CSP и кэшем, плохое имя — 404, неизвестная — 204; COVERS=0 — выключено', async () => {
    const t = rnd();
    const u = C.coverUrl(`soundcloud:qa${t}`, { title: `x ${t}`, thumbs: [`${COVERS_FAKE_BASE}/img/sc-${t}.jpg`] });
    let r = await fetch(`${base}${u}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^image\/jpeg/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(r.headers.get('cache-control')).toContain('max-age=604800');
    expect(jpegSize(Buffer.from(await r.arrayBuffer()))).toEqual({ w: 300, h: 300 });
    expect((await fetch(`${base}/media/covers/..%2Fsecret.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/media/covers/ABC.jpg`)).status).toBe(404);
    // id правильный, но сервер его не выдавал — в интернет не идём
    const before = coverLog().length;
    r = await fetch(`${base}/media/covers/${'0'.repeat(20)}.jpg`);
    expect(r.status).toBe(204);
    expect(coverLog().length).toBe(before);

    // COVERS=0: адресов не выдаём, раздача пустая, поиска нет
    process.env.COVERS = '0';
    expect(C.coverUrl('youtube:whatever', { title: 'qadeezerhit off' })).toBeNull();
    expect(C.coversEnabled()).toBe(false);
    r = await fetch(`${base}${u}`); // даже сохранённую не отдаём
    expect(r.status).toBe(204);
    expect(await C.ensureCover('1'.repeat(20), { key: 'k', title: 'qadeezerhit off', thumbs: [] })).toBe('skipped');
  });
});

/* =====================================================================================
   2. Сервер: обложки у библиотеки, очереди, ожидающих элементов, Spotify, плейлистов; раздача без чужих адресов
   ===================================================================================== */
let bot;
test.describe('обложки, эквалайзер и «Сейчас слушает» с ботом', () => {
  test.beforeAll(async () => { bot = await M.startBot(); });
  test.afterAll(async () => { await bot?.stop(); });

  async function room(name) {
    const a = await M.makeUser('cov'); sockets.push(a.socket);
    const srv = await createServer(a, name);
    const ch = textChannel(srv); const vc = voiceChannel(srv);
    expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    const states = [];
    a.socket.on('music:state', (d) => { if (d.channelId === vc.id) states.push(d); });
    const send = (content) => ack(a.socket, 'message:send', { channelId: ch.id, content });
    const waitState = (pred, ms = 40000) => {
      const last = states[states.length - 1];
      if (last && pred(last)) return Promise.resolve(last);
      return waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && pred(d), ms);
    };
    return { a, srv, ch, vc, send, waitState, states };
  }

  test('очередь и библиотека: у треков и ожидающих элементов — только наш адрес обложки; один ключ до и после скачивания', async () => {
    test.setTimeout(120_000);
    const r = await room('Обложки v21');
    await r.send('!play https://www.youtube.com/playlist?list=PLqaCov');
    const st = await r.waitState((s) => s.track?.title === 'QA Cov Thumb' && s.queue.length >= 3);
    // никаких внешних адресов в состоянии музыки (кроме ссылок источника ref.url для «Сохранить как плейлист»)
    const raw = JSON.stringify({ ...st, queue: st.queue.map(({ ref, ...q }) => q) });
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toMatch(/ytimg|scdn|dzcdn|mzstatic/);
    expect(st.track.cover).toMatch(COVER_RE);
    for (const q of st.queue) expect(q.cover, q.title).toMatch(COVER_RE);

    // обложка с миниатюры yt-dlp, раздаётся без входа (как /media/music), 300×300
    let res = await M.http('GET', st.track.cover, { raw: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(jpegSize(Buffer.from(await res.arrayBuffer()))).toEqual({ w: 300, h: 300 });
    expect((await M.http('GET', st.track.url, { raw: true })).status).toBe(200); // музыка — тоже без входа
    expect(coverLog().some((l) => l.path === '/img/thumb-qaCov000001.jpg')).toBe(true);
    expect(coverLog().some((l) => l.q.includes('qa cov thumb'))).toBe(false); // Deezer/iTunes не понадобились

    // ожидающие: Deezer / iTunes / нет обложки (204)
    const byTitle = (t) => st.queue.find((q) => q.title === t);
    res = await M.http('GET', byTitle('QA Cov qadeezerhit Song').cover, { raw: true });
    expect(res.status).toBe(200);
    res = await M.http('GET', byTitle('QA Cov qaituneshit Song').cover, { raw: true });
    expect(res.status).toBe(200);
    expect(coverLog().some((l) => /^\/img\/itunes-.*qaituneshit.*\/600x600bb\.jpg$/.test(l.path))).toBe(true);
    res = await M.http('GET', byTitle('QA Cov qanohit Song').cover, { raw: true });
    expect(res.status).toBe(204);

    // библиотека: скачанный трек — тот же адрес обложки, что был у ожидающего элемента
    const pendingCover = byTitle('QA Cov qadeezerhit Song').cover;
    await r.send('!skip');
    const st2 = await r.waitState((s) => s.track?.title === 'QA Cov qadeezerhit Song', 60000);
    expect(st2.track.cover).toBe(pendingCover);
    const lib = await M.http('GET', '/api/music', { token: r.a.token });
    const t1 = lib.json.tracks.find((t) => t.title === 'QA Cov Thumb');
    expect(t1.cover).toBe(st.track.cover);
    expect(JSON.stringify(lib.json)).not.toMatch(/ytimg|127\.0\.0\.1|thumb-/); // миниатюра источника клиенту не уходит
    // REST resolve: ожидающие элементы тоже с нашим адресом
    const rs = await M.http('POST', '/api/music/resolve', { token: r.a.token, body: { input: 'https://www.youtube.com/playlist?list=PLqaCov' } });
    expect(rs.status).toBe(200);
    for (const it of rs.json.items) expect(it.cover).toMatch(COVER_RE);

    // плейлист сервера: обложки у элементов
    const created = await M.http('POST', `/api/servers/${r.srv.id}/playlists`, { token: r.a.token, body: { name: 'С обложками' } });
    const pid = created.json.playlist.id;
    await M.http('POST', `/api/servers/${r.srv.id}/playlists/${pid}/items`, { token: r.a.token, body: { trackId: t1.id } });
    const add = await M.http('POST', `/api/servers/${r.srv.id}/playlists/${pid}/items`, {
      token: r.a.token, body: { item: { pending: true, title: 'QA Cov qaituneshit Song', artist: 'QA Cov', duration: 30, source: 'youtube', ref: { url: yt('qaCov000003'), key: 'youtube:qaCov000003' } } },
    });
    expect(add.status).toBe(200);
    expect(add.json.playlist.items[0].cover).toBe(t1.cover);
    expect(add.json.playlist.items[1].cover).toBe(byTitle('QA Cov qaituneshit Song').cover);
    await r.send('!stop');
  });

  test('Spotify: обложка альбома из embed-страницы, без Deezer/iTunes', async () => {
    const u = await M.makeUser('spc'); sockets.push(u.socket);
    const rs = await M.http('POST', '/api/music/resolve', { token: u.token, body: { input: 'https://open.spotify.com/album/qaCoverAlbum0000000000' } });
    expect(rs.status).toBe(200);
    expect(rs.json.items).toHaveLength(2);
    const covers = rs.json.items.map((i) => i.cover);
    for (const c of covers) expect(c).toMatch(COVER_RE);
    expect(covers[0]).not.toBe(covers[1]); // свой ключ у каждого трека (spotify:<id>)
    const titles = rs.json.items.map((i) => i.title.toLowerCase());
    const res = await M.http('GET', covers[0], { raw: true });
    expect(res.status).toBe(200);
    expect(coverLog().some((l) => l.path === '/img/spotify-album-qacover.jpg')).toBe(true);
    expect(coverLog().some((l) => l.path.endsWith('/search') && titles.some((t) => l.q.includes(t.split(' ')[0])))).toBe(false);
  });

  /* ---------- UI ---------- */
  async function openAs(makePage, user, opts = {}) {
    const page = await makePage(opts);
    await page.goto(MUSIC_BASE_URL + '/');
    await page.evaluate((t) => localStorage.setItem('sozvon.token', t), user.token);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    return page;
  }
  const openServer = async (page, sid) => {
    await page.locator(`[data-server-id="${sid}"]`).first().click();
    await expect(page.locator('#members')).toBeVisible();
  };
  async function joinVoicePage(page, vcId) {
    await page.locator(`a.channel[data-channel-id="${vcId}"]`).click();
    await page.waitForTimeout(300);
    const join = page.locator('#voice-join button');
    if (await join.isVisible().catch(() => false)) await join.first().click();
    await expect(page.locator('#voice-panel')).toBeVisible();
  }

  test('UI: обложка в плеере, очереди и библиотеке; Media Session с нашей обложкой; без ошибок в консоли', async ({ makePage }) => {
    test.setTimeout(120_000);
    const owner = await M.makeUser('cui'); sockets.push(owner.socket);
    const srv = await createServer(owner, 'Обложки UI');
    const page = await openAs(makePage, owner);
    await openServer(page, srv.id);
    await joinVoicePage(page, voiceChannel(srv).id);
    await ack(owner.socket, 'message:send', { channelId: textChannel(srv).id, content: '!play https://www.youtube.com/playlist?list=PLqaCov' });
    await expect(page.locator('#music-player .music-player__title')).toHaveText('QA Cov Thumb', { timeout: 60000 });
    const art = page.locator('#music-player .music-player__art');
    await expect(art).toHaveClass(/has-img/, { timeout: 20000 });
    expect(await art.locator('img.cover__img').evaluate((i) => [i.naturalWidth, new URL(i.src).origin === location.origin, i.getAttribute('src')]))
      .toEqual([300, true, expect.stringMatching(COVER_RE)]);
    // Media Session: название и обложка (наш адрес) — для системного оверлея
    await expect.poll(() => page.evaluate(() => {
      const m = navigator.mediaSession.metadata;
      return m ? { title: m.title, artist: m.artist, art: m.artwork.map((a) => new URL(a.src).pathname) } : null;
    }), { timeout: 15000 }).toEqual({ title: 'QA Cov Thumb', artist: 'QA Cov', art: [expect.stringMatching(COVER_RE)] });
    // очередь в модалке: обложки (нет обложки — значок ноты, без ошибок)
    await page.locator('#btn-music-queue').click();
    const q = page.locator('#music-queue .queue-item');
    await expect(q).toHaveCount(3, { timeout: 20000 });
    await expect(q.filter({ hasText: 'qadeezerhit' }).locator('.cover')).toHaveClass(/has-img/, { timeout: 20000 });
    await expect(q.filter({ hasText: 'qaituneshit' }).locator('.cover')).toHaveClass(/has-img/, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await expect(q.filter({ hasText: 'qanohit' }).locator('.cover')).not.toHaveClass(/has-img/);
    await expect(q.filter({ hasText: 'qanohit' }).locator('.cover .icon')).toBeVisible();
    // библиотека
    await expect(page.locator('#track-list .track', { hasText: 'QA Cov Thumb' }).locator('.cover')).toHaveClass(/has-img/, { timeout: 20000 });
    await page.keyboard.press('Escape');
    await ack(owner.socket, 'message:send', { channelId: textChannel(srv).id, content: '!stop' });
    await expect(page.locator('#music-player')).toBeHidden({ timeout: 15000 });
    expect(await page.evaluate(() => navigator.mediaSession.metadata)).toBeNull();
  });

  test('UI: эквалайзер — граф только когда не «Ровно», пресеты сохраняются, громкость и deafen работают, один выход', async ({ makePage }) => {
    test.setTimeout(150_000);
    const owner = await M.makeUser('equ'); sockets.push(owner.socket);
    const srv = await createServer(owner, 'Эквалайзер');
    // второй слушатель держит канал (иначе при перезагрузке страницы канал пустеет и бот останавливается)
    const keeper = await M.makeUser('eqk'); sockets.push(keeper.socket);
    expect((await ack(keeper.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
    expect((await ack(keeper.socket, 'voice:join', { channelId: voiceChannel(srv).id })).ok).toBe(true);
    const page = await openAs(makePage, owner, { viewport: { width: 1280, height: 860 } });
    await openServer(page, srv.id);
    await joinVoicePage(page, voiceChannel(srv).id);
    await ack(owner.socket, 'message:send', { channelId: textChannel(srv).id, content: `!play ${yt('qaCov000007')}` });
    await expect(page.locator('#music-player .music-player__title')).toHaveText('QA Cov EQ Track', { timeout: 60000 });
    const info = () => page.evaluate(() => window.__astraMusicEq.info());
    const playing = () => page.evaluate(() => { const a = document.querySelector('#music-audio'); return !a.paused && a.currentTime > 0; });
    await expect.poll(playing, { timeout: 15000 }).toBe(true);
    // по умолчанию: без графа, элемент играет сам, громкость — element.volume
    expect(await info()).toMatchObject({ graph: false, routed: 'none', outputs: 0 });
    expect(await page.evaluate(() => document.querySelector('#music-audio').volume)).toBeCloseTo(0.7, 2);

    await page.locator('#btn-music-eq').click();
    const panel = page.locator('#music-eq-panel');
    await expect(panel).toBeVisible();
    // «Ровно» включённым — всё ещё без обработки
    await panel.locator('[data-eq-preset="flat"]').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sozvon.prefs'))['music.eq'])).toMatchObject({ on: true, preset: 'flat' });
    await page.waitForTimeout(500);
    expect(await info()).toMatchObject({ graph: false, outputs: 0 });

    // «Бас» — граф: фильтры, предусиление, один выход #music-eq-out, элемент на 100 %
    await panel.locator('[data-eq-preset="bass"]').click();
    await expect.poll(async () => (await info()).routed, { timeout: 10000 }).toBe('eq');
    await expect.poll(async () => (await info()).gains, { timeout: 5000 }).toEqual([7, 6, 5, 3, 1, 0, 0, 0, 0, 0]);
    let i = await info();
    expect(i).toMatchObject({ graph: true, outputs: 1, elementVolume: 1, ctxState: 'running' });
    expect(i.preamp).toBeCloseTo(10 ** (-5 / 20), 2);
    await expect(page.locator('#btn-music-eq')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await info()).volume, { timeout: 5000 }).toBeCloseTo(0.7, 2);
    expect(await page.evaluate(() => { const o = document.querySelector('#music-eq-out'); return [!!o.srcObject, o.paused, o.muted]; })).toEqual([true, false, false]);
    // звук действительно идёт через граф (синус фейкового трека на выходе узла громкости не тишина)
    await expect.poll(() => page.evaluate(async () => {
      const eq = window.__astraMusicEq;
      const an = eq.ctx.createAnalyser();
      an.fftSize = 2048;
      eq.vol.connect(an);
      await new Promise((r) => setTimeout(r, 250));
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      eq.vol.disconnect(an);
      return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    }), { timeout: 10000 }).toBeGreaterThan(0.001);
    // синхронизация не сломалась: трек идёт
    const t0 = await page.evaluate(() => document.querySelector('#music-audio').currentTime);
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => document.querySelector('#music-audio').currentTime)).toBeGreaterThan(t0 + 0.5);

    // ползунок полосы → «Свой»; громкость музыки — узел графа, элемент остаётся на 100 %
    await panel.locator('input[data-eq-band="5"]').fill('4');
    await expect.poll(async () => (await info()).gains[5], { timeout: 5000 }).toBe(4);
    await expect(panel.locator('[data-eq-custom]')).toBeVisible();
    await page.locator('#music-volume').fill('30');
    await expect.poll(async () => (await info()).volume, { timeout: 5000 }).toBeCloseTo(0.3, 2);
    expect((await info()).elementVolume).toBe(1);
    // deafen: тишина в графе и на выходе (клик мимо панели закрывает её)
    await page.locator('#btn-deafen').click();
    await expect(panel).toBeHidden();
    await expect.poll(async () => (await info()).volume, { timeout: 5000 }).toBeCloseTo(0, 2);
    expect((await info()).outMuted).toBe(true);
    await page.locator('#btn-deafen').click();
    await expect.poll(async () => (await info()).volume, { timeout: 5000 }).toBeCloseTo(0.3, 2);
    expect((await info()).outMuted).toBe(false);
    await page.locator('#btn-music-eq').click();
    await expect(panel).toBeVisible();

    // «Ровно» после графа — фильтры обходятся (обработки нет), выход по-прежнему один
    await panel.locator('[data-eq-preset="flat"]').click();
    await expect.poll(async () => (await info()).routed, { timeout: 5000 }).toBe('bypass');
    expect((await info()).outputs).toBe(1);
    // выключатель
    await panel.locator('[data-eq-preset="rock"]').click();
    await expect.poll(async () => (await info()).routed).toBe('eq');
    await panel.locator('#music-eq-on').click();
    await expect.poll(async () => (await info()).routed).toBe('bypass');
    await panel.locator('#music-eq-on').click();
    await expect.poll(async () => (await info()).routed).toBe('eq');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // сохраняется в prefs: после перезагрузки — тот же пресет, граф строится снова, громкость 30 %
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sozvon.prefs'))['music.eq'])).toMatchObject({ on: true, preset: 'rock' });
    await openServer(page, srv.id);
    await joinVoicePage(page, voiceChannel(srv).id);
    await expect.poll(async () => (await info()).routed, { timeout: 15000 }).toBe('eq');
    await expect.poll(async () => (await info()).volume, { timeout: 5000 }).toBeCloseTo(0.3, 2);
    await expect.poll(playing, { timeout: 15000 }).toBe(true);
    expect((await info()).gains).toEqual([5, 4, 3, 1, -1, -1, 1, 3, 4, 4]);
    // мобильная ширина: панель влезает в экран
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('#btn-music-eq').click();
    const box = await page.locator('#music-eq-panel').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.locator('#music-eq-panel [data-eq-reset]').click();
    await expect.poll(async () => (await info()).routed).toBe('bypass');
    await ack(owner.socket, 'message:send', { channelId: textChannel(srv).id, content: '!stop' });
  });

  test('«Сейчас слушает»: профиль и список участников, видимость канала, «Показывать, что я слушаю», «Слушать вместе»', async ({ makePage }) => {
    test.setTimeout(150_000);
    const a = await M.makeUser('lsa'); sockets.push(a.socket);     // слушает (через сокет)
    const b = await M.makeUser('lsb'); sockets.push(b.socket);     // смотрит (браузер)
    const c = await M.makeUser('lsc'); sockets.push(c.socket);     // участник без доступа к голосовому каналу
    const srv = await createServer(a, 'Слушаем вместе');
    for (const u of [b, c]) expect((await ack(u.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
    const vc = voiceChannel(srv);
    // второй голосовой канал, скрытый от @everyone, кроме владельца
    const hidden = await ack(a.socket, 'channel:create', { serverId: srv.id, name: 'Тайный', type: 'voice' });
    expect(hidden.ok).toBe(true);
    const hid = hidden.channel;

    // A слушает в обычном канале
    expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
    await ack(a.socket, 'message:send', { channelId: textChannel(srv).id, content: `!play ${yt('qaCov000006')}` });
    await waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && d.track?.title === 'QA Cov Listen Together', 60000);

    const page = await openAs(makePage, b);
    await openServer(page, srv.id);
    const memberA = page.locator(`#members .member[data-user-id="${a.user.id}"]`);
    await expect(memberA.locator('.member__listening')).toContainText('Слушает: QA Cov — QA Cov Listen Together', { timeout: 20000 });
    await expect(memberA.locator('.member__listening .cover')).toHaveClass(/has-img/, { timeout: 20000 });
    // B не в голосовом — у B ничего не показываем
    await expect(page.locator(`#members .member[data-user-id="${b.user.id}"] .member__listening`)).toHaveCount(0);

    // профиль A: секция и кнопка «Слушать вместе»
    await memberA.click();
    const pop = page.locator('.profile-layer');
    await expect(pop.locator('.profile-listening')).toContainText('QA Cov Listen Together');
    await expect(pop.locator('.profile-listening .cover')).toHaveClass(/has-img/, { timeout: 20000 });
    const join = pop.locator('[data-action="listen-together"]');
    await expect(join).toBeEnabled();
    // «Отмена» — никуда не подключились
    await join.click();
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await expect(page.locator('#modal-confirm-text')).toContainText('«Голосовой»');
    await page.locator('#modal-confirm .modal__footer [data-close]').click();
    await expect(page.locator('#voice-panel')).toBeHidden();
    // «Подключиться»
    await memberA.click();
    if (!(await pop.isVisible().catch(() => false))) await memberA.click();
    await pop.locator('[data-action="listen-together"]').click();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#voice-panel')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => window.__sozvon?.state?.myVoice?.channelId ?? null), { timeout: 10000 }).toBe(vc.id);
    await expect(page.locator('#music-player .music-player__title')).toHaveText('QA Cov Listen Together', { timeout: 20000 });
    // теперь B тоже слушает; в профиле A кнопка неактивна: «Вы уже в этом канале»
    await expect(page.locator(`#members .member[data-user-id="${b.user.id}"] .member__listening`)).toHaveCount(1, { timeout: 10000 });
    await memberA.click();
    if (!(await pop.isVisible().catch(() => false))) await memberA.click();
    await expect(pop.locator('[data-action="listen-together"]')).toBeDisabled();
    await expect(pop.locator('.profile-listening__reason')).toHaveText('Вы уже в этом канале');
    await page.keyboard.press('Escape');

    // «Показывать, что я слушаю» = выкл у A → у B пропадает (и в профиле)
    expect((await M.http('PATCH', '/api/me', { token: a.token, body: { showListening: 'nope' } })).status).toBe(400);
    let r = await M.http('PATCH', '/api/me', { token: a.token, body: { showListening: false } });
    expect(r.status).toBe(200);
    expect(r.json.user.showListening).toBe(false);
    await expect(memberA.locator('.member__listening')).toHaveCount(0, { timeout: 10000 });
    await memberA.click();
    if (!(await pop.isVisible().catch(() => false))) await memberA.click();
    await expect(pop).toBeVisible();
    await expect(pop.locator('.profile-listening')).toHaveCount(0);
    await page.keyboard.press('Escape');
    r = await M.http('PATCH', '/api/me', { token: a.token, body: { showListening: true } });
    await expect(memberA.locator('.member__listening')).toHaveCount(1, { timeout: 10000 });

    // переключатель в настройках профиля (B у себя): сохраняется на сервере
    await page.locator('#btn-user-settings').click();
    await page.locator('.settings__tab[data-section="profile"]').click();
    const sw = page.locator('#profile-show-listening');
    await expect(sw).toBeChecked();
    await sw.click();
    await expect.poll(async () => (await M.http('GET', '/api/me', { token: b.token })).json.user.showListening).toBe(false);
    await sw.click();
    await expect.poll(async () => (await M.http('GET', '/api/me', { token: b.token })).json.user.showListening).toBe(true);
    await page.keyboard.press('Escape');

    // без права CONNECT у @everyone: кнопка неактивна с причиной (B выходит из канала)
    await page.locator('#btn-disconnect').click();
    expect((await ack(a.socket, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: DEFAULT_EVERYONE & ~P.CONNECT })).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__sozvon?.state?.myVoice ?? null), { timeout: 10000 }).toBeNull();
    await memberA.click();
    if (!(await pop.isVisible().catch(() => false))) await memberA.click();
    await expect(pop.locator('[data-action="listen-together"]')).toBeDisabled();
    await expect(pop.locator('.profile-listening__reason')).toHaveText('Нет права подключаться к этому каналу');
    await page.keyboard.press('Escape');
    expect((await ack(a.socket, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: DEFAULT_EVERYONE })).ok).toBe(true);

    // скрытый канал: A переходит в «Тайный» — те, кто его не видит, «Сейчас слушает» не видят
    expect((await ack(a.socket, 'channel:update', { channelId: hid.id, overwrites: { [srv.id]: { allow: 0, deny: P.VIEW_CHANNEL } } })).ok).toBe(true);
    await ack(a.socket, 'message:send', { channelId: textChannel(srv).id, content: '!stop' });
    await sleep(500);
    expect((await ack(a.socket, 'voice:join', { channelId: hid.id })).ok).toBe(true);
    await ack(a.socket, 'message:send', { channelId: textChannel(srv).id, content: `!play ${yt('qaCov000006')}` });
    await waitEvent(a.socket, 'music:state', (d) => d.channelId === hid.id && d.track?.title === 'QA Cov Listen Together', 60000);
    // C (сокет) не получает ни участников, ни музыку скрытого канала
    const cboot = await ack(c.socket, 'bootstrap');
    expect(cboot.voice[hid.id]).toBeUndefined();
    expect(cboot.music[hid.id]).toBeUndefined();
    // B в браузере: «Слушает» у A пропало
    await expect(memberA.locator('.member__listening')).toHaveCount(0, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await expect(memberA.locator('.member__listening')).toHaveCount(0);
    await ack(a.socket, 'message:send', { channelId: textChannel(srv).id, content: '!stop' });
  });
});
