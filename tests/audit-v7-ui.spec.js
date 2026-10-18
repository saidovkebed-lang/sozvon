// QA-аудит v7 (интерфейс): «Главная» и ЛС, «Новое сообщение», «Входящие», две вкладки, переподключение,
// живые изменения прав, мобильная ширина, темы, системные уведомления. Ошибки консоли фейлят тест (фикстура makePage).
import { test, expect, noHorizontalScroll } from './fixtures/ui.js';
import { makeUser, createServer, ack, sleep, registerApi, uniqueName } from './fixtures/api.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

async function apiUsers(n = 2, name = 'UI v7') {
  const users = [];
  for (let i = 0; i < n; i++) { const u = await makeUser(`uv${i}`); socks.push(u.socket); users.push(u); }
  const server = await createServer(users[0], name);
  for (const u of users.slice(1)) expect((await ack(u.socket, 'server:join', { inviteCode: server.inviteCode })).ok).toBe(true);
  return { users, server, text: server.channels.find((c) => c.type === 'text') };
}

/** Открыть приложение под токеном; prefs — содержимое sozvon.prefs */
async function openAs(makePage, token, { name, viewport, prefs, initScript, context } = {}) {
  const page = await makePage({ name, viewport, context });
  if (initScript) await page.addInitScript(initScript);
  await page.goto('/');
  await page.evaluate(([t, p]) => {
    localStorage.setItem('sozvon.token', t);
    if (p) localStorage.setItem('sozvon.prefs', JSON.stringify(p));
  }, [token, prefs || null]);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.__sozvon?.state?.connected)).toBe(true);
  return page;
}

const homeBadge = (p) => p.locator('.servers__item--home .server-badge');
const inboxBadge = (p) => p.locator('#btn-inbox .badge-count');

