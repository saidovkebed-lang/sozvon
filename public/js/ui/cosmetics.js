// Astra 2.0 «Профили 2.0»: рамки аватаров, анимированные баннеры, автоматические значки.
// Списки совпадают с server/cosmetics.js (сервер проверяет значения). Рисуется всё CSS-ом (css/astra2.css)
// по data-frame / data-preset; SVG рамок — /assets/frames/*.svg, значки — /assets/astra-ui.svg.
import { h, avatar, safeColor } from '../util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const UI_SPRITE = '/assets/astra-ui.svg';

export const AVATAR_FRAMES = [
  { id: 'orbit', label: 'Орбита' },
  { id: 'nova', label: 'Сверхновая' },
  { id: 'comet', label: 'Комета' },
  { id: 'aurora', label: 'Полярное сияние' },
  { id: 'eclipse', label: 'Затмение' },
  { id: 'constellation', label: 'Созвездие' },
];
export const BANNER_PRESETS = [
  { id: 'nebula', label: 'Туманность' },
  { id: 'aurora', label: 'Сияние' },
  { id: 'galaxy', label: 'Галактика' },
  { id: 'sunrise', label: 'Восход' },
  { id: 'deep', label: 'Глубокий космос' },
];
export const BADGES = {
  founder: { label: 'Основатель', hint: 'Владелец сервера', icon: 'b-founder' },
  veteran: { label: 'Ветеран', hint: 'В Astra больше 30 дней', icon: 'b-veteran' },
  melomane: { label: 'Меломан', hint: 'Добавил в библиотеку бота 5+ треков', icon: 'b-melomane' },
  streamer: { label: 'Стример', hint: 'Показывал экран в голосовом', icon: 'b-streamer' },
  bot: { label: 'Бот', hint: 'Музыкальный бот Astra', icon: 'b-bot' },
};
const ORDER = ['bot', 'founder', 'veteran', 'melomane', 'streamer'];

const FRAME_IDS = new Set(AVATAR_FRAMES.map((f) => f.id));
const PRESET_IDS = new Set(BANNER_PRESETS.map((f) => f.id));
export const validFrame = (v) => (typeof v === 'string' && FRAME_IDS.has(v) ? v : null);
export const validPreset = (v) => (typeof v === 'string' && PRESET_IDS.has(v) ? v : null);

export function uiIcon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', ('icon ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${UI_SPRITE}#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Значки пользователя. «Основатель» — по контексту: на сервере — только владелец этого сервера,
 * вне сервера (ЛС) — если сервер прислал founder (владеет каким-то сервером).
 */
export function badgesFor(u, server = null) {
  if (!u) return [];
  if (u.isBot) return ['bot'];
  const set = new Set(Array.isArray(u.badges) ? u.badges.filter((b) => b in BADGES && b !== 'bot') : []);
  if (server) {
    if (server.ownerId === u.id) set.add('founder'); else set.delete('founder');
  }
  return ORDER.filter((b) => set.has(b));
}

/** Ряд значков для попапа профиля (null — значков нет). */
export function badgeRow(u, server = null) {
  const list = badgesFor(u, server);
  if (!list.length) return null;
  return h('div', { class: 'astra-badges', role: 'list', 'aria-label': 'Значки' },
    ...list.map((id) => {
      const b = BADGES[id];
      return h('span', {
        class: `astra-badge astra-badge--${id}`, role: 'listitem', dataset: { badge: id },
        title: `${b.label} — ${b.hint}`, 'aria-label': b.label,
      }, uiIcon(b.icon, 'icon--sm'), h('span', { class: 'astra-badge__label' }, b.label));
    }));
}

/* ============================================================
   Настройки профиля: выбор рамки и анимированного баннера
   ============================================================ */
function frameOption(id, label, user) {
  const av = avatar({ ...user, avatarFrame: id }, '');
  return h('button', {
    type: 'button', class: 'cosmo-pick cosmo-pick--frame', role: 'radio', 'aria-checked': 'false',
    dataset: { frameChoice: id || '' }, title: label, 'aria-label': `Рамка: ${label}`,
  }, av, h('span', { class: 'cosmo-pick__label' }, label));
}

function presetOption(id, label) {
  return h('button', {
    type: 'button', class: 'cosmo-pick cosmo-pick--banner', role: 'radio', 'aria-checked': 'false',
    dataset: { bannerPreset: id || '' }, title: label, 'aria-label': `Фон баннера: ${label}`,
  }, h('span', { class: 'cosmo-pick__swatch' + (id ? ' profile-banner-preset' : ' cosmo-pick__swatch--none'), dataset: id ? { preset: id } : null }), h('span', { class: 'cosmo-pick__label' }, label));
}

/** Стрелки ←/→ по radiogroup (как у нативных радио). */
function arrowNav(group) {
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const items = [...group.querySelectorAll('[role="radio"]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = items[(i + d + items.length) % items.length];
    next.focus();
    next.click();
  });
}

/**
 * Блок «Оформление профиля» для раздела настроек «Профиль».
 * getDraft() — текущий черновик профиля (меняем avatarFrame / bannerPreset), onChange — перерисовать предпросмотр.
 */
export function cosmeticsSettings(getDraft, user, onChange) {
  const me = { ...user, avatar: user?.avatar, color: safeColor(user?.color) };
  const frames = h('div', { class: 'cosmo-grid', role: 'radiogroup', 'aria-label': 'Рамка аватара', id: 'profile-frame-picker' },
    frameOption(null, 'Без рамки', me), ...AVATAR_FRAMES.map((f) => frameOption(f.id, f.label, me)));
  frames.addEventListener('click', (e) => {
    const b = e.target.closest('.cosmo-pick[data-frame-choice]');
    if (!b) return;
    getDraft().avatarFrame = b.dataset.frameChoice || null;
    onChange();
  });
  const banners = h('div', { class: 'cosmo-grid cosmo-grid--banners', role: 'radiogroup', 'aria-label': 'Анимированный баннер', id: 'profile-banner-preset-picker' },
    presetOption(null, 'Нет'), ...BANNER_PRESETS.map((p) => presetOption(p.id, p.label)));
  banners.addEventListener('click', (e) => {
    const b = e.target.closest('.cosmo-pick[data-banner-preset]');
    if (!b) return;
    getDraft().bannerPreset = b.dataset.bannerPreset || null;
    onChange();
  });
  arrowNav(frames);
  arrowNav(banners);
  return [
    h('span', { class: 'field__label' }, 'Рамка аватара'),
    frames,
    h('span', { class: 'field__label' }, 'Анимированный баннер'),
    banners,
    h('p', { class: 'field__hint' }, 'Показывается вместо цвета, если не загружена картинка баннера. Двигается только в карточке профиля и не двигается при «уменьшении движения».'),
  ];
}

/** Отметить выбранные варианты по черновику (вызывается из renderProfilePreview). */
export function syncCosmetics(root, draft) {
  if (!root || !draft) return;
  for (const b of root.querySelectorAll('.cosmo-pick[data-frame-choice]')) {
    const on = (b.dataset.frameChoice || null) === (draft.avatarFrame || null);
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const b of root.querySelectorAll('.cosmo-pick[data-banner-preset]')) {
    const on = (b.dataset.bannerPreset || null) === (draft.bannerPreset || null);
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

