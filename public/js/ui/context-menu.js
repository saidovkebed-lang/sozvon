// Контекстное меню участника (v2 + v3): Профиль, громкость 0–200 % и «Заглушить локально» (в голосе),
// Роли (чекбоксы), серверный mute/deafen, Переместить в канал, Отключить, Выгнать, Забанить — по правам
// и иерархии (SPEC-v3 §1). Для бота — громкость музыки.
// Открывается: правый клик / долгий тап (500 мс) / кнопка «⋯» на .voice-user, .tile, .member, нике в чате.
import { h, icon, avatar, displayName } from '../util.js';
import { state, getServer, findUser as findUserData } from '../state.js';
import { prefs } from '../prefs.js';
import { openUserSettings } from './user-settings.js';
import { roleColor, memberRoleIds, sortedRoles } from '../perms.js';
import {
  capabilities, assignableRoles, toggleMemberRole, setServerMute, setServerDeafen, moveMember, kickMember, banMember, transferOwnership,
} from './mod-actions.js';
import { openProfile } from './profile.js';

const LONG_PRESS_MS = 500;
let menu = null;
let anchorEl = null;
let restoreFocus = null;
let lastPoint = null;

const SCOPE = '#channels .voice-user[data-user-id], .sm-member[data-user-id], #stage-grid .tile[data-socket-id], #members .member[data-user-id], .message[data-author-id] .message__author, .message[data-author-id] > .avatar';

function findUser(target) {
  const el = target.closest(SCOPE);
  if (!el) return null;
  const msg = el.closest('.message[data-author-id]');
  let userId = el.dataset.userId || msg?.dataset.authorId || null;
  const sid = el.dataset.socketId;
  let member = null;
  for (const list of Object.values(state.voice)) {
    member = (list || []).find((m) => (sid && m.socketId === sid) || (userId && m.userId === userId)) || null;
    if (member) break;
  }
  if (!userId) userId = member?.userId || (el.dataset.self === 'true' ? state.user?.id : null);
  if (!userId) return null;
  const data = findUserData(userId) || {};
  let isBot = !!member?.isBot || !!data.isBot || el.classList.contains('voice-user--bot') || el.classList.contains('tile--bot');
  const username = data.username || member?.username || el.querySelector('.voice-user__name, .tile__label > span, .member__name')?.textContent || '';
  return {
    el, userId, isBot, data: { ...data, id: userId, username },
    username: username.replace(/ — экран$/, ''), color: data.color || member?.color,
    self: userId === state.user?.id,
    inVoice: !!member,
  };
}

function volumeRow({ label, value, max, action, onInput, resetTo }) {
  const id = `cm-${action}`;
  const out = h('output', { class: 'context-menu__value', for: id });
  const input = h('input', {
    type: 'range', class: 'slider slider--wide', id, min: '0', max: String(max), step: '1',
    value: String(value), dataset: { action },
  });
  const paint = () => {
    input.style.setProperty('--val', `${(Number(input.value) / max) * 100}%`);
    out.textContent = `${input.value}%`;
    input.setAttribute('aria-valuetext', `${input.value}%`);
  };
  input.addEventListener('input', () => { paint(); onInput(Number(input.value)); });
  input.addEventListener('dblclick', () => { input.value = String(resetTo); paint(); onInput(resetTo); });
  paint();
  const marks = max === 200 ? ['0%', '100%', '200%'] : ['0%', '50%', '100%'];
  return h('div', { class: 'context-menu__slider' },
    h('div', { class: 'context-menu__row' }, h('label', { for: id }, label), out),
    input,
    h('div', { class: 'context-menu__marks', 'aria-hidden': 'true' }, ...marks.map((m) => h('span', null, m))));
}

function item(action, iconName, label, onclick, { danger = false, chevron = false, cls = '' } = {}) {
  return h('button', {
    type: 'button', class: 'context-menu__item' + (danger ? ' context-menu__item--danger' : '') + (cls ? ` ${cls}` : ''),
    role: 'menuitem', dataset: { action }, onclick,
  }, icon(iconName, 'icon--sm'), h('span', null, label), chevron ? icon('i-chevron-right', 'icon--sm context-menu__chev') : null);
}