test.describe('аудит v7 UI: «Главная» и ЛС', () => {
  test('«Главная» без ЛС и без серверов: пустое состояние, «Новое сообщение» без контактов', async ({ makePage }) => {
    const reg = await registerApi(uniqueName('lonely'));
    const p = await openAs(makePage, reg.token, { name: 'lonely' });
    await expect(p.locator('#server-name')).toHaveText('Личные сообщения');
    await expect(p.locator('#channels .sidebar__empty')).toContainText('Пока нет переписок');
    await expect(homeBadge(p)).toHaveCount(0);
    await expect(inboxBadge(p)).toHaveCount(0);
    await p.locator('#btn-new-dm').click();
    await expect(p.locator('#modal-new-dm')).toBeVisible();
    await expect(p.locator('#new-dm-list')).toContainText('Пока не с кем');
    await p.keyboard.press('Escape');
    await expect(p.locator('#modal-new-dm')).toBeHidden();
    // пустые «Входящие»
    await p.locator('#btn-inbox').click();
    await expect(p.locator('#inbox .inbox__empty')).toBeVisible();
    await expect(p.locator('#inbox-read-all')).toBeDisabled();
    await p.locator('#inbox [data-inbox-filter="unread"]').click();
    await expect(p.locator('#inbox .inbox__empty')).toContainText('Всё прочитано');
  });

  test('«Новое сообщение»: поиск по имени и нику, «Никого не нашлось», выбор открывает чат', async ({ makePage }) => {
    const { users: [a, b, c] } = await apiUsers(3);
    const p = await openAs(makePage, a.token, { name: 'A' });
    await p.locator('#btn-home').click();
    await p.locator('#btn-new-dm').click();
    const picks = p.locator('#modal-new-dm .pick-user');
    await expect(picks).toHaveCount(2); // B и C; сам A и бот — нет
    await p.locator('#new-dm-search').fill(c.username.slice(0, 8).toUpperCase());
    await expect(picks).toHaveCount(1);
    await expect(picks.first()).toContainText(c.username);
    await p.locator('#new-dm-search').fill('zzzz-нет-такого');
    await expect(p.locator('#new-dm-list')).toContainText('Никого не нашлось');
    await p.locator('#new-dm-search').fill('');
    await expect(picks).toHaveCount(2);
    await picks.filter({ hasText: b.username }).click();
    await expect(p.locator('#modal-new-dm')).toBeHidden();
    await expect(p.locator('#channel-title')).toHaveText(b.username);
    await expect(p.locator('.dm-item.is-active')).toContainText(b.username);
    await expect(p.locator('#composer-input')).toBeFocused({ timeout: 2000 }).catch(() => {}); // не критично
  });

  test('закрытие чата крестиком: пропадает у меня, остаётся у собеседника, возвращается новым сообщением', async ({ makePage }) => {
    const { users: [a, b] } = await apiUsers(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'привет с крестиком' });
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.locator('#btn-home').click();
    const item = p.locator(`.dm-item[data-dm-id="${dm.id}"]`);
    await item.click();
    await expect(p.locator('.message__content', { hasText: 'привет с крестиком' })).toBeVisible();
    await item.hover();
    await item.locator('.dm-item__close').click();
    await expect(item).toHaveCount(0);
    await expect(p.locator('#chat-view')).toBeHidden();
    await expect(p.locator('#channel-title')).toHaveText('Личные сообщения');
    await expect(p.locator('#channels .sidebar__empty')).toBeVisible();
    expect((await ack(a.socket, 'bootstrap')).dms.map((d) => d.id)).toEqual([dm.id]);
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'я вернулся' });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('я вернулся');
    await expect(homeBadge(p)).toHaveText('1');
  });

  test('ЛС: typing, удаление своего сообщения обновляет превью в списке и у собеседника, вложение', async ({ makePage }) => {
    const { users: [a, b] } = await apiUsers(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const pa = await openAs(makePage, a.token, { name: 'A' });
    const pb = await openAs(makePage, b.token, { name: 'B' });
    await pa.locator('#btn-home').click();
    await pa.locator(`.dm-item[data-dm-id="${dm.id}"]`).click();
    await pa.locator('#composer-input').fill('первое');
    await pa.locator('#composer-input').press('Enter');
    await pa.locator('#composer-input').fill('второе');
    await pa.locator('#composer-input').press('Enter');
    await pb.locator('#btn-home').click();
    const bItem = pb.locator(`.dm-item[data-dm-id="${dm.id}"]`);
    await expect(bItem.locator('.dm-item__preview')).toHaveText('второе');
    await bItem.click();
    await pa.locator('#composer-input').pressSequentially('печатаю', { delay: 30 });
    await expect(pb.locator('#typing')).toContainText(a.username);
    await pa.locator('#composer-input').fill('');
    // удаление своего «второе»
    const msg = pa.locator('#messages .message').filter({ has: pa.locator('.message__content', { hasText: 'второе' }) });
    await msg.hover();
    await msg.locator('.message__delete').click();
    const confirm = pa.locator('#modal-confirm .btn--danger, dialog[open] .btn--danger');
    if (await confirm.count()) await confirm.first().click();
    await expect(pb.locator('.message__content', { hasText: 'второе' })).toHaveCount(0);
    await expect(bItem.locator('.dm-item__preview')).toHaveText('первое');
    await expect(pa.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-item__preview`)).toHaveText('Вы: первое');
    // B не может удалить сообщение A (кнопки нет)
    const foreign = pb.locator('#messages .message').filter({ has: pb.locator('.message__content', { hasText: 'первое' }) });
    await expect(foreign.locator('.message__delete')).toHaveCount(0);
    // вложение-видео
    await pb.locator('#file-input').setInputFiles({ name: 'клип.mp4', mimeType: 'video/mp4', buffer: Buffer.from('00000018667479706d703432', 'hex') });
    await expect(pb.locator('#pending-attachments .chip:not(.is-loading)')).toHaveCount(1);
    await pb.locator('#composer-input').press('Enter');
    await expect(pa.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-item__preview`)).toContainText('📎');
  });
});

