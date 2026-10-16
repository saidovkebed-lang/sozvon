// REST / Socket.IO / бот хелперы для тестов
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { BASE_URL, DATA_DIR, ROOT } from './env.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // самоподписанный сертификат тестового сервера
process.emitWarning = (() => { const o = process.emitWarning; return (w, ...a) => (String(w).includes('NODE_TLS_REJECT_UNAUTHORIZED') ? undefined : o.call(process, w, ...a)); })();

let counter = 0;
export function uniqueName(prefix = 'qa') {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-5)}${counter}${Math.random().toString(36).slice(2, 5)}`.slice(0, 24);
}

export async function http(method, url, opts = {}) { return httpAt(BASE_URL, method, url, opts); }

export async function httpAt(base, method, url, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = token.startsWith('Bot ') ? token : `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  if (raw) return res;
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { _text: text }; }
  return { status: res.status, json, headers: res.headers };
}

export async function registerApi(username = uniqueName(), password = 'secret123') {
  const r = await http('POST', '/api/register', { body: { username, password } });
  if (r.status !== 200) throw new Error(`register ${username} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { ...r.json, username, password };
}

export function connect(token, opts = {}) {
  const auth = opts.bot ? { botToken: token } : { token };
  const socket = io(opts.base || BASE_URL, { auth, transports: ['websocket'], rejectUnauthorized: false, reconnection: false, forceNew: true });
  return socket;
}

export function connected(socket, ms = 8000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve(socket);
    const t = setTimeout(() => reject(new Error('socket connect timeout')), ms);
    socket.once('connect', () => { clearTimeout(t); resolve(socket); });
    socket.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

export async function connectUser(token) { return connected(connect(token)); }

export function ack(socket, event, payload, ms = 8000) {
  const s = socket.timeout(ms);
  return payload === undefined ? s.emitWithAck(event) : s.emitWithAck(event, payload);
}

/** Ждать событие, удовлетворяющее предикату. */
export function waitEvent(socket, event, pred = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    function h(data) { try { if (pred(data)) { clearTimeout(t); socket.off(event, h); resolve(data); } } catch (e) { /* ignore */ } }
    socket.on(event, h);
  });
}

/** Собирает все события указанного типа. */
export function collect(socket, event) {
  const arr = [];
  socket.on(event, (d) => arr.push(d));
  return arr;
}

/** Пользователь + сокет + bootstrap */
export async function makeUser(prefix = 'qa') {
  const reg = await registerApi(uniqueName(prefix));
  const socket = await connectUser(reg.token);
  const boot = await ack(socket, 'bootstrap');
  return { ...reg, socket, boot };
}

export async function createServer(user, name = 'QA сервер') {
  const r = await ack(user.socket, 'server:create', { name });
  if (!r.ok) throw new Error('server:create failed: ' + JSON.stringify(r));
  return r.server;
}

export const textChannel = (server) => server.channels.find((c) => c.type === 'text');
export const voiceChannel = (server) => server.channels.find((c) => c.type === 'voice');

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function waitFor(fn, { timeout = 10000, interval = 200, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`waitFor timeout: ${message} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// ---------- Бот как дочерний процесс ----------
export async function startBot({ base = BASE_URL, dataDir = DATA_DIR, env = {} } = {}) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'bot', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, ...env, BOT_SERVER_URL: base, DATA_DIR: dataDir, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  try {
    await waitFor(async () => {
      if (exited) throw new Error('bot exited ' + JSON.stringify(exited) + '\n' + logs.join(''));
      const r = await httpAt(base, 'GET', '/api/config');
      return r.json && r.json.botOnline === true;
    }, { timeout: 15000, message: 'botOnline=true in /api/config' });
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(e.message + '\nBOT LOGS:\n' + logs.join(''));
  }
  return {
    child, logs,
    async stop() {
      if (exited) return;
      const p = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 3000);
      await p; clearTimeout(t);
      await waitFor(async () => (await httpAt(base, 'GET', '/api/config')).json.botOnline === false,
        { timeout: 8000, message: 'botOnline=false after stop' }).catch(() => {});
    },
  };
}

export function botToken(dataDir = DATA_DIR) {
  return fs.readFileSync(path.join(dataDir, 'bot-token.txt'), 'utf8').trim();
}

/** Хелперы, привязанные к другому серверу (например, музыкальному стенду на отдельном порту). */
export function apiAt(base, dataDir) {
  const h = (method, url, opts) => httpAt(base, method, url, opts);
  async function register(username = uniqueName(), password = 'secret123') {
    const r = await h('POST', '/api/register', { body: { username, password } });
    if (r.status !== 200) throw new Error(`register ${username} failed: ${r.status} ${JSON.stringify(r.json)}`);
    return { ...r.json, username, password };
  }
  async function user(prefix = 'qa') {
    const reg = await register(uniqueName(prefix));
    const socket = await connected(connect(reg.token, { base }));
    const boot = await ack(socket, 'bootstrap');
    return { ...reg, socket, boot };
  }
  return { http: h, registerApi: register, makeUser: user, connect: (t, o = {}) => connect(t, { ...o, base }), startBot: (o = {}) => startBot({ base, dataDir, ...o }) };
}
