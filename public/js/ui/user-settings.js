// Полноэкранная модалка «Настройки пользователя» (#modal-user-settings), как в Discord:
// слева разделы, справа содержимое. Все настройки — prefs.get/set с мгновенным применением
// (без кнопки «Сохранить», кроме смены пароля). На узком экране — список разделов → экран раздела.
import { $, $$, h, icon, safeColor, firstLetter, setAvatarImage, safeMediaUrl, displayName } from '../util.js';
import { state, subscribe, applyUserUpdate } from '../state.js';
import { getToken } from '../api.js';
import { prefs, DEFAULTS } from '../prefs.js';
import { confirmDialog } from './modals.js';
import { toast, toastOk, toastError } from './toasts.js';
import { previewSound } from './sounds.js';
import { codeLabel, comboFromEvent, isModifierCode, setCapturing } from './keybinds.js';
import { canNotify, requestDesktopPermission } from './notifications.js';
import { pushSupport, pushActive, enablePush, disablePush } from '../push.js';
import { api } from '../api.js';
import { profileCard } from './profile.js';
import { openCropper } from './cropper.js';
import { renderDownloads } from '../download.js';

export const APP_VERSION = '3.0.0';
const GITHUB_URL = 'https://github.com/saidovkebed-lang/sozvon';

const SECTIONS = [
  { id: 'account', title: 'Моя учётная запись', icon: 'i-user', group: 'Настройки пользователя' },
  { id: 'profile', title: 'Профиль', icon: 'i-pencil' },
  { id: 'voice', title: 'Голос и видео', icon: 'i-mic', group: 'Настройки приложения' },
  { id: 'appearance', title: 'Внешний вид', icon: 'i-palette' },
  { id: 'notifications', title: 'Уведомления', icon: 'i-bell' },
  { id: 'keybinds', title: 'Горячие клавиши', icon: 'i-keyboard' },
  { id: 'about', title: 'О приложении', icon: 'i-info', group: '' },
];

import { AVATAR_PALETTE } from './palette.js';
export { AVATAR_PALETTE };

const MOBILE = '(max-width: 639.98px)';
const dlg = () => $('#modal-user-settings');
let current = 'account';
let built = false;
let returnFocus = null;
let onLogout = () => {};

/* ============================================================
   Звуковой движок (агент voice) — подгружаем лениво: до его готовности настройки работают без теста
   ============================================================ */
let engine = null;
let enginePromise = null;
export function loadEngine() {
  if (!enginePromise) {
    enginePromise = import('../audio/engine.js')
      .then((mod) => { engine = mod.audioEngine || mod.default || null; return engine; })
      .catch(() => { engine = null; return null; });
  }
  return enginePromise;
}

/* ============================================================
   Примитивы контролов
   ============================================================ */
let uid = 0;
const nextId = (p) => `us-${p}-${++uid}`;

function section(title, ...children) {
  return h('div', { class: 'settings-block' },
    title ? h('h3', { class: 'settings-block__title' }, title) : null,
    ...children);
}

function hint(text, cls = '') {
  return h('p', { class: 'settings-hint' + (cls ? ` ${cls}` : '') }, text);
}

/** Переключатель-строка: заголовок + описание слева, switch справа */
function switchRow(key, label, desc, { disabled = false } = {}) {
  const id = nextId('sw');
  const descId = desc ? `${id}-d` : null;
  const input = h('input', {
    type: 'checkbox', class: 'switch', id, role: 'switch',
    dataset: { pref: key }, 'aria-describedby': descId, disabled,
  });
  return h('div', { class: 'setting' },
    h('div', { class: 'setting__text' },
      h('label', { class: 'setting__label', for: id }, label),
      desc ? h('p', { class: 'setting__desc', id: descId }, desc) : null),
    input);
}

