// «Моя учётная запись → Двухфакторная защита» (TOTP, server/totp.js):
// подключение (пароль → QR + секрет → код → коды восстановления), отключение, новые коды восстановления,
// «Выйти на других устройствах». QR рисуется локально (public/js/qr.js) — секрет никуда не отправляется.
import { $, h, icon } from '../util.js';
import { state, applyUserUpdate } from '../state.js';
import { getToken } from '../api.js';
import { qrSvg } from '../qr.js';
import { confirmDialog } from './modals.js';
import { toastOk, toastError } from './toasts.js';

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new Error('Нет связи с сервером'); }
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (res.status === 404 || res.status === 405) throw new Error('Сервер пока не поддерживает эту функцию — обновите сервер Astra');
  if (!res.ok) throw Object.assign(new Error(data?.error || `Ошибка сервера (${res.status})`), { code: data?.code });
  return data || {};
}

let root = null;   // контейнер раздела
let status = null; // { enabled, recoveryCodesLeft }

const field = (id, label, attrs = {}) => h('div', { class: 'field' },
  h('label', { class: 'field__label', for: id }, label),
  h('input', { class: 'input', id, ...attrs }));
const codeAttrs = { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', spellcheck: 'false', autocapitalize: 'off' };
const errorEl = () => h('p', { class: 'form__error', id: 'twofa-error', role: 'alert' });

function setBusy(form, busy) { form.querySelectorAll('button, input').forEach((b) => { b.disabled = busy; }); }

function downloadCodes(codes) {
  const name = state.user?.username || 'astra';
  const text = [
    'Astra — коды восстановления двухфакторной защиты',
    `Аккаунт: ${name}`,
    `Создано: ${new Date().toLocaleString('ru-RU')}`,
    '',
    'Каждый код можно использовать только один раз — вместо кода из приложения.',
    'Храните их в надёжном месте (менеджер паролей, распечатка).',
    '',
    ...codes,
    '',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: `astra-recovery-codes-${name}.txt`, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function recoveryView(codes, title) {
  const view = h('div', { class: 'twofa-step', id: 'twofa-recovery' },
    h('p', { class: 'setting__label' }, title),
    h('p', { class: 'settings-hint' }, 'Сохраните эти коды восстановления. Если телефон потеряется, любой из них заменит код из приложения — по одному разу. Больше они показаны не будут.'),
    h('ol', { class: 'twofa-codes', id: 'twofa-recovery-list' }, ...codes.map((c) => h('li', null, h('code', null, c)))),
    h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', id: 'twofa-download', onclick: () => downloadCodes(codes) }, icon('i-download'), 'Скачать .txt'),
      h('button', {
        type: 'button', class: 'btn btn--ghost', id: 'twofa-copy',
        onclick: async () => {
          try { await navigator.clipboard.writeText(codes.join('\n')); toastOk('Коды скопированы'); }
          catch { toastError('Не удалось скопировать — выделите коды вручную'); }
        },
      }, 'Скопировать'),
      h('button', { type: 'button', class: 'btn btn--primary', id: 'twofa-done', onclick: () => refresh() }, 'Готово')));
  return view;
}

/* ---------- подключение ---------- */
function startEnroll() {
  const form = h('form', { class: 'form twofa-step', id: 'twofa-setup-form', novalidate: true },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', hidden: true, value: state.user?.username || '' }),
    h('p', { class: 'settings-hint' }, 'Подтвердите, что это вы: введите текущий пароль.'),
    field('twofa-password', 'Текущий пароль', { type: 'password', autocomplete: 'current-password', required: true }),
    errorEl(),
    h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => refresh() }, 'Отмена'),
      h('button', { type: 'submit', class: 'btn btn--primary', id: 'twofa-setup-submit' }, 'Продолжить')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#twofa-error', form);
    const password = $('#twofa-password', form).value;
    if (!password) { err.textContent = 'Введите текущий пароль'; return; }
    setBusy(form, true);
    try {
      const setup = await req('POST', '/api/me/2fa/setup', { password });
      showQr(setup);
    } catch (ex) { err.textContent = ex.message; setBusy(form, false); }
  });
  root.replaceChildren(form);
  $('#twofa-password', form).focus();
}

function showQr(setup) {
  const grouped = setup.secret.replace(/(.{4})/g, '$1 ').trim();
  const form = h('form', { class: 'form twofa-step', id: 'twofa-confirm-form', novalidate: true },
    h('p', { class: 'settings-hint' }, '1. Отсканируйте QR-код приложением-аутентификатором (Google Authenticator, Aegis, 2FAS, 1Password, Bitwarden…). Интернет для этого не нужен.'),
    h('div', { class: 'twofa-qr', id: 'twofa-qr' }, qrSvg(setup.uri, { label: 'QR-код для приложения-аутентификатора' })),
    h('p', { class: 'settings-hint' }, 'Не получается отсканировать? Введите ключ вручную (тип — по времени, 6 цифр, 30 секунд):'),
    h('code', { class: 'twofa-secret', id: 'twofa-secret', title: 'Секретный ключ' }, grouped),
    h('details', { class: 'twofa-uri' },
      h('summary', null, 'Ссылка otpauth://'),
      h('input', { class: 'input', id: 'twofa-uri', type: 'text', readonly: true, value: setup.uri, onfocus: (e) => e.target.select() })),
    h('p', { class: 'settings-hint' }, '2. Введите 6-значный код, который показывает приложение.'),
    field('twofa-code', 'Код подтверждения', { ...codeAttrs, placeholder: '000000', required: true }),
    errorEl(),
    h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => refresh() }, 'Отмена'),
      h('button', { type: 'submit', class: 'btn btn--primary', id: 'twofa-confirm' }, 'Включить защиту')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#twofa-error', form);
    const code = $('#twofa-code', form).value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Код — 6 цифр из приложения'; return; }
    setBusy(form, true);
    try {
      const res = await req('POST', '/api/me/2fa/enable', { code });
      if (res.user) applyUserUpdate(res.user);
      toastOk('Двухфакторная защита включена');
      root.replaceChildren(recoveryView(res.recoveryCodes || [], 'Защита включена. Коды восстановления'));
    } catch (ex) {
      err.textContent = ex.message;
      setBusy(form, false);
      if (ex.code === 'enroll_expired') return;
      $('#twofa-code', form).select();
    }
  });
  root.replaceChildren(form);
  $('#twofa-code', form).focus();
}

