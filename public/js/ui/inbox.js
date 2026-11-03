// «Входящие» (как в Discord): упоминания, @everyone и личные сообщения — колокольчик в шапке со счётчиком.
// Клик по записи открывает канал/чат; открытие канала отмечает его уведомления прочитанными (channel:read).
// Напоминания о событиях сервера (type 'event') открывают окно событий; «Подключиться» — голосовой канал события.
import { $, h, icon, avatar, displayName, fmtDate, safeMediaUrl, initials } from '../util.js';
import { state, subscribe, notify, inboxUnread, getServer, getChannel } from '../state.js';
import { emitAck } from '../socket.js';
import { selectChannel } from '../nav.js';
import { toastError } from './toasts.js';
import { openEvents } from './events.js';

let panel = null;
let filter = 'all'; // all | unread

/** Что случилось: «упомянул(а) вас» / «@everyone» / «личное сообщение» */
function actionOf(n) {
  if (n.type === 'event') return n.kind === 'start' ? 'событие начинается' : 'скоро событие';
  if (n.type === 'dm') return n.count > 1 ? `личные сообщения · ${n.count}` : 'личное сообщение';
  return n.type === 'everyone' ? '@everyone' : 'упомянул(а) вас';
}

/** Откуда: сервер и канал (названия — актуальные из state, с запасом из уведомления) или «Личные сообщения» */
function sourceEl(n) {
  if (n.type === 'dm') {
    return h('span', { class: 'inbox-item__source', title: 'Личные сообщения' },
      h('span', { class: 'inbox-item__src-icon inbox-item__src-icon--dm' }, icon('i-message', 'icon--sm')), 'Личные сообщения');
  }
  const srv = getServer(n.serverId);
  const ch = getChannel(n.channelId);
  const srvName = srv?.name || n.serverName || 'Сервер';
  if (n.type === 'event') {
    const pic = safeMediaUrl(srv?.icon);
    return h('span', { class: 'inbox-item__source', title: `${srvName} · события` },
      h('span', { class: 'inbox-item__src-icon' }, pic ? h('img', { src: pic, alt: '' }) : initials(srvName)),
      h('span', { class: 'inbox-item__src-server' }, srvName),
      h('span', { class: 'inbox-item__src-sep', 'aria-hidden': 'true' }, '›'),
      h('span', { class: 'inbox-item__src-channel' }, ch ? `🔊 ${ch.name}` : 'события'));
  }
  const chName = ch?.name || n.channelName || 'канал';
  const pic = safeMediaUrl(srv?.icon);
  return h('span', { class: 'inbox-item__source', title: `${srvName} · #${chName}` },
    h('span', { class: 'inbox-item__src-icon' }, pic ? h('img', { src: pic, alt: '' }) : initials(srvName)),
    h('span', { class: 'inbox-item__src-server' }, srvName),
    h('span', { class: 'inbox-item__src-sep', 'aria-hidden': 'true' }, '›'),
    h('span', { class: 'inbox-item__src-channel' }, `#${chName}`));
}