/** Группа радиокнопок-карточек */
function choiceGroup(key, legend, options, { cls = '' } = {}) {
  const name = nextId('r');
  return h('fieldset', { class: 'choices' + (cls ? ` ${cls}` : '') },
    legend ? h('legend', { class: 'field__label' }, legend) : null,
    ...options.map((o) => h('label', { class: 'choice' + (o.disabled ? ' is-disabled' : ''), dataset: { value: o.value } },
      h('input', { type: 'radio', name, value: o.value, dataset: { pref: key }, disabled: !!o.disabled }),
      h('span', { class: 'choice__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'choice__text' },
        h('span', { class: 'choice__label' }, o.label,
          o.badge ? h('span', { class: 'choice__badge' }, o.badge) : null),
        o.hint ? h('span', { class: 'choice__hint' }, o.hint) : null))));
}

/** Ползунок с подписью значения */
function sliderField(key, label, { min = 0, max = 100, step = 1, unit = '%', marks = null, desc = '' } = {}) {
  const id = nextId('sl');
  const out = h('output', { class: 'slider-field__value', for: id });
  const input = h('input', {
    type: 'range', class: 'slider slider--wide', id, min, max, step,
    dataset: { pref: key, unit }, 'aria-describedby': desc ? `${id}-d` : null,
  });
  const field = h('div', { class: 'slider-field' },
    h('div', { class: 'slider-field__head' },
      h('label', { class: 'field__label', for: id }, label), out),
    input,
    marks ? h('div', { class: 'slider-field__marks', 'aria-hidden': 'true' },
      ...marks.map((m) => h('span', { style: { '--pos': `${((m - min) / (max - min)) * 100}%` } }, `${m}${unit === '%' ? '%' : ''}`))) : null,
    desc ? h('p', { class: 'setting__desc', id: `${id}-d` }, desc) : null);
  // двойной клик — значение по умолчанию
  input.addEventListener('dblclick', () => { prefs.set(key, DEFAULTS[key]); });
  return field;
}

function fmtValue(input, v) {
  const unit = input.dataset.unit;
  if (unit === 'dB') return `${v} дБ`;
  if (unit === 'ms') return `${v} мс`;
  return `${v}%`;
}

function paintSlider(input) {
  const min = Number(input.min); const max = Number(input.max);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--val', `${pct}%`);
  const text = fmtValue(input, input.value);
  input.setAttribute('aria-valuetext', text);
  const out = input.closest('.slider-field')?.querySelector('.slider-field__value');
  if (out) out.textContent = text;
}

/** Кнопка захвата клавиши / сочетания */
function keyCapture(key, { single = false, label = '' } = {}) {
  const btn = h('button', {
    type: 'button', class: 'keycap-btn', dataset: { pref: key, capture: single ? 'key' : 'combo', keybindCapture: '' },
    'aria-label': label,
  });
  return btn;
}

function renderKeycap(btn) {
  const key = btn.dataset.pref;
  const v = prefs.get(key);
  btn.replaceChildren();
  if (btn.classList.contains('is-capturing')) {
    btn.append(h('span', { class: 'keycap-btn__wait' }, 'Нажмите клавишу…'));
    return;
  }
  if (!v) { btn.append(h('span', { class: 'keycap-btn__empty' }, 'Не назначено')); }
  else {
    const parts = btn.dataset.capture === 'key' ? [codeLabel(v)] : String(v).split('+');
    parts.forEach((p, i) => {
      if (i) btn.append(h('span', { class: 'keycap-btn__plus', 'aria-hidden': 'true' }, '+'));
      btn.append(h('kbd', { class: 'kbd' }, p));
    });
  }
  const base = btn.getAttribute('aria-label')?.split(':')[0] || 'Клавиша';
  btn.setAttribute('aria-label', `${base}: ${v ? (btn.dataset.capture === 'key' ? codeLabel(v) : v) : 'не назначено'}. Нажмите, чтобы изменить`);
}

let capture = null; // { btn, onKey }
function startCapture(btn) {
  stopCapture();
  btn.classList.add('is-capturing');
  btn.setAttribute('aria-pressed', 'true');
  setCapturing(true);
  renderKeycap(btn);
  const single = btn.dataset.capture === 'key';
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopCapture(); return; }
    if (single) {
      prefs.set(btn.dataset.pref, e.code);
      stopCapture();
      return;
    }
    if (isModifierCode(e.code)) return; // ждём основную клавишу
    if ((e.code === 'Backspace' || e.code === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      prefs.set(btn.dataset.pref, '');
      stopCapture();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    // конфликт с другой привязкой — снимаем её
    for (const k of ['keybinds.toggleMute', 'keybinds.toggleDeafen']) {
      if (k !== btn.dataset.pref && String(prefs.get(k)).toLowerCase() === combo.toLowerCase()) {
        prefs.set(k, '');
        toast('Это сочетание было назначено на другое действие — там оно снято', '', 3500);
      }
    }
    prefs.set(btn.dataset.pref, combo);
    stopCapture();
  };
  window.addEventListener('keydown', onKey, true);
  const onBlur = () => stopCapture();
  btn.addEventListener('blur', onBlur, { once: true });
  capture = { btn, onKey, onBlur };
}

function stopCapture() {
  if (!capture) return;
  const { btn, onKey, onBlur } = capture;
  capture = null;
  window.removeEventListener('keydown', onKey, true);
  btn.removeEventListener('blur', onBlur);
  btn.classList.remove('is-capturing');
  btn.setAttribute('aria-pressed', 'false');
  // флаг снимаем после текущего события, чтобы горячая клавиша не сработала тем же нажатием
  setTimeout(() => setCapturing(false), 0);
  renderKeycap(btn);
}

/* ---------- синхронизация контролов ↔ prefs ---------- */
function syncControl(el) {
  const key = el.dataset.pref;
  if (!key || !(key in DEFAULTS)) return;
  const v = prefs.get(key);
  if (el.classList.contains('keycap-btn')) { if (!el.classList.contains('is-capturing')) renderKeycap(el); return; }
  if (el.type === 'checkbox') el.checked = !!v;
  else if (el.type === 'radio') el.checked = String(v) === el.value;
  else if (el.type === 'range') { if (document.activeElement !== el || String(el.value) !== String(v)) el.value = String(v); paintSlider(el); }
  else if (el.tagName === 'SELECT') {
    if (![...el.options].some((o) => o.value === v) && v) el.append(h('option', { value: v }, 'Недоступное устройство'));
    el.value = v;
  }
}

function syncAll(root = dlg()) {
  $$('[data-pref]', root).forEach(syncControl);
  updateDependents();
}

function bindControls(root) {
  root.addEventListener('input', (e) => {
    const el = e.target;
    const key = el.dataset?.pref;
    if (!key || !(key in DEFAULTS)) return;
    if (el.type === 'range') { paintSlider(el); prefs.set(key, Number(el.value)); }
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    const key = el.dataset?.pref;
    if (!key || !(key in DEFAULTS)) return;
    if (el.type === 'checkbox') prefs.set(key, el.checked);
    else if (el.type === 'radio') { if (el.checked) prefs.set(key, typeof DEFAULTS[key] === 'number' ? Number(el.value) : el.value); }
    else if (el.tagName === 'SELECT') prefs.set(key, el.value);
  });
  root.addEventListener('click', (e) => {
    const cap = e.target.closest('.keycap-btn');
    if (cap) { if (cap.classList.contains('is-capturing')) stopCapture(); else startCapture(cap); return; }
    const reset = e.target.closest('[data-reset-pref]');
    if (reset) { prefs.set(reset.dataset.resetPref, DEFAULTS[reset.dataset.resetPref]); return; }
    const snd = e.target.closest('[data-preview-sound]');
    if (snd) previewSound(snd.dataset.previewSound);
  });
}

/** Видимость зависимых блоков (рация, ручная чувствительность, звуки) */
function updateDependents() {
  const root = dlg();
  if (!root) return;
  const ptt = prefs.get('audio.inputMode') === 'ptt';
  $$('[data-when="ptt"]', root).forEach((el) => { el.hidden = !ptt; });
  $$('[data-when="voice"]', root).forEach((el) => { el.hidden = ptt; });
  const manual = !prefs.get('audio.sensitivityAuto');
  $$('.meter', root).forEach((m) => m.classList.toggle('is-manual', manual));
  $$('[data-when="manual"]', root).forEach((el) => { el.hidden = !manual; });
  const thr = prefs.get('audio.sensitivityDb');
  const sv = $('#sens-value');
  if (sv) sv.textContent = `${thr} дБ`;
  $$('.meter__threshold', root).forEach((t) => { t.style.left = `${dbToPct(thr)}%`; });
  $$('.meter', root).forEach((m) => m.style.setProperty('--thr', `${dbToPct(thr)}%`));
  const soundsOn = prefs.get('notifications.sounds');
  $$('[data-when="sounds"] input', root).forEach((el) => { el.disabled = !soundsOn; });
  $$('[data-when="sounds"]', root).forEach((el) => el.classList.toggle('is-disabled', !soundsOn));
  renderDesktopState();
}

/* ============================================================
   Разделы
   ============================================================ */

/* ---------- 1. Учётная запись ---------- */
async function meRequest(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(body),
    });
  } catch { throw new Error('Нет связи с сервером'); }
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (res.status === 404 || res.status === 405) throw new Error('Сервер пока не поддерживает эту функцию — обновите сервер Созвона');
  if (!res.ok) throw new Error(data?.error || `Ошибка сервера (${res.status})`);
  return data || {};
}

function renderAccountCard() {
  const u = state.user;
  const card = $('#settings-account-card');
  if (!card || !u) return;
  const color = safeColor(u.color);
  card.style.setProperty('--c', color);
  $('.account-card__avatar', card).style.setProperty('--c', color);
  const av = $('.account-card__avatar', card);
  av.textContent = firstLetter(u.username);
  setAvatarImage(av, u);
  const bn = $('.account-card__banner', card);
  const bu = safeMediaUrl(u.banner);
  bn.style.backgroundImage = bu ? `url("${bu.replace(/"/g, '%22')}")` : '';
  bn.classList.toggle('has-img', !!bu);
  if (!bu && u.bannerColor) card.style.setProperty('--c', u.bannerColor);
  $('.account-card__name', card).textContent = displayName(u);
  $('.account-card__tag', card).textContent = `@${u.username} · имя пользователя изменить нельзя`;
  $$('[data-color]', dlg()).forEach((b) => {
    const on = b.dataset.color.toLowerCase() === color.toLowerCase();
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
  });
  const custom = $('#settings-color-custom');
  if (custom && document.activeElement !== custom) custom.value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#6a45ff';
  const isCustom = !AVATAR_PALETTE.includes(color.toLowerCase());
  $('.swatch--custom', dlg())?.classList.toggle('is-selected', isCustom);
}

