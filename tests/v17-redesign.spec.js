// v17 «Astra 2.0»: темы серверов (права, валидация, рассылка), профили 2.0 (рамки, баннеры, значки),
// живой фон (настройка, уменьшение движения, пауза при трансляции), мобильная раскладка без горизонтальной прокрутки.
import fs from 'node:fs';
import { test, expect, loginViaToken, createServerUI, inviteCode, joinServerUI, openTextChannel, sendMessageUI, noHorizontalScroll } from './fixtures/ui.js';
import { http, ack, waitEvent, makeUser, createServer, voiceChannel, registerApi } from './fixtures/api.js';
import { ensureMedia } from './fixtures/media.js';
import { guild, ok, denied, makeRole, viewOf, closeAll, withId, P } from './fixtures/v3.js';
import { openSection, closeSettings } from './fixtures/v2.js';

const users = [];
const track = (u) => { users.push(u); return u; };
test.afterAll(() => closeAll(users));

// в headless окно может считаться «не в фокусе» — для детерминизма фокус есть всегда
const alwaysFocused = (page) => page.addInitScript(() => { Document.prototype.hasFocus = () => true; });

test.describe('v17 темы серверов (API)', () => {
  test('server:update theme: валидация, MANAGE_SERVER, рассылка server:updated, сброс', async () => {
    const { srv, owner, members: [b] } = await guild(1, 'Тема');
    track(owner); track(b);
    // без права — отказ
    await denied(b.socket, 'server:update', { serverId: srv.id, theme: { accent: '#ff8800', background: 'aurora' } }, /прав/i);
    // валидация
    await denied(owner.socket, 'server:update', { serverId: srv.id, theme: { accent: 'red' } }, /#rrggbb/);
    await denied(owner.socket, 'server:update', { serverId: srv.id, theme: { background: 'sun' } }, /фон/i);
    await denied(owner.socket, 'server:update', { serverId: srv.id, theme: 'nebula' });
    await denied(owner.socket, 'server:update', { serverId: srv.id, theme: [1] });
    // по умолчанию темы нет
    expect((await viewOf(b, srv.id)).theme).toBeNull();
    // владелец задаёт — участник получает server:updated
    const got = waitEvent(b.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.theme);
    const r = await ok(owner.socket, 'server:update', { serverId: srv.id, theme: { accent: '#FF8800', background: 'aurora' } });
    expect(r.server.theme).toEqual({ accent: '#ff8800', background: 'aurora' });
    expect((await got).server.theme).toEqual({ accent: '#ff8800', background: 'aurora' });
    // роль с MANAGE_SERVER может менять тему
    const mgr = await makeRole(owner, srv.id, { name: 'Дизайнер', permissions: P.MANAGE_SERVER });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: b.id, roleIds: [mgr.id] });
    await ok(b.socket, 'server:update', { serverId: srv.id, theme: { accent: null, background: 'galaxy' } });
    expect((await viewOf(owner, srv.id)).theme).toEqual({ accent: null, background: 'galaxy' });
    // пустая тема и null — сброс
    await ok(b.socket, 'server:update', { serverId: srv.id, theme: { accent: null, background: 'none' } });
    expect((await viewOf(owner, srv.id)).theme).toBeNull();
    await ok(owner.socket, 'server:update', { serverId: srv.id, theme: { accent: '#00b0f4' } });
    await ok(owner.socket, 'server:update', { serverId: srv.id, theme: null });
    expect((await viewOf(b, srv.id)).theme).toBeNull();
  });
});