function checkItem(action, iconName, label, checked, onchange) {
  const id = `cm-${action}`;
  const cb = h('input', { type: 'checkbox', class: 'switch switch--sm', dataset: { action }, id });
  cb.checked = !!checked;
  cb.addEventListener('change', () => onchange(cb.checked));
  return h('label', { class: 'context-menu__item context-menu__item--check', for: id, role: 'menuitemcheckbox', 'aria-checked': String(!!checked) },
    icon(iconName, 'icon--sm'), h('span', null, label), cb);
}

const sep = () => h('div', { class: 'context-menu__sep', role: 'separator' });

function headEl(u) {
  const color = roleColor(getServer(), u.userId);
  return h('div', { class: 'context-menu__head' },
    avatar(u.data, 'sm'),
    h('span', { class: 'context-menu__name', style: color ? { color } : null }, displayName(u.data)),
    u.isBot ? h('span', { class: 'badge badge--bot' }, 'БОТ') : null,
    u.self ? h('span', { class: 'context-menu__you' }, 'это вы') : null);
}

function buildMenu(u) {
  const server = getServer();
  const items = [headEl(u)];
  items.push(item('profile', 'i-user', 'Профиль', () => {
    const anchor = anchorEl;
    const at = lastPoint;
    closeMenu(false);
    openProfile(u.userId, anchor, { at });
  }));
  if (u.self) {
    items.push(item('voice-settings', 'i-settings', 'Настройки голоса', () => { closeMenu(false); openUserSettings('voice'); }));
  } else if (u.isBot) {
    items.push(volumeRow({
      label: 'Громкость музыки', value: prefs.get('audio.musicVolume'), max: 100, action: 'music-volume', resetTo: 70,
      onInput: (v) => prefs.set('audio.musicVolume', v),
    }));
    items.push(h('p', { class: 'context-menu__hint' }, 'Только для вас — у остальных своя громкость.'));
    return items;
  } else if (u.inVoice || u.el.matches('.voice-user, .tile')) {
    items.push(volumeRow({
      label: 'Громкость пользователя', value: prefs.getUserVolume(u.userId), max: 200, action: 'user-volume', resetTo: 100,
      onInput: (v) => prefs.setUserVolume(u.userId, v),
    }));
    items.push(checkItem('mute-user', 'i-volume-x', 'Заглушить локально', prefs.isUserMuted(u.userId), (v) => prefs.setUserMuted(u.userId, v)));
    items.push(h('p', { class: 'context-menu__hint' }, 'Слышите только вы. Двойной клик по ползунку — 100%.'));
  }
  if (!server) return items;
  const caps = capabilities(server, u.userId);
  const mod = [];
  if (caps.roles && assignableRoles(server).length) mod.push(item('roles', 'i-tag', 'Роли', () => showPage(rolesPage(u, server)), { chevron: true }));
  if (caps.mute) {
    mod.push(checkItem('server-mute', 'i-mic-off', 'Заглушить на сервере', caps.inVoice.member.serverMute, (v) => setServerMute(server, u.userId, v)));
  }
  if (caps.deafen) {
    mod.push(checkItem('server-deafen', 'i-headphones-off', 'Отключить звук на сервере', caps.inVoice.member.serverDeafen, (v) => setServerDeafen(server, u.userId, v)));
  }
  if (caps.move) {
    mod.push(item('move', 'i-move', 'Переместить в', () => showPage(movePage(u, server, caps.inVoice.channel.id)), { chevron: true }));
    mod.push(item('disconnect', 'i-phone-off', 'Отключить от голосового', () => { closeMenu(false); moveMember(server, u.userId, null); }, { danger: true }));
  }
  if (mod.length) items.push(sep(), ...mod);
  const danger = [];
  if (caps.transfer) danger.push(item('transfer', 'i-crown', 'Передать владение', () => { closeMenu(false); transferOwnership(server, u.userId); }));
  if (caps.kick) danger.push(item('kick', 'i-door', `Выгнать ${displayName(u.data)}`, () => { closeMenu(false); kickMember(server, u.userId); }, { danger: true }));
  if (caps.ban) danger.push(item('ban', 'i-ban', `Забанить ${displayName(u.data)}`, () => { closeMenu(false); banMember(server, u.userId); }, { danger: true }));
  if (danger.length) items.push(sep(), ...danger);
  return items;
}