let colorSeq = 0;
async function setColor(color, { silent = false } = {}) {
  if (!state.user || !/^#[0-9a-f]{6}$/i.test(color)) return;
  const prev = state.user.color;
  const seq = ++colorSeq;
  const err = $('#settings-color-error');
  err.textContent = '';
  // предпросмотр сразу
  state.user = { ...state.user, color };
  renderAccountCard();
  try {
    const res = await meRequest('PATCH', '/api/me', { color });
    if (seq !== colorSeq) return;
    applyUserUpdate(res.user || { id: state.user.id, color });
    if (!silent) toastOk('Цвет аватара обновлён');
  } catch (e) {
    if (seq !== colorSeq) return;
    state.user = { ...state.user, color: prev };
    renderAccountCard();
    err.textContent = e.message;
  }
}

function buildAccount() {
  const palette = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Цвет аватара' },
    ...AVATAR_PALETTE.map((c) => h('button', {
      type: 'button', class: 'swatch', role: 'radio', 'aria-checked': 'false',
      dataset: { color: c }, style: { '--c': c }, 'aria-label': `Цвет ${c}`, title: c,
    }, icon('i-check', 'swatch__check'))),
    h('label', { class: 'swatch swatch--custom', title: 'Свой цвет' },
      h('input', { type: 'color', id: 'settings-color-custom', 'aria-label': 'Свой цвет аватара' }),
      icon('i-palette', 'swatch__icon')));
  palette.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (b) setColor(b.dataset.color);
  });
  let colorTimer = null;
  palette.addEventListener('input', (e) => {
    if (e.target.id !== 'settings-color-custom') return;
    const c = e.target.value;
    state.user = state.user && { ...state.user, color: c };
    renderAccountCard();
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => setColor(c, { silent: true }), 400);
  });

  const pwForm = h('form', { class: 'form password-form', id: 'form-password', novalidate: true },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', hidden: true, value: state.user?.username || '' }),
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'settings-old-password' }, 'Текущий пароль'),
      h('input', { class: 'input', id: 'settings-old-password', type: 'password', autocomplete: 'current-password', required: true })),
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' },
        h('label', { class: 'field__label', for: 'settings-new-password' }, 'Новый пароль'),
        h('input', { class: 'input', id: 'settings-new-password', type: 'password', autocomplete: 'new-password', minlength: '4', maxlength: '128', required: true })),
      h('div', { class: 'field' },
        h('label', { class: 'field__label', for: 'settings-confirm-password' }, 'Повторите новый пароль'),
        h('input', { class: 'input', id: 'settings-confirm-password', type: 'password', autocomplete: 'new-password', required: true }))),
    h('p', { class: 'form__error', id: 'settings-password-error', role: 'alert' }),
    h('div', { class: 'form__actions' },
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Сменить пароль')));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#settings-password-error');
    const oldPassword = $('#settings-old-password').value;
    const newPassword = $('#settings-new-password').value;
    const confirm = $('#settings-confirm-password').value;
    $$('.input', pwForm).forEach((i) => i.removeAttribute('aria-invalid'));
    const fail = (msg, el) => { err.textContent = msg; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };
    if (!oldPassword) return fail('Введите текущий пароль', $('#settings-old-password'));
    if (newPassword.length < 4) return fail('Новый пароль должен быть не короче 4 символов', $('#settings-new-password'));
    if (newPassword !== confirm) return fail('Пароли не совпадают', $('#settings-confirm-password'));
    if (newPassword === oldPassword) return fail('Новый пароль совпадает с текущим', $('#settings-new-password'));
    err.textContent = '';
    const btn = pwForm.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await meRequest('POST', '/api/me/password', { oldPassword, newPassword });
      pwForm.reset();
      toastOk('Пароль изменён. Другие сеансы завершены');
    } catch (ex) {
      fail(ex.message);
    } finally { btn.disabled = false; }
  });

  return [
    h('div', { class: 'account-card', id: 'settings-account-card' },
      h('div', { class: 'account-card__banner', 'aria-hidden': 'true' }),
      h('div', { class: 'account-card__body' },
        h('div', { class: 'avatar avatar--xl account-card__avatar', 'aria-hidden': 'true' }),
        h('div', { class: 'account-card__who' },
          h('div', { class: 'account-card__name' }),
          h('div', { class: 'account-card__tag' }, 'Имя пользователя изменить нельзя')))),
    section('Цвет аватара',
      hint('Цвет кружка с буквой — его видят все участники ваших серверов.'),
      palette,
      h('p', { class: 'form__error', id: 'settings-color-error', role: 'alert' })),
    section('Пароль', pwForm),
    section('',
      h('div', { class: 'setting setting--danger' },
        h('div', { class: 'setting__text' },
          h('span', { class: 'setting__label' }, 'Выйти из аккаунта'),
          h('p', { class: 'setting__desc' }, 'На этом устройстве. Настройки приложения сохранятся.')),
        h('button', { type: 'button', class: 'btn btn--danger', onclick: () => onLogout() }, icon('i-logout'), 'Выйти'))),
  ];
}

/* ---------- 1b. Профиль (v3 §2.3) ---------- */
let draft = null;          // несохранённые текстовые поля профиля
let profileBusy = false;

const PROFILE_KEYS = ['displayName', 'pronouns', 'about', 'bannerColor', 'profileTheme'];

function profileDraftFromUser() {
  const u = state.user || {};
  return {
    displayName: u.displayName || '',
    pronouns: u.pronouns || '',
    about: u.about || '',
    bannerColor: u.bannerColor || null,
    profileTheme: u.profileTheme ? { ...u.profileTheme } : null,
  };
}

function profileDirty() {
  if (!draft) return false;
  const cur = profileDraftFromUser();
  return JSON.stringify(cur) !== JSON.stringify(draft);
}

function renderProfilePreview() {
  const box = $('#profile-preview');
  if (!box || !state.user) return;
  const u = { ...state.user, ...draft, displayName: draft?.displayName?.trim() || null };
  box.replaceChildren(profileCard(u, { preview: true }));
  $('#profile-save-bar').hidden = !profileDirty();
  const about = $('#profile-about');
  if (about) $('#profile-about-count').textContent = `${about.value.length}/190`;
  $('#profile-avatar-remove').hidden = !(state.user.avatar || state.user.avatarAnimated);
  $('#profile-banner-remove').hidden = !(state.user.banner || state.user.bannerAnimated);
  $$('[data-banner-color]', dlg()).forEach((b) => {
    const on = (b.dataset.bannerColor || null) === (draft.bannerColor || null);
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
  });
  const themeOn = !!draft.profileTheme;
  const tsw = $('#profile-theme-on');
  if (tsw) tsw.checked = themeOn;
  $$('.profile-theme__colors', dlg()).forEach((e) => e.classList.toggle('is-disabled', !themeOn));
  if ($('#profile-theme-primary')) {
    $('#profile-theme-primary').disabled = !themeOn;
    $('#profile-theme-accent').disabled = !themeOn;
  }
}

function fillProfileForm() {
  draft = profileDraftFromUser();
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('#profile-display-name', draft.displayName);
  set('#profile-pronouns', draft.pronouns);
  set('#profile-about', draft.about);
  set('#profile-banner-color', draft.bannerColor || safeColor(state.user?.color));
  set('#profile-theme-primary', draft.profileTheme?.primary || '#6a45ff');
  set('#profile-theme-accent', draft.profileTheme?.accent || '#ec4899');
  $('#profile-error') && ($('#profile-error').textContent = '');
  renderProfilePreview();
}

async function uploadProfileMedia(kind, input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file || profileBusy) return;
  const limit = kind === 'avatar' ? 10 : 15;
  if (file.size > limit * 1024 * 1024) { toast(`Файл больше ${limit} МБ`); return; }
  const res = await openCropper(file, { aspect: kind === 'avatar' ? 1 : 960 / 340, round: kind === 'avatar', title: kind === 'avatar' ? 'Аватар' : 'Баннер профиля' });
  if (!res) return;
  profileBusy = true;
  const box = $(kind === 'avatar' ? '#profile-avatar-box' : '#profile-banner-box');
  box?.classList.add('is-busy');
  try {
    const r = kind === 'avatar' ? await api.uploadAvatar(res.file, res.crop) : await api.uploadBanner(res.file, res.crop);
    if (r?.user) applyUserUpdate(r.user);
    toastOk(kind === 'avatar' ? 'Аватар обновлён' : 'Баннер обновлён');
  } catch (e) { toastError(e); } finally {
    profileBusy = false;
    box?.classList.remove('is-busy');
    renderProfilePreview();
  }
}

async function removeProfileMedia(kind) {
  try {
    const r = kind === 'avatar' ? await api.deleteAvatar() : await api.deleteBanner();
    if (r?.user) applyUserUpdate(r.user);
    renderProfilePreview();
  } catch (e) { toastError(e); }
}

