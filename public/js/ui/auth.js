import { $ } from '../util.js';
import { api, setToken } from '../api.js';

let mode = 'login';
let challenge = null;      // 2FA: токен второго шага входа (5 минут, одноразовый)
let recoveryMode = false;

function show2fa(on) {
  $('#auth-form').hidden = on;
  $('#auth-2fa-form').hidden = !on;
  $('#auth-title').textContent = on ? 'Двухфакторная защита' : (mode === 'login' ? 'С возвращением!' : 'Создать аккаунт');
  $('#auth-subtitle').textContent = on ? 'Введите код, чтобы завершить вход' : (mode === 'login' ? 'Рады видеть тебя снова в Astra' : 'Придумай имя и пароль — и зови друзей');
  $('#auth-2fa-error').textContent = '';
  if (on) { set2faMode(false); $('#auth-2fa-code').value = ''; $('#auth-2fa-code').focus(); }
  else { challenge = null; $('#auth-password').focus(); }
}

function set2faMode(recovery) {
  recoveryMode = recovery;
  const input = $('#auth-2fa-code');
  $('#auth-2fa-label').textContent = recovery ? 'Код восстановления' : 'Код из приложения-аутентификатора';
  input.inputMode = recovery ? 'text' : 'numeric';
  input.placeholder = recovery ? 'xxxxx-xxxxx' : '000000';
  $('#auth-2fa-recovery').textContent = recovery ? 'Ввести код из приложения' : 'Использовать код восстановления';
}

function applyMode() {
  const login = mode === 'login';
  $('#auth-title').textContent = login ? 'С возвращением!' : 'Создать аккаунт';
  $('#auth-subtitle').textContent = login ? 'Рады видеть тебя снова в Astra' : 'Придумай имя и пароль — и зови друзей';
  $('#auth-submit').textContent = login ? 'Войти' : 'Зарегистрироваться';
  $('#auth-switch-text').textContent = login ? 'Нет аккаунта?' : 'Уже есть аккаунт?';
  $('#auth-toggle').textContent = login ? 'Зарегистрироваться' : 'Войти';
  $('#auth-password').autocomplete = login ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

export function showAuth(message = '') {
  if (challenge) show2fa(false);
  $('#app').hidden = true;
  $('#auth-screen').hidden = false;
  $('#auth-error').textContent = message;
  $('#auth-username').focus();
}

export function hideAuth() {
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
}

export function initAuth(onLoggedIn) {
  applyMode();
  $('#auth-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    mode = mode === 'login' ? 'register' : 'login';
    applyMode();
  });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const err = $('#auth-error');
    if (username.length < 2 || username.length > 24) { err.textContent = 'Имя — от 2 до 24 символов'; return; }
    if (!password) { err.textContent = 'Введите пароль'; return; }
    const btn = $('#auth-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
      if (res?.twoFactor && res.challenge) { // пароль верен, нужен второй шаг
        challenge = res.challenge;
        $('#auth-password').value = '';
        show2fa(true);
        return;
      }
      setToken(res.token);
      $('#auth-password').value = '';
      onLoggedIn(res.token);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });

  // 2FA: второй шаг
  $('#auth-2fa-recovery').addEventListener('click', (e) => { e.preventDefault(); set2faMode(!recoveryMode); $('#auth-2fa-code').focus(); });
  $('#auth-2fa-back').addEventListener('click', (e) => { e.preventDefault(); show2fa(false); });
  $('#auth-2fa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#auth-2fa-error');
    const code = $('#auth-2fa-code').value.trim();
    if (!code) { err.textContent = 'Введите код'; return; }
    if (!recoveryMode && !/^\d{6}$/.test(code.replace(/\s/g, ''))) { err.textContent = 'Код — 6 цифр из приложения'; return; }
    const btn = $('#auth-2fa-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await api.login2fa(challenge, code);
      challenge = null;
      setToken(res.token);
      $('#auth-2fa-code').value = '';
      show2fa(false);
      onLoggedIn(res.token);
    } catch (ex) {
      if (ex.code === 'challenge_invalid') { show2fa(false); $('#auth-error').textContent = ex.message; return; }
      err.textContent = ex.message;
      $('#auth-2fa-code').select();
    } finally {
      btn.disabled = false;
    }
  });
}
