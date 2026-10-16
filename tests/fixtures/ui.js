// UI-хелперы и фикстуры Playwright (селекторы — строго SPEC §5)
import { test as base, expect } from '@playwright/test';
import { registerApi, uniqueName } from './api.js';

/** Фикстура: makePage() создаёт отдельный browser context (= отдельный "пользователь")
 *  и собирает ошибки консоли; после теста ошибки консоли фейлят тест (критерий 8). */
export const test = base.extend({
  makePage: async ({ browser }, use, testInfo) => {
    const created = [];
    async function makePage(opts = {}) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        permissions: ['microphone', 'camera'],
        viewport: opts.viewport || { width: 1440, height: 900 },
        ...(opts.context || {}),
      });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()} @ ${msg.location()?.url || ''}`); });
      page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
      page.qaErrors = errors;
      page.qaName = opts.name || `p${created.length + 1}`;
      created.push({ context, page, errors, allowErrors: opts.allowErrors });
      return page;
    }
    await use(makePage);
    const report = [];
    for (const c of created) {
      const errs = c.allowErrors ? c.errors.filter((e) => !c.allowErrors.some((re) => re.test(e))) : c.errors;
      if (errs.length) report.push(`${c.page.qaName}:\n  ${errs.join('\n  ')}`);
    }
    for (const c of created) await c.context.close().catch(() => {});
    if (report.length) {
      await testInfo.attach('console-errors', { body: report.join('\n'), contentType: 'text/plain' });
      throw new Error('Ошибки в консоли браузера (критерий 8):\n' + report.join('\n'));
    }
  },
});
export { expect };

export async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#auth-screen, #app').locator('visible=true').first()).toBeVisible();
}

async function authSubmitText(page) {
  return (await page.locator('#auth-form button[type="submit"], #auth-form .btn--primary').first().innerText()).trim();
}

export async function ensureAuthMode(page, mode /* 'register' | 'login' */) {
  await expect(page.locator('#auth-screen')).toBeVisible();
  const re = mode === 'register' ? /регистр|создать/i : /войти|вход/i;
  for (let i = 0; i < 2; i++) {
    if (re.test(await authSubmitText(page))) return;
    await page.locator('#auth-toggle').click();
  }
  expect(await authSubmitText(page), `кнопка формы в режиме ${mode}`).toMatch(re);
}

export async function fillAuth(page, username, password) {
  const u = page.locator('#auth-form input[name="username"], #auth-username').first();
  const p = page.locator('#auth-form input[name="password"], #auth-password').first();
  await u.fill(username);
  await p.fill(password);
  await page.locator('#auth-form button[type="submit"], #auth-form .btn--primary').first().click();
}

export async function registerUI(page, username = uniqueName('ui'), password = 'secret123') {
  await openApp(page);
  await ensureAuthMode(page, 'register');
  await fillAuth(page, username, password);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeHidden();
  return { username, password };
}

export async function loginUI(page, username, password) {
  await openApp(page);
  await ensureAuthMode(page, 'login');
  await fillAuth(page, username, password);
  await expect(page.locator('#app')).toBeVisible();
}

/** Быстрый вход: регистрация через API + token в localStorage (sozvon.token). */
export async function loginViaToken(page, prefix = 'ui') {
  const reg = await registerApi(uniqueName(prefix));
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), reg.token);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  return reg;
}

const visibleIn = (root, sel) => root.locator(sel).locator('visible=true');

export async function createServerUI(page, name) {
  await page.locator('#btn-add-server').click();
  const modal = page.locator('#modal-server');
  await expect(modal).toBeVisible();
  const tabs = modal.locator('.tab');
  if (await tabs.count()) await tabs.first().click();
  await visibleIn(modal, 'input:not([type=hidden]):not([type=file])').first().fill(name);
  await visibleIn(modal, '.btn--primary').first().click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#server-name')).toHaveText(name);
}

export async function joinServerUI(page, inviteCode, expectedName) {
  await page.locator('#btn-add-server').click();
  const modal = page.locator('#modal-server');
  await expect(modal).toBeVisible();
  await modal.locator('.tab').nth(1).click();
  await visibleIn(modal, 'input:not([type=hidden]):not([type=file])').first().fill(inviteCode);
  await visibleIn(modal, '.btn--primary').first().click();
  await expect(modal).toBeHidden();
  if (expectedName) await expect(page.locator('#server-name')).toHaveText(expectedName);
}

export async function inviteCode(page) {
  const code = (await page.locator('#invite-code').innerText()).trim();
  expect(code).toMatch(/^[a-z0-9]{8}$/);
  return code;
}

export function channel(page, type, name) {
  let loc = page.locator(`a.channel[data-type="${type}"]`);
  if (name) loc = loc.filter({ has: page.locator('.channel__name', { hasText: name }) });
  return loc.first();
}

export async function openTextChannel(page, name = 'общий') {
  await channel(page, 'text', name).click();
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(page.locator('#composer-input')).toBeVisible();
}

export async function joinVoiceUI(page, name = 'Голосовой') {
  await channel(page, 'voice', name).click();
  const join = page.locator('#voice-join');
  // Клик по каналу либо сразу подключает, либо показывает «Подключиться»
  await page.waitForTimeout(300);
  // #voice-panel живёт в сайдбаре: на мобиле он в закрытом выезжающем меню, поэтому «подключён» = панель не скрыта (hidden/display)
  const joined = () => page.locator('#voice-panel').evaluate((el) => !el.hidden && getComputedStyle(el).display !== 'none').catch(() => false);
  for (let i = 0; i < 3 && !(await joined()); i++) {
    if (!(await join.isVisible())) { await page.waitForTimeout(300); continue; }
    const btn = join.locator('button');
    // кнопка может исчезнуть, если подключение уже идёт — не ждём её бесконечно
    if (await btn.count()) await btn.first().click({ timeout: 3000 }).catch(() => {});
    else await join.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  if (await page.locator('#btn-menu').isVisible() && !(await page.locator('#app.is-nav-open').count())) {
    await expect.poll(joined, { message: '#voice-panel не скрыт (мобильный)' }).toBe(true);
  } else {
    await expect(page.locator('#voice-panel')).toBeVisible();
  }
  await expect(page.locator('#voice-view')).toBeVisible();
}

export async function sendMessageUI(page, text) {
  const input = page.locator('#composer-input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

export function messageWith(page, text) {
  return page.locator('#messages .message').filter({ has: page.locator('.message__content', { hasText: text }) });
}

/** Два пользователя в одном сервере (A создаёт, B входит по инвайту через UI). */
export async function twoUsersOneServer(makePage, serverName = 'Созвон QA') {
  const pa = await makePage({ name: 'A' });
  const pb = await makePage({ name: 'B' });
  const ua = await loginViaToken(pa, 'ua');
  const ub = await loginViaToken(pb, 'ub');
  await createServerUI(pa, serverName);
  const code = await inviteCode(pa);
  await joinServerUI(pb, code, serverName);
  return { pa, pb, ua, ub, code };
}

export async function noHorizontalScroll(page) {
  return page.evaluate(() => {
    const d = document.documentElement; const b = document.body;
    return { doc: [d.scrollWidth, d.clientWidth], body: [b.scrollWidth, b.clientWidth], ok: d.scrollWidth <= d.clientWidth && b.scrollWidth <= b.clientWidth };
  });
}
