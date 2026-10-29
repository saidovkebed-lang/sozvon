// «Моя учётная запись → Двухфакторная защита»: два способа — приложение-аутентификатор (TOTP, server/totp.js)
// и Telegram-бот сервера (server/tg2fa.js); можно оба, при входе подходит любой.
// Приложение: пароль → QR + секрет → код → коды восстановления. QR рисуется локально (public/js/qr.js).
// Telegram: пароль → одноразовая ссылка t.me/<бот>?start=… (+ QR) → «Start» в боте → страница обновляется сама.
// Коды восстановления — один набор на аккаунт для любого способа. Также «Выйти на других устройствах».
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
      if (res.recoveryCodes?.length) root.replaceChildren(recoveryView(res.recoveryCodes, 'Защита включена. Коды восстановления'));
      else refresh(); // уже был Telegram — коды восстановления прежние
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
const hasTg = () => !!(status?.telegram?.enabled ?? state.user?.tg2faEnabled);

/** Кнопка «Прислать код в Telegram» (код для действия в настройках). */
function tgCodeButton(errEl, id = 'twofa-action-tg') {
  const btn = h('button', { type: 'button', class: 'btn btn--ghost', id }, icon('i-send'), 'Прислать код в Telegram');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await req('POST', '/api/me/2fa/telegram/code');
      toastOk('Код отправлен в Telegram');
      if (errEl) errEl.textContent = '';
      setTimeout(() => { btn.disabled = false; }, 30_000);
    } catch (ex) {
      if (errEl) errEl.textContent = ex.message; else toastError(ex.message);
      btn.disabled = false;
    }
  });
  return btn;
}
export { tgCodeButton };

function actionForm({ title, submitText, danger = false, onSubmit, note = null }) {
  const err = errorEl();
  const tg = hasTg();
  const label = tg ? (status?.totpEnabled ? 'Код из Telegram или приложения, либо код восстановления' : 'Код из Telegram или код восстановления')
    : 'Код из приложения или код восстановления';
  const form = h('form', { class: 'form twofa-step', id: 'twofa-action-form', novalidate: true },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', hidden: true, value: state.user?.username || '' }),
    h('p', { class: 'setting__label' }, title),
    note ? h('p', { class: 'settings-hint' }, note) : '',
    h('div', { class: 'form-grid' },
      field('twofa-action-password', 'Текущий пароль', { type: 'password', autocomplete: 'current-password', required: true }),
      field('twofa-action-code', label, { ...codeAttrs, inputmode: 'text', required: true })),
    err,
    h('div', { class: 'twofa-actions' },
      tg ? tgCodeButton(err) : '',
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => refresh() }, 'Отмена'),
      h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, id: 'twofa-action-submit' }, submitText)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
    title: hasTg() ? 'Отключить приложение-аутентификатор' : 'Отключить двухфакторную защиту',
    submitText: 'Отключить',
    danger: true,
    onSubmit: async (body) => {
      const res = await req('POST', '/api/me/2fa/disable', body);
      if (res.user) applyUserUpdate(res.user);
      toastOk(hasTg() ? 'Приложение-аутентификатор отключено' : 'Двухфакторная защита отключена');
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

/* ---------- Telegram ---------- */
const cloudPasswordNote = () => h('p', { class: 'settings-hint twofa-note', id: 'twofa-tg-note' },
  icon('i-shield'),
  ' Совет: включите в Telegram «Облачный пароль» (Настройки → Конфиденциальность → Облачный пароль). '
  + 'Без него тот, кто перевыпустит вашу SIM-карту, сможет войти в ваш Telegram и получить коды. Бот включить его за вас не может.');

let linkPoll = null;
function stopLinkPoll() { clearTimeout(linkPoll); linkPoll = null; }

function startTgLink() {
  const form = h('form', { class: 'form twofa-step', id: 'twofa-tg-form', novalidate: true },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', hidden: true, value: state.user?.username || '' }),
    h('p', { class: 'settings-hint' }, 'Коды входа будут приходить от бота этого сервера Astra в Telegram, а вход можно будет подтвердить кнопкой «Это я». Подтвердите, что это вы: введите текущий пароль.'),
    field('twofa-tg-password', 'Текущий пароль', { type: 'password', autocomplete: 'current-password', required: true }),
    errorEl(),
    h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => refresh() }, 'Отмена'),
      h('button', { type: 'submit', class: 'btn btn--primary', id: 'twofa-tg-submit' }, 'Продолжить')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#twofa-error', form);
    const password = $('#twofa-tg-password', form).value;
    if (!password) { err.textContent = 'Введите текущий пароль'; return; }
    setBusy(form, true);
    try {
      showTgLink(await req('POST', '/api/me/2fa/telegram/link', { password }));
    } catch (ex) { err.textContent = ex.message; setBusy(form, false); }
  });
  root.replaceChildren(form);
  $('#twofa-tg-password', form).focus();
}

