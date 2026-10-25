// Astra 2.0: темы серверов — акцентный цвет и космический фон, которые задаёт владелец/админ
// (право «Управлять сервером»). Применяются, пока открыт этот сервер:
//   <html style="--accent: #…" data-server-accent> — производные токены считает CSS (color-mix, css/astra2.css);
//   <html data-server-bg="nebula|aurora|galaxy|eclipse|deep"> — фон за оболочкой.
// Хранится на сервере (server.theme), рассылается всем участникам через server:updated.
import { h, icon } from '../util.js';
import { state, subscribe, getServer } from '../state.js';
import { emitAck } from '../socket.js';
import { can } from '../perms.js';
import { AVATAR_PALETTE } from './palette.js';
import { applyServerFromAck } from './mod-actions.js';
import { toastOk } from './toasts.js';

export const SERVER_BACKGROUNDS = [
  { id: 'nebula', label: 'Туманность' },
  { id: 'aurora', label: 'Северное сияние' },
  { id: 'galaxy', label: 'Галактика' },
  { id: 'eclipse', label: 'Затмение' },
  { id: 'deep', label: 'Глубокий космос' },
];
const BG_IDS = new Set(SERVER_BACKGROUNDS.map((b) => b.id));
const HEX = /^#[0-9a-f]{6}$/i;

/** Относительная яркость (WCAG) цвета #rrggbb */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** Белый или тёмный текст на акценте — что контрастнее */
export function textOnAccent(hex) {
  const L = luminance(hex);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.0601) ? '#ffffff' : '#0b0d1a';
}

export function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const accent = HEX.test(t.accent || '') ? t.accent.toLowerCase() : null;
  const background = BG_IDS.has(t.background) ? t.background : null;
  return accent || background ? { accent, background } : null;
}

/** Применить тему к документу (null — тема по умолчанию) */
export function applyTheme(theme) {
  const html = document.documentElement;
  const t = cleanTheme(theme);
  if (t?.accent) {
    html.style.setProperty('--accent', t.accent);
    html.style.setProperty('--text-on-accent', textOnAccent(t.accent));
    html.dataset.serverAccent = t.accent;
  } else if (html.dataset.serverAccent) {
    html.style.removeProperty('--accent');
    html.style.removeProperty('--text-on-accent');
    delete html.dataset.serverAccent;
  }
  if (t?.background) html.dataset.serverBg = t.background;
  else delete html.dataset.serverBg;
}

let lastSig = '';
function sync() {
  const s = state.currentServerId ? getServer() : null;
  const t = cleanTheme(s?.theme);
  const sig = t ? `${t.accent}|${t.background}` : '';
  if (sig === lastSig) return;
  lastSig = sig;
  applyTheme(t);
}

export function initServerTheme() {
  subscribe(['nav', 'servers'], sync);
  sync();
}

/* ============================================================
   Раздел «Оформление» в настройках сервера
   ============================================================ */
let draft = null;     // { accent, background }
let draftFor = null;  // serverId

function bgOption(id, label) {
  return h('button', {
    type: 'button', class: 'cosmo-pick cosmo-pick--banner', role: 'radio', 'aria-checked': 'false',
    dataset: { serverBg: id || '' }, title: label, 'aria-label': `Фон: ${label}`,
  }, h('span', { class: 'cosmo-pick__swatch server-bg-swatch', dataset: id ? { bg: id } : null }), h('span', { class: 'cosmo-pick__label' }, label));
}

