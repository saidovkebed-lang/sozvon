// Личные сообщения: список чатов на «Главной», окно «Новое сообщение», бейдж непрочитанного у кнопки «Главная».
// Только переписка: текст, фото, видео и файлы — без звонков.
import { $, h, icon, avatar, displayName, fmtClock } from '../util.js';
import {
  state, subscribe, notify, getDm, upsertDm, dmWithUser, presenceOf, findUser, dmUnreadTotal,
} from '../state.js';
import { emitAck } from '../socket.js';
import { selectChannel, selectServer, markRead } from '../nav.js';
import { openModal, closeModal } from './modals.js';
import { toastError } from './toasts.js';
import { statusDot } from './members.js';

/** Открыть (или создать) ЛС с пользователем */
export async function openDmWith(userId) {
  if (!userId || userId === state.user?.id) return;
  const existing = dmWithUser(userId);
  if (existing) { selectChannel(existing.id); return; }
  try {
    const res = await emitAck('dm:open', { userId });
    if (res.dm) { upsertDm(res.dm); notify('dms'); selectChannel(res.dm.id); }
  } catch (e) { toastError(e); }
}

/** Можно ли написать пользователю (не я, не бот, есть общий сервер) */
export function canDmUser(u) {
  if (!u || !state.user || u.id === state.user.id || u.isBot) return false;
  return state.servers.some((s) => s.members?.some((m) => m.id === u.id));
}

function shortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtClock(ms);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function lastPreview(dm) {
  const m = dm.lastMessage;
  if (!m) return 'Нет сообщений';
  const mine = m.author?.id === state.user?.id ? 'Вы: ' : '';
  let t = (m.content || '').replace(/\s+/g, ' ').trim();
  if (!t && m.attachments?.length) {
    const a = m.attachments;
    t = `📎 ${a.every((x) => String(x.type).startsWith('image/')) ? 'Фото' : a.every((x) => String(x.type).startsWith('video/')) ? 'Видео' : 'Файл'}${a.length > 1 ? ` (${a.length})` : ''}`;
  }
  return mine + t;
}

function dmItem(dm) {
  const u = { ...dm.user, ...(findUser(dm.user?.id) || {}) };
  const active = dm.id === state.currentChannelId;
  const av = avatar(u, 'sm');
  av.append(statusDot(presenceOf(u)));
  const unread = dm.unread || 0;
  return h('a', {
    class: 'dm-item' + (active ? ' is-active' : '') + (unread ? ' is-unread' : ''),
    href: '#', dataset: { dmId: dm.id, userId: u.id || '' }, 'aria-current': active ? 'page' : null, title: displayName(u),
  }, av,
  h('span', { class: 'dm-item__text' },
    h('span', { class: 'dm-item__top' },
      h('span', { class: 'dm-item__name' }, displayName(u)),
      h('span', { class: 'dm-item__time' }, shortDate(dm.lastMessage?.createdAt || dm.lastAt))),
    h('span', { class: 'dm-item__preview' }, lastPreview(dm))),
  unread ? h('span', { class: 'badge-count', 'aria-label': `Непрочитанных: ${unread}` }, unread > 99 ? '99+' : String(unread)) : null,
  h('button', { type: 'button', class: 'icon-btn dm-item__close', title: 'Закрыть чат', 'aria-label': `Закрыть чат с ${displayName(u)}`, dataset: { closeDm: dm.id } }, icon('i-close', 'icon--sm')));
}

/** Содержимое сайдбара на «Главной» (вызывается из sidebar.js) */
export function renderDmSidebar(box) {
  const header = h('div', { class: 'channel-group__header' }, h('span', null, 'Личные сообщения'),
    h('button', { type: 'button', class: 'icon-btn', id: 'btn-new-dm', title: 'Новое сообщение', 'aria-label': 'Новое сообщение' }, icon('i-plus', 'icon--sm')));
  const list = state.dms.map(dmItem);
  box.replaceChildren(h('div', { class: 'channel-group dm-list' }, header,
    list.length ? list : h('p', { class: 'sidebar__empty' }, 'Пока нет переписок. Нажмите «+», чтобы написать участнику своего сервера.')));
}

function renderHomeBadge() {
  const btn = $('#btn-home');
  if (!btn) return;
  const n = dmUnreadTotal();
  let b = btn.parentElement.querySelector('.server-badge');
  if (!n) { b?.remove(); btn.setAttribute('aria-label', 'Главная: личные сообщения'); return; }
  if (!b) { b = h('span', { class: 'server-badge', 'aria-hidden': 'true' }); btn.parentElement.append(b); }
  b.textContent = n > 99 ? '99+' : String(n);
  btn.setAttribute('aria-label', `Главная: личные сообщения, непрочитанных ${n}`);
}

