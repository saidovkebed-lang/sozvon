// v3 UI: роли (настройки сервера, контекстное меню, цвет ника, hoist), профиль (аватар/попап/статус),
// пинг, качество стрима 1080p60. Селекторы — согласованы с frontend (см. docs/QA_REPORT.md, раздел v3). owner: qa
import { test, expect, twoUsersOneServer, loginViaToken, createServerUI, inviteCode, joinServerUI, openTextChannel, sendMessageUI, joinVoiceUI, messageWith, startScreenShare } from './fixtures/ui.js';
import { connectUser, ack, http, sleep } from './fixtures/api.js';
import { BASE_URL } from './fixtures/env.js';
import { P, DEFAULT_EVERYONE, ok, ensureV3Media, upload } from './fixtures/v3.js';
import { trackPeerConnections, openSection } from './fixtures/v2.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

/** A (владелец) и B в одном сервере через UI + сокет владельца для быстрых API-операций. */
async function setup(makePage, name = 'Роли QA') {
  const r = await twoUsersOneServer(makePage, name);
  const sa = await connectUser(r.ua.token); socks.push(sa);
  const sb = await connectUser(r.ub.token); socks.push(sb);
  const srv = (await ack(sa, 'bootstrap')).servers.find((s) => s.name === name);
  return { ...r, sa, sb, srv, A: { socket: sa, id: r.ua.user.id, token: r.ua.token }, B: { socket: sb, id: r.ub.user.id, token: r.ub.token } };
}

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

