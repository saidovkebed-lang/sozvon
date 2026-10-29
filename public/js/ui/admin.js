// Админ-панель экземпляра: пункт «Админ-панель» в меню пользователя (только администраторам),
// обязательная смена временного пароля. Сама панель — лениво, js/ui/admin-panel.js.
import { h, icon, $ } from '../util.js';
import { state, subscribe, notify } from '../state.js';
import { getToken, setToken } from '../api.js';

export const adminState = { info: null, loadedFor: null };

/** Запрос к /api с токеном; ошибка — Error(message) c .status и .code */
export async function adminFetch(method, url, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    const e = new Error('Нет связи с сервером'); e.status = 0; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) {
    const e = new Error(data?.error || `Ошибка сервера (${res.status})`);
    e.status = res.status; e.code = data?.code || null;
    throw e;
  }
  return data;
}

async function refreshAdminInfo() {
  if (!state.user) return;
  try {
    adminState.info = await adminFetch('GET', '/api/me/flags');
  } catch { adminState.info = null; }
  adminState.loadedFor = state.user.id;
  const active = !!adminState.info?.active;
  if (state.instanceAdmin !== active) {
    state.instanceAdmin = active; // js/perms.js: все права на серверах (как на сервере)
    notify('servers', 'nav', 'members');
  }
  if (adminState.info?.admin) resumeUpdateWatch();
}

export function isAdmin() { return !!adminState.info?.admin; }

export async function openAdminPanel(section) {
  const mod = await import('./admin-panel.js');
  return mod.openAdminPanel(section);
}

/** После перезапуска во время обновления: показать «Обновлено до …», даже если страница перезагрузилась. */
async function resumeUpdateWatch() {
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('astra.adminUpdate') || 'null'); } catch { /* нет */ }
  if (!pending || Date.now() - pending.at > 2 * 3600_000) return;
  const mod = await import('./admin-panel.js');
  mod.watchUpdate();
}

// Пункт в меню статуса (js/ui/profile.js строит его при каждом открытии) — дописываем, не трогая модуль
function decorateStatusMenu(menu) {
  if (!isAdmin() || menu.querySelector('[data-action="admin-panel"]')) return;
  const item = h('button', {
    type: 'button', class: 'status-menu__item status-menu__admin', role: 'menuitem', dataset: { action: 'admin-panel' },
    onclick: () => {
      $('#me-avatar')?.click(); // повторный клик по аватару закрывает меню (js/ui/profile.js)
      if (menu.isConnected) menu.remove();
      openAdminPanel();
    },
  }, icon('i-shield', 'icon--sm'), h('span', { class: 'status-menu__text' }, h('span', null, 'Админ-панель'), h('small', null, 'Управление Astra')));
  menu.append(h('div', { class: 'status-menu__sep', role: 'separator' }), item);
}

// ---------- временный пароль (сброшен администратором) ----------
let pwDialog = null;
export function requirePasswordChange(onDone) {
  if (pwDialog?.open) return;
  pwDialog?.remove();
  const err = h('p', { class: 'form__error', role: 'alert' });
  const oldI = h('input', { class: 'input', id: 'temp-old-password', type: 'password', autocomplete: 'current-password', required: true });
  const newI = h('input', { class: 'input', id: 'temp-new-password', type: 'password', autocomplete: 'new-password', minlength: '4', maxlength: '128', required: true });
  const repI = h('input', { class: 'input', id: 'temp-confirm-password', type: 'password', autocomplete: 'new-password', required: true });
  // при включённой 2FA смена пароля требует код (server/totp.js: requireUserCode)
  const codeI = h('input', { class: 'input', id: 'temp-2fa-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '20' });
  const codeField = h('label', { class: 'field', hidden: true }, h('span', { class: 'field__label' }, 'Код двухфакторной защиты'), codeI);
  adminFetch('GET', '/api/me').then((r) => { if (r?.user?.totpEnabled) codeField.hidden = false; }).catch(() => {});
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Сменить пароль');
  const form = h('form', { class: 'modal__body form', novalidate: true },
    h('p', { class: 'modal__text' }, 'Администратор сбросил ваш пароль. Введите временный пароль, который он вам передал, и придумайте новый.'),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Временный пароль'), oldI),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Новый пароль'), newI),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Повторите новый пароль'), repI),
    codeField,
    err,
    h('div', { class: 'modal__footer admin-ask__footer' },
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { setToken(null); location.reload(); } }, 'Выйти'),
      submit));
  pwDialog = h('dialog', { class: 'modal admin-ask', id: 'modal-temp-password', 'aria-labelledby': 'temp-password-title' },
    h('div', { class: 'modal__header' }, h('h2', { class: 'modal__title', id: 'temp-password-title' }, 'Смените временный пароль')),
    form);
  pwDialog.addEventListener('cancel', (e) => e.preventDefault()); // закрыть нельзя — только сменить или выйти
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!oldI.value) { err.textContent = 'Введите временный пароль'; return; }
    if (newI.value.length < 4) { err.textContent = 'Новый пароль — не короче 4 символов'; return; }
    if (newI.value !== repI.value) { err.textContent = 'Пароли не совпадают'; return; }
    submit.disabled = true;
    try {
      const body = { oldPassword: oldI.value, newPassword: newI.value };
      if (codeI.value.trim()) body.code = codeI.value.replace(/\s+/g, '');
      await adminFetch('POST', '/api/me/password', body);
      pwDialog.close();
      pwDialog.remove();
      pwDialog = null;
      onDone?.(getToken());
    } catch (ex) {
      if (ex.code === 'totp_required' || ex.code === 'totp_invalid') codeField.hidden = false;
      err.textContent = ex.message;
    } finally { submit.disabled = false; }
  });
  document.body.append(pwDialog);
  pwDialog.showModal();
  oldI.focus();
}

export function initAdmin() {
  subscribe('me', () => {
    if (state.user && adminState.loadedFor !== state.user.id) refreshAdminInfo();
  });
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('status-menu')) decorateStatusMenu(n);
  }).observe(document.body, { childList: true });
  window.__sozvon = Object.assign(window.__sozvon || {}, { openAdminPanel, refreshAdminInfo });
  // клавиатура: Ctrl+Shift+A — админ-панель (только администраторам)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a' || e.code === 'KeyA') && isAdmin() && !$('dialog[open]')) {
      e.preventDefault();
      openAdminPanel();
    }
  });
}