test.describe('v17 профили 2.0 (API)', () => {
  test('рамка и баннер: валидация, рассылка user:updated; значки нельзя задать вручную', async () => {
    const { srv, owner, members: [b] } = await guild(1, 'Профили');
    track(owner); track(b);
    const bad1 = await http('PATCH', '/api/me', { token: owner.token, body: { avatarFrame: 'square' } });
    expect(bad1.status).toBe(400);
    const bad2 = await http('PATCH', '/api/me', { token: owner.token, body: { bannerPreset: 'http://evil' } });
    expect(bad2.status).toBe(400);
    const bad3 = await http('PATCH', '/api/me', { token: owner.token, body: { badges: ['founder', 'veteran'] } });
    expect(bad3.status).toBe(400);
    const seen = waitEvent(b.socket, 'user:updated', (d) => d.user?.id === owner.id && d.user.avatarFrame === 'orbit');
    const r = await http('PATCH', '/api/me', { token: owner.token, body: { avatarFrame: 'orbit', bannerPreset: 'nebula' } });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ avatarFrame: 'orbit', bannerPreset: 'nebula' });
    expect((await seen).user.bannerPreset).toBe('nebula');
    // в участниках сервера — тоже
    const m = (await viewOf(b, srv.id)).members.find((x) => x.id === owner.id);
    expect(m).toMatchObject({ avatarFrame: 'orbit', bannerPreset: 'nebula' });
    // сброс
    const r2 = await http('PATCH', '/api/me', { token: owner.token, body: { avatarFrame: null, bannerPreset: 'none' } });
    expect(r2.json.user).toMatchObject({ avatarFrame: null, bannerPreset: null });
  });

  test('значки: Основатель, Бот, Меломан (≥5 треков), Стример; новичок — не Ветеран', async () => {
    const fresh = await registerApi();
    const me0 = await http('GET', '/api/me', { token: fresh.token });
    expect(me0.json.user.badges).toEqual([]);

    const owner = track(withId(await makeUser('bdg')));
    const srv = await createServer(owner, 'Значки');
    const view = await viewOf(owner, srv.id);
    const self = view.members.find((x) => x.id === owner.id);
    expect(self.badges).toContain('founder');
    expect(self.badges).not.toContain('veteran');
    const bot = view.members.find((x) => x.isBot);
    if (bot) expect(bot.badges).toEqual(['bot']);

    // Меломан: 5 загруженных треков (addedBy = имя пользователя); потом убираем, чтобы не мешать другим тестам
    const { upload } = ensureMedia();
    const buf = fs.readFileSync(upload);
    const ids = [];
    try {
      for (let i = 0; i < 5; i++) {
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), `v17-melomane-${i}.mp3`);
        const up = await http('POST', '/api/music/upload', { token: owner.token, body: fd });
        expect(up.status).toBe(200);
        ids.push(up.json.track.id);
        if (i === 3) expect((await http('GET', '/api/me', { token: owner.token })).json.user.badges).not.toContain('melomane');
      }
      expect((await http('GET', '/api/me', { token: owner.token })).json.user.badges).toContain('melomane');
    } finally {
      for (const id of ids) await http('DELETE', `/api/music/${encodeURIComponent(id)}`, { token: owner.token });
    }
    expect((await http('GET', '/api/me', { token: owner.token })).json.user.badges).not.toContain('melomane');

    // Стример: первая трансляция экрана → user:updated со значком
    const vc = voiceChannel(srv);
    await ok(owner.socket, 'voice:join', { channelId: vc.id });
    const upd = waitEvent(owner.socket, 'user:updated', (d) => d.user?.id === owner.id && d.user.badges?.includes('streamer'));
    owner.socket.emit('voice:state', { streaming: true });
    await upd;
    owner.socket.emit('voice:state', { streaming: false });
    await ack(owner.socket, 'voice:leave');
    expect((await http('GET', '/api/me', { token: owner.token })).json.user.badges).toEqual(expect.arrayContaining(['founder', 'streamer']));
  });
});

test.describe('v17 профили 2.0 (UI)', () => {
  test('рамка в участниках и сообщениях, значки и анимированный баннер в карточке, выбор рамки в настройках', async ({ makePage }) => {
    const page = await makePage({ name: 'A' });
    const reg = await loginViaToken(page, 'frm');
    await createServerUI(page, 'Рамки');
    const set = await http('PATCH', '/api/me', { token: reg.token, body: { avatarFrame: 'nova', bannerPreset: 'aurora' } });
    expect(set.status).toBe(200);
    await openTextChannel(page);
    await sendMessageUI(page, 'Привет из космоса');
    await expect(page.locator(`#members .member[data-user-id="${reg.user.id}"] .avatar[data-frame="nova"]`)).toHaveCount(1);
    await expect(page.locator('#messages .message .avatar[data-frame="nova"]').first()).toBeVisible();
    // рамку рисует CSS: у ::after есть картинка
    const bg = await page.locator('#messages .message .avatar[data-frame="nova"]').first()
      .evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
    expect(bg).toContain('/assets/frames/nova.svg');
    // карточка профиля
    await page.locator(`#members .member[data-user-id="${reg.user.id}"]`).click();
    const card = page.locator('.profile-popup').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.profile-popup__avatar[data-frame="nova"]')).toHaveCount(1);
    await expect(card.locator('.profile-popup__banner[data-preset="aurora"]')).toHaveCount(1);
    await expect(card.locator('.astra-badge--founder')).toBeVisible();
    await expect(card.locator('.astra-badge--founder')).toHaveAttribute('title', /Основатель/);
    await page.keyboard.press('Escape');

    // настройки → Профиль → выбрать «Комета» и «Галактика» → сохранить
    const panel = await openSection(page, 'profile');
    await panel.locator('#profile-frame-picker [data-frame-choice="comet"]').click();
    await expect(panel.locator('#profile-frame-picker [data-frame-choice="comet"]')).toHaveAttribute('aria-checked', 'true');
    await expect(panel.locator('#profile-preview .profile-popup__avatar[data-frame="comet"]')).toHaveCount(1);
    await panel.locator('#profile-banner-preset-picker [data-banner-preset="galaxy"]').click();
    await expect(panel.locator('#profile-preview .profile-popup__banner[data-preset="galaxy"]')).toHaveCount(1);
    await page.locator('#btn-profile-save').click();
    await expect.poll(async () => (await http('GET', '/api/me', { token: reg.token })).json.user)
      .toMatchObject({ avatarFrame: 'comet', bannerPreset: 'galaxy' });
    await closeSettings(page);
    await expect(page.locator(`#members .member[data-user-id="${reg.user.id}"] .avatar[data-frame="comet"]`)).toHaveCount(1);
  });
});

