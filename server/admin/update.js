// «Обновить Astra» из админ-панели.
//
// Приложение (пользователь sozvon) НЕ обновляет себя само и не запускает git/npm/systemctl. Единственный
// интерфейс к привилегированной стороне — файл-запрос DATA_DIR/update-request с одним словом:
//   check  — root-помощник делает git fetch и пишет update-check.json {current, latest, behind, notes}
//   update — root-помощник запускает deploy/update.sh, вывод — в update.log, итог — update-status.json
//   backup — root-помощник запускает deploy/backup.sh now (бот: «💾 Бэкап сейчас»), итог — backup-status.json
//            (пишет сам backup.sh) и backup-run.json {state, startedAt, finishedAt, exitCode}
// Результаты лежат в STATE_DIR (/var/lib/sozvon-state, root:root 755): приложение их только читает, а root
// не пишет в каталог, принадлежащий sozvon (защита от подмены файлов символическими ссылками).
// Файл отслеживает systemd: sozvon-self-update.path → sozvon-self-update.service (deploy/self-update.sh, root).
// Помощник не выполняет содержимое запроса: сравнивает его с тремя фиксированными словами, остальное игнорирует.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { readJson } from './access.js';

let dataDir = null;
let rootDir = null;
const PATH_UNIT = process.env.SOZVON_SELF_UPDATE_UNIT || '/etc/systemd/system/sozvon-self-update.path';
const TEST_MODE = process.env.NODE_ENV !== 'production';

export function initUpdate({ dataDir: d, rootDir: r }) {
  dataDir = d;
  rootDir = r;
}

/** Каталог результатов root-помощников (обновление, бэкап, проверка музыки): рядом с DATA_DIR, владелец root. */
export const stateDir = () => process.env.SOZVON_STATE_DIR || path.join(path.dirname(dataDir), 'sozvon-state');
const f = (name) => path.join(stateDir(), name);
const reqFile = () => path.join(dataDir, 'update-request');

// ---------- версия ----------
function gitDir() {
  const p = path.join(rootDir, '.git');
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return p;
    const m = fs.readFileSync(p, 'utf8').match(/^gitdir:\s*(.+)$/m); // worktree
    if (m) return path.resolve(rootDir, m[1].trim());
  } catch { /* не git */ }
  return null;
}