function showTgLink(link) {
  const left = h('span', { id: 'twofa-tg-left' });
  const tick = () => {
    const s = Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000));
    left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    return s;
  };
  tick();
  const cancel = async () => {
    stopLinkPoll();
    try { await req('DELETE', '/api/me/2fa/telegram/link'); } catch { /* ignore */ }
    refresh();
  };
  const view = h('div', { class: 'twofa-step', id: 'twofa-tg-link' },
    h('p', { class: 'settings-hint' }, '1. Откройте ссылку на телефоне или компьютере с Telegram (или отсканируйте QR-код камерой телефона).'),
    h('a', { class: 'btn btn--primary twofa-tg-open', id: 'twofa-tg-open', href: link.link, target: '_blank', rel: 'noopener noreferrer' }, icon('i-send'), `Открыть @${link.bot}`),
    h('div', { class: 'twofa-qr', id: 'twofa-tg-qr' }, qrSvg(link.link, { label: 'QR-код ссылки на бота Telegram' })),
    h('p', { class: 'settings-hint' }, '2. В боте нажмите «Запустить» (Start). Эта страница обновится сама.'),
    h('p', { class: 'settings-hint', role: 'status' }, 'Ожидаем привязку… Ссылка одноразовая и действует ещё ', left, '.'),
    cloudPasswordNote(),
    h('p', { class: 'form__error', id: 'twofa-error', role: 'alert' }),
    h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', id: 'twofa-tg-cancel', onclick: cancel }, 'Отмена')));
  root.replaceChildren(view);
  const poll = async () => {
    linkPoll = null;
    if (!view.isConnected) return; // настройки закрыты
    if (tick() <= 0) { $('#twofa-error', view).textContent = 'Время ссылки истекло — начните заново.'; return; }
    try {
      const st = await req('GET', '/api/me/2fa/telegram/link');
      if (st.linked) {
        if (st.user) applyUserUpdate(st.user);
        toastOk('Telegram привязан');
        if (st.recoveryCodes?.length) root.replaceChildren(recoveryView(st.recoveryCodes, 'Telegram привязан. Коды восстановления'));
        else {
          root.replaceChildren(h('div', { class: 'twofa-step', id: 'twofa-tg-done' },
            h('p', { class: 'setting__label' }, 'Telegram привязан'),
            h('p', { class: 'settings-hint' }, 'Коды восстановления остались прежними — они подходят для любого способа.'),
            h('div', { class: 'twofa-actions' }, h('button', { type: 'button', class: 'btn btn--primary', id: 'twofa-done', onclick: () => refresh() }, 'Готово'))));
        }
        return;
      }
      if (!st.pending) { $('#twofa-error', view).textContent = 'Ссылка больше не действует — начните заново.'; return; }
    } catch { /* сеть — повторим */ }
    linkPoll = setTimeout(poll, 2000);
  };
  stopLinkPoll();
  linkPoll = setTimeout(poll, 1500);
}

function unlinkTgFlow() {
  actionForm({
    title: 'Отвязать Telegram',
    note: 'Нажмите «Прислать код в Telegram» и введите код из бота (или код из приложения / код восстановления).',
    submitText: 'Отвязать',
    danger: true,
    onSubmit: async (body) => {
      const res = await req('POST', '/api/me/2fa/telegram/unlink', body);
      if (res.user) applyUserUpdate(res.user);
      toastOk('Telegram отвязан');
      refresh();
    },
  });
}

/* ---------- состояние ---------- */
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function methodRow({ id, title, desc, on, actions }) {
  return h('div', { class: 'setting twofa-method', id, dataset: { enabled: String(!!on) } },
    h('div', { class: 'setting__text' },
      h('span', { class: 'setting__label' }, title, on ? h('span', { class: 'twofa-badge' }, 'включено') : ''),
      h('p', { class: 'setting__desc' }, desc)),
    h('div', { class: 'twofa-actions' }, ...actions));
}

