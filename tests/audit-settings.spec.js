// Полный аудит: настройки пользователя — каждая настройка сохраняется и переживает перезагрузку,
// тест микрофона, переназначение горячих клавиш, сброс. owner: qa
import { test, expect, loginViaToken, createServerUI, joinVoiceUI } from './fixtures/ui.js';
import { readPrefs, openSettings, openSection, closeSettings, setPrefUI, captureKeyUI } from './fixtures/v2.js';

// [секция, ключ, новое значение] — всё, что пользователь может поменять в UI (кроме громкостей собеседников)
const CHANGES = [
  ['voice', 'audio.noiseSuppression', 'standard'],
  ['voice', 'audio.echoCancellation', false],
  ['voice', 'audio.autoGain', false],
  ['voice', 'audio.sensitivityAuto', false],
  ['voice', 'stream.autoWatch', true],
  ['voice', 'stream.selfPreview', true],
  ['voice', 'audio.inputMode', 'ptt'], // после него чувствительность скрыта
  ['appearance', 'appearance.theme', 'light'],
  ['appearance', 'appearance.compact', true],
  ['appearance', 'appearance.reduceMotion', 'on'],
  // подпункты звуков — до общего выключателя (при выключенных звуках они скрыты)
  ['notifications', 'notifications.soundJoinLeave', false],
  ['notifications', 'notifications.soundMessage', false],
  ['notifications', 'notifications.soundMute', false],
  ['notifications', 'notifications.sounds', false],
  ['notifications', 'notifications.mentionsOnly', true],
];

