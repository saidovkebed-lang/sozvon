// Администратор экземпляра (владелец Astra): кто им является и выполнено ли требование 2FA.
//
// Администратор — человек (не бот), который:
//   • указан в переменной окружения ADMIN_USERS (через запятую: имена или id), или
//   • имеет флаг user.instanceAdmin = true (выдаётся только root: sudo bash deploy/admin.sh grant <имя>,
//     либо в самой админ-панели другим администратором).
//
// Двухфакторная защита (2FA): админ-панель и права администратора на всех серверах действуют, только если
// у администратора включена 2FA — приложение-аутентификатор (user.totpEnabled === true, server/totp.js) или,
// если разрешено ADMIN_ALLOW_TG_2FA (по умолчанию 1 — так попросил владелец), вход через Telegram-бота
// (user.tg2fa === true, server/tg2fa.js). ADMIN_ALLOW_TG_2FA=0 — только приложение-аутентификатор.
// Требование настраивается: ADMIN_REQUIRE_2FA=0 в /etc/sozvon.env, либо (только root) admin.sh require-2fa off|on|default
// — значение хранится в DATA_DIR/admin-settings.json и важнее переменной окружения.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';

let dataDir = null;
let settings = {};

const SETTINGS_FILE = () => (dataDir ? path.join(dataDir, 'admin-settings.json') : null);

export function initAdminAccess(dir) {
  dataDir = dir;
  settings = readJson(SETTINGS_FILE()) || {};
}

export function readJson(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Атомарная запись JSON (tmp + rename). */
export function writeJsonAtomic(file, data, mode = 0o640) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode });
  fs.renameSync(tmp, file);
}

export function getSettings() { return settings; }
export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  const f = SETTINGS_FILE();
  if (f) writeJsonAtomic(f, settings);
  return settings;
}

// ---------- кто администратор ----------
function envAdmins() {
  return String(process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const userOf = (u) => (typeof u === 'string' ? db.data.users.find((x) => x.id === u) : u) || null;

/** Указан ли пользователь в ADMIN_USERS (по имени без учёта регистра или по id). */
export function isEnvAdmin(u) {
  const user = userOf(u);
  if (!user || user.isBot) return false;
  const list = envAdmins();
  return list.includes(String(user.id).toLowerCase()) || list.includes(String(user.usernameLower || user.username || '').toLowerCase());
}

/** Администратор экземпляра (без учёта 2FA). Боты — никогда. */
export function isInstanceAdmin(u) {
  const user = userOf(u);
  if (!user || user.isBot || user.instanceBan) return false;
  return user.instanceAdmin === true || isEnvAdmin(user);
}

export function listAdmins() {
  return db.data.users.filter((u) => isInstanceAdmin(u));
}

// ---------- 2FA ----------
const OFF = ['0', 'false', 'no', 'off'];

/** Требуется ли 2FA для админ-панели: admin-settings.json (root) → ADMIN_REQUIRE_2FA → по умолчанию да. */
export function admin2faRequired() {
  if (typeof settings.require2fa === 'boolean') return settings.require2fa;
  return !OFF.includes(String(process.env.ADMIN_REQUIRE_2FA ?? '1').trim().toLowerCase());
}

/** Засчитывается ли Telegram как 2FA для админ-панели (ADMIN_ALLOW_TG_2FA, по умолчанию да). */
export function adminAllowTg2fa() {
  return !OFF.includes(String(process.env.ADMIN_ALLOW_TG_2FA ?? '1').trim().toLowerCase());
}

/**
 * Хук 2FA для админских действий. Поля от модулей 2FA: user.totpEnabled === true или (если разрешено)
 * user.tg2fa === true (секреты здесь не читаются). true — можно.
 */
export function requireAdmin2FA(reqOrUser) {
  const user = reqOrUser?.user && !reqOrUser.username ? reqOrUser.user : reqOrUser;
  if (!admin2faRequired()) return true;
  return user?.totpEnabled === true || (adminAllowTg2fa() && user?.tg2fa === true && !!user?.tgChatId);
}

/** Администратор с выполненным требованием 2FA: только у него действуют права на всех серверах. */
export function isActiveAdmin(u) {
  const user = userOf(u);
  return isInstanceAdmin(user) && requireAdmin2FA(user);
}

/** Активен ли временный пароль (сброшен администратором и ещё не сменён). */
export function mustChangePassword(u) {
  const user = userOf(u);
  const m = user?.mustChangePassword;
  return !!m && typeof m === 'object' && !!m.hash && m.hash === user.passwordHash;
}

// ---------- разблокировка админ-сессии свежим кодом 2FA ----------
// Включённой 2FA мало: чтобы открыть админ-панель, администратор вводит текущий код (POST /api/admin/unlock),
// и этот сеанс (токен) разблокирован на ADMIN_UNLOCK_MIN минут (по умолчанию 30). Хранится в памяти:
// перезапуск сервера, выход или отзыв сеанса — и код нужно ввести снова.
const unlocks = new Map(); // token → until
export const unlockMinutes = () => {
  const n = Number(process.env.ADMIN_UNLOCK_MIN);
  return Number.isFinite(n) && n > 0 ? n : 30;
};
export function unlockSession(token) {
  const until = Date.now() + unlockMinutes() * 60_000;
  unlocks.set(token, until);
  for (const [t, u] of unlocks) if (u <= Date.now() || !db.data.sessions[t]) unlocks.delete(t);
  return until;
}
/** Разблокирован ли сеанс (без требования 2FA — всегда да). */
export function sessionUnlockedUntil(token) {
  if (!admin2faRequired()) return Infinity;
  const u = unlocks.get(token);
  if (!u || u <= Date.now() || !db.data.sessions[token]) { unlocks.delete(token); return 0; }
  return u;
}
export function lockSession(token) { unlocks.delete(token); }
