// Полный аудит: PWA, мобильная вёрстка 375px по всем основным экранам, настройки сервера (все разделы),
// бан → разбан через UI, модератор с MANAGE_CHANNELS переименовывает голосовой канал, REST-мелочи. owner: qa
import {
  test, expect, loginViaToken, createServerUI, twoUsersOneServer, joinVoiceUI, openTextChannel, channel, noHorizontalScroll,
} from './fixtures/ui.js';
import { http } from './fixtures/api.js';
import { openSection, closeSettings } from './fixtures/v2.js';

test.describe('audit: PWA и статика', () => {
  test('manifest: имя, start_url, display, иконки 192/512 отдаются; service worker регистрируется', async ({ makePage }) => {
    const m = await http('GET', '/manifest.webmanifest');
    expect(m.status).toBe(200);
    const j = m.json;
    expect(j.name || j.short_name).toBeTruthy();
    expect(j.start_url).toBeTruthy();
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(j.display);
    const sizes = j.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const i of j.icons) expect((await http('GET', i.src, { raw: true })).status, i.src).toBe(200);
    const p = await makePage();
    await loginViaToken(p, 'pwa');
    await expect.poll(() => p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))), { timeout: 15000 }).toBe(true);
  });

  test('REST: неизвестный путь → 404 JSON по-русски; кривой JSON → 400, не 500; /api/me без токена → 401', async () => {
    const r = await http('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/[а-я]/i);
    const bad = await http('POST', '/api/login', { body: undefined, headers: { 'Content-Type': 'application/json' }, raw: true });
    expect(bad.status).toBeLessThan(500);
    const res = await fetch(new URL('/api/login', (await import('./fixtures/env.js')).BASE_URL), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
    expect((await http('GET', '/api/me')).status).toBe(401);
    // обход каталога в медиа
    for (const u of ['/media/uploads/..%2f..%2fdb.json', '/media/music/..%2fdb.json', '/media/avatars/..%2f..%2fdb.json']) {
      expect([400, 403, 404], u).toContain((await http('GET', u, { raw: true })).status);
    }
  });
});

test.describe('audit: мобильная вёрстка 375px', () => {
  test('чат, голос, настройки пользователя и сервера, библиотека музыки — без горизонтального скролла, управление доступно', async ({ makePage }) => {
    test.setTimeout(120_000);
    const p = await makePage({ viewport: { width: 375, height: 740 }, context: { isMobile: true, hasTouch: true } });
    await loginViaToken(p, 'mob');
    await p.locator('#btn-menu').click();
    await createServerUI(p, 'Мобила');
    const check = async (what) => { const r = await noHorizontalScroll(p); expect(r.ok, `${what}: ${JSON.stringify(r)}`).toBe(true); };
    await check('после создания сервера');
    if (!(await p.locator('#app.is-nav-open').count())) await p.locator('#btn-menu').click();
    await channel(p, 'text', 'общий').click();
    await expect(p.locator('#composer-input')).toBeVisible();
    await check('чат');
    if (!(await p.locator('#app.is-nav-open').count())) await p.locator('#btn-menu').click();
    await joinVoiceUI(p);
    await check('голос');
    for (const id of ['#ctrl-mute', '#ctrl-deafen', '#ctrl-camera', '#ctrl-screen', '#ctrl-leave']) {
      const b = await p.locator(id).boundingBox();
      expect(b, id).toBeTruthy();
      expect(b.x >= 0 && b.x + b.width <= 375, `${id} в пределах экрана`).toBe(true);
    }
    for (const sec of ['account', 'profile', 'voice', 'appearance', 'notifications', 'keybinds', 'about']) {
      await openSection(p, sec);
      await check(`настройки/${sec}`);
    }
    await closeSettings(p);
    if (!(await p.locator('#app.is-nav-open').count())) await p.locator('#btn-menu').click();
    await p.locator('#btn-server-menu').click();
    await expect(p.locator('#modal-settings')).toBeVisible();
    await check('настройки сервера');
    await p.keyboard.press('Escape');
    await expect(p.locator('#modal-settings')).toBeHidden();
  });
});

