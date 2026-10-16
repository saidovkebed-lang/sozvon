// Регистрация, вход, сессии, токен бота, middleware авторизации.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, save, newId } from './db.js';
import { findUser, findUserByName, getBotUser, randomColor, publicUser, BOT_USERNAME } from './model.js';

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

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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

function createSession(userId) {
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
  db.data.users.push(user);
  save();
  return { token: createSession(user.id), user: publicUser(user) };
}

export async function login(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().replace(/\s+/g, ' ') : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) throw new HttpError(401, 'Введите имя пользователя и пароль');
  const user = findUserByName(username);
  if (!user || user.isBot || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'Неверное имя пользователя или пароль');
  }
  return { token: createSession(user.id), user: publicUser(user) };
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
export function updateColor(user, body) {
  const color = typeof body?.color === 'string' ? body.color.trim().toLowerCase() : '';
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, 'Цвет нужно указать в формате #rrggbb');
  if (user.isBot) throw new HttpError(403, 'Боту цвет менять нельзя');
  user.color = color;
  save();
  return publicUser(user);
}

/** Смена пароля: все сессии, кроме текущей (keepToken), удаляются. Возвращает удалённые токены. */
export async function changePassword(user, keepToken, body) {
  const oldPassword = typeof body?.oldPassword === 'string' ? body.oldPassword : '';
  if (!oldPassword) throw new HttpError(400, 'Введите текущий пароль');
  if (typeof body?.newPassword !== 'string' || !body.newPassword) throw new HttpError(400, 'Введите новый пароль');
  const newPassword = validatePassword(body.newPassword);
  if (!user.passwordHash || !(await bcrypt.compare(oldPassword, user.passwordHash))) {
    throw new HttpError(400, 'Неверный текущий пароль');
  }
  if (oldPassword === newPassword) throw new HttpError(400, 'Новый пароль совпадает с текущим');
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  const revoked = [];
  for (const [token, s] of Object.entries(db.data.sessions)) {
    if (s.userId === user.id && token !== keepToken) { delete db.data.sessions[token]; revoked.push(token); }
  }
  save();
  return revoked;
}
