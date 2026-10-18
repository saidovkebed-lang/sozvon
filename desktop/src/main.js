'use strict';
// Созвон для ПК — главный процесс Electron.
// Окно открывает веб-клиент сервера (по умолчанию прод), добавляет: глобальную рацию и mute/deafen (uiohook),
// трей, автозапуск, выбор экрана для демонстрации, бейдж непрочитанных, одиночный экземпляр.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, session, shell, dialog, nativeImage, desktopCapturer,
  screen, Notification, clipboard,
} = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { buildCodeMap, parseCombo } = require('./keymap');
const { createUpdater } = require('./updater');

const APP_ID = 'io.sslip.sozvon.desktop';
const DISPLAY_NAME = 'Созвон';
const DEFAULT_SERVER = 'https://89-108-81-153.sslip.io';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const ASSETS = path.join(__dirname, 'assets');
let startHidden = process.argv.includes('--hidden');

app.setName(IS_LINUX ? 'sozvon' : 'Sozvon'); // каталог userData: %APPDATA%\Sozvon, ~/.config/sozvon
// Отдельный профиль (тесты, второй аккаунт): --user-data-dir=ПУТЬ
{
  const ud = (process.argv.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length);
  if (ud) app.setPath('userData', path.resolve(ud));
}
if (IS_WIN) app.setAppUserModelId(APP_ID);

// ---------------- Конфигурация (userData/config.json) ----------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  serverUrl: null,         // null → первый запуск, показываем окно настройки
  trustedCerts: [],        // [{host, fingerprint}] — самоподписанные сертификаты, явно одобренные пользователем
  closeToTray: true,
  autoStart: false,
  windowBounds: null,      // {x,y,width,height,maximized}
  notifiedTray: false,
};
let config = loadConfig();
if (config.startHiddenOnce) { startHidden = true; delete config.startHiddenOnce; }
function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch { return { ...DEFAULT_CONFIG }; }
}
let saveTimer = null;
function saveConfig(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(`${CONFIG_PATH}.tmp`, JSON.stringify(config, null, 2));
      fs.renameSync(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
    } catch (e) { console.error('[config]', e); }
  };
  if (now) write(); else saveTimer = setTimeout(write, 400);
}

// Разрешено переопределить сервер для тестов/портативного запуска: --server=URL или SOZVON_SERVER
const cliServer = (process.argv.find((a) => a.startsWith('--server=')) || '').slice('--server='.length)
  || process.env.SOZVON_SERVER_URL || process.env.SOZVON_SERVER || '';
// Только для автотестов: самоподписанный сертификат на localhost/127.0.0.1 без окна согласия
const ALLOW_INSECURE_LOCALHOST = process.env.SOZVON_ALLOW_INSECURE_LOCALHOST === '1';

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch { return null; }
}
const serverOrigin = () => normalizeUrl(cliServer) || normalizeUrl(config.serverUrl);
const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');

// http-сервер в локальной сети: без secure context нет микрофона — считаем его безопасным (только этот origin).
{
  const o = serverOrigin();
  if (o && o.startsWith('http:') && !isLocalHost(new URL(o).hostname)) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', o);
  }
}
// Медиа-ключи/фоновые вкладки: голос не должен «засыпать», когда окно свёрнуто
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Окно свёрнуто или перекрыто — Chromium перестаёт его рисовать (видео, анимации): заметно меньше нагрузка.
// Таймеры не замедляем — индикаторы речи и пинг работают и в фоне; звук и WebRTC от этого не зависят.

// ---------------- Одиночный экземпляр ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

let mainWindow = null;
let setupWindow = null;
let tray = null;
let quitting = false;
let badgeCount = 0;
let voiceState = { inVoice: false, muted: false, deafened: false };
let updateInfo = null; // {version, url}

const isOurOrigin = (url) => {
  try { return new URL(url).origin === serverOrigin(); } catch { return false; }
};
const APP_FILE_PREFIX = `${pathToFileURL(__dirname).href}/`;
const isAppFile = (url) => typeof url === 'string' && url.startsWith(APP_FILE_PREFIX);

