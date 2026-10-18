// Полный аудит: профиль глазами другого пользователя (живое обновление без перезагрузки), статусы, лимиты. owner: qa
import { test, expect, twoUsersOneServer, openTextChannel, sendMessageUI, messageWith } from './fixtures/ui.js';
import { http } from './fixtures/api.js';

test.describe('audit: профиль у другого пользователя', () => {
  test('A меняет профиль → у B без перезагрузки: имя в участниках и чате, попап (местоимения, «Обо мне», статус, тема)', async ({ makePage }) => {
    const { pa, pb, ua } = await twoUsersOneServer(makePage, 'Профили');
    const aId = (await http('GET', '/api/me', { token: ua.token })).json.user.id;
    await openTextChannel(pa); await openTextChannel(pb);
    await sendMessageUI(pa, 'до смены имени');
    const r = await http('PATCH', '/api/me', {
      token: ua.token,
      body: {
        displayName: 'Капитан QA', pronouns: 'он/его', about: '**Жирное** обо мне',
        bannerColor: '#123456', profileTheme: { primary: '#ff0000', accent: '#0000ff' },
        customStatus: { emoji: '🎮', text: 'Играю в тесты', expiresAt: null }, status: 'dnd',
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const member = pb.locator(`.member[data-user-id="${aId}"]`);
    await expect(member).toContainText('Капитан QA');
    await expect(messageWith(pb, 'до смены имени').locator('.message__author')).toHaveText('Капитан QA');
    await expect(member.locator('[data-status="dnd"]')).toHaveCount(1);
    await member.click();
    const pop = pb.locator('.profile-popup');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.profile-popup__name')).toHaveText('Капитан QA');
    await expect(pop.locator('.profile-popup__username')).toContainText(ua.username);
    await expect(pop.locator('.profile-popup__pronouns')).toHaveText('он/его');
    await expect(pop.locator('.profile-popup__about strong')).toHaveText('Жирное');
    await expect(pop.locator('.profile-popup__status')).toContainText('Играю в тесты');
    const bg = await pop.evaluate((el) => getComputedStyle(el).backgroundImage + getComputedStyle(el).getPropertyValue('--profile-primary'));
    expect(bg, 'тема профиля (градиент/переменные)').toMatch(/gradient|#ff0000|255, 0, 0/i);
    await pb.keyboard.press('Escape');
    await expect(pop).toBeHidden();
  });

  test('лимиты профиля: about 191, pronouns 41, displayName 33, кривой цвет, неизвестный статус → 400 по-русски', async ({ makePage }) => {
    const p = await makePage();
    const reg = await (await import('./fixtures/api.js')).registerApi();
    for (const body of [
      { about: 'я'.repeat(191) }, { pronouns: 'x'.repeat(41) }, { displayName: 'д'.repeat(33) },
      { bannerColor: 'red' }, { status: 'away' }, { customStatus: { text: 'x'.repeat(129) } },
      { profileTheme: { primary: '#fff' } },
    ]) {
      const r = await http('PATCH', '/api/me', { token: reg.token, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error, JSON.stringify(body)).toMatch(/[а-я]/i);
    }
    // граничные — проходят
    const ok = await http('PATCH', '/api/me', { token: reg.token, body: { about: 'я'.repeat(190), pronouns: 'x'.repeat(40), displayName: 'д'.repeat(32) } });
    expect(ok.status).toBe(200);
    // пустой displayName = сброс на ник
    const reset = await http('PATCH', '/api/me', { token: reg.token, body: { displayName: '' } });
    expect([200, 400]).toContain(reset.status);
    if (reset.status === 200) expect(reset.json.user.displayName ?? null).toBeNull();
    void p;
  });
});