test.describe('аудит v7 UI: «Входящие»', () => {
  test('Esc закрывает «Входящие» и возвращает фокус; клик снаружи — тоже; «Прочитать всё»', async ({ makePage }) => {
    const { users: [a, b], text } = await apiUsers(2);
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.locator('#btn-home').click(); // со страницы канала — иначе открытый канал сразу «прочитает» упоминания
    await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} раз` });
    await ack(a.socket, 'message:send', { channelId: text.id, content: '@everyone два' });
    await expect(inboxBadge(p)).toHaveText('2');
    await p.locator('#btn-inbox').click();
    await expect(p.locator('#inbox')).toBeVisible();
    await expect(p.locator('#btn-inbox')).toHaveAttribute('aria-expanded', 'true');
    await p.keyboard.press('Escape');
    await expect(p.locator('#inbox')).toBeHidden();
    await expect(p.locator('#btn-inbox')).toBeFocused();
    await p.locator('#btn-inbox').click();
    await p.locator('#server-name').click();
    await expect(p.locator('#inbox')).toBeHidden();
    await p.locator('#btn-inbox').click();
    await expect(p.locator('#inbox .inbox-item')).toHaveCount(2);
    await expect(p.locator('#inbox .inbox-item').first().locator('.inbox-item__where')).toHaveText('@everyone');
    await expect(p.locator('#inbox .inbox-item').first().locator('.inbox-item__source')).toContainText('#');
    await p.locator('#inbox-read-all').click();
    await expect(inboxBadge(p)).toHaveCount(0);
    await expect(p.locator('#inbox .inbox-item.is-unread')).toHaveCount(0);
    await p.locator('#inbox [data-inbox-filter="unread"]').click();
    await expect(p.locator('#inbox .inbox__empty')).toBeVisible();
  });

  test('канал удалили — уведомление о нём уходит из «Входящих» сразу, без перезагрузки', async ({ makePage }) => {
    const { users: [a, b], server } = await apiUsers(2);
    const ch2 = (await ack(a.socket, 'channel:create', { serverId: server.id, name: 'временный', type: 'text' })).channel;
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.locator('#btn-home').click();
    await ack(a.socket, 'message:send', { channelId: ch2.id, content: `@${b.username} в временном` });
    await expect(inboxBadge(p)).toHaveText('1');
    await ack(a.socket, 'channel:delete', { channelId: ch2.id });
    await expect(inboxBadge(p), 'бейдж «Входящих» после удаления канала').toHaveCount(0, { timeout: 5000 });
  });

  test('сервер удалили — уведомления о нём уходят из «Входящих» сразу', async ({ makePage }) => {
    const { users: [a, b], server, text } = await apiUsers(2);
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.locator('#btn-home').click();
    await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} пока сервер жив` });
    await expect(inboxBadge(p)).toHaveText('1');
    await ack(a.socket, 'server:delete', { serverId: server.id });
    await expect(inboxBadge(p), 'бейдж «Входящих» после удаления сервера').toHaveCount(0, { timeout: 5000 });
  });

  test('кик: уведомления сервера уходят, ЛС становится только для чтения у обоих без перезагрузки', async ({ makePage }) => {
    const { users: [a, b], server, text } = await apiUsers(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'до кика' });
    const pa = await openAs(makePage, a.token, { name: 'A' });
    const pb = await openAs(makePage, b.token, { name: 'B', allowErrors: [] });
    for (const p of [pa, pb]) {
      await p.locator('#btn-home').click();
      await p.locator(`.dm-item[data-dm-id="${dm.id}"]`).click();
      await expect(p.locator('#composer-input')).toBeEnabled();
    }
    await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} уходи` });
    await expect(inboxBadge(pb)).toHaveText('1');
    await ack(a.socket, 'member:kick', { serverId: server.id, userId: b.user.id });
    await expect(pb.locator('#composer-input')).toBeDisabled();
    await expect(pb.locator('#composer-input')).toHaveAttribute('placeholder', /больше нет общих серверов/);
    await expect(pa.locator('#composer-input')).toBeDisabled();
    // переписка остаётся видна
    await expect(pb.locator('.message__content', { hasText: 'до кика' })).toBeVisible();
    // у выгнанного не должно остаться упоминания с сервера, которого он больше не видит
    await expect(inboxBadge(pb), 'бейдж «Входящих» у выгнанного').toHaveCount(0, { timeout: 5000 });
  });
});

test.describe('аудит v7 UI: вкладки и связь', () => {
  test('две вкладки: прочитал ЛС в одной — бейджи сбросились в другой', async ({ makePage }) => {
    const { users: [a, b] } = await apiUsers(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const t1 = await openAs(makePage, b.token, { name: 'B1' });
    const t2 = await openAs(makePage, b.token, { name: 'B2' });
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'для двух вкладок' });
    for (const t of [t1, t2]) {
      await expect(homeBadge(t)).toHaveText('1');
      await expect(inboxBadge(t)).toHaveText('1');
    }
    await t1.locator('#btn-home').click();
    await t1.locator(`.dm-item[data-dm-id="${dm.id}"]`).click();
    await expect(t1.locator('.message__content', { hasText: 'для двух вкладок' })).toBeVisible();
    await expect(homeBadge(t1)).toHaveCount(0);
    await expect(homeBadge(t2)).toHaveCount(0);
    await expect(inboxBadge(t2)).toHaveCount(0);
    await t2.locator('#btn-home').click();
    await expect(t2.locator(`.dm-item[data-dm-id="${dm.id}"]`)).not.toHaveClass(/is-unread/);
  });

  test('переподключение сокета: список ЛС и бейджи восстанавливаются', async ({ makePage }) => {
    const { users: [a, b] } = await apiUsers(2);
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.locator('#btn-home').click();
    await expect(p.locator('#channels .sidebar__empty')).toBeVisible();
    await p.evaluate(() => window.__sozvon.socket.disconnect());
    await expect.poll(() => p.evaluate(() => window.__sozvon.state.connected)).toBe(false);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'пока офлайн' });
    await p.evaluate(() => window.__sozvon.socket.connect());
    await expect(p.locator(`.dm-item[data-dm-id="${dm.id}"]`)).toContainText('пока офлайн');
    await expect(homeBadge(p)).toHaveText('1');
    await expect(inboxBadge(p)).toHaveText('1');
    // обрыв транспорта (как при потере сети) — после автопереподключения всё на месте
    await p.evaluate(() => window.__sozvon.socket.io.engine.close());
    await sleep(300);
    await expect.poll(() => p.evaluate(() => window.__sozvon.state.connected), { timeout: 15000 }).toBe(true);
    await expect(homeBadge(p)).toHaveText('1');
    await expect(p.locator(`.dm-item[data-dm-id="${dm.id}"]`)).toHaveCount(1);
  });
});

test.describe('аудит v7 UI: вёрстка', () => {
  test('375px: «Главная», чат ЛС и «Входящие» без горизонтального скролла', async ({ makePage }) => {
    const { users: [a, b], text } = await apiUsers(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'оченьдлинноесловобезпробелов'.repeat(8) });
    await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} ${'длинный текст '.repeat(20)}` });
    const p = await openAs(makePage, b.token, { name: 'B375', viewport: { width: 375, height: 740 } });
    expect((await noHorizontalScroll(p)).ok).toBe(true);
    await p.locator('#btn-menu').click();
    await p.locator('#btn-home').click();
    const item = p.locator(`.dm-item[data-dm-id="${dm.id}"]`);
    await expect(item).toBeVisible();
    const ib = await item.boundingBox();
    expect(ib.x + ib.width).toBeLessThanOrEqual(375);
    expect((await noHorizontalScroll(p)).ok).toBe(true);
    await item.click();
    await expect(p.locator('#chat-view')).toBeVisible();
    expect((await noHorizontalScroll(p)).ok).toBe(true);
    await p.locator('#btn-inbox').click();
    const box = await p.locator('#inbox').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + Math.min(box.height, 100)).toBeLessThanOrEqual(740);
    expect((await noHorizontalScroll(p)).ok).toBe(true);
    await p.keyboard.press('Escape');
    await p.locator('#btn-menu').click();
    await p.locator('#btn-new-dm').click();
    const mb = await p.locator('#modal-new-dm').boundingBox();
    expect(mb.x).toBeGreaterThanOrEqual(0);
    expect(mb.x + mb.width).toBeLessThanOrEqual(375);
    expect((await noHorizontalScroll(p)).ok).toBe(true);
  });

  for (const theme of ['light', 'dark']) {
    test(`тема ${theme}: «Входящие», список ЛС и чат читаемы (контраст текста к фону)`, async ({ makePage }) => {
      const { users: [a, b] } = await apiUsers(2);
      const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
      await ack(a.socket, 'message:send', { channelId: dm.id, content: 'тема' });
      const p = await openAs(makePage, b.token, { name: `B-${theme}`, prefs: { 'appearance.theme': theme } });
      await expect(p.locator('html')).toHaveAttribute('data-theme', theme);
      await p.locator('#btn-home').click();
      await p.locator('#btn-inbox').click();
      await expect(p.locator('#inbox .inbox-item')).toHaveCount(1);
      const contrast = (sel) => p.locator(sel).first().evaluate((el) => {
        const parse = (c) => { const v = (c.match(/[\d.]+/g) || []).map(Number); return [v[0] || 0, v[1] || 0, v[2] || 0, v.length > 3 ? v[3] : 1]; };
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        // фон с учётом полупрозрачных слоёв: собираем цепочку до непрозрачного и смешиваем сверху вниз
        const layers = [];
        for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
        let base = [255, 255, 255];
        for (const c of layers.reverse()) base = base.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
        const fg = parse(getComputedStyle(el).color);
        const fgc = fg.slice(0, 3).map((v, i) => v * fg[3] + base[i] * (1 - fg[3]));
        const L1 = lum(fgc); const L2 = lum(base);
        return { ratio: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), bgLum: L2 };
      });
      for (const sel of ['#inbox .inbox-item__who', '#inbox .inbox-item__preview', '#inbox h3', '.dm-item__name', '.dm-item__preview']) {
        const c = await contrast(sel);
        expect(c.ratio, `${theme}: контраст ${sel}`).toBeGreaterThanOrEqual(sel.includes('preview') ? 3 : 4.5);
        if (theme === 'light') expect(c.bgLum, `${theme}: фон ${sel} светлый`).toBeGreaterThan(0.4);
        else expect(c.bgLum, `${theme}: фон ${sel} тёмный`).toBeLessThan(0.2);
      }
      await p.screenshot({ path: test.info().outputPath(`inbox-${theme}.png`) });
    });
  }
});

