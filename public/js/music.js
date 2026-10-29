// Синхронизированное воспроизведение музыки бота по MusicState.
import { state, notify, musicElapsed } from './state.js';
import { lsSet } from './util.js';
import { prefs } from './prefs.js';
import { musicEq } from './audio/music-eq.js';

const DRIFT_MAX = 1.5;
const PREF_KEY = 'audio.musicVolume';     // 0..100 — единственный источник истины
const LEGACY_KEY = 'sozvon.musicVolume';  // зеркало для совместимости (старые тесты/откат версии)

class MusicSync {
  constructor() {
    this.audio = null;
    this.blocked = false;
    this.currentUrl = null;
    this.timer = null;
    this.seekSeq = new Map(); // channelId -> последний seekSeq (перемотка: прыгаем сразу, а не через DRIFT_MAX)
    this.seekPending = false;
  }

  init() {
    this.audio = document.getElementById('music-audio');
    // эквалайзер: граф WebAudio строится только когда он включён и не «Ровно» (audio/music-eq.js)
    musicEq.onBlocked = () => { if (!this.blocked) { this.blocked = true; notify('music'); } };
    musicEq.init(this.audio);
    this.applyVolume(prefs.get(PREF_KEY));
    prefs.subscribe(PREF_KEY, (_k, v) => { this.applyVolume(v); notify('music'); });
    this.audio.addEventListener('error', () => {
      if (this.audio.getAttribute('src')) console.warn('[music] не удалось загрузить трек', this.audio.src);
    });
    this.audio.addEventListener('loadedmetadata', () => this.sync(true));
    this.timer = setInterval(() => this.sync(false), 2000);
  }

  applyVolume(v) {
    const n = Number(v);
    this.volume = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 70;
    // при активном эквалайзере громкость — узел графа, а элемент всегда на 100 %
    if (this.audio) this.audio.volume = musicEq.active ? 1 : this.volume / 100;
    musicEq.setVolume(this.volume / 100);
  }

  /** Слайдер #music-volume / контекстное меню бота → prefs */
  setVolume(v) {
    this.applyVolume(v);
    prefs.set(PREF_KEY, this.volume);
    lsSet(LEGACY_KEY, this.volume);
  }

  /** Вызвать в обработчике пользовательского жеста */
  unlock() {
    if (!this.audio) return;
    musicEq.kick();
    if (this.blocked) {
      this.blocked = false;
      notify('music');
    }
    if (this.currentState()?.track?.url && this.audio.paused) this.sync(true);
  }

  /** Принять MusicState от сервера */
  setState(ms) {
    if (!ms || !ms.channelId) return;
    ms._skew = typeof ms.serverNow === 'number' ? ms.serverNow - Date.now() : 0;
    const seq = Number(ms.seekSeq) || 0;
    if (this.seekSeq.has(ms.channelId) && this.seekSeq.get(ms.channelId) !== seq) {
      if (state.myVoice?.channelId === ms.channelId) this.seekPending = true;
    }
    this.seekSeq.set(ms.channelId, seq);
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
    // «ожидающий» элемент очереди (pending, без url) — не аудио, играть нечего
    if (!ms || !ms.track || !ms.track.url || ms.track.pending) {
      if (this.currentUrl) {
        a.pause();
        a.removeAttribute('src');
        a.load();
        this.currentUrl = null;
      }
      return;
    }
    a.muted = !!state.deafened;
    musicEq.setMuted(!!state.deafened);
    const elapsed = musicElapsed(ms);
    if (this.currentUrl !== ms.track.url) {
      this.currentUrl = ms.track.url;
      a.src = ms.track.url;
      try { a.currentTime = elapsed; } catch { /* до loadedmetadata */ }
      force = true;
    }
    if (ms.paused) {
      if (!a.paused) a.pause();
      if (a.readyState >= 1) this.seekPending = false;
      if (force && a.readyState >= 1 && Math.abs(a.currentTime - elapsed) > 0.25) {
        try { a.currentTime = elapsed; } catch { /* ignore */ }
      }
      return;
    }
    const dur = ms.track.duration || a.duration || Infinity;
    if (elapsed >= dur) { if (!a.paused) a.pause(); return; }
    const maxDrift = this.seekPending ? 0.25 : DRIFT_MAX;
    if (a.readyState >= 1) this.seekPending = false;
    if (a.readyState >= 1 && Math.abs(a.currentTime - elapsed) > maxDrift) {
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
    musicEq.kick();
    const a = this.audio;
    const ms = this.currentState();
    if (!a || !ms?.track?.url) return;
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
