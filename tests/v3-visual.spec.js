// v3: скриншоты новых экранов (tests/screens-qa/v3/) — 1440/375 × темы dark/light/amoled. owner: qa
import fs from 'node:fs';
import { test, expect, twoUsersOneServer, openTextChannel, sendMessageUI, messageWith, noHorizontalScroll } from './fixtures/ui.js';
import { connectUser, ack, http } from './fixtures/api.js';
import { BASE_URL } from './fixtures/env.js';
import { P, ok, ensureV3Media, upload } from './fixtures/v3.js';
import { openSection, closeSettings } from './fixtures/v2.js';

const DIR = 'tests/screens-qa/v3';
fs.mkdirSync(DIR, { recursive: true });

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    const p = JSON.parse(localStorage.getItem('sozvon.prefs') || '{}'); p['appearance.theme'] = t;
    localStorage.setItem('sozvon.prefs', JSON.stringify(p));
  }, theme);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function openNavIfMobile(page) {
  if (await page.locator('#btn-menu').isVisible() && !(await page.locator('#app.is-nav-open').count())) {
    await page.locator('#btn-menu').click(); await page.waitForTimeout(350);
  }
}
async function closeNav(page) {
  // клик вне #sidebar/#servers закрывает выезжающее меню (main.js)
  for (let k = 0; k < 2 && await page.locator('#app.is-nav-open').count(); k++) {
    await page.keyboard.press('Escape');
    if (await page.locator('#app.is-nav-open').count()) { const vp = page.viewportSize(); await page.mouse.click(vp.width - 6, Math.round(vp.height / 2)); }
    await page.waitForTimeout(350);
  }
}

for (const vp of [{ w: 1440, h: 900, tag: '1440' }, { w: 375, h: 812, tag: '375' }]) {
  test(`скриншоты v3 ${vp.tag}: участники с ролями, попап профиля, роли, профиль, стрим, пинг × 3 темы`, async ({ makePage }) => {
    test.setTimeout(300_000);
    const media = ensureV3Media();
    const { pa, pb, ua, ub } = await twoUsersOneServer(makePage, 'Витрина v3');
    await pb.setViewportSize({ width: vp.w, height: vp.h });
    const sa = await connectUser(ua.token);
    try {
      const srv = (await ack(sa, 'bootstrap')).servers.find((s) => s.name === 'Витрина v3');
      const admins = (await ok(sa, 'role:create', { serverId: srv.id, name: 'Админы', color: '#e91e63', permissions: P.KICK_MEMBERS })).role;
      await ok(sa, 'role:update', { serverId: srv.id, roleId: admins.id, hoist: true });
      const dj = (await ok(sa, 'role:create', { serverId: srv.id, name: 'Диджеи', color: '#1abc9c' })).role;
      await ok(sa, 'member:roles', { serverId: srv.id, userId: ua.user.id, roleIds: [admins.id, dj.id] });
      await upload(BASE_URL, '/api/me/avatar', ua.token, media.gif, 'image/gif');
      await upload(BASE_URL, '/api/me/banner', ua.token, media.banner, 'image/png');
      await http('PATCH', '/api/me', { token: ua.token, body: { displayName: 'Аня', about: 'Привет! Люблю **музыку** и созвоны по вечерам.', pronouns: 'она/её',
        customStatus: { emoji: '🎧', text: 'слушаю lo-fi', expiresAt: null }, profileTheme: { primary: '#5865f2', accent: '#eb459e' } } });
      await openTextChannel(pa);
      await sendMessageUI(pa, 'Всем привет, это витрина v3');
      for (const theme of ['dark', 'light', 'amoled']) {
        const name = (s) => `${DIR}/${vp.tag}-${theme}-${s}.png`;
        await setTheme(pb, theme);
        await openNavIfMobile(pb);
        await openTextChannel(pb);
        await closeNav(pb);
        await expect(messageWith(pb, 'витрина v3')).toBeVisible();
        expect((await noHorizontalScroll(pb)).ok, `${vp.tag} ${theme}: нет горизонтального скролла`).toBe(true);
        await pb.screenshot({ path: name('app') });
        // попап профиля
        await messageWith(pb, 'витрина v3').locator('.message__author').click();
        await expect(pb.locator('.profile-popup').locator('visible=true').first()).toBeVisible();
        await pb.waitForTimeout(300);
        expect((await noHorizontalScroll(pb)).ok, `${vp.tag} ${theme} попап: нет горизонтального скролла`).toBe(true);
        await pb.screenshot({ path: name('profile-popup') });
        await pb.keyboard.press('Escape');
        // участники (на мобиле — открыть панель участников, если есть кнопка)
        if (vp.w >= 900) await pb.screenshot({ path: name('members'), clip: { x: vp.w - 300, y: 0, width: 300, height: vp.h } });
        // настройки → профиль
        await openSection(pb, 'profile');
        await pb.waitForTimeout(300);
        expect((await noHorizontalScroll(pb)).ok, `${vp.tag} ${theme} профиль: нет горизонтального скролла`).toBe(true);
        await pb.screenshot({ path: name('settings-profile') });
        await closeSettings(pb);
        // меню статуса
        await openNavIfMobile(pb);
        await pb.locator('#me-avatar').click();
        await expect(pb.locator('.status-menu')).toBeVisible();
        await pb.screenshot({ path: name('status-menu') });
        await pb.keyboard.press('Escape');
        // пинг-попап
        const ping = pb.locator('#ping-user');
        if (await ping.isVisible()) { await ping.click(); await pb.waitForTimeout(300); await pb.screenshot({ path: name('ping-popup') }); await pb.keyboard.press('Escape'); }
        await closeNav(pb);
        // настройки сервера владельца (pa, тот же вьюпорт для 375 — через pb нельзя: нет прав) — снимем на pa
        await pa.setViewportSize({ width: vp.w, height: vp.h });
        await setTheme(pa, theme);
        await openNavIfMobile(pa);
        await pa.locator('#btn-server-menu').click();
        const modal = pa.locator('#modal-settings');
        await expect(modal).toBeVisible();
        const rolesTab = modal.locator('button[data-ssection="roles"]');
        await rolesTab.click();
        await modal.locator(`.role-row[data-role-id="${admins.id}"]`).click();
        await pa.waitForTimeout(300);
        expect((await noHorizontalScroll(pa)).ok, `${vp.tag} ${theme} роли: нет горизонтального скролла`).toBe(true);
        await pa.screenshot({ path: name('server-roles') });
        await pa.keyboard.press('Escape');
        await closeNav(pa);
        // контекстное меню участника у владельца
        await openNavIfMobile(pa);
        const mem = pa.locator(`.member[data-user-id="${ub.user.id}"]`);
        if (await mem.isVisible()) {
          await mem.click({ button: 'right' });
          await expect(pa.locator('.context-menu')).toBeVisible();
          await pa.screenshot({ path: name('member-menu') });
          await pa.keyboard.press('Escape');
        }
        await closeNav(pa);
      }
      // модалка стрима (в голосе)
      const { joinVoiceUI } = await import('./fixtures/ui.js');
      await openNavIfMobile(pb);
      await joinVoiceUI(pb);
      await closeNav(pb);
      await pb.locator('#ctrl-screen').click({ timeout: 10000 });
      await expect(pb.locator('#modal-stream')).toBeVisible();
      await pb.screenshot({ path: `${DIR}/${vp.tag}-amoled-stream-modal.png` });
      await pb.keyboard.press('Escape');
      await setTheme(pa, 'dark'); await setTheme(pb, 'dark');
    } finally { sa.close(); }
  });
}
