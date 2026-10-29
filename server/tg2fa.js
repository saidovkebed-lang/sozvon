// Второй фактор через Telegram-бота владельца — альтернатива приложению-аутентификатору.
//
// Привязка: пароль → одноразовая ссылка https://t.me/<бот>?start=<токен> (10 минут) → пользователь нажимает
// «Start» в боте → сервер связывает chat id с аккаунтом. Поля пользователя в db.json:
//   tg2fa       — true, если вход через Telegram включён;
//   tgChatId    — id личного чата с ботом (строка). Клиенту НЕ отдаётся никогда (ни владельцу, ни другим);
//   tgLinkedAt  — когда привязан; tgName — имя/@ник в Telegram (видит только сам владелец, чтобы заметить чужую привязку);
//   tgLockUntil — до какого момента вход по коду из Telegram приостановлен (после «Это не я»);
//   tgLogin     — «Вход без пароля через Telegram» (кнопка «✅ Войти» в боте; см. startPasswordless);
//   tgNotify    — настройки уведомлений в Telegram (server/tgbot.js).
// Клиенту (только самому себе) — флаг tg2faEnabled (server/model.js publicUser).
//
// Коды: 6 цифр, 5 минут, одноразовые, в памяти только HMAC (ключ процесса), привязаны к конкретному
// запросу (второй шаг входа / разблокировка админ-панели / действие в настройках). В сообщении — кнопки
// «✅ Это я» / «⛔ Это не я» (callback_data — непрозрачный случайный id; чат нажавшего обязан совпадать
// с привязанным). Отправка: не чаще 1 раза в 30 с и 5 раз за 15 минут на аккаунт.
// Неверные коды считаются в общий лимит 2FA (server/totp.js: 5 за 15 минут → блокировка).
import crypto from 'node:crypto';
import { db, save } from './db.js';
import { HttpError } from './http-error.js';
import { waitText } from './rate-limit.js';
import { botConfig, getMe, sendMessage, editMessageText, answerCallbackQuery, createPoller } from './telegram.js';
import {
  has2FA, setTelegramVerifier, getChallenge, dropChallenge, checkPassword, checkUserCode,
  issueRecoveryIfMissing, dropRecoveryIfUnused,
} from './totp.js';

// Сроки (переменные окружения TG2FA_* — только для тестов; в бою не задавайте).
const envMs = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };
const LINK_TTL_MS = () => envMs('TG2FA_LINK_TTL_MS', 10 * 60_000);
const CODE_TTL_MS = () => envMs('TG2FA_CODE_TTL_MS', 5 * 60_000);
const RESEND_GAP_MS = () => envMs('TG2FA_RESEND_GAP_MS', 30_000);
const DENY_LOCK_MS = 15 * 60_000;
const RESEND_MAX = 5;
const RESEND_WINDOW_MS = 15 * 60_000;
const FRESH_CODES_TTL_MS = 15 * 60_000;

const KEY = crypto.randomBytes(32); // HMAC кодов: только в памяти процесса
const hashCode = (id, code) => crypto.createHmac('sha256', KEY).update(`${id}:${code}`).digest();
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomBytes(16).toString('base64url'); // 22 символа, в callback_data
const findUser = (id) => db.data.users.find((u) => u.id === id) || null;

let poller = null;
let hooks = { onUserUpdated: () => {}, onSecurityEvent: () => {}, onLinked: () => {} };
// Обработчик обновлений бота: по умолчанию — только 2FA; server/tgbot.js подключает меню (setUpdateHandler)
let updateHandler = (u) => handleTg2faUpdate(u);
export function setUpdateHandler(fn) { updateHandler = fn; }
/** Привязка завершена (server/tgbot.js: главное меню, команды бота). */
export function setLinkedHook(fn) { hooks.onLinked = fn; }
/** Запустить опрос бота (постоянный — см. server/telegram.js continuousPolling). */
export function kickPoller() { poller?.kick(); }

