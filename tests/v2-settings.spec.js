// v2 §3: модалка «Настройки пользователя», внешний вид, горячие клавиши, профиль через UI
import {
  test, expect, loginViaToken, createServerUI, joinVoiceUI, openTextChannel, loginUI,
} from './fixtures/ui.js';
import { http } from './fixtures/api.js';
import {
  SECTIONS, readPrefs, openSettings, openSection, closeSettings, setPrefUI, captureKeyUI, recordEarlyTheme,
} from './fixtures/v2.js';

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const rootFont = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
function luminance(rgb) {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) || []).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test.describe('v2: модалка настроек', () => {
  test('открывается #btn-user-settings, все 6 разделов рендерятся, Esc и крестик закрывают', async ({ makePage }) => {
    const page = await makePage();
    await loginViaToken(page, 'set');
    const modal = await openSettings(page);
    for (const id of SECTIONS) {
      const panel = await openSection(page, id);
      await expect(page.locator(`#modal-user-settings button[data-section="${id}"]`)).toBeVisible();
      expect((await panel.innerText()).trim().length, `раздел ${id} не пустой`).toBeGreaterThan(10);
      // остальные панели скрыты
      await expect(modal.locator('[data-panel]').locator('visible=true')).toHaveCount(1);
    }
    // ключевые контролы по разделам
    const voice = await openSection(page, 'voice');
    for (const key of ['audio.inputDeviceId', 'audio.inputVolume', 'audio.outputVolume', 'audio.echoCancellation', 'audio.autoGain', 'audio.sensitivityAuto', 'audio.pttKey']) {
      await expect(voice.locator(`[data-pref="${key}"]`).first(), key).toHaveCount(1);
    }
    for (const v of ['rnnoise', 'standard', 'off']) await expect(voice.locator(`input[type=radio][data-pref="audio.noiseSuppression"][value="${v}"]`)).toHaveCount(1);
    for (const v of ['voice', 'ptt']) await expect(voice.locator(`input[type=radio][data-pref="audio.inputMode"][value="${v}"]`)).toHaveCount(1);
    const app = await openSection(page, 'appearance');
    for (const v of ['dark', 'light', 'amoled']) await expect(app.locator(`input[type=radio][data-pref="appearance.theme"][value="${v}"]`)).toHaveCount(1);
    await expect(app.locator('[data-pref="appearance.fontScale"]')).toHaveCount(1);
    await expect(app.locator('[data-pref="appearance.compact"]')).toHaveCount(1);
    const kb = await openSection(page, 'keybinds');
    for (const key of ['keybinds.toggleMute', 'keybinds.toggleDeafen']) await expect(kb.locator(`button[data-pref="${key}"]`)).toHaveCount(1);
    const acc = await openSection(page, 'account');
    await expect(acc.locator('button[data-color]')).not.toHaveCount(0);
    await expect(acc.locator('#settings-old-password')).toHaveCount(1);
    await expect(acc.locator('#settings-new-password')).toHaveCount(1);

    await closeSettings(page);
    await openSettings(page);
    await page.locator('#modal-user-settings button.settings__close[data-close]').click();
    await expect(modal).toBeHidden();
  });

  test('тема light/amoled: data-theme на <html>, сохраняется после reload и стоит ДО рендера body', async ({ makePage }) => {
    const page = await makePage();
    await recordEarlyTheme(page);
    await loginViaToken(page, 'thm');
    const darkBg = await bodyBg(page);
    expect(await theme(page) ?? 'dark').toBe('dark');

    await openSection(page, 'appearance');
    await setPrefUI(page, 'appearance.theme', 'light');
    await expect.poll(() => theme(page)).toBe('light');
    const lightBg = await bodyBg(page);
    expect(luminance(lightBg), `светлая тема светлее тёмной (${lightBg} vs ${darkBg})`).toBeGreaterThan(luminance(darkBg) + 60);
    await closeSettings(page);

    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    expect(await theme(page)).toBe('light');
    const early = await page.evaluate(() => window.__qaTheme);
    expect(early.atDCL, 'data-theme на DOMContentLoaded').toBe('light');
    expect(early.atBody, 'data-theme уже стоит к началу <body> (без мигания тёмной темы)').toBe('light');

    await openSection(page, 'appearance');
    await setPrefUI(page, 'appearance.theme', 'amoled');
    await expect.poll(() => theme(page)).toBe('amoled');
    await closeSettings(page);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    const early2 = await page.evaluate(() => window.__qaTheme);
    expect(early2.atBody).toBe('amoled');
    expect(early2.atDCL).toBe('amoled');
    const amoledBg = await bodyBg(page);
    expect(luminance(amoledBg), `AMOLED фон почти чёрный (${amoledBg})`).toBeLessThan(8);

    // Сброс настроек в «О приложении» возвращает тёмную тему
    await openSection(page, 'about');
    const reset = page.locator('#modal-user-settings [data-panel="about"] button').filter({ hasText: /сброс/i });
    await expect(reset).toHaveCount(1);
    await reset.click();
    const confirm = page.locator('#modal-confirm');
    if (await confirm.isVisible().catch(() => false)) await confirm.locator('.btn--danger, .btn--primary').first().click();
    await expect.poll(() => theme(page).then((t) => t ?? 'dark')).toBe('dark');
  });

  test('масштаб шрифта и компактный режим применяются и сохраняются', async ({ makePage }) => {
    const page = await makePage();
    await loginViaToken(page, 'fnt');
    const base = await rootFont(page);
    await openSection(page, 'appearance');
    await setPrefUI(page, 'appearance.fontScale', 130);
    expect((await readPrefs(page))['appearance.fontScale']).toBe(130);
    await expect.poll(() => rootFont(page), { message: 'font-size <html> при 130%' }).toBeCloseTo(base * 1.3, 0);
    await setPrefUI(page, 'appearance.fontScale', 80);
    await expect.poll(() => rootFont(page)).toBeCloseTo(base * 0.8, 0);
    await setPrefUI(page, 'appearance.compact', true);
    await expect(page.locator('html')).toHaveAttribute('data-compact', 'true');
    await closeSettings(page);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    expect(await rootFont(page)).toBeCloseTo(base * 0.8, 0);
    await expect(page.locator('html')).toHaveAttribute('data-compact', 'true');
  });
});