async function saveProfile() {
  if (!draft || !state.user) return;
  const err = $('#profile-error');
  const body = {};
  const cur = profileDraftFromUser();
  for (const k of PROFILE_KEYS) if (JSON.stringify(cur[k]) !== JSON.stringify(draft[k])) body[k] = draft[k];
  if ('displayName' in body) body.displayName = draft.displayName.trim() || null;
  if ('about' in body) body.about = draft.about.slice(0, 190);
  if (!Object.keys(body).length) return;
  const btn = $('#btn-profile-save');
  btn.disabled = true;
  err.textContent = '';
  try {
    const r = await api.patchMe(body);
    applyUserUpdate(r?.user || { id: state.user.id, ...body });
    fillProfileForm();
    toastOk('Профиль сохранён');
  } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; }
}

function buildProfile() {
  draft = profileDraftFromUser();
  const avatarInput = h('input', { type: 'file', id: 'profile-avatar-input', accept: 'image/png,image/jpeg,image/webp,image/gif,image/apng', hidden: true });
  const bannerInput = h('input', { type: 'file', id: 'profile-banner-input', accept: 'image/png,image/jpeg,image/webp,image/gif,image/apng', hidden: true });
  avatarInput.addEventListener('change', () => uploadProfileMedia('avatar', avatarInput));
  bannerInput.addEventListener('change', () => uploadProfileMedia('banner', bannerInput));
  const text = (id, label, max, placeholder, key, hintText) => {
    const input = h('input', { class: 'input', id, maxlength: String(max), placeholder, autocomplete: 'off' });
    input.addEventListener('input', () => { draft[key] = input.value; renderProfilePreview(); });
    return h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, hintText ? h('p', { class: 'field__hint' }, hintText) : null);
  };
  const about = h('textarea', { class: 'input', id: 'profile-about', maxlength: '190', rows: '4', placeholder: 'Пара слов о себе. Работает **жирный**, *курсив*, `код` и ссылки.' });
  about.addEventListener('input', () => { draft.about = about.value; renderProfilePreview(); });
  const bannerSwatches = h('div', { class: 'swatches swatches--sm', role: 'radiogroup', 'aria-label': 'Цвет баннера' },
    h('button', { type: 'button', class: 'swatch swatch--none', role: 'radio', dataset: { bannerColor: '' }, title: 'Как цвет аватара', 'aria-label': 'Как цвет аватара' }, icon('i-close', 'swatch__check')),
    ...AVATAR_PALETTE.slice(0, 7).map((c) => h('button', { type: 'button', class: 'swatch', role: 'radio', dataset: { bannerColor: c }, style: { '--c': c }, title: c, 'aria-label': `Цвет ${c}` }, icon('i-check', 'swatch__check'))),
    h('label', { class: 'swatch swatch--custom', title: 'Свой цвет' },
      h('input', { type: 'color', id: 'profile-banner-color', 'aria-label': 'Свой цвет баннера' }), icon('i-palette', 'swatch__icon')));
  bannerSwatches.addEventListener('click', (e) => {
    const b = e.target.closest('[data-banner-color]');
    if (!b) return;
    draft.bannerColor = b.dataset.bannerColor || null;
    renderProfilePreview();
  });
  bannerSwatches.addEventListener('input', (e) => {
    if (e.target.id !== 'profile-banner-color') return;
    draft.bannerColor = e.target.value;
    renderProfilePreview();
  });
  const themeSw = h('input', { type: 'checkbox', class: 'switch', id: 'profile-theme-on', role: 'switch' });
  themeSw.addEventListener('change', () => {
    draft.profileTheme = themeSw.checked ? { primary: $('#profile-theme-primary').value, accent: $('#profile-theme-accent').value } : null;
    renderProfilePreview();
  });
  const themeColor = (id, label) => {
    const inp = h('input', { type: 'color', id, class: 'color-chip__input', 'aria-label': label });
    inp.addEventListener('input', () => {
      if (!draft.profileTheme) return;
      draft.profileTheme = { primary: $('#profile-theme-primary').value, accent: $('#profile-theme-accent').value };
      renderProfilePreview();
    });
    return h('label', { class: 'color-chip' }, inp, h('span', null, label));
  };
  const form = h('div', { class: 'profile-form' },
    section('Аватар',
      h('div', { class: 'media-row', id: 'profile-avatar-box' },
        h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => avatarInput.click() }, icon('i-upload'), 'Сменить аватар'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'profile-avatar-remove', onclick: () => removeProfileMedia('avatar') }, 'Удалить'),
        avatarInput),
      hint('PNG, JPG, WebP или GIF до 10 МБ. Анимированные GIF играют при наведении — как в Discord, только бесплатно.')),
    section('Баннер',
      h('div', { class: 'media-row', id: 'profile-banner-box' },
        h('button', { type: 'button', class: 'btn btn--sm', onclick: () => bannerInput.click() }, icon('i-image'), 'Сменить баннер'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'profile-banner-remove', onclick: () => removeProfileMedia('banner') }, 'Удалить'),
        bannerInput),
      h('span', { class: 'field__label' }, 'Цвет баннера (если нет картинки)'),
      bannerSwatches),
    section('О себе',
      text('profile-display-name', 'Отображаемое имя', 32, state.user?.username || '', 'displayName', 'Видно вместо имени пользователя. @имя для входа не меняется.'),
      text('profile-pronouns', 'Местоимения', 40, 'он/его, она/её…', 'pronouns'),
      h('div', { class: 'field' },
        h('div', { class: 'field__row' }, h('label', { class: 'field__label', for: 'profile-about' }, 'Обо мне'), h('span', { class: 'field__count', id: 'profile-about-count' }, '0/190')),
        about)),
    section('Тема профиля',
      h('div', { class: 'setting' },
        h('div', { class: 'setting__text' }, h('label', { class: 'setting__label', for: 'profile-theme-on' }, 'Цветная тема карточки'), h('p', { class: 'setting__desc' }, 'Градиент из двух цветов на фоне вашего профиля.')),
        themeSw),
      h('div', { class: 'profile-theme__colors' }, themeColor('profile-theme-primary', 'Основной'), themeColor('profile-theme-accent', 'Акцент'))),
    h('p', { class: 'form__error', id: 'profile-error', role: 'alert' }));
  const bar = h('div', { class: 'save-bar save-bar--sticky', id: 'profile-save-bar', hidden: true },
    h('span', { class: 'save-bar__text' }, 'Есть несохранённые изменения'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: fillProfileForm }, 'Сбросить'),
    h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'btn-profile-save', onclick: saveProfile }, 'Сохранить'));
  return [
    h('div', { class: 'profile-layout' },
      form,
      h('aside', { class: 'profile-preview-wrap' },
        h('div', { class: 'field__label' }, 'Предпросмотр'),
        h('div', { class: 'profile-preview', id: 'profile-preview' }))),
    bar,
  ];
}

/* ---------- 2. Голос и видео ---------- */
const DB_MIN = -100;
const dbToPct = (db) => Math.max(0, Math.min(100, ((Number(db) - DB_MIN) / -DB_MIN) * 100));

function meterEl({ withSlider = false } = {}) {
  const m = h('div', { class: 'meter', 'aria-hidden': withSlider ? null : 'true' },
    h('div', { class: 'meter__track' },
      h('div', { class: 'meter__fill' }),
      h('div', { class: 'meter__threshold', title: 'Порог шумового гейта' })));
  if (withSlider) {
    const id = nextId('sens');
    m.append(h('input', {
      type: 'range', class: 'meter__slider', id, min: String(DB_MIN), max: '0', step: '1',
      dataset: { pref: 'audio.sensitivityDb', unit: 'dB' }, 'aria-label': 'Порог чувствительности микрофона',
    }));
  }
  return m;
}

