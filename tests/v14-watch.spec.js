// v14: «Смотреть вместе» — синхронный просмотр видео в голосовом канале (server/watch.js, public/js/ui/watch.js).
// Стенд музыки (tests/start-server-music.js): фейковый yt-dlp отдаёт видео qaWatch* (mp4 VP9+Opus, 20 с),
// лимиты стенда: WATCH_MAX_MB=2, WATCH_CACHE_GB=0.001 (~1 МБ), WATCH_IDLE_SEC=3.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures/ui.js';
import { apiAt, ack, waitEvent, createServer, voiceChannel, sleep, waitFor } from './fixtures/api.js';
import { MUSIC_BASE_URL, MUSIC_DATA_DIR } from './fixtures/env.js';

const M = apiAt(MUSIC_BASE_URL, MUSIC_DATA_DIR);
const YT = (id) => `https://www.youtube.com/watch?v=${id}`;
const WATCH_DIR = path.join(MUSIC_DATA_DIR, 'watch');
const USE_MUSIC_BOT = 1 << 18;

const sockets = [];
test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } } });

/** Два пользователя на одном сервере, оба в голосовом канале. */
async function room(name = 'Кино') {
  const a = await M.makeUser('wa'); sockets.push(a.socket);
  const b = await M.makeUser('wb'); sockets.push(b.socket);
  const srv = await createServer(a, name);
  expect((await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const vc = voiceChannel(srv);
  expect((await ack(a.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
  expect((await ack(b.socket, 'voice:join', { channelId: vc.id })).ok).toBe(true);
  const log = { a: [], b: [] };
  a.socket.on('watch:state', (d) => { if (d.channelId === vc.id) log.a.push(d); });
  b.socket.on('watch:state', (d) => { if (d.channelId === vc.id) log.b.push(d); });
  const waitState = (who, pred, ms = 30000) => {
    const arr = log[who === a ? 'a' : 'b'];
    const last = arr[arr.length - 1];
    if (last && pred(last)) return Promise.resolve(last);
    return waitEvent(who.socket, 'watch:state', (d) => d.channelId === vc.id && pred(d), ms).catch((e) => {
      const l = arr[arr.length - 1];
      throw new Error(`${e.message}: ${pred.toString().slice(0, 120)}; последнее: video=${l?.video?.title} paused=${l?.paused} pos=${l?.position} queue=${l?.queue?.length} loading=${JSON.stringify(l?.loading)}`);
    });
  };
  const ctl = (who, action, extra = {}) => ack(who.socket, 'watch:control', { action, ...extra });
  return { a, b, srv, vc, log, waitState, ctl };
}

const elapsedOf = (s) => s.position + (s.paused ? 0 : Math.max(0, (s.serverNow - s.updatedAt) / 1000));

test('ссылка → сервер скачивает → оба видят видео; пауза/перемотка/play синхронно; очередь, skip, stop', async () => {
  test.setTimeout(120_000);
  const r = await room();
  const res = await ack(r.a.socket, 'watch:start', { url: YT('qaWatchSlo1') });
  expect(res.ok).toBe(true);
  expect(res.loadingId).toBeTruthy();
  // прогресс скачивания виден всему каналу (и тому, кто не запускал)
  const prog = await r.waitState(r.b, (s) => s.loading.length === 1 && s.loading[0].progress > 0 && s.loading[0].progress < 1, 30000);
  expect(prog.loading[0].title).toBe('QA Watch Slow');
  expect(prog.loading[0].stage).toBe('download');
  expect(prog.loading[0].by.id).toBe(r.a.user.id);
  const sa = await r.waitState(r.a, (s) => s.video?.title === 'QA Watch Slow' && !s.loading.length);
  const sb = await r.waitState(r.b, (s) => s.video?.title === 'QA Watch Slow');
  expect(sa.video.url).toBe(sb.video.url);
  expect(sa.video.url).toMatch(/^\/media\/watch\/[0-9a-f]{16}\.mp4$/);
  expect(sa.video.duration).toBe(20);
  expect(sa.video.by.id).toBe(r.a.user.id);
  expect(sa.paused).toBe(false);
  // файл лежит в кэше
  expect(fs.existsSync(path.join(WATCH_DIR, path.basename(sa.video.url)))).toBe(true);

  // B ставит на паузу — у обоих пауза, позиция зафиксирована
  await sleep(1500);
  expect((await r.ctl(r.b, 'pause')).ok).toBe(true);
  const pa = await r.waitState(r.a, (s) => s.paused);
  expect(pa.position).toBeGreaterThan(0);
  expect(pa.position).toBeLessThan(5);
  // A перематывает (на паузе): seekSeq растёт, позиция у обоих 12 с
  expect((await r.ctl(r.a, 'seek', { position: 12 })).ok).toBe(true);
  const sk = await r.waitState(r.b, (s) => s.seekSeq > pa.seekSeq);
  expect(sk.position).toBe(12);
  expect(sk.paused).toBe(true);
  // за конец — не дальше duration−0.5
  await r.ctl(r.a, 'seek', { position: 999 });
  await r.waitState(r.b, (s) => Math.abs(s.position - 19.5) < 0.01);
  await r.ctl(r.a, 'seek', { position: 3 });
  // play
  expect((await r.ctl(r.b, 'play')).ok).toBe(true);
  const pl = await r.waitState(r.a, (s) => !s.paused);
  expect(Math.abs(elapsedOf(pl) - 3)).toBeLessThan(0.5);
  expect((await r.ctl(r.a, 'seek', { position: 'abc' })).error).toMatch(/время/);

  // очередь: второе видео встаёт в очередь, skip → оно; remove; stop
  expect((await ack(r.a.socket, 'watch:start', { url: YT('qaWatch0002') })).ok).toBe(true);
  const q = await r.waitState(r.b, (s) => s.queue.length === 1 && !s.loading.length);
  expect(q.queue[0].title).toBe('QA Watch Two');
  expect(q.video.title).toBe('QA Watch Slow');
  expect((await r.ctl(r.b, 'skip')).ok).toBe(true);
  const sk2 = await r.waitState(r.a, (s) => s.video?.title === 'QA Watch Two' && !s.queue.length);
  expect(sk2.position).toBe(0);
  // повтор той же ссылки — из кэша, без нового скачивания
  const before = fs.readFileSync(M_LOG(), 'utf8').split('\n').filter((l) => l.includes('qaWatch0002')).length;
  expect((await ack(r.b.socket, 'watch:start', { url: `https://youtu.be/qaWatch0002` })).ok).toBe(true);
  const q2 = await r.waitState(r.a, (s) => s.queue.length === 1);
  expect(q2.queue[0].url).toBe(sk2.video.url);
  expect(fs.readFileSync(M_LOG(), 'utf8').split('\n').filter((l) => l.includes('qaWatch0002')).length).toBe(before);
  expect((await r.ctl(r.a, 'remove', { qid: q2.queue[0].qid })).ok).toBe(true);
  await r.waitState(r.b, (s) => s.queue.length === 0 && s.video?.title === 'QA Watch Two');
  // конец видео: сервер сам переходит дальше (очередь пуста → ничего не играет)
  await r.ctl(r.a, 'seek', { position: 19 });
  await r.waitState(r.b, (s) => !s.video, 15000);
  // stop
  expect((await ack(r.a.socket, 'watch:start', { url: YT('qaWatch0002') })).ok).toBe(true);
  await r.waitState(r.b, (s) => s.video?.title === 'QA Watch Two');
  expect((await r.ctl(r.b, 'stop')).ok).toBe(true);
  await r.waitState(r.a, (s) => !s.video && !s.queue.length && !s.loading.length);
  // watch:sync отдаёт пустой список и токен
  const sync = await ack(r.b.socket, 'watch:sync');
  expect(sync.ok).toBe(true);
  expect(sync.states.find((s) => s.channelId === r.vc.id)).toBeFalsy();
  expect(sync.token).toMatch(/\./);
  expect(sync.limits).toEqual({ maxDurationMin: 180, maxMb: 2 });
});

const M_LOG = () => MUSIC_DATA_DIR + '-ytdlp-calls.log';

test('файл: Range (206), без токена 401, чужой 403; права: без USE_MUSIC_BOT и вне канала — отказ', async () => {
  test.setTimeout(90_000);
  const r = await room('Кино права');
  expect((await ack(r.a.socket, 'watch:start', { url: YT('qaWatch0001') })).ok).toBe(true);
  const st = await r.waitState(r.b, (s) => s.video?.title === 'QA Watch One');
  const { token } = await ack(r.b.socket, 'watch:sync');
  const url = MUSIC_BASE_URL + st.video.url;

  const full = await fetch(`${url}?t=${encodeURIComponent(token)}`);
  expect(full.status).toBe(200);
  expect(full.headers.get('accept-ranges')).toBe('bytes');
  expect(full.headers.get('content-type')).toMatch(/video\/mp4/);
  const size = Number(full.headers.get('content-length'));
  expect(size).toBeGreaterThan(10_000);
  await full.arrayBuffer();
  const part = await fetch(`${url}?t=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=100-199' } });
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe(`bytes 100-199/${size}`);
  expect((await part.arrayBuffer()).byteLength).toBe(100);
  const tail = await fetch(`${url}?t=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=-50' } });
  expect(tail.status).toBe(206);
  expect((await tail.arrayBuffer()).byteLength).toBe(50);
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(`${url}?t=${encodeURIComponent(token.slice(0, -2) + 'xx')}`)).status).toBe(401);
  expect((await fetch(`${MUSIC_BASE_URL}/media/watch/0000000000000000.mp4?t=${encodeURIComponent(token)}`)).status).toBe(404);
  expect((await fetch(`${MUSIC_BASE_URL}/media/watch/..%2Findex.json?t=${encodeURIComponent(token)}`)).status).toBe(404);
  // посторонний (не на этом сервере) со своим токеном — 403
  const c = await M.makeUser('wc'); sockets.push(c.socket);
  const ct = (await ack(c.socket, 'watch:sync')).token;
  expect((await fetch(`${url}?t=${encodeURIComponent(ct)}`)).status).toBe(403);
  // посторонний не может управлять: не в канале
  expect((await ack(c.socket, 'watch:control', { action: 'pause' })).error).toMatch(/голосовой канал/);
  expect((await ack(c.socket, 'watch:start', { url: YT('qaWatch0003') })).error).toMatch(/голосовой канал/);

  // владелец снимает USE_MUSIC_BOT у @everyone → B не может ничего
  const everyone = r.srv.roles.find((x) => x.id === r.srv.id);
  expect((await ack(r.a.socket, 'role:update', { serverId: r.srv.id, roleId: r.srv.id, permissions: everyone.permissions & ~USE_MUSIC_BOT })).ok).toBe(true);
  await sleep(200);
  for (const [action, extra] of [['pause', {}], ['seek', { position: 5 }], ['stop', {}], ['skip', {}]]) {
    const res = await r.ctl(r.b, action, extra);
    expect(res.ok, action).toBe(false);
    expect(res.error).toMatch(/Нет права/);
  }
  expect((await ack(r.b.socket, 'watch:start', { url: YT('qaWatch0003') })).error).toMatch(/Нет права/);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(1000)], { type: 'video/mp4' }), 'x.mp4');
  const up = await M.http('POST', '/api/watch/upload', { token: r.b.token, body: fd });
  expect(up.status).toBe(403);
  // смотреть B по-прежнему может (файл доступен), владелец — управляет
  expect((await fetch(`${url}?t=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=0-9' } })).status).toBe(206);
  expect((await r.ctl(r.a, 'pause')).ok).toBe(true);
  // некорректный ввод
  expect((await ack(r.a.socket, 'watch:start', { url: 'не ссылка' })).error).toMatch(/ссылку/);
  expect((await ack(r.a.socket, 'watch:start', { url: 'ftp://example.com/x.mp4' })).error).toMatch(/http/);
  expect((await r.ctl(r.a, 'explode')).error).toMatch(/Неизвестное/);
  await r.ctl(r.a, 'stop');
});

test('лимиты: длинное, слишком большое, недоступное видео; загрузка файла (mov → mp4) и 413 сверх WATCH_MAX_MB', async () => {
  test.setTimeout(90_000);
  const r = await room('Кино лимиты');
  const err = (url) => {
    const p = waitEvent(r.b.socket, 'watch:error', (d) => d.channelId === r.vc.id, 20000);
    return ack(r.a.socket, 'watch:start', { url }).then((res) => { expect(res.ok).toBe(true); return p; });
  };
  expect((await err(YT('qaWatchLong'))).error).toMatch(/слишком длинное: 4:00:00 \(максимум 180 мин\)/);
  expect((await err(YT('qaWatchBIG1'))).error).toMatch(/больше 2 МБ/);
  expect((await err(YT('qaWatchFAIL'))).error).toMatch(/недоступн/);
  expect((await err('https://example.invalid/clip')).error).toBeTruthy();
  // ошибки не оставляют «висящих» загрузок
  await r.waitState(r.a, (s) => !s.loading.length && !s.video);

  // загрузка файла: .mov (ремукс в mp4), длительность через ffprobe
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-watch-'));
  const mov = path.join(tmp, 'Мой ролик.mov');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', mov]);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(mov)], { type: 'video/quicktime' }), 'Мой ролик.mov');
  const up = await M.http('POST', `/api/watch/upload?channelId=${r.vc.id}`, { token: r.a.token, body: fd });
  expect(up.status, JSON.stringify(up.json)).toBe(200);
  expect(up.json.video.title).toBe('Мой ролик');
  expect(up.json.video.url).toMatch(/\.mp4$/);
  expect(up.json.video.duration).toBeGreaterThan(3.5);
  const s = await r.waitState(r.b, (x) => x.video?.title === 'Мой ролик');
  expect(s.video.by.id).toBe(r.a.user.id);
  // не видео
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  expect((await M.http('POST', '/api/watch/upload', { token: r.a.token, body: bad })).status).toBe(400);
  const fake = new FormData();
  fake.append('file', new Blob([Buffer.alloc(5000, 1)], { type: 'video/mp4' }), 'broken.mp4');
  expect((await M.http('POST', '/api/watch/upload', { token: r.a.token, body: fake })).json.error).toMatch(/не похож на видео/);
  // больше WATCH_MAX_MB=2 → 413
  const big = new FormData();
  big.append('file', new Blob([Buffer.alloc(2.5 * 1024 * 1024, 1)], { type: 'video/mp4' }), 'big.mp4');
  const r413 = await M.http('POST', '/api/watch/upload', { token: r.a.token, body: big });
  expect(r413.status).toBe(413);
  expect(r413.json.error).toMatch(/максимум 2 МБ/);
  // без авторизации
  expect((await M.http('POST', '/api/watch/upload', { body: new FormData() })).status).toBe(401);
  // недокачанные/отклонённые файлы не остаются
  expect(fs.readdirSync(WATCH_DIR).filter((f) => f.startsWith('.upload-') || f.startsWith('.dl-'))).toEqual([]);
  fs.rmSync(tmp, { recursive: true, force: true });
  await r.ctl(r.a, 'stop');
});

test('уборка: LRU-кэш (WATCH_CACHE_GB) не удаляет то, что смотрят; все ушли из канала — просмотр закончен', async () => {
  test.setTimeout(120_000);
  const r = await room('Кино уборка');
  const play = async (id, title) => {
    expect((await ack(r.a.socket, 'watch:start', { url: YT(id) })).ok).toBe(true);
    return r.waitState(r.a, (s) => s.video?.title === title || s.queue.some((q) => q.title === title), 30000);
  };
  await play('qaWatch0001', 'QA Watch One');
  await play('qaWatch0002', 'QA Watch Two');
  const s3 = await play('qaWatch0003', 'QA Watch Three');
  // все три в очереди/играют — ни один не удалён, хотя кэш (~1 МБ) переполнен
  const files = () => fs.readdirSync(WATCH_DIR).filter((f) => /^[0-9a-f]{16}\.mp4$/.test(f));
  const urls = [s3.video.url, ...s3.queue.map((q) => q.url)];
  expect(urls).toHaveLength(3);
  for (const u of urls) expect(files()).toContain(path.basename(u));
  // stop → следующая загрузка вытесняет самые давние неиспользуемые, пока кэш не уложится в лимит
  await r.ctl(r.a, 'stop');
  await r.waitState(r.a, (s) => !s.video);
  await play('qaWatchSlo1', 'QA Watch Slow');
  const limit = 0.001 * 1024 ** 3;
  await waitFor(() => files().reduce((n, f) => n + fs.statSync(path.join(WATCH_DIR, f)).size, 0) <= limit, { timeout: 5000, message: 'кэш в пределах лимита' });
  expect(files().length).toBeLessThan(4);
  // индекс на диске (пишется с задержкой ~0.3 с) совпадает с файлами
  await expect.poll(() => Object.values(JSON.parse(fs.readFileSync(path.join(WATCH_DIR, 'index.json'), 'utf8')).videos)
    .map((v) => v.file).sort().join(), { timeout: 5000 }).toBe(files().sort().join());

  // все вышли из голосового → через WATCH_IDLE_SEC (3 с) просмотр закончен для всех
  const ended = waitEvent(r.a.socket, 'watch:state', (d) => d.channelId === r.vc.id && !d.video && !d.queue.length, 15000);
  await ack(r.a.socket, 'voice:leave');
  await ack(r.b.socket, 'voice:leave');
  await ended;
  expect((await ack(r.a.socket, 'watch:sync')).states.find((s) => s.channelId === r.vc.id)).toBeFalsy();
});

// ---------------------------------------------------------------- UI --
async function pageFor(makePage, user, opts = {}) {
  const page = await makePage(opts);
  await page.goto(MUSIC_BASE_URL + '/');
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), user.token);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  return page;
}
async function joinVoice(page) {
  await page.locator('a.channel[data-type="voice"]').first().click();
  for (let i = 0; i < 10 && !(await page.locator('#stage-controls').isVisible()); i++) {
    const join = page.locator('#btn-voice-join');
    if (await join.isVisible()) await join.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await expect(page.locator('#stage-controls')).toBeVisible();
}
const vid = (page) => page.evaluate(() => {
  const v = document.querySelector('#watch-video');
  return { t: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, ready: v.readyState, src: v.getAttribute('src') || '' };
});

test('UI: двое в канале — ссылка, оба смотрят синхронно; пауза/перемотка/продолжить; громкость своя; «Включить звук»; индикатор в списке каналов', async ({ makePage }) => {
  test.setTimeout(120_000);
  const a = await M.makeUser('wua'); sockets.push(a.socket);
  const b = await M.makeUser('wub'); sockets.push(b.socket);
  const srv = await createServer(a, 'Кино UI');
  expect((await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const pa = await pageFor(makePage, a, { name: 'A' });
  const pb = await pageFor(makePage, b, { name: 'B' });
  // у B браузер «запрещает» звук без жеста — должен появиться «▶ Включить звук»
  await pb.evaluate(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      if (this.id === 'watch-video' && !this.muted && !window.__qaUnlocked) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      return orig.call(this);
    };
  });
  await joinVoice(pa);
  await joinVoice(pb);

  // A открывает панель и вставляет ссылку
  await expect(pa.locator('#watch-panel')).toBeHidden();
  await pa.locator('#ctrl-watch').click();
  await expect(pa.locator('#watch-panel')).toBeVisible();
  await expect(pa.locator('#watch-placeholder')).toContainText('Вставьте ссылку');
  await pa.locator('#watch-url').fill(YT('qaWatch0003'));
  await pa.locator('#watch-submit').click();
  // у B панель открывается сама: сначала загрузка, потом видео
  await expect(pb.locator('#watch-panel')).toBeVisible({ timeout: 15000 });
  await expect(pb.locator('#watch-now')).toContainText('QA Watch Three', { timeout: 30000 });
  await expect(pa.locator('#watch-now')).toContainText('Сейчас смотрим: QA Watch Three');
  for (const p of [pa, pb]) await expect(p.locator('.channel-watch')).toContainText('Сейчас смотрим: QA Watch Three');
  // B: звук заблокирован → видео идёт без звука, кнопка «Включить звук»
  await expect(pb.locator('#btn-watch-unlock')).toBeVisible({ timeout: 15000 });
  expect((await vid(pb)).muted).toBe(true);
  await pb.evaluate(() => { window.__qaUnlocked = true; });
  await pb.locator('#btn-watch-unlock').click();
  await expect(pb.locator('#btn-watch-unlock')).toBeHidden();
  await expect.poll(async () => (await vid(pb)).muted).toBe(false);

  // оба играют, расхождение меньше секунды
  for (const p of [pa, pb]) await expect.poll(async () => { const v = await vid(p); return !v.paused && v.t > 1.5; }, { timeout: 20000 }).toBe(true);
  const [va, vb] = await Promise.all([vid(pa), vid(pb)]);
  expect(va.src).toMatch(/^\/media\/watch\/[0-9a-f]{16}\.mp4\?t=/);
  expect(Math.abs(va.t - vb.t)).toBeLessThan(1.2);

  // A ставит на паузу — у B тоже пауза на той же секунде
  await pa.locator('#watch-screen').hover();
  await pa.locator('#watch-play').click();
  await expect.poll(async () => (await vid(pb)).paused, { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await vid(pa)).paused).toBe(true);
  await expect.poll(async () => Math.abs((await vid(pa)).t - (await vid(pb)).t), { timeout: 5000 }).toBeLessThan(0.5);
  await expect(pb.locator('#watch-play')).toHaveAttribute('aria-label', 'Продолжить для всех');

  // A перематывает кликом по полосе (75 % от 20 с ≈ 15 с) — у обоих
  const box = await pa.locator('#watch-progress').boundingBox();
  await pa.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  for (const p of [pa, pb]) await expect.poll(async () => (await vid(p)).t, { timeout: 10000 }).toBeGreaterThan(13.5);
  for (const p of [pa, pb]) expect((await vid(p)).t).toBeLessThan(16.5);
  // клавиатура: Home — в начало
  await pa.locator('#watch-progress').focus();
  await pa.keyboard.press('Home');
  for (const p of [pa, pb]) await expect.poll(async () => (await vid(p)).t, { timeout: 10000 }).toBeLessThan(0.6);

  // B продолжает — оба играют синхронно
  await pb.locator('#watch-screen').hover();
  await pb.locator('#watch-play').click();
  for (const p of [pa, pb]) await expect.poll(async () => { const v = await vid(p); return !v.paused && v.t > 1; }, { timeout: 10000 }).toBe(true);
  const [wa, wb] = await Promise.all([vid(pa), vid(pb)]);
  expect(Math.abs(wa.t - wb.t)).toBeLessThan(1.2);

  // громкость — только у себя и запоминается
  await pb.locator('#watch-volume').fill('30');
  await expect.poll(async () => (await vid(pb)).volume).toBeCloseTo(0.3, 2);
  expect((await vid(pa)).volume).toBeCloseTo(0.8, 2);
  expect(await pb.evaluate(() => JSON.parse(localStorage.getItem('sozvon.prefs'))['watch.volume'])).toBe(30);

  // кинотеатр: плитки скрыты
  await pa.locator('#watch-screen').hover();
  await pa.locator('#watch-focus').click();
  await expect(pa.locator('#voice-view')).toHaveClass(/is-watch-focus/);
  await expect(pa.locator('#stage-grid')).toBeHidden();
  await pa.locator('#watch-focus').click();
  await expect(pa.locator('#stage-grid')).toBeVisible();

  // «Стоп» — у всех пропадает видео и индикатор
  await pb.locator('#watch-stop').click();
  for (const p of [pa, pb]) {
    await expect(p.locator('.channel-watch')).toHaveCount(0, { timeout: 10000 });
    await expect.poll(async () => (await vid(p)).src).toBe('');
  }
  await expect(pb.locator('#watch-panel')).toBeHidden();
});

test('UI: без права — смотреть можно, включать нельзя; мобильная вёрстка без горизонтальной прокрутки', async ({ makePage }) => {
  test.setTimeout(90_000);
  const a = await M.makeUser('wma'); sockets.push(a.socket);
  const b = await M.makeUser('wmb'); sockets.push(b.socket);
  const srv = await createServer(a, 'Кино моб');
  expect((await ack(b.socket, 'server:join', { inviteCode: srv.inviteCode })).ok).toBe(true);
  const everyone = srv.roles.find((x) => x.id === srv.id);
  expect((await ack(a.socket, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: everyone.permissions & ~USE_MUSIC_BOT })).ok).toBe(true);
  const pb = await pageFor(makePage, b, { name: 'B-mobile', viewport: { width: 390, height: 844 } });
  // мобильный: каналы в выезжающем меню
  if (await pb.locator('#btn-menu').isVisible()) await pb.locator('#btn-menu').click();
  await joinVoice(pb);
  if (await pb.locator('#app.is-nav-open').count()) await pb.locator('#btn-menu').click();
  await pb.locator('#ctrl-watch').click();
  await expect(pb.locator('#watch-panel')).toBeVisible();
  await expect(pb.locator('#watch-submit')).toBeDisabled();
  await expect(pb.locator('#watch-hint')).toBeHidden(); // на телефоне подсказка скрыта
  // владелец (через сокет в канале) включает видео — B видит
  expect((await ack(a.socket, 'voice:join', { channelId: voiceChannel(srv).id })).ok).toBe(true);
  expect((await ack(a.socket, 'watch:start', { url: YT('qaWatch0001') })).ok).toBe(true);
  await expect(pb.locator('#watch-now')).toContainText('QA Watch One', { timeout: 30000 });
  await expect.poll(async () => { const v = await vid(pb); return !v.paused && v.t > 0.5; }, { timeout: 20000 }).toBe(true);
  await expect(pb.locator('#watch-play')).toBeDisabled();
  await expect(pb.locator('#watch-progress')).toHaveAttribute('aria-disabled', 'true');
  await expect(pb.locator('#watch-stop')).toBeHidden();
  const sw = await pb.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sw).toBeLessThanOrEqual(0);
  const scr = await pb.locator('#watch-screen').boundingBox();
  expect(scr.width).toBeLessThanOrEqual(390);
  expect(scr.width).toBeGreaterThan(300);
  await ack(a.socket, 'watch:control', { action: 'stop' });
  await expect(pb.locator('#watch-now')).not.toContainText('QA Watch One', { timeout: 10000 });
});
