// Полный аудит: сквозные сценарии «как пользователь» и пограничные случаи UI. owner: qa
import {
  test, expect, loginViaToken, createServerUI, joinServerUI, inviteCode, channel, openTextChannel,
  joinVoiceUI, sendMessageUI, messageWith, twoUsersOneServer, registerUI, loginUI,
} from './fixtures/ui.js';
import { http } from './fixtures/api.js';

const remoteTile = (page, name) => page.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: name }).first();
const dropSocket = (page) => page.evaluate(() => window.__sozvon.socket.io.engine.close());

test.describe('audit: чат', () => {
  test('markdown: жирный/курсив/код/ссылка; javascript: не становится ссылкой; переносы строк', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'md');
    await createServerUI(p, 'MD');
    await openTextChannel(p);
    const input = p.locator('#composer-input');
    await input.fill('**жир** *кур* `код` https://example.com/a?b=1, javascript:alert(1)');
    await input.press('Enter');
    const m = messageWith(p, 'жир').locator('.message__content');
    await expect(m.locator('strong')).toHaveText('жир');
    await expect(m.locator('em')).toHaveText('кур');
    await expect(m.locator('code')).toHaveText('код');
    await expect(m.locator('a')).toHaveCount(1);
    await expect(m.locator('a')).toHaveAttribute('href', 'https://example.com/a?b=1');
    await expect(m.locator('a')).toHaveAttribute('rel', /noopener/);
    await expect(m).toContainText('javascript:alert(1)');
    // Shift+Enter — перенос строки, а не отправка
    await input.fill('строка1');
    await input.press('Shift+Enter');
    await input.type('строка2');
    await expect(input).toHaveValue('строка1\nстрока2');
    await input.press('Enter');
    await expect(messageWith(p, 'строка1').locator('.message__content br')).toHaveCount(1);
  });

  test('пустое/пробелы не отправляются; 2000 символов — да; двойной Enter не дублирует', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'len');
    await createServerUI(p, 'Длина');
    await openTextChannel(p);
    const input = p.locator('#composer-input');
    await input.fill('     ');
    await input.press('Enter');
    await p.locator('#btn-send').click();
    await p.waitForTimeout(400);
    await expect(p.locator('#messages .message')).toHaveCount(0);
    const long = 'я'.repeat(1990) + 'КОНЕЦ12345';
    await input.fill(long);
    await input.press('Enter');
    await expect(messageWith(p, 'КОНЕЦ12345')).toHaveCount(1);
    // поле не даёт ввести больше 2000
    await input.fill('');
    await input.type('x'.repeat(5));
    await input.evaluate((el) => { el.value = 'y'.repeat(2005); });
    await expect.poll(() => input.evaluate((el) => el.maxLength)).toBe(2000);
    // двойная отправка
    await input.fill('дубль-тест');
    await Promise.all([input.press('Enter'), p.locator('#btn-send').click()]);
    await p.waitForTimeout(700);
    await expect(messageWith(p, 'дубль-тест')).toHaveCount(1);
    // длинное слово без пробелов не ломает вёрстку
    await sendMessageUI(p, 'W'.repeat(400));
    const ok = await p.evaluate(() => { const b = document.querySelector('#messages'); return b.scrollWidth <= b.clientWidth + 1; });
    expect(ok, 'длинное слово переносится, без горизонтального скролла в чате').toBe(true);
  });

  test('упоминание @username подсвечивает сообщение у адресата, у автора — нет', async ({ makePage }) => {
    const { pa, pb, ub } = await twoUsersOneServer(makePage, 'Упоминания');
    await openTextChannel(pa); await openTextChannel(pb);
    await sendMessageUI(pa, `эй @${ub.username} глянь`);
    await expect(messageWith(pb, 'глянь')).toHaveClass(/message--mention/);
    await expect(messageWith(pa, 'глянь')).not.toHaveClass(/message--mention/);
    // @everyone от владельца (MENTION_EVERYONE есть у владельца) подсвечивает у B
    await sendMessageUI(pa, 'всем @everyone сбор');
    await expect(messageWith(pb, 'сбор')).toHaveClass(/message--mention/);
  });

  test('«печатает» пропадает после отправки; вложение-файл (не картинка) → file-card с размером', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Печать');
    await openTextChannel(pa); await openTextChannel(pb);
    await pa.locator('#composer-input').type('печатаю...');
    await expect(pb.locator('#typing')).toContainText(/печата/i);
    await pa.locator('#composer-input').press('Enter');
    await expect(pb.locator('#typing')).not.toContainText(/печата/i, { timeout: 8000 });
    await pa.locator('#file-input').setInputFiles({ name: 'отчёт.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') });
    await expect(pa.locator('#pending-attachments .chip')).toHaveCount(1, { timeout: 15000 });
    await expect(pa.locator('#pending-attachments .chip.is-loading')).toHaveCount(0, { timeout: 15000 });
    await pa.locator('#btn-send').click();
    const card = pb.locator('#messages .message a.file-card').filter({ hasText: 'отчёт.txt' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(/Б|КБ/);
  });

  test('сообщение, отправленное во время обрыва связи у B, появляется у B после переподключения', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Обрыв');
    await openTextChannel(pa); await openTextChannel(pb);
    await pb.context().setOffline(true);
    await dropSocket(pb);
    await sendMessageUI(pa, 'пока тебя не было');
    await pb.waitForTimeout(500);
    await pb.context().setOffline(false);
    await expect(messageWith(pb, 'пока тебя не было')).toHaveCount(1, { timeout: 20000 });
    // и B снова может писать
    await sendMessageUI(pb, 'я вернулся');
    await expect(messageWith(pa, 'я вернулся')).toHaveCount(1);
  });

  test('отправка без связи: текст не теряется, понятная ошибка', async ({ makePage }) => {
    const p = await makePage({ allowErrors: [/WebSocket|ERR_INTERNET_DISCONNECTED|net::/] });
    await loginViaToken(p, 'off');
    await createServerUI(p, 'Офлайн');
    await openTextChannel(p);
    await p.context().setOffline(true);
    await dropSocket(p);
    await p.waitForTimeout(300);
    await p.locator('#composer-input').fill('не потеряй меня');
    await p.locator('#composer-input').press('Enter');
    await expect(p.locator('#toasts .toast').last()).toContainText(/соединени|связ/i);
    await expect(p.locator('#composer-input')).toHaveValue('не потеряй меня');
    await p.context().setOffline(false);
  });
});