let micStop = null;
let micBusy = false;
function setMicLevel(db, open) {
  const pct = dbToPct(db);
  $$('.meter', dlg()).forEach((m) => {
    m.style.setProperty('--level', `${pct}%`);
    m.classList.toggle('is-open', !!open);
  });
  const lbl = $('#mic-test-db');
  if (lbl) lbl.textContent = Number.isFinite(db) ? `${Math.round(db)} дБ` : '';
}

async function toggleMicTest() {
  const btn = $('#btn-mic-test');
  if (micStop) { stopMicTest(); return; }
  if (micBusy) return;
  if (!engine) {
    toast('Звуковой движок ещё загружается — попробуйте через пару секунд', '', 3000);
    loadEngine();
    return;
  }
  micBusy = true;
  btn.disabled = true;
  try {
    // вызов синхронно из обработчика клика (движок разблокирует AudioContext первой строкой)
    const p = engine.startMicTest({ loopback: !!$('#mic-test-loopback')?.checked, onLevel: setMicLevel });
    const stop = await p;
    micStop = stop;
    btn.classList.add('is-active');
    btn.lastChild.textContent = 'Остановить проверку';
    $('#mic-test-box')?.classList.add('is-testing');
    refreshDevices();
  } catch (e) {
    toastError(e);
  } finally {
    micBusy = false;
    btn.disabled = false;
  }
}

export function stopMicTest() {
  if (!micStop) return;
  try { micStop(); } catch { /* ignore */ }
  micStop = null;
  setMicLevel(-Infinity, false);
  const btn = $('#btn-mic-test');
  if (btn) { btn.classList.remove('is-active'); btn.lastChild.textContent = 'Проверить микрофон'; }
  $('#mic-test-box')?.classList.remove('is-testing');
}

async function listDevicesFallback() {
  const out = { inputs: [{ deviceId: 'default', label: 'По умолчанию' }], outputs: [{ deviceId: 'default', label: 'По умолчанию' }], canSelectOutput: false };
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    let ni = 0; let no = 0;
    for (const d of all) {
      if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
      if (d.kind === 'audioinput') out.inputs.push({ deviceId: d.deviceId, label: d.label || `Микрофон ${++ni}` });
      if (d.kind === 'audiooutput') out.outputs.push({ deviceId: d.deviceId, label: d.label || `Динамики ${++no}` });
    }
    out.canSelectOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  } catch { /* нет mediaDevices (http) */ }
  return out;
}

let devSeq = 0;
async function refreshDevices() {
  const seq = ++devSeq;
  let d;
  try { d = engine?.listDevices ? await engine.listDevices() : await listDevicesFallback(); } catch { d = await listDevicesFallback(); }
  if (seq !== devSeq || !dlg()) return;
  const fill = (sel, list) => {
    if (!sel) return;
    sel.replaceChildren(...list.map((x) => h('option', { value: x.deviceId }, x.label || 'Устройство')));
    syncControl(sel);
  };
  fill($('#settings-input-device'), d.inputs || []);
  fill($('#settings-output-device'), d.outputs || []);
  const out = $('#settings-output-device');
  if (out) {
    out.disabled = !d.canSelectOutput;
    $('#settings-output-note').hidden = !!d.canSelectOutput;
  }
}

function updateRnnoise() {
  const label = dlg()?.querySelector('.choice[data-value="rnnoise"]');
  if (!label) return;
  const input = label.querySelector('input');
  const supported = engine ? !!engine.rnnoiseSupported?.() : true;
  input.disabled = !supported;
  label.classList.toggle('is-disabled', !supported);
  $('#rnnoise-note').hidden = supported;
  const actual = engine?.getNoiseMode?.();
  const fb = $('#rnnoise-fallback');
  if (fb) fb.hidden = !(supported && prefs.get('audio.noiseSuppression') === 'rnnoise' && actual && actual !== 'rnnoise');
  const engineNote = $('#engine-note');
  if (engineNote) engineNote.hidden = !!engine;
}

function buildVoice() {
  const devGrid = h('div', { class: 'form-grid' },
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'settings-input-device' }, 'Устройство ввода'),
      h('select', { class: 'input', id: 'settings-input-device', dataset: { pref: 'audio.inputDeviceId' } },
        h('option', { value: 'default' }, 'По умолчанию'))),
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'settings-output-device' }, 'Устройство вывода'),
      h('select', { class: 'input', id: 'settings-output-device', dataset: { pref: 'audio.outputDeviceId' } },
        h('option', { value: 'default' }, 'По умолчанию')),
      h('p', { class: 'setting__desc', id: 'settings-output-note', hidden: true }, 'Браузер не умеет выбирать устройство вывода — звук идёт в системное по умолчанию.')));
  const volGrid = h('div', { class: 'form-grid' },
    sliderField('audio.inputVolume', 'Громкость микрофона', { min: 0, max: 200, marks: [0, 100, 200] }),
    sliderField('audio.outputVolume', 'Громкость собеседников', { min: 0, max: 200, marks: [0, 100, 200] }));

  const testBtn = h('button', { type: 'button', class: 'btn btn--primary', id: 'btn-mic-test', onclick: toggleMicTest },
    icon('i-mic'), h('span', null, 'Проверить микрофон'));
  const micTest = h('div', { class: 'mic-test', id: 'mic-test-box' },
    h('div', { class: 'mic-test__row' },
      testBtn,
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: 'mic-test-loopback' }), h('span', null, 'Слышать себя')),
      h('span', { class: 'mic-test__db', id: 'mic-test-db', 'aria-live': 'off' })),
    meterEl(),
    hint('Скажите что-нибудь — полоса покажет уровень после шумоподавления и громкости. Зелёным — когда микрофон «открыт» (выше порога).'));

  return [
    h('p', { class: 'settings-note', id: 'engine-note', hidden: true }, icon('i-info', 'icon--sm'),
      'Звуковой движок ещё загружается: проверка микрофона и шумоподавление появятся через несколько секунд.'),
    section('Устройства', devGrid, volGrid),
    section('Проверка микрофона', micTest),
    section('Режим ввода',
      choiceGroup('audio.inputMode', '', [
        { value: 'voice', label: 'По голосу', hint: 'Микрофон включается, когда вы говорите' },
        { value: 'ptt', label: 'Рация (push-to-talk)', hint: 'Говорите, пока зажата клавиша' },
      ], { cls: 'choices--row' }),
      h('div', { class: 'ptt-box', dataset: { when: 'ptt' } },
        h('div', { class: 'setting' },
          h('div', { class: 'setting__text' },
            h('span', { class: 'setting__label', id: 'ptt-key-label' }, 'Клавиша рации'),
            h('p', { class: 'setting__desc' }, 'Нажмите на кнопку и затем нужную клавишу. Esc — отмена.')),
          h('div', { class: 'keycap-group' },
            keyCapture('audio.pttKey', { single: true, label: 'Клавиша рации' }),
            h('button', { type: 'button', class: 'icon-btn', dataset: { resetPref: 'audio.pttKey' }, 'aria-label': 'Сбросить клавишу рации', title: 'Сбросить' }, icon('i-reset', 'icon--sm')))),
        sliderField('audio.pttReleaseDelay', 'Задержка отпускания', { min: 0, max: 1000, step: 20, unit: 'ms', marks: [0, 500, 1000] }),
        h('p', { class: 'settings-note settings-note--warn' }, icon('i-info', 'icon--sm'),
          window.sozvonDesktop?.isDesktop
          ? 'В приложении для ПК клавиша рации работает и в свёрнутом окне — даже в игре.'
          : 'Рация работает, только пока вкладка Созвона активна (в фокусе) — это ограничение браузера. В приложении для ПК клавиша работает и в фоне.'))),
    section('Чувствительность ввода',
      h('div', { dataset: { when: 'voice' } },
        switchRow('audio.sensitivityAuto', 'Определять чувствительность автоматически', 'Созвон сам решит, когда вы говорите. Выключите, чтобы задать порог вручную.'),
        h('div', { class: 'sens', dataset: { when: 'manual' } },
          h('div', { class: 'slider-field__head' },
            h('span', { class: 'field__label' }, 'Порог срабатывания'),
            h('output', { class: 'slider-field__value', id: 'sens-value' })),
          meterEl({ withSlider: true }),
          h('div', { class: 'sens__scale', 'aria-hidden': 'true' }, h('span', null, '−100 дБ'), h('span', null, '−50'), h('span', null, '0 дБ')),
          hint('Звук тише порога не передаётся. Перетащите ползунок так, чтобы при разговоре полоса была зелёной, а в тишине — нет. Включите «Проверить микрофон», чтобы видеть уровень.'))),
      h('p', { class: 'settings-hint', dataset: { when: 'ptt' } }, 'В режиме рации порог не используется — микрофон открыт, пока зажата клавиша.')),
    section('Обработка звука',
      choiceGroup('audio.noiseSuppression', 'Шумоподавление', [
        { value: 'rnnoise', label: 'ИИ-шумоподавление', badge: 'RNNoise', hint: 'Нейросеть убирает клавиатуру, вентилятор и шум улицы, оставляя голос' },
        { value: 'standard', label: 'Стандартное', hint: 'Встроенное в браузер — легче для слабых устройств' },
        { value: 'off', label: 'Выключено', hint: 'Без обработки — для хорошего микрофона в тихой комнате' },
      ]),
      h('p', { class: 'settings-note settings-note--warn', id: 'rnnoise-note', hidden: true }, icon('i-info', 'icon--sm'),
        'ИИ-шумоподавление недоступно в этом браузере (нужны AudioWorklet и WebAssembly). Используйте стандартное.'),
      h('p', { class: 'settings-note settings-note--warn', id: 'rnnoise-fallback', hidden: true }, icon('i-info', 'icon--sm'),
        'ИИ-модель не загрузилась — сейчас работает стандартное шумоподавление.'),
      switchRow('audio.echoCancellation', 'Эхоподавление', 'Убирает звук собеседников, попавший в микрофон из колонок.'),
      switchRow('audio.autoGain', 'Автоматическая регулировка усиления', 'Выравнивает громкость, если вы отходите от микрофона.')),
    section('Демонстрация экрана',
      switchRow('stream.autoWatch', 'Сразу смотреть трансляции', 'Иначе трансляция откроется по кнопке «Смотреть» — пока вы не смотрите, видео не идёт к вам и не грузит процессор и интернет.'),
      switchRow('stream.selfPreview', 'Показывать превью своей демонстрации', 'Видеть свой экран на сцене. Выключено — меньше нагрузка на процессор во время трансляции.')),
    section('',
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => resetKeys(VOICE_KEYS, 'Сбросить настройки голоса?') }, icon('i-reset'), 'Сбросить настройки голоса')),
  ];
}

