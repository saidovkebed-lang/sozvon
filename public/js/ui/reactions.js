// Реакции на сообщения: «пилюли» под сообщением (эмодзи + счётчик, моя — подсвечена, tooltip с именами),
// пикер эмодзи (частые + последние в localStorage), меню сообщения по правому клику / долгому тапу.
// Сервер: reaction:add / reaction:remove → всем, кто видит канал, message:reactions (server/reactions.js).
import { $, h, icon, displayName, lsGet, lsSet } from '../util.js';
import { state, getChannel, getServer, getDm, findUser } from '../state.js';
import { can } from '../perms.js';
import { emitAck } from '../socket.js';
import { toastError, toast } from './toasts.js';
import { closeMenu as closeUserMenu } from './context-menu.js';

const FREQUENT = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '👎', '😡', '🙏', '💯', '👏', '🤔', '😍', '😎',
  '🥲', '😭', '🤯', '🥳', '💀', '🤡', '😴', '🤝', '✅', '❌', '⭐', '🚀', '🍿', '🎮', '🎧', '☕'];
const RECENT_KEY = 'sozvon.reactions.recent';
const RECENT_MAX = 8;
const QUICK = 6;          // эмодзи в строке быстрых реакций меню сообщения
const TIP_NAMES = 10;     // имён в подсказке, дальше — «и ещё N»
const MAX_REACTIONS = 20; // как на сервере
const LONG_PRESS_MS = 500;

const box = () => $('#messages');
let popup = null;         // открытый пикер или меню сообщения
let popupAnchor = null;
let restoreFocus = null;
let tip = null;