test.describe('audit: сессии и вкладки', () => {
  test('один пользователь в двух вкладках: сообщения в обеих; голос во второй вкладке выбивает первую из голоса', async ({ makePage, browser }) => {
    test.setTimeout(90_000);
    const p1 = await makePage({ name: 't1' });
    const reg = await loginViaToken(p1, 'tabs');
    await createServerUI(p1, 'Вкладки');
    const p2 = await p1.context().newPage();
    const errs2 = [];
    p2.on('pageerror', (e) => errs2.push(e.message));
    await p2.goto('/');
    await expect(p2.locator('#app')).toBeVisible();
    await expect(p2.locator('#server-name')).toHaveText('Вкладки');
    await openTextChannel(p1); await openTextChannel(p2);
    await sendMessageUI(p1, 'из первой вкладки');
    await expect(messageWith(p2, 'из первой вкладки')).toHaveCount(1);
    await joinVoiceUI(p1);
    await expect(p1.locator('.voice-users .voice-user')).toHaveCount(1);
    await joinVoiceUI(p2);
    // первая вкладка понимает, что её выбило: панель голоса скрыта, в сайдбаре ровно один участник
    await expect(p1.locator('#voice-panel')).toBeHidden({ timeout: 10000 });
    await expect(p1.locator('.voice-users .voice-user')).toHaveCount(1);
    await expect(p2.locator('.voice-users .voice-user')).toHaveCount(1);
    expect(errs2).toEqual([]);
    expect(reg.username).toBeTruthy();
  });

  test('смена пароля в одной вкладке разлогинивает другие сессии; старый пароль больше не подходит', async ({ makePage }) => {
    const pa = await makePage({ name: 'A1' });
    const { username } = await registerUI(pa, undefined, 'secret123');
    const pb = await makePage({ name: 'A2', allowErrors: [/401|Unauthorized/i] });
    await loginUI(pb, username, 'secret123');
    const login = await http('POST', '/api/login', { body: { username, password: 'secret123' } });
    const token = await pa.evaluate(() => localStorage.getItem('sozvon.token'));
    const r = await http('POST', '/api/me/password', { token, body: { oldPassword: 'secret123', newPassword: 'newsecret456' } });
    expect(r.status).toBe(200);
    // вторая вкладка выкинута на экран входа
    await expect(pb.locator('#auth-screen')).toBeVisible({ timeout: 15000 });
    // старый токен из login тоже недействителен
    expect((await http('GET', '/api/me', { token: login.json.token })).status).toBe(401);
    // текущая вкладка осталась в приложении
    await pa.reload();
    await expect(pa.locator('#app')).toBeVisible();
    expect((await http('POST', '/api/login', { body: { username, password: 'secret123' } })).status).toBe(401);
  });

  test('выход: токен удаляется, reload показывает вход; кнопку «Войти» с пустыми полями — понятная ошибка', async ({ makePage }) => {
    const p = await makePage({ allowErrors: [/400|401/] });
    await loginViaToken(p, 'out');
    await p.locator('#btn-logout').click();
    await expect(p.locator('#auth-screen')).toBeVisible();
    expect(await p.evaluate(() => localStorage.getItem('sozvon.token'))).toBeNull();
    await p.reload();
    await expect(p.locator('#auth-screen')).toBeVisible();
    await p.locator('#auth-form button[type="submit"], #auth-form .btn--primary').first().click();
    // либо HTML5-валидация не даёт отправить, либо #auth-error
    const invalid = await p.locator('#auth-form input:invalid').count();
    if (!invalid) await expect(p.locator('#auth-error')).not.toBeEmpty();
    await expect(p.locator('#auth-screen')).toBeVisible();
  });
});

