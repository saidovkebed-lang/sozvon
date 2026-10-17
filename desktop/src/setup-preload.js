'use strict';
// Мост для локальных окон приложения (setup.html — «Сервер…», offline.html — нет связи).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sozvonSetup', Object.freeze({
  getState: () => ipcRenderer.invoke('setup:state'),
  check: (url, trustCert) => ipcRenderer.invoke('setup:check', { url: String(url || ''), trustCert: !!trustCert }),
  save: (url) => ipcRenderer.invoke('setup:save', { url: String(url || '') }),
  cancel: () => ipcRenderer.send('setup:cancel'),
  retry: () => ipcRenderer.send('offline:retry'),
  openServerSettings: () => ipcRenderer.send('desktop:open-server-settings'),
}));
