// v25: реакции на сообщения — каналы сервера и ЛС. Сокеты: reaction:add / reaction:remove → message:reactions
// всем, кто видит канал; права (видеть + писать; снять свою — достаточно видеть), лимиты, сохранение в истории.
// UI: пилюли под сообщением, панель действий и меню сообщения, подсказка с именами, живое обновление, мобильная ширина.
import {
  test, expect, twoUsersOneServer, openTextChannel, sendMessageUI, messageWith, noHorizontalScroll, loginViaToken,
} from './fixtures/ui.js';
import { makeUser, createServer, textChannel, ack, waitEvent, http } from './fixtures/api.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

const P = { SEND_MESSAGES: 1 << 8, VIEW_CHANNEL: 1 << 7 };

async function ok(socket, event, payload) {
  const r = await ack(socket, event, payload);
  expect(r.ok, `${event}: ${JSON.stringify(r)}`).toBe(true);
  return r;
}
async function denied(socket, event, payload, re) {
  const r = await ack(socket, event, payload);
  expect(r.ok, `${event} должен быть отклонён: ${JSON.stringify(r)}`).toBe(false);
  if (re) expect(r.error).toMatch(re);
  return r;
}

/** Владелец + n участников на одном сервере (через сокеты) */
async function group(n = 1, prefix = 'rx') {
  const owner = await makeUser(`${prefix}o`); socks.push(owner.socket);
  const srv = await createServer(owner, 'Реакции');
  const members = [];
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`${prefix}${i}`); socks.push(u.socket);
    await ok(u.socket, 'server:join', { inviteCode: srv.inviteCode });
    members.push(u);
  }
  return { owner, srv, ch: textChannel(srv), members };
}

const counts = (reactions) => Object.fromEntries((reactions || []).map((r) => [r.emoji, r.userIds.length]));

