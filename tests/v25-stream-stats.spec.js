// v25: качество трансляции. Стример видит значок на своей плитке (зелёный/жёлтый/красный) и по клику — панель:
// реальные кадры/с, разрешение, битрейт, кодек, причина ограничения, зрители, пинг/потери, совет.
// Источник — RTCRtpSender.getStats() (SFU: один сендер, mesh: по сендеру на зрителя, сводка — по худшему).
// Зритель по наведению на плитку видит получаемые к/с и разрешение. Опрос getStats — только пока трансляция
// идёт и индикатор на экране; после остановки — прекращается.
import {
  test, expect, loginViaToken, createServerUI, inviteCode, joinServerUI, joinVoiceUI, startScreenShare, watchScreen,
} from './fixtures/ui.js';
import { sleep } from './fixtures/api.js';

const SHOTS = 'tests/.results/v25';
const stats = (p) => p.evaluate(() => {
  const s = window.__sozvon.streamStats;
  return { active: s.active, polls: s.polls, level: s.level, last: s.last && { ...s.last, list: undefined }, viewer: { ...s.viewer } };
});
const sfuInfo = (p) => p.evaluate(() => window.__sozvon.rtc.sfu.debug());

/** Стример A и зрители в одном голосовом канале; sfuOff — у стримера SFU выключен (трансляция по mesh) */
async function inVoice(makePage, name, { viewers = 1, sfuOff = false } = {}) {
  const pages = [];
  for (const n of ['A', 'B', 'C'].slice(0, viewers + 1)) {
    const p = await makePage({ name: n });
    await loginViaToken(p, 'v25');
    pages.push(p);
  }
  const [pa, ...rest] = pages;
  if (sfuOff) await pa.evaluate(() => localStorage.setItem('sozvon.sfu', 'off'));
  await createServerUI(pa, name);
  const code = await inviteCode(pa);
  for (const p of rest) await joinServerUI(p, code, name);
  for (const p of pages) await joinVoiceUI(p);
  for (const p of pages) await expect(p.locator('.tile[data-connected="true"]')).toHaveCount(viewers, { timeout: 20000 });
  return pages;
}

/** Стример: значок и панель с ненулевыми кадрами и разрешением */
async function expectStreamerPanel(pa, { via, viewers }) {
  const badge = pa.locator('#stage-grid .tile--screen[data-self="true"] .tile__q');
  await expect(badge).toBeVisible();
  await expect.poll(async () => (await stats(pa)).last?.fps ?? 0, { timeout: 20000, message: 'реально отправляемые к/с' }).toBeGreaterThan(0);
  const s = (await stats(pa)).last;
  expect(s.via).toBe(via);
  expect(s.viewers).toBe(viewers);
  expect(s.width).toBeGreaterThan(0);
  expect(s.height).toBeGreaterThan(0);
  expect(['cpu', 'bandwidth', 'none', 'other']).toContain(s.limitation);
  expect(s.codec).toMatch(/H264|VP8|VP9|AV1/i);
  await expect(badge).toHaveAttribute('data-level', /good|mid|bad/);
  await expect(badge.locator('.tile__q-text')).toHaveText(/^\d+ к\/с$/);
  await expect(pa.locator('#ctrl-screen-q')).toBeVisible();
  await expect(pa.locator('#ctrl-screen-q')).toHaveAttribute('data-level', /good|mid|bad/);

  await badge.click();
  const pop = pa.locator('.stream-popup');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.ping-popup__row', { hasText: 'Кадры/с' }).locator('strong')).toHaveText(/^[1-9]\d* из 30$/, { timeout: 10000 });
  await expect(pop.locator('.ping-popup__row', { hasText: 'Разрешение' }).locator('strong')).toHaveText(/^\d+×\d+/);
  await expect(pop.locator('.ping-popup__row', { hasText: 'Кодек' }).locator('strong')).toHaveText(/H264|VP8|VP9|AV1/);
  await expect(pop.locator('.ping-popup__row', { hasText: 'Ограничение' }).locator('strong')).toHaveText(/нет|не хватает процессора|не хватает интернета на отдачу|ограничено браузером/);
  await expect(pop.locator('.ping-popup__row', { hasText: 'Зрители' }).locator('strong')).toHaveText(String(viewers));
  await expect(pop.locator('.ping-popup__row', { hasText: 'Битрейт' }).locator('strong')).toHaveText(/\d+ (кбит|Мбит)\/с/, { timeout: 10000 });
  // панель открыта — опрос чаще (раз в секунду)
  const p0 = (await stats(pa)).polls;
  await sleep(2600);
  expect((await stats(pa)).polls - p0).toBeGreaterThanOrEqual(2);
  return pop;
}

