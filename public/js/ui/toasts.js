import { h, $ } from '../util.js';

export function toast(text, type = 'error', ms = 4500) {
  const box = $('#toasts');
  if (!box) return;
  const el = h('div', { class: 'toast' + (type ? ` toast--${type}` : ''), role: type === 'error' ? 'alert' : 'status' }, String(text));
  box.append(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export const toastError = (e) => toast(e?.message || String(e), 'error');
export const toastOk = (t) => toast(t, 'ok', 2500);