export function themePanel() {
  const swatches = h('div', { class: 'swatches swatches--sm', role: 'radiogroup', 'aria-label': 'Акцент сервера', id: 'ss-theme-accents' },
    h('button', { type: 'button', class: 'swatch swatch--none', role: 'radio', dataset: { accent: '' }, title: 'Как в теме Astra', 'aria-label': 'Акцент по умолчанию' }, icon('i-close', 'swatch__check')),
    ...AVATAR_PALETTE.map((c) => h('button', { type: 'button', class: 'swatch', role: 'radio', dataset: { accent: c }, style: { '--c': c }, title: c, 'aria-label': `Акцент ${c}` }, icon('i-check', 'swatch__check'))),
    h('label', { class: 'swatch swatch--custom', title: 'Свой цвет' },
      h('input', { type: 'color', id: 'ss-theme-accent-custom', 'aria-label': 'Свой цвет акцента' }), icon('i-palette', 'swatch__icon')));
  swatches.addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (!b || b.disabled) return;
    draft.accent = b.dataset.accent || null;
    renderThemePanel();
  });
  swatches.addEventListener('input', (e) => {
    if (e.target.id !== 'ss-theme-accent-custom') return;
    draft.accent = e.target.value.toLowerCase();
    renderThemePanel();
  });
  const bgs = h('div', { class: 'cosmo-grid cosmo-grid--banners', role: 'radiogroup', 'aria-label': 'Фон сервера', id: 'ss-theme-bgs' },
    bgOption(null, 'Обычный'), ...SERVER_BACKGROUNDS.map((b) => bgOption(b.id, b.label)));
  bgs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-server-bg]');
    if (!b || b.disabled) return;
    draft.background = b.dataset.serverBg || null;
    renderThemePanel();
  });
  const preview = h('div', { class: 'ss-theme-preview', id: 'ss-theme-preview', 'aria-hidden': 'true' },
    h('div', { class: 'ss-theme-preview__sky' }),
    h('div', { class: 'ss-theme-preview__ui' },
      h('span', { class: 'ss-theme-preview__chan' }, icon('i-hash', 'icon--sm'), 'общий'),
      h('span', { class: 'ss-theme-preview__btn' }, 'Подключиться'),
      h('span', { class: 'ss-theme-preview__link' }, 'ссылка-приглашение')));
  return [
    h('p', { class: 'settings-hint' }, 'Цвет и космический фон видят все участники, пока открыт этот сервер. Свои настройки внешнего вида (тема, анимации) у каждого остаются.'),
    h('div', { class: 'settings-block' }, h('h3', { class: 'settings-block__title' }, 'Предпросмотр'), preview),
    h('div', { class: 'settings-block' }, h('h3', { class: 'settings-block__title' }, 'Акцентный цвет'), swatches),
    h('div', { class: 'settings-block' }, h('h3', { class: 'settings-block__title' }, 'Фон'), bgs),
    h('p', { class: 'form__error', id: 'ss-theme-error', role: 'alert' }),
    h('div', { class: 'save-bar', id: 'ss-theme-bar', hidden: true },
      h('span', { class: 'save-bar__text' }, 'Есть несохранённые изменения'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { draft = null; renderThemePanel(); } }, 'Сбросить'),
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'ss-theme-save', onclick: saveTheme }, 'Сохранить оформление')),
  ];
}

let panelServerId = null;
/** Перерисовать раздел (вызывается из server-settings.js при открытии/обновлении) */
export function renderThemePanel(serverId = panelServerId) {
  panelServerId = serverId;
  const s = getServer(serverId);
  const root = document.getElementById('ss-theme-accents')?.closest('.settings__panel');
  if (!s || !root) return;
  const saved = cleanTheme(s.theme) || { accent: null, background: null };
  if (!draft || draftFor !== s.id) { draft = { ...saved }; draftFor = s.id; }
  const editable = can(s, 'MANAGE_SERVER');
  for (const b of root.querySelectorAll('[data-accent]')) {
    const on = (b.dataset.accent || null) === (draft.accent || null);
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
    b.disabled = !editable;
  }
  const custom = root.querySelector('#ss-theme-accent-custom');
  if (custom) { custom.disabled = !editable; if (draft.accent) custom.value = draft.accent; }
  const customWrap = custom?.closest('.swatch--custom');
  const isCustom = !!draft.accent && !AVATAR_PALETTE.includes(draft.accent);
  customWrap?.classList.toggle('is-selected', isCustom);
  if (customWrap) customWrap.style.setProperty('--c', isCustom ? draft.accent : '');
  for (const b of root.querySelectorAll('[data-server-bg]')) {
    const on = (b.dataset.serverBg || null) === (draft.background || null);
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    b.disabled = !editable;
  }
  const pv = root.querySelector('#ss-theme-preview');
  if (pv) {
    if (draft.accent) { pv.style.setProperty('--pv-accent', draft.accent); pv.style.setProperty('--pv-on-accent', textOnAccent(draft.accent)); }
    else { pv.style.removeProperty('--pv-accent'); pv.style.removeProperty('--pv-on-accent'); }
    if (draft.background) pv.dataset.bg = draft.background; else delete pv.dataset.bg;
  }
  const dirty = (draft.accent || null) !== (saved.accent || null) || (draft.background || null) !== (saved.background || null);
  root.querySelector('#ss-theme-bar').hidden = !dirty || !editable;
}

async function saveTheme() {
  const s = getServer(panelServerId);
  if (!s || !draft) return;
  const btn = document.getElementById('ss-theme-save');
  const err = document.getElementById('ss-theme-error');
  btn.disabled = true;
  err.textContent = '';
  try {
    const theme = draft.accent || draft.background ? { accent: draft.accent || null, background: draft.background || null } : null;
    const res = await emitAck('server:update', { serverId: s.id, theme });
    applyServerFromAck(res);
    draft = null;
    renderThemePanel();
    toastOk('Оформление сервера сохранено');
  } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; }
}