/** Зритель: по наведению — получаемые к/с и разрешение; курсор ушёл — опрос остановлен */
async function expectViewerStats(pb) {
  const tile = pb.locator('#stage-grid .tile--screen').first();
  await expect.poll(() => tile.locator('video').evaluate((v) => v.videoWidth).catch(() => 0), { timeout: 20000 }).toBeGreaterThan(0);
  await expect(tile.locator('.tile__rx')).toBeAttached();
  // после «Смотреть» курсор над плиткой — подпись уже опрашивается; уводим курсор
  await pb.mouse.move(2, 2);
  await expect.poll(async () => (await stats(pb)).viewer.active, { message: 'без наведения опроса нет' }).toBe(0);
  const idle = (await stats(pb)).viewer.polls;
  await sleep(2200);
  expect((await stats(pb)).viewer.polls).toBe(idle);
  await tile.hover({ position: { x: 40, y: 80 } });
  await expect(tile.locator('.tile__rx')).toBeVisible();
  await expect(tile.locator('.tile__rx')).toHaveText(/^[1-9]\d* к\/с · \d+×\d+$/, { timeout: 15000 });
  expect((await stats(pb)).viewer.active).toBe(1);
  await pb.mouse.move(2, 2);
  await expect.poll(async () => (await stats(pb)).viewer.active).toBe(0);
  const n = (await stats(pb)).viewer.polls;
  await sleep(2500);
  expect((await stats(pb)).viewer.polls, 'курсор ушёл — опрос зрителя остановлен').toBe(n);
}

/** Стример остановил трансляцию → опрос прекращён, значка нет */
async function expectStopped(pa, viewers) {
  await pa.locator('#ctrl-screen').click();
  for (const p of viewers) await expect(p.locator('.tile--screen')).toHaveCount(0, { timeout: 15000 });
  await expect(pa.locator('.tile__q')).toHaveCount(0);
  await expect(pa.locator('.stream-popup')).toHaveCount(0);
  await expect(pa.locator('#ctrl-screen-q')).toBeHidden();
  await expect.poll(async () => (await stats(pa)).active).toBe(false);
  const n = (await stats(pa)).polls;
  await sleep(4500);
  expect((await stats(pa)).polls, 'после конца трансляции getStats не опрашивается').toBe(n);
}