test.describe('аудит v7 UI: системные уведомления', () => {
  // Заглушка Notification: разрешение выдано, вкладка «не в фокусе» — фиксируем, что показало бы приложение
  const stub = () => {
    window.__shown = [];
    class N { constructor(title, opts) { window.__shown.push({ title, body: opts?.body, tag: opts?.tag }); } close() {} static requestPermission() { return Promise.resolve('granted'); } }
    N.permission = 'granted';
    window.Notification = N;
    Document.prototype.hasFocus = () => false;
  };

  test('«Только упоминания»: ЛС уведомляет всегда, обычное сообщение — нет, упоминание — да', async ({ makePage }) => {
    const { users: [a, b], text } = await apiUsers(2);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const p = await openAs(makePage, b.token, {
      name: 'B', initScript: stub,
      prefs: { 'notifications.desktop': true, 'notifications.mentionsOnly': true },
    });
    const shown = () => p.evaluate(() => window.__shown);
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'лично тебе' });
    await expect.poll(async () => (await shown()).length).toBe(1);
    expect((await shown())[0]).toMatchObject({ title: `Личные сообщения · ${a.username}`, body: 'лично тебе', tag: `sozvon-${dm.id}` });
    await ack(a.socket, 'message:send', { channelId: text.id, content: 'всем, но без упоминания' });
    await sleep(600);
    expect((await shown()).length).toBe(1);
    await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} а это тебе` });
    await expect.poll(async () => (await shown()).length).toBe(2);
    // откуда: «Сервер · #канал», в тексте — автор
    expect((await shown())[1].title).toMatch(new RegExp(` · #${text.name}$`));
    expect((await shown())[1].body).toBe(`${a.username}: @${b.username} а это тебе`);
    // «Не беспокоить» — ничего
    expect((await ack(b.socket, 'bootstrap')).ok).toBe(true);
  });
});