test.describe('v3 UI: роли', () => {
  test('настройки сервера → Роли: создать роль через UI, она есть на сервере; цвет ника по роли и hoist-группа у обоих', async ({ makePage }) => {
    const { pa, pb, sa, srv, B, ub } = await setup(makePage);
    await pa.locator('#btn-server-menu').click();
    const modal = pa.locator('#modal-settings');
    await expect(modal).toBeVisible();
    await modal.locator('button[data-ssection="roles"]').click();
    await expect(modal.locator('[data-spanel="roles"]')).toBeVisible();
    const before = await modal.locator('.role-row[data-role-id]').count();
    await modal.locator('#btn-role-create').click();
    await expect(modal.locator('.role-row[data-role-id]')).toHaveCount(before + 1);
    let roles;
    await expect.poll(async () => { roles = (await ack(sa, 'bootstrap')).servers.find((s) => s.id === srv.id).roles; return roles.length; }).toBe(2);
    const role = roles.find((r) => r.id !== srv.id);
    // переименование и право через редактор
    await modal.locator(`.role-row[data-role-id="${role.id}"]`).click();
    await modal.locator('#role-name-input').fill('Админы');
    await modal.locator('#role-name-input').press('Enter').catch(() => {});
    const kick = modal.locator('input[type=checkbox][data-perm="KICK_MEMBERS"]');
    // права — на вкладке «Права» редактора роли
    if (!(await kick.isVisible())) await modal.locator('[data-spanel="roles"]').getByRole('button', { name: /^Права$/ }).or(modal.locator('[data-spanel="roles"] [role=tab]', { hasText: /^Права$/ })).first().click();
    const kickLabel = kick.locator('xpath=ancestor::label[1]');
    if (await kick.isVisible()) await kick.check(); else if (await kickLabel.count()) await kickLabel.click(); else await kick.check({ force: true });
    await expect(kick).toBeChecked();
    const save = modal.locator('[data-spanel="roles"] button[type=submit], [data-spanel="roles"] #btn-role-save');
    if (await save.count() && await save.first().isVisible()) await save.first().click();
    await expect.poll(async () => {
      const r = (await ack(sa, 'bootstrap')).servers.find((s) => s.id === srv.id).roles.find((x) => x.id === role.id);
      return r && r.name === 'Админы' && (r.permissions & P.KICK_MEMBERS) !== 0;
    }, { message: 'имя и KICK_MEMBERS из редактора дошли до сервера' }).toBe(true);
    await pa.keyboard.press('Escape');
    // цвет + hoist + выдача B — через API, проверяем отображение
    await ok(sa, 'role:update', { serverId: srv.id, roleId: role.id, color: '#e91e63', hoist: true });
    await ok(sa, 'member:roles', { serverId: srv.id, userId: B.id, roleIds: [role.id] });
    for (const p of [pa, pb]) {
      const group = p.locator(`.members__group[data-group="${role.id}"]`);
      await expect(group).toBeVisible();
      await expect(group.locator('.members__title')).toHaveText(/Админы\s*—\s*1/);
      await expect(group.locator(`.member[data-user-id="${B.id}"] .member__name`)).toHaveCSS('color', rgb('#e91e63'));
      await expect(p.locator('.members__group[data-group="online"]')).toBeVisible();
    }
    await openTextChannel(pb);
    await sendMessageUI(pb, 'цветной ник');
    await expect(messageWith(pa, 'цветной ник').locator('.message__author')).toHaveCSS('color', rgb('#e91e63'));
    void ub;
  });

  test('контекстное меню участника: владелец видит kick/ban/роли, рядовой — нет; кик через меню + причина', async ({ makePage }) => {
    const { pa, pb, srv, B, A, sa } = await setup(makePage, 'Меню QA');
    // пункт «Роли» имеет смысл, когда есть хотя бы одна роль кроме @everyone
    await ok(sa, 'role:create', { serverId: srv.id, name: 'Тестеры', color: '#3498db' });
    // рядовой B по владельцу: нет модерации
    await pb.locator(`.member[data-user-id="${A.id}"]`).click({ button: 'right' });
    const menuB = pb.locator('.context-menu');
    await expect(menuB).toBeVisible();
    await expect(menuB.locator('[data-action="kick"], [data-action="ban"], [data-action="roles"]')).toHaveCount(0);
    await expect(menuB.locator('[data-action="profile"]')).toHaveCount(1);
    await pb.keyboard.press('Escape');
    // владелец по B
    await pa.locator(`.member[data-user-id="${B.id}"]`).click({ button: 'right' });
    const menu = pa.locator('.context-menu');
    for (const a of ['profile', 'roles', 'kick', 'ban']) await expect(menu.locator(`[data-action="${a}"]`), a).toHaveCount(1);
    await menu.locator('[data-action="kick"]').click();
    await expect(pa.locator('#modal-reason')).toBeVisible();
    await pa.locator('#reason-input').fill('проверка кика');
    await pa.locator('#reason-ok').click();
    // B вылетел с сервера
    await expect(pb.locator('#server-name')).not.toHaveText('Меню QA', { timeout: 10000 });
    await expect(pa.locator(`.member[data-user-id="${B.id}"]`)).toHaveCount(0);
    void srv;
  });

  test('приватный канал не виден в сайдбаре у участника без роли; появляется при выдаче роли', async ({ makePage }) => {
    const { pa, pb, sa, srv, B } = await setup(makePage, 'Приват QA');
    const vip = (await ok(sa, 'role:create', { serverId: srv.id, name: 'VIP' })).role;
    const ch = (await ok(sa, 'channel:create', { serverId: srv.id, name: 'вип-зал', type: 'text' })).channel;
    await ok(sa, 'channel:update', { channelId: ch.id, overwrites: { [srv.id]: { allow: 0, deny: P.VIEW_CHANNEL }, [vip.id]: { allow: P.VIEW_CHANNEL, deny: 0 } } });
    await expect(pa.locator('a.channel[data-type="text"]', { hasText: 'вип-зал' })).toHaveCount(1);
    await expect(pb.locator('a.channel[data-type="text"]', { hasText: 'вип-зал' })).toHaveCount(0);
    await ok(sa, 'member:roles', { serverId: srv.id, userId: B.id, roleIds: [vip.id] });
    await expect(pb.locator('a.channel[data-type="text"]', { hasText: 'вип-зал' })).toHaveCount(1);
  });

  test('без SEND_MESSAGES композер у участника заблокирован/понятная ошибка, а не тихая потеря', async ({ makePage }) => {
    const { pb, sa, srv } = await setup(makePage, 'Немой QA');
    await ok(sa, 'role:update', { serverId: srv.id, roleId: srv.id, permissions: DEFAULT_EVERYONE & ~P.SEND_MESSAGES });
    await openTextChannel(pb).catch(() => {});
    const input = pb.locator('#composer-input');
    const disabled = await input.isDisabled().catch(() => true);
    if (!disabled) {
      await input.fill('нельзя');
      await input.press('Enter');
      await expect(pb.locator('.toast, #composer-error, .composer__error').filter({ hasText: /прав|нельзя|не можете/i }).first()).toBeVisible();
    }
    await expect(messageWith(pb, 'нельзя')).toHaveCount(0);
  });
});