// ---------------- Сертификаты: только явное согласие для конкретного хоста и отпечатка ----------------
const lastCertErrors = new Map(); // host → {fingerprint, issuer, subject, error, validExpiry}
const isTrustedCert = (host, fp) => (config.trustedCerts || []).some((c) => c.host === host && c.fingerprint === fp)
  || (ALLOW_INSECURE_LOCALHOST && (host === 'localhost' || host === '127.0.0.1'));
// Страница/WebSocket: если проверка в сессии уже закэширована как ошибка — решаем здесь (тот же список согласий)
app.on('certificate-error', (e, _wc, url, _err, cert, cb) => {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  if (host && isTrustedCert(host, cert?.fingerprint)) { e.preventDefault(); cb(true); } else cb(false);
});
function setupCertificates(ses) {
  ses.setCertificateVerifyProc((req, cb) => {
    if (req.errorCode === 0) return cb(-3); // всё хорошо — решение Chromium
    const fp = req.certificate?.fingerprint;
    lastCertErrors.set(req.hostname, {
      host: req.hostname, fingerprint: fp, error: req.verificationResult,
      issuer: req.certificate?.issuerName, subject: req.certificate?.subjectName,
      validExpiry: req.certificate?.validExpiry,
    });
    cb(isTrustedCert(req.hostname, fp) ? 0 : -3);
  });
}

// ---------------- Разрешения: медиа/уведомления — только своему серверу ----------------
const ALLOWED_PERMS = new Set([
  'media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read',
  'speaker-selection', 'pointerLock', 'keyboardLock', 'window-management', 'idle-detection',
]);
function setupPermissions(ses) {
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = details?.requestingUrl || wc?.getURL() || '';
    cb(isOurOrigin(origin) && ALLOWED_PERMS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return isOurOrigin(requestingOrigin || wc?.getURL() || '') && ALLOWED_PERMS.has(permission);
  });
  ses.setDisplayMediaRequestHandler(handleDisplayMedia, { useSystemPicker: false });
}

// ---------------- Демонстрация экрана ----------------
let pendingSource = null; // {id, audio, at}
async function getSources({ types, thumbnailWidth, thumbnailHeight } = {}) {
  const t = (Array.isArray(types) ? types : ['screen', 'window']).filter((x) => x === 'screen' || x === 'window');
  const w = Math.min(Math.max(Number(thumbnailWidth) || 320, 16), 1280);
  const h = Math.min(Math.max(Number(thumbnailHeight) || 180, 16), 720);
  return desktopCapturer.getSources({ types: t.length ? t : ['screen', 'window'], thumbnailSize: { width: w, height: h }, fetchWindowIcons: true });
}
async function handleDisplayMedia(request, callback) {
  try {
    const frameUrl = request.frame?.url || request.securityOrigin || '';
    if (!isOurOrigin(frameUrl)) return callback({});
    // Выбор не сбрасываем сразу: если системный звук недоступен, страница повторит запрос без звука
    const sel = pendingSource && Date.now() - pendingSource.at < 15000 ? pendingSource : null;
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    let src = sel ? sources.find((s) => s.id === sel.id) : null;
    if (sel && !src) return callback({}); // окно закрыли между выбором и запуском
    if (!src) {
      // Без выбора в UI — основной экран (совместимость со старым клиентом)
      const primary = String(screen.getPrimaryDisplay().id);
      src = sources.find((s) => s.id.startsWith('screen:') && s.display_id === primary) || sources.find((s) => s.id.startsWith('screen:'));
    }
    if (!src) return callback({});
    const res = { video: src };
    // Системный звук: loopback поддерживается Chromium только на Windows (и macOS 13+ — здесь не собираем)
    if (request.audioRequested && (sel ? sel.audio : true) && IS_WIN) res.audio = 'loopback';
    callback(res);
  } catch (e) {
    console.error('[display-media]', e);
    callback({});
  }
}

// ---------------- Глобальные клавиши (uiohook) ----------------
let hook = null;
let codeMap = {};
const hotkeys = { pttEnabled: false, pttKey: 'KeyV', toggleMute: '', toggleDeafen: '' };
let pttCodes = new Set();
let muteCombo = null;
let deafenCombo = null;
let pttDownSent = false;
const heldKeys = new Set();