function pageHead(title) {
  return h('div', { class: 'context-menu__page-head' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Назад', title: 'Назад', dataset: { action: 'back' }, onclick: () => showPage(null) }, icon('i-chevron-left', 'icon--sm')),
    h('span', null, title));
}

function rolesPage(u, server) {
  const have = new Set(memberRoleIds(server, u.userId));
  const editable = new Set(assignableRoles(server).map((r) => r.id));
  const list = sortedRoles(server).filter((r) => r.id !== server.id).map((r) => {
    const id = `cm-role-${r.id}`;
    const cb = h('input', { type: 'checkbox', id, dataset: { roleId: r.id }, disabled: !editable.has(r.id) });
    cb.checked = have.has(r.id);
    cb.addEventListener('change', () => toggleMemberRole(server, u.userId, r.id, cb.checked));
    return h('label', { class: 'context-menu__item context-menu__role' + (editable.has(r.id) ? '' : ' is-disabled'), for: id, style: { '--rc': r.color || 'var(--text-faint)' } },
      h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }), h('span', null, r.name), cb);
  });
  return [pageHead('Роли'), h('div', { class: 'context-menu__scroll' }, ...(list.length ? list : [h('p', { class: 'context-menu__hint' }, 'На сервере пока нет ролей')]))];
}

function movePage(u, server, currentId) {
  const chans = (server.channels || []).filter((c) => c.type === 'voice').sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return [pageHead('Переместить в'), h('div', { class: 'context-menu__scroll' }, ...chans.map((c) => h('button', {
    type: 'button', class: 'context-menu__item' + (c.id === currentId ? ' is-current' : ''), role: 'menuitem',
    dataset: { moveTo: c.id }, disabled: c.id === currentId,
    onclick: () => { closeMenu(false); moveMember(server, u.userId, c.id); },
  }, icon('i-volume', 'icon--sm'), h('span', null, c.name), c.id === currentId ? h('small', null, 'сейчас') : null)))];
}

let mainItems = null;
function showPage(nodes) {
  if (!menu) return;
  if (nodes) {
    mainItems = mainItems || [...menu.childNodes];
    menu.replaceChildren(...nodes);
  } else if (mainItems) {
    menu.replaceChildren(...mainItems);
    mainItems = null;
  }
  const r = menu.getBoundingClientRect();
  position(menu, r.left, r.top);
  (menu.querySelector('input:not(:disabled), button:not(:disabled)') || menu).focus({ preventScroll: true });
}

function position(m, x, y) {
  const pad = 8;
  const r = m.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = x; let top = y;
  if (left + r.width + pad > vw) left = Math.max(pad, x - r.width);
  if (top + r.height + pad > vh) top = Math.max(pad, vh - r.height - pad);
  left = Math.max(pad, Math.min(left, vw - r.width - pad));
  m.style.left = `${Math.round(left)}px`;
  m.style.top = `${Math.round(top)}px`;
}

export function openMenuFor(target, x, y, { page = null } = {}) {
  const u = findUser(target);
  if (!u) return false;
  closeMenu(false);
  restoreFocus = document.activeElement;
  anchorEl = u.el;
  lastPoint = { x, y };
  mainItems = null;
  anchorEl.classList.add('is-menu-open');
  menu = h('div', {
    class: 'context-menu', role: 'menu', tabindex: '-1',
    'aria-label': u.self ? 'Ваше меню' : `Меню: ${displayName(u.data)}`,
    dataset: { userId: u.userId },
  }, ...buildMenu(u));
  (document.querySelector('dialog[open]') || document.body).append(menu);
  position(menu, x, y);
  const first = menu.querySelector('input, button');
  (first || menu).focus({ preventScroll: true });
  if (page === 'roles') menu.querySelector('[data-action="roles"]')?.click();
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  return true;
}

