// v2 §2–3: громкость собеседника (0–200 %, GainNode), шумоподавление на лету, push-to-talk
import {
  test, expect, loginViaToken, createServerUI, joinServerUI, inviteCode, joinVoiceUI, openTextChannel,
} from './fixtures/ui.js';
import {
  readPrefs, openSection, setPrefUI, closeSettings, trackPeerConnections, inboundAudio, livePcStates,
} from './fixtures/v2.js';

async function pairInVoice(makePage, serverName, { track = false } = {}) {
  const pa = await makePage({ name: 'A' });
  const pb = await makePage({ name: 'B' });
  const vendor = [];
  if (track) {
    for (const p of [pa, pb]) await trackPeerConnections(p);
    pa.on('response', (r) => { if (r.url().includes('/vendor/')) vendor.push({ url: r.url(), status: r.status() }); });
  }
  const ua = await loginViaToken(pa, 'va');
  const ub = await loginViaToken(pb, 'vb');
  await createServerUI(pa, serverName);
  const code = await inviteCode(pa);
  await joinServerUI(pb, code, serverName);
  await joinVoiceUI(pa);
  await joinVoiceUI(pb);
  const tileB = pa.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: ub.user.username }).first();
  const tileA = pb.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: ua.user.username }).first();
  await expect(tileB).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
  await expect(tileA).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
  return { pa, pb, ua, ub, tileA, tileB, vendor };
}

const gain = (page, userId) => page.evaluate((id) => window.__sozvon?.audio?.getUserGain?.(id), userId);

async function openUserMenu(page, userId) {
  const row = page.locator(`.voice-users .voice-user[data-user-id="${userId}"]`);
  await expect(row).toHaveCount(1);
  await row.click({ button: 'right' });
  const menu = page.locator('.context-menu').locator('visible=true');
  await expect(menu).toHaveCount(1);
  return menu;
}

test.describe('v2: громкость собеседника', () => {
  test('контекстное меню: 0/50/200 % → getUserGain ≈ 0/0.5/2; сохраняется после reload; «Заглушить» → 0; для себя без громкости', async ({ makePage }) => {
    test.setTimeout(150_000);
    const { pa, ua, ub } = await pairInVoice(makePage, 'Громкость');
    const B = ub.user.id;
    await expect.poll(() => gain(pa, B), { message: 'window.__sozvon.audio.getUserGain(B) по умолчанию' }).toBeCloseTo(1, 2);

    let menu = await openUserMenu(pa, B);
    const slider = menu.locator('input[type="range"][data-action="user-volume"]');
    await expect(slider).toBeVisible();
    expect(await slider.getAttribute('min')).toBe('0');
    expect(await slider.getAttribute('max')).toBe('200');
    await expect(slider).toHaveValue('100');
    for (const [v, g] of [[0, 0], [50, 0.5], [200, 2]]) {
      await slider.fill(String(v));
      await expect.poll(() => gain(pa, B), { message: `gain при ${v}%` }).toBeCloseTo(g, 2);
      if (v === 0) {
        // при 0 % в динамики ничего не идёт
        for (let i = 0; i < 10; i++) { expect(await pa.evaluate((id) => window.__sozvon.audio.getUserLevel(id), B), 'уровень при 0%').toBe(0); await pa.waitForTimeout(100); }
      }
    }
    await expect.poll(() => pa.evaluate((id) => window.__sozvon.audio.getUserLevel(id), B), { message: 'уровень при 200% > 0', timeout: 10000, intervals: [100] }).toBeGreaterThan(0.01);
    expect((await readPrefs(pa))['audio.userVolumes']?.[B]).toBe(200);
    // двойной клик — сброс в 100
    await slider.dblclick();
    await expect.poll(() => gain(pa, B), { message: 'двойной клик → 100%' }).toBeCloseTo(1, 2);
    await slider.fill('200');
    await expect.poll(() => gain(pa, B)).toBeCloseTo(2, 2);
    await pa.keyboard.press('Escape');
    await expect(pa.locator('.context-menu').locator('visible=true')).toHaveCount(0);

    // Громкость пользователя сохраняется после перезагрузки
    await pa.reload();
    await expect(pa.locator('#app')).toBeVisible();
    await joinVoiceUI(pa);
    await expect(pa.locator('#stage-grid .tile[data-connected="true"]')).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => gain(pa, B), { message: 'gain после reload' }).toBeCloseTo(2, 2);
    menu = await openUserMenu(pa, B);
    await expect(menu.locator('input[type="range"][data-action="user-volume"]')).toHaveValue('200');

    // «Заглушить локально» → 0; снять → снова 2
    const mute = menu.locator('input[type="checkbox"][data-action="mute-user"]');
    await expect(mute).toHaveCount(1);
    await mute.setChecked(true, { force: !(await mute.isVisible()) });
    await expect.poll(() => gain(pa, B), { message: 'заглушён → 0' }).toBe(0);
    expect((await readPrefs(pa))['audio.userMuted']?.[B]).toBe(true);
    await mute.setChecked(false, { force: !(await mute.isVisible()) });
    await expect.poll(() => gain(pa, B)).toBeCloseTo(2, 2);
    await pa.keyboard.press('Escape');

    // Контекстное меню на тайле тоже есть
    const tile = pa.locator(`#stage-grid .tile[data-socket-id]`).filter({ hasText: ub.user.username }).first();
    await tile.click({ button: 'right' });
    await expect(pa.locator('.context-menu').locator('visible=true').locator('input[type="range"][data-action="user-volume"]')).toHaveValue('200');
    await pa.keyboard.press('Escape');

    // Для себя — без громкости и «заглушить»
    const selfRow = pa.locator(`.voice-users .voice-user[data-user-id="${ua.user.id}"]`);
    await selfRow.click({ button: 'right' });
    const selfMenu = pa.locator('.context-menu').locator('visible=true');
    await expect(selfMenu.locator('[data-action="user-volume"], [data-action="mute-user"]')).toHaveCount(0);
    await pa.keyboard.press('Escape');

    // Общая громкость вывода: итог = userVolume × outputVolume
    await openSection(pa, 'voice');
    await setPrefUI(pa, 'audio.outputVolume', 50);
    await expect.poll(() => gain(pa, B), { message: '200% × 50% = 1' }).toBeCloseTo(1, 2);
    await setPrefUI(pa, 'audio.outputVolume', 100);
    await closeSettings(pa);
  });
});

