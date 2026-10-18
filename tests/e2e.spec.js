// UI-сценарии по критериям приёмки SPEC §6 (два browser context = два пользователя)
import {
  test, expect, registerUI, loginUI, loginViaToken, createServerUI, joinServerUI, inviteCode,
  channel, openTextChannel, joinVoiceUI, sendMessageUI, messageWith, twoUsersOneServer, noHorizontalScroll, startScreenShare, watchScreen } from './fixtures/ui.js';
import { startBot, http, uniqueName } from './fixtures/api.js';
import { ensureMedia } from './fixtures/media.js';

test.describe('Критерий 1: регистрация / вход / выход / сессия', () => {
  test('регистрация через UI, сессия переживает reload, выход, вход', async ({ makePage }) => {
    const page = await makePage();
    const { username, password } = await registerUI(page, uniqueName('c1'));
    const token = await page.evaluate(() => localStorage.getItem('sozvon.token'));
    expect(token, 'token в localStorage sozvon.token').toBeTruthy();
    await expect(page.locator('.user-panel__name')).toHaveText(username);

    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#auth-screen')).toBeHidden();
    await expect(page.locator('.user-panel__name')).toHaveText(username);

    await page.locator('#btn-logout').click();
    await expect(page.locator('#auth-screen')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('sozvon.token'))).toBeFalsy();
    await page.reload();
    await expect(page.locator('#auth-screen')).toBeVisible();

    await loginUI(page, username, password);
    await expect(page.locator('.user-panel__name')).toHaveText(username);
  });

  test('ошибки входа показываются в #auth-error', async ({ makePage }) => {
    // 401 на /api/login браузер логирует как ошибку ресурса — это ожидаемо, не баг приложения
    const page = await makePage({ allowErrors: [/401|Unauthorized|status of 4\d\d/i] });
    await page.goto('/');
    await expect(page.locator('#auth-screen')).toBeVisible();
    const submit = page.locator('#auth-form button[type="submit"], #auth-form .btn--primary').first();
    if (!/войти|вход/i.test(await submit.innerText())) await page.locator('#auth-toggle').click();
    await page.locator('#auth-form input[name="username"], #auth-username').first().fill(uniqueName('nobody'));
    await page.locator('#auth-form input[name="password"], #auth-password').first().fill('wrongpass');
    await submit.click();
    await expect(page.locator('#auth-error')).toBeVisible();
    await expect(page.locator('#auth-error')).toHaveText(/\S/);
    await expect(page.locator('#app')).toBeHidden();
  });
});

test.describe('Критерий 2: сервер, инвайт, участники', () => {
  test('создать сервер → 2 канала; B входит по инвайту; оба онлайн в members', async ({ makePage }) => {
    const { pa, pb, ua, ub } = await twoUsersOneServer(makePage, 'Сервер К2');
    for (const p of [pa, pb]) {
      await expect(p.locator('a.channel[data-type="text"] .channel__name')).toHaveText(['общий']);
      await expect(p.locator('a.channel[data-type="voice"] .channel__name')).toHaveText(['Голосовой']);
      await expect(p.locator('#servers .server-icon.is-active')).toHaveCount(1);
      for (const u of [ua, ub]) {
        const m = p.locator('#members .member').filter({ has: p.locator('.member__name', { hasText: u.username }) });
        await expect(m).toHaveCount(1);
        await expect(m).not.toHaveClass(/is-offline/);
      }
      // DJ Бот — участник каждого сервера
      await expect(p.locator('#members .member').filter({ hasText: 'DJ Бот' })).toHaveCount(1);
    }
    // владелец помечен короной
    const ownerRow = pb.locator('#members .member').filter({ hasText: ua.username });
    await expect(ownerRow.locator('use[href$="#i-crown"]')).toHaveCount(1);
    // B уходит офлайн → A видит .is-offline
    await pb.context().close();
    await expect(pa.locator('#members .member').filter({ hasText: ub.username })).toHaveClass(/is-offline/, { timeout: 10000 });
  });
});