test.describe('v25: качество трансляции', () => {
  test.setTimeout(150_000);

  test('SFU: стример видит к/с, разрешение, кодек; зритель — по наведению; опрос останавливается', async ({ makePage }) => {
    const [pa, pb] = await inVoice(makePage, 'Качество SFU');
    await expect.poll(async () => (await sfuInfo(pa)).device, { message: 'SFU доступен клиенту' }).toBe(true);
    expect((await stats(pa)).active, 'без трансляции опроса нет').toBe(false);

    await startScreenShare(pa, '720p30');
    await expect.poll(async () => (await sfuInfo(pa)).producing, { timeout: 15000 }).toBe(true);
    // никто не смотрит — пауза (серый значок), цифр нет
    const badge = pa.locator('#stage-grid .tile--screen[data-self="true"] .tile__q');
    await expect(badge).toHaveAttribute('data-level', 'idle', { timeout: 10000 });
    await expect(badge.locator('.tile__q-text')).toHaveText('пауза');
    expect((await stats(pa)).active).toBe(true);

    await watchScreen(pb);
    const pop = await expectStreamerPanel(pa, { via: 'sfu', viewers: 1 });
    await pa.screenshot({ path: `${SHOTS}/sfu-streamer-panel.png` });
    // Esc закрывает панель
    await pa.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);

    await expectViewerStats(pb);
    await expectStopped(pa, [pb]);
  });

  test('mesh (SFU выключен у стримера): сводка по двум зрителям, совет и смена качества', async ({ makePage }) => {
    const [pa, pb, pc] = await inVoice(makePage, 'Качество mesh', { viewers: 2, sfuOff: true });
    expect((await sfuInfo(pa)).device).toBe(false);
    await startScreenShare(pa, '720p30');
    await watchScreen(pb);
    await watchScreen(pc);
    await expect.poll(async () => (await stats(pa)).last?.senders ?? 0, { timeout: 20000, message: 'копия каждому зрителю' }).toBe(2);
    expect(await pa.evaluate(() => window.__sozvon.rtc.sfuScreen)).toBe(false);
    const pop = await expectStreamerPanel(pa, { via: 'mesh', viewers: 2 });
    await expect(pop.locator('.ping-popup__row', { hasText: 'Маршрут' }).locator('strong')).toHaveText('напрямую каждому зрителю');
    // сводка — по худшему зрителю (меньше всего к/с), битрейт — суммарный
    const one = await pa.evaluate(async () => {
      const s = await window.__sozvon.streamStats.sample();
      return { fps: s.fps, kbps: s.kbps, list: s.list.map((x) => ({ fps: x.fps, kbps: x.kbps })) };
    });
    expect(one.list.length).toBe(2);
    if (one.list.every((x) => x.fps != null)) expect(one.fps).toBe(Math.min(...one.list.map((x) => x.fps)));
    if (one.list.every((x) => x.kbps != null)) expect(one.kbps).toBe(one.list[0].kbps + one.list[1].kbps);
    await pa.screenshot({ path: `${SHOTS}/mesh-streamer-panel.png` });
    // «Сменить качество» открывает окно качества идущей демонстрации
    await pop.locator('.stream-popup__quality').click();
    await expect(pa.locator('#modal-stream')).toBeVisible();
    await expect(pa.locator('#modal-stream-title')).toHaveText('Качество демонстрации');
    await pa.keyboard.press('Escape');
    await expect(pa.locator('#modal-stream')).toBeHidden();

    await expectViewerStats(pc);
    // зритель вышел — у стримера один сендер и 1 зритель
    await pb.locator('#stage-grid .tile--screen .tile__unwatch').click();
    await expect.poll(async () => (await stats(pa)).last?.viewers, { timeout: 15000 }).toBe(1);
    await expectStopped(pa, [pb, pc]);
  });

  test('уровни и советы: интернет / процессор / статичная картинка', async ({ makePage }) => {
    const pa = await makePage({ name: 'A' });
    await loginViaToken(pa, 'v25');
    const r = await pa.evaluate(() => {
      const { levelOf, adviceOf } = window.__sozvon.streamStats;
      const st = window.__sozvon.state;
      const base = { senders: 1, viewers: 1, via: 'sfu', width: 1280, height: 720, rtt: 40, loss: 0, sourceFps: 30, hw: true };
      const out = {};
      st.streamQuality = '1080p60';
      out.good = levelOf({ ...base, fps: 58, limitation: 'none' });
      out.bw = [levelOf({ ...base, fps: 6, limitation: 'bandwidth' }), adviceOf({ ...base, fps: 6, limitation: 'bandwidth' })];
      out.cpu = [levelOf({ ...base, fps: 40, limitation: 'cpu' }), adviceOf({ ...base, fps: 40, limitation: 'cpu' })];
      // захват сам даёт мало кадров (картинка не меняется) — это не проблема
      out.still = [levelOf({ ...base, fps: 2, sourceFps: 2, limitation: 'none' }), adviceOf({ ...base, fps: 2, sourceFps: 2, limitation: 'none' })];
      out.idle = levelOf({ senders: 0, viewers: 0, fps: null });
      st.streamQuality = '720p30';
      out.bw720 = adviceOf({ ...base, fps: 6, limitation: 'bandwidth' });
      st.streamQuality = null;
      return out;
    });
    expect(r.good).toBe('good');
    expect(r.bw[0]).toBe('bad');
    expect(r.bw[1]).toBe('Не хватает интернета на отдачу — выберите 720p 30.');
    expect(r.cpu[0]).toBe('mid');
    expect(r.cpu[1]).toMatch(/^Процессор не успевает — выберите качество ниже или закройте лишнее/);
    expect(r.still[0]).toBe('good');
    expect(r.still[1]).toMatch(/почти не меняется/);
    expect(r.idle).toBe('idle');
    expect(r.bw720).toMatch(/^Не хватает интернета на отдачу — закройте загрузки/);
  });
});
