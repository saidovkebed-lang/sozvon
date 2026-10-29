'use strict';
// Мост в страницу сервера: window.sozvonDesktop (contextIsolation + sandbox; наружу — только функции и примитивы).
// Контракт: docs/DESKTOP.md → «Мост window.sozvonDesktop». Все методы не бросают исключений.
const { contextBridge, ipcRenderer } = require('electron');

let info = {};
try { info = ipcRenderer.sendSync('desktop:info') || {}; } catch { info = {}; }

// Мост — только для страницы своего сервера (на чужих страницах окно и так не открывается)
const allowed = !!info.serverOrigin && location.origin === info.serverOrigin;

function subscribe(channel, map) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, ...args) => { try { cb(...map(args)); } catch (err) { console.error('[sozvonDesktop]', err); } };
    ipcRenderer.on(channel, handler);
    return () => { try { ipcRenderer.removeListener(channel, handler); } catch { /* ignore */ } };
  };
}

const send = (ch, payload) => { try { ipcRenderer.send(ch, payload); } catch { /* ignore */ } };
const invoke = async (ch, payload, fallback) => {
  try { return await ipcRenderer.invoke(ch, payload); } catch (err) { console.warn('[sozvonDesktop]', ch, err?.message || err); return fallback; }
};

if (allowed) {
  contextBridge.exposeInMainWorld('sozvonDesktop', Object.freeze({
    isDesktop: true,
    version: String(info.version || ''),
    platform: String(info.platform || ''),
    onPttChange: subscribe('desktop:ptt', ([pressed]) => [!!pressed]),
    onToggleMute: subscribe('desktop:toggle-mute', () => []),
    onToggleDeafen: subscribe('desktop:toggle-deafen', () => []),
    setSettings: (s) => send('desktop:settings', s && typeof s === 'object' ? {
      pttEnabled: s.pttEnabled, pttKey: s.pttKey, toggleMute: s.toggleMute, toggleDeafen: s.toggleDeafen,
    } : {}),
    setVoiceState: (s) => send('desktop:voice-state', s && typeof s === 'object' ? {
      inVoice: !!s.inVoice, muted: !!s.muted, deafened: !!s.deafened,
    } : {}),
    setBadge: (n) => send('desktop:badge', Number(n) || 0),
    focusWindow: () => send('desktop:focus'),
    getScreenSources: (opts) => invoke('desktop:screen-sources', opts && typeof opts === 'object' ? {
      types: Array.isArray(opts.types) ? opts.types.slice(0, 2).map(String) : undefined,
      thumbnailWidth: Number(opts.thumbnailWidth) || undefined,
      thumbnailHeight: Number(opts.thumbnailHeight) || undefined,
    } : {}, []),
    selectScreenSource: (id, opts) => invoke('desktop:select-source', {
      id: id == null ? null : String(id), audio: !!(opts && opts.audio), audioOnly: !!(opts && opts.audioOnly),
    }, false),
    // Свой захват экрана (Windows): помощник отдаёт кадры по http://127.0.0.1 (url с одноразовым токеном)
    nativeCapture: !!info.nativeCapture,
    startNativeCapture: (opts) => invoke('desktop:native-capture-start', opts && typeof opts === 'object' ? {
      sourceId: String(opts.sourceId || ''),
      maxWidth: Number(opts.maxWidth) || undefined,
      maxHeight: Number(opts.maxHeight) || undefined,
      fps: Number(opts.fps) || undefined,
    } : {}, { ok: false, error: 'ipc' }),
    // звук экрана без звука самого приложения (Windows 11): {ok, token, url} или {ok:false}
    startNativeAudio: () => invoke('desktop:native-audio-start', {}, { ok: false, error: 'ipc' }),
    nativeCaptureControl: (token, cmd, params) => invoke('desktop:native-capture-ctl', {
      token: String(token || ''), cmd: String(cmd || ''),
      params: params && typeof params === 'object' ? { maxWidth: Number(params.maxWidth) || undefined, maxHeight: Number(params.maxHeight) || undefined, fps: Number(params.fps) || undefined } : undefined,
    }, { ok: false }),
    onNativeCaptureEnded: subscribe('desktop:native-capture-ended', ([m]) => [{ token: String(m?.token || ''), reason: String(m?.reason || '') }]),
    openServerSettings: () => send('desktop:open-server-settings'),
    // «Слушает Spotify / …» (Windows): что играет на ПК — системные медиасессии (помощник --media)
    mediaWatch: !!info.mediaWatch,
    setMediaWatch: (on) => send('desktop:media-watch', on === true),
    onMedia: subscribe('desktop:media', ([list]) => [(Array.isArray(list) ? list : []).slice(0, 20).map((s) => ({
      app: String(s?.app || ''), title: String(s?.title || ''), artist: String(s?.artist || ''),
      album: String(s?.album || ''), albumArtist: String(s?.albumArtist || ''),
      durationMs: Number(s?.durationMs) || 0, positionMs: Number(s?.positionMs) || 0, updatedAt: Number(s?.updatedAt) || 0,
      playing: s?.playing === true, current: s?.current === true,
    }))]),
  }));
}

// Локальная страница «Нет связи» (offline.html) в главном окне
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('sozvonSetup', Object.freeze({
    retry: () => send('offline:retry'),
    openServerSettings: () => send('desktop:open-server-settings'),
  }));
}