test.describe('v2: шумоподавление на лету', () => {
  test('rnnoise → standard → off → rnnoise: соединение живо, звук идёт, RNNoise из /vendor/ подгружен', async ({ makePage }) => {
    test.setTimeout(150_000);
    const { pa, pb, ua, vendor } = await pairInVoice(makePage, 'Шумодав', { track: true });
    expect((await readPrefs(pa))['audio.noiseSuppression'] ?? 'rnnoise').toBe('rnnoise');
    const supported = await pa.evaluate(() => typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined');
    expect(supported, 'в Chromium есть AudioWorklet и WASM').toBe(true);
    await expect.poll(() => vendor.filter((v) => v.status === 200).length,
      { message: 'запрос RNNoise worklet/wasm к /vendor/ со статусом 200', timeout: 15000 }).toBeGreaterThan(0);
    expect(vendor.filter((v) => v.status >= 400), 'нет ошибок загрузки /vendor/').toEqual([]);
    expect(vendor.some((v) => /\.wasm(\?|$)/.test(v.url)), 'wasm RNNoise загружен: ' + JSON.stringify(vendor)).toBe(true);
    await expect.poll(() => pa.evaluate(() => window.__sozvon.audio.isRnnoiseLoaded()), { message: 'isRnnoiseLoaded()' }).toBe(true);
    await expect.poll(() => pa.evaluate(() => window.__sozvon.audio.getNoiseMode())).toBe('rnnoise');

    const pcsBefore = await pa.evaluate(() => window.__qaPcs.length);
    async function checkFlowing(label) {
      await expect.poll(() => livePcStates(pa), { message: `${label}: pc у A`, timeout: 10000 }).toEqual(['connected']);
      const s1 = await inboundAudio(pb);
      await pb.waitForTimeout(2500);
      const s2 = await inboundAudio(pb);
      expect(s2.states, `${label}: pc у B`).toEqual(['connected']);
      expect(s2.bytes - s1.bytes, `${label}: bytesReceived у B растёт`).toBeGreaterThan(1000);
      return s2;
    }
    await checkFlowing('rnnoise');

    await openSection(pa, 'voice');
    const rn = pa.locator('#modal-user-settings input[type="radio"][data-pref="audio.noiseSuppression"][value="rnnoise"]');
    await expect(rn, 'RNNoise поддерживается → радио не disabled').toBeEnabled();
    for (const mode of ['standard', 'off', 'rnnoise']) {
      await setPrefUI(pa, 'audio.noiseSuppression', mode);
      expect((await readPrefs(pa))['audio.noiseSuppression']).toBe(mode);
      await expect.poll(() => pa.evaluate(() => window.__sozvon.audio.getNoiseMode()), { message: `getNoiseMode() = ${mode}` }).toBe(mode);
      await pa.waitForTimeout(800);
      await checkFlowing(mode);
      // звук собеседника реально доходит до выхода B (пик после GainNode; inbound audioLevel в Chromium
      // считается после громкости <audio>, а .remote-audio теперь muted — поэтому через хук движка)
      await expect.poll(() => pb.evaluate((id) => window.__sozvon.audio.getUserLevel(id), ua.user.id),
        { message: `${mode}: getUserLevel(A) у B > 0`, timeout: 10000, intervals: [100] }).toBeGreaterThan(0.01);
    }
    await closeSettings(pa);
    // Пересборка графа — через replaceTrack, без новых RTCPeerConnection и без перезахода
    expect(await pa.evaluate(() => window.__qaPcs.length), 'pc не пересоздавались').toBe(pcsBefore);
    await expect(pa.locator('#voice-panel')).toBeVisible();
    // Отправляемый трек жив
    const live = await pa.evaluate(() => window.__qaPcs.filter((p) => p.connectionState === 'connected')
      .every((p) => p.getSenders().some((s) => s.track && s.track.kind === 'audio' && s.track.readyState === 'live')));
    expect(live, 'у A живой аудиотрек в sender').toBe(true);
  });
});

test.describe('v2: push-to-talk', () => {
  test('режим рации: без клавиши A не говорит; с зажатой V — говорит у B; ввод в композер не включает', async ({ makePage }) => {
    test.setTimeout(150_000);
    const { pa, pb, ua, tileA } = await pairInVoice(makePage, 'Рация');
    const speakingA = pb.locator('.voice-users .voice-user.is-speaking').filter({ hasText: ua.user.username });
    // в режиме «по голосу» фейковый бип даёт speaking
    await expect(tileA).toHaveClass(/is-speaking/, { timeout: 15000 });

    await openSection(pa, 'voice');
    await setPrefUI(pa, 'audio.inputMode', 'ptt');
    expect((await readPrefs(pa))['audio.inputMode']).toBe('ptt');
    expect((await readPrefs(pa))['audio.pttKey'] ?? 'KeyV').toBe('KeyV');
    await closeSettings(pa);

    // без клавиши — тишина 5 с
    await expect(tileA).not.toHaveClass(/is-speaking/, { timeout: 5000 });
    for (let i = 0; i < 10; i++) {
      await pb.waitForTimeout(500);
      expect(await tileA.getAttribute('class'), `PTT без клавиши: A не говорит (t=${i * 0.5}s)`).not.toMatch(/is-speaking/);
      expect(await pb.evaluate((id) => window.__sozvon.audio.getUserLevel(id), ua.user.id), 'PTT без клавиши: звук A не приходит к B').toBeLessThan(0.001);
    }
    // зажатая V
    await pa.locator('#stage-grid').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await pa.keyboard.down('v');
    await expect(tileA, 'с зажатой V A говорит у B').toHaveClass(/is-speaking/, { timeout: 8000 });
    await expect(speakingA).toHaveCount(1);
    await expect.poll(() => pb.evaluate((id) => window.__sozvon.audio.getUserLevel(id), ua.user.id),
      { message: 'с зажатой V звук A приходит к B', timeout: 8000, intervals: [100] }).toBeGreaterThan(0.01);
    await pa.keyboard.up('v');
    await expect(tileA, 'после отпускания (+pttReleaseDelay) — молчит').not.toHaveClass(/is-speaking/, { timeout: 5000 });

    // V при вводе в композер не включает микрофон
    await openTextChannel(pa);
    await pa.locator('#composer-input').focus();
    await pa.keyboard.down('v');
    for (let i = 0; i < 6; i++) {
      await pb.waitForTimeout(500);
      expect(await tileA.getAttribute('class'), 'V в композере не включает PTT').not.toMatch(/is-speaking/);
    }
    await pa.keyboard.up('v');
    await expect(pa.locator('#composer-input')).toHaveValue(/v/);
  });
});
