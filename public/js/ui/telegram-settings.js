// «Настройки» → «Уведомления» → «Telegram»: что бот Astra пересылает в Telegram, пауза и вход без пароля.
// Те же настройки — в меню бота («💬 Уведомления», «🔐 Безопасность»). REST: GET/PATCH /api/me/telegram.
import { h } from '../util.js';
import { api } from '../api.js';

let box = null;
let openAccount = () => {};
let data = null;

const ROWS = [
  ['dm', 'Личные сообщения', 'Новые сообщения в ЛС.'],
  ['mention', 'Упоминания', 'Когда вас упоминают через @ник.'],
  ['everyone', '@everyone и @here', 'Сообщения для всех участников сервера.'],
  ['onlyAway', 'Только когда меня нет в Astra', 'Не дублировать, пока Astra открыта на экране.'],
];

function switchEl(id, checked, onchange, disabled = false) {
  const input = h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', disabled });
  input.checked = !!checked;
  input.addEventListener('change', () => onchange(input.checked, input));
  return input;
}

function row(id, label, desc, control) {
  return h('div', { class: 'setting' },
    h('div', { class: 'setting__text' },
      h('label', { class: 'setting__label', for: id }, label),
      desc ? h('p', { class: 'setting__desc' }, desc) : null),
    control);
}

async function patch(body) {
  const err = box.querySelector('#tg-settings-error');
  err.textContent = '';
  try {
    data = await api.patchTelegramSettings(body);
    render();
  } catch (ex) {
    err.textContent = ex.message;
    render();
  }
}

function fmtUntil(ms) {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function render() {
  if (!box) return;
  const err = h('p', { class: 'form__error', id: 'tg-settings-error', role: 'alert' });
  if (!data) { box.replaceChildren(h('p', { class: 'settings-hint', id: 'tg-settings-status' }, 'Загрузка…')); return; }
  if (!data.available) {
    box.replaceChildren(h('p', { class: 'settings-hint', id: 'tg-settings-status', dataset: { state: 'unavailable' } }, 'Telegram-бот не настроен на этом сервере.'));
    return;
  }
  if (!data.linked) {
    box.replaceChildren(
      h('p', { class: 'settings-hint', id: 'tg-settings-status', dataset: { state: 'unlinked' } },
        `Привяжите Telegram, и бот${data.bot ? ` @${data.bot}` : ' Astra'} будет присылать личные сообщения и упоминания, пока вас нет в Astra; на них можно ответить прямо из Telegram. Там же — вход без пароля и сброс пароля.`),
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'tg-settings-link', onclick: () => openAccount() }, 'Привязать Telegram'));
    return;
  }
  const n = data.notify || {};
  const paused = n.pauseUntil && n.pauseUntil > Date.now();
  const pwField = h('div', { class: 'tg-pwless-confirm', id: 'tg-pwless-confirm', hidden: true },
    h('input', { class: 'input', type: 'password', id: 'tg-pwless-password', autocomplete: 'current-password', placeholder: 'Текущий пароль' }),
    h('button', {
      type: 'button', class: 'btn btn--primary btn--sm', id: 'tg-pwless-confirm-btn',
      onclick: () => patch({ passwordless: true, password: box.querySelector('#tg-pwless-password').value }),
    }, 'Включить'));
  box.replaceChildren(
    h('p', { class: 'settings-hint', id: 'tg-settings-status', dataset: { state: 'linked' } },
      `Telegram привязан${data.account ? ` (${data.account})` : ''}. ${paused ? `Уведомления на паузе до ${fmtUntil(n.pauseUntil)}.` : 'Ответьте на уведомление в Telegram — ответ придёт в Astra.'} В статусе «Не беспокоить» уведомления не приходят.`),
    ...ROWS.map(([key, label, desc]) => row(`tg-notify-${key}`, label, desc, switchEl(`tg-notify-${key}`, n[key], (v) => patch({ notify: { [key]: v } })))),
    h('div', { class: 'tg-pause' },
      paused
        ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'tg-pause-0', onclick: () => patch({ pauseMinutes: 0 }) }, 'Снять паузу')
        : [h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'tg-pause-60', onclick: () => patch({ pauseMinutes: 60 }) }, 'Пауза на 1 час'),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'tg-pause-480', onclick: () => patch({ pauseMinutes: 480 }) }, 'Пауза на 8 часов')]),
    row('tg-passwordless', 'Вход без пароля через Telegram', 'На экране входа «Войти через Telegram» → кнопка «✅ Войти» в боте. Если включено приложение-аутентификатор, код из него всё равно понадобится.',
      switchEl('tg-passwordless', data.passwordless, (v, input) => {
        if (!v) { patch({ passwordless: false }); return; }
        input.checked = false; // включится после пароля
        pwField.hidden = false;
        pwField.querySelector('input').focus();
      })),
    pwField,
    err);
}

/** Блок для раздела «Уведомления». onAccount — открыть «Моя учётная запись» (привязка Telegram). */
export function telegramSection({ onAccount } = {}) {
  openAccount = onAccount || (() => {});
  box = h('div', { class: 'tg-settings', id: 'settings-telegram' });
  render();
  return box;
}

export async function refreshTelegramSettings() {
  if (!box) return;
  try { data = await api.telegramSettings(); } catch { data = { available: false }; }
  render();
}
