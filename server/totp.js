// Двухфакторная защита (TOTP, RFC 6238 / HOTP, RFC 4226) — без внешних зависимостей, только node:crypto.
//
// Поля пользователя в db.json:
//   totpEnabled   — boolean, включена ли 2FA (единственное, что видно клиенту — и только самому владельцу);
//   totpSecret    — секрет (base32, 160 бит), зашифрован AES-256-GCM ключом из DATA_DIR/totp-key;
//   totpLastStep  — номер последнего принятого 30-секундного шага (защита от повтора кода);
//   totpRecovery  — HMAC-SHA256 хэши неиспользованных кодов восстановления;
//   totpEnabledAt — когда включена.
//
// API для других модулей (например, админ-панели):
//   verifyUserTotp(user, code[, { allowRecovery }]) → boolean
//   requireRecent2FA(req, code[, { allowRecovery }]) → null (2FA выключена) | 'totp' | 'recovery'; иначе бросает HttpError
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, save } from './db.js';
import { HttpError } from './http-error.js';
import { Limiter, exempt, waitText } from './rate-limit.js';

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;          // ±1 шаг (часы телефона могут отставать/спешить на 30 с)
export const TOTP_ISSUER = 'Astra';
export const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60_000;   // второй шаг входа: 5 минут
const CHALLENGE_MAX_TRIES = 3;      // после 3 неверных кодов — заново с паролем
const ENROLL_TTL_MS = 10 * 60_000;     // подключение: 10 минут на ввод первого кода
const ACCOUNT_FAIL_LIMIT = 5;          // 5 неверных кодов в аккаунт за 15 минут → блокировка на 15 минут
const ACCOUNT_FAIL_WINDOW_MS = 15 * 60_000;

/* ---------------- base32 (RFC 4648, без «=») ---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/* ---------------- HOTP / TOTP ---------------- */
/** HOTP (RFC 4226): key — Buffer, counter — целое ≥ 0. */
export function hotp(key, counter, { digits = TOTP_DIGITS, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (timeMs = Date.now()) => Math.floor(timeMs / 1000 / TOTP_STEP_SEC);

/** TOTP (RFC 6238) для момента timeMs. */
export function totp(key, timeMs = Date.now(), opts = {}) {
  return hotp(key, totpStep(timeMs), opts);
}

/** Найти шаг, на котором код верен (окно ±TOTP_WINDOW), строго новее lastStep. -1 — не подошёл. */
function matchStep(key, code, lastStep, now) {
  const cur = totpStep(now);
  const want = Buffer.from(code);
  let found = -1;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = cur + d;
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, step)), want);
    if (ok && step > lastStep && found < 0) found = step;
  }
  return found;
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20)); // 160 бит

export function otpauthUri(secret, account) {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
}

/* ---------------- ключ шифрования (DATA_DIR/totp-key) ---------------- */
let encKey = null;     // AES-256-GCM для секретов
let pepperKey = null;  // HMAC для кодов восстановления

export function initTotp(dataDir) {
  const file = path.join(dataDir, 'totp-key');
  let master = null;
  if (fs.existsSync(file)) {
    master = fs.readFileSync(file);
    if (master.length !== 32) throw new Error(`[2fa] ${file}: ожидалось 32 байта`);
  } else {
    master = crypto.randomBytes(32);
    fs.writeFileSync(file, master, { mode: 0o600, flag: 'wx' });
    const orphaned = (db.data.users || []).filter((u) => u.totpEnabled).length;
    if (orphaned) {
      console.error(`[2fa] Файл ${file} отсутствовал и создан заново, но у ${orphaned} польз. включена 2FA — `
        + 'их коды (и коды восстановления) не подойдут. Верните старый totp-key из резервной копии '
        + 'или отключите им 2FA вручную в db.json (totpEnabled: false). См. docs/SECURITY.md.');
    }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('astra-2fa'), Buffer.from(info), 32));
  encKey = derive('totp-secret-v1');
  pepperKey = derive('recovery-codes-v1');
}

function ensureKeys() {
  if (!encKey) initTotp(path.dirname(db.file || path.resolve('data', 'db.json')));
}

