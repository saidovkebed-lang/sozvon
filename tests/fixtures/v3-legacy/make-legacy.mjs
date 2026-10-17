// Генератор фикстуры «прод-формат до v3» (owner: qa).
// Запускать на СТАРОЙ версии кода (коммит 28bc738 — последний до v3):
//   git worktree add --detach /tmp/sozvon-old 28bc738 && ln -s $PWD/node_modules /tmp/sozvon-old/
//   node tests/fixtures/v3-legacy/make-legacy.mjs /tmp/sozvon-old
// Скрипт поднимает старый сервер, наполняет его через реальные REST/Socket.IO
// (пользователи, сервер, каналы, сообщения, вложение, цвет аватара) и копирует
// получившиеся db.json + uploads/ в tests/fixtures/v3-legacy/data/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(OLD, 'server', 'index.js'))) throw new Error('укажите путь к checkout старой версии');
const PORT = 3977;
const BASE = `https://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-legacy-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(OLD, 'server', 'index.js')], {
  cwd: OLD, env: { ...process.env, PORT: String(PORT), HTTPS: '1', DATA_DIR: DATA }, stdio: 'inherit',
});
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} await sleep(150); }
  const reg = async (username) => {
    const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'legacy123' }) });
    return r.json();
  };
  const sock = async (token) => { const s = io(BASE, { auth: { token }, transports: ['websocket'], rejectUnauthorized: false, forceNew: true }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
  const ack = (s, e, p) => s.timeout(5000).emitWithAck(e, p);

  const owner = await reg('legacy_owner');
  const member = await reg('legacy_member');
  const lurker = await reg('legacy_lurker'); // зарегистрирован, но ни на одном сервере
  await fetch(BASE + '/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner.token }, body: JSON.stringify({ color: '#e5484d' }) });
  const so = await sock(owner.token); const sm = await sock(member.token);
  const { server } = await ack(so, 'server:create', { name: 'Старый сервер' });
  await ack(so, 'channel:create', { serverId: server.id, name: 'мемы', type: 'text' });
  await ack(sm, 'server:join', { inviteCode: server.inviteCode });
  const text = server.channels.find((c) => c.type === 'text');
  await ack(so, 'message:send', { channelId: text.id, content: 'Привет из старой версии' });
  await ack(sm, 'message:send', { channelId: text.id, content: 'Сообщение участника до миграции' });
  // вложение
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(HERE, '..', 'media', 'qa-image.png'))], { type: 'image/png' }), 'old.png');
  const up = await (await fetch(BASE + '/api/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token }, body: fd })).json();
  await ack(so, 'message:send', { channelId: text.id, content: 'картинка', attachments: [up] });
  const { server: second } = await ack(sm, 'server:create', { name: 'Сервер участника' });
  void second; void lurker;
  so.close(); sm.close();
  await sleep(800); // debounce записи db.json
} finally {
  srv.kill('SIGINT');
  await new Promise((r) => srv.once('exit', r));
}
const out = path.join(HERE, 'data');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'uploads'), { recursive: true });
const dbj = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
// сессии не переносим в фикстуру — тесты логинятся паролем
dbj.sessions = {};
fs.writeFileSync(path.join(out, 'db.json'), JSON.stringify(dbj, null, 1));
for (const f of fs.readdirSync(path.join(DATA, 'uploads'))) fs.copyFileSync(path.join(DATA, 'uploads', f), path.join(out, 'uploads', f));
console.log('legacy fixture ->', out, 'servers:', dbj.servers.length, 'users:', dbj.users.length);
