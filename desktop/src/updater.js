'use strict';
// Автообновление «Созвона для ПК» с СВОЕГО сервера (electron-updater, generic-провайдер).
// Цепочка: релиз на GitHub → сервер раз в час кладёт его в /media/downloads (deploy/app-release.sh)
// → приложение проверяет <сервер>/media/downloads/latest.yml, качает новую версию в фоне
// (по .blockmap — только изменившиеся части) и ставит её при выходе или по кнопке «Перезапустить».
// Работает для установленной версии Windows (NSIS) и AppImage на Linux; портативный zip —
// только уведомление со ссылкой на /download.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }

/** Можно ли обновляться автоматически в этой установке */
function supported() {
  if (!autoUpdater || !app.isPackaged) return false;
  if (process.platform === 'win32') {
    // NSIS-установка кладёт рядом деинсталлятор; у портативного zip его нет
    try {
      return fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .+\.exe$/i.test(f));
    } catch { return false; }
  }
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}

/**
 * state.phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
 * onChange(state) — после каждого изменения (трей, уведомления, «О приложении»).
 */
function createUpdater({ getOrigin, onChange, log = console }) {
  const state = { phase: 'idle', version: null, percent: 0, error: null, supported: supported() };
  const set = (patch) => { Object.assign(state, patch); try { onChange?.(state); } catch (e) { log.warn('[updater]', e); } };
  let feed = null;
  let wired = false;

  function wire() {
    if (wired || !autoUpdater) return;
    wired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = { info() {}, debug() {}, warn: (m) => log.warn('[updater]', m), error: (m) => log.error('[updater]', m) };
    autoUpdater.on('checking-for-update', () => { if (state.phase !== 'ready' && state.phase !== 'downloading') set({ phase: 'checking', error: null }); });
    autoUpdater.on('update-available', (info) => set({ phase: 'downloading', version: info?.version || null, percent: 0, error: null }));
    autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p?.percent || 0) }));
    autoUpdater.on('update-not-available', () => { if (state.phase !== 'ready') set({ phase: 'idle', error: null }); });
    autoUpdater.on('update-downloaded', (info) => set({ phase: 'ready', version: info?.version || state.version, percent: 100, error: null }));
    autoUpdater.on('error', (err) => { if (state.phase !== 'ready') set({ phase: 'error', error: String(err?.message || err) }); });
  }

  /** Проверить обновления. Возвращает state после проверки (или null, если авто недоступно). */
  async function check() {
    if (!state.supported) return null;
    const origin = getOrigin();
    if (!origin) return null;
    wire();
    const url = `${origin}/media/downloads/`;
    if (feed !== url) {
      // Express/nginx отдают одиночные диапазоны — так blockmap-загрузка надёжнее
      autoUpdater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false });
      feed = url;
    }
    if (state.phase === 'ready' || state.phase === 'downloading') return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      set({ phase: 'error', error: String(e?.message || e) });
    }
    return state;
  }

  /** Закрыть приложение и поставить скачанное обновление (тихо), затем запустить снова */
  function installNow() {
    if (state.phase !== 'ready' || !autoUpdater) return false;
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }

  return { state, check, installNow };
}

module.exports = { createUpdater, supported };