test.describe('v3 UI: профиль', () => {
  test('аватар (GIF): img вместо буквы, статичный src, анимированный при hover; попап профиля у другого — баннер, about, статус, тема, роли', async ({ makePage }) => {
    const media = ensureV3Media();
    const { pa, pb, sa, srv, A } = await setup(makePage, 'Профиль QA');
    const up = await upload(BASE_URL, '/api/me/avatar', A.token, media.gif, 'image/gif');
    expect(up.status).toBe(200);
    const { avatar, avatarAnimated } = up.json.user;
    expect(avatarAnimated).toBeTruthy();
    await upload(BASE_URL, '/api/me/banner', A.token, media.banner, 'image/png');
    await http('PATCH', '/api/me', { token: A.token, body: {
      displayName: 'Аня QA', about: 'Люблю **созвоны**', pronouns: 'она/её',
      customStatus: { emoji: '🎧', text: 'слушаю музыку', expiresAt: null }, profileTheme: { primary: '#ff0055', accent: '#3355ff' } } });
    const role = (await ok(sa, 'role:create', { serverId: srv.id, name: 'Основатель', color: '#f1c40f' })).role;
    await ok(sa, 'member:roles', { serverId: srv.id, userId: A.id, roleIds: [role.id] });
    await openTextChannel(pa);
    await sendMessageUI(pa, 'сообщение с аватаром');
    // у B: в участниках и сообщении — img, статичная версия
    const memberImg = pb.locator(`.member[data-user-id="${A.id}"] .avatar.has-img img.avatar__img`);
    await expect(memberImg).toHaveAttribute('src', new RegExp(avatar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(memberImg).toHaveAttribute('data-animated', avatarAnimated);
    await openTextChannel(pb);
    const msg = messageWith(pb, 'сообщение с аватаром');
    const msgImg = msg.locator('.avatar img.avatar__img');
    await expect(msgImg).toHaveAttribute('src', new RegExp(avatar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(msg.locator('.avatar')).toHaveClass(/has-img/);
    await expect(msg.locator('.avatar img.avatar__img')).toBeVisible();
    await msg.hover();
    await expect(msgImg).toHaveAttribute('src', new RegExp(avatarAnimated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await pb.mouse.move(5, 5);
    await expect(msgImg).toHaveAttribute('src', new RegExp(avatar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // имя автора — displayName
    await expect(msg.locator('.message__author')).toHaveText(/Аня QA/);
    // попап профиля
    await msg.locator('.message__author').click();
    const pop = pb.locator('.profile-popup').locator('visible=true').first();
    await expect(pop).toBeVisible();
    await pb.waitForTimeout(300); // анимация появления
    const box = await pop.boundingBox(); const vpH = pb.viewportSize().height;
    expect(box.y, 'попап не прилипает к верху').toBeGreaterThanOrEqual(4);
    expect(box.y + box.height, `попап профиля целиком во вьюпорте с отступом (UI-v3-1): низ ${Math.round(box.y + box.height)} из ${vpH}`).toBeLessThanOrEqual(vpH - 4);
    await expect(pop.locator('.profile-popup__name')).toHaveText(/Аня QA/);
    await expect(pop.locator('.profile-popup__username')).toContainText('@');
    await expect(pop.locator('.profile-popup__pronouns')).toHaveText(/она\/её/);
    await expect(pop.locator('.profile-popup__status')).toContainText('слушаю музыку');
    await expect(pop.locator('.profile-popup__about')).toContainText('созвоны');
    await expect(pop.locator('.profile-popup__about strong, .profile-popup__about b')).toHaveText('созвоны');
    await expect(pop.locator(`.profile-popup__roles .role-pill[data-role-id="${role.id}"]`)).toContainText('Основатель');
    await expect(pop.locator('.role-pill--add'), 'у B нет MANAGE_ROLES → нет «+»').toHaveCount(0);
    await expect(pop.locator('.profile-popup__since')).toBeVisible();
    const bannerBg = await pop.locator('.profile-popup__banner').evaluate((el) => {
      const img = el.querySelector('img'); return (img && img.src) || getComputedStyle(el).backgroundImage;
    });
    expect(bannerBg).toMatch(/\/media\/banners\//);
    // в попапе анимированный аватар всегда
    await expect(pop.locator('.profile-popup__avatar img')).toHaveAttribute('src', new RegExp(avatarAnimated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // тема профиля: градиент primary→accent где-то в попапе
    const bg = await pop.evaluate((el) => [el, ...el.querySelectorAll('*')].map((n) => getComputedStyle(n).backgroundImage).join(' '));
    // градиент primary→accent (допускается смешивание с фоном темы): первая точка «красная», последняя «синяя»
    const grad = bg.match(/linear-gradient\((.*?)\)\s*(none|$|url|linear|radial)/)?.[1] || bg;
    const cols = [...grad.matchAll(/rgba?\((\d+), (\d+), (\d+)|color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/g)]
      .map((m) => (m[1] !== undefined ? [m[1], m[2], m[3]].map(Number) : [m[4], m[5], m[6]].map((x) => Number(x) * 255)));
    expect(bg, 'в попапе есть градиент темы профиля').toMatch(/gradient\(/);
    expect(cols.length).toBeGreaterThanOrEqual(2);
    const [first, last] = [cols[0], cols[cols.length - 1]];
    expect(first[0], `первая точка от primary #ff0055 (красная): ${first}`).toBeGreaterThan(first[2]);
    expect(last[2], `последняя точка от accent #3355ff (синяя): ${last}`).toBeGreaterThan(last[0]);
    await pb.keyboard.press('Escape');
    await expect(pb.locator('.profile-popup').locator('visible=true')).toHaveCount(0);
  });

  test('без аватара — буква как раньше; reduced-motion — hover не включает анимацию', async ({ makePage }) => {
    const media = ensureV3Media();
    const { pa, pb, A, B } = await setup(makePage, 'Буква QA');
    await expect(pa.locator(`.member[data-user-id="${B.id}"] .avatar`)).not.toHaveClass(/has-img/);
    await expect(pa.locator(`.member[data-user-id="${B.id}"] .avatar`)).toHaveText(/^\S$/);
    const up = await upload(BASE_URL, '/api/me/avatar', A.token, media.gif, 'image/gif');
    await pb.emulateMedia({ reducedMotion: 'reduce' });
    const img = pb.locator(`.member[data-user-id="${A.id}"] img.avatar__img`);
    await expect(img).toHaveAttribute('src', new RegExp(up.json.user.avatar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await pb.locator(`.member[data-user-id="${A.id}"]`).hover();
    await pb.waitForTimeout(400);
    await expect(img).not.toHaveAttribute('src', new RegExp(up.json.user.avatarAnimated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('настройки → Профиль: about со счётчиком 190, displayName, сохранение; загрузка аватара через кадрирование', async ({ makePage }) => {
    const media = ensureV3Media();
    const { pa, pb, A } = await setup(makePage, 'Настройки профиля QA');
    const panel = await openSection(pa, 'profile');
    await panel.locator('#profile-display-name').fill('Новое имя');
    await panel.locator('#profile-about').fill('a'.repeat(200));
    expect((await panel.locator('#profile-about').inputValue()).length).toBeLessThanOrEqual(190);
    await expect(panel).toContainText(/190/);
    await panel.locator('#profile-pronouns').fill('они');
    // предпросмотр живой
    await expect(panel.locator('.profile-preview .profile-popup__name')).toHaveText(/Новое имя/);
    await panel.locator('#btn-profile-save').click();
    await expect.poll(async () => (await http('GET', '/api/me', { token: A.token })).json.user).toMatchObject({ displayName: 'Новое имя', pronouns: 'они', about: 'a'.repeat(190) });
    // аватар через input → кадрирование
    await panel.locator('#profile-avatar-input').setInputFiles(media.png);
    await expect(pa.locator('#modal-crop')).toBeVisible();
    await expect(pa.locator('#crop-canvas')).toBeVisible();
    await pa.locator('#crop-ok').click();
    await expect.poll(async () => (await http('GET', '/api/me', { token: A.token })).json.user.avatar, { timeout: 15000 }).toMatch(/^\/media\/avatars\//);
    await expect(pb.locator(`.member[data-user-id="${A.id}"] img.avatar__img`)).toBeVisible();
    await expect(pb.locator(`.member[data-user-id="${A.id}"] .member__name`)).toHaveText(/Новое имя/);
  });

  test('статус: меню у аватара → Невидимый → у другого offline; Задать статус… → виден другому', async ({ makePage }) => {
    const { pa, pb, A } = await setup(makePage, 'Статус QA');
    await expect(pb.locator(`.member[data-user-id="${A.id}"]`)).not.toHaveClass(/is-offline/);
    await pa.locator('#me-avatar').click();
    await pa.locator('.status-menu').locator('visible=true').locator('button[data-status="invisible"]').click();
    await expect(pb.locator(`.member[data-user-id="${A.id}"]`)).toHaveClass(/is-offline/);
    await expect(pb.locator(`.members__group[data-group="offline"] .member[data-user-id="${A.id}"]`)).toHaveCount(1);
    await pa.locator('#me-avatar').click();
    await pa.locator('.status-menu').locator('visible=true').locator('button[data-status="dnd"]').click();
    await expect(pb.locator(`.member[data-user-id="${A.id}"]`)).not.toHaveClass(/is-offline/);
    await pa.locator('#me-avatar').click();
    await pa.locator('.status-menu').locator('visible=true').locator('[data-action="custom-status"]').click();
    await expect(pa.locator('#modal-custom-status')).toBeVisible();
    await pa.locator('#custom-status-text').fill('на созвоне');
    await pa.locator('#custom-status-save').click();
    await expect(pb.locator(`.member[data-user-id="${A.id}"]`)).toContainText('на созвоне');
    expect((await http('GET', '/api/me', { token: A.token })).json.user).toMatchObject({ status: 'dnd', customStatus: { text: 'на созвоне' } });
  });
});

test.describe('v3 UI: пинг и стрим', () => {
  test('пинг: __sozvon.ping.last > 0, значок «мс»; в голосе — WebRTC RTT', async ({ makePage }) => {
    const { pa, pb } = await setup(makePage, 'Пинг QA');
    await expect.poll(() => pa.evaluate(() => window.__sozvon?.ping?.last), { timeout: 15000 }).toBeGreaterThan(0);
    const hist = await pa.evaluate(() => window.__sozvon.ping.history);
    expect(Array.isArray(hist)).toBe(true);
    await expect(pa.locator('#ping-user')).toBeVisible();
    await expect(pa.locator('#ping-user')).toHaveText(/\d+\s*мс/);
    await expect(pa.locator('#ping-user')).toHaveAttribute('data-level', /good|mid|bad/);
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    await expect(pa.locator('#ping-voice')).toBeVisible();
    await expect.poll(() => pa.evaluate(() => window.__sozvon.ping.voice?.rtt), { timeout: 20000, message: 'ping.voice.rtt — число' }).toEqual(expect.any(Number));
    const v = await pa.evaluate(() => window.__sozvon.ping.voice);
    expect(v.rtt).toBeGreaterThanOrEqual(0);
    expect(v).toHaveProperty('loss'); expect(v).toHaveProperty('jitter');
    await pa.locator('#ping-voice').click();
    await expect(pa.locator('.ping-popup')).toBeVisible();
    await expect(pa.locator('.ping-popup svg.ping-chart')).toBeVisible();
  });

  test('стрим 1080p60: getParameters().encodings[0].maxBitrate === 6_000_000, maxFramerate 60; 720p30 → 2.5 Мбит/с; выбор запоминается', async ({ makePage }) => {
    const pa = await makePage({ name: 'A' });
    await trackPeerConnections(pa);
    const pb = await makePage({ name: 'B' });
    await loginViaToken(pa, 'sa'); await loginViaToken(pb, 'sb');
    await createServerUI(pa, 'Стрим QA');
    await joinServerUI(pb, await inviteCode(pa), 'Стрим QA');
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    await expect(pa.locator('#stage-grid .tile[data-connected="true"]')).toHaveCount(1, { timeout: 20000 }).catch(() => {});
    const screenEnc = () => pa.evaluate(async () => {
      const out = [];
      for (const pc of window.__qaPcs || []) {
        if (pc.connectionState === 'closed') continue;
        for (const s of pc.getSenders()) {
          if (s.track?.kind !== 'video') continue;
          const settings = s.track.getSettings?.() || {};
          const e = s.getParameters().encodings?.[0] || {};
          out.push({ maxBitrate: e.maxBitrate, maxFramerate: e.maxFramerate, surface: settings.displaySurface || null, label: s.track.label });
        }
      }
      return out;
    });
    await startScreenShare(pa, '1080p60');
    await expect(pb.locator('#stage-grid .tile.tile--screen video')).toHaveCount(1, { timeout: 20000 });
    await expect.poll(async () => (await screenEnc()).some((e) => e.maxBitrate === 6_000_000 && e.maxFramerate === 60),
      { timeout: 15000, message: 'sender экрана: maxBitrate 6e6, maxFramerate 60' }).toBe(true);
    const dbg = await pa.evaluate(() => window.__sozvon.rtc.screenEncodings?.());
    if (dbg) expect(dbg.some((e) => e.maxBitrate === 6_000_000 && e.maxFramerate === 60)).toBe(true);
    const prefs = await pa.evaluate(() => JSON.parse(localStorage.getItem('sozvon.prefs') || '{}'));
    expect(prefs['stream.quality']).toBe('1080p60');
    await pa.locator('#ctrl-screen').click(); // стоп
    await expect(pb.locator('#stage-grid .tile.tile--screen')).toHaveCount(0, { timeout: 15000 });
    // повторный запуск: в модалке предвыбрано 1080p60; выбираем 720p30
    await pa.locator('#ctrl-screen').click();
    await expect(pa.locator('#modal-stream input[name=stream-quality][value="1080p60"]')).toBeChecked();
    await pa.keyboard.press('Escape');
    await startScreenShare(pa, '720p30');
    await expect.poll(async () => (await screenEnc()).some((e) => e.maxBitrate === 2_500_000 && e.maxFramerate === 30),
      { timeout: 15000, message: '720p30 → 2.5 Мбит/с, 30 fps' }).toBe(true);
    await pa.locator('#ctrl-screen').click();
    await sleep(300);
  });
});
