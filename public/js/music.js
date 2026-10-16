// Синхронизированное воспроизведение музыки бота по MusicState.
import { state, notify, musicElapsed } from './state.js';
import { lsGet, lsSet } from './util.js';

const DRIFT_MAX = 1.5;
const VOL_KEY = 'sozvon.musicVolume';

class MusicSync {
  constructor() {
    this.audio = null;
    this.blocked = false;
    this.currentUrl = null;
    this.timer = null;
  }

  init() {
    this.audio = document.getElementById('music-audio');
    const v = Number(lsGet(VOL_KEY, '50'));
    this.volume = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50;
    this.audio.volume = this.volume / 100;
    this.audio.addEventListener('error', () => {
      if (this.audio.getAttribute('src')) console.warn('[music] не удалось загрузить трек', this.audio.src);
    });
    this.audio.addEventListener('loadedmetadata', () => this.sync(true));
    this.timer = setInterval(() => this.sync(false), 2000);
  }

  setVolume(v) {
    this.volume = Math.min(100, Math.max(0, Number(v) || 0));
    lsSet(VOL_KEY, this.volume);
    if (this.audio) this.audio.volume = this.volume / 100;
  }

  /** Вызвать в обработчике пользовательского жеста */
  unlock() {
    if (!this.audio) return;
    if (this.blocked) {
      this.blocked = false;
      notify('music');
    }
    if (this.currentState()?.track && this.audio.paused) this.sync(true);
  }

  /** Принять MusicState от сервера */
  setState(ms) {
    if (!ms || !ms.channelId) return;
    ms._skew = typeof ms.serverNow === 'number' ? ms.serverNow - Date.now() : 0;
    state.music[ms.channelId] = ms;
    if (state.myVoice?.channelId === ms.channelId) this.sync(true);
    notify('music');
  }

  currentState() {
    const ch = state.myVoice?.channelId;
    return ch ? state.music[ch] || null : null;
  }

  refresh() { this.sync(true); }

  sync(force) {
    const a = this.audio;
    if (!a) return;
    const ms = this.currentState();
    if (!ms || !ms.track) {
      if (this.currentUrl) {
        a.pause();
        a.removeAttribute('src');
        a.load();
        this.currentUrl = null;
      }
      return;
    }
    a.muted = !!state.deafened;
    const elapsed = musicElapsed(ms);
    if (this.currentUrl !== ms.track.url) {
      this.currentUrl = ms.track.url;
      a.src = ms.track.url;
      try { a.currentTime = elapsed; } catch { /* до loadedmetadata */ }
      force = true;
    }
    if (ms.paused) {
      if (!a.paused) a.pause();
      if (force && a.readyState >= 1 && Math.abs(a.currentTime - elapsed) > 0.25) {
        try { a.currentTime = elapsed; } catch { /* ignore */ }
      }
      return;
    }
    const dur = ms.track.duration || a.duration || Infinity;
    if (elapsed >= dur) { if (!a.paused) a.pause(); return; }
    if (a.readyState >= 1 && Math.abs(a.currentTime - elapsed) > DRIFT_MAX) {
      try { a.currentTime = elapsed; } catch { /* ignore */ }
    }
    if (a.paused && !this.blocked) {
      a.play().then(() => {
        if (this.blocked) { this.blocked = false; notify('music'); }
      }).catch((e) => {
        if (e?.name === 'NotAllowedError') {
          this.blocked = true;
          notify('music');
        }
      });
    }
  }

  /** Кнопка «▶ Включить звук» */
  async forcePlay() {
    this.blocked = false;
    const a = this.audio;
    const ms = this.currentState();
    if (!a || !ms?.track) return;
    try {
      if (a.readyState >= 1) a.currentTime = musicElapsed(ms);
      await a.play();
    } catch (e) {
      if (e?.name === 'NotAllowedError') this.blocked = true;
    }
    notify('music');
  }
}

export const music = new MusicSync();