const links = new Map();      // sha256(токен) → { userId, exp }
const freshCodes = new Map(); // userId → { codes, exp } — коды восстановления, созданные при привязке (выдаются один раз)
const requests = new Map();   // id → запрос кода (см. createRequest)
const byChallenge = new Map(); // токен второго шага входа → id
const bySession = new Map();  // токен сессии (разблокировка админ-панели) → id
const byAction = new Map();   // userId → id (код для действия в настройках)
const denied = new Map();     // токен второго шага → exp (вход отклонён кнопкой «Это не я»)
const sends = new Map();      // userId → [время отправки…]

export const telegramAvailable = () => botConfig().configured;

/** Подключить (из server/twofa-routes.js) — один раз на процесс. */
export function initTelegram2FA({ dataDir, onUserUpdated, onSecurityEvent } = {}) {
  if (onUserUpdated) hooks.onUserUpdated = onUserUpdated;
  if (onSecurityEvent) hooks.onSecurityEvent = onSecurityEvent;
  if (!poller) {
    poller = createPoller({ dataDir, wanted, onUpdate: (u) => updateHandler(u) });
    setImmediate(() => poller.kick()); // постоянный опрос (если задан токен)
  }
  return poller;
}
/** Журнал событий безопасности (подключает модуль администрирования: запись в журнал аудита). */
export function setSecurityHook(fn) { hooks.onSecurityEvent = fn; }

function security(user, action, details, ip) {
  console.warn(`[2fa] ${action}: пользователь ${user?.username}`);
  try { hooks.onSecurityEvent(user, action, details, ip); } catch { /* журнал не должен ломать вход */ }
}

/* ---------------- опрос нужен, только пока есть чего ждать ---------------- */
function wanted() {
  if (links.size) return true;
  for (const r of requests.values()) if (r.buttons && (r.state === 'pending' || r.state === 'sending')) return true;
  return false;
}
const kick = () => poller?.kick();

/* ---------------- описание устройства ---------------- */
export function uaSummary(ua) {
  const s = String(ua || '');
  if (!s) return 'неизвестное устройство';
  const browser = /AstraDesktop|Electron\//.test(s) ? 'приложение Astra'
    : /YaBrowser\//.test(s) ? 'Яндекс Браузер'
      : /Edg\//.test(s) ? 'Edge'
        : /OPR\//.test(s) ? 'Opera'
          : /Firefox\//.test(s) ? 'Firefox'
            : /Chrome\//.test(s) ? 'Chrome'
              : /Safari\//.test(s) ? 'Safari' : null;
  const os = /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
      : /Windows/.test(s) ? 'Windows'
        : /Mac OS X|Macintosh/.test(s) ? 'macOS'
          : /Linux/.test(s) ? 'Linux' : null;
  if (!browser && !os) return s.replace(/[^\w ./()-]/g, '').slice(0, 40) || 'неизвестное устройство';
  return [browser, os].filter(Boolean).join(', ');
}

