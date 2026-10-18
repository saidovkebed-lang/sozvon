// Просмотр фото и видео внутри приложения (без перехода в браузер).
// Листание стрелками/свайпом по всем медиа текущего канала, зум колесом/двойным кликом/щипком,
// перетаскивание увеличенного фото, скачивание. Esc / клик по фону — закрыть.
import { h, icon } from '../util.js';

let root = null;
let items = [];   // [{ url, name, type: 'image'|'video' }]
let index = 0;
let zoom = 1;
let pan = { x: 0, y: 0 };
let returnFocus = null;

const MIN_Z = 1;
const MAX_Z = 6;

function build() {
  if (root) return root;
  root = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Просмотр', hidden: true, tabindex: '-1' },
    h('div', { class: 'lightbox__bar' },
      h('div', { class: 'lightbox__title' }),
      h('div', { class: 'lightbox__count' }),
      h('a', { class: 'icon-btn lightbox__btn', dataset: { lb: 'download' }, title: 'Скачать', 'aria-label': 'Скачать', download: '' }, icon('i-download')),
      h('button', { type: 'button', class: 'icon-btn lightbox__btn', dataset: { lb: 'close' }, title: 'Закрыть (Esc)', 'aria-label': 'Закрыть' }, icon('i-close'))),
    h('button', { type: 'button', class: 'lightbox__nav lightbox__nav--prev', dataset: { lb: 'prev' }, 'aria-label': 'Предыдущее' }, icon('i-chevron-left')),
    h('div', { class: 'lightbox__stage' }),
    h('button', { type: 'button', class: 'lightbox__nav lightbox__nav--next', dataset: { lb: 'next' }, 'aria-label': 'Следующее' }, icon('i-chevron-right')));
  document.body.append(root);

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb]');
    if (b) {
      const a = b.dataset.lb;
      if (a === 'close') close();
      else if (a === 'prev') show(index - 1);
      else if (a === 'next') show(index + 1);
      return; // download — обычная ссылка
    }
    // клик по фону (не по самому фото/видео) — закрыть
    if (!e.target.closest('.lightbox__media') && !e.target.closest('.lightbox__bar')) close();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
    else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25);
    else if (e.key === '-') setZoom(zoom / 1.25);
    else if (e.key === '0') setZoom(1);
  });
  root.addEventListener('wheel', (e) => {
    if (items[index]?.type !== 'image') return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });

  // перетаскивание увеличенного фото / свайп для листания
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    const media = e.target.closest('.lightbox__media');
    if (!media || items[index]?.type !== 'image') return;
    drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false };
    media.setPointerCapture?.(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (zoom > 1) { pan = { x: drag.px + dx, y: drag.py + dy }; apply(); }
  });
  root.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (zoom === 1 && drag.moved && Math.abs(dx) > 60) show(index + (dx < 0 ? 1 : -1));
    drag = null;
  });
  root.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.lightbox__media') || items[index]?.type !== 'image') return;
    setZoom(zoom > 1 ? 1 : 2.5);
  });
  return root;
}

function setZoom(z) {
  zoom = Math.min(MAX_Z, Math.max(MIN_Z, z));
  if (zoom === 1) pan = { x: 0, y: 0 };
  apply();
}

function apply() {
  const m = root?.querySelector('.lightbox__media');
  if (m && items[index]?.type === 'image') {
    m.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    m.classList.toggle('is-zoomed', zoom > 1);
  }
}

function show(i) {
  if (!items.length) return;
  index = (i + items.length) % items.length;
  zoom = 1; pan = { x: 0, y: 0 };
  const it = items[index];
  const stage = root.querySelector('.lightbox__stage');
  stage.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
  const media = it.type === 'video'
    ? h('video', { class: 'lightbox__media', src: it.url, controls: true, autoplay: true, playsInline: true, preload: 'auto' })
    : h('img', { class: 'lightbox__media', src: it.url, alt: it.name || 'изображение', draggable: 'false' });
  stage.replaceChildren(media);
  root.querySelector('.lightbox__title').textContent = it.name || '';
  root.querySelector('.lightbox__count').textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
  const dl = root.querySelector('[data-lb="download"]');
  dl.href = it.url;
  dl.setAttribute('download', it.name || '');
  root.querySelectorAll('.lightbox__nav').forEach((b) => { b.hidden = items.length < 2; });
}

/** Открыть просмотр: list — все медиа канала по порядку, start — индекс открытого */
export function openLightbox(list, start = 0) {
  build();
  items = list.filter((x) => x && x.url);
  if (!items.length) return;
  returnFocus = document.activeElement;
  root.hidden = false;
  document.body.classList.add('has-lightbox');
  show(start);
  root.focus({ preventScroll: true });
}

export function closeLightbox() { close(); }

function close() {
  if (!root || root.hidden) return;
  root.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
  root.querySelector('.lightbox__stage').replaceChildren();
  root.hidden = true;
  document.body.classList.remove('has-lightbox');
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.({ preventScroll: true });
  returnFocus = null;
}

export const isLightboxOpen = () => !!root && !root.hidden;