/* ---------- последние использованные ---------- */
function recent() {
  try {
    const v = JSON.parse(lsGet(RECENT_KEY, '[]'));
    return Array.isArray(v) ? v.filter((e) => typeof e === 'string' && e.length <= 32).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function remember(emoji) {
  lsSet(RECENT_KEY, JSON.stringify([emoji, ...recent().filter((e) => e !== emoji)].slice(0, RECENT_MAX)));
}
/** Быстрые: сначала свои последние, потом частые */
const quickList = (n) => [...new Set([...recent(), ...FREQUENT])].slice(0, n);

/* ---------- права (окончательно решает сервер) ---------- */
function canReact(channelId) {
  const ch = getChannel(channelId);
  if (!ch || ch.type !== 'text') return false;
  return ch.dm ? !!ch.canMessage : can(getServer(ch.serverId), 'SEND_MESSAGES', ch.id);
}

const findMessage = (channelId, messageId) => state.messages[channelId]?.find((m) => m.id === messageId) || null;
const messageNode = (messageId) => box()?.querySelector(`.message[data-message-id="${CSS.escape(messageId)}"]`) || null;

function nameOf(userId, channelId) {
  if (userId === state.user?.id) return 'Вы';
  const ch = getChannel(channelId);
  const u = findUser(userId, getServer(ch?.serverId)) || (ch?.dm && getDm(ch.id)?.user?.id === userId ? getDm(ch.id).user : null);
  return u ? displayName(u) : 'Кто-то';
}

function tipText(r, channelId) {
  const ids = [...r.userIds].sort((a, b) => (b === state.user?.id) - (a === state.user?.id)); // «Вы» — первым
  const names = ids.slice(0, TIP_NAMES).map((id) => nameOf(id, channelId));
  const rest = ids.length - names.length;
  let who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
  if (rest > 0) who = `${names.join(', ')} и ещё ${rest}`;
  return `${who}: ${r.emoji}`;
}

/* ---------- пилюли ---------- */
/** Блок реакций под сообщением (null — реакций нет) */
export function reactionsEl(m) {
  if (!m.reactions?.length) return null;
  const me = state.user?.id;
  const allowed = canReact(m.channelId);
  const pills = m.reactions.map((r) => {
    const mine = r.userIds.includes(me);
    const n = r.userIds.length;
    return h('button', {
      type: 'button', class: 'reaction' + (mine ? ' is-mine' : '') + (!mine && !allowed ? ' is-locked' : ''),
      'aria-pressed': String(mine), 'aria-disabled': !mine && !allowed ? 'true' : null,
      'aria-label': `${r.emoji}: ${n}. ${mine ? 'Снять реакцию' : 'Поставить реакцию'}`,
      dataset: { reaction: r.emoji },
    }, h('span', { class: 'reaction__emoji' }, r.emoji), h('span', { class: 'reaction__count' }, String(n)));
  });
  if (allowed && m.reactions.length < MAX_REACTIONS) {
    pills.push(h('button', {
      type: 'button', class: 'reaction reaction--add', title: 'Добавить реакцию', 'aria-label': 'Добавить реакцию',
      dataset: { reactPick: '' },
    }, icon('i-smile', 'icon--sm')));
  }
  return h('div', { class: 'reactions', role: 'group', 'aria-label': 'Реакции' }, pills);
}

/** Кнопка «Добавить реакцию» для панели действий сообщения */
export function reactButton(m) {
  if (!canReact(m.channelId)) return null;
  return h('button', {
    type: 'button', class: 'icon-btn message__action message__react',
    'aria-label': 'Добавить реакцию', title: 'Добавить реакцию', 'aria-haspopup': 'dialog',
    dataset: { reactPick: '' },
  }, icon('i-smile', 'icon--sm'));
}

/** Перерисовать реакции одного сообщения на месте (без перерисовки ленты) */
function patchMessage(m) {
  const el = messageNode(m.id);
  const body = el?.querySelector('.message__body');
  if (!body) return;
  const list = box();
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const next = reactionsEl(m);
  const old = body.querySelector(':scope > .reactions');
  if (old && next) old.replaceWith(next);
  else if (old) old.remove();
  else if (next) body.append(next);
  if (stick) list.scrollTop = list.scrollHeight;
  if (tip && !document.contains(tip.anchor)) hideTip();
}

function apply(channelId, messageId, reactions) {
  const m = findMessage(channelId, messageId);
  if (!m) return;
  if (reactions?.length) m.reactions = reactions; else delete m.reactions;
  patchMessage(m);
}

/** Поставить/снять. on: true/false; undefined — переключить */
export async function toggleReaction(channelId, messageId, emoji, on) {
  const m = findMessage(channelId, messageId);
  const mine = !!m?.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(state.user?.id);
  const add = on ?? !mine;
  if (add && !canReact(channelId)) { toast('Здесь нельзя ставить реакции'); return; }
  if (add) remember(emoji);
  try {
    const res = await emitAck(add ? 'reaction:add' : 'reaction:remove', { channelId, messageId, emoji });
    apply(channelId, messageId, res.reactions);
  } catch (e) { toastError(e); }
}

/* ---------- подсказка с именами ---------- */
function showTip(pill) {
  const msgEl = pill.closest('.message');
  const m = msgEl && findMessage(state.currentChannelId, msgEl.dataset.messageId);
  const r = m?.reactions?.find((x) => x.emoji === pill.dataset.reaction);
  if (!r) return;
  hideTip();
  tip = h('div', { class: 'reaction-tip', role: 'tooltip' }, tipText(r, m.channelId));
  tip.anchor = pill;
  document.body.append(tip);
  const a = pill.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const left = Math.max(8, Math.min(a.left + a.width / 2 - tip.offsetWidth / 2, vw - tip.offsetWidth - 8));
  const top = a.top - tip.offsetHeight - 6 < 8 ? a.bottom + 6 : a.top - tip.offsetHeight - 6;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
function hideTip() { tip?.remove(); tip = null; }

/* ---------- всплывающие окна: пикер и меню сообщения ---------- */
function place(el, x, y) {
  const pad = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = x; let top = y;
  if (left + el.offsetWidth + pad > vw) left = x - el.offsetWidth;
  if (top + el.offsetHeight + pad > vh) top = vh - el.offsetHeight - pad;
  el.style.left = `${Math.round(Math.max(pad, Math.min(left, vw - el.offsetWidth - pad)))}px`;
  el.style.top = `${Math.round(Math.max(pad, top))}px`;
}

function openPopup(el, anchor, x, y) {
  closePopup(false);
  closeUserMenu(false);
  hideTip();
  restoreFocus = document.activeElement;
  popup = el;
  popupAnchor = anchor;
  anchor?.classList.add('is-reacting');
  document.body.append(el);
  place(el, x, y);
  (el.querySelector('button') || el).focus({ preventScroll: true });
  setTimeout(() => {
    if (popup !== el) return;
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
  }, 0);
  document.addEventListener('keydown', onKey, true);
}

export function closePopup(focusBack = true) {
  if (!popup) return;
  popup.remove();
  popup = null;
  popupAnchor?.classList.remove('is-reacting');
  popupAnchor = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  if (focusBack && restoreFocus && document.contains(restoreFocus)) restoreFocus.focus?.({ preventScroll: true });
  restoreFocus = null;
}
function onOutside(e) { if (popup && !popup.contains(e.target)) closePopup(false); }
function onScroll(e) { if (popup && !popup.contains(e.target)) closePopup(false); }
function onResize() { closePopup(false); }
function onKey(e) {
  if (!popup) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup(); return; }
  if (e.target.matches?.('input')) return;
  const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: popup.classList.contains('reaction-picker') ? 8 : 1, ArrowUp: popup.classList.contains('reaction-picker') ? -8 : -1 };
  if (!(e.key in keys)) return;
  const f = [...popup.querySelectorAll('button:not(:disabled)')];
  const i = f.indexOf(document.activeElement);
  e.preventDefault();
  f[Math.max(0, Math.min(f.length - 1, i < 0 ? 0 : i + keys[e.key]))]?.focus();
}

const emojiBtn = (e, cls = 'emoji-btn') => h('button', { type: 'button', class: cls, dataset: { pickEmoji: e }, 'aria-label': e, title: e }, e);

/** Пикер реакций: последние + частые + поле «свой эмодзи» */
export function openPicker(msgEl, anchor, x, y) {
  const { channelId, messageId } = ids(msgEl);
  const rec = recent();
  const input = h('input', {
    type: 'text', class: 'input reaction-picker__input', placeholder: 'Свой эмодзи — вставьте и Enter',
    maxlength: '32', 'aria-label': 'Свой эмодзи', autocomplete: 'off',
  });
  const el = h('div', { class: 'reaction-picker', role: 'dialog', 'aria-label': 'Выбор реакции', tabindex: '-1' },
    rec.length ? h('div', { class: 'reaction-picker__title' }, 'Недавние') : null,
    rec.length ? h('div', { class: 'reaction-picker__grid' }, rec.map((e) => emojiBtn(e))) : null,
    h('div', { class: 'reaction-picker__title' }, 'Частые'),
    h('div', { class: 'reaction-picker__grid' }, FREQUENT.map((e) => emojiBtn(e))),
    input);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-emoji]');
    if (!b) return;
    closePopup();
    toggleReaction(channelId, messageId, b.dataset.pickEmoji, true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const v = input.value.trim();
    // одна графема-эмодзи; окончательная проверка — на сервере
    const one = [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(v)].length === 1;
    if (!v || !one || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(v)) { toast('Вставьте один эмодзи'); return; }
    closePopup();
    toggleReaction(channelId, messageId, v, true);
  });
  const r = anchor?.getBoundingClientRect();
  openPopup(el, msgEl, x ?? (r ? r.right - 300 : 16), y ?? (r ? r.bottom + 4 : 16));
}