test.describe('audit: настройки сервера и модерация через UI', () => {
  test('все разделы настроек сервера открываются у владельца без ошибок; у рядового — только «Обзор» и выход', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Разделы');
    await pa.locator('#btn-server-menu').click();
    const m = pa.locator('#modal-settings');
    await expect(m).toBeVisible();
    for (const id of ['overview', 'roles', 'members', 'bans', 'channels']) {
      await m.locator(`#ss-tab-${id}`).click();
      await expect(m.locator(`#ss-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
    }
    await pa.keyboard.press('Escape');
    await pb.locator('#btn-server-menu').click();
    const mb = pb.locator('#modal-settings');
    await expect(mb).toBeVisible();
    for (const id of ['roles', 'members', 'bans', 'channels']) await expect(mb.locator(`#ss-tab-${id}`), id).toBeHidden();
    await expect(pb.locator('#server-rename-input')).toHaveJSProperty('readOnly', true);
  });

  test('бан через меню участника → у B сервер пропал, по инвайту не войти; разбан в «Баны» → B входит', async ({ makePage }) => {
    const { pa, pb, ub, code } = await twoUsersOneServer(makePage, 'Баны UI');
    const bId = (await http('GET', '/api/me', { token: ub.token })).json.user.id;
    await pa.locator(`.member[data-user-id="${bId}"]`).click({ button: 'right' });
    await pa.locator('.context-menu [data-action="ban"]').click();
    await expect(pa.locator('#modal-reason')).toBeVisible();
    await pa.locator('#reason-input').fill('спам');
    await pa.locator('#reason-ok').click();
    await expect(pb.locator('#server-name')).not.toHaveText('Баны UI', { timeout: 10000 });
    await expect(pb.locator('#toasts')).toContainText(/забанили/i);
    // B пытается вернуться
    await pb.locator('#btn-add-server').click();
    const modal = pb.locator('#modal-server');
    await modal.locator('.tab').nth(1).click();
    await pb.locator('#invite-input').fill(code);
    await modal.locator('.btn--primary:visible').first().click();
    await expect(modal.locator('[data-error]:visible').first()).toContainText(/заблокированы/);
    await pb.keyboard.press('Escape');
    // разбан
    await pa.locator('#btn-server-menu').click();
    await pa.locator('#ss-tab-bans').click();
    const row = pa.locator('#modal-settings [data-action="unban"]');
    await expect(row).toHaveCount(1);
    await expect(pa.locator('#modal-settings')).toContainText('спам');
    await row.click();
    await expect(row).toHaveCount(0);
    await pa.keyboard.press('Escape');
    await pb.locator('#btn-add-server').click();
    await modal.locator('.tab').nth(1).click();
    await pb.locator('#invite-input').fill(code);
    await modal.locator('.btn--primary:visible').first().click();
    await expect(pb.locator('#server-name')).toHaveText('Баны UI');
  });

  test('модератор (роль с MANAGE_CHANNELS, не владелец) видит шестерёнку и переименовывает голосовой канал', async ({ makePage }) => {
    const { pa, pb, ub } = await twoUsersOneServer(makePage, 'Модер');
    const bId = (await http('GET', '/api/me', { token: ub.token })).json.user.id;
    await expect(channel(pb, 'voice', 'Голосовой').locator('.channel__edit')).toHaveCount(0);
    await pa.evaluate(async (uid) => {
      const s = window.__sozvon.state.servers[0];
      const P = window.__sozvon.perms.PERMS;
      const emit = (ev, d) => new Promise((res) => window.__sozvon.socket.emit(ev, d, res));
      const r = await emit('role:create', { serverId: s.id, name: 'Каналы', permissions: P.MANAGE_CHANNELS });
      await emit('member:roles', { serverId: s.id, userId: uid, roleIds: [r.role.id] });
    }, bId);
    const row = channel(pb, 'voice', 'Голосовой');
    await expect(row.locator('.channel__edit')).toHaveCount(1);
    await row.hover();
    await row.locator('.channel__edit').click();
    await pb.locator('#channel-edit-name').fill('Модерская');
    await pb.locator('#btn-channel-perms-save').click();
    await expect(pb.locator('#modal-channel-perms')).toBeHidden();
    await expect(channel(pa, 'voice', 'Модерская')).toBeVisible();
  });

  test('рядовой в голосе: владелец через меню глушит (server mute) и отключает его', async ({ makePage }) => {
    const { pa, pb, ub } = await twoUsersOneServer(makePage, 'Глушилка');
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    const vu = pa.locator('.voice-user').filter({ hasText: ub.username });
    await vu.click({ button: 'right' });
    const menu = pa.locator('.context-menu');
    await expect(menu).toBeVisible();
    const sm = menu.locator('[data-action="server-mute"]');
    await expect(sm).toHaveCount(1);
    await sm.click();
    await expect(pb.locator('#ctrl-mute')).toHaveClass(/is-on/, { timeout: 10000 });
    await pa.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await vu.click({ button: 'right' });
    await expect(menu).toBeVisible();
    const disc = menu.locator('[data-action="disconnect"]');
    await expect(disc).toHaveCount(1);
    await disc.click();
    await expect(pb.locator('#voice-panel')).toBeHidden({ timeout: 10000 });
  });
});
