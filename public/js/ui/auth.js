import { $ } from '../util.js';
import { api, setToken } from '../api.js';

let mode = 'login';
let challenge = null;      // 2FA: токен второго шага входа (5 минут, одноразовый)
let methods = [];          // способы второго шага: 'totp' | 'telegram' | 'recovery'
let recoveryMode = false;
let onDone = null;
let pollTimer = null;      // Telegram: опрос «нажато ли „Это я“»
let tickTimer = null;      // обратный отсчёт до повторной отправки
let resendAt = 0;
let tgState = null;

const hasTg = () => methods.includes('telegram');
const hasTotp = () => methods.includes('totp');

function stopTelegram() {
  clearTimeout(pollTimer); pollTimer = null;
  clearInterval(tickTimer); tickTimer = null;
  tgState = null;
}

let tgAvailable = false;   // бот Astra настроен на сервере (/api/config → telegram)
let tgLoginChallenge = null; // вход без пароля: токен ожидания «✅ Войти»
let tgLoginTimer = null;

/** Показать одну из форм экрана входа: main | 2fa | tglogin | forgot */
function showPanel(name) {
  $('#auth-form').hidden = name !== 'main';
  $('#auth-2fa-form').hidden = name !== '2fa';
  $('#auth-tglogin-form').hidden = name !== 'tglogin';
  $('#auth-forgot-form').hidden = name !== 'forgot';
  if (name !== 'tglogin') stopTgLogin();
}

function stopTgLogin() {
  clearTimeout(tgLoginTimer); tgLoginTimer = null;
  tgLoginChallenge = null;
}

/** /api/config: есть ли бот — тогда показываем «Войти через Telegram» и «Забыли пароль?» */
export function setAuthTelegram(on) {
  tgAvailable = !!on;
  updateAlt();
}
function updateAlt() {
  $('#auth-alt').hidden = !(tgAvailable && mode === 'login');
}

function show2fa(on) {
  showPanel(on ? '2fa' : 'main');
  $('#auth-2fa-form').hidden = !on;
  $('#auth-title').textContent = on ? 'Двухфакторная защита' : (mode === 'login' ? 'С возвращением!' : 'Создать аккаунт');
  $('#auth-subtitle').textContent = on
    ? (hasTg() ? 'Подтвердите вход в Telegram или введите код' : 'Введите код, чтобы завершить вход')
    : (mode === 'login' ? 'Рады видеть тебя снова в Astra' : 'Придумай имя и пароль — и зови друзей');
  $('#auth-2fa-error').textContent = '';
  $('#auth-2fa-tg').hidden = !(on && hasTg());
  if (on) { set2faMode(false); $('#auth-2fa-code').value = ''; $('#auth-2fa-code').focus(); }
  else { challenge = null; methods = []; stopTelegram(); $('#auth-password').focus(); }
}

function codeLabel() {
  if (hasTg() && hasTotp()) return 'Код из Telegram или приложения-аутентификатора';
  if (hasTg()) return 'Код из Telegram';
  return 'Код из приложения-аутентификатора';
}

function set2faMode(recovery) {
  recoveryMode = recovery;
  const input = $('#auth-2fa-code');
  $('#auth-2fa-label').textContent = recovery ? 'Код восстановления' : codeLabel();
  input.inputMode = recovery ? 'text' : 'numeric';
  input.placeholder = recovery ? 'xxxxx-xxxxx' : '000000';
  $('#auth-2fa-recovery').textContent = recovery
    ? (hasTg() && !hasTotp() ? 'Ввести код из Telegram' : 'Ввести код из приложения')
    : 'Использовать код восстановления';
}