function encryptSecret(secret, userId) {
  ensureKeys();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  c.setAAD(Buffer.from(`astra-totp:${userId}`));
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function decryptSecret(blob, userId) {
  ensureKeys();
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(blob.slice(3), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
    d.setAAD(Buffer.from(`astra-totp:${userId}`));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null; // ключ потерян или запись испорчена
  }
}

/* ---------------- коды восстановления ---------------- */
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // без 0/o/1/l/i
const normRecovery = (code) => String(code || '').toLowerCase().replace(/[\s-]/g, '');
function hashRecovery(code) {
  ensureKeys();
  return crypto.createHmac('sha256', pepperKey).update(normRecovery(code)).digest('hex');
}

export function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let s = '';
    for (let j = 0; j < 10; j++) s += RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)];
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}

function consumeRecovery(user, code) {
  const n = normRecovery(code);
  if (!/^[a-z0-9]{10}$/.test(n) || !Array.isArray(user.totpRecovery)) return false;
  const h = Buffer.from(hashRecovery(n), 'hex');
  let idx = -1;
  user.totpRecovery.forEach((stored, i) => {
    const s = Buffer.from(String(stored), 'hex');
    if (s.length === h.length && crypto.timingSafeEqual(s, h) && idx < 0) idx = i;
  });
  if (idx < 0) return false;
  user.totpRecovery.splice(idx, 1); // одноразовый
  save();
  return true;
}

/* ---------------- блокировки ---------------- */
const accountFails = new Map(); // userId → { count, reset }
const ipFails = new Limiter({ limit: 20, windowMs: ACCOUNT_FAIL_WINDOW_MS });
const passwordFails = new Limiter({ limit: 10, windowMs: ACCOUNT_FAIL_WINDOW_MS });
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of accountFails) if (v.reset <= now) accountFails.delete(k);
  for (const [k, v] of challenges) if (v.exp <= now) challenges.delete(k);
  for (const [k, v] of pending) if (v.exp <= now) pending.delete(k);
}, 60_000).unref();

/** Сколько секунд аккаунт ещё заблокирован для ввода кодов (0 — не заблокирован). */
export function totpLockedFor(userId) {
  const v = accountFails.get(userId);
  if (!v || v.reset <= Date.now() || v.count < ACCOUNT_FAIL_LIMIT) return 0;
  return Math.ceil((v.reset - Date.now()) / 1000);
}
function noteFailure(userId) {
  const now = Date.now();
  const v = accountFails.get(userId);
  if (!v || v.reset <= now) accountFails.set(userId, { count: 1, reset: now + ACCOUNT_FAIL_WINDOW_MS });
  else v.count += 1;
}

function tooMany(sec, code = 'totp_locked') {
  const e = new HttpError(429, `Слишком много неверных кодов. Подождите ${waitText(sec)} и попробуйте снова.`, code);
  e.retryAfter = sec;
  return e;
}

/* ---------------- проверка второго фактора ---------------- */
/**
 * Внутренняя проверка: 'totp' | 'recovery' | false. Учитывает блокировку аккаунта и повтор кода,
 * неудача увеличивает счётчик блокировки.
 */
function verifySecondFactor(user, code, { allowRecovery = false, now = Date.now() } = {}) {
  if (!user || user.isBot || !user.totpEnabled) return false;
  if (totpLockedFor(user.id)) return false;
  const raw = String(code ?? '').replace(/\s/g, '');
  if (/^\d{6}$/.test(raw)) {
    const secret = decryptSecret(user.totpSecret, user.id);
    if (secret) {
      const step = matchStep(base32Decode(secret), raw, Number(user.totpLastStep) || -1, now);
      if (step >= 0) {
        user.totpLastStep = step;
        accountFails.delete(user.id);
        save();
        return 'totp';
      }
    }
  } else if (allowRecovery && consumeRecovery(user, raw)) {
    accountFails.delete(user.id);
    return 'recovery';
  }
  noteFailure(user.id);
  return false;
}

