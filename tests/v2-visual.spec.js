// v2: скриншоты модалки настроек во всех темах (tests/screens-qa/v2/) + контекстное меню громкости
import fs from 'node:fs';
import { test, expect, loginViaToken, createServerUI, joinServerUI, inviteCode, joinVoiceUI, noHorizontalScroll } from './fixtures/ui.js';
import { SECTIONS, openSection, setPrefUI, closeSettings } from './fixtures/v2.js';

const DIR = 'tests/screens-qa/v2';
fs.mkdirSync(DIR, { recursive: true });

for (const vp of [{ w: 1440, h: 900, tag: '1440' }, { w: 375, h: 812, tag: '375' }]) {
  test(`скриншоты настроек ${vp.tag}: все разделы × темы dark/light/amoled`, async ({ makePage }) => {
    test.setTimeout(150_000);
    const page = await makePage({ viewport: { width: vp.w, height: vp.h } });
    await loginViaToken(page, 'shot');
    for (const theme of ['dark', 'light', 'amoled']) {
      await openSection(page, 'appearance');
      await setPrefUI(page, 'appearance.theme', theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const id of SECTIONS) {
        await openSection(page, id);
        await page.waitForTimeout(250);
        const sc = await noHorizontalScroll(page);
        expect(sc.ok, `${vp.tag} ${theme} ${id}: нет горизонтального скролла ${JSON.stringify(sc)}`).toBe(true);
        await page.screenshot({ path: `${DIR}/${vp.tag}-${theme}-settings-${id}.png` });
      }
      if (vp.w < 640) {
        const back = page.locator('#modal-user-settings .settings__back');
        if (await back.isVisible()) { await back.click(); await page.waitForTimeout(250); await page.screenshot({ path: `${DIR}/${vp.tag}-${theme}-settings-nav.png` }); }
      }
      await closeSettings(page);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/${vp.tag}-${theme}-app.png` });
    }
    await openSection(page, 'appearance');
    await setPrefUI(page, 'appearance.theme', 'dark');
    await closeSettings(page);
  });
}

test('скриншот контекстного меню громкости собеседника 1440/375', async ({ makePage }) => {
  test.setTimeout(120_000);
  const pa = await makePage({ name: 'A' });
  const pb = await makePage({ name: 'B', viewport: { width: 375, height: 812 } });
  const ua = await loginViaToken(pa, 'cmA');
  await loginViaToken(pb, 'cmB');
  await createServerUI(pa, 'Меню');
  const code = await inviteCode(pa);
  if (await pb.locator('#btn-menu').isVisible()) await pb.locator('#btn-menu').click();
  await joinServerUI(pb, code, 'Меню');
  await joinVoiceUI(pa);
  if (await pb.locator('#btn-menu').isVisible() && !(await pb.locator('#app.is-nav-open').count())) await pb.locator('#btn-menu').click();
  await joinVoiceUI(pb);
  const row = pa.locator('.voice-users .voice-user').filter({ hasNotText: ua.user.username }).first();
  await row.click({ button: 'right' });
  await expect(pa.locator('.context-menu').locator('visible=true')).toHaveCount(1);
  await pa.locator('.context-menu input[type=range][data-action="user-volume"]').fill('150');
  await pa.waitForTimeout(200);
  await pa.screenshot({ path: `${DIR}/1440-context-menu.png` });
  await pa.keyboard.press('Escape');
  // мобильный: «⋯»/долгий тап; здесь — правый клик по тайлу A у B
  const tile = pb.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: ua.user.username }).first();
  await tile.click({ button: 'right' });
  await expect(pb.locator('.context-menu').locator('visible=true')).toHaveCount(1);
  await pb.waitForTimeout(200);
  const sc = await noHorizontalScroll(pb);
  expect(sc.ok, 'меню на 375 без горизонтального скролла').toBe(true);
  const box = await pb.locator('.context-menu').locator('visible=true').boundingBox();
  expect(box.x >= 0 && box.x + box.width <= 375, `меню в пределах экрана ${JSON.stringify(box)}`).toBe(true);
  await pb.screenshot({ path: `${DIR}/375-context-menu.png` });
});
