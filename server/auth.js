// Регистрация, вход, сессии, токен бота, middleware авторизации.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, save, newId } from './db.js';
import { findUser, findUserByName, getBotUser, randomColor, publicUser, BOT_USERNAME, migrateUser, USER_STATUSES } from './model.js';
import { cleanChoice, AVATAR_FRAMES, BANNER_PRESETS } from './cosmetics.js';

let botToken = null;

export function initBotToken(dataDir) {
  if (process.env.BOT_TOKEN) {
    botToken = process.env.BOT_TOKEN.trim();
    return botToken;
  }
  const file = path.join(dataDir, 'bot-token.txt');
  if (fs.existsSync(file)) botToken = fs.readFileSync(file, 'utf8').trim();
  if (!botToken) {
    botToken = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, botToken + '\n', { mode: 0o600 });
  }
  return botToken;
}

export function checkBotToken(token) {
  if (!botToken || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(botToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export { HttpError } from './http-error.js';
import { HttpError } from './http-error.js';
import { createLoginChallenge, requireUserCode } from './totp.js';
// Двухфакторная защита (server/totp.js): помощники для других модулей (админ-панель и т. п.)
export { verifyUserTotp, requireRecent2FA } from './totp.js';

export function validateUsername(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Введите имя пользователя');
  const username = raw.trim().replace(/\s+/g, ' ');
  if (username.length < 2 || username.length > 24) throw new HttpError(400, 'Имя должно быть от 2 до 24 символов');
  if (/[\u0000-\u001f\u007f<>]/.test(username)) throw new HttpError(400, 'Имя содержит недопустимые символы');
  return username;
}

function validatePassword(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, 'Введите пароль');
  if (raw.length < 4) throw new HttpError(400, 'Пароль должен быть не короче 4 символов');
  if (raw.length > 128) throw new HttpError(400, 'Пароль слишком длинный (максимум 128 символов)');
  return raw;
}

export function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.data.sessions[token] = { userId, createdAt: Date.now() };
  save();
  return token;
}

export async function register(body) {
  const username = validateUsername(body?.username);
  const password = validatePassword(body?.password);
  if (username.toLowerCase() === BOT_USERNAME.toLowerCase() || findUserByName(username)) {
    throw new HttpError(400, 'Это имя уже занято');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  // повторная проверка после await (гонка двух регистраций)
  if (findUserByName(username)) throw new HttpError(400, 'Это имя уже занято');
  const user = {
    id: newId(), username, usernameLower: username.toLowerCase(), passwordHash,
    color: randomColor(), isBot: false, createdAt: Date.now(),
  };
  migrateUser(user);
  db.data.users.push(user);
  save();
  return { token: createSession(user.id), user: publicUser(user, { self: true }) };
}

export async function login(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().replace(/\s+/g, ' ') : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) throw new HttpError(401, 'Введите имя пользователя и пароль');
  const user = findUserByName(username);
  if (!user || user.isBot || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'Неверное имя пользователя или пароль');
  }
  // 2FA: пароль верен, но сессию выдаём только после второго шага (POST /api/login/2fa)
  if (user.totpEnabled) return { twoFactor: true, challenge: createLoginChallenge(user), methods: ['totp', 'recovery'] };
  return { token: createSession(user.id), user: publicUser(user, { self: true }) };
}

export function userByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const s = db.data.sessions[token];
  if (!s) return null;
  const u = findUser(s.userId);
  return u && !u.isBot ? u : null;
}

// Express middleware: Bearer <token> (пользователь) или Bot <token> (бот)
export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (/^bearer$/i.test(scheme)) {
    const user = userByToken(value);
    if (user) { req.user = user; req.token = value; return next(); }
  } else if (/^bot$/i.test(scheme) && checkBotToken(value)) {
    req.user = getBotUser();
    req.isBot = true;
    if (req.user) return next();
  }
  res.status(401).json({ error: 'Требуется авторизация. Войдите заново.' });
}

// ---------- профиль ----------
const HEX = /^#[0-9a-f]{6}$/;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function hexOrNull(v, what) {
  if (v === null || v === '') return null;
  const c = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!HEX.test(c)) throw new HttpError(400, `${what}: нужен цвет в формате #rrggbb`);
  return c;
}

