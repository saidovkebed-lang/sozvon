'use strict';
// Собственный захват экрана/окна для демонстрации (Windows): sozvon-capture.exe (DXGI Desktop Duplication).
// Chromium в Electron 44 на Windows 11 24H2+ захватывает только через Windows Graphics Capture с курсором —
// Windows от этого переводит курсор в программный режим, и в играх со своим курсором (Noita и др.) он пропадает.
// Кадры (I420) помощник отдаёт по HTTP с 127.0.0.1 (одноразовый токен) — страница читает их fetch'ем
// и складывает в MediaStreamTrackGenerator; главный процесс в передаче кадров не участвует (через него
// 1080p60 — это ~190 МБ/с и почти целое ядро). Протокол — desktop/native/capture/capture.cpp.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { desktopCapturer, screen, app } = require('electron');

function helperCommand() {
  // Автотесты на Linux: SOZVON_CAPTURE_FAKE=путь к node-скрипту с тем же протоколом
  const fake = process.env.SOZVON_CAPTURE_FAKE;
  if (fake && fs.existsSync(fake)) return { cmd: process.execPath, pre: [fake], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  if (process.platform !== 'win32') return null;
  const exe = app.isPackaged
    ? path.join(process.resourcesPath, 'capture', 'sozvon-capture.exe')
    : path.join(__dirname, '..', 'native', 'capture', 'build', 'sozvon-capture.exe');
  return fs.existsSync(exe) ? { cmd: exe, pre: [], env: process.env } : null;
}

const isAvailable = () => !!helperCommand();

/** Аргументы помощника для источника desktopCapturer ('screen:…' / 'window:HWND:…') */
async function sourceArgs(sourceId) {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => s.id === sourceId);
  if (!src) return null;
  if (src.id.startsWith('window:')) {
    const hwnd = src.id.split(':')[1];
    return /^\d+$/.test(hwnd) ? ['--hwnd', hwnd] : null;
  }
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(src.display_id)) || screen.getPrimaryDisplay();
  // физические пиксели (помощник работает с учётом DPI каждого монитора)
  const r = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
  return ['--monitor', `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`];
}