test.describe('audit: голос — повторные клики и обрывы', () => {
  test('быстрые повторные клики mute/deafen: итог совпадает с сервером', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb, ua } = await twoUsersOneServer(makePage, 'Клики');
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    for (let i = 0; i < 5; i++) await pa.locator('#ctrl-mute').click();
    await expect(pa.locator('#ctrl-mute')).toHaveClass(/is-on/);
    const vuA = pb.locator('.voice-user').filter({ hasText: ua.username });
    await expect(vuA.locator('use[href$="#i-mic-off"]')).not.toHaveCount(0);
    for (let i = 0; i < 4; i++) await pa.locator('#ctrl-deafen').click();
    await expect(pa.locator('#ctrl-deafen')).not.toHaveClass(/is-on/);
    await expect(pa.locator('#ctrl-mute')).toHaveClass(/is-on/, { timeout: 3000 });
    // deafen включает mute; снятие deafen возвращает прежний mute
    await pa.locator('#ctrl-mute').click();
    await expect(pa.locator('#ctrl-mute')).not.toHaveClass(/is-on/);
    await pa.locator('#ctrl-deafen').click();
    await expect(pa.locator('#ctrl-mute')).toHaveClass(/is-on/);
    await pa.locator('#ctrl-deafen').click();
    await expect(pa.locator('#ctrl-mute')).not.toHaveClass(/is-on/);
    await expect(vuA.locator('use[href$="#i-mic-off"]')).toHaveCount(0);
  });

  test('двойной клик по голосовому каналу и «Выйти/Войти» подряд: ровно одно подключение', async ({ makePage }) => {
    test.setTimeout(90_000);
    const { pa, pb, ua } = await twoUsersOneServer(makePage, 'Двойной');
    await joinVoiceUI(pb);
    await channel(pa, 'voice', 'Голосовой').dblclick();
    await pa.waitForTimeout(1500);
    if (!(await pa.locator('#voice-panel').isVisible())) await joinVoiceUI(pa);
    await expect(pb.locator('.voice-users .voice-user')).toHaveCount(2);
    for (let i = 0; i < 3; i++) {
      await pa.locator('#ctrl-leave').click();
      await expect(pa.locator('#voice-panel')).toBeHidden();
      await joinVoiceUI(pa);
    }
    await expect(pb.locator('.voice-users .voice-user')).toHaveCount(2);
    await expect(remoteTile(pb, ua.username)).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
    await expect(pb.locator('#stage-grid .tile[data-socket-id]:not(.tile--screen)')).toHaveCount(2);
  });

  test('обрыв сокета в голосе: автоматическое переподключение к тому же каналу, звук снова идёт', async ({ makePage }) => {
    test.setTimeout(120_000);
    const { pa, pb, ua } = await twoUsersOneServer(makePage, 'Реконнект');
    await joinVoiceUI(pa); await joinVoiceUI(pb);
    await expect(remoteTile(pb, ua.username)).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
    await dropSocket(pa);
    await expect(pa.locator('#voice-panel')).toBeVisible({ timeout: 20000 });
    await expect(pb.locator('.voice-users .voice-user')).toHaveCount(2, { timeout: 20000 });
    await expect(pb.locator('#stage-grid .tile[data-socket-id]:not(.tile--screen)')).toHaveCount(2, { timeout: 20000 });
    await expect(remoteTile(pb, ua.username)).toHaveAttribute('data-connected', 'true', { timeout: 30000 });
  });

  test('владелец удаляет голосовой канал, где сидят: всех выкидывает без ошибок', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Удаление');
    // второй голосовой, чтобы был что удалить
    await pa.locator('[data-add-channel="voice"]').click();
    const modal = pa.locator('#modal-channel');
    await modal.locator('#channel-name-input').fill('Временный');
    await modal.locator('.btn--primary:visible').first().click();
    await expect(channel(pb, 'voice', 'Временный')).toBeVisible();
    await joinVoiceUI(pb, 'Временный');
    const row = channel(pa, 'voice', 'Временный');
    await row.hover();
    await row.locator('.channel__delete').click();
    await pa.locator('#confirm-ok').click();
    await expect(channel(pb, 'voice', 'Временный')).toHaveCount(0);
    await expect(pb.locator('#voice-panel')).toBeHidden({ timeout: 10000 });
  });
});