test.describe('v25: реакции — сервер', () => {
  test('поставить/снять, рассылка всем в канале, история, повтор не дублирует', async () => {
    const { owner, ch, members: [b] } = await group(1);
    const { message } = await ok(owner.socket, 'message:send', { channelId: ch.id, content: 'оцените' });
    const ids = { channelId: ch.id, messageId: message.id };

    const live = waitEvent(b.socket, 'message:reactions', (p) => p.messageId === message.id && counts(p.reactions)['👍'] === 1);
    const r1 = await ok(owner.socket, 'reaction:add', { ...ids, emoji: '👍' });
    expect(r1.reactions).toEqual([{ emoji: '👍', userIds: [owner.user.id] }]);
    expect((await live).channelId).toBe(ch.id);

    // повтор — без изменений; второй пользователь и второй эмодзи
    expect((await ok(owner.socket, 'reaction:add', { ...ids, emoji: '👍' })).reactions[0].userIds).toHaveLength(1);
    await ok(b.socket, 'reaction:add', { ...ids, emoji: '👍' });
    const r2 = await ok(b.socket, 'reaction:add', { ...ids, emoji: '❤️' });
    expect(counts(r2.reactions)).toEqual({ '👍': 2, '❤️': 1 });
    expect(r2.reactions.map((r) => r.emoji)).toEqual(['👍', '❤️']); // порядок появления

    // история (и bootstrap-история после переподключения) отдаёт реакции
    const hist = await ok(b.socket, 'message:history', { channelId: ch.id });
    expect(counts(hist.messages.find((m) => m.id === message.id).reactions)).toEqual({ '👍': 2, '❤️': 1 });

    // снять: у владельца остаётся только ❤️ от B, пустая реакция исчезает
    const gone = waitEvent(owner.socket, 'message:reactions', (p) => p.messageId === message.id && !counts(p.reactions)['❤️']);
    await ok(b.socket, 'reaction:remove', { ...ids, emoji: '❤️' });
    expect(counts((await gone).reactions)).toEqual({ '👍': 2 });
    await ok(b.socket, 'reaction:remove', { ...ids, emoji: '❤️' }); // повторное снятие — без ошибки
    await ok(b.socket, 'reaction:remove', { ...ids, emoji: '👍' });
    const last = await ok(owner.socket, 'reaction:remove', { ...ids, emoji: '👍' });
    expect(last.reactions).toEqual([]);
    const hist2 = await ok(owner.socket, 'message:history', { channelId: ch.id });
    expect(hist2.messages.find((m) => m.id === message.id).reactions).toBeUndefined();
  });

  test('валидация эмодзи, лимит 20 разных реакций, несуществующее/удалённое сообщение', async () => {
    const { owner, ch } = await group(0, 'rv');
    const { message } = await ok(owner.socket, 'message:send', { channelId: ch.id, content: 'лимиты' });
    const ids = { channelId: ch.id, messageId: message.id };
    for (const bad of ['a', '1', 'привет', '<b>', '👍👍', '', ' ', '👍x', 'x'.repeat(40), 42, null, { e: '👍' }]) {
      await denied(owner.socket, 'reaction:add', { ...ids, emoji: bad }, /эмодзи/);
    }
    // сложные эмодзи — одна графема
    for (const good of ['👨‍👩‍👧‍👦', '🇷🇺', '1️⃣', '👍🏽']) await ok(owner.socket, 'reaction:add', { ...ids, emoji: good });

    const many = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙'];
    let res = null;
    for (const e of many.slice(0, 16)) res = await ok(owner.socket, 'reaction:add', { ...ids, emoji: e });
    expect(res.reactions).toHaveLength(20);
    await denied(owner.socket, 'reaction:add', { ...ids, emoji: many[16] }, /20 разных реакций/);
    // к существующему эмодзи присоединиться можно и при лимите
    const b = await makeUser('rvb'); socks.push(b.socket);
    await ok(b.socket, 'server:join', { inviteCode: (await ok(owner.socket, 'bootstrap')).servers[0].inviteCode });
    await ok(b.socket, 'reaction:add', { ...ids, emoji: '😀' });

    await denied(owner.socket, 'reaction:add', { channelId: ch.id, messageId: 'нет-такого', emoji: '👍' }, /Сообщение не найдено/);
    await denied(owner.socket, 'reaction:add', { channelId: ch.id, emoji: '👍' }, /Сообщение не найдено/);

    // удаление сообщения удаляет и реакции
    await ok(owner.socket, 'message:delete', { messageId: message.id });
    await denied(owner.socket, 'reaction:add', { ...ids, emoji: '👍' }, /Сообщение не найдено/);
    const hist = await ok(owner.socket, 'message:history', { channelId: ch.id });
    expect(hist.messages.some((m) => m.id === message.id)).toBe(false);
  });

  test('ограничение частоты: не больше 30 реакций за 10 секунд на пользователя', async () => {
    const { owner, ch } = await group(0, 'rr');
    const { message } = await ok(owner.socket, 'message:send', { channelId: ch.id, content: 'спам' });
    const ids = { channelId: ch.id, messageId: message.id };
    let failed = null;
    for (let i = 0; i < 40 && !failed; i++) {
      const r = await ack(owner.socket, i % 2 ? 'reaction:remove' : 'reaction:add', { ...ids, emoji: '🔥' });
      if (!r.ok) failed = { i, error: r.error };
    }
    expect(failed, 'лимит сработал').not.toBeNull();
    expect(failed.i).toBe(30);
    expect(failed.error).toMatch(/Слишком много реакций/);
  });

  test('права: чужой сервер, скрытый канал, канал без права писать (снять свою — можно)', async () => {
    const { owner, srv, ch, members: [b] } = await group(1, 'rp');
    const stranger = await makeUser('rps'); socks.push(stranger.socket);
    const { message } = await ok(owner.socket, 'message:send', { channelId: ch.id, content: 'для своих' });
    const ids = { channelId: ch.id, messageId: message.id };
    // не участник сервера не узнаёт даже о существовании канала, и ничего не получает
    let leaked = false;
    stranger.socket.on('message:reactions', () => { leaked = true; });
    await denied(stranger.socket, 'reaction:add', { ...ids, emoji: '👍' }, /Канал не найден/);
    await denied(stranger.socket, 'reaction:remove', { ...ids, emoji: '👍' }, /Канал не найден/);
    // нельзя подставить сообщение из другого канала через «свой» channelId
    const strangerSrv = await createServer(stranger, 'Чужой');
    await denied(stranger.socket, 'reaction:add', { channelId: textChannel(strangerSrv).id, messageId: message.id, emoji: '👍' }, /Сообщение не найдено/);

    // скрытый канал: B его не видит → отказ и никаких рассылок B
    const secret = (await ok(owner.socket, 'channel:create', { serverId: srv.id, name: 'секрет', type: 'text' })).channel;
    await ok(owner.socket, 'channel:update', { channelId: secret.id, overwrites: { [srv.id]: { allow: 0, deny: P.VIEW_CHANNEL } } });
    const hidden = (await ok(owner.socket, 'message:send', { channelId: secret.id, content: 'тсс' })).message;
    let bGotSecret = false;
    b.socket.on('message:reactions', (p) => { if (p.channelId === secret.id) bGotSecret = true; });
    await denied(b.socket, 'reaction:add', { channelId: secret.id, messageId: hidden.id, emoji: '👍' }, /Нет доступа/);
    await ok(owner.socket, 'reaction:add', { channelId: secret.id, messageId: hidden.id, emoji: '🤫' });

    // B ставит реакцию, потом у @everyone забирают право писать: поставить нельзя, снять свою — можно
    await ok(b.socket, 'reaction:add', { ...ids, emoji: '👍' });
    await ok(owner.socket, 'channel:update', { channelId: ch.id, overwrites: { [srv.id]: { allow: 0, deny: P.SEND_MESSAGES } } });
    await denied(b.socket, 'reaction:add', { ...ids, emoji: '😮' }, /Нет права писать/);
    const r = await ok(b.socket, 'reaction:remove', { ...ids, emoji: '👍' });
    expect(r.reactions).toEqual([]);
    await new Promise((res) => setTimeout(res, 300));
    expect(leaked, 'постороннему ничего не пришло').toBe(false);
    expect(bGotSecret, 'B не получил реакции скрытого канала').toBe(false);
  });

  test('ЛС: реакции видят оба, посторонний — отказ, без общего сервера — только снять свою', async () => {
    const { owner: a, srv, members: [b] } = await group(1, 'rd');
    const stranger = await makeUser('rds'); socks.push(stranger.socket);
    const dm = (await ok(a.socket, 'dm:open', { userId: b.user.id })).dm;
    const { message } = await ok(a.socket, 'message:send', { channelId: dm.id, content: 'лично' });
    const ids = { channelId: dm.id, messageId: message.id };

    const atA = waitEvent(a.socket, 'message:reactions', (p) => p.messageId === message.id && counts(p.reactions)['😂'] === 1);
    await ok(b.socket, 'reaction:add', { ...ids, emoji: '😂' });
    expect((await atA).channelId).toBe(dm.id);
    const hist = await ok(b.socket, 'message:history', { channelId: dm.id });
    expect(hist.messages[0].reactions).toEqual([{ emoji: '😂', userIds: [b.user.id] }]);

    await denied(stranger.socket, 'reaction:add', { ...ids, emoji: '👍' }, /Канал не найден|Чат не найден/);

    // B уходит с единственного общего сервера: писать (и ставить реакции) в ЛС больше нельзя
    await ok(b.socket, 'server:leave', { serverId: srv.id });
    await denied(b.socket, 'reaction:add', { ...ids, emoji: '👍' }, /общий сервер/);
    expect((await ok(b.socket, 'reaction:remove', { ...ids, emoji: '😂' })).reactions).toEqual([]);
  });
});