/** Меню сообщения: быстрые реакции, «Добавить реакцию», копировать текст, удалить (если можно) */
function openMessageMenu(msgEl, x, y) {
  const { channelId, messageId } = ids(msgEl);
  const m = findMessage(channelId, messageId);
  if (!m) return false;
  const items = [];
  if (canReact(channelId)) {
    items.push(h('div', { class: 'reaction-quick', role: 'group', 'aria-label': 'Быстрые реакции' },
      quickList(QUICK).map((e) => {
        const mine = !!m.reactions?.find((r) => r.emoji === e)?.userIds.includes(state.user?.id);
        return h('button', {
          type: 'button', class: 'emoji-btn reaction-quick__btn' + (mine ? ' is-mine' : ''), 'aria-pressed': String(mine),
          'aria-label': e, title: e, onclick: () => { closePopup(); toggleReaction(channelId, messageId, e); },
        }, e);
      })));
    items.push(h('button', {
      type: 'button', class: 'context-menu__item', role: 'menuitem', dataset: { action: 'react' },
      onclick: () => { const r = msgEl.getBoundingClientRect(); openPicker(msgEl, null, x, Math.max(y, r.top)); },
    }, icon('i-smile', 'icon--sm'), h('span', null, 'Добавить реакцию')));
  }
  if (m.content) {
    items.push(h('button', {
      type: 'button', class: 'context-menu__item', role: 'menuitem', dataset: { action: 'copy' },
      onclick: () => {
        closePopup();
        navigator.clipboard?.writeText(m.content).then(() => toast('Текст скопирован', '', 1500), () => toast('Не удалось скопировать'));
      },
    }, icon('i-copy', 'icon--sm'), h('span', null, 'Копировать текст')));
  }
  const del = msgEl.querySelector('[data-delete-message]');
  if (del) {
    items.push(h('div', { class: 'context-menu__sep', role: 'separator' }));
    items.push(h('button', {
      type: 'button', class: 'context-menu__item context-menu__item--danger', role: 'menuitem', dataset: { action: 'delete' },
      onclick: () => { closePopup(false); del.click(); },
    }, icon('i-trash', 'icon--sm'), h('span', null, 'Удалить сообщение')));
  }
  if (!items.length) return false;
  openPopup(h('div', { class: 'context-menu message-menu', role: 'menu', tabindex: '-1', 'aria-label': 'Действия с сообщением' }, items), msgEl, x, y);
  return true;
}