/* ---------- Telegram ---------- */
function renderTelegram(t) {
  if (!t) return;
  tgState = t;
  const text = $('#auth-2fa-tg-text');
  const box = $('#auth-2fa-tg');
  box.dataset.state = t.state;
  resendAt = Date.now() + (t.resendIn || 0) * 1000;
  const alt = hasTotp() ? 'код из приложения-аутентификатора или код восстановления' : 'код восстановления';
  const msg = {
    sending: 'Отправляем код в Telegram…',
    sent: 'Код отправлен в Telegram. Нажмите «✅ Это я» в боте — вход завершится сам — или введите код здесь.',
    failed: `Не удалось отправить код: Telegram недоступен с сервера. Введите ${alt}.`,
    locked: t.error || `Вход по коду из Telegram временно приостановлен. Введите ${alt}.`,
    unavailable: `Вход через Telegram сейчас недоступен на сервере. Введите ${alt}.`,
    limited: 'Код уже отправляли недавно — новый можно запросить чуть позже.',
    none: 'Код ещё не отправлен — запросите его кнопкой ниже.',
  }[t.state] || 'Код отправлен в Telegram.';
  text.textContent = msg;
  updateResend();
  if (['failed', 'locked', 'unavailable'].includes(t.state) && !recoveryMode && !hasTotp()) set2faMode(true);
}

function updateResend() {
  const btn = $('#auth-2fa-resend');
  const st = tgState?.state;
  const hide = st === 'locked' || st === 'unavailable';
  btn.hidden = hide;
  const left = Math.ceil((resendAt - Date.now()) / 1000);
  btn.disabled = left > 0 || st === 'sending';
  btn.textContent = left > 0 ? `Отправить код ещё раз (через ${left} с)` : 'Отправить код ещё раз';
}

function startTelegram(initial) {
  stopTelegram();
  renderTelegram(initial || { state: 'sending', resendIn: 30 });
  tickTimer = setInterval(updateResend, 1000);
  const poll = async () => {
    pollTimer = null;
    if (!challenge) return;
    const ch = challenge;
    try {
      const res = await api.login2faStatus(ch);
      if (ch !== challenge) return;
      if (res?.token) { finishLogin(res.token); return; }
      if (res?.telegram) renderTelegram(res.telegram);
    } catch (ex) {
      if (ch !== challenge) return;
      if (ex.code === 'challenge_invalid' || ex.code === 'challenge_denied') {
        show2fa(false);
        $('#auth-error').textContent = ex.message;
        return;
      }
      // сеть/лимит — просто повторим позже
    }
    if (challenge === ch) pollTimer = setTimeout(poll, 2000);
  };
  pollTimer = setTimeout(poll, 1500);
}

function finishLogin(token) {
  challenge = null;
  stopTelegram();
  setToken(token);
  $('#auth-2fa-code').value = '';
  show2fa(false);
  onDone?.(token);
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
  updateAlt();
}

/* ---------- вход без пароля через Telegram ---------- */
function tgLoginStatus(text, state = 'ok') {
  const box = $('#auth-tglogin-box');
  box.hidden = !text;
  box.dataset.state = state;
  $('#auth-tglogin-status').textContent = text;
}
function openTgLogin() {
  showPanel('tglogin');
  $('#auth-title').textContent = 'Вход через Telegram';
  $('#auth-subtitle').textContent = 'Без пароля — подтвердите вход в боте Astra';
  $('#auth-tglogin-username').value = $('#auth-username').value.trim();
  $('#auth-tglogin-error').textContent = '';
  tgLoginStatus('');
  $('#auth-tglogin-submit').hidden = false;
  $('#auth-tglogin-username').focus();
}
function pollTgLogin() {
  tgLoginTimer = null;
  const ch = tgLoginChallenge;
  if (!ch) return;
  api.loginTelegramStatus(ch).then((res) => {
    if (ch !== tgLoginChallenge) return;
    if (res?.token) { stopTgLogin(); finishLogin(res.token); return; }
    if (res?.twoFactor && res.challenge) {
      // «✅ Войти» нажато, но включено приложение-аутентификатор: нужен код из него
      stopTgLogin();
      challenge = res.challenge;
      methods = Array.isArray(res.methods) ? res.methods : ['totp', 'recovery'];
      show2fa(true);
      $('#auth-subtitle').textContent = 'Вход подтверждён в Telegram — введите код из приложения-аутентификатора';
      return;
    }
    tgLoginTimer = setTimeout(pollTgLogin, 2000);
  }).catch((ex) => {
    if (ch !== tgLoginChallenge) return;
    if (ex.code === 'challenge_invalid' || ex.code === 'challenge_denied' || ex.status === 401) {
      stopTgLogin();
      tgLoginStatus(ex.code === 'challenge_denied' ? 'Вход отклонён в Telegram («Это не я»).' : 'Время на подтверждение истекло. Отправьте запрос ещё раз.', 'error');
      $('#auth-tglogin-submit').hidden = false;
      return;
    }
    tgLoginTimer = setTimeout(pollTgLogin, 3000); // сеть — повторим
  });
}

