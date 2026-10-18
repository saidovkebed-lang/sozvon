// v4: исправления по отзыву владельца — ввод названия роли, звук демонстрации экрана
// (без звука звонка, фолбэк при «Устройство занято», отключение звука трансляции у зрителя),
// шифрование (код конфиденциальности одинаков у участников, заголовки безопасности).
import { test, expect, twoUsersOneServer, joinVoiceUI, startScreenShare, watchScreen } from './fixtures/ui.js';
import { connectUser, ack, http } from './fixtures/api.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

/** Перехват getDisplayMedia: пишем аргументы; failAudio — первый вызов со звуком падает NotReadableError */
async function spyDisplayMedia(page, { failAudio = false } = {}) {
  await page.addInitScript((fail) => {
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia) return;
    const orig = md.getDisplayMedia.bind(md);
    window.__gdm = [];
    md.getDisplayMedia = async (opts) => {
      window.__gdm.push(JSON.parse(JSON.stringify(opts || {})));
      if (fail && opts?.audio) throw new DOMException('Could not start audio source', 'NotReadableError');
      return orig(opts);
    };
  }, failAudio);
}

test.describe('v4: исправления', () => {
  test('название роли печатается посимвольно, фокус не теряется', async ({ makePage }) => {
    const { pa } = await twoUsersOneServer(makePage, 'Роли ввод');
    await pa.locator('#btn-server-menu').click();
    const modal = pa.locator('#modal-settings');
    await modal.locator('button[data-ssection="roles"]').click();
    await modal.locator('#btn-role-create').click();
    const input = modal.locator('#role-name-input');
    await expect(input).toBeVisible();
    await input.click();
    await input.press('Control+A');
    await input.press('Backspace');
    await input.pressSequentially('Старшие модераторы', { delay: 40 });
    await expect(input).toHaveValue('Старшие модераторы');
    await expect(input).toBeFocused();
    // пауза дольше задержки сохранения (500 мс) и дописывание — фокус всё ещё на месте
    await pa.waitForTimeout(900);
    await input.pressSequentially(' 2', { delay: 40 });
    await expect(input).toHaveValue('Старшие модераторы 2');
    await expect(modal.locator('.role-row', { hasText: 'Старшие модераторы 2' })).toBeVisible();
  });

  test('демонстрация со звуком: звук «Созвона» исключён (restrictOwnAudio); при «Устройство занято» — повтор без звука', async ({ makePage }) => {
    const { pa } = await twoUsersOneServer(makePage, 'Звук стрима');
    await spyDisplayMedia(pa, { failAudio: true });
    await pa.reload();
    await joinVoiceUI(pa);
    await pa.evaluate(async () => (await import('/js/prefs.js')).prefs.set('stream.audio', true));
    await startScreenShare(pa, '720p30');
    await expect.poll(() => pa.evaluate(() => window.__gdm.length)).toBe(2);
    const calls = await pa.evaluate(() => window.__gdm);
    expect(calls[0].audio, 'первый запрос — со звуком').toBeTruthy();
    expect(calls[0].audio.restrictOwnAudio, 'звук звонка не попадает в трансляцию').toBe(true);
    expect(calls[1].audio, 'повтор — без звука').toBe(false);
    await expect(pa.locator('.toast', { hasText: 'без звука' })).toBeVisible();
    await expect(pa.locator('.tile--screen')).toBeVisible();
  });

  test('зритель может выключить звук трансляции у себя; код конфиденциальности совпадает у обоих', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Шифр');
    await joinVoiceUI(pa);
    await joinVoiceUI(pb);
    await expect(pa.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });
    await expect(pb.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });

    const codeOf = (p) => p.evaluate(async () => (await window.__sozvon.rtc.privacyCode())?.code || null);
    await expect.poll(() => codeOf(pa), { timeout: 15000 }).toMatch(/^\d{5}( \d{5}){5}$/);
    const ca = await codeOf(pa);
    const cb = await codeOf(pb);
    expect(cb).toBe(ca);

    // код виден в попапе «Подключение»
    await pa.locator('.voice-panel .ping-badge').click();
    await expect(pa.locator('#privacy-code')).toHaveText(ca);
    await pa.keyboard.press('Escape');

    // трансляция со звуком у A → у B кнопка звука трансляции; выключение даёт gain 0 только для экрана
    await pa.evaluate(async () => (await import('/js/prefs.js')).prefs.set('stream.audio', true));
    await startScreenShare(pa, '720p30');
    const screenTile = pb.locator('.tile--screen');
    await expect(screenTile).toBeVisible({ timeout: 20000 });
    await watchScreen(pb);
    const btn = screenTile.locator('.tile__sound');
    if (await btn.count() === 0) test.info().annotations.push({ type: 'note', description: 'в headless у экрана нет звуковой дорожки — кнопка не показывается' });
    else {
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      const gains = await pb.evaluate(() => [...window.__sozvon.audio.engine.remotes.values()].map((r) => [r.kind, r.target]));
      expect(gains.filter(([k]) => k === 'screen').every(([, g]) => g === 0)).toBe(true);
      expect(gains.filter(([k]) => k === 'mic').every(([, g]) => g > 0)).toBe(true);
    }
  });

  test('трансляция по запросу: без «Смотреть» видео не отправляется; «Выйти из трансляции»; «Остановить демонстрацию»', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'По запросу');
    await joinVoiceUI(pa);
    await joinVoiceUI(pb);
    await expect(pa.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });
    await startScreenShare(pa, '720p30');
    // треки, которые A реально отправляет B для экрана (null = ничего не кодируется)
    const sending = () => pa.evaluate(() => {
      const p = [...window.__sozvon.rtc.peers.values()][0];
      return p.senders.screen.filter((s) => s.track && s.track.kind === 'video').length;
    });
    await expect(pb.locator('.tile--screen .tile__watch')).toBeVisible({ timeout: 20000 });
    await expect(pb.locator('.tile--screen video')).toHaveCount(0);
    expect(await sending()).toBe(0);
    // своя плашка у стримера — без превью, с кнопкой остановки
    await expect(pa.locator('.tile--screen .tile__cover')).toBeVisible();
    await expect(pa.locator('.tile--screen video')).toHaveCount(0);

    await watchScreen(pb);
    await expect.poll(sending, { timeout: 10000 }).toBe(1);
    await expect.poll(() => pb.locator('.tile--screen video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);

    await pb.locator('.tile--screen').hover();
    await pb.locator('.tile--screen .tile__unwatch').click();
    await expect(pb.locator('.tile--screen .tile__watch')).toBeVisible();
    await expect(pb.locator('.tile--screen video')).toHaveCount(0);
    await expect.poll(sending, { timeout: 10000 }).toBe(0);

    await pa.locator('.tile--screen .tile__stopshare').click();
    await expect(pa.locator('#ctrl-screen')).not.toHaveClass(/is-on/);
    await expect(pb.locator('.tile--screen')).toHaveCount(0, { timeout: 20000 });
  });

  test('заголовки безопасности', async () => {
    const res = await http('GET', '/');
    const h = res.headers;
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(h.get('referrer-policy')).toBe('same-origin');
    expect(h.get('permissions-policy')).toContain('microphone=(self)');
    expect(h.get('strict-transport-security')).toContain('max-age=');
  });
});
