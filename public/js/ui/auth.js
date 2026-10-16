import { $ } from '../util.js';
import { api, setToken } from '../api.js';

let mode = 'login';

function applyMode() {
  const login = mode === 'login';
  $('#auth-title').textContent = login ? 'С возвращением!' : 'Создать аккаунт';
  $('#auth-subtitle').textContent = login ? 'Рады видеть тебя снова в Созвоне' : 'Придумай имя и пароль — и зови друзей';
  $('#auth-submit').textContent = login ? 'Войти' : 'Зарегистрироваться';
  $('#auth-switch-text').textContent = login ? 'Нет аккаунта?' : 'Уже есть аккаунт?';
  $('#auth-toggle').textContent = login ? 'Зарегистрироваться' : 'Войти';
  $('#auth-password').autocomplete = login ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

export function showAuth(message = '') {
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
      setToken(res.token);
      $('#auth-password').value = '';
      onLoggedIn(res.token);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
}