test.describe('Критерий 3: сообщения', () => {
  test('realtime, история после reload, картинка-вложение, удаление', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Чат К3');
    await openTextChannel(pa); await openTextChannel(pb);
    await sendMessageUI(pa, 'Привет из A');
    await expect(messageWith(pb, 'Привет из A')).toHaveCount(1);
    await sendMessageUI(pb, 'Ответ из B');
    await expect(messageWith(pa, 'Ответ из B')).toHaveCount(1);
    // кнопка отправки тоже работает
    await pa.locator('#composer-input').fill('через кнопку');
    await pa.locator('#btn-send').click();
    await expect(messageWith(pb, 'через кнопку')).toHaveCount(1);

    // история после перезагрузки
    await pb.reload();
    await expect(pb.locator('#app')).toBeVisible();
    await openTextChannel(pb);
    await expect(messageWith(pb, 'Привет из A')).toHaveCount(1);
    await expect(messageWith(pb, 'Ответ из B')).toHaveCount(1);

    // вложение-картинка
    const { image } = ensureMedia();
    await pa.locator('#file-input').setInputFiles(image);
    await expect(pa.locator('#pending-attachments .chip')).toHaveCount(1, { timeout: 15000 });
    await pa.locator('#composer-input').fill('картинка');
    await pa.locator('#btn-send').click();
    const imgB = messageWith(pb, 'картинка').locator('img.message__image');
    await expect(imgB).toHaveCount(1);
    await expect.poll(() => imgB.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

    // удаление своего сообщения
    const own = messageWith(pa, 'Привет из A');
    await own.hover();
    await own.locator('.message__delete').click();
    await expect(messageWith(pa, 'Привет из A')).toHaveCount(0);
    await expect(messageWith(pb, 'Привет из A')).toHaveCount(0);
    // B (не владелец) не видит кнопку удаления чужого сообщения
    const foreign = messageWith(pb, 'через кнопку');
    await foreign.hover();
    await expect(foreign.locator('.message__delete:visible')).toHaveCount(0);
  });
});

async function remoteTile(page, otherName) {
  return page.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: otherName }).first();
}

test.describe('Критерий 4–5: голос и стрим экрана', () => {
  test('оба в голосе, PC connected, входящий аудиотрек, mute виден у второго, стрим экрана @autoplay', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb, ua, ub } = await twoUsersOneServer(makePage, 'Голос К4');
    await joinVoiceUI(pa);
    await joinVoiceUI(pb);
    for (const p of [pa, pb]) {
      const vu = p.locator('.voice-users .voice-user');
      await expect(vu).toHaveCount(2);
      await expect(vu.filter({ hasText: ua.username })).toHaveCount(1);
      await expect(vu.filter({ hasText: ub.username })).toHaveCount(1);
      await expect(p.locator('#stage-grid .tile[data-socket-id]')).toHaveCount(2);
    }
    // RTCPeerConnection connected → data-connected="true" на удалённом тайле
    const tB_onA = await remoteTile(pa, ub.username);
    const tA_onB = await remoteTile(pb, ua.username);
    await expect(tB_onA).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
    await expect(tA_onB).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
    // входящий аудиотрек
    for (const p of [pa, pb]) {
      await expect(p.locator('audio.remote-audio')).not.toHaveCount(0);
      await expect.poll(() => p.evaluate(() => [...document.querySelectorAll('audio.remote-audio')].some((a) =>
        a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live') && !a.paused)),
      { timeout: 15000, message: 'live remote audio track playing' }).toBe(true);
    }

    // mute A → у B иконка mic-off на тайле и в сайдбаре
    await pa.locator('#ctrl-mute').click();
    await expect(pa.locator('#ctrl-mute')).toHaveClass(/is-on/);
    await expect(pa.locator('#btn-mute')).toHaveClass(/is-on/);
    await expect(tA_onB.locator('use[href$="#i-mic-off"]')).not.toHaveCount(0);
    const vuA_onB = pb.locator('.voice-user').filter({ hasText: ua.username });
    await expect(vuA_onB.locator('use[href$="#i-mic-off"]')).not.toHaveCount(0);
    // unmute
    await pa.locator('#ctrl-mute').click();
    await expect(pa.locator('#ctrl-mute')).not.toHaveClass(/is-on/);
    await expect(vuA_onB.locator('use[href$="#i-mic-off"]')).toHaveCount(0);

    // стрим экрана: A → у B .tile--screen video с videoWidth>0 и LIVE в сайдбаре
    await startScreenShare(pa); // v3: через #modal-stream
    await expect(pa.locator('#ctrl-screen')).toHaveClass(/is-on/);
    await watchScreen(pb); // трансляция по запросу: «Смотреть»
    const screenB = pb.locator('#stage-grid .tile.tile--screen video');
    await expect(screenB).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => screenB.evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(vuA_onB.locator('.badge--live')).toBeVisible();
    // остановка стрима
    await pa.locator('#ctrl-screen').click();
    await expect(pb.locator('#stage-grid .tile.tile--screen')).toHaveCount(0, { timeout: 15000 });
    await expect(vuA_onB.locator('.badge--live')).toHaveCount(0);

    // выход из голоса
    await pb.locator('#ctrl-leave').click();
    await expect(pb.locator('#voice-panel')).toBeHidden();
    await expect(pa.locator('.voice-users .voice-user')).toHaveCount(1);
    await expect(pa.locator('#stage-grid .tile[data-socket-id]')).toHaveCount(1);
  });
});