test.describe('v17 живой фон', () => {
  test('по умолчанию идёт; настройка «Анимированный фон», уменьшение движения, трансляция и голосовой канал ставят на паузу', async ({ makePage }) => {
    const page = await makePage({ name: 'A' });
    await alwaysFocused(page);
    await loginViaToken(page, 'bg');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-cosmos', 'live');
    const playState = () => page.evaluate(() => getComputedStyle(document.body, '::before').animationPlayState);
    expect(await playState()).toBe('running');

    // трансляция в голосовом → фон замирает
    await page.evaluate(() => { window.__sozvon.state.streaming = true; window.__sozvon.cosmos.update(); });
    await expect(html).toHaveAttribute('data-cosmos', 'still');
    await expect(html).toHaveAttribute('data-cosmos-why', 'media');
    await page.evaluate(() => { window.__sozvon.state.streaming = false; window.__sozvon.cosmos.update(); });
    await expect(html).toHaveAttribute('data-cosmos', 'live');
    // в голосовом канале (звонок + игра) — тоже пауза
    await page.evaluate(() => { window.__sozvon.state.myVoice = { channelId: 'x', serverId: 'y' }; window.__sozvon.cosmos.update(); });
    await expect(html).toHaveAttribute('data-cosmos-why', 'voice');
    await page.evaluate(() => { window.__sozvon.state.myVoice = null; window.__sozvon.cosmos.update(); });
    await expect(html).toHaveAttribute('data-cosmos', 'live');

    // настройка в «Внешнем виде»
    const panel = await openSection(page, 'appearance');
    const sw = panel.locator('input.switch[data-pref="appearance.animatedBg"]');
    await expect(sw).toBeChecked();
    await panel.locator('label', { hasText: 'Анимированный фон' }).click();
    await expect(sw).not.toBeChecked();
    await closeSettings(page);
    await expect(html).toHaveAttribute('data-anim-bg', 'off');
    await expect(html).toHaveAttribute('data-cosmos', 'still');
    await expect(html).toHaveAttribute('data-cosmos-why', 'pref');
    expect(await page.evaluate(() => getComputedStyle(document.body, '::before').animationName)).toBe('none');
    // до первой отрисовки (theme-boot.js) после перезагрузки
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect(html).toHaveAttribute('data-anim-bg', 'off');
    await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('sozvon.prefs')); p['appearance.animatedBg'] = true; localStorage.setItem('sozvon.prefs', JSON.stringify(p)); });
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect(html).toHaveAttribute('data-cosmos', 'live');

    // системное «уменьшить движение»
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(html).toHaveAttribute('data-cosmos', 'still');
    await expect(html).toHaveAttribute('data-cosmos-why', 'motion');
    expect(await page.evaluate(() => getComputedStyle(document.body, '::before').animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(html).toHaveAttribute('data-cosmos', 'live');
  });

  test('светлая тема: звёзд нет; вкладка в фоне — пауза', async ({ makePage }) => {
    const page = await makePage({ name: 'A' });
    await loginViaToken(page, 'bgl');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    // скрытая вкладка
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('html')).toHaveAttribute('data-cosmos-why', 'hidden');
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('sozvon.prefs') || '{}'); p['appearance.theme'] = 'light';
      localStorage.setItem('sozvon.prefs', JSON.stringify(p));
    });
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-cosmos-why', 'theme');
    expect(await page.evaluate(() => getComputedStyle(document.body, '::before').display)).toBe('none');
  });
});