test.describe('v25: реакции — интерфейс', () => {
  test('панель действий → пикер, пилюля у другого вживую, клик по чужой, подсказка с именами, снять, после перезагрузки', async ({ makePage }) => {
    const { pa, pb, ua, ub } = await twoUsersOneServer(makePage, 'Реакции UI');
    await openTextChannel(pa); await openTextChannel(pb);
    await sendMessageUI(pa, 'Как вам идея?');
    const msgA = messageWith(pa, 'Как вам идея?');
    const msgB = messageWith(pb, 'Как вам идея?');
    await expect(msgB).toHaveCount(1);

    // A: наведение → «Добавить реакцию» → 👍
    await msgA.hover();
    await msgA.locator('.message__react').click();
    const picker = pa.locator('.reaction-picker');
    await expect(picker).toBeVisible();
    await pa.screenshot({ path: 'tests/.results/v25-reactions-picker.png', animations: 'disabled' });
    await picker.locator('[data-pick-emoji="👍"]').first().click();
    await expect(picker).toHaveCount(0);
    const pillA = msgA.locator('.reaction[data-reaction="👍"]');
    await expect(pillA).toHaveClass(/is-mine/);
    await expect(pillA.locator('.reaction__count')).toHaveText('1');

    // B видит без перезагрузки, его пилюля не подсвечена; кликает — 2 у обоих
    const pillB = msgB.locator('.reaction[data-reaction="👍"]');
    await expect(pillB.locator('.reaction__count')).toHaveText('1');
    await expect(pillB).not.toHaveClass(/is-mine/);
    await expect(pillB).toHaveAttribute('aria-pressed', 'false');
    await pillB.click();
    await expect(pillB).toHaveClass(/is-mine/);
    await expect(pillA.locator('.reaction__count')).toHaveText('2');

    // подсказка с именами
    await pillA.hover();
    const tip = pa.locator('.reaction-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Вы');
    await expect(tip).toContainText(ub.username);
    await expect(tip).toContainText('👍');
    await pa.screenshot({ path: 'tests/.results/v25-reactions-desktop.png' });

    // недавние в localStorage → первыми в пикере
    expect(await pa.evaluate(() => JSON.parse(localStorage.getItem('sozvon.reactions.recent')))).toEqual(['👍']);

    // A снимает свою: у B — 1 и своя подсветка остаётся
    await pillA.click();
    await expect(pillA).not.toHaveClass(/is-mine/);
    await expect(pillB.locator('.reaction__count')).toHaveText('1');
    await expect(pillB).toHaveClass(/is-mine/);

    // сохранилось после перезагрузки
    await pa.reload();
    await expect(pa.locator('#app')).toBeVisible();
    await openTextChannel(pa);
    await expect(msgA.locator('.reaction[data-reaction="👍"] .reaction__count')).toHaveText('1');
    await expect(msgA.locator('.reaction[data-reaction="👍"]')).not.toHaveClass(/is-mine/);
    expect(ua.username).toBeTruthy();
  });

  test('меню сообщения по правому клику: быстрая реакция, «Добавить реакцию», удаление своего', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Меню сообщения');
    await openTextChannel(pa); await openTextChannel(pb);
    await sendMessageUI(pb, 'правый клик сюда');
    const msgA = messageWith(pa, 'правый клик сюда');
    await msgA.locator('.message__content').click({ button: 'right' });
    const menu = pa.locator('.message-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-action="copy"]')).toHaveCount(1);
    await menu.locator('.reaction-quick__btn').first().click();
    await expect(menu).toHaveCount(0);
    await expect(msgA.locator('.reaction.is-mine')).toHaveCount(1);
    await expect(messageWith(pb, 'правый клик сюда').locator('.reaction')).toHaveCount(2); // пилюля + «добавить»

    // «Добавить реакцию» из меню открывает пикер; Escape закрывает
    await msgA.locator('.message__content').click({ button: 'right' });
    await menu.locator('[data-action="react"]').click();
    await expect(pa.locator('.reaction-picker')).toBeVisible();
    await pa.keyboard.press('Escape');
    await expect(pa.locator('.reaction-picker')).toHaveCount(0);

    // правый клик по нику — по-прежнему меню участника
    await msgA.locator('.message__author').click({ button: 'right' });
    await expect(pa.locator('.context-menu:not(.message-menu)')).toBeVisible();
    await pa.keyboard.press('Escape');

    // своё сообщение B удаляет из меню — реакции уходят вместе с ним
    const msgB = messageWith(pb, 'правый клик сюда');
    await msgB.locator('.message__content').click({ button: 'right' });
    await pb.locator('.message-menu [data-action="delete"]').click();
    await expect(messageWith(pa, 'правый клик сюда')).toHaveCount(0);
  });

  test('ЛС: реакция в личной переписке видна собеседнику вживую', async ({ makePage }) => {
    const { pa, pb, ub } = await twoUsersOneServer(makePage, 'ЛС реакции');
    const bId = (await http('GET', '/api/me', { token: ub.token })).json.user.id;
    const dmId = await pa.evaluate(async (userId) => {
      const { emitAck } = await import('/js/socket.js');
      return (await emitAck('dm:open', { userId })).dm.id;
    }, bId);
    await pa.goto(`/?c=${dmId}`);
    await expect(pa.locator('#composer-input')).toBeVisible();
    await sendMessageUI(pa, 'привет лично');
    await pb.goto(`/?c=${dmId}`);
    const msgB = messageWith(pb, 'привет лично');
    await expect(msgB).toHaveCount(1);
    await msgB.hover();
    await msgB.locator('.message__react').click();
    await pb.locator('.reaction-picker [data-pick-emoji="❤️"]').first().click();
    await expect(messageWith(pa, 'привет лично').locator('.reaction[data-reaction="❤️"] .reaction__count')).toHaveText('1');
  });

  test('нет права писать: кнопки реакции нет, чужую пилюлю не нажать', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Только чтение');
    await openTextChannel(pa); await openTextChannel(pb);
    await sendMessageUI(pa, 'объявление');
    const msgA = messageWith(pa, 'объявление');
    await msgA.hover();
    await msgA.locator('.message__react').click();
    await pa.locator('.reaction-picker [data-pick-emoji="🎉"]').first().click();
    const msgB = messageWith(pb, 'объявление');
    await expect(msgB.locator('.reaction[data-reaction="🎉"]')).toHaveCount(1);
    // A (владелец) запрещает @everyone писать в канале
    await pa.evaluate(async () => {
      const { emitAck } = await import('/js/socket.js');
      const st = window.__sozvon.state;
      const srv = st.servers.find((s) => s.channels.some((c) => c.id === st.currentChannelId));
      await emitAck('channel:update', { channelId: st.currentChannelId, overwrites: { [srv.id]: { allow: 0, deny: 1 << 8 } } });
    });
    await expect(pb.locator('#composer-input')).toBeDisabled();
    await msgB.hover();
    await expect(msgB.locator('.message__react')).toHaveCount(0);
    await expect(msgB.locator('.reaction--add')).toHaveCount(0);
    await expect(msgB.locator('.reaction[data-reaction="🎉"]')).toHaveAttribute('aria-disabled', 'true');
    await msgB.locator('.reaction[data-reaction="🎉"]').click({ force: true }); // aria-disabled — Playwright сам не кликает
    await expect(pb.locator('.toast').filter({ hasText: 'нельзя ставить реакции' })).toBeVisible();
    await expect(msgB.locator('.reaction[data-reaction="🎉"] .reaction__count')).toHaveText('1');
  });

  test('мобильная ширина 390px: пилюли и пикер помещаются, нет горизонтальной прокрутки; светлая тема', async ({ makePage }) => {
    const p = await makePage({ name: 'M', viewport: { width: 390, height: 844 }, context: { hasTouch: true, isMobile: true } });
    await loginViaToken(p, 'mob');
    const srvName = 'Моб реакции';
    await p.evaluate(async (name) => { const { emitAck } = await import('/js/socket.js'); await emitAck('server:create', { name }); }, srvName);
    await p.reload();
    await expect(p.locator('#app')).toBeVisible();
    const chId = await p.evaluate((name) => window.__sozvon.state.servers.find((s) => s.name === name).channels.find((c) => c.type === 'text').id, srvName);
    await p.goto(`/?c=${chId}`);
    await expect(p.locator('#composer-input')).toBeVisible();
    await sendMessageUI(p, 'мобильное сообщение');
    const msg = messageWith(p, 'мобильное сообщение');
    // реакции через сокет (несколько), затем пикер из пилюли «добавить»
    await p.evaluate(async ({ chId }) => {
      const { emitAck } = await import('/js/socket.js');
      const st = window.__sozvon.state;
      const m = st.messages[chId].at(-1);
      for (const emoji of ['👍', '❤️', '😂', '🔥', '🎉', '👀', '🙏', '💯', '🤔', '😎']) await emitAck('reaction:add', { channelId: chId, messageId: m.id, emoji });
    }, { chId });
    await expect(msg.locator('.reaction:not(.reaction--add)')).toHaveCount(10);
    expect((await noHorizontalScroll(p)).ok).toBe(true);
    await msg.locator('.reaction--add').tap();
    const picker = p.locator('.reaction-picker');
    await expect(picker).toBeVisible();
    const box = await picker.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await picker.locator('[data-pick-emoji="🚀"]').first().tap();
    await expect(msg.locator('.reaction[data-reaction="🚀"].is-mine')).toHaveCount(1);
    expect((await noHorizontalScroll(p)).ok).toBe(true);

    // светлая тема: пилюля «моя» использует переменные темы (не тёмный фон)
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    const bg = await msg.locator('.reaction.is-mine').first().evaluate((el) => getComputedStyle(el).color);
    expect(bg).toBe('rgb(74, 38, 214)'); // --accent-text светлой темы
    await p.screenshot({ path: 'tests/.results/v25-reactions-mobile.png' });
  });
});