test.describe('Критерий 7: бот офлайн', () => {
  test('!play при офлайн-боте → системное сообщение', async ({ makePage }) => {
    const cfg = await http('GET', '/api/config');
    test.skip(cfg.json.botOnline, 'бот запущен');
    const page = await makePage();
    await loginViaToken(page, 'c7');
    await createServerUI(page, 'Без бота');
    await openTextChannel(page);
    await sendMessageUI(page, '!play lofi');
    const sys = page.locator('#messages .message.message--system');
    await expect(sys).toHaveCount(1);
    await expect(sys).toContainText('Музыкальный бот не запущен');
  });
});

test.describe('Критерий 6: музыкальный бот', () => {
  let bot;
  test.beforeAll(async () => { bot = await startBot(); });
  test.afterAll(async () => { await bot?.stop(); });

  test('!play → бот с бейджем БОТ, плеер, audio играет; кнопки; !skip; !stop @autoplay', async ({ makePage }) => {
    test.setTimeout(120_000);
    const { pa, pb } = await twoUsersOneServer(makePage, 'Музыка К6');
    await joinVoiceUI(pa);
    await joinVoiceUI(pb);
    await openTextChannel(pa);
    await sendMessageUI(pa, '!play qa sine 440');

    for (const p of [pa, pb]) {
      const botRow = p.locator('.voice-users .voice-user').filter({ has: p.locator('.badge--bot') });
      await expect(botRow).toHaveCount(1, { timeout: 15000 });
      await expect(botRow.locator('.badge--bot')).toHaveText('БОТ');
      await expect(botRow).toContainText('DJ Бот');
      await expect(p.locator('#music-player')).toBeVisible();
      await expect(p.locator('#music-player .music-player__title')).toContainText('440');
      await expect.poll(() => p.evaluate(() => {
        const a = document.querySelector('audio#music-audio');
        return a && !a.paused && a.src.includes('/media/music/') && a.currentTime > 0;
      }), { timeout: 15000, message: 'audio#music-audio играет' }).toBe(true);
    }
    // синхронизация позиции между слушателями (≤ 1.5 c)
    const [ta, tb] = await Promise.all([pa, pb].map((p) => p.evaluate(() => document.querySelector('#music-audio').currentTime)));
    expect(Math.abs(ta - tb)).toBeLessThan(2);
    // бот отвечает в чат
    await expect(pa.locator('#messages .message').filter({ hasText: 'DJ Бот' }).last()).toBeVisible();

    // кнопка pause у B → пауза у обоих; resume
    await pb.locator('#music-player [data-music="pause"]').click();
    for (const p of [pa, pb]) await expect.poll(() => p.evaluate(() => document.querySelector('#music-audio').paused), { timeout: 10000 }).toBe(true);
    await pb.locator('#music-player [data-music="resume"]').click();
    for (const p of [pa, pb]) await expect.poll(() => p.evaluate(() => !document.querySelector('#music-audio').paused), { timeout: 10000 }).toBe(true);

    // очередь + !skip
    await sendMessageUI(pa, '!play 660');
    await sendMessageUI(pa, '!skip');
    for (const p of [pa, pb]) await expect(p.locator('#music-player .music-player__title')).toContainText('660', { timeout: 10000 });
    // кнопка skip плеера → следующего нет → track:null или новая очередь
    await sendMessageUI(pa, '!play 880');
    await pb.locator('#music-player [data-music="skip"]').click();
    for (const p of [pa, pb]) await expect(p.locator('#music-player .music-player__title')).toContainText('880', { timeout: 10000 });

    // громкость — локальный слайдер, сохраняется в localStorage
    await pb.locator('#music-volume').fill('20');
    await expect.poll(() => pb.evaluate(() => localStorage.getItem('sozvon.musicVolume'))).not.toBeNull();
    await expect.poll(() => pb.evaluate(() => document.querySelector('#music-audio').volume)).toBeLessThan(0.5);

    // !stop → плеер скрыт, бот вышел из голоса
    await sendMessageUI(pa, '!stop');
    for (const p of [pa, pb]) {
      await expect(p.locator('#music-player')).toBeHidden({ timeout: 10000 });
      await expect(p.locator('.voice-users .voice-user .badge--bot')).toHaveCount(0, { timeout: 10000 });
    }

    // кнопка stop плеера
    await sendMessageUI(pa, '!play 440');
    await expect(pb.locator('#music-player')).toBeVisible({ timeout: 10000 });
    await pb.locator('#music-player [data-music="stop"]').click();
    await expect(pb.locator('#music-player')).toBeHidden({ timeout: 10000 });
  });

  test('библиотека: загрузка трека через #modal-music', async ({ makePage }) => {
    const page = await makePage();
    await loginViaToken(page, 'lib');
    await createServerUI(page, 'Библиотека');
    await joinVoiceUI(page);
    await openTextChannel(page);
    await sendMessageUI(page, '!play 440');
    await expect(page.locator('#music-player')).toBeVisible({ timeout: 15000 });
    await page.locator('#btn-music-library').click();
    const modal = page.locator('#modal-music');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.track')).not.toHaveCount(0);
    const before = await modal.locator('.track').count();
    const { uploadUi } = ensureMedia();
    await modal.locator('input[type=file]').setInputFiles(uploadUi);
    await expect(modal.locator('.track')).toHaveCount(before + 1, { timeout: 15000 });
    await expect(modal.locator('.track').filter({ hasText: 'QA UI Upload' })).toHaveCount(1);
    await sendMessageUI(page, '!stop').catch(() => {});
  });
});

