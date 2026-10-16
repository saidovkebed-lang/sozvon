// JSON-хранилище: data/db.json. Запись атомарная (tmp + rename) с debounce 300 мс.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SAVE_DEBOUNCE_MS = 300;

const EMPTY = () => ({
  version: 1,
  users: [],      // { id, username, usernameLower, passwordHash, color, isBot, createdAt }
  sessions: {},   // token -> { userId, createdAt }
  servers: [],    // { id, name, ownerId, inviteCode, icon, memberIds: [], createdAt }
  channels: [],   // { id, serverId, name, type, position }
  messages: {},   // channelId -> [{ id, channelId, authorId, content, attachments, createdAt, system? }]
  tracks: [],     // { id, file, title, artist, duration, addedBy, size, mtimeMs, createdAt }
});

export const db = { data: EMPTY(), file: null };
let timer = null;
let dirty = false;

export function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db.file = path.join(dataDir, 'db.json');
  if (fs.existsSync(db.file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(db.file, 'utf8'));
      db.data = { ...EMPTY(), ...parsed };
    } catch (err) {
      const backup = db.file + '.broken-' + Date.now();
      fs.copyFileSync(db.file, backup);
      console.error(`[db] Не удалось прочитать db.json (${err.message}). Копия сохранена: ${backup}. Начинаю с пустой базы.`);
      db.data = EMPTY();
    }
  }
  return db.data;
}

export function save() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushSync();
  }, SAVE_DEBOUNCE_MS);
}

export function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty || !db.file) return;
  const tmp = `${db.file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db.data));
    fs.renameSync(tmp, db.file);
    dirty = false;
  } catch (err) {
    console.error('[db] Ошибка записи базы:', err.message);
  }
}

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}
