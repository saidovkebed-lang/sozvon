// v22: «Слушает Spotify / Яндекс Музыка / …» — что играет на ПК пользователя (приложение для Windows).
//   1. Чистые функции public/js/media-sources.js (app id → источник, выбор сессии) и разбор строки помощника.
//   2. Сервер (server/pc-listening.js + presence:listening): проверка данных, частота, кому рассылается,
//      bootstrap, сброс при отключении/паузе, showListening=false и «невидимка».
//   3. Electron из desktop/ под Xvfb + подделка помощника в режиме --media (tests/fixtures/fake-capture.cjs,
//      состоянием управляет файл) и зритель-браузер: список участников, профиль с прогрессом, пауза,
//      браузеры (по умолчанию не учитываются), список источников в настройках, выключатель «Показывать, что я слушаю».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { test, expect, loginViaToken, createServerUI, inviteCode, joinServerUI } from './fixtures/ui.js';
import { ROOT, BASE_URL } from './fixtures/env.js';
import { registerApi, uniqueName, sleep, makeUser, createServer, ack, waitEvent, collect, http, connectUser } from './fixtures/api.js';
import {
  resolveSource, normalizeSession, pickSession, listSources, livePosition, fmtTime, sourceAllowed,
} from '../public/js/media-sources.js';

const require = createRequire(import.meta.url);
const { parseMediaLine } = require('../desktop/src/media-watch.js');

