// Общая логика <dialog>: showModal (focus-trap и Esc нативно), [data-close], клик по фону
import { $, $$ } from '../util.js';

let lastFocus = null;

export function openModal(id) {
  const dlg = typeof id === 'string' ? document.getElementById(id) : id;
  if (!dlg) return null;
  if (dlg.open) return dlg;
  lastFocus = document.activeElement;
  $$('[data-error]', dlg).forEach((e) => { e.textContent = ''; });
  dlg.showModal();
  const first = dlg.querySelector('form:not([hidden]) input:not([type=hidden]):not([type=radio]):not([hidden]), [autofocus]');
  (first || dlg.querySelector('button:not([data-close])') || dlg).focus();
  return dlg;
}

export function closeModal(id) {
  const dlg = typeof id === 'string' ? document.getElementById(id) : id;
  if (dlg?.open) dlg.close();
}

export function setModalError(dlg, text) {
  const el = dlg.querySelector('form:not([hidden]) [data-error]') || dlg.querySelector('[data-error]');
  if (el) el.textContent = text || '';
}

export function initModals() {
  for (const dlg of $$('dialog.modal')) {
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { dlg.close(); return; }
      if (e.target === dlg) {
        // клик по backdrop (вне прямоугольника содержимого)
        const r = dlg.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) dlg.close();
      }
    });
    dlg.addEventListener('close', () => {
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus?.();
      lastFocus = null;
    });
  }
}

let confirmResolve = null;
export function confirmDialog({ title = 'Вы уверены?', text = '', ok = 'Подтвердить', danger = true } = {}) {
  const dlg = $('#modal-confirm');
  $('#modal-confirm-title').textContent = title;
  $('#modal-confirm-text').textContent = text;
  const btn = $('#confirm-ok');
  btn.textContent = ok;
  btn.classList.toggle('btn--danger', danger);
  btn.classList.toggle('btn--primary', !danger);
  if (confirmResolve) confirmResolve(false);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      if (confirmResolve === resolve) { confirmResolve = null; resolve(dlg.returnValue === 'ok'); }
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    openModal(dlg);
    btn.focus();
  });
}

export function initConfirm() {
  $('#confirm-ok').addEventListener('click', () => $('#modal-confirm').close('ok'));
}
