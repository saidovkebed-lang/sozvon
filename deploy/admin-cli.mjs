// Помощник deploy/admin.sh (Node, без зависимостей):
//   node admin-cli.mjs json КОМАНДА [АРГУМЕНТ]           JSON-запрос к admin.sock
//   node admin-cli.mjs print < ответ.json                 человекочитаемый вывод ответа (код выхода 1 — ошибка)
//   node admin-cli.mjs offline DB.json КОМАНДА [АРГУМЕНТ] правка остановленной базы (сервер НЕ запущен)
import fs from 'node:fs';
import path from 'node:path';

const [mode, ...rest] = process.argv.slice(2);

function request(cmd, arg) {
  const body = { cmd };
  if (cmd === 'grant' || cmd === 'revoke') body.username = arg;
  if (cmd === 'require-2fa') body.value = arg;
  return body;
}

function print(r) {
  if (!r || r.ok !== true) {
    console.error(`✗ ${r?.error || 'Неизвестная ошибка'}`);
    process.exit(1);
  }
  if (r.user) {
    if (!('stillAdmin' in r)) console.log(`✓ ${r.user}: теперь администратор`);
    else console.log(r.stillAdmin ? `! ${r.user}: флаг снят, но он всё ещё администратор (указан в ADMIN_USERS)` : `✓ ${r.user}: больше не администратор`);
    if (r.require2fa && r.totpEnabled === false) {
      console.log('  Админ-панель откроется после включения двухфакторной защиты: «Настройки» → «Моя учётная запись» → «Двухфакторная защита».');
      console.log('  (Выключить требование: sudo bash /opt/sozvon/deploy/admin.sh require-2fa off — не рекомендуется.)');
    }
  }
  if (r.admins) {
    console.log(r.admins.length ? 'Администраторы:' : 'Администраторов нет. Назначить: sudo bash /opt/sozvon/deploy/admin.sh grant ИМЯ');
    for (const a of r.admins) {
      const src = [a.flag ? 'admin.sh/панель' : null, a.env ? 'ADMIN_USERS' : null].filter(Boolean).join(', ');
      console.log(`  • ${a.username} (${src}; 2FA ${a.totpEnabled ? 'включена' : 'выключена'})`);
    }
  }
  if (typeof r.require2fa === 'boolean') console.log(`Требование 2FA для админ-панели: ${r.require2fa ? 'включено' : 'выключено'}`);
  if (r.offline) console.log('(база изменена напрямую — сервер был остановлен)');
}

function offline(dbFile, cmd, arg) {
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const users = Array.isArray(db.users) ? db.users : [];
  const out = { ok: true, offline: true };
  const list = () => users.filter((u) => !u.isBot && u.instanceAdmin === true && !u.instanceBan)
    .map((u) => ({ id: u.id, username: u.username, flag: true, env: false, totpEnabled: u.totpEnabled === true }));
  if (cmd === 'list') return { ...out, admins: list() };
  if (cmd !== 'grant' && cmd !== 'revoke') return { ok: false, error: 'Без работающего сервера доступны: list | grant ИМЯ | revoke ИМЯ' };
  const l = String(arg || '').trim().toLowerCase();
  const u = users.find((x) => x.usernameLower === l || String(x.username || '').toLowerCase() === l || x.id === arg);
  if (!u) return { ok: false, error: `Пользователь «${arg}» не найден` };
  if (u.isBot) return { ok: false, error: 'Бот не может быть администратором' };
  if (cmd === 'grant') u.instanceAdmin = true; else delete u.instanceAdmin;
  const st = fs.statSync(dbFile);
  const tmp = path.join(path.dirname(dbFile), `.db.json.admin-${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: st.mode & 0o777 });
  try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* не root */ }
  fs.renameSync(tmp, dbFile);
  const entry = { at: Date.now(), actor: { id: null, username: 'root (admin.sh, offline)' }, action: `admin.${cmd}`, target: { type: 'user', id: u.id, name: u.username } };
  const audit = path.join(path.dirname(dbFile), 'admin-audit.jsonl');
  try {
    fs.appendFileSync(audit, JSON.stringify(entry) + '\n', { mode: 0o640 });
    fs.chownSync(audit, st.uid, st.gid);
  } catch { /* не критично */ }
  return { ...out, user: u.username, admins: list(), ...(cmd === 'revoke' ? { stillAdmin: false } : {}) };
}

if (mode === 'json') {
  process.stdout.write(JSON.stringify(request(rest[0], rest[1])));
} else if (mode === 'print') {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let r;
    try { r = JSON.parse(raw); } catch { r = { ok: false, error: `Неожиданный ответ сервера: ${raw.slice(0, 200)}` }; }
    print(r);
  });
} else if (mode === 'offline') {
  let r;
  try { r = offline(rest[0], rest[1], rest[2]); } catch (err) { r = { ok: false, error: `Не удалось изменить ${rest[0]}: ${err.message}` }; }
  print(r);
} else {
  console.error('Использование: admin-cli.mjs json|print|offline …');
  process.exit(2);
}
