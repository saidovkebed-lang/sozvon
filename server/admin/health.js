// «Состояние сервера» для админ-панели и проверок оповещений. Только чтение, без root:
// /proc, statfs, файлы в DATA_DIR, проба прокси и TLS-сертификата. Секреты (токены, пароли, содержимое
// /etc/sozvon.env) сюда не попадают: из переменных окружения берутся только адреса и флаги.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { db } from '../db.js';
import { isOnline } from '../model.js';
import { ytdlpPath } from '../music-library.js';
import { recentLogs, errorsSince, botCheckFailures } from './logbuf.js';
import { readJson } from './access.js';
import { currentVersion, stateDir } from './update.js';

let ctx = { dataDir: null, sfu: null, realtime: null };
export function initHealth(c) { ctx = { ...ctx, ...c }; }

const TEST_MODE = process.env.NODE_ENV !== 'production';
const OFF = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());

// ---------- система ----------
export function memInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
    const total = kb('MemTotal'), avail = kb('MemAvailable');
    if (Number.isFinite(total) && Number.isFinite(avail)) return { total, available: avail, used: total - avail, pct: round1(((total - avail) / total) * 100) };
  } catch { /* не Linux */ }
  const total = os.totalmem(), free = os.freemem();
  return { total, available: free, used: total - free, pct: round1(((total - free) / total) * 100) };
}

export function diskInfo(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    return { path: p, total, free, used, pct: total ? round1((used / (used + free)) * 100) : 0 };
  } catch (err) { return { path: p, error: err.code || err.message }; }
}

const round1 = (n) => Math.round(n * 10) / 10;

export function trafficInfo() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    const ifaces = [];
    for (const l of lines) {
      const m = l.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m || m[1] === 'lo') continue;
      const n = m[2].trim().split(/\s+/).map(Number);
      ifaces.push({ name: m[1].trim(), rx: n[0], tx: n[8] });
    }
    return { rx: ifaces.reduce((a, i) => a + i.rx, 0), tx: ifaces.reduce((a, i) => a + i.tx, 0), interfaces: ifaces, since: Date.now() - os.uptime() * 1000 };
  } catch { return null; }
}

// ---------- музыка ----------
let ytCache = null;
function ytdlpInfo() {
  if (ytCache && Date.now() - ytCache.at < 10 * 60_000) return Promise.resolve(ytCache.v);
  const bin = ytdlpPath();
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      let mtime = null;
      try {
        const full = bin.includes('/') ? bin : ['/usr/local/bin', '/usr/bin'].map((d) => path.join(d, bin)).find((p) => fs.existsSync(p));
        if (full) mtime = fs.statSync(full).mtimeMs;
      } catch { /* ignore */ }
      const v = err ? { installed: false, version: null, updatedAt: mtime } : { installed: true, version: String(stdout).trim().slice(0, 40), updatedAt: mtime };
      ytCache = { at: Date.now(), v };
      resolve(v);
    });
  });
}

function cookiesInfo() {
  const src = process.env.YTDLP_COOKIES;
  if (!src) return { configured: false };
  try {
    const st = fs.statSync(src);
    return { configured: true, exists: true, mtime: st.mtimeMs, ageDays: round1((Date.now() - st.mtimeMs) / 86400_000) };
  } catch (err) {
    return { configured: true, exists: false, error: err.code || 'нет доступа' };
  }
}

// ---------- VPN-прокси ----------
/** Адрес прокси (без логина/пароля): SPOTIFY_PROXY / YTDLP_PROXY, иначе null. */
export function proxyAddress() {
  for (const raw of [process.env.SPOTIFY_PROXY, process.env.YTDLP_PROXY]) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) continue; // socks — не проверяем CONNECT-ом
      return { host: u.hostname, port: Number(u.port) || 80, auth: u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : null };
    } catch { /* неверный URL */ }
  }
  return null;
}