test.describe('Критерий 8: адаптив 375px', () => {
  test('375px: нет горизонтального скролла на auth и в приложении; меню выезжает', async ({ makePage }) => {
    const page = await makePage({ viewport: { width: 375, height: 812 } });
    await page.goto('/');
    await expect(page.locator('#auth-screen')).toBeVisible();
    let s0 = await noHorizontalScroll(page);
    expect(s0.ok, 'auth 375px: ' + JSON.stringify(s0)).toBe(true);
    await loginViaToken(page, 'mob');
    s0 = await noHorizontalScroll(page);
    expect(s0.ok, 'пустое приложение 375px: ' + JSON.stringify(s0)).toBe(true);
    await expect(page.locator('#members')).toBeHidden();
    await expect(page.locator('#btn-menu')).toBeVisible();
    // < 640px колонка серверов и сайдбар выезжают по #btn-menu
    await expect(page.locator('#sidebar')).not.toBeInViewport();
    await page.locator('#btn-menu').click();
    await expect(page.locator('#app')).toHaveClass(/is-nav-open/);
    await expect(page.locator('#btn-add-server')).toBeInViewport();
    await createServerUI(page, 'Мобилка');
    if (!(await page.locator('#app.is-nav-open').count())) await page.locator('#btn-menu').click();
    await channel(page, 'text', 'общий').click();
    // после выбора канала меню закрывается (или закрываем сами), композер доступен
    if (await page.locator('#app.is-nav-open').count()) await page.locator('#btn-menu').click();
    await expect(page.locator('#composer-input')).toBeInViewport();
    await sendMessageUI(page, 'длинное_сообщение_без_пробелов_' + 'x'.repeat(200));
    let s = await noHorizontalScroll(page);
    expect(s.ok, 'чат 375px: ' + JSON.stringify(s)).toBe(true);
    await page.locator('#btn-menu').click();
    await expect(page.locator('#app')).toHaveClass(/is-nav-open/);
    await expect(page.locator('#sidebar')).toBeInViewport();
    await expect(page.locator('#servers')).toBeInViewport();
    s = await noHorizontalScroll(page);
    expect(s.ok, 'меню открыто 375px: ' + JSON.stringify(s)).toBe(true);
    // голосовой вид на мобиле
    await joinVoiceUI(page);
    if (await page.locator('#app.is-nav-open').count()) await page.locator('#btn-menu').click();
    s = await noHorizontalScroll(page);
    expect(s.ok, 'голос 375px: ' + JSON.stringify(s)).toBe(true);
    await expect(page.locator('#ctrl-leave')).toBeInViewport();
  });

  test('< 900px members скрыт, ≥ 900px виден', async ({ makePage }) => {
    const page = await makePage({ viewport: { width: 1200, height: 800 } });
    await loginViaToken(page, 'mid');
    await createServerUI(page, 'Ширина');
    await expect(page.locator('#members')).toBeVisible();
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.locator('#members')).toBeHidden();
    expect((await noHorizontalScroll(page)).ok).toBe(true);
  });
});

