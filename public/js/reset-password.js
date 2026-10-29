// Страница сброса пароля по ссылке из Telegram-бота: /reset-password#t=<токен> (server/pwreset.js).
// Токен берётся из фрагмента (на сервер при открытии страницы он не уходит) и сразу убирается из адресной строки.
import { api, setToken } from './api.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('t') || '';
history.replaceState(null, '', location.pathname); // токен не остаётся в истории/адресной строке

function fail(text) {
  $('#reset-title').textContent = 'Ссылка недействительна';
  $('#reset-subtitle').textContent = text;
  $('#reset-form').hidden = true;
  $('#reset-done').hidden = false;
  $('#reset-done-text').textContent = 'Запросите новую: экран входа → «Забыли пароль?» или меню бота → «🔐 Безопасность» → «🔑 Сбросить пароль».';
  $('#reset-login').textContent = 'На страницу входа';
}

async function init() {
  if (!token) { fail('В ссылке нет кода сброса.'); return; }
  let info;
  try { info = await api.passwordResetCheck(token); } catch (ex) { fail(ex.message); return; }
  $('#reset-subtitle').textContent = `Аккаунт: ${info.username}`;
  $('#reset-code-field').hidden = !info.needCode;
  $('#reset-form').hidden = false;
  $('#reset-password').focus();
}

$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#reset-error');
  const password = $('#reset-password').value;
  if (password.length < 4) { err.textContent = 'Пароль должен быть не короче 4 символов'; return; }
  if (password !== $('#reset-password2').value) { err.textContent = 'Пароли не совпадают'; return; }
  const needCode = !$('#reset-code-field').hidden;
  const code = $('#reset-code').value.trim();
  if (needCode && !code) { err.textContent = 'Введите код из приложения-аутентификатора или код восстановления'; return; }
  const btn = $('#reset-submit');
  btn.disabled = true;
  err.textContent = '';
  try {
    await api.passwordResetComplete({ token, password, ...(needCode ? { code } : {}) });
    setToken(null); // старые сеансы завершены
    $('#reset-form').hidden = true;
    $('#reset-title').textContent = 'Пароль изменён';
    $('#reset-subtitle').textContent = 'Все сеансы завершены.';
    $('#reset-done').hidden = false;
    $('#reset-done-text').textContent = 'Войдите с новым паролем.';
  } catch (ex) {
    if (ex.code === 'reset_invalid') { fail(ex.message); return; }
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

init();