/** CONNECT open.spotify.com:443 через прокси — отвечает ли «200». */
export function probeProxy({ timeoutMs = 8000 } = {}) {
  const px = proxyAddress();
  if (!px) return Promise.resolve({ configured: false });
  const target = process.env.ADMIN_VPN_PROBE_TARGET || 'open.spotify.com:443';
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve({ configured: true, proxy: `${px.host}:${px.port}`, target, ms: Date.now() - started, ...r }); };
    const sock = net.connect({ host: px.host, port: px.port });
    sock.setTimeout(timeoutMs, () => finish({ ok: false, error: 'нет ответа' }));
    sock.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    sock.on('connect', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${px.auth ? `Proxy-Authorization: ${px.auth}\r\n` : ''}\r\n`);
    });
    let head = '';
    sock.on('data', (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n')) return;
      const m = head.match(/^HTTP\/1\.[01] (\d{3})/);
      if (m && m[1] === '200') finish({ ok: true });
      else finish({ ok: false, error: m ? `HTTP ${m[1]}` : 'неверный ответ' });
    });
  });
}

let vpnCache = null;
async function vpnInfo(fresh = false) {
  if (!fresh && vpnCache && Date.now() - vpnCache.at < 60_000) return vpnCache.v;
  const v = await probeProxy();
  vpnCache = { at: Date.now(), v };
  return v;
}

// ---------- сертификат ----------
function certFromPem(file) {
  const x = new crypto.X509Certificate(fs.readFileSync(file));
  return { expiresAt: Date.parse(x.validTo), subject: x.subject.replace(/\n/g, ', ').slice(0, 120) };
}

function probeTls(host, port, servername) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: 6000 }, () => {
      const c = s.getPeerCertificate();
      s.destroy();
      resolve(c?.valid_to ? { expiresAt: Date.parse(c.valid_to), subject: String(c.subject?.CN || '').slice(0, 120) } : { error: 'нет сертификата' });
    });
    s.on('timeout', () => { s.destroy(); resolve({ error: 'нет ответа' }); });
    s.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

let certCache = null;
async function certInfo(fresh = false) {
  if (!fresh && certCache && Date.now() - certCache.at < 3600_000) return certCache.v;
  let v = null;
  try {
    const file = process.env.ADMIN_CERT_FILE;
    if (file) v = { source: 'file', ...certFromPem(file) };
    else if (/^https:\/\//.test(process.env.PUBLIC_URL || '')) {
      const u = new URL(process.env.PUBLIC_URL);
      // сначала локальный nginx (тот же сертификат, без выхода в интернет), потом — по адресу
      let r = await probeTls('127.0.0.1', Number(u.port) || 443, u.hostname);
      if (r.error) r = await probeTls(u.hostname, Number(u.port) || 443, u.hostname);
      v = { source: 'https', host: u.hostname, ...r };
    } else {
      const own = path.join(ctx.dataDir, 'certs', 'cert.pem');
      if (fs.existsSync(own)) v = { source: 'self-signed', ...certFromPem(own) };
    }
  } catch (err) { v = { error: err.code || err.message }; }
  if (v && Number.isFinite(v.expiresAt)) v.daysLeft = round1((v.expiresAt - Date.now()) / 86400_000);
  certCache = { at: Date.now(), v };
  return v;
}

// ---------- резервные копии ----------
function backupInfo() {
  const st = readJson(path.join(stateDir(), 'backup-status.json'));
  if (!st || typeof st !== 'object') return { known: false };
  const at = Date.parse(st.time || '') || null;
  return {
    known: true, ok: st.ok !== false && st.result !== 'failed', result: String(st.result || (st.ok === false ? 'failed' : 'ok')),
    at, ageHours: at ? round1((Date.now() - at) / 3600_000) : null,
    file: st.file ? String(st.file).slice(0, 120) : null, size: Number.isFinite(st.size) ? st.size : null,
    telegram: st.telegram ? String(st.telegram).slice(0, 80) : null, error: st.error ? String(st.error).slice(0, 300) : null,
  };
}

// ---------- SFU ----------
let sfuWasReady = false;
export function sfuInfo() {
  const enabled = !OFF(process.env.SFU);
  const ready = !!ctx.sfu?.ready;
  if (ready) sfuWasReady = true;
  return { enabled, ready, wasReady: sfuWasReady };
}

// ---------- онлайн ----------
function liveInfo() {
  const humans = db.data.users.filter((u) => !u.isBot);
  const stats = ctx.realtime?.adminOps?.liveStats?.() || {};
  return {
    users: humans.length,
    servers: db.data.servers.length,
    online: humans.filter((u) => isOnline(u.id)).length,
    voice: stats.voice ?? null,
    streams: stats.streams ?? null,
    botOnline: ctx.realtime?.isBotOnline?.() ?? null,
  };
}

/** Переопределение результатов проверок для тестов (только не в production): JSON-файл ALERT_PROBE_OVERRIDES. */
export function probeOverrides() {
  if (!TEST_MODE || !process.env.ALERT_PROBE_OVERRIDES) return {};
  return readJson(process.env.ALERT_PROBE_OVERRIDES) || {};
}

/** Полный снимок состояния. fresh — без кэша прокси/сертификата. */
export async function collectHealth({ fresh = false } = {}) {
  const [ytdlp, vpn, cert] = await Promise.all([ytdlpInfo(), vpnInfo(fresh), certInfo(fresh)]);
  const ov = probeOverrides();
  const mem = memInfo();
  const out = {
    at: Date.now(),
    version: currentVersion(),
    system: {
      hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length,
      load: os.loadavg().map(round1), uptime: Math.round(os.uptime()), memory: mem,
      disks: [diskInfo(ctx.dataDir), diskInfo('/')],
    },
    process: {
      uptime: Math.round(process.uptime()), node: process.version, pid: process.pid,
      rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
    },
    live: liveInfo(),
    sfu: sfuInfo(),
    traffic: trafficInfo(),
    music: {
      ytdlp, cookies: cookiesInfo(),
      check: (() => { const c = readJson(path.join(stateDir(), 'music-check.json')); return c && typeof c === 'object' ? { time: c.time || null, ok: Number(c.ok) || 0, failed: Number(c.failed) || 0, failures: Array.isArray(c.failures) ? c.failures.slice(0, 10).map((s) => String(s).slice(0, 200)) : [] } : null; })(),
      botChecks: botCheckFailures(6 * 3600_000),
      botChecksHour: botCheckFailures(3600_000).count,
    },
    vpn,
    backup: backupInfo(),
    cert,
    errors: { lastHour: errorsSince(3600_000), last5min: errorsSince(5 * 60_000), recent: recentLogs(100) },
  };
  // тестовые переопределения (только вне production)
  if (ov.memoryPct != null) out.system.memory = { ...out.system.memory, pct: ov.memoryPct };
  if (ov.diskPct != null) out.system.disks = out.system.disks.map((d) => ({ ...d, pct: ov.diskPct }));
  for (const k of ['vpn', 'backup', 'cert', 'sfu']) if (ov[k]) out[k] = { ...out[k], ...ov[k] };
  if (ov.botChecks != null) { out.music.botChecks = { count: ov.botChecks, last: Date.now() }; out.music.botChecksHour = ov.botChecks; }
  if (ov.cookiesAgeDays != null) out.music.cookies = { configured: true, exists: true, ageDays: ov.cookiesAgeDays };
  if (ov.errors5min != null) out.errors.last5min = ov.errors5min;
  return out;
}