/* ---------- «Новое сообщение» ---------- */
let dlg = null;
function contacts() {
  const seen = new Map();
  for (const s of state.servers) {
    for (const m of s.members || []) {
      if (m.isBot || m.id === state.user?.id || seen.has(m.id)) continue;
      seen.set(m.id, { ...m, servers: [] });
    }
    for (const m of s.members || []) seen.get(m.id)?.servers.push(s.name);
  }
  return [...seen.values()].sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'));
}

function renderPicker() {
  const q = $('#new-dm-search').value.trim().toLowerCase();
  const list = contacts().filter((u) => !q || displayName(u).toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
  const box = $('#new-dm-list');
  box.replaceChildren(...(list.length ? list.map((u) => {
    const av = avatar(u, 'sm');
    av.append(statusDot(presenceOf(u)));
    return h('button', { type: 'button', class: 'pick-user', dataset: { userId: u.id } }, av,
      h('span', { class: 'pick-user__text' },
        h('span', { class: 'pick-user__name' }, displayName(u)),
        h('span', { class: 'pick-user__sub' }, `@${u.username} · ${u.servers.slice(0, 2).join(', ')}${u.servers.length > 2 ? '…' : ''}`)));
  }) : [h('p', { class: 'modal__hint' }, q ? 'Никого не нашлось' : 'Пока не с кем переписываться — пригласите друзей на свой сервер.')]));
}

export function openNewDm() {
  if (!dlg) {
    dlg = h('dialog', { class: 'modal', id: 'modal-new-dm', 'aria-labelledby': 'modal-new-dm-title' },
      h('header', { class: 'modal__header' },
        h('h3', { id: 'modal-new-dm-title' }, 'Новое сообщение'),
        h('button', { type: 'button', class: 'icon-btn', 'data-close': '', 'aria-label': 'Закрыть', onclick: () => closeModal(dlg) }, icon('i-close'))),
      h('div', { class: 'modal__body' },
        h('p', { class: 'modal__hint' }, 'Писать можно тем, с кем у вас есть общий сервер. Только переписка: текст, фото и видео.'),
        h('input', { class: 'input', id: 'new-dm-search', type: 'search', placeholder: 'Найти по имени', autocomplete: 'off', 'aria-label': 'Поиск' }),
        h('div', { class: 'pick-list', id: 'new-dm-list', role: 'list' })));
    document.body.append(dlg);
    $('#new-dm-search').addEventListener('input', renderPicker);
    $('#new-dm-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-user-id]');
      if (!b) return;
      closeModal(dlg);
      openDmWith(b.dataset.userId);
    });
  }
  $('#new-dm-search').value = '';
  renderPicker();
  openModal(dlg);
  $('#new-dm-search').focus();
}

export function initDms(on) {
  subscribe(['dms', 'servers', 'nav'], renderHomeBadge);
  // ЛС пришло/обновилось: открыт и виден — сразу прочитано
  on('dm:updated', ({ dm } = {}) => {
    if (!dm?.id) return;
    upsertDm(dm);
    if (dm.id === state.currentChannelId && dm.unread) markRead(dm.id, { force: true });
    notify('dms');
  });
  on('dm:closed', ({ dmId } = {}) => {
    state.dms = state.dms.filter((d) => d.id !== dmId);
    delete state.messages[dmId];
    if (state.lastDm === dmId) state.lastDm = null;
    if (state.currentChannelId === dmId) selectServer(null);
    notify('dms');
  });
  on('read:state', ({ channelId } = {}) => {
    const dm = channelId && getDm(channelId);
    if (dm && dm.unread) { dm.unread = 0; notify('dms'); }
  });
  // новое сообщение в открытом канале на виду — прочитано (уведомления о нём уйдут из «Входящих»)
  on('message:new', ({ message } = {}) => {
    if (message?.channelId === state.currentChannelId && message.author?.id !== state.user?.id) markRead(message.channelId);
  });

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-new-dm, #btn-home-new-dm')) { openNewDm(); return; }
    const close = e.target.closest('[data-close-dm]');
    if (close) {
      e.preventDefault();
      e.stopPropagation();
      try { await emitAck('dm:close', { dmId: close.dataset.closeDm }); } catch (ex) { toastError(ex); }
      return;
    }
    const item = e.target.closest('.dm-item[data-dm-id]');
    if (item) { e.preventDefault(); selectChannel(item.dataset.dmId); }
  });
}