/* ---------- забыли пароль ---------- */
function openForgot() {
  showPanel('forgot');
  $('#auth-title').textContent = 'Сброс пароля';
  $('#auth-subtitle').textContent = 'Ссылку для сброса пришлёт бот Astra в Telegram';
  $('#auth-forgot-username').value = $('#auth-username').value.trim();
  $('#auth-forgot-error').textContent = '';
  $('#auth-forgot-box').hidden = true;
  $('#auth-forgot-username').focus();
}
function backToMain() {
  showPanel('main');
  applyMode();
  $('#auth-username').focus();
}

export function showAuth(message = '') {
  if (challenge) show2fa(false);
  else showPanel('main');
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
  onDone = onLoggedIn;
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
        methods = Array.isArray(res.methods) ? res.methods : ['totp', 'recovery'];
        $('#auth-password').value = '';
        show2fa(true);
        if (hasTg()) startTelegram(res.telegram);
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

  // Telegram: вход без пароля и сброс пароля
  $('#auth-tg-login').addEventListener('click', openTgLogin);
  $('#auth-forgot').addEventListener('click', (e) => { e.preventDefault(); openForgot(); });
  $('#auth-tglogin-back').addEventListener('click', (e) => { e.preventDefault(); backToMain(); });
  $('#auth-forgot-back').addEventListener('click', (e) => { e.preventDefault(); backToMain(); });
  $('#auth-tglogin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#auth-tglogin-username').value.trim();
    const err = $('#auth-tglogin-error');
    if (username.length < 2) { err.textContent = 'Введите имя пользователя'; return; }
    const btn = $('#auth-tglogin-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await api.loginTelegram(username);
      tgLoginChallenge = res.challenge;
      btn.hidden = true;
      tgLoginStatus('Если для этого аккаунта включён вход через Telegram, бот Astra прислал запрос. Нажмите в нём «✅ Войти» — вход завершится сам.');
      tgLoginTimer = setTimeout(pollTgLogin, 1500);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#auth-forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#auth-forgot-username').value.trim();
    const err = $('#auth-forgot-error');
    if (username.length < 2) { err.textContent = 'Введите имя пользователя'; return; }
    const btn = $('#auth-forgot-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await api.passwordResetRequest(username);
      const box = $('#auth-forgot-box');
      box.hidden = false;
      box.dataset.state = 'ok';
      $('#auth-forgot-status').textContent = res.message;
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });

  // 2FA: второй шаг
  $('#auth-2fa-recovery').addEventListener('click', (e) => { e.preventDefault(); set2faMode(!recoveryMode); $('#auth-2fa-code').focus(); });
  $('#auth-2fa-back').addEventListener('click', (e) => { e.preventDefault(); show2fa(false); });
  $('#auth-2fa-resend').addEventListener('click', async () => {
    if (!challenge) return;
    const btn = $('#auth-2fa-resend');
    btn.disabled = true;
    try {
      const res = await api.login2faResend(challenge);
      renderTelegram(res.telegram);
      $('#auth-2fa-error').textContent = '';
    } catch (ex) {
      if (ex.code === 'challenge_invalid') { show2fa(false); $('#auth-error').textContent = ex.message; return; }
      $('#auth-2fa-error').textContent = ex.message;
      updateResend();
    }
  });
  $('#auth-2fa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#auth-2fa-error');
    const code = $('#auth-2fa-code').value.trim();
    if (!code) { err.textContent = 'Введите код'; return; }
    if (!recoveryMode && !/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      err.textContent = hasTg() && !hasTotp() ? 'Код — 6 цифр из Telegram' : 'Код — 6 цифр из приложения';
      return;
    }
    const btn = $('#auth-2fa-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await api.login2fa(challenge, code);
      finishLogin(res.token);
    } catch (ex) {
      if (ex.code === 'challenge_invalid') { show2fa(false); $('#auth-error').textContent = ex.message; return; }
      err.textContent = ex.message;
      $('#auth-2fa-code').select();
    } finally {
      btn.disabled = false;
    }
  });
}