const VOICE_KEYS = ['audio.inputDeviceId', 'audio.outputDeviceId', 'audio.inputVolume', 'audio.outputVolume', 'audio.noiseSuppression',
  'audio.echoCancellation', 'audio.autoGain', 'audio.inputMode', 'audio.sensitivityAuto', 'audio.sensitivityDb', 'audio.pttKey', 'audio.pttReleaseDelay'];

async function resetKeys(keys, title) {
  const yes = await confirmDialog({ title, text: 'Значения вернутся к стандартным.', ok: 'Сбросить' });
  if (!yes) return;
  for (const k of keys) prefs.set(k, DEFAULTS[k]);
  toastOk('Готово');
}

/* ---------- 3. Внешний вид ---------- */
function themeCard(value, label) {
  return h('label', { class: `theme-card theme-card--${value}`, dataset: { value } },
    h('input', { type: 'radio', name: 'us-theme', value, dataset: { pref: 'appearance.theme' } }),
    h('span', { class: 'theme-card__preview', 'aria-hidden': 'true' },
      h('span', { class: 'tp-side' }, h('i'), h('i'), h('i')),
      h('span', { class: 'tp-main' }, h('b'), h('i'), h('i', { class: 'is-short' }), h('b'), h('i'))),
    h('span', { class: 'theme-card__label' }, h('span', { class: 'choice__dot', 'aria-hidden': 'true' }), label));
}

function buildAppearance() {
  const now = Date.now();
  const me = state.user || { username: 'Вы', color: '#6a45ff' };
  const fake = (author, color, text, grouped = false) => h('div', { class: 'message' + (grouped ? ' message--grouped' : '') },
    h('div', { class: 'avatar', style: { '--c': color }, 'aria-hidden': 'true' }, firstLetter(author)),
    h('div', { class: 'message__body' },
      h('div', { class: 'message__meta' },
        h('span', { class: 'message__author', style: { color } }, author),
        h('time', { class: 'message__time' }, grouped ? '' : `Сегодня в ${new Date(now).toTimeString().slice(0, 5)}`)),
      h('div', { class: 'message__content' }, text)));
  return [
    section('Тема',
      h('fieldset', { class: 'theme-cards' },
        h('legend', { class: 'sr-only' }, 'Тема оформления'),
        themeCard('dark', 'Тёмная'), themeCard('light', 'Светлая'), themeCard('amoled', 'AMOLED'))),
    section('Предпросмотр',
      h('div', { class: 'appearance-preview', 'aria-hidden': 'true' },
        fake('Маша', '#ec4899', 'Ну что, вечером в голосовой? 🎧'),
        fake(me.username, safeColor(me.color), 'Да, после восьми. Включу музыку'),
        fake(me.username, safeColor(me.color), 'Кстати, тему можно сменить в настройках', true))),
    section('Масштаб',
      sliderField('appearance.fontScale', 'Размер шрифта', { min: 80, max: 130, step: 5, marks: [80, 100, 130] }),
      switchRow('appearance.compact', 'Компактный режим сообщений', 'Без аватаров, больше сообщений на экране.')),
    section('Анимации',
      choiceGroup('appearance.reduceMotion', 'Уменьшение движения', [
        { value: 'system', label: 'Как в системе', hint: 'Следовать настройке «уменьшить движение» вашей ОС' },
        { value: 'on', label: 'Уменьшить', hint: 'Выключить анимации и пульсацию' },
        { value: 'off', label: 'Не уменьшать', hint: 'Все анимации, даже если ОС просит меньше' },
      ])),
  ];
}

/* ---------- 4. Уведомления ---------- */
function soundRow(key, label, desc, sound) {
  const row = switchRow(key, label, desc);
  row.dataset.when = 'sounds';
  row.querySelector('.switch').before(h('button', {
    type: 'button', class: 'icon-btn', dataset: { previewSound: sound }, 'aria-label': `Прослушать: ${label}`, title: 'Прослушать',
  }, icon('i-play', 'icon--sm')));
  return row;
}

function renderDesktopState() {
  const box = $('#desktop-perm');
  if (!box) return;
  const sw = dlg().querySelector('[data-pref="notifications.desktop"]');
  const btn = $('#btn-desktop-perm');
  const status = $('#desktop-perm-status');
  if (!canNotify()) {
    status.textContent = 'Этот браузер не поддерживает системные уведомления.';
    btn.hidden = true;
    sw.disabled = true;
    return;
  }
  const p = Notification.permission;
  btn.hidden = p !== 'default';
  sw.disabled = p !== 'granted';
  status.textContent = p === 'granted' ? 'Разрешение получено.'
    : p === 'denied' ? 'Уведомления запрещены в браузере. Разрешите их в настройках сайта (значок замка в адресной строке).'
      : 'Нужно разрешение браузера.';
  box.dataset.perm = p;
  $('[data-pref="notifications.mentionsOnly"]', dlg()).disabled = p !== 'granted' || !prefs.get('notifications.desktop');
}