test.describe('audit: настройки', () => {
  test('каждая настройка: UI → prefs → после перезагрузки контрол показывает сохранённое', async ({ makePage }) => {
    test.setTimeout(150_000);
    const p = await makePage();
    await loginViaToken(p, 'set');
    const missing = [];
    for (const [sec, key, val] of CHANGES) {
      await openSection(p, sec);
      const ctl = p.locator(`#modal-user-settings [data-pref="${key}"]`);
      if (!(await ctl.count())) { missing.push(key); continue; }
      await setPrefUI(p, key, val);
      await expect.poll(async () => (await readPrefs(p))[key], { message: key }).toEqual(val);
    }
    expect(missing, 'контролы, которых нет в UI').toEqual([]);
    // ползунки
    await openSection(p, 'voice');
    for (const [key, v] of [['audio.inputVolume', '150'], ['audio.outputVolume', '60']]) {
      const r = p.locator(`#modal-user-settings input[type=range][data-pref="${key}"]`);
      if (await r.count()) { await r.fill(v); await expect.poll(async () => (await readPrefs(p))[key]).toBe(Number(v)); }
      else missing.push(key);
    }
    await openSection(p, 'appearance');
    const fs = p.locator('#modal-user-settings [data-pref="appearance.fontScale"]');
    if (await fs.count()) {
      const tag = await fs.first().evaluate((n) => n.tagName + n.type);
      if (/range/.test(tag)) await fs.first().fill('120'); else await setPrefUI(p, 'appearance.fontScale', 120);
      await expect.poll(async () => (await readPrefs(p))['appearance.fontScale']).toBe(120);
    }
    expect(missing).toEqual([]);
    await closeSettings(p);
    await p.reload();
    await expect(p.locator('#app')).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    for (const [sec, key, val] of CHANGES) {
      await openSection(p, sec);
      const radio = p.locator(`#modal-user-settings input[type=radio][data-pref="${key}"][value="${val}"]`);
      if (await radio.count()) { await expect(radio, key).toBeChecked(); continue; }
      const el = p.locator(`#modal-user-settings [data-pref="${key}"]`).first();
      const type = await el.evaluate((n) => n.type);
      if (type === 'checkbox') expect(await el.isChecked(), key).toBe(!!val);
      else expect(await el.inputValue(), key).toBe(String(val));
    }
    await openSection(p, 'voice');
    expect(await p.locator('#modal-user-settings input[type=range][data-pref="audio.inputVolume"]').inputValue()).toBe('150');
  });

  test('«Сбросить настройки» возвращает всё по умолчанию (с подтверждением)', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'rst');
    await openSection(p, 'appearance');
    await setPrefUI(p, 'appearance.theme', 'amoled');
    await expect.poll(() => p.evaluate(() => document.documentElement.dataset.theme)).toBe('amoled');
    await openSection(p, 'about');
    await p.locator('#btn-reset-all').click();
    await p.locator('#confirm-ok').click();
    await expect.poll(async () => (await readPrefs(p))['appearance.theme'] ?? 'dark').toBe('dark');
    await expect.poll(() => p.evaluate(() => document.documentElement.dataset.theme || 'dark')).toBe('dark');
  });

  test('тест микрофона: уровень в дБ меняется, повторный клик останавливает; закрытие окна тоже останавливает', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'mic');
    await openSection(p, 'voice');
    const btn = p.locator('#btn-mic-test');
    await btn.click();
    await expect(p.locator('#mic-test-db')).toHaveText(/-?\d+ дБ/, { timeout: 10000 });
    await btn.click();
    await expect(btn).toContainText('Проверить микрофон');
    // запустить и закрыть модалку: трек микрофона должен быть остановлен
    await btn.click();
    await expect(p.locator('#mic-test-db')).toHaveText(/дБ/, { timeout: 10000 });
    await closeSettings(p);
    await p.waitForTimeout(500);
    await openSection(p, 'voice');
    await expect(p.locator('#btn-mic-test')).toContainText('Проверить микрофон');
  });

  test('устройства: списки ввода/вывода заполнены (фейковые устройства), выбор сохраняется', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'dev');
    await openSection(p, 'voice');
    const inp = p.locator('#settings-input-device');
    await expect.poll(() => inp.locator('option').count(), { timeout: 10000 }).toBeGreaterThan(1);
    const values = await inp.locator('option').evaluateAll((os) => os.map((o) => o.value));
    const pick = values.find((v) => v !== 'default') || values[0];
    await inp.selectOption(pick);
    await expect.poll(async () => (await readPrefs(p))['audio.inputDeviceId']).toBe(pick);
  });

  test('горячая клавиша mute переназначается и работает; старое сочетание больше не работает', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'kb');
    await createServerUI(p, 'Клавиши');
    await joinVoiceUI(p);
    await openSection(p, 'keybinds');
    await captureKeyUI(p, 'keybinds.toggleMute', 'Alt+KeyK');
    await expect.poll(async () => (await readPrefs(p))['keybinds.toggleMute']).toMatch(/Alt\+K/i);
    await closeSettings(p);
    await p.locator('#stage-grid').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await p.keyboard.press('Control+Shift+M');
    await p.waitForTimeout(300);
    await expect(p.locator('#ctrl-mute')).not.toHaveClass(/is-on/);
    await p.keyboard.press('Alt+KeyK');
    await expect(p.locator('#ctrl-mute')).toHaveClass(/is-on/);
    await p.keyboard.press('Alt+KeyK');
    await expect(p.locator('#ctrl-mute')).not.toHaveClass(/is-on/);
  });

  test('Esc и крестик закрывают настройки; несохранённый профиль — предупреждение или сохранённое состояние', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'esc');
    await openSettings(p);
    await p.locator('#modal-user-settings button.settings__close, #modal-user-settings [data-close]').first().click();
    await expect(p.locator('#modal-user-settings')).toBeHidden();
    await openSection(p, 'profile');
    await p.locator('#profile-about').fill('несохранённый текст');
    await expect(p.locator('#profile-save-bar')).toBeVisible();
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    // допустимо: модалка не закрылась (просит сохранить) ИЛИ закрылась, а изменения не применены на сервере
    if (await p.locator('#modal-user-settings').isHidden()) {
      const about = await p.evaluate(() => window.__sozvon.state.user.about);
      expect(about).not.toBe('несохранённый текст');
    }
  });
});