export function closeMenu(focusBack = true) {
  if (!menu) return;
  menu.remove();
  menu = null;
  anchorEl?.classList.remove('is-menu-open');
  anchorEl = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('blur', onResize);
  if (focusBack && restoreFocus && document.contains(restoreFocus)) restoreFocus.focus?.({ preventScroll: true });
  restoreFocus = null;
}

function onOutside(e) { if (menu && !menu.contains(e.target)) closeMenu(false); }
function onScroll(e) { if (menu && !menu.contains(e.target)) closeMenu(false); }
function onResize() { closeMenu(false); }
function onKey(e) {
  if (!menu) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (mainItems) showPage(null); else closeMenu(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement?.type !== 'range') {
    const f = [...menu.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.key === 'ArrowDown' ? 1 : -1) + f.length) % f.length].focus();
  } else if (e.key === 'ArrowLeft' && mainItems && document.activeElement?.type !== 'range') { e.preventDefault(); showPage(null); }
  else if (e.key === 'Tab') {
    const f = [...menu.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
}

/* ---------- «⋯» кнопки ---------- */
export function moreButton(label) {
  return h('button', {
    type: 'button', class: 'icon-btn more-btn', dataset: { userMenu: '' },
    'aria-label': `Действия: ${label}`, title: 'Громкость и действия', 'aria-haspopup': 'menu',
  }, icon('i-more', 'icon--sm'));
}

/** Индикатор изменённой громкости/заглушения для .voice-user */
export function volumeBadge(userId, isBot) {
  if (!userId || userId === state.user?.id || isBot) return null;
  const muted = prefs.isUserMuted(userId);
  const vol = prefs.getUserVolume(userId);
  if (!muted && vol === 100) return null;
  const text = muted ? 'Заглушён у вас' : `Громкость у вас: ${vol}%`;
  const b = h('span', { class: 'vol-badge' + (muted ? ' vol-badge--muted' : ''), title: text, role: 'img', 'aria-label': text },
    icon(muted ? 'i-volume-x' : (vol < 100 ? 'i-volume-low' : 'i-volume'), 'icon--sm'));
  return b;
}

export function initContextMenu() {
  const scope = (t) => t.closest?.(SCOPE);
  let pressTimer = null;
  let pressStart = null;
  let suppressClick = false;

  document.addEventListener('contextmenu', (e) => {
    const el = scope(e.target);
    if (!el) return;
    e.preventDefault();
    if (menu && anchorEl === el) return; // уже открыто долгим тапом
    openMenuFor(el, e.clientX, e.clientY);
  });

  document.addEventListener('click', (e) => {
    const more = e.target.closest('[data-user-menu]');
    if (more) {
      e.preventDefault();
      e.stopPropagation();
      const el = scope(more);
      if (menu && anchorEl === el) { closeMenu(); return; }
      const r = more.getBoundingClientRect();
      openMenuFor(el, r.left, r.bottom + 4);
      return;
    }
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);

  // долгий тап на сенсорных экранах
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = scope(e.target);
    if (!el || e.target.closest('button')) return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (openMenuFor(el, pressStart.x, pressStart.y)) {
        suppressClick = true;
        navigator.vibrate?.(10);
      }
    }, LONG_PRESS_MS);
  }, { passive: true });
  const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
  document.addEventListener('pointermove', (e) => {
    if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancel();
  }, { passive: true });
  document.addEventListener('pointerup', () => { cancel(); setTimeout(() => { suppressClick = false; }, 400); });
  document.addEventListener('pointercancel', cancel);

  // клавиатура: Shift+F10 / клавиша «меню» на сфокусированном тайле
  document.addEventListener('keydown', (e) => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    const el = scope(document.activeElement || document.body);
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    openMenuFor(el, r.left + 12, r.top + 12);
  });
}

export const isMenuOpen = () => !!menu;