test.describe('v2: горячие клавиши', () => {
  test('Ctrl+Shift+M переключает mute; при вводе в композер буквы не переключают; переназначение работает', async ({ makePage }) => {
    test.setTimeout(90_000);
    const page = await makePage();
    await loginViaToken(page, 'hk');
    await createServerUI(page, 'Клавиши');
    await joinVoiceUI(page);
    const mute = page.locator('#btn-mute');
    await expect(mute).not.toHaveClass(/is-on/);
    await page.locator('body').click({ position: { x: 700, y: 10 } }).catch(() => {});
    await page.keyboard.press('Control+Shift+KeyM');
    await expect(mute, 'Ctrl+Shift+M → mute').toHaveClass(/is-on/);
    await page.keyboard.press('Control+Shift+KeyM');
    await expect(mute).not.toHaveClass(/is-on/);
    await page.keyboard.press('Control+Shift+KeyD');
    await expect(page.locator('#btn-deafen'), 'Ctrl+Shift+D → deafen').toHaveClass(/is-on/);
    await page.keyboard.press('Control+Shift+KeyD');
    await expect(page.locator('#btn-deafen')).not.toHaveClass(/is-on/);

    // переназначить mute на одиночную клавишу M (без модификаторов) — при вводе текста не срабатывает
    await openSection(page, 'keybinds');
    await captureKeyUI(page, 'keybinds.toggleMute', 'KeyM');
    await expect.poll(async () => (await readPrefs(page))['keybinds.toggleMute'], { message: 'захват клавиши' }).toMatch(/^(M|KeyM)$/);
    await closeSettings(page);
    await expect(mute, 'захват не переключил mute').not.toHaveClass(/is-on/);
    await openTextChannel(page);
    const input = page.locator('#composer-input');
    await input.click();
    await input.pressSequentially('mama mia M');
    await expect(input).toHaveValue('mama mia M');
    await expect(mute, 'буквы в композере не переключают mute').not.toHaveClass(/is-on/);
    await input.fill('');
    await page.locator('#messages').click().catch(() => {});
    await page.locator('#composer-input').blur();
    await page.keyboard.press('KeyM');
    await expect(mute, 'M вне поля ввода → mute').toHaveClass(/is-on/);
    await page.keyboard.press('Control+Shift+KeyM');
    await expect(mute, 'старое сочетание больше не действует').toHaveClass(/is-on/);
    await page.keyboard.press('KeyM');
    await expect(mute).not.toHaveClass(/is-on/);
  });
});

test.describe('v2: учётная запись через UI', () => {
  test('цвет из палитры сохраняется на сервере; смена пароля через форму', async ({ makePage }) => {
    // 400 на неверный старый пароль браузер логирует как ошибку ресурса — ожидаемо
    const page = await makePage({ allowErrors: [/status of 400 .*\/api\/me\/password/] });
    const reg = await loginViaToken(page, 'acc');
    const acc = await openSection(page, 'account');
    const sw = acc.locator('button[data-color]').nth(2);
    const color = (await sw.getAttribute('data-color')).toLowerCase();
    await sw.click();
    await expect.poll(async () => (await http('GET', '/api/me', { token: reg.token })).json.user.color.toLowerCase(),
      { message: 'PATCH /api/me из UI' }).toBe(color);

    await acc.locator('#settings-old-password').fill('wrong-old-pass');
    await acc.locator('#settings-new-password').fill('brandnew77');
    const confirm = acc.locator('#settings-confirm-password');
    if (await confirm.count()) await confirm.fill('brandnew77');
    await acc.locator('#form-password [type="submit"]').click();
    // ошибка показана, сессия жива
    await expect(acc.locator('#form-password')).toContainText(/невер|парол/i);
    await expect(page.locator('#app')).toBeVisible();

    await acc.locator('#settings-old-password').fill(reg.password);
    await acc.locator('#settings-new-password').fill('brandnew77');
    if (await confirm.count()) await confirm.fill('brandnew77');
    await acc.locator('#form-password [type="submit"]').click();
    await expect.poll(async () => (await http('POST', '/api/login', { body: { username: reg.username, password: 'brandnew77' } })).status,
      { message: 'вход с новым паролем' }).toBe(200);
    await expect(page.locator('#app')).toBeVisible();
    await page.reload();
    await expect(page.locator('#app'), 'текущая сессия не разлогинена').toBeVisible();
    await closeSettings(page).catch(() => {});
    // свежий контекст: вход через форму с новым паролем
    const p2 = await makePage({ name: 'relogin' });
    await loginUI(p2, reg.username, 'brandnew77');
  });
});
