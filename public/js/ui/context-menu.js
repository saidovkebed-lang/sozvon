// Контекстное меню собеседника: громкость 0–200 %, «Заглушить локально»; для бота — громкость музыки.
// Открывается: правый клик / долгий тап (500 мс) / кнопка «⋯» на .voice-user (сайдбар) и .tile (сцена).
import { h, icon, avatar } from '../util.js';
import { state, getServer } from '../state.js';
import { prefs } from '../prefs.js';
import { openUserSettings } from './user-settings.js';

const LONG_PRESS_MS = 500;
let menu = null;
let anchorEl = null;
let restoreFocus = null;

function findUser(target) {
  const el = target.closest('.voice-user[data-user-id], .tile[data-socket-id]');
  if (!el) return null;
  let userId = el.dataset.userId || null;
  const sid = el.dataset.socketId;
  let member = null;
  for (const list of Object.values(state.voice)) {
    member = (list || []).find((m) => (sid && m.socketId === sid) || (userId && m.userId === userId)) || null;
    if (member) break;
  }
  if (!userId) userId = member?.userId || (el.dataset.self === 'true' ? state.user?.id : null);
  if (!userId) return null;
  let isBot = !!member?.isBot || el.classList.contains('voice-user--bot') || el.classList.contains('tile--bot');
  let username = member?.username || el.querySelector('.voice-user__name, .tile__label > span')?.textContent || '';
  let color = member?.color;
  if (!member) {
    const srv = getServer();
    const u = srv?.members.find((m) => m.id === userId);
    if (u) { username = u.username; color = u.color; isBot = isBot || !!u.isBot; }
  }
  return { el, userId, isBot, username: username.replace(/ — экран$/, ''), color, self: userId === state.user?.id };
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

function buildMenu(u) {
  const items = [];
  items.push(h('div', { class: 'context-menu__head' },
    avatar({ username: u.username, color: u.color }, 'sm'),
    h('span', { class: 'context-menu__name' }, u.username),
    u.isBot ? h('span', { class: 'badge badge--bot' }, 'БОТ') : null,
    u.self ? h('span', { class: 'context-menu__you' }, 'это вы') : null));
  if (u.self) {
    items.push(h('button', {
      type: 'button', class: 'context-menu__item', role: 'menuitem',
      onclick: () => { closeMenu(false); openUserSettings('voice'); },
    }, icon('i-settings', 'icon--sm'), 'Настройки голоса'));
  } else if (u.isBot) {
    items.push(volumeRow({
      label: 'Громкость музыки', value: prefs.get('audio.musicVolume'), max: 100, action: 'music-volume', resetTo: 70,
      onInput: (v) => prefs.set('audio.musicVolume', v),
    }));
    items.push(h('p', { class: 'context-menu__hint' }, 'Только для вас — у остальных своя громкость.'));
  } else {
    items.push(volumeRow({
      label: 'Громкость пользователя', value: prefs.getUserVolume(u.userId), max: 200, action: 'user-volume', resetTo: 100,
      onInput: (v) => prefs.setUserVolume(u.userId, v),
    }));
    const cb = h('input', { type: 'checkbox', class: 'switch switch--sm', dataset: { action: 'mute-user' }, id: 'cm-mute' });
    cb.checked = prefs.isUserMuted(u.userId);
    cb.addEventListener('change', () => prefs.setUserMuted(u.userId, cb.checked));
    items.push(h('label', { class: 'context-menu__item context-menu__item--check', for: 'cm-mute' },
      icon('i-volume-x', 'icon--sm'), h('span', null, 'Заглушить локально'), cb));
    items.push(h('p', { class: 'context-menu__hint' }, 'Слышите только вы. Двойной клик по ползунку — 100%.'));
  }
  return items;
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

export function openMenuFor(target, x, y) {
  const u = findUser(target);
  if (!u) return false;
  closeMenu(false);
  restoreFocus = document.activeElement;
  anchorEl = u.el;
  anchorEl.classList.add('is-menu-open');
  menu = h('div', {
    class: 'context-menu', role: 'menu', tabindex: '-1',
    'aria-label': u.self ? 'Ваше меню' : `Меню: ${u.username}`,
    dataset: { userId: u.userId },
  }, ...buildMenu(u));
  (document.querySelector('dialog[open]') || document.body).append(menu);
  position(menu, x, y);
  const first = menu.querySelector('input, button');
  (first || menu).focus({ preventScroll: true });
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
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  else if (e.key === 'Tab') {
    const f = [...menu.querySelectorAll('input, button')];
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
  const scope = (t) => t.closest?.('#channels .voice-user[data-user-id], #stage-grid .tile[data-socket-id]');
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