function text(v, max, what, { multiline = false } = {}) {
  if (v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${what}: нужен текст`);
  let t = v.replace(/\r\n/g, '\n').replace(CTRL, '');
  if (!multiline) t = t.replace(/\s+/g, ' ');
  t = t.trim();
  if (multiline) t = t.replace(/\n{3,}/g, '\n\n');
  if ([...t].length > max) throw new HttpError(400, `${what}: не больше ${max} символов`);
  return t;
}

/**
 * PATCH /api/me: color, displayName, bannerColor, about, pronouns, status, customStatus, profileTheme.
 * Все поля необязательны; проверяются все, применяются только если все верны. Возвращает {user, changed}.
 */
export function updateProfile(user, body) {
  if (user.isBot) throw new HttpError(403, 'Боту профиль менять нельзя');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Нужен JSON-объект');
  const patch = {};
  if ('color' in body) {
    const c = hexOrNull(body.color, 'Цвет');
    if (!c) throw new HttpError(400, 'Цвет нужно указать в формате #rrggbb');
    patch.color = c;
  }
  if ('displayName' in body) {
    const n = text(body.displayName ?? '', 32, 'Отображаемое имя');
    if (n && /[<>]/.test(n)) throw new HttpError(400, 'Отображаемое имя содержит недопустимые символы');
    patch.displayName = n || null;
  }
  if ('bannerColor' in body) patch.bannerColor = hexOrNull(body.bannerColor, 'Цвет баннера');
  if ('about' in body) patch.about = text(body.about ?? '', 190, '«Обо мне»', { multiline: true });
  if ('pronouns' in body) patch.pronouns = text(body.pronouns ?? '', 40, 'Местоимения');
  if ('status' in body) {
    if (!USER_STATUSES.includes(body.status)) throw new HttpError(400, 'Статус: online, idle, dnd или invisible');
    patch.status = body.status;
  }
  if ('customStatus' in body) {
    const cs = body.customStatus;
    if (cs === null) patch.customStatus = null;
    else {
      if (typeof cs !== 'object' || Array.isArray(cs)) throw new HttpError(400, 'Некорректный пользовательский статус');
      const emoji = cs.emoji == null || cs.emoji === '' ? null : text(cs.emoji, 8, 'Эмодзи статуса');
      const t = text(cs.text ?? '', 128, 'Текст статуса');
      let expiresAt = null;
      if (cs.expiresAt != null) {
        if (!Number.isFinite(cs.expiresAt)) throw new HttpError(400, 'expiresAt: время в мс');
        if (cs.expiresAt <= Date.now()) throw new HttpError(400, 'Время окончания статуса уже прошло');
        expiresAt = Math.floor(cs.expiresAt);
      }
      patch.customStatus = !emoji && !t ? null : { emoji, text: t, expiresAt };
    }
  }
  if ('profileTheme' in body) {
    const th = body.profileTheme;
    if (th === null) patch.profileTheme = null;
    else {
      if (typeof th !== 'object' || Array.isArray(th)) throw new HttpError(400, 'Некорректная тема профиля');
      const primary = hexOrNull(th.primary, 'Тема профиля (основной)');
      const accent = hexOrNull(th.accent, 'Тема профиля (акцент)');
      if (!primary || !accent) throw new HttpError(400, 'Тема профиля: нужны оба цвета #rrggbb');
      patch.profileTheme = { primary, accent };
    }
  }
  // Astra 2.0: рамка аватара и анимированный баннер — из фиксированных списков (null — без них)
  if ('avatarFrame' in body) {
    const v = cleanChoice(body.avatarFrame, AVATAR_FRAMES);
    if (v === undefined) throw new HttpError(400, 'Неизвестная рамка аватара');
    patch.avatarFrame = v;
  }
  if ('bannerPreset' in body) {
    const v = cleanChoice(body.bannerPreset, BANNER_PRESETS);
    if (v === undefined) throw new HttpError(400, 'Неизвестный фон баннера');
    patch.bannerPreset = v;
  }
  if ('badges' in body) throw new HttpError(400, 'Значки выдаются автоматически');
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'Нет полей для изменения');
  const prevStatus = user.status;
  Object.assign(user, patch);
  save();
  return { user: publicUser(user, { self: true }), statusChanged: 'status' in patch && patch.status !== prevStatus, prevStatus };
}

// совместимость с v2
export function updateColor(user, body) {
  return updateProfile(user, { color: body?.color }).user;
}

/** Смена пароля: все сессии, кроме текущей (keepToken), удаляются. Возвращает удалённые токены. */
export async function changePassword(user, keepToken, body, { ip } = {}) {
  const oldPassword = typeof body?.oldPassword === 'string' ? body.oldPassword : '';
  if (!oldPassword) throw new HttpError(400, 'Введите текущий пароль');
  if (typeof body?.newPassword !== 'string' || !body.newPassword) throw new HttpError(400, 'Введите новый пароль');
  const newPassword = validatePassword(body.newPassword);
  if (!user.passwordHash || !(await bcrypt.compare(oldPassword, user.passwordHash))) {
    throw new HttpError(400, 'Неверный текущий пароль');
  }
  if (oldPassword === newPassword) throw new HttpError(400, 'Новый пароль совпадает с текущим');
  requireUserCode(user, body?.code, ip); // при включённой 2FA — свежий код
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  const revoked = [];
  for (const [token, s] of Object.entries(db.data.sessions)) {
    if (s.userId === user.id && token !== keepToken) { delete db.data.sessions[token]; revoked.push(token); }
  }
  save();
  return revoked;
}