function loadHook() {
  if (hook !== null) return hook;
  try {
    const mod = require('uiohook-napi');
    codeMap = buildCodeMap(mod.UiohookKey);
    hook = { mod, running: false };
    mod.uIOhook.on('keydown', onGlobalKeyDown);
    mod.uIOhook.on('keyup', onGlobalKeyUp);
  } catch (e) {
    console.error('[hotkeys] uiohook недоступен:', e?.message || e);
    hook = false;
  }
  return hook;
}
function applyHotkeys() {
  const h = loadHook();
  if (!h) return;
  pttCodes = new Set(hotkeys.pttEnabled ? (codeMap[hotkeys.pttKey] || []) : []);
  muteCombo = parseCombo(hotkeys.toggleMute);
  deafenCombo = parseCombo(hotkeys.toggleDeafen);
  const need = pttCodes.size > 0 || !!muteCombo || !!deafenCombo;
  try {
    if (need && !h.running) { h.mod.uIOhook.start(); h.running = true; console.log('[hotkeys] глобальный перехват клавиш включён'); }
    else if (!need && h.running) { h.mod.uIOhook.stop(); h.running = false; releasePtt(); }
  } catch (e) { console.error('[hotkeys] start/stop:', e?.message || e); }
}
const windowFocused = () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
function sendToPage(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed() && isOurOrigin(mainWindow.webContents.getURL())) {
    mainWindow.webContents.send(channel, ...args);
  }
}
function releasePtt() {
  if (pttDownSent) { pttDownSent = false; sendToPage('desktop:ptt', false); }
}
function comboMatches(c, e) {
  if (!c) return false;
  const codes = codeMap[c.code] || [];
  return codes.includes(e.keycode) && !!e.ctrlKey === c.ctrl && !!e.altKey === c.alt && !!e.shiftKey === c.shift && !!e.metaKey === c.meta;
}
function onGlobalKeyDown(e) {
  const repeat = heldKeys.has(e.keycode);
  heldKeys.add(e.keycode);
  // В фокусе страница сама обрабатывает клавиши (иначе mute переключится дважды)
  if (pttCodes.has(e.keycode)) {
    if (!pttDownSent && !windowFocused()) { pttDownSent = true; sendToPage('desktop:ptt', true); }
    return;
  }
  if (repeat || windowFocused()) return;
  if (comboMatches(muteCombo, e)) sendToPage('desktop:toggle-mute');
  else if (comboMatches(deafenCombo, e)) sendToPage('desktop:toggle-deafen');
}
function onGlobalKeyUp(e) {
  heldKeys.delete(e.keycode);
  if (pttCodes.has(e.keycode)) releasePtt();
}

// ---------------- Окно ----------------
function windowIcon() { return nativeImage.createFromPath(path.join(ASSETS, 'icon.png')); }

function restoreBounds() {
  const b = config.windowBounds;
  const def = { width: 1280, height: 800 };
  if (!b || !b.width || !b.height) return def;
  const out = { width: Math.max(940, b.width), height: Math.max(560, b.height) };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    const d = screen.getDisplayMatching({ x: b.x, y: b.y, width: out.width, height: out.height });
    const wa = d.workArea;
    const visible = b.x < wa.x + wa.width - 80 && b.x + out.width > wa.x + 80 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 80;
    if (visible) { out.x = b.x; out.y = b.y; }
  }
  return out;
}
function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const maximized = mainWindow.isMaximized() || mainWindow.isFullScreen();
  const nb = maximized ? (config.windowBounds || mainWindow.getNormalBounds()) : mainWindow.getBounds();
  config.windowBounds = { ...nb, maximized };
  saveConfig();
}

