// v8: громкость звука трансляции у зрителя — ползунок 0–200 % на плитке экрана, свой для каждого стримера,
// не зависит от громкости голоса этого человека, запоминается. Чтобы у трансляции был звук в headless,
// getDisplayMedia подменяется: холст + генератор тона.
import { test, expect, twoUsersOneServer, joinVoiceUI, startScreenShare, watchScreen } from './fixtures/ui.js';

async function fakeDisplayWithAudio(page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const g = c.getContext('2d');
      let n = 0;
      setInterval(() => { g.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`; g.fillRect(0, 0, 640, 360); }, 50);
      const v = c.captureStream(20);
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dst = ctx.createMediaStreamDestination();
      osc.connect(dst);
      osc.start();
      return new MediaStream([...v.getVideoTracks(), ...dst.stream.getAudioTracks()]);
    };
  });
}

const gains = (p) => p.evaluate(() => [...window.__sozvon.audio.engine.remotes.values()].map((r) => ({ kind: r.kind, target: r.target })));

test('ползунок громкости трансляции: меняет только звук экрана, запоминается, «выкл» и снова вкл', async ({ makePage }) => {
  const { pa, pb, ua } = await twoUsersOneServer(makePage, 'Громкость стрима');
  await fakeDisplayWithAudio(pa);
  await pa.reload();
  await joinVoiceUI(pa);
  await joinVoiceUI(pb);
  await expect(pa.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });
  await pa.evaluate(async () => (await import('/js/prefs.js')).prefs.set('stream.audio', true));
  await startScreenShare(pa, '720p30');
  await watchScreen(pb);

  const tile = pb.locator('.tile--screen');
  const vol = tile.locator('.tile__volume');
  await expect(vol).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await gains(pb)).some((g) => g.kind === 'screen'), { timeout: 15000 }).toBe(true);

  // по умолчанию 100 %
  const range = vol.locator('input[type=range]');
  await expect(range).toHaveValue('100');
  // голос стримера сделали тише — трансляция не меняется
  await pb.evaluate((id) => import('/js/prefs.js').then((m) => m.prefs.setUserVolume(id, 40)), ua.user.id);
  await expect.poll(async () => (await gains(pb)).find((g) => g.kind === 'screen').target).toBe(1);

  // ползунок: 50 % → звук экрана 0.5, голос по-прежнему 0.4
  await vol.hover();
  await expect(range).toBeVisible();
  await range.fill('50');
  await expect(vol.locator('.tile__volume-pct')).toHaveText('50%');
  await expect.poll(async () => (await gains(pb)).find((g) => g.kind === 'screen').target).toBeCloseTo(0.5, 5);
  const mic = (await gains(pb)).find((g) => g.kind === 'mic');
  if (mic) expect(mic.target).toBeCloseTo(0.4, 5);

  // громче 100 %
  await range.fill('150');
  await expect.poll(async () => (await gains(pb)).find((g) => g.kind === 'screen').target).toBeCloseTo(1.5, 5);

  // кнопка — выключить; сдвиг ползунка включает обратно
  await vol.locator('.tile__sound').click();
  await expect(vol.locator('.tile__sound')).toHaveAttribute('aria-pressed', 'true');
  await expect(vol.locator('.tile__volume-pct')).toHaveText('выкл');
  await expect.poll(async () => (await gains(pb)).find((g) => g.kind === 'screen').target).toBe(0);
  await range.fill('80');
  await expect(vol.locator('.tile__sound')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await gains(pb)).find((g) => g.kind === 'screen').target).toBeCloseTo(0.8, 5);

  // клик по ползунку не переключает фокус плитки
  await expect(tile).not.toHaveClass(/is-focused/);

  // запоминается для этого стримера
  expect(await pb.evaluate((id) => import('/js/prefs.js').then((m) => m.prefs.getStreamVolume(id)), ua.user.id)).toBe(80);
  // двойной клик — 100 %
  await range.dblclick();
  await expect(range).toHaveValue('100');
  expect(await pb.evaluate((id) => import('/js/prefs.js').then((m) => m.prefs.getStreamVolume(id)), ua.user.id)).toBe(100);
});