/** IP без последних октетов: 89.108.*.* (IPv6 — первые две группы). */
export function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '');
  const v4 = s.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.${v4[2]}.*.*`;
  if (s.includes(':')) return `${s.split(':').slice(0, 2).join(':')}:*`;
  return 'неизвестен';
}

/* ---------------- лимит отправки ---------------- */
function sendWait(userId) {
  const now = Date.now();
  const list = (sends.get(userId) || []).filter((t) => t > now - RESEND_WINDOW_MS);
  sends.set(userId, list);
  if (!list.length) return 0;
  const gap = list[list.length - 1] + RESEND_GAP_MS() - now;
  const cap = list.length >= RESEND_MAX ? list[0] + RESEND_WINDOW_MS - now : 0;
  return Math.max(0, Math.ceil(Math.max(gap, cap) / 1000));
}
const noteSend = (userId) => { sends.set(userId, [...(sends.get(userId) || []), Date.now()]); };
/** Общий лимит сообщений с кодами/ссылками на аккаунт (вход, сброс пароля): секунд до следующей отправки. */
export const tgSendWait = (userId) => sendWait(userId);
export const tgNoteSend = (userId) => noteSend(userId);

export function tgLockedFor(user) {
  const t = Number(user?.tgLockUntil) || 0;
  return t > Date.now() ? Math.ceil((t - Date.now()) / 1000) : 0;
}

/* ---------------- запросы кода ---------------- */
const TITLES = {
  login: '🔐 Вход в Astra',
  admin: '🔐 Открыть админ-панель Astra',
  action: '🔐 Подтверждение действия в Astra (настройки безопасности)',
  pwless: '🔐 Вход в Astra без пароля',
};
const DONE = {
  approved: { login: '✅ Вход подтверждён', admin: '✅ Вход в админ-панель подтверждён', action: '✅ Действие подтверждено', pwless: '✅ Вход подтверждён' },
  denied: { login: '⛔ Вход отклонён', admin: '⛔ Открытие админ-панели отклонено', action: '⛔ Отклонено', pwless: '⛔ Вход отклонён' },
  expired: { login: '⌛ Код истёк', admin: '⌛ Код истёк', action: '⌛ Код истёк', pwless: '⌛ Запрос на вход истёк' },
};

function messageText(r, code) {
  if (r.kind === 'pwless') {
    return [TITLES.pwless, `Аккаунт: ${r.username}`, `Устройство: ${uaSummary(r.ua)}, IP ${maskIp(r.ip)}`,
      'Нажмите «✅ Войти», если это вы. Если нет — нажмите «Это не я» (пароль никто не вводил, но лучше проверить настройки безопасности).'].join('\n');
  }
  const lines = [TITLES[r.kind], `Код: ${code}`];
  if (r.kind !== 'action') lines.push(`Устройство: ${uaSummary(r.ua)}, IP ${maskIp(r.ip)}`);
  lines.push(r.buttons ? 'Если это не вы — нажмите «Это не я» и смените пароль.' : 'Если это не вы — срочно смените пароль.');
  return lines.join('\n');
}

/** Состояние для клиента: sending | sent | failed | locked | limited | unavailable; resendIn — через сколько секунд можно повторить. */
function publicState(user, r) {
  const resendIn = sendWait(user.id);
  const locked = tgLockedFor(user);
  if (locked) return { state: 'locked', resendIn: locked, error: lockedText(locked) };
  if (!telegramAvailable()) return { state: 'unavailable', resendIn: 0, error: 'Вход через Telegram сейчас недоступен на сервере' };
  if (!r) return { state: 'none', resendIn };
  if (r.state === 'failed') return { state: 'failed', resendIn, error: 'Не удалось отправить код в Telegram — Telegram недоступен с сервера. Введите код из приложения-аутентификатора или код восстановления.' };
  if (r.state === 'sending') return { state: 'sending', resendIn };
  if (r.state === 'pending') return { state: 'sent', resendIn, expiresAt: r.exp };
  if (r.state === 'limited') return { state: 'limited', resendIn, error: `Код уже отправляли недавно. Повторить можно через ${resendIn} с.` };
  return { state: r.state, resendIn };
}
const lockedText = (sec) => `Вход по коду из Telegram приостановлен (нажата кнопка «Это не я»). Подождите ${waitText(sec)} или используйте приложение-аутентификатор / код восстановления.`;

function finish(r, outcome) {
  if (!r || !['pending', 'sending'].includes(r.state)) return;
  r.state = outcome === 'approved' ? 'used' : outcome;
  if (outcome === 'expired' || outcome === 'denied') r.codeHash = null;
  if (r.messageId) {
    editMessageText(r.chatId, r.messageId, DONE[outcome][r.kind]).catch(() => { /* сообщение могли удалить */ });
  }
}

/** Создать запрос и отправить код (асинхронно). Предыдущий запрос того же назначения истекает. */
function createRequest(user, { kind, challenge = null, session = null, ip = null, ua = '', force = false }) {
  const prevId = kind === 'login' || kind === 'pwless' ? byChallenge.get(challenge) : kind === 'admin' ? bySession.get(session) : byAction.get(user.id);
  const prev = prevId ? requests.get(prevId) : null;
  if (tgLockedFor(user) || !telegramAvailable()) return { r: null, prev };
  const wait = sendWait(user.id);
  if (wait && !force) return { r: { state: 'limited', kind }, prev, wait };
  finish(prev, 'expired');
  const id = newId();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const r = {
    id, kind, userId: user.id, chatId: String(user.tgChatId), codeHash: hashCode(id, code),
    exp: Date.now() + CODE_TTL_MS(), state: 'sending', messageId: null, challenge, session, ip, ua: String(ua || '').slice(0, 300),
    buttons: kind !== 'action', username: user.username,
  };
  requests.set(id, r);
  if (kind === 'login' || kind === 'pwless') byChallenge.set(challenge, id);
  else if (kind === 'admin') bySession.set(session, id);
  else byAction.set(user.id, id);
  noteSend(user.id);
  const okText = kind === 'pwless' ? '✅ Войти' : '✅ Это я';
  const extra = r.buttons
    ? { reply_markup: { inline_keyboard: [[{ text: okText, callback_data: `ok:${id}`, style: 'success' }, { text: '⛔ Это не я', callback_data: `no:${id}`, style: 'danger' }]] } }
    : {};
  if (kind === 'pwless') r.codeHash = null; // вход без пароля — только кнопкой, кода нет
  r.sent = sendMessage(r.chatId, messageText(r, code), extra)
    .then((m) => {
      r.messageId = m?.message_id ?? null;
      if (r.state === 'sending') r.state = 'pending';
      else if (r.messageId && r.state !== 'pending') {
        // успели завершить, пока сообщение отправлялось
        const outcome = r.state === 'used' ? 'approved' : r.state;
        if (DONE[outcome]) editMessageText(r.chatId, r.messageId, DONE[outcome][r.kind]).catch(() => {});
      }
      kick();
    })
    .catch((err) => {
      console.warn(`[2fa] Код в Telegram не отправлен (${user.username}): ${err.message}`);
      if (r.state === 'sending') { r.state = 'failed'; r.codeHash = null; }
    });
  kick();
  return { r, prev };
}

/** Проверка кода из Telegram (подключена в server/totp.js). */
function verifyCode(user, code, ctx) {
  if (!ctx || tgLockedFor(user)) return false;
  const id = ctx.kind === 'login' ? byChallenge.get(ctx.challenge)
    : ctx.kind === 'admin' ? bySession.get(ctx.session)
      : ctx.kind === 'action' ? byAction.get(user.id) : null;
  const r = id ? requests.get(id) : null;
  if (!r || r.userId !== user.id || r.kind !== ctx.kind || !r.codeHash || r.exp <= Date.now()) return false;
  if (!['pending', 'sending'].includes(r.state)) return false;
  if (String(user.tgChatId) !== r.chatId) return false;
  if (!crypto.timingSafeEqual(r.codeHash, hashCode(r.id, code))) return false;
  finish(r, 'approved');
  return true;
}
setTelegramVerifier(verifyCode);

/* ---------------- вход ---------------- */
/** После верного пароля (server/auth.js login): отправить код. Возвращает состояние для клиента. */
export function startLoginTelegram(user, challenge, { ip, ua } = {}) {
  if (!user?.tg2fa) return null;
  const { r } = createRequest(user, { kind: 'login', challenge, ip, ua });
  return publicState(user, r);
}

/** «Отправить код ещё раз» на экране входа. */
export function resendLoginTelegram(challenge) {
  const c = getChallenge(challenge);
  const user = c && findUser(c.userId);
  if (!c || !user || !has2FA(user)) throw new HttpError(401, 'Время на ввод кода истекло. Войдите заново.', 'challenge_invalid');
  if (!user.tg2fa) throw new HttpError(400, 'Вход через Telegram не подключён');
  return resendCommon(user, () => createRequest(user, { kind: 'login', challenge, ip: c.ip, ua: c.ua }));
}

function resendCommon(user, make) {
  const locked = tgLockedFor(user);
  if (locked) throw Object.assign(new HttpError(429, lockedText(locked), 'tg_locked'), { retryAfter: locked });
  if (!telegramAvailable()) throw new HttpError(503, 'Вход через Telegram сейчас недоступен на сервере', 'tg_unavailable');
  const wait = sendWait(user.id);
  if (wait) throw Object.assign(new HttpError(429, `Код уже отправлен. Повторить можно через ${wait} с.`, 'tg_resend_limited'), { retryAfter: wait });
  const { r } = make();
  return publicState(user, r);
}

/** Состояние Telegram для экрана входа (опрос). */
export function loginTelegramState(challenge) {
  const c = getChallenge(challenge);
  const user = c && findUser(c.userId);
  if (!user?.tg2fa) return null;
  const id = byChallenge.get(challenge);
  return publicState(user, id ? requests.get(id) : null);
}

/** Вход завершён (любым способом): сообщение в Telegram — «✅ Вход подтверждён». */
export function loginCompleted(challenge) {
  const id = byChallenge.get(challenge);
  if (id) finish(requests.get(id), 'approved');
  byChallenge.delete(challenge);
}

/** Ошибка для отклонённого «Это не я» второго шага (для pollLoginChallenge). */
export function deniedError(challenge) {
  if (!denied.has(challenge)) return null;
  return new HttpError(401, 'Вход отклонён в Telegram («Это не я»). Если это были вы — войдите заново; если нет — смените пароль.', 'challenge_denied');
}

/* ---------------- вход без пароля (кнопкой «✅ Войти» в боте) ---------------- */
// Только для тех, кто включил «Вход без пароля через Telegram» (user.tgLogin === true: галочка при привязке,
// по умолчанию включена; переключатель в настройках Astra; в боте — только ВЫКЛЮЧИТЬ: включать из Telegram
// нельзя, иначе доступ к одному лишь чату превращался бы в доступ к аккаунту).
// Ответ всегда одинаковый (токен ожидания), есть ли такой пользователь и включён ли у него вход — не видно:
// для «пустых» запросов токен просто никогда не подтверждается. Если у пользователя есть приложение-
// аутентификатор, после «✅ Войти» всё равно нужен код из него (server/tg-routes.js).
const pwless = new Map(); // токен → { userId | null, exp }

export function startPasswordless(username, { ip = null, ua = '' } = {}, findByName) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + CODE_TTL_MS();
  const user = typeof username === 'string' && username.trim() ? findByName(username.trim().replace(/\s+/g, ' ')) : null;
  const usable = user && !user.isBot && !user.instanceBan && user.tg2fa === true && !!user.tgChatId && user.tgLogin === true
    && !tgLockedFor(user) && telegramAvailable() && !sendWait(user.id);
  if (usable) {
    pwless.set(token, { userId: user.id, exp });
    createRequest(user, { kind: 'pwless', challenge: token, ip, ua });
  } else {
    pwless.set(token, { userId: null, exp });
  }
  return { challenge: token, expiresAt: exp };
}

/** Опрос: { user } (нажато «✅ Войти», одноразово) | { pending: true }; иначе HttpError 401. */
export function pollPasswordless(token) {
  const p = typeof token === 'string' ? pwless.get(token) : null;
  if (denied.has(token)) throw new HttpError(401, 'Вход отклонён в Telegram («Это не я»).', 'challenge_denied');
  if (!p || p.exp <= Date.now()) {
    if (p) pwless.delete(token);
    throw new HttpError(401, 'Время на подтверждение истекло. Попробуйте ещё раз.', 'challenge_invalid');
  }
  if (!p.userId) return { pending: true };
  const id = byChallenge.get(token);
  const r = id ? requests.get(id) : null;
  if (!r || r.state !== 'approved') return { pending: true };
  r.state = 'used';
  pwless.delete(token);
  byChallenge.delete(token);
  const user = findUser(p.userId);
  if (!user || user.isBot || user.instanceBan || user.tg2fa !== true || user.tgLogin !== true || String(user.tgChatId) !== r.chatId) {
    throw new HttpError(401, 'Время на подтверждение истекло. Попробуйте ещё раз.', 'challenge_invalid');
  }
  return { user, ip: r.ip, ua: r.ua };
}

/* ---------------- админ-панель ---------------- */
export function startAdminUnlock(user, session, { ip, ua } = {}) {
  if (!user?.tg2fa) throw new HttpError(400, 'Вход через Telegram не подключён');
  let rid = null;
  const state = resendCommon(user, () => { const out = createRequest(user, { kind: 'admin', session, ip, ua }); rid = out.r?.id ?? null; return out; });
  return { requestId: rid, telegram: state };
}

/** Опрос разблокировки: 'approved' (одноразово) | 'pending' | 'denied' | 'expired'. */
export function adminUnlockState(user, session, requestId) {
  const r = typeof requestId === 'string' ? requests.get(requestId) : null;
  if (!r || r.kind !== 'admin' || r.userId !== user.id || r.session !== session) return 'expired';
  if (r.state === 'approved') { r.state = 'used'; return 'approved'; }
  if (r.state === 'denied') return 'denied';
  if ((r.state === 'pending' || r.state === 'sending') && r.exp > Date.now()) return 'pending';
  if (r.state === 'failed') return 'failed';
  return 'expired';
}

/* ---------------- действие в настройках ---------------- */
export function sendActionCode(user) {
  if (!user?.tg2fa) throw new HttpError(400, 'Вход через Telegram не подключён');
  return resendCommon(user, () => createRequest(user, { kind: 'action' }));
}

/* ---------------- обработка обновлений бота ---------------- */
/** Обновления, которые касаются 2FA (привязка /start <токен>, кнопки ok:/no:). true — обработано здесь. */
export async function handleTg2faUpdate(u) {
  if (u.message) return handleMessage(u.message);
  if (u.callback_query) return handleCallback(u.callback_query);
  return false;
}

async function handleMessage(m) {
  if (m?.chat?.type !== 'private' || typeof m.text !== 'string') return false;
  const match = m.text.trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{20,64})$/);
  if (!match) return false; // прочие сообщения — меню бота (server/tgbot.js)
  const key = hashToken(match[1]);
  const l = links.get(key);
  if (!l) return false;
  links.delete(key);
  const user = findUser(l.userId);
  if (l.exp <= Date.now() || !user || user.isBot || user.tg2fa) return false;
  const codes = issueRecoveryIfMissing(user);
  const from = m.from || {};
  Object.assign(user, {
    tg2fa: true,
    tgChatId: String(m.chat.id),
    tgLinkedAt: Date.now(),
    tgName: (from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ')).slice(0, 64) || null,
    tgLogin: l.passwordless !== false, // «Вход без пароля через Telegram» — галочка при привязке (по умолчанию да)
  });
  delete user.tgLockUntil;
  save();
  freshCodes.set(user.id, { codes, exp: Date.now() + FRESH_CODES_TTL_MS });
  console.log(`[2fa] Telegram привязан: пользователь ${user.username}`);
  try { hooks.onUserUpdated(user, {}); } catch { /* ignore */ }
  await sendMessage(m.chat.id, `Аккаунт Astra «${user.username}» привязан. Здесь будут приходить коды входа.`).catch(() => {});
  try { await hooks.onLinked(user); } catch { /* меню — не критично */ }
  return true;
}

async function handleCallback(q) {
  const match = String(q.data || '').match(/^(ok|no):([A-Za-z0-9_-]{22})$/);
  if (!match) return false; // кнопки меню — server/tgbot.js
  await handleCodeCallback(q, match);
  return true;
}

async function handleCodeCallback(q, match) {
  const answer = (text) => answerCallbackQuery(q.id, text).catch(() => {});
  const r = match ? requests.get(match[2]) : null;
  const chatId = String(q.message?.chat?.id ?? q.from?.id ?? '');
  const user = r ? findUser(r.userId) : null;
  // кнопку принимаем только из того же чата, куда ушёл код, и только пока он привязан к аккаунту
  if (!r || !user || !user.tg2fa || String(user.tgChatId) !== chatId || r.chatId !== chatId || String(q.from?.id ?? chatId) !== chatId) {
    return answer('Запрос не найден или устарел');
  }
  if (!['pending', 'sending'].includes(r.state) || r.exp <= Date.now()) {
    finish(r, 'expired');
    return answer('Запрос уже обработан или устарел');
  }
  if (match[1] === 'ok') {
    if (r.kind === 'login') {
      const c = getChallenge(r.challenge);
      if (!c) { finish(r, 'expired'); return answer('Время на вход истекло — войдите заново'); }
      c.approved = true;
    }
    if (r.kind === 'pwless' && (user.tgLogin !== true || !pwless.has(r.challenge))) { finish(r, 'expired'); return answer('Запрос уже обработан или устарел'); }
    finish(r, 'approved');
    // разблокирует опрос adminUnlockState / pollPasswordless (одноразово)
    if (r.kind === 'admin' || r.kind === 'pwless') r.state = 'approved';
    return answer(r.kind === 'admin' ? 'Админ-панель будет открыта' : 'Вход подтверждён');
  }
  // «Это не я»: отмена, блокировка входа по Telegram на 15 минут, совет и запись события
  finish(r, 'denied');
  if (r.kind === 'login') {
    dropChallenge(r.challenge);
    denied.set(r.challenge, Date.now() + 5 * 60_000);
  }
  if (r.kind === 'pwless') {
    pwless.delete(r.challenge);
    denied.set(r.challenge, Date.now() + 5 * 60_000);
  }
  user.tgLockUntil = Date.now() + DENY_LOCK_MS;
  for (const other of requests.values()) if (other.userId === user.id && other !== r) finish(other, 'expired');
  save();
  const action = r.kind === 'admin' ? 'security.tg_admin_denied' : r.kind === 'pwless' ? 'security.tg_pwless_denied' : 'security.tg_login_denied';
  security(user, action, { device: uaSummary(r.ua), ip: maskIp(r.ip) }, r.ip);
  await answer('Вход отклонён');
  const who = r.kind === 'pwless'
    ? `Кто-то запросил вход без пароля в аккаунт Astra «${user.username}» (${uaSummary(r.ua)}, IP ${maskIp(r.ip)}). Пароль при этом не вводился.`
    : `Кто-то ввёл верный пароль от аккаунта Astra «${user.username}» (${uaSummary(r.ua)}, IP ${maskIp(r.ip)}).`;
  await sendMessage(r.chatId, [
    r.kind === 'admin' ? '⛔ Открытие админ-панели отклонено.' : '⛔ Вход отклонён.',
    who,
    r.kind === 'pwless'
      ? 'Если такое повторяется — выключите «Вход без пароля через Telegram» (меню бота → «🔐 Безопасность»).'
      : 'Срочно смените пароль: «Настройки» → «Моя учётная запись» → «Сменить пароль», затем нажмите «Выйти на других устройствах».',
    'Вход по коду из Telegram для этого аккаунта приостановлен на 15 минут.',
  ].join('\n')).catch(() => {});
  return undefined;
}

/* ---------------- истечение ---------------- */
setInterval(() => {
  const now = Date.now();
  for (const [k, l] of links) if (l.exp <= now) links.delete(k);
  for (const [k, v] of freshCodes) if (v.exp <= now) freshCodes.delete(k);
  for (const [k, exp] of denied) if (exp <= now) denied.delete(k);
  for (const [k, p] of pwless) if (p.exp + 60_000 <= now) pwless.delete(k);
  for (const [id, r] of requests) {
    if (r.exp <= now) finish(r, 'expired');
    if (r.exp + 60_000 <= now) {
      requests.delete(id);
      if (byChallenge.get(r.challenge) === id) byChallenge.delete(r.challenge);
      if (bySession.get(r.session) === id) bySession.delete(r.session);
      if (byAction.get(r.userId) === id) byAction.delete(r.userId);
    }
  }
}, 5_000).unref();

/* ---------------- привязка / отвязка ---------------- */
function notBot(user) {
  if (!user || user.isBot) throw new HttpError(403, 'Боту двухфакторная защита недоступна');
}

export async function startLink(user, password, { passwordless = true } = {}) {
  notBot(user);
  if (user.tg2fa) throw new HttpError(400, 'Telegram уже привязан');
  if (!telegramAvailable()) throw new HttpError(400, 'Вход через Telegram не настроен на этом сервере', 'tg_unavailable');
  await checkPassword(user, password);
  let me;
  try { me = await getMe(); } catch (err) {
    console.warn('[2fa] getMe:', err.message);
    throw new HttpError(503, 'Telegram сейчас недоступен с сервера — попробуйте позже', 'tg_unreachable');
  }
  if (!me?.username) throw new HttpError(503, 'Не удалось узнать имя бота', 'tg_unreachable');
  for (const [k, l] of links) if (l.userId === user.id) links.delete(k); // одна ссылка на пользователя
  const token = crypto.randomBytes(24).toString('base64url'); // 32 символа: [A-Za-z0-9_-]
  const exp = Date.now() + LINK_TTL_MS();
  links.set(hashToken(token), { userId: user.id, exp, passwordless: passwordless !== false });
  freshCodes.delete(user.id);
  kick();
  return { link: `https://t.me/${me.username}?start=${token}`, bot: me.username, expiresAt: exp };
}