test.describe('v17 темы серверов (UI)', () => {
  test('владелец задаёт акцент и фон в «Оформлении» — у друга применяется сразу; без права раздела нет', async ({ makePage }) => {
    const pa = await makePage({ name: 'A' });
    const pb = await makePage({ name: 'B' });
    await alwaysFocused(pa);
    await loginViaToken(pa, 'thm');
    await createServerUI(pa, 'Туманность');
    const code = await inviteCode(pa);
    await loginViaToken(pb, 'thf');
    await joinServerUI(pb, code, 'Туманность');

    await pa.locator('#btn-server-menu').click();
    await expect(pa.locator('#modal-settings')).toBeVisible();
    await pa.locator('#ss-tab-appearance').click();
    const panel = pa.locator('#ss-panel-appearance');
    await expect(panel).toBeVisible();
    await panel.locator('[data-accent="#ec4899"]').click();
    await panel.locator('[data-server-bg="nebula"]').click();
    await expect(panel.locator('#ss-theme-preview')).toHaveAttribute('data-bg', 'nebula');
    await panel.locator('#ss-theme-save').click();
    await expect(panel.locator('#ss-theme-bar')).toBeHidden();
    await pa.keyboard.press('Escape');

    for (const p of [pa, pb]) {
      await expect(p.locator('html')).toHaveAttribute('data-server-bg', 'nebula');
      await expect(p.locator('html')).toHaveAttribute('data-server-accent', '#ec4899');
      expect(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#ec4899');
    }
    // у участника без «Управлять сервером» раздела нет
    await pb.locator('#btn-server-menu').click();
    await expect(pb.locator('#modal-settings')).toBeVisible();
    await expect(pb.locator('#ss-tab-appearance')).toBeHidden();
    await pb.keyboard.press('Escape');
    // «Главная» (ЛС) — тема сервера не применяется
    await pb.locator('#btn-home').click();
    await expect(pb.locator('html')).not.toHaveAttribute('data-server-bg', /.+/);
    await expect(pb.locator('html')).not.toHaveAttribute('data-server-accent', /.+/);
  });
});

test.describe('v17 мобильная раскладка 375 px', () => {
  test('вход, чат, настройки профиля и оформления сервера — без горизонтальной прокрутки', async ({ makePage }) => {
    const page = await makePage({ name: 'M', viewport: { width: 375, height: 812 } });
    await page.goto('/');
    await expect(page.locator('#auth-screen')).toBeVisible();
    expect((await noHorizontalScroll(page)).ok, 'вход').toBe(true);
    await loginViaToken(page, 'mob');
    expect((await noHorizontalScroll(page)).ok, 'главная').toBe(true);
    await page.locator('#btn-menu').click();
    await createServerUI(page, 'Мобильный');
    if (await page.locator('#app.is-nav-open').count()) await page.keyboard.press('Escape');
    expect((await noHorizontalScroll(page)).ok, 'чат').toBe(true);
    const panel = await openSection(page, 'profile');
    await expect(panel.locator('#profile-frame-picker')).toBeVisible();
    const inner = await page.evaluate(() => {
      const s = document.querySelector('#modal-user-settings .settings__scroll');
      return { sw: s.scrollWidth, cw: s.clientWidth };
    });
    expect(inner.sw, 'настройки профиля шире экрана').toBeLessThanOrEqual(inner.cw);
    expect((await noHorizontalScroll(page)).ok, 'настройки профиля').toBe(true);
    await closeSettings(page);
    if (!(await page.locator('#app.is-nav-open').count())) await page.locator('#btn-menu').click();
    await page.locator('#btn-server-menu').click();
    await expect(page.locator('#modal-settings')).toBeVisible();
    await page.locator('#ss-tab-appearance').click();
    await expect(page.locator('#ss-panel-appearance')).toBeVisible();
    const ss = await page.evaluate(() => {
      const s = document.querySelector('#ss-scroll');
      return { sw: s.scrollWidth, cw: s.clientWidth };
    });
    expect(ss.sw, 'оформление сервера шире экрана').toBeLessThanOrEqual(ss.cw);
    expect((await noHorizontalScroll(page)).ok, 'оформление сервера').toBe(true);
  });
});

