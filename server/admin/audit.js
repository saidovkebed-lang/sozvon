// Журнал действий администраторов: DATA_DIR/admin-audit.jsonl (по строке JSON на действие).
// Ротация: при размере > AUDIT_MAX_BYTES файл становится .1 (хранятся .1–.3).
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = Number(process.env.ADMIN_AUDIT_MAX_BYTES) > 0 ? Number(process.env.ADMIN_AUDIT_MAX_BYTES) : 2 * 1024 * 1024;
const KEEP = 3;
let file = null;

export function initAudit(dataDir) {
  file = path.join(dataDir, 'admin-audit.jsonl');
}

function rotate() {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
  } catch { return; }
  for (let i = KEEP - 1; i >= 1; i--) {
    try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* нет такого */ }
  }
  try { fs.renameSync(file, `${file}.1`); } catch { /* ignore */ }
}

const cut = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : v);

/**
 * Записать действие. actor — пользователь (или {username:'root'} для admin.sh), action — код действия,
 * target — {type, id, name}, details — небольшой объект без секретов.
 */
export function audit(actor, action, target = null, details = null, ip = null) {
  const entry = {
    at: Date.now(),
    actor: actor ? { id: actor.id ?? null, username: cut(actor.username ?? '?', 64) } : null,
    action,
    target: target ? { type: target.type, id: target.id ?? null, name: cut(target.name ?? null, 100) } : null,
    details: details || undefined,
    ip: ip || undefined,
  };
  if (!file) return entry;
  try {
    rotate();
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o640 });
  } catch (err) {
    console.error('[admin] Не удалось записать журнал аудита:', err.message);
  }
  return entry;
}

/** Последние записи (новые первыми), из текущего файла и .1. */
export function readAudit(limit = 200) {
  const out = [];
  for (const f of [file, `${file}.1`]) {
    if (!f || out.length >= limit) break;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* битая строка */ }
    }
  }
  return out;
}