export function cancelLink(user) {
  for (const [k, l] of links) if (l.userId === user.id) links.delete(k);
}

/** Опрос страницы настроек во время привязки. Коды восстановления (если созданы) — один раз. */
export function linkStatus(user) {
  let pending = false;
  for (const l of links.values()) if (l.userId === user.id && l.exp > Date.now()) pending = true;
  const out = { linked: user.tg2fa === true, pending };
  if (out.linked) {
    const f = freshCodes.get(user.id);
    if (f) {
      freshCodes.delete(user.id);
      if (f.codes) out.recoveryCodes = f.codes; else out.recoveryKept = true;
    }
  }
  return out;
}

export function telegramStatus(user) {
  return {
    available: telegramAvailable(),
    enabled: user.tg2fa === true,
    linkedAt: user.tg2fa ? user.tgLinkedAt ?? null : null,
    account: user.tg2fa ? user.tgName ?? null : null,
    lockedFor: user.tg2fa ? tgLockedFor(user) : 0,
    passwordless: user.tg2fa === true && user.tgLogin === true,
  };
}

/** Отвязка: пароль + код (из Telegram, приложения или код восстановления). */
export async function unlinkTelegram(user, { password, code } = {}, ip) {
  notBot(user);
  if (!user.tg2fa) throw new HttpError(400, 'Telegram не привязан');
  await checkPassword(user, password);
  checkUserCode(user, code, { ip, allowRecovery: true, tg: { kind: 'action' } });
  dropTelegram(user);
}