const DESKTOP = path.join(ROOT, 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-capture.cjs');
const COVER_RE = /^\/media\/covers\/[a-f0-9]{20}\.jpg$/;

const SPOTIFY = { app: 'Spotify.exe', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', durationMs: 354000, positionMs: 30000, playing: true };
const CHROME = { app: 'chrome', title: 'Rick Astley - Never Gonna Give You Up (Official Video)', artist: '', durationMs: 213000, positionMs: 1000, playing: true };

/* =====================================================================================
   1. Чистые функции
   ===================================================================================== */
test.describe('media-sources.js: источники и выбор сессии', () => {
  test('app id → название и категория', () => {
    const cases = {
      'Spotify.exe': ['spotify', 'Spotify', 'music'],
      'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify': ['spotify', 'Spotify', 'music'],
      'A025C540.Yandex.Music_vfvw9svesycw6!App': ['yandex-music', 'Яндекс Музыка', 'music'],
      'Yandex.Music': ['yandex-music', 'Яндекс Музыка', 'music'],
      'VK Music': ['vk-music', 'VK Музыка', 'music'],
      'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App': ['apple-music', 'Apple Music', 'music'],
      'iTunes.exe': ['apple-music', 'Apple Music', 'music'],
      'C:\\Program Files\\AIMP\\AIMP.exe': ['aimp', 'AIMP', 'music'],
      'foobar2000.exe': ['foobar2000', 'foobar2000', 'music'],
      'MusicBee.exe': ['musicbee', 'MusicBee', 'music'],
      'winamp.exe': ['winamp', 'Winamp', 'music'],
      'TelegramDesktop': ['telegram', 'Telegram', 'music'],
      'SberZvuk.exe': ['zvuk', 'Звук', 'music'],
      'Deezer.exe': ['deezer', 'Deezer', 'music'],
      'TIDAL.exe': ['tidal', 'TIDAL', 'music'],
      'SoundCloud.exe': ['soundcloud', 'SoundCloud', 'music'],
      'Chrome._crx_cinhimbnkkaeohfgghhklpknlkffjgod': ['youtube-music', 'YouTube Music', 'music'],
      'vlc.exe': ['vlc', 'VLC', 'player'],
      'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic': ['media-player', 'Медиаплеер', 'player'],
      chrome: ['chrome', 'Chrome', 'browser'],
      MSEdge: ['edge', 'Edge', 'browser'],
      '308046B0AF4A39CB': ['firefox', 'Firefox', 'browser'],
      'firefox.exe': ['firefox', 'Firefox', 'browser'],
      'opera.exe': ['opera', 'Opera', 'browser'],
      'browser.exe': ['yandex-browser', 'Яндекс Браузер', 'browser'],
      'Chrome._crx_abcdefabcdefabcdefabcdefabcdefab': ['pwa', 'Веб-приложение', 'browser'],
    };
    for (const [app, [id, name, category]] of Object.entries(cases)) {
      expect(resolveSource(app), app).toEqual({ id, name, category });
    }
    const unk = resolveSource('Vendor.CoolPlayer_abcdefghijklm!App');
    expect(unk).toMatchObject({ name: 'CoolPlayer', category: 'other' });
    expect(unk.id).toMatch(/^app:/);
  });

  test('нормализация: мусор в названии, «Исполнитель - Название», « - Topic», позиция на «сейчас»', () => {
    const now = 1_000_000;
    const t = normalizeSession({ ...CHROME, updatedAt: now - 2000 }, now);
    expect(t).toMatchObject({ artist: 'Rick Astley', title: 'Never Gonna Give You Up', positionMs: 3000, at: now, source: { id: 'chrome' } });
    expect(normalizeSession({ app: 'chrome', title: 'Song', artist: 'Band - Topic', playing: true }, now).artist).toBe('Band');
    expect(normalizeSession({ app: 'x', title: '', artist: '' })).toBeNull();
    // пауза: позиция не бежит; длинное — обрезано до 200
    const p = normalizeSession({ ...SPOTIFY, playing: false, updatedAt: now - 5000, title: 'x'.repeat(500) }, now);
    expect(p.positionMs).toBe(30000);
    expect(p.title).toHaveLength(200);
    expect(livePosition({ positionMs: 1000, at: now, durationMs: 5000 }, now + 10000)).toBe(5000);
    expect(livePosition({ positionMs: 1000, at: now, durationMs: 5000, playing: false }, now + 2000)).toBe(1000);
    expect(fmtTime(354000)).toBe('5:54');
    expect(fmtTime(3723000)).toBe('1:02:03');
  });

  test('выбор: только играющее; музыка важнее плееров и браузеров; браузеры — по настройке; скрытые источники', () => {
    const vlc = { app: 'vlc.exe', title: 'Movie', artist: '', durationMs: 7200000, positionMs: 0, playing: true };
    expect(pickSession([])).toBeNull();
    expect(pickSession([{ ...SPOTIFY, playing: false }])).toBeNull(); // пауза — ничего
    expect(pickSession([CHROME])).toBeNull(); // браузер по умолчанию не учитывается
    expect(pickSession([CHROME], { browsers: true }).source.id).toBe('chrome');
    expect(pickSession([CHROME, SPOTIFY], { browsers: true }).source.id).toBe('spotify');
    expect(pickSession([vlc, SPOTIFY]).source.id).toBe('spotify');
    expect(pickSession([vlc, { ...SPOTIFY, playing: false }]).source.id).toBe('vlc');
    expect(pickSession([vlc, SPOTIFY], { hidden: { spotify: true } }).source.id).toBe('vlc');
    expect(pickSession([SPOTIFY], { hidden: { spotify: true } })).toBeNull();
    // с длиной раньше, чем без неё; затем уже показанный; затем «текущий» по Windows
    const aimp = { app: 'AIMP.exe', title: 'A', artist: 'B', durationMs: 0, playing: true };
    expect(pickSession([aimp, SPOTIFY]).source.id).toBe('spotify');
    const aimp2 = { ...aimp, durationMs: 1000 };
    expect(pickSession([aimp2, SPOTIFY], { prevKey: 'Spotify.exe|Queen|Bohemian Rhapsody' }).source.id).toBe('spotify');
    expect(pickSession([SPOTIFY, aimp2], { prevKey: 'AIMP.exe|B|A' }).source.id).toBe('aimp');
    expect(pickSession([SPOTIFY, { ...aimp2, current: true }]).source.id).toBe('aimp');
    expect(sourceAllowed({ id: 'chrome', category: 'browser' }, { browsers: false })).toBe(false);
    // список источников для настроек: без повторов, музыка первой
    const list = listSources([CHROME, SPOTIFY, { ...SPOTIFY, title: 'Other', playing: false }]);
    expect(list.map((s) => [s.id, s.playing])).toEqual([['spotify', true], ['chrome', true]]);
  });

  test('разбор строки помощника (desktop/src/media-watch.js)', () => {
    expect(parseMediaLine('мусор')).toBeNull();
    expect(parseMediaLine('{"t":"other"}')).toBeNull();
    expect(parseMediaLine('{"t":"media","sessions":[]}')).toEqual([]);
    const line = JSON.stringify({ t: 'media', sessions: [{ ...SPOTIFY, title: 'Тест «кавычки» "q" \\ \u0001', updatedAt: 1700000000000, evil: { x: 1 } }, null, 5] });
    const s = parseMediaLine(line);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({
      app: 'Spotify.exe', title: 'Тест «кавычки» "q" \\ \u0001', artist: 'Queen', album: 'A Night at the Opera', albumArtist: '',
      durationMs: 354000, positionMs: 30000, updatedAt: 1700000000000, playing: true, current: false,
    });
    const many = parseMediaLine(JSON.stringify({ t: 'media', sessions: Array.from({ length: 50 }, () => SPOTIFY) }));
    expect(many).toHaveLength(20);
  });
});

/* =====================================================================================
   2. Сервер: presence:listening
   ===================================================================================== */
const NP = { source: 'Spotify', kind: 'music', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', durationMs: 354000, positionMs: 30000, at: Date.now() };

test.describe('сервер: presence:listening', () => {
  const sockets = [];
  test.afterEach(() => { while (sockets.length) { try { sockets.pop().disconnect(); } catch { /* */ } } });
  const user = async (p) => { const u = await makeUser(p); sockets.push(u.socket); return u; };
  const join = async (u, server) => {
    const r = await ack(u.socket, 'server:join', { inviteCode: server.inviteCode });
    expect(r.ok).toBe(true);
  };

  test('проверка данных: типы, длины, числа', async () => {
    const a = await user('npv');
    const bad = [
      [{ ...NP, title: 5 }, /Название/],
      [{ ...NP, title: 'x'.repeat(201) }, /Название: не длиннее 200/],
      [{ ...NP, artist: 'x'.repeat(201) }, /Исполнитель/],
      [{ ...NP, album: 'x'.repeat(201) }, /Альбом/],
      [{ ...NP, source: 'x'.repeat(41) }, /Источник: не длиннее 40/],
      [{ ...NP, source: '' }, /Источник/],
      [{ ...NP, title: '   ' }, /Название: пусто/],
      [{ ...NP, durationMs: -1 }, /Длительность/],
      [{ ...NP, durationMs: 'big' }, /Длительность/],
      [{ ...NP, positionMs: Number.MAX_SAFE_INTEGER }, /Позиция/],
      [{ ...NP, positionMs: 400000 }, /Позиция больше длительности/],
      [{ ...NP, kind: 'hack' }, /Тип источника/],
    ];
    for (const [p, re] of bad) {
      const r = await ack(a.socket, 'presence:listening', p);
      expect(r.ok, JSON.stringify(p).slice(0, 80)).toBe(false);
      expect(r.error).toMatch(re);
    }
    // ровно на границе — можно; управляющие символы вычищаются
    const ok = await ack(a.socket, 'presence:listening', { ...NP, title: `${'я'.repeat(199)}\n`, source: 'x'.repeat(40) });
    expect(ok.ok).toBe(true);
    expect(ok.listening.title).toBe('я'.repeat(199));
    expect(ok.listening.cover).toMatch(COVER_RE);
    // без названия — «ничего не играет»
    expect(await ack(a.socket, 'presence:listening', {})).toEqual({ ok: true, listening: null });
  });

  test('частота: не больше 8 обновлений за 12 с', async () => {
    const a = await user('npr');
    const res = [];
    for (let i = 0; i < 12; i++) res.push(await ack(a.socket, 'presence:listening', { ...NP, positionMs: 1000 * i }));
    const fails = res.filter((r) => !r.ok);
    expect(res.filter((r) => r.ok)).toHaveLength(8);
    expect(fails.length).toBe(4);
    expect(fails[0].error).toMatch(/Слишком часто/);
    // сброс («ничего не играет») проходит всегда
    expect((await ack(a.socket, 'presence:listening', {})).ok).toBe(true);
  });

  test('рассылка: участникам общих серверов и собеседникам по ЛС; чужим — нет; bootstrap; пауза и отключение сбрасывают', async () => {
    const a = await user('npa');
    const b = await user('npb');
    const c = await user('npc'); // ни сервера, ни ЛС с A
    const d = await user('npd'); // был на сервере, открыл ЛС с A, ушёл с сервера
    const srv = await createServer(a, 'NP сервер');
    await join(b, srv);
    await join(d, srv);
    expect((await ack(d.socket, 'dm:open', { userId: a.user.id })).ok).toBe(true);
    expect((await ack(d.socket, 'server:leave', { serverId: srv.id })).ok).toBe(true);
    const cGot = collect(c.socket, 'listening');

    const bEv = waitEvent(b.socket, 'listening', (e) => e.userId === a.user.id && e.listening);
    const dEv = waitEvent(d.socket, 'listening', (e) => e.userId === a.user.id && e.listening);
    const aEv = waitEvent(a.socket, 'listening', (e) => e.userId === a.user.id && e.listening); // свои вкладки
    const r = await ack(a.socket, 'presence:listening', NP);
    expect(r.ok).toBe(true);
    const ev = await bEv;
    expect(ev.listening).toMatchObject({ source: 'Spotify', kind: 'music', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', durationMs: 354000 });
    expect(ev.listening.positionMs).toBeGreaterThanOrEqual(30000);
    expect(ev.listening.positionMs).toBeLessThan(32000);
    expect(ev.listening.cover).toMatch(COVER_RE);
    await dEv;
    await aEv;

    // bootstrap: новый сокет B видит, что A слушает (позиция пересчитана на «сейчас»); C — нет
    await sleep(1100);
    const b2 = await connectUser(b.token);
    sockets.push(b2);
    const boot = await ack(b2, 'bootstrap');
    expect(boot.listening[a.user.id]).toMatchObject({ title: 'Bohemian Rhapsody' });
    expect(boot.listening[a.user.id].positionMs).toBeGreaterThanOrEqual(31000);
    const cBoot = await ack(c.socket, 'bootstrap');
    expect(cBoot.listening[a.user.id]).toBeUndefined();
    // вступил на сервер позже — получает сразу, без ожидания следующего обновления
    const e = await user('npe');
    const eEv = waitEvent(e.socket, 'listening', (x) => x.userId === a.user.id && x.listening);
    await join(e, srv);
    expect((await eEv).listening.title).toBe('Bohemian Rhapsody');

    // пауза → null всем
    const bNull = waitEvent(b.socket, 'listening', (e) => e.userId === a.user.id && e.listening === null);
    await ack(a.socket, 'presence:listening', {});
    await bNull;

    // снова играет, затем сокет A отключается → null
    const bAgain = waitEvent(b.socket, 'listening', (e) => e.userId === a.user.id && e.listening);
    await ack(a.socket, 'presence:listening', NP);
    await bAgain;
    const bGone = waitEvent(b.socket, 'listening', (e) => e.userId === a.user.id && e.listening === null);
    a.socket.disconnect();
    await bGone;
    expect(cGot.filter((e) => e.userId === a.user.id)).toHaveLength(0);
    const boot3 = await ack(b2, 'bootstrap');
    expect(boot3.listening[a.user.id]).toBeUndefined();
  });

  test('showListening=false и «невидимка»: не храним и не рассылаем; выключение сбрасывает уже показанное', async () => {
    const a = await user('nph');
    const b = await user('npw');
    const srv = await createServer(a, 'NP скрытый');
    await join(b, srv);
    const got = collect(b.socket, 'listening');
    const shown = waitEvent(b.socket, 'listening', (e) => e.userId === a.user.id && e.listening);
    await ack(a.socket, 'presence:listening', NP);
    await shown;

    // выключил «Показывать, что я слушаю» → B получает null
    const cleared = waitEvent(b.socket, 'listening', (e) => e.userId === a.user.id && e.listening === null);
    expect((await http('PATCH', '/api/me', { token: a.token, body: { showListening: false } })).status).toBe(200);
    await cleared;
    const n = got.length;
    const r = await ack(a.socket, 'presence:listening', NP);
    expect(r).toMatchObject({ ok: true, listening: null, hidden: true });
    await sleep(400);
    expect(got.length).toBe(n);
    expect((await ack(b.socket, 'bootstrap')).listening[a.user.id]).toBeUndefined();

    // включил обратно, но «невидимка» — тоже не рассылаем
    await http('PATCH', '/api/me', { token: a.token, body: { showListening: true, status: 'invisible' } });
    expect((await ack(a.socket, 'presence:listening', NP)).hidden).toBe(true);
    await sleep(300);
    expect(got.filter((e) => e.listening).length).toBe(1);
  });
});

/* =====================================================================================
   3. Приложение для ПК (Electron + подделка помощника --media) и зритель-браузер
   ===================================================================================== */
let xvfb = null;
test.describe('приложение для ПК: «Слушает Spotify»', () => {
  test.skip(!fs.existsSync(ELECTRON), 'нет desktop/node_modules (npm ci в desktop/)');
  test.setTimeout(150_000);

  test.beforeAll(async () => {
    if (!process.env.DISPLAY && fs.existsSync(ELECTRON)) {
      const disp = ':' + (80 + (Number(process.env.QA_PORT || 3200) % 9));
      xvfb = spawn('Xvfb', [disp, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      process.env.DISPLAY = disp;
      await sleep(800);
    }
  });
  test.afterAll(() => {
    if (!xvfb) return;
    process.kill(xvfb.pid, 'SIGTERM');
    delete process.env.DISPLAY;
    xvfb = null;
  });

  async function launch(mediaFile) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-np-'));
    const logFile = path.join(userData, 'fake.log');
    const app = await electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, `--server=${BASE_URL}`, `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, SOZVON_ALLOW_INSECURE_LOCALHOST: '1', SOZVON_CAPTURE_FAKE: FAKE, SOZVON_CAPTURE_FAKE_LOG: logFile, SOZVON_CAPTURE_FAKE_MEDIA: mediaFile },
      timeout: 60_000,
    });
    let win;
    await expect.poll(async () => {
      for (const w of app.windows()) if (w.url().startsWith(BASE_URL)) { win = w; return true; }
      return false;
    }, { timeout: 40_000 }).toBe(true);
    await win.waitForLoadState('domcontentloaded');
    const errors = [];
    win.on('pageerror', (e) => errors.push(e.message));
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const reg = await registerApi(uniqueName('np'));
    await win.evaluate((t) => localStorage.setItem('sozvon.token', t), reg.token);
    await win.reload();
    await expect(win.locator('#app')).toBeVisible({ timeout: 20_000 });
    const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    return { app, win, errors, readLog, reg, userData };
  }

  test('зритель видит «🎵 Spotify: …» и профиль с прогрессом; пауза убирает; браузер — только по настройке; выключатель', async ({ makePage }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-media-'));
    const mediaFile = path.join(dir, 'media.json');
    const setMedia = (sessions) => fs.writeFileSync(mediaFile, JSON.stringify({ sessions }));
    setMedia([SPOTIFY]);
    const A = await launch(mediaFile);
    const { win } = A;
    try {
      expect(await win.evaluate(() => window.sozvonDesktop.mediaWatch)).toBe(true);
      await createServerUI(win, 'Слушаем');
      const code = await inviteCode(win);
      const pb = await makePage({ name: 'B' });
      await loginViaToken(pb, 'npviewer');
      await joinServerUI(pb, code, 'Слушаем');

      const aId = A.reg.user.id;
      const line = pb.locator(`#members .member[data-user-id="${aId}"] .member__listening--pc`);
      await expect(line).toHaveText('🎵 Spotify: Queen — Bohemian Rhapsody', { timeout: 15000 });
      expect(A.readLog()).toMatch(/media-start/);
      // пока ничего не меняется, повторы помощника (раз в 5 с) не превращаются в рассылку (повтор — раз в 30 с)
      await pb.evaluate(() => import('/js/socket.js').then((m) => { window.__npCount = 0; m.getSocket().on('listening', () => { window.__npCount++; }); }));
      await sleep(6500);
      expect(await pb.evaluate(() => window.__npCount)).toBe(0);

      // профиль: «Слушает Spotify», обложка, название, исполнитель, альбом, живой прогресс, кнопки
      await pb.locator(`#members .member[data-user-id="${aId}"]`).click();
      const card = pb.locator('.profile-popup .profile-listening--pc');
      await expect(card.locator('h4')).toHaveText('Слушает Spotify');
      await expect(card.locator('.profile-listening__title')).toHaveText('Bohemian Rhapsody');
      await expect(card.locator('.profile-listening__artist')).toHaveText('Queen');
      await expect(card.locator('.profile-listening__album')).toHaveText('A Night at the Opera');
      // обложка — наш адрес /media/covers/… (поиск в интернете на тестовом сервере выключен: картинки нет — значок ноты)
      await expect(card.locator('.cover')).toBeVisible();
      expect(await pb.evaluate((id) => import('/js/state.js').then((m) => m.state.pcListening[id]?.cover), aId)).toMatch(COVER_RE);
      const cur = card.locator('.np-progress__cur');
      await expect(card.locator('.np-progress__time').last()).toHaveText('5:54');
      const t1 = await cur.innerText();
      expect(t1).toMatch(/^0:[34]\d$/); // 0:30 + сколько прошло
      await expect.poll(() => cur.innerText(), { timeout: 5000 }).not.toBe(t1); // идёт
      const yt = card.locator('[data-action="np-youtube"]');
      await expect(yt).toHaveAttribute('href', 'https://www.youtube.com/results?search_query=Queen%20Bohemian%20Rhapsody');
      const play = card.locator('[data-action="np-play"]');
      await expect(play).toBeDisabled(); // зритель не в голосовом канале
      await expect(play).toHaveAttribute('title', /голосовой канал/);
      await pb.keyboard.press('Escape');

      // пауза → пропадает
      setMedia([{ ...SPOTIFY, playing: false }]);
      await expect(line).toHaveCount(0, { timeout: 10000 });

      // играет браузер: по умолчанию не учитывается
      setMedia([{ ...SPOTIFY, playing: false }, CHROME]);
      await sleep(3000);
      await expect(line).toHaveCount(0);
      // источники в настройках (приложение): Spotify и Chrome, браузер выключен
      await win.evaluate(() => import('/js/ui/user-settings.js').then((m) => m.openUserSettings('profile')));
      const srcs = win.locator('#np-sources');
      await expect(srcs.locator('[data-source="spotify"]')).toBeVisible();
      await expect(srcs.locator('[data-source="chrome"]')).toBeDisabled();
      await expect(srcs.locator('.np-source', { hasText: 'Chrome' })).toContainText('играет');
      // «Учитывать браузеры» → зритель видит Chrome
      await win.locator('.setting', { hasText: 'Учитывать браузеры' }).locator('input[type=checkbox]').check();
      await expect(line).toHaveText('🎵 Chrome: Rick Astley — Never Gonna Give You Up', { timeout: 10000 });
      // снять галочку у источника Chrome → пропадает
      await expect(srcs.locator('[data-source="chrome"]')).toBeEnabled();
      await srcs.locator('[data-source="chrome"]').uncheck();
      await expect(line).toHaveCount(0, { timeout: 10000 });
      expect(await win.evaluate(() => import('/js/prefs.js').then((m) => m.prefs.get('activity.hiddenSources')))).toEqual({ chrome: true });

      // снова Spotify, затем «Показывать, что я слушаю» выключено — у зрителя пусто, помощник остановлен
      setMedia([SPOTIFY]);
      await expect(line).toHaveText('🎵 Spotify: Queen — Bohemian Rhapsody', { timeout: 10000 });
      await win.locator('#profile-show-listening').uncheck();
      await expect(line).toHaveCount(0, { timeout: 10000 });
      await expect.poll(() => /exit media/.test(A.readLog()), { timeout: 10000 }).toBe(true);
      const starts = (A.readLog().match(/media-start/g) || []).length;
      await sleep(2500);
      await expect(line).toHaveCount(0);
      // включили обратно — помощник снова запущен, статус вернулся
      await win.locator('#profile-show-listening').check();
      await expect(line).toHaveText('🎵 Spotify: Queen — Bohemian Rhapsody', { timeout: 15000 });
      expect((A.readLog().match(/media-start/g) || []).length).toBe(starts + 1);

      // у зрителя-браузера настроек «Источники» нет
      await pb.evaluate(() => import('/js/ui/user-settings.js').then((m) => m.openUserSettings('profile')));
      await expect(pb.locator('#profile-show-listening')).toBeVisible();
      await expect(pb.locator('#np-sources')).toHaveCount(0);
      expect(await pb.evaluate(() => !!window.sozvonDesktop)).toBe(false);
      expect(A.errors).toEqual([]);
    } finally {
      await A.app.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('помощник упал — перезапуск; «медиасессии недоступны» — без ошибок на странице', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-media-'));
    const A = await launch('unavailable');
    try {
      // код 4 три раза подряд (паузы 1 и 2 с) — сдаёмся; страница живёт дальше
      await expect.poll(() => (A.readLog().match(/media-start unavailable/g) || []).length, { timeout: 15000 }).toBe(3);
      await sleep(4000);
      expect((A.readLog().match(/media-start/g) || []).length).toBe(3);
      expect(A.errors).toEqual([]);
    } finally {
      await A.app.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