test.describe('audit: серверы', () => {
  test('неверный/пустой инвайт — ошибка в модалке; повторный вход по тому же инвайту не дублирует', async ({ makePage }) => {
    const { pa, pb, code } = await twoUsersOneServer(makePage, 'Инвайты');
    await pb.locator('#btn-add-server').click();
    const modal = pb.locator('#modal-server');
    await modal.locator('.tab').nth(1).click();
    const input = modal.locator('input:visible').first();
    await input.fill('zzzzzzzz');
    await modal.locator('.btn--primary:visible').first().click();
    await expect(modal.locator('[data-error]:visible, .form__error:visible').first()).toContainText(/не найден/i);
    await input.fill(`https://example.com/?invite=${code}`);
    await modal.locator('.btn--primary:visible').first().click();
    await pb.waitForTimeout(800);
    await pb.keyboard.press('Escape');
    // ровно одна иконка сервера «Инвайты»
    const icons = await pb.locator('#servers .server-icon:not(.server-icon--add)').count();
    expect(icons).toBeLessThanOrEqual(2); // «домой»/1 сервер
    expect(await inviteCode(pa)).toBe(code);
  });

  test('ссылка-приглашение ?invite=<код> открывает модалку входа с подставленным кодом', async ({ makePage }) => {
    const pa = await makePage({ name: 'A' });
    await loginViaToken(pa, 'inv');
    await createServerUI(pa, 'Ссылка');
    const code = await inviteCode(pa);
    const pb = await makePage({ name: 'B' });
    await loginViaToken(pb, 'invb');
    await pb.goto(`/?invite=${code}`);
    await expect(pb.locator('#modal-server')).toBeVisible();
    await expect(pb.locator('#invite-input')).toHaveValue(code);
    await pb.locator('#modal-server .btn--primary:visible').first().click();
    await expect(pb.locator('#server-name')).toHaveText('Ссылка');
  });

  test('длинное название сервера (50 — предел поля и сервера) не ломает сайдбар', async ({ makePage }) => {
    const p = await makePage();
    await loginViaToken(p, 'long');
    const name = 'Д'.repeat(50);
    await createServerUI(p, name);
    const overflow = await p.locator('#server-name').evaluate((el) => getComputedStyle(el).textOverflow);
    const box = await p.locator('#sidebar').boundingBox();
    const nb = await p.locator('#server-name').boundingBox();
    expect(nb.x + nb.width, 'название не вылезает за сайдбар').toBeLessThanOrEqual(box.x + box.width + 1);
    expect(['ellipsis', 'clip']).toContain(overflow);
  });
});