const TG_FIELDS = ['tg2fa', 'tgChatId', 'tgLinkedAt', 'tgName', 'tgLockUntil', 'tgLogin'];
function dropTelegram(user) {
  const chat = user.tgChatId;
  for (const k of TG_FIELDS) delete user[k];
  dropRecoveryIfUnused(user);
  for (const r of requests.values()) if (r.userId === user.id) finish(r, 'expired');
  save();
  if (chat && telegramAvailable()) {
    sendMessage(chat, `Аккаунт Astra «${user.username}» отвязан от этого чата. Коды входа и уведомления сюда больше не придут.`).catch(() => {});
  }
  try { hooks.onUserUpdated(user, {}); } catch { /* ignore */ }
}

/**
 * Отвязка из бота (меню «🔐 Безопасность» → «⛔ Отвязать Telegram»): одного доступа к чату мало — нужен
 * код восстановления или код приложения-аутентификатора (коды из самого Telegram не принимаются).
 */
export function unlinkTelegramFromBot(user, code) {
  notBot(user);
  if (!user.tg2fa) throw new HttpError(400, 'Telegram не привязан');
  checkUserCode(user, code, { allowRecovery: true, tg: null });
  dropTelegram(user);
}

/** Сброс администратором (потерян доступ): только поля, без сообщений. */
export function resetTelegramFields(user) {
  let any = false;
  for (const k of TG_FIELDS) if (k in user) { delete user[k]; any = true; }
  return any;
}

/** Для тестов/диагностики: идёт ли опрос. */
export const pollerRunning = () => !!poller?.running;
