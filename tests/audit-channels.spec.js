// Полный аудит: каналы — переименование (текст/голос), пограничные случаи (owner: qa)
import { test, expect, loginViaToken, createServerUI, channel, joinVoiceUI } from './fixtures/ui.js';

async function renameViaGear(page, type, from, to) {
  const row = channel(page, type, from);
  await row.hover();
  await row.locator('.channel__edit').click();
  const modal = page.locator('#modal-channel-perms');
  await expect(modal).toBeVisible();
  const input = modal.locator('#channel-edit-name');
  await expect(input).toHaveValue(from);
  await input.fill(to);
  await expect(input).toHaveValue(to);
  await page.locator('#btn-channel-perms-save').click();
  return modal;
}

test.describe('audit: переименование каналов', () => {
  test('владелец переименовывает голосовой канал через шестерёнку', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'rn');
    await createServerUI(p, 'Rename QA');
    const modal = await renameViaGear(p, 'voice', 'Голосовой', 'Болталка');
    await expect(modal).toBeHidden();
    await expect(channel(p, 'voice', 'Болталка')).toBeVisible();
    await p.reload();
    await expect(channel(p, 'voice', 'Болталка')).toBeVisible();
  });

  test('владелец переименовывает голосовой канал, находясь в нём', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'rn');
    await createServerUI(p, 'Rename QA2');
    await joinVoiceUI(p, 'Голосовой');
    const modal = await renameViaGear(p, 'voice', 'Голосовой', 'Комната 2');
    await expect(modal).toBeHidden();
    await expect(channel(p, 'voice', 'Комната 2')).toBeVisible();
  });

  test('переименование текстового канала', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'rn');
    await createServerUI(p, 'Rename QA3');
    const modal = await renameViaGear(p, 'text', 'общий', 'флуд');
    await expect(modal).toBeHidden();
    await expect(channel(p, 'text', 'флуд')).toBeVisible();
  });

  test('имя 33–40 символов: поле принимает, сервер отвечает понятной ошибкой', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'rn');
    await createServerUI(p, 'Rename QA4');
    const long = 'Очень длинное название канала 1234567'; // 37
    const modal = await renameViaGear(p, 'voice', 'Голосовой', long);
    // либо принято целиком, либо модалка показывает ошибку — молча ничего не должно происходить
    await p.waitForTimeout(800);
    const hidden = await modal.isHidden();
    if (hidden) await expect(channel(p, 'voice', long)).toBeVisible();
    else await expect(modal.locator('[data-error]')).toHaveText(/длинн|максимум/i);
    test.info().annotations.push({ type: 'result', description: hidden ? 'accepted' : 'error shown' });
  });
});