// ---------- Расширенные сценарии (контракт §4–§5, edge cases) ----------
test.describe('Расширенные: голос', () => {
  test('камера, deafen, индикатор речи, поздний участник видит уже идущий стрим', async ({ makePage }) => {
    test.setTimeout(120_000);
    const { pa, pb, ua, ub, code } = await twoUsersOneServer(makePage, 'Голос+');
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    const tA_onB = await remoteTile(pb, ua.username);
    await expect(tA_onB).toHaveAttribute('data-connected', 'true', { timeout: 20000 });

    // индикатор речи: фейковый микрофон Chromium издаёт периодический «бип»
    await expect(pb.locator(`#stage-grid .tile.is-speaking`).filter({ hasText: ua.username }).first())
      .toBeVisible({ timeout: 15000 });

    // камера A → у B .tile--video с video.videoWidth > 0
    await pa.locator('#ctrl-camera').click();
    await expect(pa.locator('#ctrl-camera')).toHaveClass(/is-on/);
    const camB = pb.locator('#stage-grid .tile.tile--video:not(.tile--screen) video');
    await expect(camB).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => camB.evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    await pa.locator('#ctrl-camera').click();
    await expect(pb.locator('#stage-grid .tile.tile--video:not(.tile--screen)')).toHaveCount(0, { timeout: 15000 });

    // deafen B → у A иконка наушников-выкл.; у B входящее аудио заглушено
    await pb.locator('#ctrl-deafen').click();
    await expect(pb.locator('#ctrl-deafen')).toHaveClass(/is-on/);
    const vuB_onA = pa.locator('.voice-user').filter({ hasText: ub.username });
    await expect(vuB_onA.locator('use[href$="#i-headphones-off"]')).not.toHaveCount(0);
    await expect.poll(() => pb.evaluate(() => [...document.querySelectorAll('audio.remote-audio')].every((a) => a.muted || a.volume === 0 || a.paused))).toBe(true);
    await pb.locator('#ctrl-deafen').click();
    await expect(vuB_onA.locator('use[href$="#i-headphones-off"]')).toHaveCount(0);

    // A стримит, C заходит позже → у C есть экран A
    await startScreenShare(pa); // v3: через #modal-stream
    await watchScreen(pb);
    await expect(pb.locator('#stage-grid .tile.tile--screen video')).toHaveCount(1, { timeout: 20000 });
    const pc = await makePage({ name: 'C' });
    await loginViaToken(pc, 'uc');
    await joinServerUI(pc, code, 'Голос+');
    await joinVoiceUI(pc);
    await watchScreen(pc);
    const scrC = pc.locator('#stage-grid .tile.tile--screen video');
    await expect(scrC).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => scrC.evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(pc.locator('#stage-grid .tile[data-socket-id]:not(.tile--screen)')).toHaveCount(3);
    await expect(pc.locator('#stage-grid .tile[data-connected="true"]:not(.tile--screen)')).toHaveCount(2, { timeout: 20000 });
  });

  test('reload в голосе: нет «призрачного» тайла, можно перезайти', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb, ub } = await twoUsersOneServer(makePage, 'Призраки');
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    await expect(pa.locator('#stage-grid .tile[data-socket-id]')).toHaveCount(2);
    await pb.reload();
    await expect(pb.locator('#app')).toBeVisible();
    await expect(pa.locator('#stage-grid .tile[data-socket-id]')).toHaveCount(1, { timeout: 10000 });
    await expect(pa.locator('.voice-users .voice-user')).toHaveCount(1);
    await joinVoiceUI(pb);
    const t = (await remoteTile(pa, ub.username));
    await expect(t).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
    await expect(pa.locator('#stage-grid .tile[data-socket-id]')).toHaveCount(2);
  });
});