/**
 * Проверить 6-значный код приложения-аутентификатора (а с { allowRecovery: true } — и код восстановления).
 * true — код верен и «израсходован» (повтор того же кода будет отклонён). false — неверен, 2FA выключена,
 * пользователь — бот или аккаунт временно заблокирован после серии неверных кодов.
 */
export function verifyUserTotp(user, code, { allowRecovery = false } = {}) {
  return !!verifySecondFactor(user, code, { allowRecovery });
}

/**
 * Проверка «свежего» второго фактора для чувствительного действия (смена пароля, отключение 2FA,
 * действия администратора и т. п.). Бросает HttpError:
 *   403 { code: 'totp_required' } — код не передан; 403 { code: 'totp_invalid' } — неверный;
 *   429 { code: 'totp_locked' } — слишком много неверных кодов (аккаунт или адрес).
 * Возвращает null, если у пользователя 2FA выключена (ничего не требуется), иначе 'totp' | 'recovery'.
 */
export function requireRecent2FA(req, code, { allowRecovery = true, status = 403 } = {}) {
  const user = req?.user;
  if (!user || req.isBot || user.isBot) throw new HttpError(403, 'Недоступно для бота');
  if (!user.totpEnabled) return null;
  return checkCode(user, code, { ip: req.ip, allowRecovery, status });
}

function checkCode(user, code, { ip, allowRecovery = true, status = 403 } = {}) {
  const limitIp = ip && !exempt(ip);
  if (limitIp) { const w = ipFails.blockedFor(ip); if (w) throw tooMany(w); }
  const locked = totpLockedFor(user.id);
  if (locked) throw tooMany(locked);
  if (code === undefined || code === null || String(code).trim() === '') {
    throw new HttpError(status, 'Введите код двухфакторной защиты', 'totp_required');
  }
  const method = verifySecondFactor(user, code, { allowRecovery });
  if (method) return method;
  if (limitIp) ipFails.hit(ip);
  const nowLocked = totpLockedFor(user.id);
  if (nowLocked) throw tooMany(nowLocked);
  throw new HttpError(status, 'Неверный код', 'totp_invalid');
}

/* ---------------- вход: второй шаг ---------------- */
const challenges = new Map(); // token → { userId, pw, exp, tries }

export function createLoginChallenge(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  challenges.set(token, { userId: user.id, pw: user.passwordHash, exp: Date.now() + CHALLENGE_TTL_MS, tries: 0 });
  return token;
}

/** Второй шаг входа. Возвращает пользователя; одноразовый — после успеха токен удаляется. */
export function completeLoginChallenge(token, code, ip) {
  const limitIp = ip && !exempt(ip);
  if (limitIp) { const w = ipFails.blockedFor(ip); if (w) throw tooMany(w); }
  const expired = () => new HttpError(401, 'Время на ввод кода истекло. Войдите заново.', 'challenge_invalid');
  const c = typeof token === 'string' ? challenges.get(token) : null;
  if (!c || c.exp <= Date.now()) {
    if (c) challenges.delete(token);
    if (limitIp) ipFails.hit(ip);
    throw expired();
  }
  const user = db.data.users.find((u) => u.id === c.userId);
  if (!user || user.isBot || !user.totpEnabled || user.passwordHash !== c.pw) { challenges.delete(token); throw expired(); }
  const method = (() => {
    try { return checkCode(user, code, { ip, allowRecovery: true, status: 401 }); }
    catch (e) {
      if (e.code === 'totp_invalid' && ++c.tries >= CHALLENGE_MAX_TRIES) challenges.delete(token);
      if (e.code === 'totp_locked') challenges.delete(token);
      throw e;
    }
  })();
  challenges.delete(token);
  return { user, method };
}

/* ---------------- пароль для чувствительных действий ---------------- */
export async function checkPassword(user, password) {
  const key = user.id;
  const wait = passwordFails.blockedFor(key);
  if (wait) throw new HttpError(429, `Слишком много неверных попыток. Подождите ${waitText(wait)} и попробуйте снова.`);
  if (typeof password !== 'string' || !password) throw new HttpError(400, 'Введите текущий пароль');
  if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    passwordFails.hit(key);
    throw new HttpError(400, 'Неверный пароль');
  }
  passwordFails.clear(key);
}