/** Напоминание о событии: не <button> — внутри своя кнопка «Подключиться» */
function eventItemEl(n) {
  const ch = n.channelId ? getChannel(n.channelId) : null;
  return h('div', {
    class: 'inbox-item inbox-item--event' + (n.read ? '' : ' is-unread'), role: 'listitem', tabindex: '0',
    dataset: { notificationId: n.id, eventId: n.eventId, serverId: n.serverId },
  }, h('span', { class: 'inbox-item__event-icon' }, icon('i-calendar')),
  h('span', { class: 'inbox-item__text' },
    sourceEl(n),
    h('span', { class: 'inbox-item__top' },
      h('span', { class: 'inbox-item__who' }, n.preview || 'Событие'),
      h('span', { class: 'inbox-item__where' }, actionOf(n))),
    n.startAt ? h('span', { class: 'inbox-item__preview' }, `Начало в ${new Date(n.startAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`) : null,
    ch ? h('span', { class: 'inbox-item__event-actions' },
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', dataset: { eventJoin: ch.id } }, icon('i-headphones', 'icon--sm'), 'Подключиться')) : null,
    h('time', { class: 'inbox-item__time', datetime: new Date(n.createdAt).toISOString() }, fmtDate(n.createdAt))),
  n.read ? null : h('span', { class: 'inbox-item__dot', 'aria-label': 'Не прочитано' }));
}

function itemEl(n) {
  if (n.type === 'event') return eventItemEl(n);
  return h('button', {
    type: 'button', class: 'inbox-item' + (n.read ? '' : ' is-unread'), role: 'listitem',
    dataset: { notificationId: n.id, channelId: n.channelId },
  }, avatar(n.author, 'sm'),
  h('span', { class: 'inbox-item__text' },
    sourceEl(n),
    h('span', { class: 'inbox-item__top' },
      h('span', { class: 'inbox-item__who' }, displayName(n.author)),
      h('span', { class: 'inbox-item__where' }, actionOf(n))),
    h('span', { class: 'inbox-item__preview' }, n.preview || ''),
    h('time', { class: 'inbox-item__time', datetime: new Date(n.createdAt).toISOString() }, fmtDate(n.createdAt))),
  n.read ? null : h('span', { class: 'inbox-item__dot', 'aria-label': 'Не прочитано' }));
}

function renderBadge() {
  const btn = $('#btn-inbox');
  if (!btn) return;
  const n = inboxUnread();
  let b = btn.querySelector('.badge-count');
  if (!n) b?.remove();
  else {
    if (!b) { b = h('span', { class: 'badge-count badge-count--corner' }); btn.append(b); }
    b.textContent = n > 99 ? '99+' : String(n);
  }
  btn.setAttribute('aria-label', n ? `Входящие: непрочитанных ${n}` : 'Входящие');
  btn.classList.toggle('has-unread', !!n);
}

function renderPanel() {
  if (!panel || panel.hidden) return;
  const list = state.notifications.filter((n) => filter === 'all' || !n.read);
  panel.querySelectorAll('[data-inbox-filter]').forEach((t) => {
    const on = t.dataset.inboxFilter === filter;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#inbox-read-all').disabled = !inboxUnread();
  $('#inbox-list').replaceChildren(...(list.length ? list.map(itemEl) : [h('div', { class: 'inbox__empty' },
    icon('i-inbox', 'icon--lg'),
    h('p', null, filter === 'unread' ? 'Всё прочитано' : 'Здесь появятся упоминания вас, личные сообщения и напоминания о событиях'))]));
}

function build() {
  if (panel) return panel;
  panel = h('section', { class: 'inbox', id: 'inbox', hidden: true, role: 'dialog', 'aria-label': 'Входящие' },
    h('header', { class: 'inbox__header' },
      icon('i-inbox'),
      h('h3', null, 'Входящие'),
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'inbox-read-all' }, icon('i-check', 'icon--sm'), 'Прочитать всё')),
    h('div', { class: 'tabs inbox__tabs', role: 'tablist' },
      h('button', { type: 'button', class: 'tab', role: 'tab', dataset: { inboxFilter: 'all' } }, 'Все'),
      h('button', { type: 'button', class: 'tab', role: 'tab', dataset: { inboxFilter: 'unread' } }, 'Непрочитанные')),
    h('div', { class: 'inbox__list', id: 'inbox-list', role: 'list' }));
  document.body.append(panel);
  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-inbox-filter]');
    if (t) { filter = t.dataset.inboxFilter; renderPanel(); return; }
    if (e.target.closest('#inbox-read-all')) {
      try { await emitAck('notification:read', { all: true }); } catch (ex) { toastError(ex); }
      return;
    }
    if (e.target.closest('[data-event-join]')) { closeInbox(); return; } // подключение — events.js
    const item = e.target.closest('.inbox-item');
    if (item) {
      closeInbox();
      const n = state.notifications.find((x) => x.id === item.dataset.notificationId);
      if (n && !n.read) emitAck('notification:read', { ids: [n.id] }).catch(() => {});
      if (item.dataset.eventId) openEvents(item.dataset.serverId, item.dataset.eventId);
      else selectChannel(item.dataset.channelId);
    }
  });
  panel.addEventListener('keydown', (e) => {
    const item = e.target.closest?.('.inbox-item--event');
    if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); item.click(); }
  });
  return panel;
}

function place() {
  const r = $('#btn-inbox').getBoundingClientRect();
  const w = Math.min(420, window.innerWidth - 16);
  panel.style.width = `${w}px`;
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)))}px`;
}

export function openInbox() {
  build();
  panel.hidden = false;
  place();
  renderPanel();
  $('#btn-inbox').setAttribute('aria-expanded', 'true');
  panel.querySelector('.inbox-item, [data-inbox-filter]')?.focus({ preventScroll: true });
}

export function closeInbox() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $('#btn-inbox').setAttribute('aria-expanded', 'false');
}

export const isInboxOpen = () => !!panel && !panel.hidden;

function upsert(n) {
  // напоминание о событии одно на событие: «начинается» заменяет «скоро» (как на сервере)
  const same = (x) => x.id === n.id || (n.type === 'event' && x.type === 'event' && x.eventId === n.eventId);
  state.notifications = [n, ...state.notifications.filter((x) => !same(x))]
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

/** Канал/сервер удалили или доступ пропал (кик, бан, роль) — его уведомления больше не показываем */
function pruneInaccessible() {
  const visible = new Set(state.servers.flatMap((s) => s.channels.map((c) => c.id)));
  const servers = new Set(state.servers.map((s) => s.id));
  const keep = state.notifications.filter((n) => n.type === 'dm' || (n.type === 'event' ? servers.has(n.serverId) : visible.has(n.channelId)));
  if (keep.length === state.notifications.length) return;
  state.notifications = keep;
  notify('inbox');
}

export function initInbox(on) {
  subscribe(['inbox', 'me'], () => { renderBadge(); renderPanel(); });
  subscribe('servers', pruneInaccessible);
  subscribe('profile', renderPanel);
  subscribe('servers', renderPanel); // переименовали сервер/канал — «откуда» обновится
  $('#btn-inbox').addEventListener('click', (e) => {
    e.stopPropagation();
    if (isInboxOpen()) closeInbox(); else openInbox();
  });
  document.addEventListener('click', (e) => {
    if (isInboxOpen() && !e.target.closest('#inbox, #btn-inbox')) closeInbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isInboxOpen()) { closeInbox(); $('#btn-inbox').focus(); }
  });
  window.addEventListener('resize', () => { if (isInboxOpen()) place(); });

  on('notification:new', ({ notification } = {}) => {
    if (!notification?.id) return;
    upsert(notification);
    notify('inbox');
  });
  on('notification:removed', ({ id, messageId, eventId } = {}) => {
    const before = state.notifications.length;
    state.notifications = state.notifications.filter((n) => (id ? n.id !== id : eventId ? n.eventId !== eventId : n.messageId !== messageId));
    if (state.notifications.length !== before) notify('inbox');
  });
  on('read:state', ({ notificationIds } = {}) => {
    if (!notificationIds?.length) return;
    const ids = new Set(notificationIds);
    for (const n of state.notifications) if (ids.has(n.id)) n.read = true;
    notify('inbox');
  });
  renderBadge();
}