function commonDir(gd) {
  try { return path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch { return gd; }
}

function resolveRef(gd, ref) {
  for (const base of [gd, commonDir(gd)]) {
    try { return fs.readFileSync(path.join(base, ref), 'utf8').trim(); } catch { /* дальше */ }
    try {
      const packed = fs.readFileSync(path.join(base, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
      if (line) return line.split(' ')[0];
    } catch { /* нет */ }
  }
  return null;
}

/** Дата и заголовок коммита из «рыхлого» объекта (если он не упакован). */
function commitInfo(gd, sha) {
  try {
    const raw = zlib.inflateSync(fs.readFileSync(path.join(commonDir(gd), 'objects', sha.slice(0, 2), sha.slice(2)))).toString('utf8');
    const body = raw.slice(raw.indexOf('\0') + 1);
    const m = body.match(/^committer .* (\d+) [+-]\d{4}$/m);
    const subject = body.split('\n\n')[1]?.split('\n')[0] || null;
    return { date: m ? Number(m[1]) * 1000 : null, subject };
  } catch { return { date: null, subject: null }; }
}

let versionCache = null;
export function currentVersion() {
  if (versionCache && Date.now() - versionCache.at < 30_000) return versionCache.v;
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version; } catch { /* нет */ }
  let commit = null, branch = null, info = { date: null, subject: null };
  const gd = gitDir();
  if (gd) {
    try {
      const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) { branch = head.slice(5).replace(/^refs\/heads\//, ''); commit = resolveRef(gd, head.slice(5)); } else commit = head;
      if (commit && !/^[0-9a-f]{40}$/.test(commit)) commit = null;
      if (commit) info = commitInfo(gd, commit);
    } catch { /* ignore */ }
  }
  const v = { version, commit, short: commit ? commit.slice(0, 7) : null, branch, date: info.date, subject: info.subject ? info.subject.slice(0, 200) : null };
  versionCache = { at: Date.now(), v };
  return v;
}

// ---------- состояние ----------
export function helperInstalled() {
  if (TEST_MODE && process.env.SOZVON_UPDATE_HELPER_CMD) return true;
  try { return fs.statSync(PATH_UNIT).isFile(); } catch { return false; }
}

export function updateState() {
  const status = readJson(f('update-status.json'));
  const check = readJson(f('update-check.json'));
  let pending = null;
  try { pending = fs.readFileSync(reqFile(), 'utf8').trim().slice(0, 10) || 'update'; } catch { /* нет запроса */ }
  let logSize = 0;
  try { logSize = fs.statSync(f('update.log')).size; } catch { /* нет журнала */ }
  const running = status?.state === 'running' && Date.now() - (status.startedAt || 0) < 2 * 3600_000;
  return {
    current: currentVersion(),
    helperInstalled: helperInstalled(),
    pending,
    running,
    status: status && typeof status === 'object' ? {
      state: String(status.state || ''), kind: status.kind || null, startedAt: status.startedAt || null,
      finishedAt: status.finishedAt || null, from: status.from || null, to: status.to || null, exitCode: status.exitCode ?? null,
    } : null,
    check: check && typeof check === 'object' ? {
      current: check.current || null, latest: check.latest || null, behind: Number.isFinite(check.behind) ? check.behind : null,
      notes: Array.isArray(check.notes) ? check.notes.slice(0, 30).map((n) => String(n).slice(0, 200)) : [],
      checkedAt: check.checkedAt || null, error: check.error ? String(check.error).slice(0, 300) : null,
    } : null,
    logSize,
  };
}

/** Кусок журнала обновления начиная с offset (не больше 64 КБ). */
export function readUpdateLog(offset = 0) {
  const file = f('update.log');
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { offset: 0, size: 0, text: '' }; }
  let from = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  if (from > size) from = 0; // журнал начат заново
  if (size - from > 65536) from = size - 65536;
  const len = size - from;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
  return { offset: from, size, text: buf.toString('utf8') };
}

export class UpdateError extends Error {}

/** Итог последнего «бэкапа по кнопке» (root-помощник): { state, startedAt, finishedAt, exitCode } | null. */
export function backupRunState() {
  const st = readJson(f('backup-run.json'));
  return st && typeof st === 'object' ? {
    state: String(st.state || ''), startedAt: st.startedAt || null, finishedAt: st.finishedAt || null, exitCode: st.exitCode ?? null,
  } : null;
}
/** Итог последнего бэкапа (пишет deploy/backup.sh): как в «Состоянии сервера». */
export function backupStatusFile() {
  const st = readJson(f('backup-status.json'));
  return st && typeof st === 'object' ? st : null;
}

/** Записать запрос (check | update | backup). Конкурентные запуски: пока есть запрос или идёт обновление — отказ. */
export function requestUpdate(kind) {
  if (!['check', 'update', 'backup'].includes(kind)) throw new UpdateError('Неизвестный запрос');
  if (!helperInstalled()) throw new UpdateError('Помощник обновления не установлен. Один раз выполните на сервере: sudo bash /opt/sozvon/deploy/update.sh');
  const st = updateState();
  if (st.running) throw new UpdateError('Обновление уже идёт');
  if (st.pending) throw new UpdateError('Запрос уже отправлен — подождите');
  const tmp = path.join(dataDir, `.update-request.${process.pid}.tmp`);
  fs.writeFileSync(tmp, kind + '\n', { mode: 0o640 });
  fs.renameSync(tmp, reqFile());
  // Тестовый крючок (не в production): вместо systemd path-юнита запустить помощник самим
  if (TEST_MODE && process.env.SOZVON_UPDATE_HELPER_CMD) {
    const child = spawn('bash', [process.env.SOZVON_UPDATE_HELPER_CMD], {
      detached: true, stdio: 'ignore', env: { ...process.env, DATA_DIR: dataDir },
    });
    child.unref();
  }
  return updateState();
}