test.describe('Расширенные: чат и управление', () => {
  test('XSS: HTML в сообщении/имени сервера отображается текстом', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, '<b>жирный</b>');
    await openTextChannel(pa); await openTextChannel(pb);
    await pb.evaluate(() => { window.__xss = 0; });
    await sendMessageUI(pa, '<img src=x onerror="window.__xss=1"> **жирный** `код`');
    await expect(messageWith(pb, 'onerror')).toHaveCount(1);
    await expect(pb.locator('#messages img[src="x"]')).toHaveCount(0);
    expect(await pb.evaluate(() => window.__xss)).toBe(0);
    await expect(pb.locator('#server-name')).toHaveText('<b>жирный</b>');
  });

  test('индикатор набора текста (#typing) у второго пользователя', async ({ makePage }) => {
    const { pa, pb, ua } = await twoUsersOneServer(makePage, 'Печать');
    await openTextChannel(pa); await openTextChannel(pb);
    await pa.locator('#composer-input').pressSequentially('пишу...', { delay: 50 });
    await expect(pb.locator('#typing')).toContainText(ua.username, { timeout: 5000 });
  });

  test('владелец создаёт и удаляет канал через UI (#modal-channel, #modal-confirm)', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Каналы');
    await pa.locator('[data-add-channel="text"]').click();
    const modal = pa.locator('#modal-channel');
    await expect(modal).toBeVisible();
    await modal.locator('input:visible:not([type=radio]):not([type=checkbox])').first().fill('мемы');
    await modal.locator('.btn--primary:visible').first().click();
    await expect(modal).toBeHidden();
    await expect(channel(pb, 'text', 'мемы')).toBeVisible();
    // B (не владелец) не видит кнопок управления каналами
    await expect(pb.locator('[data-add-channel]:visible')).toHaveCount(0);
    await expect(pb.locator('.channel__delete:visible')).toHaveCount(0);
    const ch = channel(pa, 'text', 'мемы');
    await ch.hover();
    await ch.locator('.channel__delete').click();
    await expect(pa.locator('#modal-confirm')).toBeVisible();
    await pa.locator('#confirm-ok').click();
    await expect(channel(pb, 'text', 'мемы')).toHaveCount(0);
    await expect(channel(pa, 'text', 'мемы')).toHaveCount(0);
  });

  test('копирование инвайта (#btn-copy-invite) и тост', async ({ makePage }) => {
    const page = await makePage({ context: { permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'] } });
    await loginViaToken(page, 'cp');
    await createServerUI(page, 'Копия');
    const code = await inviteCode(page);
    await page.locator('#btn-copy-invite').click();
    await expect(page.locator('#toasts .toast', { hasText: 'скопирован' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(code);
  });
});

test.describe('Расширенные: бот', () => {
  let bot;
  test.beforeAll(async () => { bot = await startBot(); });
  test.afterAll(async () => { await bot?.stop(); });

  test('поздний слушатель синхронизирован; deafen глушит музыку', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb } = await twoUsersOneServer(makePage, 'Синк');
    await joinVoiceUI(pa);
    await openTextChannel(pa);
    await sendMessageUI(pa, '!play qa sine 660');
    await expect(pa.locator('#music-player')).toBeVisible({ timeout: 15000 });
    await pa.waitForTimeout(4000);
    await joinVoiceUI(pb);
    await expect.poll(() => pb.evaluate(() => { const a = document.querySelector('#music-audio'); return a && !a.paused && a.currentTime; }), { timeout: 15000 }).toBeGreaterThan(3);
    const [ta, tb] = await Promise.all([pa, pb].map((p) => p.evaluate(() => document.querySelector('#music-audio').currentTime)));
    expect(Math.abs(ta - tb), `рассинхрон ${ta} vs ${tb}`).toBeLessThan(1.6);
    // слушатель, не находящийся в голосовом канале, музыку не слышит
    await pb.locator('#ctrl-leave').click();
    await expect.poll(() => pb.evaluate(() => { const a = document.querySelector('#music-audio'); return !a || a.paused || a.muted; }), { timeout: 10000 }).toBe(true);
    await joinVoiceUI(pb);
    await pb.locator('#ctrl-deafen').click();
    await expect.poll(() => pb.evaluate(() => { const a = document.querySelector('#music-audio'); return !a || a.paused || a.muted || a.volume === 0; }), { timeout: 10000 }).toBe(true);
    await sendMessageUI(pa, '!stop');
  });
});

test.describe('Расширенные: управление сервером и история', () => {
  test('rename, B покидает сервер, владелец удаляет сервер — UI обновляется у всех', async ({ makePage }) => {
    const { pa, pb, ub } = await twoUsersOneServer(makePage, 'Старое имя');
    await pa.locator('#btn-server-menu').click();
    const st = pa.locator('#modal-settings');
    await expect(st).toBeVisible();
    await st.locator('#server-rename-input').fill('Новое имя');
    await st.locator('button[type=submit]').click();
    await expect(pb.locator('#server-name')).toHaveText('Новое имя');
    await expect(pa.locator('#server-name')).toHaveText('Новое имя');

    // B покидает сервер
    await pb.locator('#btn-server-menu').click();
    await pb.locator('#btn-server-leave').click();
    if (await pb.locator('#modal-confirm').isVisible()) await pb.locator('#confirm-ok').click();
    await expect(pb.locator('#server-name')).not.toHaveText('Новое имя');
    await expect(pb.locator('#servers .server-icon[title="Новое имя"], #servers .server-icon[aria-label="Новое имя"]')).toHaveCount(0);
    await expect(pa.locator('#members .member').filter({ hasText: ub.username })).toHaveCount(0);

    // B возвращается по коду, A удаляет сервер
    const code = await inviteCode(pa);
    await joinServerUI(pb, code, 'Новое имя');
    await pa.locator('#btn-server-menu').click();
    await pa.locator('#btn-server-delete').click();
    await expect(pa.locator('#modal-confirm')).toBeVisible();
    await pa.locator('#confirm-ok').click();
    await expect(pa.locator('#server-name')).not.toHaveText('Новое имя');
    await expect(pb.locator('#server-name')).not.toHaveText('Новое имя');
    await expect(pb.locator('#toasts .toast')).not.toHaveCount(0);
  });

  test('подгрузка истории вверх (60 сообщений) и вложение-файл .file-card', async ({ makePage }) => {
    const { makeUser: mk, ack: ak, connectUser: cu, http: h } = await import('./fixtures/api.js');
    const page = await makePage();
    const reg = await loginViaToken(page, 'hist');
    await createServerUI(page, 'История');
    const s = [await cu(reg.token), await cu(reg.token), await cu(reg.token)];
    const boot = await ak(s[0], 'bootstrap');
    const ch = boot.servers.find((x) => x.name === 'История').channels.find((c) => c.type === 'text');
    for (let i = 1; i <= 60; i++) await ak(s[Math.floor((i - 1) / 20)], 'message:send', { channelId: ch.id, content: `hist ${i}` });
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('hello qa')], { type: 'text/plain' }), 'notes.txt');
    const att = (await h('POST', '/api/attachments', { token: reg.token, body: fd })).json;
    await ak(s[0], 'message:send', { channelId: ch.id, content: 'файл', attachments: [att] });
    s.forEach((x) => x.disconnect()); void mk;
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await openTextChannel(page);
    await expect(messageWith(page, 'hist 60')).toHaveCount(1);
    const card = messageWith(page, 'файл').locator('a.file-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('notes.txt');
    expect(await card.getAttribute('href')).toBe(att.url);
    await expect(page.locator('#messages .message[data-message-id]')).not.toHaveCount(61); // не всё сразу
    for (let i = 0; i < 10 && !(await messageWith(page, 'hist 1').filter({ hasText: /^hist 1$/ }).count()); i++) {
      await page.locator('#messages').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(400);
    }
    await expect(page.locator('#messages .message__content', { hasText: /^hist 1$/ })).toHaveCount(1);
    await expect(page.locator('#messages .message__content', { hasText: /^hist 30$/ })).toHaveCount(1);
  });
});
