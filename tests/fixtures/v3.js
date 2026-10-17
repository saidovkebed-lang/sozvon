// Хелперы для тестов v3 (роли и права, профили, миграция). Значения прав — из SPEC-v3 §1.1,
// намеренно продублированы здесь (а не импортированы из server/), чтобы тесты проверяли контракт независимо.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { ack, makeUser, createServer, waitEvent, waitFor, httpAt, sleep } from './api.js';
import { ROOT, PORT } from './env.js';

export const P = {
  ADMINISTRATOR: 1 << 0, MANAGE_SERVER: 1 << 1, MANAGE_ROLES: 1 << 2, MANAGE_CHANNELS: 1 << 3,
  KICK_MEMBERS: 1 << 4, BAN_MEMBERS: 1 << 5, CREATE_INVITE: 1 << 6, VIEW_CHANNEL: 1 << 7,
  SEND_MESSAGES: 1 << 8, ATTACH_FILES: 1 << 9, MANAGE_MESSAGES: 1 << 10, MENTION_EVERYONE: 1 << 11,
  CONNECT: 1 << 12, SPEAK: 1 << 13, STREAM: 1 << 14, MUTE_MEMBERS: 1 << 15, DEAFEN_MEMBERS: 1 << 16,
  MOVE_MEMBERS: 1 << 17, USE_MUSIC_BOT: 1 << 18,
};
export const DEFAULT_EVERYONE = P.CREATE_INVITE | P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES
  | P.CONNECT | P.SPEAK | P.STREAM | P.USE_MUSIC_BOT;

export const withId = (u) => Object.assign(u, { id: u.user.id });
export const memberIds = (srv) => (srv.members || []).map((m) => m.id);

/** Владелец A создаёт сервер; остальные входят по инвайту. Возвращает {srv, owner, members[]} */
export async function guild(n = 2, name = 'v3 сервер') {
  const owner = withId(await makeUser('own'));
  const srv = await createServer(owner, name);
  const members = [];
  for (let i = 0; i < n; i++) {
    const u = withId(await makeUser('mem'));
    const r = await ack(u.socket, 'server:join', { inviteCode: srv.inviteCode });
    if (!r.ok) throw new Error('server:join ' + JSON.stringify(r));
    members.push(u);
  }
  return { srv, owner, members, all: [owner, ...members] };
}

export async function ok(socket, event, payload) {
  const r = await ack(socket, event, payload);
  expect(r, `${event} ${JSON.stringify(payload)} → ok`).toMatchObject({ ok: true });
  return r;
}
export async function denied(socket, event, payload, re) {
  const r = await ack(socket, event, payload);
  expect(r.ok, `${event} ${JSON.stringify(payload)} должен быть отклонён, ответ: ${JSON.stringify(r)}`).toBe(false);
  expect(typeof r.error).toBe('string');
  if (re) expect(r.error).toMatch(re);
  return r;
}

export async function makeRole(owner, serverId, opts) {
  const r = await ok(owner.socket, 'role:create', { serverId, ...opts });
  expect(r.role).toBeTruthy();
  return r.role;
}

/** Свежий вид сервера глазами пользователя (через bootstrap). */
export async function viewOf(user, serverId) {
  const b = await ack(user.socket, 'bootstrap');
  return (b.servers || []).find((s) => s.id === serverId) || null;
}

export async function setEveryone(owner, serverId, permissions) {
  await ok(owner.socket, 'role:update', { serverId, roleId: serverId, permissions });
}

export const closeAll = (users) => { for (const u of users) u.socket?.close(); };

// ---------- отдельный сервер (миграция, лимиты) ----------
/** Запуск отдельного экземпляра server/index.js. Останавливается по PID (stop()). */
export async function startStandalone({ port, dataDir, env = {} }) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HTTPS: '1', DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  const base = `https://localhost:${port}`;
  await waitFor(async () => {
    if (exited) throw new Error('server exited ' + JSON.stringify(exited) + '\n' + logs.join(''));
    return (await httpAt(base, 'GET', '/api/config')).status === 200;
  }, { timeout: 20000, message: `standalone server :${port}` }).catch((e) => { child.kill('SIGKILL'); throw new Error(e.message + '\n' + logs.join('')); });
  return {
    base, pid: child.pid, logs, child,
    async stop() {
      if (exited) return;
      const p = new Promise((r) => child.once('exit', r));
      process.kill(child.pid, 'SIGTERM');
      const t = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 4000);
      await p; clearTimeout(t);
    },
  };
}

export const MIGRATION_PORT = PORT + 20;
export const LIMIT_PORT = PORT + 21;
export const LEGACY_DIR = path.join(ROOT, 'tests', 'fixtures', 'v3-legacy', 'data');

// ---------- медиа для профиля ----------
export const V3_MEDIA = path.join(ROOT, 'tests', 'fixtures', 'media', 'v3');
export function ensureV3Media() {
  fs.mkdirSync(V3_MEDIA, { recursive: true });
  const ff = (out, args) => {
    const f = path.join(V3_MEDIA, out);
    if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, f]);
    return f;
  };
  return {
    // неквадратный PNG 640×360 — проверяем центр-кроп до 256×256
    png: ff('avatar-640x360.png', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1']),
    // анимированный GIF 320×240, 2 с, 10 fps (20 кадров)
    gif: ff('avatar-anim-320x240.gif', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2']),
    // баннер 1200×500
    banner: ff('banner-1200x500.png', ['-f', 'lavfi', '-i', 'testsrc2=size=1200x500:rate=1', '-frames:v', '1']),
    // анимированный баннер
    bannerGif: ff('banner-anim-480x200.gif', ['-f', 'lavfi', '-i', 'testsrc2=size=480x200:rate=10:duration=1']),
  };
}

/** Размеры и число кадров картинки. ffprobe; для animated WebP (декодер ffmpeg не поддерживает ANIM) —
 *  разбор RIFF: холст из VP8X, кадры — число чанков ANMF. */
export function probe(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.toString('ascii', 12, 16) === 'VP8X') {
    const w = 1 + buf.readUIntLE(24, 3); const h = 1 + buf.readUIntLE(27, 3);
    let frames = 0; let off = 12;
    while (off + 8 <= buf.length) { const id = buf.toString('ascii', off, off + 4); const sz = buf.readUInt32LE(off + 4); if (id === 'ANMF') frames++; off += 8 + sz + (sz & 1); }
    return { width: w, height: h, frames: frames || 1, codec: 'webp' };
  }
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_read_frames,codec_name', '-of', 'json', file], { encoding: 'utf8' });
  const s = JSON.parse(out).streams[0];
  return { width: s.width, height: s.height, frames: Number(s.nb_read_frames), codec: s.codec_name };
}

export async function upload(base, url, token, file, type, extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  fd.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  return httpAt(base, 'POST', url, { token, body: fd });
}

export async function download(base, url, dest) {
  const res = await fetch(new URL(url, base));
  expect(res.status, `GET ${url}`).toBe(200);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return { file: dest, headers: res.headers };
}

export { waitEvent, sleep };