function createMainWindow() {
  const bounds = restoreBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: DISPLAY_NAME,
    icon: IS_MAC ? undefined : windowIcon(),
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      backgroundThrottling: true,
    },
  });
  if (config.windowBounds?.maximized) mainWindow.maximize();
  const wc = mainWindow.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} SozvonDesktop/${app.getVersion()}`);

  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(ev, rememberBounds);
  mainWindow.on('focus', () => { if (IS_WIN) mainWindow.flashFrame(false); });
  mainWindow.on('close', (e) => {
    rememberBounds();
    if (!quitting && config.closeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
      if (!config.notifiedTray && Notification.isSupported()) {
        config.notifiedTray = true; saveConfig();
        new Notification({ title: DISPLAY_NAME, body: 'Созвон продолжает работать в трее. Выйти — правой кнопкой по значку → «Выход».', icon: windowIcon() }).show();
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Навигация: остаёмся на своём сервере, всё прочее — в системном браузере
  wc.on('will-navigate', (e, url) => {
    if (isOurOrigin(url) || isAppFile(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (isOurOrigin(url) || isAppFile(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED */) return;
    showOffline(url, `${desc} (${code})`);
  });
  wc.on('render-process-gone', (_e, d) => {
    console.error('[renderer gone]', d.reason);
    if (d.reason !== 'clean-exit') setTimeout(() => loadServer(), 1000);
  });
  wc.on('context-menu', (_e, p) => showContextMenu(p));
  wc.on('before-input-event', (e, input) => {
    // F5 / Ctrl+R — перезагрузка, Ctrl+Shift+I — инструменты разработчика
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r' && !input.shift)) { e.preventDefault(); wc.reload(); }
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') { e.preventDefault(); wc.toggleDevTools(); }
  });
  wc.on('did-navigate', () => { if (!isOurOrigin(wc.getURL())) setBadge(0); });
  loadServer();
}

function loadServer() {
  const origin = serverOrigin();
  if (!mainWindow || !origin) return;
  mainWindow.loadURL(`${origin}/`).catch(() => { /* did-fail-load покажет offline */ });
}
function showOffline(url, error) {
  if (!mainWindow) return;
  mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { url: serverOrigin() || url || '', error: error || '' } });
  if (!startHidden && !mainWindow.isVisible()) mainWindow.show();
}
function showMain() {
  if (setupWindow && !setupWindow.isDestroyed() && !mainWindow) { setupWindow.show(); setupWindow.focus(); return; }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function openExternal(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href);
  } catch { /* ignore */ }
}

function showContextMenu(p) {
  const items = [];
  if (p.misspelledWord && p.dictionarySuggestions?.length) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => mainWindow.webContents.replaceMisspelling(s) });
    items.push({ type: 'separator' });
  }
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    items.push({ label: 'Открыть ссылку в браузере', click: () => openExternal(p.linkURL) });
    items.push({ label: 'Копировать ссылку', click: () => clipboard.writeText(p.linkURL) });
    items.push({ type: 'separator' });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Копировать изображение', click: () => mainWindow.webContents.copyImageAt(p.x, p.y) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' },
      { role: 'cut', label: 'Вырезать', enabled: p.editFlags.canCut },
      { role: 'copy', label: 'Копировать', enabled: p.editFlags.canCopy },
      { role: 'paste', label: 'Вставить', enabled: p.editFlags.canPaste },
      { role: 'selectAll', label: 'Выделить всё' });
  } else if (p.selectionText) {
    items.push({ role: 'copy', label: 'Копировать' });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

// ---------------- Окно «Сервер…» ----------------
function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${DISPLAY_NAME} — сервер`,
    icon: IS_MAC ? undefined : windowIcon(),
    parent: mainWindow && mainWindow.isVisible() ? mainWindow : undefined,
    modal: !!(mainWindow && mainWindow.isVisible()),
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  setupWindow.setMenu(null);
  setupWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  setupWindow.webContents.on('will-navigate', (e, url) => { if (!isAppFile(url)) { e.preventDefault(); openExternal(url); } });
  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (!serverOrigin()) app.quit(); // первый запуск отменён
  });
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}

let checkSeq = 0;
async function checkServer(url, trustCert) {
  const origin = normalizeUrl(url);
  if (!origin) return { ok: false, error: 'Неверный адрес. Пример: https://89-108-81-153.sslip.io' };
  const host = new URL(origin).hostname;
  if (trustCert) {
    const ce = lastCertErrors.get(host);
    if (ce?.fingerprint && !(config.trustedCerts || []).some((c) => c.host === host && c.fingerprint === ce.fingerprint)) {
      config.trustedCerts = [...(config.trustedCerts || []).filter((c) => c.host !== host), { host, fingerprint: ce.fingerprint }];
      saveConfig(true);

    }
  }
  lastCertErrors.delete(host);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    // Отдельная временная сессия на каждую проверку: Chromium кэширует результат проверки сертификата,
    // и отказ, закэшированный в основной сессии, мешал бы открыть сервер после согласия пользователя.
    const ses = session.fromPartition(`sozvon-check-${++checkSeq}`, { cache: false });
    setupCertificates(ses);
    const res = await ses.fetch(`${origin}/api/config`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, origin, error: `Сервер ответил ${res.status}. Это точно сервер Созвона?` };
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.iceServers)) return { ok: false, origin, error: 'По этому адресу не Созвон (нет /api/config).' };
    return {
      ok: true, origin, publicUrl: data.publicUrl || null,
      insecure: origin.startsWith('http:') && !isLocalHost(host),
    };
  } catch (e) {
    const ce = lastCertErrors.get(host);
    if (ce) {
      return {
        ok: false, origin, error: 'Сертификат сервера не прошёл проверку.',
        cert: { host, fingerprint: ce.fingerprint, issuer: ce.issuer, subject: ce.subject, error: ce.error },
      };
    }
    return { ok: false, origin, error: e?.name === 'AbortError' ? 'Сервер не ответил за 10 секунд.' : `Не удалось подключиться: ${e?.message || e}` };
  } finally {
    clearTimeout(timer);
  }
}