const ids = (msgEl) => ({ channelId: state.currentChannelId, messageId: msgEl.dataset.messageId });

// правый клик по автору/аватару — меню участника (context-menu.js); по ссылкам/медиа — меню браузера
const NATIVE = '.message__author, .message > .avatar, a, img, video, audio, input, textarea';

export function initReactions(on) {
  on('message:reactions', ({ channelId, messageId, reactions }) => apply(channelId, messageId, reactions));

  const list = box();
  list.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-react-pick]');
    if (pick) {
      const msgEl = pick.closest('.message');
      if (popup && popupAnchor === msgEl && popup.classList.contains('reaction-picker')) { closePopup(); return; }
      openPicker(msgEl, pick);
      return;
    }
    const pill = e.target.closest('[data-reaction]');
    if (!pill) return;
    const msgEl = pill.closest('.message');
    if (pill.classList.contains('is-locked')) { toast('Здесь нельзя ставить реакции'); return; }
    hideTip();
    toggleReaction(state.currentChannelId, msgEl.dataset.messageId, pill.dataset.reaction);
  });

  // подсказка «кто поставил»: наведение мышью и фокус с клавиатуры
  list.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const pill = e.target.closest('[data-reaction]');
    if (pill && tip?.anchor !== pill) showTip(pill);
  });
  list.addEventListener('pointerout', (e) => {
    const pill = e.target.closest('[data-reaction]');
    if (pill && !pill.contains(e.relatedTarget)) hideTip();
  });
  list.addEventListener('focusin', (e) => { const pill = e.target.closest('[data-reaction]'); if (pill) showTip(pill); });
  list.addEventListener('focusout', (e) => { if (e.target.closest('[data-reaction]')) hideTip(); });
  list.addEventListener('scroll', hideTip, { passive: true });

  // меню сообщения: правый клик (слушатель на ленте срабатывает раньше документного из context-menu.js)
  list.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.message[data-message-id]');
    if (!msgEl || e.target.closest(NATIVE) || String(window.getSelection?.() || '').trim()) return;
    if (openMessageMenu(msgEl, e.clientX, e.clientY)) e.preventDefault();
  });

  // долгий тап на сенсорных экранах; следующий за ним click не должен попасть в пункт меню
  let pressTimer = null;
  let pressStart = null;
  let suppressClick = false;
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const msgEl = e.target.closest('.message[data-message-id]');
    if (!msgEl || e.target.closest(NATIVE) || e.target.closest('button')) return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (openMessageMenu(msgEl, pressStart.x, pressStart.y)) { suppressClick = true; navigator.vibrate?.(10); }
    }, LONG_PRESS_MS);
  }, { passive: true });
  const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
  list.addEventListener('pointermove', (e) => {
    if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancel();
  }, { passive: true });
  document.addEventListener('pointerup', () => { cancel(); setTimeout(() => { suppressClick = false; }, 400); });
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);
}