/** Запустить помощник; resolve({proc, url}) после строки "PORT n" */
function launchHelper({ args, params, origin, log }) {
  return new Promise((resolve, reject) => {
    const hc = helperCommand();
    if (!hc) { reject(new Error('помощник захвата не найден')); return; }
    const token = crypto.randomBytes(16).toString('hex');
    const size = params ? ['--max-width', String(params.maxWidth), '--max-height', String(params.maxHeight), '--fps', String(params.fps)] : [];
    const argv = [...hc.pre, ...args, ...size, '--listen', '--token', token, '--origin', origin];
    const proc = spawn(hc.cmd, argv, { env: hc.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let done = false;
    const timer = setTimeout(() => fail(new Error('помощник не ответил')), 8000);
    function fail(e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      reject(e);
    }
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s) => {
      if (done) return;
      out += s;
      const m = out.match(/PORT (\d+)/);
      if (!m) return;
      done = true;
      clearTimeout(timer);
      resolve({ proc, url: `http://127.0.0.1:${m[1]}/${token}` });
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (s) => { for (const line of s.split('\n')) if (line.trim()) log(line.trim()); });
    proc.stdin.on('error', () => { /* помощник уже вышел */ });
    proc.on('error', (e) => fail(e));
    proc.on('exit', (code) => fail(new Error(`помощник завершился (код ${code})`)));
  });
}

function stopProc(proc) {
  if (!proc) return;
  try { proc.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { try { if (proc.exitCode === null) proc.kill(); } catch { /* ignore */ } }, 1500);
}

/**
 * Сессии захвата. start(webContents, {sourceId, maxWidth, maxHeight, fps}) → {ok, token, url} | {ok:false, error}.
 * Конец сессии (помощник вышел сам) — событие 'desktop:native-capture-ended' ({token, reason}) в страницу.
 */
function createNativeCapture({ log = console.log } = {}) {
  const sessions = new Map();
  const clamp = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || def));
  const norm = (o = {}) => ({
    maxWidth: clamp(o.maxWidth, 160, 3840, 1280),
    maxHeight: clamp(o.maxHeight, 90, 2160, 720),
    fps: clamp(o.fps, 1, 60, 30),
  });

  function watch(s, proc) {
    proc.on('exit', (code) => {
      if (s.proc !== proc || s.closed) return; // замена при смене качества или штатная остановка
      s.closed = true;
      sessions.delete(s.token);
      s.log(`помощник завершился (код ${code})`);
      if (!s.wc.isDestroyed()) s.wc.send('desktop:native-capture-ended', { token: s.token, reason: code === 3 ? 'window-closed' : 'exit', code });
    });
    if (s.paused) proc.stdin.write('pause\n');
  }

  async function start(wc, opts = {}) {
    if (!isAvailable()) return { ok: false, error: 'unavailable' };
    const args = await sourceArgs(String(opts.sourceId || ''));
    if (!args) return { ok: false, error: 'source' };
    let origin;
    try { origin = new URL(wc.getURL()).origin; } catch { return { ok: false, error: 'origin' }; }
    const token = crypto.randomBytes(8).toString('hex');
    const s = { token, wc, args, origin, params: norm(opts), proc: null, paused: false, closed: false, log: (m) => log(`[capture ${token}] ${m}`) };
    try {
      const { proc, url } = await launchHelper(s);
      s.proc = proc;
      sessions.set(token, s);
      watch(s, proc);
      return { ok: true, token, url };
    } catch (e) {
      s.log(e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Звук экрана без звука самого приложения (WASAPI process loopback, Windows 11): голоса звонка, которые
   * играет «Astra», в трансляцию не попадают — их не нужно приглушать. Исключается весь наш процесс с потомками
   * (звук Chromium играет служебный процесс-потомок главного). {ok:false} — нет API (Windows 10) или устройства.
   */
  async function startAudio(wc) {
    if (!isAvailable()) return { ok: false, error: 'unavailable' };
    let origin;
    try { origin = new URL(wc.getURL()).origin; } catch { return { ok: false, error: 'origin' }; }
    const token = crypto.randomBytes(8).toString('hex');
    const s = { token, wc, args: ['--audio-exclude-pid', String(process.pid)], origin, params: null, proc: null, paused: false, closed: false, audio: true, log: (m) => log(`[audio ${token}] ${m}`) };
    try {
      const { proc, url } = await launchHelper(s);
      s.proc = proc;
      sessions.set(token, s);
      watch(s, proc);
      return { ok: true, token, url };
    } catch (e) {
      s.log(e.message);
      return { ok: false, error: e.message };
    }
  }

  async function control(token, cmd, params) {
    const s = sessions.get(String(token || ''));
    if (!s) return { ok: false };
    if (cmd === 'pause' || cmd === 'resume') {
      s.paused = cmd === 'pause';
      try { s.proc.stdin.write(`${cmd}\n`); } catch { /* ignore */ }
      return { ok: true };
    }
    if (cmd === 'update' && !s.audio) {
      s.params = norm(params);
      const old = s.proc;
      try {
        const { proc, url } = await launchHelper(s);
        s.proc = proc;
        watch(s, proc);
        stopProc(old);
        return { ok: true, url };
      } catch (e) {
        s.log(e.message);
        return { ok: false };
      }
    }
    if (cmd === 'stop') {
      s.closed = true;
      sessions.delete(s.token);
      stopProc(s.proc);
      return { ok: true };
    }
    return { ok: false };
  }

  function stopAll() {
    for (const s of sessions.values()) { s.closed = true; stopProc(s.proc); }
    sessions.clear();
  }

  return { isAvailable, start, startAudio, control, stopAll, get count() { return sessions.size; } };
}

module.exports = { createNativeCapture, helperCommand };