function applyServer(origin) {
  const prev = serverOrigin();
  const needRelaunch = origin.startsWith('http:') && !isLocalHost(new URL(origin).hostname) && origin !== prev;
  config.serverUrl = origin;
  saveConfig(true);
  if (needRelaunch || cliServer) {
    // флаг insecure-origin задаётся только при старте процесса
    app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith('--server=')) });
    quitting = true;
    app.exit(0);
    return;
  }
  if (!mainWindow) { createMainWindow(); buildTray(); }
  else { loadServer(); showMain(); }
  checkForUpdates(false);
}

// ---------------- Бейдж / трей ----------------
function setBadge(n) {
  const count = Math.max(0, Math.min(9999, Math.floor(Number(n) || 0)));
  const grew = count > badgeCount;
  badgeCount = count;
  try {
    if (IS_WIN && mainWindow) {
      if (count > 0) {
        const name = count > 9 ? 'badge-9p' : `badge-${count}`;
        mainWindow.setOverlayIcon(nativeImage.createFromPath(path.join(ASSETS, `${name}.png`)), `Непрочитанных: ${count}`);
        if (grew && !mainWindow.isFocused()) mainWindow.flashFrame(true);
      } else {
        mainWindow.setOverlayIcon(null, '');
        mainWindow.flashFrame(false);
      }
    } else {
      app.setBadgeCount(count); // macOS dock, Linux (Unity launcher)
    }
  } catch (e) { console.warn('[badge]', e?.message || e); }
  updateTray();
}

function trayImage() {
  let name = 'tray';
  if (voiceState.inVoice && voiceState.deafened) name = 'tray-deafened';
  else if (voiceState.inVoice && voiceState.muted) name = 'tray-muted';
  else if (badgeCount > 0) name = 'tray-unread';
  return nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
}

function buildTray() {
  if (tray) return;
  try {
    tray = new Tray(trayImage());
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused() && !IS_LINUX) mainWindow.hide();
      else showMain();
    });
    tray.on('double-click', () => showMain());
    updateTray();
  } catch (e) {
    console.error('[tray]', e?.message || e);
    tray = null;
  }
}

function updateTray() {
  if (!tray) return;
  try {
    tray.setImage(trayImage());
    const status = voiceState.inVoice ? (voiceState.deafened ? ' — звук выключен' : voiceState.muted ? ' — микрофон выключен' : ' — в голосовом') : '';
    tray.setToolTip(`${DISPLAY_NAME}${status}${badgeCount ? ` · непрочитанных: ${badgeCount}` : ''}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Показать Созвон', click: () => showMain() },
      { type: 'separator' },
      { label: 'Выключить микрофон', type: 'checkbox', checked: !!voiceState.muted, click: () => { sendToPage('desktop:toggle-mute'); setTimeout(updateTray, 300); } },
      { label: 'Выключить звук', type: 'checkbox', checked: !!voiceState.deafened, click: () => { sendToPage('desktop:toggle-deafen'); setTimeout(updateTray, 300); } },
      { type: 'separator' },
      { label: 'Сервер…', click: () => openSetup() },
      { label: 'Запускать при входе в систему', type: 'checkbox', checked: !!config.autoStart, click: (mi) => setAutoStart(mi.checked) },
      { label: 'Сворачивать в трей при закрытии', type: 'checkbox', checked: !!config.closeToTray, click: (mi) => { config.closeToTray = mi.checked; saveConfig(); buildAppMenu(); } },
      ...updateTrayItems(),
      { label: 'О приложении', click: () => showAbout() },
      { type: 'separator' },
      { label: 'Выход', click: () => quit() },
    ]));
  } catch (e) { console.warn('[tray]', e?.message || e); }
}

// ---------------- Автозапуск ----------------
const LINUX_AUTOSTART = path.join(app.getPath('appData'), 'autostart', 'sozvon.desktop');
function setAutoStart(on) {
  config.autoStart = !!on;
  saveConfig();
  try {
    if (IS_LINUX) {
      const exe = process.env.APPIMAGE || process.execPath;
      if (on) {
        fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
        fs.writeFileSync(LINUX_AUTOSTART, `[Desktop Entry]\nType=Application\nName=${DISPLAY_NAME}\nExec="${exe}" --hidden\nIcon=sozvon\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
      } else {
        fs.rmSync(LINUX_AUTOSTART, { force: true });
      }
    } else if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    }
  } catch (e) { console.error('[autostart]', e?.message || e); }
  updateTray();
  buildAppMenu();
}

