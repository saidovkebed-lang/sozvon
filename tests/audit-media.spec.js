// Полный аудит: трансляции и камера — пограничные случаи (отмена выбора экрана, стример уходит,
// автопросмотр, нет права STREAM, два стримера + камера). owner: qa
import { test, expect, twoUsersOneServer, joinVoiceUI, startScreenShare, watchScreen } from './fixtures/ui.js';

const tiles = (p, sel = '') => p.locator(`#stage-grid .tile${sel}`);

async function connectedPair(makePage, name) {
  const r = await twoUsersOneServer(makePage, name);
  await joinVoiceUI(r.pa); await joinVoiceUI(r.pb);
  await expect(r.pb.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });
  return r;
}

test.describe('audit: трансляции и камера', () => {
  test('отмена выбора экрана (NotAllowedError): кнопка не залипает, LIVE нет, повторный запуск работает', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb, ua } = await connectedPair(makePage, 'Отмена');
    await pa.evaluate(() => {
      const md = navigator.mediaDevices; const orig = md.getDisplayMedia.bind(md); let n = 0;
      md.getDisplayMedia = (o) => (++n === 1 ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : orig(o));
    });
    await startScreenShare(pa, '720p30');
    await pa.waitForTimeout(800);
    await expect(pa.locator('#ctrl-screen')).not.toHaveClass(/is-on/);
    await expect(pb.locator('.voice-user').filter({ hasText: ua.username }).locator('.badge--live')).toHaveCount(0);
    await expect(tiles(pb, '.tile--screen')).toHaveCount(0);
    await startScreenShare(pa, '720p30');
    await expect(pa.locator('#ctrl-screen')).toHaveClass(/is-on/);
    await expect(tiles(pb, '.tile--screen')).toHaveCount(1, { timeout: 20000 });
  });

  test('стример выходит из голоса, пока его смотрят: у зрителя плитка экрана исчезает, без «призраков»', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb } = await connectedPair(makePage, 'Уход');
    await startScreenShare(pa, '720p30');
    await watchScreen(pb);
    await expect.poll(() => pb.locator('.tile--screen video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    await pa.locator('#ctrl-leave').click();
    await expect(tiles(pb, '.tile--screen')).toHaveCount(0, { timeout: 15000 });
    await expect(tiles(pb, '[data-socket-id]')).toHaveCount(1);
    // вернулся — стрима нет, кнопка экрана выключена
    await joinVoiceUI(pa);
    await expect(pa.locator('#ctrl-screen')).not.toHaveClass(/is-on/);
    await expect(tiles(pb, '[data-socket-id]:not(.tile--screen)')).toHaveCount(2, { timeout: 15000 });
    await expect(tiles(pb, '.tile--screen')).toHaveCount(0);
  });

  test('настройка «Сразу смотреть трансляции»: видео приходит без кнопки «Смотреть»', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb } = await connectedPair(makePage, 'Автопросмотр');
    await pb.evaluate(async () => (await import('/js/prefs.js')).prefs.set('stream.autoWatch', true));
    await startScreenShare(pa, '720p30');
    const v = pb.locator('.tile--screen video');
    await expect(v).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => v.evaluate((el) => el.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
  });

  test('без права STREAM: экран и камера не включаются, понятное сообщение', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Без стрима');
    // владелец A снимает STREAM у @everyone через API-событие из своего браузера
    await pa.evaluate(async () => {
      const s = window.__sozvon.state.servers[0];
      const ev = s.roles.find((r) => r.id === s.id);
      const P = window.__sozvon.perms.PERMS;
      await new Promise((res) => window.__sozvon.socket.emit('role:update', { serverId: s.id, roleId: s.id, permissions: ev.permissions & ~P.STREAM }, res));
    });
    await joinVoiceUI(pb);
    const scr = pb.locator('#ctrl-screen');
    if (await scr.isEnabled()) {
      await scr.click();
      await expect(pb.locator('#modal-stream')).toBeHidden();
      await expect(pb.locator('#toasts .toast').last()).toContainText(/Нет права/);
    }
    const cam = pb.locator('#ctrl-camera');
    if (await cam.isEnabled()) {
      await cam.click();
      await pb.waitForTimeout(800);
      await expect(cam).not.toHaveClass(/is-on/);
    }
  });

  test('два стримера одновременно + камера: у третьего 2 экрана и видео камеры', async ({ makePage }) => {
    test.setTimeout(120_000);
    const { pa, pb } = await connectedPair(makePage, 'Двое');
    await startScreenShare(pa, '720p30');
    await startScreenShare(pb, '720p30');
    await pb.locator('#ctrl-camera').click();
    await expect(pb.locator('#ctrl-camera')).toHaveClass(/is-on/);
    await expect(tiles(pa, '.tile--screen')).toHaveCount(2, { timeout: 20000 });
    await expect(tiles(pa, '.tile--video:not(.tile--screen) video')).toHaveCount(1, { timeout: 20000 });
    // A смотрит экран B
    const other = pa.locator('#stage-grid .tile.tile--screen .tile__watch').first();
    await other.click();
    await expect.poll(() => pa.locator('.tile--screen video').first().evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    // B останавливает экран, камера остаётся
    await pb.locator('#ctrl-screen').click();
    await pb.waitForTimeout(500);
    if (await pb.locator('#modal-stream').isVisible()) await pb.keyboard.press('Escape');
    await expect(tiles(pa, '.tile--screen')).toHaveCount(1, { timeout: 15000 });
    await expect(tiles(pa, '.tile--video:not(.tile--screen) video')).toHaveCount(1);
  });
});
