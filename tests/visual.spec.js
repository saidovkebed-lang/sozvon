// Скриншоты ключевых экранов для ручной визуальной проверки (tests/screens-qa/*.png)
import { test, expect, loginViaToken, createServerUI, joinServerUI, inviteCode, openTextChannel, joinVoiceUI, sendMessageUI } from './fixtures/ui.js';
import { startBot } from './fixtures/api.js';
import { ensureMedia } from './fixtures/media.js';

const DIR = 'tests/screens-qa';
const shot = (page, name) => page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });

for (const vp of [{ w: 1440, h: 900, tag: '1440' }, { w: 375, h: 812, tag: '375' }]) {
  test.describe(`Визуал ${vp.tag}`, () => {
    let bot;
    test.beforeAll(async () => { bot = await startBot(); });
    test.afterAll(async () => { await bot?.stop(); });

    test(`ключевые экраны ${vp.tag}`, async ({ makePage }) => {
      test.setTimeout(120_000);
      const viewport = { width: vp.w, height: vp.h };
      const mobile = vp.w < 640;
      const pa = await makePage({ viewport, name: 'A' });
      const pb = await makePage({ viewport: { width: 1440, height: 900 }, name: 'B' });
      await pa.goto('/');
      await expect(pa.locator('#auth-screen')).toBeVisible();
      await pa.waitForTimeout(300);
      await shot(pa, `${vp.tag}-01-auth`);

      await loginViaToken(pa, 'vis');
      await pa.waitForTimeout(800); // дождаться входной анимации
      await shot(pa, `${vp.tag}-02-empty-app`);
      const openNav = async () => { if (mobile && !(await pa.locator('#app.is-nav-open').count())) await pa.locator('#btn-menu').click(); };
      await openNav();
      await pa.locator('#btn-add-server').click();
      await expect(pa.locator('#modal-server')).toBeVisible();
      await pa.waitForTimeout(250);
      await shot(pa, `${vp.tag}-03-modal-server`);
      await pa.keyboard.press('Escape');
      await expect(pa.locator('#modal-server')).toBeHidden();
      await openNav();
      await createServerUI(pa, 'Ламповый');
      const code = await inviteCode(pa);
      await loginViaToken(pb, 'friend');
      await joinServerUI(pb, code, 'Ламповый');

      await openNav();
      await openTextChannel(pa);
      await openTextChannel(pb);
      await sendMessageUI(pa, 'Всем привет! Кто сегодня в голосе?');
      await sendMessageUI(pa, 'Я зайду через 10 минут');
      await sendMessageUI(pb, 'Го, я уже тут 🎧');
      const { image } = ensureMedia();
      await pb.locator('#file-input').setInputFiles(image);
      await expect(pb.locator('#pending-attachments .chip')).toHaveCount(1, { timeout: 15000 });
      await pb.locator('#btn-send').click();
      await expect(pa.locator('img.message__image')).toHaveCount(1);
      await pa.waitForTimeout(500);
      await shot(pa, `${vp.tag}-04-chat`);
      if (mobile) {
        await pa.locator('#btn-menu').click();
        await pa.waitForTimeout(400);
        await shot(pa, `${vp.tag}-05-nav-open`);
      }
      await joinVoiceUI(pa);
      await joinVoiceUI(pb);
      await expect(pa.locator('#stage-grid .tile[data-connected="true"]')).not.toHaveCount(0, { timeout: 20000 });
      await pb.locator('#ctrl-screen').click();
      await expect(pa.locator('.tile--screen video')).toHaveCount(1, { timeout: 20000 });
      await pa.waitForTimeout(1200);
      await shot(pa, `${vp.tag}-06-voice-screen`);
      await openNav();
      await openTextChannel(pa);
      await sendMessageUI(pa, '!play qa sine 440');
      await expect(pa.locator('#music-player')).toBeVisible({ timeout: 15000 });
      await pa.waitForTimeout(1500);
      await shot(pa, `${vp.tag}-07-music-player`);
      // SPEC §4: громкость бота — локальный слайдер, доступен на любой ширине
      await expect.soft(pa.locator('#music-volume'), `#music-volume виден (${vp.tag})`).toBeVisible();
      // UX: плавающий плеер не должен перекрывать текст последних сообщений
      await sendMessageUI(pa, 'Длинное сообщение, чтобы проверить перекрытие плеером: ' + 'слово '.repeat(40));
      await pa.waitForTimeout(400);
      const overlap = await pa.evaluate(() => {
        const pl = document.querySelector('#music-player').getBoundingClientRect();
        const box = document.querySelector('#messages'); box.scrollTop = box.scrollHeight;
        const hits = [];
        for (const c of [...document.querySelectorAll('#messages .message__content')].slice(-3)) {
          const r = document.createRange(); r.selectNodeContents(c);
          for (const q of r.getClientRects()) {
            if (q.right > pl.left && q.left < pl.right && q.bottom > pl.top && q.top < pl.bottom) hits.push(c.textContent.slice(0, 40));
          }
        }
        return [...new Set(hits)];
      });
      expect.soft(overlap, `#music-player перекрывает текст сообщений (${vp.tag})`).toEqual([]);
      // на узких экранах #btn-music-library скрыт CSS — библиотека через кнопку в шапке
      if (await pa.locator('#btn-music-library').isVisible()) await pa.locator('#btn-music-library').click();
      else await pa.locator('#btn-open-music').click();
      await expect(pa.locator('#modal-music')).toBeVisible();
      await pa.waitForTimeout(300);
      await shot(pa, `${vp.tag}-08-modal-music`);
      await pa.keyboard.press('Escape');
      await sendMessageUI(pa, '!stop');
    });
  });
}