/* ---------- действия при включённой 2FA ---------- */
function actionForm({ title, submitText, danger = false, onSubmit }) {
  const form = h('form', { class: 'form twofa-step', id: 'twofa-action-form', novalidate: true },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', hidden: true, value: state.user?.username || '' }),
    h('p', { class: 'setting__label' }, title),
    h('div', { class: 'form-grid' },
      field('twofa-action-password', 'Текущий пароль', { type: 'password', autocomplete: 'current-password', required: true }),
      field('twofa-action-code', 'Код из приложения или код восстановления', { ...codeAttrs, inputmode: 'text', required: true })),
    errorEl(),
    h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => refresh() }, 'Отмена'),
      h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, id: 'twofa-action-submit' }, submitText)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#twofa-error', form);
    const password = $('#twofa-action-password', form).value;
    const code = $('#twofa-action-code', form).value.trim();
    if (!password) { err.textContent = 'Введите текущий пароль'; return; }
    if (!code) { err.textContent = 'Введите код'; return; }
    setBusy(form, true);
    try { await onSubmit({ password, code }); }
    catch (ex) { err.textContent = ex.message; setBusy(form, false); }
  });
  root.replaceChildren(form);
  $('#twofa-action-password', form).focus();
}

function disableFlow() {
  actionForm({
    title: 'Отключить двухфакторную защиту',
    submitText: 'Отключить',
    danger: true,
    onSubmit: async (body) => {
      const res = await req('POST', '/api/me/2fa/disable', body);
      if (res.user) applyUserUpdate(res.user);
      toastOk('Двухфакторная защита отключена');
      refresh();
    },
  });
}

function regenFlow() {
  actionForm({
    title: 'Новые коды восстановления (старые перестанут действовать)',
    submitText: 'Получить новые коды',
    onSubmit: async (body) => {
      const res = await req('POST', '/api/me/2fa/recovery-codes', body);
      root.replaceChildren(recoveryView(res.recoveryCodes || [], 'Новые коды восстановления'));
    },
  });
}

/* ---------- состояние ---------- */
function renderStatus() {
  const on = !!status?.enabled;
  const left = status?.recoveryCodesLeft ?? 0;
  const desc = on
    ? `Включена. При входе нужен код из приложения. Кодов восстановления осталось: ${left}.`
    : 'При входе, кроме пароля, потребуется 6-значный код из приложения-аутентификатора на телефоне. Работает без интернета и сторонних сервисов.';
  const row = h('div', { class: 'setting', id: 'twofa-status', dataset: { enabled: String(on) } },
    h('div', { class: 'setting__text' },
      h('span', { class: 'setting__label' }, on ? 'Двухфакторная защита включена' : 'Двухфакторная защита выключена'),
      h('p', { class: 'setting__desc' }, desc)),
    on
      ? h('div', { class: 'twofa-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'twofa-regen', onclick: regenFlow }, 'Новые коды'),
        h('button', { type: 'button', class: 'btn btn--danger-soft', id: 'twofa-disable', onclick: disableFlow }, 'Отключить'))
      : h('button', { type: 'button', class: 'btn btn--primary', id: 'twofa-enable', onclick: startEnroll }, 'Включить'));
  const low = on && left <= 3
    ? h('p', { class: 'settings-hint twofa-warn' }, left === 0 ? 'Коды восстановления закончились — создайте новые.' : 'Кодов восстановления мало — создайте новые.')
    : null;
  root.replaceChildren(row, low || '');
}

export async function refresh() {
  if (!root) return;
  status = { enabled: !!state.user?.totpEnabled, recoveryCodesLeft: 0 };
  renderStatus();
  if (state.user?.isBot) return;
  try {
    status = await req('GET', '/api/me/2fa');
    renderStatus();
  } catch { /* старый сервер — показываем по флагу */ }
}

async function revokeOthers() {
  const ok = await confirmDialog({ title: 'Выйти на других устройствах?', text: 'Все остальные сеансы (браузеры, телефоны, приложение для ПК) будут завершены. Этот сеанс останется.', ok: 'Выйти' });
  if (!ok) return;
  try {
    const res = await req('POST', '/api/me/sessions/revoke-others');
    toastOk(res.revoked ? `Завершено сеансов: ${res.revoked}` : 'Других сеансов нет');
  } catch (ex) { toastError(ex.message); }
}

/** Блоки раздела «Моя учётная запись»: 2FA + выход на других устройствах. */
export function twoFactorBlocks() {
  root = h('div', { class: 'twofa', id: 'settings-2fa' });
  refresh();
  const sessions = h('div', { class: 'setting' },
    h('div', { class: 'setting__text' },
      h('span', { class: 'setting__label' }, 'Выйти на других устройствах'),
      h('p', { class: 'setting__desc' }, 'Завершить все сеансы, кроме этого. Пригодится, если вы входили с чужого компьютера или потеряли телефон.')),
    h('button', { type: 'button', class: 'btn btn--ghost', id: 'btn-revoke-others', onclick: revokeOthers }, 'Выйти'));
  return { twofa: root, sessions };
}