const PUSH_TEXT = {
  desktop: 'В приложении для ПК уведомления показывает само приложение, даже когда оно свёрнуто в трей.',
  insecure: 'Push работает только по HTTPS.',
  unsupported: 'Этот браузер не поддерживает push-уведомления.',
  'ios-install': 'На iPhone и iPad push работает только у установленного приложения: «Поделиться» → «На экран „Домой“», затем откройте Созвон с главного экрана.',
  'server-off': 'Push-уведомления выключены на сервере.',
  denied: 'Уведомления запрещены в браузере. Разрешите их в настройках сайта (значок замка в адресной строке) и попробуйте снова.',
  default: 'Чтобы включить, разрешите уведомления в запросе браузера.',
};

function renderPushState(msg) {
  const sw = $('#push-switch');
  if (!sw) return;
  const sup = pushSupport();
  sw.disabled = sup !== 'ok';
  sw.checked = sup === 'ok' && pushActive();
  $('#push-status').textContent = msg || (sup !== 'ok' ? PUSH_TEXT[sup]
    : pushActive() ? 'Включено на этом устройстве. Push придёт, когда ни одно окно Созвона не открыто на виду.'
      : 'Выключено на этом устройстве.');
}

function pushRow() {
  const sw = h('input', { type: 'checkbox', class: 'switch', id: 'push-switch', role: 'switch', 'aria-describedby': 'push-status' });
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try {
      if (sw.checked) {
        const res = await enablePush();
        renderPushState(res === 'granted' ? null : PUSH_TEXT[res] || null);
      } else {
        await disablePush();
        renderPushState();
      }
    } catch (e) {
      renderPushState(`Не получилось: ${e?.message || e}`);
    }
  });
  return h('div', { class: 'setting' },
    h('div', { class: 'setting__text' },
      h('label', { class: 'setting__label', for: 'push-switch' }, 'Push-уведомления на этом устройстве'),
      h('p', { class: 'setting__desc' }, 'Личные сообщения и упоминания придут, даже если Созвон закрыт — на телефоне и на компьютере.'),
      h('p', { class: 'setting__desc', id: 'push-status' })),
    sw);
}

function buildNotifications() {
  return [
    section('Push-уведомления', pushRow()),
    section('Звуки',
      switchRow('notifications.sounds', 'Звуки интерфейса', 'Короткие сигналы Созвона. Выключите, чтобы отключить все звуки разом.'),
      soundRow('notifications.soundJoinLeave', 'Вход и выход', 'Кто-то зашёл в ваш голосовой канал или вышел из него.', 'join'),
      soundRow('notifications.soundMessage', 'Новое сообщение', 'Сообщение в другом канале или пока вкладка неактивна.', 'message'),
      soundRow('notifications.soundMute', 'Микрофон и звук', 'Щелчок при выключении и включении микрофона и звука.', 'mute')),
    section('Системные уведомления',
      h('div', { class: 'perm-box', id: 'desktop-perm' },
        icon('i-bell', 'perm-box__icon'),
        h('p', { class: 'perm-box__text', id: 'desktop-perm-status' }),
        h('button', {
          type: 'button', class: 'btn btn--primary btn--sm', id: 'btn-desktop-perm',
          onclick: async () => {
            const res = await requestDesktopPermission();
            if (res === 'granted') prefs.set('notifications.desktop', true);
            renderDesktopState();
          },
        }, 'Разрешить уведомления')),
      switchRow('notifications.desktop', 'Показывать уведомления о сообщениях', 'Когда окно Созвона не в фокусе.'),
      switchRow('notifications.mentionsOnly', 'Только упоминания', `Уведомлять, только если в сообщении есть @${state.user?.username || 'ваш_ник'}.`)),
  ];
}

/* ---------- 5. Горячие клавиши ---------- */
function bindRow(key, label, desc, single = false) {
  return h('div', { class: 'setting setting--bind' },
    h('div', { class: 'setting__text' },
      h('span', { class: 'setting__label' }, label),
      desc ? h('p', { class: 'setting__desc' }, desc) : null),
    h('div', { class: 'keycap-group' },
      keyCapture(key, { single, label }),
      h('button', { type: 'button', class: 'icon-btn', dataset: { resetPref: key }, 'aria-label': `Сбросить: ${label}`, title: 'Сбросить' }, icon('i-reset', 'icon--sm'))));
}

function buildKeybinds() {
  return [
    h('p', { class: 'settings-lead' }, 'Нажмите на сочетание, затем нужные клавиши. Esc — отмена, Backspace — снять привязку.'),
    section('Голос',
      bindRow('keybinds.toggleMute', 'Вкл/выкл микрофон', 'Работает везде, кроме полей ввода текста.'),
      bindRow('keybinds.toggleDeafen', 'Вкл/выкл звук', 'Выключает и звук, и микрофон.'),
      bindRow('audio.pttKey', 'Рация (push-to-talk)', 'Действует, когда в «Голос и видео» выбран режим «Рация».', true)),
    h('p', { class: 'settings-note' }, icon('i-info', 'icon--sm'),
      window.sozvonDesktop?.isDesktop
        ? 'В приложении для ПК сочетания работают глобально — даже когда окно свёрнуто.'
        : 'Горячие клавиши работают, только пока вкладка Созвона активна — браузер не передаёт нажатия из других окон. В приложении для ПК — глобально.'),
    section('',
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => resetKeys(['keybinds.toggleMute', 'keybinds.toggleDeafen', 'audio.pttKey'], 'Сбросить горячие клавиши?') }, icon('i-reset'), 'Сбросить все сочетания')),
  ];
}

/* ---------- 6. О приложении ---------- */
function buildAbout() {
  const feat = (ok, text) => h('li', { class: ok ? 'is-ok' : 'is-off' }, icon(ok ? 'i-check' : 'i-close', 'icon--sm'), text);
  const list = h('ul', { class: 'features', id: 'about-features' });
  const fill = () => {
    list.replaceChildren(
      feat(engine ? !!engine.rnnoiseSupported?.() : (typeof AudioWorkletNode === 'function' && typeof WebAssembly === 'object'), 'ИИ-шумоподавление (AudioWorklet + WebAssembly)'),
      feat(typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype, 'Выбор устройства вывода'),
      feat(canNotify(), 'Системные уведомления'),
      feat(!!navigator.mediaDevices?.getDisplayMedia, 'Демонстрация экрана'),
      feat('serviceWorker' in navigator, 'Установка как приложение (PWA)'));
  };
  fill();
  list.refresh = fill;
  return [
    h('div', { class: 'about-hero' },
      h('img', { src: '/assets/logo.svg', alt: '', width: '64', height: '64', class: 'about-hero__logo' }),
      h('div', null,
        h('div', { class: 'about-hero__name' }, 'Созвон'),
        h('div', { class: 'about-hero__ver' }, `Версия ${APP_VERSION}`),
        h('a', { class: 'about-hero__link', href: GITHUB_URL, target: '_blank', rel: 'noopener noreferrer' },
          'Исходный код на GitHub', icon('i-external', 'icon--sm')))),
    window.sozvonDesktop?.isDesktop ? section('Приложение для ПК',
      h('div', { class: 'setting' },
        h('div', { class: 'setting__text' },
          h('span', { class: 'setting__label' }, `Созвон для ПК ${window.sozvonDesktop.version || ''}`.trim()),
          h('p', { class: 'setting__desc' }, 'Глобальные клавиши рации и mute работают, даже когда окно не в фокусе.')),
        window.sozvonDesktop.openServerSettings ? h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { try { window.sozvonDesktop.openServerSettings(); } catch { /* ignore */ } } }, icon('i-link'), 'Сервер…') : null))
      : section('Приложение для ПК',
        hint('Рация и mute в фоне (даже в игре), трей, автозапуск, выбор окна для демонстрации.'),
        h('div', { class: 'dl', id: 'about-download', dataset: { hideDesktop: '' } })),
    section(window.sozvonDesktop?.isDesktop ? 'Возможности' : 'Возможности этого браузера', list),
    section('Сброс',
      h('div', { class: 'setting setting--danger' },
        h('div', { class: 'setting__text' },
          h('span', { class: 'setting__label' }, 'Сбросить все настройки'),
          h('p', { class: 'setting__desc' }, 'Звук, внешний вид, уведомления, горячие клавиши и громкость собеседников вернутся к стандартным. Аккаунт не затрагивается.')),
        h('button', {
          type: 'button', class: 'btn btn--danger', id: 'btn-reset-all',
          onclick: async () => {
            const yes = await confirmDialog({ title: 'Сбросить все настройки?', text: 'Все настройки этого браузера вернутся к стандартным. Это нельзя отменить.', ok: 'Сбросить' });
            if (!yes) return;
            prefs.reset();
            toastOk('Настройки сброшены');
          },
        }, 'Сбросить'))),
  ];
}