/* ---------------- подключение / отключение ---------------- */
const pending = new Map(); // userId → { secret, exp }

export function twoFactorStatus(user) {
  return {
    enabled: !!user.totpEnabled,
    recoveryCodesLeft: user.totpEnabled && Array.isArray(user.totpRecovery) ? user.totpRecovery.length : 0,
    enabledAt: user.totpEnabled ? user.totpEnabledAt ?? null : null,
  };
}

function notBot(user) {
  if (!user || user.isBot) throw new HttpError(403, 'Боту двухфакторная защита недоступна');
}

/** Шаг 1: пароль → новый секрет (ещё не включён). */
export async function startEnrollment(user, password) {
  notBot(user);
  if (user.totpEnabled) throw new HttpError(400, 'Двухфакторная защита уже включена');
  await checkPassword(user, password);
  const secret = generateSecret();
  pending.set(user.id, { secret, exp: Date.now() + ENROLL_TTL_MS });
  return { secret, uri: otpauthUri(secret, user.username), issuer: TOTP_ISSUER, account: user.username, digits: TOTP_DIGITS, period: TOTP_STEP_SEC };
}

/** Шаг 2: код из приложения → 2FA включена, возвращаются коды восстановления (показываются один раз). */
export function confirmEnrollment(user, code, ip) {
  notBot(user);
  if (user.totpEnabled) throw new HttpError(400, 'Двухфакторная защита уже включена');
  const p = pending.get(user.id);
  if (!p || p.exp <= Date.now()) { pending.delete(user.id); throw new HttpError(400, 'Время подключения истекло — начните заново', 'enroll_expired'); }
  const limitIp = ip && !exempt(ip);
  if (limitIp) { const w = ipFails.blockedFor(ip); if (w) throw tooMany(w); }
  const locked = totpLockedFor(user.id);
  if (locked) throw tooMany(locked);
  const raw = String(code ?? '').replace(/\s/g, '');
  const step = /^\d{6}$/.test(raw) ? matchStep(base32Decode(p.secret), raw, -1, Date.now()) : -1;
  if (step < 0) {
    noteFailure(user.id);
    if (limitIp) ipFails.hit(ip);
    const nowLocked = totpLockedFor(user.id);
    if (nowLocked) throw tooMany(nowLocked);
    throw new HttpError(400, 'Неверный код. Проверьте время на телефоне и попробуйте ещё раз', 'totp_invalid');
  }
  const codes = generateRecoveryCodes();
  pending.delete(user.id);
  accountFails.delete(user.id);
  Object.assign(user, {
    totpEnabled: true,
    totpSecret: encryptSecret(p.secret, user.id),
    totpLastStep: step,
    totpRecovery: codes.map(hashRecovery),
    totpEnabledAt: Date.now(),
  });
  save();
  return { recoveryCodes: codes };
}

/** Отключение: пароль + код (или код восстановления). */
export async function disableTwoFactor(user, { password, code } = {}, ip) {
  notBot(user);
  if (!user.totpEnabled) throw new HttpError(400, 'Двухфакторная защита не включена');
  await checkPassword(user, password);
  checkCode(user, code, { ip, allowRecovery: true });
  for (const k of ['totpSecret', 'totpLastStep', 'totpRecovery', 'totpEnabledAt']) delete user[k];
  user.totpEnabled = false;
  save();
}

/** Новые коды восстановления (старые перестают действовать): пароль + код. */
export async function regenerateRecoveryCodes(user, { password, code } = {}, ip) {
  notBot(user);
  if (!user.totpEnabled) throw new HttpError(400, 'Двухфакторная защита не включена');
  await checkPassword(user, password);
  checkCode(user, code, { ip, allowRecovery: true });
  const codes = generateRecoveryCodes();
  user.totpRecovery = codes.map(hashRecovery);
  save();
  return { recoveryCodes: codes };
}

/** Код для чувствительного действия (для модулей без req): бросает HttpError как requireRecent2FA. */
export function requireUserCode(user, code, ip) {
  if (!user?.totpEnabled) return null;
  return checkCode(user, code, { ip, allowRecovery: true });
}