// ---------------- Меню, «О приложении», обновления ----------------
function showAbout() {
  const opts = {
    type: 'info',
    title: 'О приложении',
    message: `${DISPLAY_NAME} для ПК ${app.getVersion()}`,
    detail: [
      `Сервер: ${serverOrigin() || 'не выбран'}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      `${process.platform} ${process.arch}`,
      aboutUpdateLine(),
    ].join('\n'),
    buttons: updater.state.phase === 'ready' ? ['Перезапустить и обновить', 'OK'] : updateInfo ? ['Скачать обновление', 'OK'] : ['OK'],
    icon: windowIcon(),
    noLink: true,
  };
  const p = mainWindow && mainWindow.isVisible() ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
  p.then(({ response }) => {
    if (response !== 0) return;
    if (updater.state.phase === 'ready') installUpdateNow();
    else if (updateInfo) openExternal(updateInfo.url);
  }).catch(() => {});
}

function buildAppMenu() {
  const tpl = [
    {
      label: DISPLAY_NAME,
      submenu: [
        { label: 'О приложении', click: () => showAbout() },
        { label: 'Проверить обновления', click: () => checkForUpdates(true) },
        { type: 'separator' },
        { label: 'Сервер…', click: () => openSetup() },
        { label: 'Запускать при входе в систему', type: 'checkbox', checked: !!config.autoStart, click: (mi) => setAutoStart(mi.checked) },
        { label: 'Сворачивать в трей при закрытии', type: 'checkbox', checked: !!config.closeToTray, click: (mi) => { config.closeToTray = mi.checked; saveConfig(); updateTray(); } },
        { type: 'separator' },
        { label: 'Выход', accelerator: IS_MAC ? 'Cmd+Q' : 'Ctrl+Q', click: () => quit() },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' },
        { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'resetZoom', label: 'Обычный масштаб' }, { role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}
async function checkForUpdates(manual) {
  const origin = serverOrigin();
  if (!origin) return;
  if (updater.state.supported) {
    const st = await updater.check();
    if (st && st.phase !== 'error') {
      if (manual) {
        const msg = st.phase === 'ready' ? `Обновление ${st.version} загружено.`
          : st.phase === 'downloading' ? `Загружается обновление ${st.version || ''} (${st.percent}%) — установится автоматически.`
            : `У вас последняя версия (${app.getVersion()}).`;
        const r = await dialog.showMessageBox({ type: 'info', title: 'Обновления', message: msg, buttons: st.phase === 'ready' ? ['Перезапустить сейчас', 'Позже'] : ['OK'], icon: windowIcon(), noLink: true }).catch(() => ({ response: 1 }));
        if (st.phase === 'ready' && r.response === 0) installUpdateNow();
      }
      return;
    }
    // ошибка автообновления — падаем на уведомление со ссылкой на /download
  }
  try {
    const res = await session.defaultSession.fetch(`${origin}/api/app/latest`, { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    if (data?.version && cmpVer(data.version, app.getVersion()) > 0) {
      const fresh = !updateInfo || updateInfo.version !== data.version;
      updateInfo = { version: data.version, url: `${origin}/download` };
      updateTray();
      if (fresh && Notification.isSupported()) {
        const n = new Notification({ title: 'Доступно обновление Созвона', body: `Версия ${data.version}. Нажмите, чтобы скачать.`, icon: windowIcon() });
        n.on('click', () => openExternal(updateInfo.url));
        n.show();
      }
      if (manual) showAbout();
    } else if (manual) {
      dialog.showMessageBox({ type: 'info', title: 'Обновления', message: `У вас последняя версия (${app.getVersion()}).`, buttons: ['OK'], icon: windowIcon() }).catch(() => {});
    }
  } catch (e) {
    if (manual) dialog.showMessageBox({ type: 'warning', title: 'Обновления', message: 'Не удалось проверить обновления.', detail: String(e?.message || e), buttons: ['OK'] }).catch(() => {});
  }
}

// ---------------- Автообновление ----------------
let readyNotified = false;
const updater = createUpdater({ getOrigin: () => serverOrigin(), onChange: onUpdateState, log: console });

function onUpdateState(st) {
  updateTray();
  if (st.phase !== 'ready' || readyNotified) return;
  readyNotified = true;
  // Свёрнуто в трей и не в голосовом — ставим сразу и тихо возвращаемся в трей
  if (!voiceState.inVoice && !(mainWindow && mainWindow.isVisible())) {
    installUpdateNow({ backToTray: true });
    return;
  }
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `Обновление Созвона ${st.version || ''} загружено`,
      body: 'Установится при выходе из приложения. Нажмите, чтобы перезапустить сейчас.',
      icon: windowIcon(),
    });
    n.on('click', () => {
      if (voiceState.inVoice) {
        dialog.showMessageBox({ type: 'question', title: 'Обновление', message: 'Перезапустить сейчас? Вы выйдете из голосового канала на несколько секунд.', buttons: ['Перезапустить', 'Позже'], icon: windowIcon(), noLink: true })
          .then(({ response }) => { if (response === 0) installUpdateNow(); }).catch(() => {});
      } else installUpdateNow();
    });
    n.show();
  }
}

function installUpdateNow({ backToTray = false } = {}) {
  if (updater.state.phase !== 'ready') return;
  if (backToTray) config.startHiddenOnce = true;
  quitting = true;
  saveConfig(true);
  updater.installNow();
}

function updateTrayItems() {
  const st = updater.state;
  if (st.phase === 'ready') return [{ label: `Перезапустить и обновить до ${st.version}`, click: () => installUpdateNow() }];
  if (st.phase === 'downloading') return [{ label: `Загружается обновление${st.version ? ` ${st.version}` : ''}… ${st.percent}%`, enabled: false }];
  if (updateInfo && !st.supported) return [{ label: `Скачать версию ${updateInfo.version}…`, click: () => openExternal(updateInfo.url) }];
  return [{ label: 'Проверить обновления', click: () => checkForUpdates(true) }];
}

function aboutUpdateLine() {
  const st = updater.state;
  if (st.phase === 'ready') return `\nОбновление ${st.version} загружено — установится при выходе.`;
  if (st.phase === 'downloading') return `\nЗагружается обновление ${st.version || ''}: ${st.percent}%`;
  if (updateInfo) return `\nДоступна новая версия ${updateInfo.version}.`;
  return st.supported ? '\nАвтообновление включено.' : '\nАвтообновление недоступно в портативной версии.';
}

function quit() {
  quitting = true;
  app.quit();
}

// ---------------- IPC ----------------
// Мост страницы — только от главного окна и только со страницы своего сервера
function fromPage(e) {
  return !!mainWindow && e.sender === mainWindow.webContents && isOurOrigin(e.senderFrame?.url || '');
}
function fromAppWindow(e) {
  return isAppFile(e.senderFrame?.url || '');
}

function setupIpc() {
  ipcMain.on('desktop:info', (e) => {
    e.returnValue = { version: app.getVersion(), platform: process.platform, serverOrigin: serverOrigin() };
  });
  ipcMain.on('desktop:settings', (e, s) => {
    if (!fromPage(e) || !s || typeof s !== 'object') return;
    if (typeof s.pttEnabled === 'boolean') hotkeys.pttEnabled = s.pttEnabled;
    if (typeof s.pttKey === 'string') hotkeys.pttKey = s.pttKey.slice(0, 40);
    if (typeof s.toggleMute === 'string') hotkeys.toggleMute = s.toggleMute.slice(0, 60);
    if (typeof s.toggleDeafen === 'string') hotkeys.toggleDeafen = s.toggleDeafen.slice(0, 60);
    applyHotkeys();
  });
  ipcMain.on('desktop:voice-state', (e, s) => {
    if (!fromPage(e) || !s) return;
    voiceState = { inVoice: !!s.inVoice, muted: !!s.muted, deafened: !!s.deafened };
    updateTray();
  });
  ipcMain.on('desktop:badge', (e, n) => { if (fromPage(e)) setBadge(n); });
  ipcMain.on('desktop:focus', (e) => { if (fromPage(e)) showMain(); });
  ipcMain.handle('desktop:screen-sources', async (e, opts) => {
    if (!fromPage(e)) return [];
    const sources = await getSources(opts || {});
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      displayId: s.display_id || '',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
  });
  ipcMain.handle('desktop:select-source', async (e, { id, audio } = {}) => {
    if (!fromPage(e)) return false;
    if (!id) { pendingSource = null; return true; }
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.some((s) => s.id === id)) { pendingSource = null; return false; }
    pendingSource = { id, audio: !!audio, at: Date.now() };
    return true;
  });
  ipcMain.on('desktop:open-server-settings', (e) => { if (fromPage(e) || fromAppWindow(e)) openSetup(); });

  // Окно «Сервер…»
  ipcMain.handle('setup:state', (e) => {
    if (!fromAppWindow(e)) return null;
    return { serverUrl: serverOrigin() || DEFAULT_SERVER, defaultServer: DEFAULT_SERVER, firstRun: !config.serverUrl, version: app.getVersion() };
  });
  ipcMain.handle('setup:check', (e, { url, trustCert } = {}) => (fromAppWindow(e) ? checkServer(url, trustCert) : { ok: false }));
  ipcMain.handle('setup:save', async (e, { url } = {}) => {
    if (!fromAppWindow(e)) return { ok: false };
    const r = await checkServer(url, false);
    if (!r.ok) return r;
    applyServer(r.origin);
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
    return { ok: true };
  });
  ipcMain.on('setup:cancel', (e) => { if (fromAppWindow(e) && setupWindow) setupWindow.close(); });
  ipcMain.on('offline:retry', (e) => { if (fromAppWindow(e)) loadServer(); });
}

// ---------------- Старт ----------------
app.on('web-contents-created', (_e, wc) => {
  // Никаких новых окон и webview ни из какого содержимого
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  setupCertificates(session.defaultSession);
  setupPermissions(session.defaultSession);
  setupIpc();
  buildAppMenu();
  if (serverOrigin()) {
    createMainWindow();
    buildTray();
    setTimeout(() => checkForUpdates(false), 15000);
    setInterval(() => checkForUpdates(false), 2 * 3600 * 1000);
  } else {
    openSetup();
  }
  app.on('activate', () => showMain());
});

app.on('before-quit', () => { quitting = true; saveConfig(true); });
app.on('window-all-closed', () => {
  // Окно скрыто в трей — работаем дальше; иначе выходим (кроме macOS)
  if (!IS_MAC && !setupWindow) app.quit();
});
app.on('will-quit', () => {
  try { if (hook && hook.running) hook.mod.uIOhook.stop(); } catch { /* ignore */ }
});

// Smoke-тест (SOZVON_SMOKE=1): после загрузки страницы печатаем в stdout, что выдал бы обработчик демонстрации экрана
if (process.env.SOZVON_SMOKE === '1') {
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => {
      if (win !== mainWindow) return;
      handleDisplayMedia({ frame: { url: `${serverOrigin()}/` }, audioRequested: true, videoRequested: true }, (res) => {
        console.log('[smoke] display-media ->', JSON.stringify(res && res.video ? { id: res.video.id, name: res.video.name, audio: res.audio || null } : res));
      });
      console.log('[smoke] tray:', tray ? 'ok' : 'none', '| page:', win.webContents.getURL());
      // окно без фокуса — чтобы проверить глобальную рацию (в фокусе клавиши обрабатывает сама страница)
      setTimeout(() => { try { win.blur(); } catch { /* ignore */ } console.log('[smoke] focused after blur:', win.isFocused()); }, 500);
    });
  });
}