const BUILDERS = { account: buildAccount, profile: buildProfile, voice: buildVoice, appearance: buildAppearance, notifications: buildNotifications, keybinds: buildKeybinds, about: buildAbout };

/* ============================================================
   Каркас модалки
   ============================================================ */
function build() {
  if (built) return;
  built = true;
  const root = dlg();
  const nav = $('.settings__nav-list', root);
  const scroll = $('.settings__scroll', root);
  let lastGroup = null;
  for (const s of SECTIONS) {
    if (s.group !== undefined && s.group !== lastGroup) {
      lastGroup = s.group;
      nav.append(s.group ? h('div', { class: 'settings__group', role: 'presentation' }, s.group) : h('div', { class: 'settings__sep', role: 'presentation' }));
    }
    nav.append(h('button', {
      type: 'button', class: 'settings__tab', role: 'tab', id: `settings-tab-${s.id}`,
      dataset: { section: s.id }, 'aria-controls': `settings-panel-${s.id}`, 'aria-selected': 'false', tabindex: '-1',
    }, icon(s.icon), h('span', null, s.title), icon('i-chevron-right', 'settings__chev')));
    scroll.append(h('section', {
      class: 'settings__panel', id: `settings-panel-${s.id}`, role: 'tabpanel',
      dataset: { panel: s.id }, 'aria-labelledby': `settings-tab-${s.id}`, hidden: true,
    }, h('h2', { class: 'settings__title' }, s.title), ...BUILDERS[s.id]()));
  }
  nav.append(h('div', { class: 'settings__sep', role: 'presentation' }),
    h('button', { type: 'button', class: 'settings__tab settings__tab--danger', onclick: () => onLogout() }, icon('i-logout'), h('span', null, 'Выйти')),
    h('div', { class: 'settings__version' }, `Созвон ${APP_VERSION}`));

  bindControls(root);
  nav.addEventListener('click', (e) => {
    const t = e.target.closest('[data-section]');
    if (t) showSection(t.dataset.section, { focusPanel: matchMedia(MOBILE).matches });
  });
  nav.addEventListener('keydown', (e) => {
    const tabs = $$('.settings__tab[data-section]', nav);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j == null) return;
    e.preventDefault();
    tabs[j].focus();
    if (!matchMedia(MOBILE).matches) showSection(tabs[j].dataset.section);
  });
  $('.settings__back', root).addEventListener('click', () => {
    root.classList.remove('is-section-open');
    $(`.settings__tab[data-section="${current}"]`, root)?.focus();
  });
  // фокус-ловушка (поверх нативной инертности <dialog>) — Tab не уходит в адресную строку
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || capture) return;
    const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', root)
      .filter((el) => !el.disabled && el.offsetParent !== null && el.tabIndex >= 0);
    // в навигации доступна только активная вкладка (roving tabindex) — её и учитываем
    if (!f.length) return;
    const first = f[0]; const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  root.addEventListener('cancel', (e) => {
    // Esc во время захвата клавиши — только отмена захвата
    if (capture) { e.preventDefault(); stopCapture(); }
  });
  root.addEventListener('close', onClosed);

  prefs.subscribe('*', (key) => {
    if (!root.open) return;
    $$(`[data-pref="${key}"]`, root).forEach(syncControl);
    updateDependents();
    if (key === 'audio.noiseSuppression') updateRnnoise();
  });
  subscribe('me', () => { if (root.open) { renderAccountCard(); if (current === 'profile' && !profileDirty()) fillProfileForm(); else if (current === 'profile') renderProfilePreview(); } });
}

function showSection(id, { focusPanel = false } = {}) {
  if (!BUILDERS[id]) id = 'account';
  const root = dlg();
  if (current !== id && current === 'voice') stopMicTest();
  current = id;
  $$('.settings__tab[data-section]', root).forEach((t) => {
    const on = t.dataset.section === id;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$('.settings__panel', root).forEach((p) => { p.hidden = p.dataset.panel !== id; });
  $('#settings-bar-title').textContent = SECTIONS.find((s) => s.id === id).title;
  root.classList.add('is-section-open');
  $('.settings__scroll', root).scrollTop = 0;
  if (id === 'voice') { refreshDevices(); updateRnnoise(); }
  if (id === 'account') renderAccountCard();
  if (id === 'profile') fillProfileForm();
  if (id === 'about') { const dl = $('#about-download'); if (dl && !dl.dataset.loaded) { dl.dataset.loaded = '1'; renderDownloads(dl); } }
  if (id === 'about') $('#about-features')?.refresh?.();
  if (id === 'notifications') { renderDesktopState(); renderPushState(); }
  if (focusPanel) $('.settings__back', root).focus();
}

let offDevices = null;
const onDeviceChange = () => refreshDevices();

export async function openUserSettings(sectionId) {
  const root = dlg();
  if (!root) return;
  build();
  if (!root.open) {
    returnFocus = document.activeElement;
    root.showModal();
    // тосты — внутрь модалки, иначе их закроет верхний слой <dialog>
    const t = $('#toasts');
    if (t) root.append(t);
  }
  syncAll(root);
  renderAccountCard();
  const mobile = matchMedia(MOBILE).matches;
  showSection(sectionId || current || 'account');
  if (mobile && !sectionId) root.classList.remove('is-section-open');
  (mobile && !sectionId ? $('.settings__tab.is-active', root) : $('.settings__close', root))?.focus();
  // движок — лениво; когда загрузится, обновить устройства/RNNoise
  loadEngine().then((eng) => {
    if (!root.open) return;
    updateRnnoise();
    refreshDevices();
    $('#about-features')?.refresh?.();
    if (eng?.onDevicesChange && !offDevices) offDevices = eng.onDevicesChange(onDeviceChange);
  });
  if (!offDevices && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  }
}

function onClosed() {
  const t = $('#toasts');
  if (t && t.parentElement !== document.body) document.body.append(t);
  stopCapture();
  stopMicTest();
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  if (typeof offDevices === 'function') { try { offDevices(); } catch { /* ignore */ } }
  offDevices = null;
  const pw = $('#form-password');
  if (pw) { pw.reset(); $('#settings-password-error').textContent = ''; }
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.({ preventScroll: true, focusVisible: false });
  returnFocus = null;
}

export function closeUserSettings() {
  const root = dlg();
  if (root?.open) root.close();
}

export function initUserSettings({ logout } = {}) {
  if (logout) onLogout = logout;
  $('#btn-user-settings')?.addEventListener('click', () => openUserSettings());
  window.addEventListener('pagehide', stopMicTest);
  subscribe('push', () => renderPushState());
}