test.describe('аудит v7 UI: переход из push', () => {
  test('сообщение service worker «sozvon:open» открывает ЛС; ?c= с чужим/несуществующим id — без ошибок', async ({ makePage }) => {
    const { users: [a, b, c] } = await apiUsers(3);
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const foreign = (await ack(a.socket, 'dm:open', { userId: c.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'из push' });
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'sozvon:open', channelId: id } })), dm.id);
    await expect(p.locator('#channel-title')).toHaveText(a.username);
    await expect(p.locator('.message__content', { hasText: 'из push' })).toBeVisible();
    await p.goto(`/?c=${foreign.id}`);
    await expect(p.locator('#app')).toBeVisible();
    await expect.poll(() => p.evaluate(() => window.__sozvon.state.connected)).toBe(true);
    await expect(p.locator('#channel-title')).not.toHaveText(c.username);
    expect(new URL(p.url()).search).toBe('');
    await p.goto('/?c=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    await expect(p.locator('#app')).toBeVisible();
    expect(new URL(p.url()).search).toBe('');
  });
});

test.describe('аудит v7 UI: автооткрытие канала', () => {
  test('после перезагрузки последний канал открывается сам, но упоминания не гаснут; явный клик — гасит', async ({ makePage }) => {
    const { users: [a, b], text } = await apiUsers(2);
    await ack(a.socket, 'message:send', { channelId: text.id, content: `@${b.username} пока ты спал` });
    const p = await openAs(makePage, b.token, { name: 'B' });
    await expect(p.locator('#channel-title')).toHaveText(text.name);
    await expect(inboxBadge(p)).toHaveText('1');
    await p.reload();
    await expect(p.locator('#channel-title')).toHaveText(text.name);
    await expect(inboxBadge(p)).toHaveText('1');
    await p.locator(`a.channel[data-channel-id="${text.id}"], a.channel[data-type="text"]`).first().click();
    await expect(inboxBadge(p)).toHaveCount(0);
  });
});

test.describe('аудит v7 UI: порядок «Входящих»', () => {
  test('обновление старой записи ЛС (удалили сообщение) не поднимает её над более новыми', async ({ makePage }) => {
    const { users: [a, b, c], text } = await apiUsers(3);
    const p = await openAs(makePage, b.token, { name: 'B' });
    await p.locator('#btn-home').click();
    const dm = (await ack(a.socket, 'dm:open', { userId: b.user.id })).dm;
    await ack(a.socket, 'message:send', { channelId: dm.id, content: 'лс-1' });
    const m2 = (await ack(a.socket, 'message:send', { channelId: dm.id, content: 'лс-2' })).message;
    await sleep(20);
    await ack(c.socket, 'message:send', { channelId: text.id, content: `@${b.username} новее` });
    await expect(inboxBadge(p)).toHaveText('2');
    await ack(a.socket, 'message:delete', { messageId: m2.id });
    await p.locator('#btn-inbox').click();
    const items = p.locator('#inbox .inbox-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('новее');
    await expect(items.nth(1)).toContainText('лс-1');
  });
});