function renderStatus() {
  stopLinkPoll();
  const on = !!status?.enabled;
  const totpOn = !!status?.totpEnabled;
  const tg = status?.telegram || { available: false, enabled: !!state.user?.tg2faEnabled };
  const left = status?.recoveryCodesLeft ?? 0;
  const ways = [totpOn && 'код из приложения', tg.enabled && 'код или кнопка «Это я» в Telegram'].filter(Boolean).join(' или ');
  const desc = on
    ? `Включена. При входе нужен ${ways}. Кодов восстановления осталось: ${left}.`
    : 'При входе, кроме пароля, потребуется второй шаг: 6-значный код из приложения-аутентификатора на телефоне или подтверждение в Telegram. Выберите способ.';
  const row = h('div', { class: 'setting', id: 'twofa-status', dataset: { enabled: String(on) } },
    h('div', { class: 'setting__text' },
      h('span', { class: 'setting__label' }, on ? 'Двухфакторная защита включена' : 'Двухфакторная защита выключена'),
      h('p', { class: 'setting__desc' }, desc)),
    on ? h('div', { class: 'twofa-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', id: 'twofa-regen', onclick: regenFlow }, 'Новые коды')) : '');

  const totpRow = methodRow({
    id: 'twofa-method-totp',
    title: 'Приложение-аутентификатор',
    on: totpOn,
    desc: totpOn ? 'Google Authenticator, Яндекс Ключ, Aegis, 2FAS и т. п. Работает без интернета.'
      : 'Google Authenticator, Яндекс Ключ, Aegis, 2FAS и т. п. Работает без интернета и сторонних сервисов.',
    actions: [totpOn
      ? h('button', { type: 'button', class: 'btn btn--danger-soft', id: 'twofa-disable', onclick: disableFlow }, 'Отключить')
      : h('button', { type: 'button', class: on ? 'btn btn--ghost' : 'btn btn--primary', id: 'twofa-enable', onclick: startEnroll }, on ? 'Подключить' : 'Включить')],
  });
  let tgRow = null;
  if (tg.enabled || tg.available) {
    const tgDesc = tg.enabled
      ? `Привязан${tg.account ? `: ${tg.account}` : ''}${tg.linkedAt ? `, ${fmtDate(tg.linkedAt)}` : ''}. Коды входа приходят от бота сервера, вход можно подтвердить кнопкой «Это я».`
        + (tg.lockedFor ? ' Сейчас вход по коду из Telegram приостановлен (нажата «Это не я»).' : '')
      : 'Без установки приложений: код входа и кнопка «Это я» приходят от бота этого сервера в Telegram.';
    tgRow = methodRow({
      id: 'twofa-method-tg',
      title: 'Telegram',
      on: tg.enabled,
      desc: tgDesc,
      actions: [tg.enabled
        ? h('button', { type: 'button', class: 'btn btn--danger-soft', id: 'twofa-tg-unlink', onclick: unlinkTgFlow }, 'Отвязать')
        : h('button', { type: 'button', class: on ? 'btn btn--ghost' : 'btn btn--primary', id: 'twofa-tg-enable', onclick: startTgLink }, on ? 'Подключить' : 'Включить')],
    });
  }
  const methods = h('div', { class: 'twofa-methods', id: 'twofa-methods' },
    h('p', { class: 'settings-hint' }, on ? 'Способы (при входе подходит любой включённый):' : 'Способ второго шага:'),
    totpRow, tgRow || '');
  const low = on && left <= 3
    ? h('p', { class: 'settings-hint twofa-warn' }, left === 0 ? 'Коды восстановления закончились — создайте новые.' : 'Кодов восстановления мало — создайте новые.')
    : null;
  root.replaceChildren(row, methods, tg.enabled ? cloudPasswordNote() : '', low || '');
}

export async function refresh() {
  if (!root) return;
  status = {
    enabled: !!(state.user?.totpEnabled || state.user?.tg2faEnabled), totpEnabled: !!state.user?.totpEnabled, recoveryCodesLeft: 0,
    telegram: { available: false, enabled: !!state.user?.tg2faEnabled },
  };
  renderStatus();
  if (state.user?.isBot) return;
  try {
    status = await req('GET', '/api/me/2fa');
    if (!status.telegram) status.telegram = { available: false, enabled: false }; // старый сервер
    if (!('totpEnabled' in status)) status.totpEnabled = status.enabled;
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
