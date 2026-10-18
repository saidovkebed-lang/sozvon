// Профили (SPEC-v3 §2.3): попап профиля, меню статуса в user-panel, кастомный статус, авто-«Не активен».
import { $, h, icon, avatar, displayName, safeColor, safeMediaUrl, renderMarkdown, motionReduced } from '../util.js';
import { state, subscribe, getServer, findUser, presenceOf, activeCustomStatus, STATUS_LABELS, applyUserUpdate } from '../state.js';
import { api } from '../api.js';
import { memberRoles, canManageRole, outranks, isServerOwner } from '../perms.js';
import { openModal, closeModal } from './modals.js';
import { toastError } from './toasts.js';
import { capabilities, toggleMemberRole, assignableRoles, kickMember, banMember, setServerMute } from './mod-actions.js';
import { statusDot } from './members.js';

const MONTHS = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const fmtSince = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`; };

/** Баннер: картинка/гиф или цвет */
function bannerEl(u, { animate }) {
  const stat = safeMediaUrl(u.banner);
  const anim = safeMediaUrl(u.bannerAnimated);
  const color = /^#[0-9a-f]{6}$/i.test(u.bannerColor || '') ? u.bannerColor : safeColor(u.color);
  const el = h('div', { class: 'profile-popup__banner' + (stat || anim ? ' has-img' : ''), style: { '--banner': color } });
  if (stat || anim) {
    el.append(h('img', { src: animate && anim && !motionReduced() ? anim : (stat || anim), alt: '', draggable: 'false' }));
  }
  return el;
}

/**
 * Карточка профиля (используется в попапе и живом предпросмотре настроек).
 * opts.server — роли на сервере; opts.preview — без действий.
 */
export function profileCard(u, { server = null, preview = false, onAction = null } = {}) {
  const status = preview ? (u.status === 'invisible' ? 'offline' : (u.status || 'online')) : presenceOf(u);
  const theme = u.profileTheme && /^#[0-9a-f]{6}$/i.test(u.profileTheme.primary || '') && /^#[0-9a-f]{6}$/i.test(u.profileTheme.accent || '') ? u.profileTheme : null;
  const card = h('div', {
    class: 'profile-popup' + (theme ? ' has-theme' : ''),
    dataset: { userId: u.id || '' },
    style: theme ? { '--pp-primary': theme.primary, '--pp-accent': theme.accent } : null,
  });
  card.append(bannerEl(u, { animate: true }));
  const av = avatar(u, 'xl', { animate: true });
  av.classList.add('profile-popup__avatar');
  av.append(statusDot(status));
  av.title = STATUS_LABELS[status] || '';
  card.append(h('div', { class: 'profile-popup__head' }, av,
    u.isBot ? h('span', { class: 'badge badge--bot profile-popup__badge' }, 'БОТ') : null));

  const body = h('div', { class: 'profile-popup__body' });
  body.append(h('div', { class: 'profile-popup__name' }, displayName(u)));
  const sub = h('div', { class: 'profile-popup__sub' }, h('span', { class: 'profile-popup__username' }, `@${u.username || ''}`));
  if (u.pronouns) sub.append(h('span', { class: 'profile-popup__dotsep', 'aria-hidden': 'true' }, '•'), h('span', { class: 'profile-popup__pronouns' }, u.pronouns));
  body.append(sub);
  const cs = activeCustomStatus(u);
  if (cs) {
    body.append(h('div', { class: 'profile-popup__status' },
      cs.emoji ? h('span', { class: 'profile-popup__emoji' }, cs.emoji) : null,
      cs.text ? h('span', null, cs.text) : null));
  }
  const sections = h('div', { class: 'profile-popup__sections' });
  if (u.about) {
    sections.append(h('section', { class: 'profile-popup__section' },
      h('h4', null, 'Обо мне'), h('div', { class: 'profile-popup__about' }, renderMarkdown(u.about))));
  }
  if (u.createdAt) {
    sections.append(h('section', { class: 'profile-popup__section' },
      h('h4', null, 'В Созвоне с'),
      h('div', { class: 'profile-popup__since' }, icon('i-calendar', 'icon--sm'), fmtSince(u.createdAt))));
  }
  if (server && !u.isBot && !preview && u.id) {
    const roles = memberRoles(server, u.id);
    const canEdit = !!capabilities(server, u.id).roles;
    const list = h('div', { class: 'profile-popup__roles' });
    for (const r of roles) {
      const editable = canEdit && canManageRole(server, r);
      list.append(h('span', { class: 'role-pill', dataset: { roleId: r.id }, style: { '--rc': r.color || 'var(--text-faint)' } },
        h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }), h('span', { class: 'role-pill__name' }, r.name),
        editable ? h('button', {
          type: 'button', class: 'role-pill__remove', 'aria-label': `Снять роль ${r.name}`, title: 'Снять роль',
          onclick: () => toggleMemberRole(server, u.id, r.id, false),
        }, icon('i-close', 'icon--sm')) : null));
    }
    if (canEdit && assignableRoles(server).some((r) => !roles.includes(r))) {
      list.append(h('button', {
        type: 'button', class: 'role-pill role-pill--add', 'aria-label': 'Добавить роль', title: 'Добавить роль', 'aria-haspopup': 'listbox',
        onclick: (e) => openRolePicker(e.currentTarget, server, u.id),
      }, icon('i-plus', 'icon--sm')));
    }
    if (roles.length || canEdit) {
      sections.append(h('section', { class: 'profile-popup__section' }, h('h4', null, roles.length ? `Роли — ${roles.length}` : 'Роли'), list));
    }
  }
  body.append(sections);

  if (!preview && server && u.id) {
    const caps = capabilities(server, u.id);
    const actions = h('div', { class: 'profile-popup__actions' });
    if (caps.self) {
      actions.append(h('button', { type: 'button', class: 'btn btn--sm btn--block-soft', onclick: () => { onAction?.(); import('./user-settings.js').then((m) => m.openUserSettings('profile')); } },
        icon('i-pencil'), 'Редактировать профиль'));
    }
    if (!caps.self && !u.isBot) {
      actions.append(h('button', { type: 'button', class: 'btn btn--sm btn--primary btn--block', dataset: { action: 'message' }, onclick: () => { onAction?.(); import('./dms.js').then((m) => m.openDmWith(u.id)); } },
        icon('i-message'), 'Написать сообщение'));
    }
    if (caps.mute) {
      const on = !!caps.inVoice.member.serverMute;
      actions.append(h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'server-mute' }, onclick: () => { onAction?.(); setServerMute(server, u.id, !on); } },
        icon(on ? 'i-mic' : 'i-mic-off'), on ? 'Вернуть микрофон' : 'Отключить микрофон'));
    }
    if (caps.kick) actions.append(h('button', { type: 'button', class: 'btn btn--sm btn--danger-soft', dataset: { action: 'kick' }, onclick: () => { onAction?.(); kickMember(server, u.id); } }, icon('i-door'), 'Выгнать'));
    if (caps.ban) actions.append(h('button', { type: 'button', class: 'btn btn--sm btn--danger-soft', dataset: { action: 'ban' }, onclick: () => { onAction?.(); banMember(server, u.id); } }, icon('i-ban'), 'Забанить'));
    if (actions.children.length) body.append(actions);
  }
  card.append(body);
  return card;
}

/* ---------- выбор роли (поповер внутри попапа) ---------- */
function openRolePicker(anchor, server, userId) {
  const existing = document.querySelector('.role-picker');
  if (existing) { existing.remove(); return; }
  const have = new Set(memberRoles(server, userId).map((r) => r.id));
  const roles = assignableRoles(server).filter((r) => !have.has(r.id)).sort((a, b) => b.position - a.position);
  const input = h('input', { class: 'input role-picker__search', placeholder: 'Роль', 'aria-label': 'Поиск роли' });
  const list = h('div', { class: 'role-picker__list', role: 'listbox' });
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    list.replaceChildren(...roles.filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => h('button', {
      type: 'button', class: 'role-picker__item', role: 'option', dataset: { roleId: r.id },
      style: { '--rc': r.color || 'var(--text-faint)' },
      onclick: () => { picker.remove(); toggleMemberRole(server, userId, r.id, true); },
    }, h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }), r.name)));
    if (!list.children.length) list.append(h('p', { class: 'role-picker__empty' }, 'Нет подходящих ролей'));
  };
  input.addEventListener('input', fill);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); picker.remove(); anchor.focus(); } });
  const picker = h('div', { class: 'role-picker' }, input, list);
  fill();
  anchor.closest('.profile-popup').append(picker);
  const pr = anchor.closest('.profile-popup').getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  picker.style.top = `${Math.round(ar.bottom - pr.top + 6)}px`;
  picker.style.left = `${Math.round(Math.max(8, Math.min(ar.left - pr.left, pr.width - 228)))}px`;
  input.focus();
}

/* ============================================================
   Попап профиля
   ============================================================ */
let popup = null;      // { el, userId, serverId, anchor }
let restoreFocus = null;

export function isProfileOpen() { return !!popup; }

export function closeProfile(focusBack = true) {
  if (!popup) return;
  popup.el.remove();
  popup.anchor?.classList.remove('is-profile-open');
  popup = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  if (focusBack && restoreFocus && document.contains(restoreFocus)) restoreFocus.focus?.({ preventScroll: true });
  restoreFocus = null;
}

function onOutside(e) {
  if (!popup) return;
  if (popup.el.contains(e.target)) return;
  if (e.target.closest?.('.context-menu, dialog[open]')) return;
  closeProfile(false);
}
function onKey(e) {
  if (e.key === 'Escape' && popup) {
    if (document.querySelector('.role-picker')) return;
    e.preventDefault(); e.stopPropagation(); closeProfile();
  }
}
function onResize() { closeProfile(false); }

function placePopup(el, anchor, at) {
  const pad = 12;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  if (vw < 640) { el.classList.add('profile-popup--sheet'); return; }
  // offset*, а не getBoundingClientRect: во время анимации появления (scale 0.96) прямоугольник меньше настоящего
  const r = { width: el.offsetWidth, height: el.offsetHeight };
  const a = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  // справа от якоря, а если не влезает (колонка участников справа) — слева
  let left = a.right + pad;
  if (left + r.width > vw - pad) left = a.left - r.width - pad;
  left = Math.max(pad, Math.min(left, vw - r.width - pad));
  let top = a.top;
  if (top + r.height > vh - pad) top = vh - r.height - pad;
  top = Math.max(pad, top);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** Открыть попап профиля пользователя (anchor — элемент, по которому кликнули) */
export function openProfile(userId, anchor, { serverId = null, at = null } = {}) {
  if (!userId) return;
  if (popup && popup.userId === userId && popup.anchor === anchor) { closeProfile(); return; }
  closeProfile(false);
  const server = getServer(serverId) || getServer();
  const u = findUser(userId, server);
  if (!u) return;
  restoreFocus = document.activeElement;
  const wrap = h('div', { class: 'profile-layer', role: 'dialog', 'aria-label': `Профиль: ${displayName(u)}`, tabindex: '-1' },
    profileCard(u, { server, onAction: () => closeProfile(false) }));
  (document.querySelector('dialog[open]') || document.body).append(wrap);
  popup = { el: wrap, userId, serverId: server?.id || null, anchor, at };
  anchor?.classList?.add('is-profile-open');
  placePopup(wrap, anchor, at);
  // баннер/аватар догружаются и меняют высоту — переставить, чтобы попап не упирался в край экрана
  wrap.addEventListener('load', () => { if (popup?.el === wrap) placePopup(wrap, popup.anchor, popup.at); }, true);
  wrap.focus({ preventScroll: true });
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', onResize);
  }, 0);
  document.addEventListener('keydown', onKey, true);
}

function refreshPopup() {
  if (!popup) return;
  const server = getServer(popup.serverId) || getServer();
  const u = findUser(popup.userId, server);
  if (!u) { closeProfile(false); return; }
  if (popup.el.querySelector('.role-picker')) return; // не сбивать выбор роли
  popup.el.replaceChildren(profileCard(u, { server, onAction: () => closeProfile(false) }));
  placePopup(popup.el, popup.anchor, popup.at);
}

/* ============================================================
   Статус: меню в user-panel, кастомный статус, авто-«Не активен»
   ============================================================ */
const STATUS_ITEMS = [
  { id: 'online', label: 'В сети' },
  { id: 'idle', label: 'Не активен' },
  { id: 'dnd', label: 'Не беспокоить', hint: 'Без звуков и системных уведомлений' },
  { id: 'invisible', label: 'Невидимый', hint: 'Вы будете казаться не в сети, но сможете пользоваться Созвоном' },
];

let statusMenu = null;
let autoIdle = false;          // статус «Не активен» выставлен автоматически

export async function setMyStatus(status, { auto = false } = {}) {
  if (!state.user) return;
  const prev = state.user.status || 'online';
  if (prev === status) return;
  autoIdle = auto && status === 'idle';
  applyUserUpdate({ id: state.user.id, status });
  try {
    const res = await api.patchMe({ status });
    if (res?.user) applyUserUpdate(res.user);
  } catch (e) {
    applyUserUpdate({ id: state.user.id, status: prev });
    if (!auto) toastError(e);
  }
}

export const myStatus = () => state.user?.status || 'online';
export const isDnd = () => myStatus() === 'dnd';

function closeStatusMenu() {
  if (!statusMenu) return;
  statusMenu.remove();
  statusMenu = null;
  $('#me-avatar')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onStatusOutside, true);
  document.removeEventListener('keydown', onStatusKey, true);
}
function onStatusOutside(e) { if (statusMenu && !statusMenu.contains(e.target) && !e.target.closest('#me-avatar')) closeStatusMenu(); }
function onStatusKey(e) {
  if (!statusMenu) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeStatusMenu(); $('#me-avatar')?.focus(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = [...statusMenu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
}

function openStatusMenu() {
  if (statusMenu) { closeStatusMenu(); return; }
  const cur = myStatus();
  const cs = activeCustomStatus(state.user);
  const btn = $('#me-avatar');
  statusMenu = h('div', { class: 'status-menu', role: 'menu', 'aria-label': 'Статус' },
    h('div', { class: 'status-menu__me' },
      h('div', { class: 'status-menu__name' }, displayName(state.user)),
      h('div', { class: 'status-menu__user' }, `@${state.user.username}`)),
    h('button', { type: 'button', class: 'status-menu__item status-menu__custom', role: 'menuitem', dataset: { action: 'custom-status' }, onclick: () => { closeStatusMenu(); openCustomStatus(); } },
      cs?.emoji ? h('span', { class: 'status-menu__emoji' }, cs.emoji) : icon('i-smile', 'icon--sm'),
      h('span', { class: 'status-menu__text' }, cs ? (cs.text || 'Статус задан') : 'Задать статус'),
      cs ? h('span', { class: 'status-menu__clear', role: 'button', title: 'Сбросить статус', 'aria-label': 'Сбросить статус', onclick: (e) => { e.stopPropagation(); closeStatusMenu(); saveCustomStatus(null); } }, icon('i-close', 'icon--sm')) : null),
    h('div', { class: 'status-menu__sep', role: 'separator' }),
    ...STATUS_ITEMS.map((s) => h('button', {
      type: 'button', class: 'status-menu__item' + (s.id === cur ? ' is-current' : ''), role: 'menuitemradio',
      'aria-checked': String(s.id === cur), dataset: { status: s.id },
      onclick: () => { closeStatusMenu(); setMyStatus(s.id); },
    }, h('span', { class: 'status-ico', dataset: { status: s.id }, 'aria-hidden': 'true' }),
    h('span', { class: 'status-menu__text' }, h('span', null, s.label), s.hint ? h('small', null, s.hint) : null))));
  document.body.append(statusMenu);
  const r = btn.getBoundingClientRect();
  const mr = { width: statusMenu.offsetWidth, height: statusMenu.offsetHeight };
  statusMenu.style.left = `${Math.max(8, Math.min(r.left, document.documentElement.clientWidth - mr.width - 8))}px`;
  statusMenu.style.top = `${Math.max(8, r.top - mr.height - 8)}px`;
  btn.setAttribute('aria-expanded', 'true');
  statusMenu.querySelector('.is-current, button')?.focus();
  setTimeout(() => document.addEventListener('pointerdown', onStatusOutside, true), 0);
  document.addEventListener('keydown', onStatusKey, true);
}

/* ---------- кастомный статус ---------- */
const EMOJIS = ['😀', '😎', '🎮', '🎧', '🎵', '💻', '📚', '☕', '🍕', '😴', '🤒', '🏃', '✈️', '🔥', '❤️', '🎉', '🤔', '👀', '🛠️', '🚫'];
const EXPIRES = [
  { id: '30m', label: '30 минут', ms: 30 * 60e3 },
  { id: '1h', label: '1 час', ms: 60 * 60e3 },
  { id: '4h', label: '4 часа', ms: 4 * 60 * 60e3 },
  { id: 'today', label: 'Сегодня' },
  { id: 'never', label: 'Не сбрасывать' },
];

function expiresAt(id) {
  const e = EXPIRES.find((x) => x.id === id);
  if (!e || id === 'never') return null;
  if (id === 'today') { const d = new Date(); d.setHours(23, 59, 59, 0); return d.getTime(); }
  return Date.now() + e.ms;
}

async function saveCustomStatus(cs) {
  if (!state.user) return false;
  const prev = state.user.customStatus || null;
  applyUserUpdate({ id: state.user.id, customStatus: cs });
  try {
    const res = await api.patchMe({ customStatus: cs });
    if (res?.user) applyUserUpdate(res.user);
    return true;
  } catch (e) {
    applyUserUpdate({ id: state.user.id, customStatus: prev });
    toastError(e);
    return false;
  }
}

function openCustomStatus() {
  const dlg = $('#modal-custom-status');
  const cs = activeCustomStatus(state.user);
  $('#custom-status-emoji').value = cs?.emoji || '';
  $('#custom-status-text').value = cs?.text || '';
  $('#custom-status-expire').value = 'today';
  $('#custom-status-emoji-btn').textContent = cs?.emoji || '';
  $('#custom-status-emoji-btn').classList.toggle('is-empty', !cs?.emoji);
  $('#custom-status-emojis').hidden = true;
  updateCount();
  openModal(dlg);
  $('#custom-status-text').focus();
}

function updateCount() {
  const t = $('#custom-status-text');
  $('#custom-status-count').textContent = `${t.value.length}/128`;
}

function initCustomStatus() {
  const grid = $('#custom-status-emojis');
  grid.replaceChildren(...EMOJIS.map((e) => h('button', { type: 'button', class: 'emoji-btn', dataset: { emoji: e }, 'aria-label': e }, e)));
  const setEmoji = (e) => {
    $('#custom-status-emoji').value = e;
    const b = $('#custom-status-emoji-btn');
    b.textContent = e;
    b.classList.toggle('is-empty', !e);
  };
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    setEmoji(b.dataset.emoji);
    grid.hidden = true;
    $('#custom-status-text').focus();
  });
  $('#custom-status-emoji-btn').addEventListener('click', () => { grid.hidden = !grid.hidden; });
  $('#custom-status-emoji').addEventListener('input', (e) => setEmoji(Array.from(e.target.value).slice(0, 2).join('')));
  $('#custom-status-expire').replaceChildren(...EXPIRES.map((x) => h('option', { value: x.id }, x.label)));
  $('#custom-status-text').addEventListener('input', updateCount);
  $('#form-custom-status').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#custom-status-text').value.trim().slice(0, 128);
    const emoji = $('#custom-status-emoji').value.trim().slice(0, 8) || null;
    const cs = text || emoji ? { emoji, text, expiresAt: expiresAt($('#custom-status-expire').value) } : null;
    if (await saveCustomStatus(cs)) closeModal('modal-custom-status');
  });
  $('#custom-status-clear').addEventListener('click', async () => {
    if (await saveCustomStatus(null)) closeModal('modal-custom-status');
  });
}

/* ---------- авто «Не активен» через 10 минут без активности ---------- */
const IDLE_MS = 10 * 60 * 1000;
let lastActivity = Date.now();

function onActivity() {
  lastActivity = Date.now();
  if (autoIdle && myStatus() === 'idle') { autoIdle = false; setMyStatus('online'); }
}

function idleTick() {
  if (!state.user || !state.connected) return;
  if (myStatus() === 'online' && Date.now() - lastActivity >= IDLE_MS) setMyStatus('idle', { auto: true });
}

export function initProfile() {
  initCustomStatus();
  const me = $('#me-avatar');
  me.addEventListener('click', (e) => { e.stopPropagation(); openStatusMenu(); });
  // клики по нику/аватару/участнику → попап
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const t = e.target;
    if (t.closest('[data-user-menu], .more-btn, button:not(.member):not(.voice-user)')) return;
    const msgAuthor = t.closest('.message .message__author, .message > .avatar');
    if (msgAuthor) {
      const msg = msgAuthor.closest('.message');
      const uid = msg.dataset.authorId;
      if (uid) { e.preventDefault(); openProfile(uid, msgAuthor); }
      return;
    }
    const member = t.closest('#members .member[data-user-id]');
    if (member) { openProfile(member.dataset.userId, member); return; }
    const vu = t.closest('#channels .voice-user[data-user-id]');
    if (vu) { openProfile(vu.dataset.userId, vu); return; }
    const uPanel = t.closest('.user-panel__info');
    if (uPanel && state.user) openProfile(state.user.id, uPanel);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const member = e.target.closest?.('#members .member[data-user-id]');
    if (member) { e.preventDefault(); openProfile(member.dataset.userId, member); return; }
    const author = e.target.closest?.('.message .message__author[role="button"]');
    if (author) { e.preventDefault(); const uid = author.closest('.message').dataset.authorId; if (uid) openProfile(uid, author); return; }
    const info = e.target.closest?.('.user-panel__info');
    if (info && e.target === info && state.user) { e.preventDefault(); openProfile(state.user.id, info); }
  });
  subscribe(['profile', 'servers', 'presence', 'voice'], refreshPopup);

  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, onActivity, { passive: true, capture: true });
  window.addEventListener('pointermove', () => { if (Date.now() - lastActivity > 30_000 || autoIdle) onActivity(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onActivity(); });
  setInterval(idleTick, 30_000);
  // кто-то в другой вкладке/устройстве сменил статус вручную — авто-флаг снимаем
  subscribe('me', () => { if (myStatus() !== 'idle') autoIdle = false; });
}

export { outranks, isServerOwner };
