// Пользовательские настройки (хранятся в браузере, localStorage `sozvon.prefs`).
// Единый источник истины для экрана настроек (ui/settings*.js) и звукового движка (voice/**, audio/**).
//
//   import { prefs } from './prefs.js';
//   prefs.get('audio.inputVolume')            → 100
//   prefs.set('audio.inputVolume', 150)
//   const off = prefs.subscribe('audio.', (key, value) => …)   // по префиксу или точному ключу
//   prefs.getUserVolume(userId) / prefs.setUserVolume(userId, 0..200)

export const DEFAULTS = Object.freeze({
  // --- Голос и видео ---
  'audio.inputDeviceId': 'default',
  'audio.outputDeviceId': 'default',
  'audio.inputVolume': 100,          // 0..200 %
  'audio.outputVolume': 100,         // 0..200 % — общая громкость собеседников
  'audio.noiseSuppression': 'rnnoise', // 'rnnoise' (ИИ) | 'standard' (браузер) | 'off'
  'audio.echoCancellation': true,
  'audio.autoGain': true,
  'audio.inputMode': 'voice',        // 'voice' (по голосу) | 'ptt' (рация)
  'audio.sensitivityAuto': true,
  'audio.sensitivityDb': -50,        // порог шумового гейта, -100..0 dBFS (при sensitivityAuto=false)
  'audio.pttKey': 'KeyV',            // KeyboardEvent.code
  'audio.pttReleaseDelay': 200,      // мс
  'audio.userVolumes': {},           // { [userId]: 0..200 }
  'audio.userMuted': {},             // { [userId]: true } — локально заглушён
  'audio.streamVolumes': {},         // { [userId]: 0..200 } — громкость звука трансляции этого стримера (отдельно от голоса)
  'audio.musicVolume': 70,           // 0..100 — громкость бота
  'watch.volume': 80,                // 0..100 — громкость «Смотреть вместе» (только у себя)

  // --- Внешний вид ---
  'appearance.theme': 'dark',        // 'dark' | 'light' | 'amoled'
  'appearance.fontScale': 100,       // 80..130 %
  'appearance.compact': false,       // компактные сообщения
  'appearance.reduceMotion': 'system', // 'system' | 'on' | 'off'
  'appearance.animatedBg': true,     // «Анимированный фон» — живое звёздное небо (Astra 2.0)

  // --- Уведомления ---
  'notifications.sounds': true,          // общий выключатель звуков
  'notifications.soundJoinLeave': true,  // вход/выход в голосовом
  'notifications.soundMessage': true,    // новое сообщение не в текущем канале
  'notifications.soundMute': true,       // щелчки mute/deafen
  'notifications.desktop': false,        // системные уведомления браузера
  'notifications.mentionsOnly': false,   // системные — только при упоминании @ника
  'notifications.push': false,           // push на этом устройстве (личные сообщения и упоминания, даже когда Astra закрыта)

  // --- Демонстрация экрана (v3) ---
  'stream.quality': '720p30',        // '720p30' | '1080p60' | 'source'
  'stream.audio': true,              // передавать звук экрана
  'stream.autoWatch': false,         // сразу смотреть чужие трансляции (иначе — по кнопке «Смотреть»)
  'stream.selfPreview': false,       // показывать себе превью своего экрана (тратит процессор)

  // --- Горячие клавиши (строка вида 'Ctrl+Shift+M'; '' = не назначено) ---
  'keybinds.toggleMute': 'Ctrl+Shift+M',
  'keybinds.toggleDeafen': 'Ctrl+Shift+D',
});

const STORAGE_KEY = 'sozvon.prefs';
const listeners = new Set();
let values = load();

function load() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { saved = {}; }
  // миграция старого ключа громкости музыки
  try {
    const old = localStorage.getItem('sozvon.musicVolume');
    if (old != null && saved['audio.musicVolume'] == null) {
      const v = Number(old);
      if (Number.isFinite(v)) saved['audio.musicVolume'] = v <= 1 ? Math.round(v * 100) : Math.round(v);
    }
  } catch { /* ignore */ }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = k in saved ? saved[k] : clone(DEFAULTS[k]);
  return out;
}

function clone(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)); } catch { /* приватный режим и т.п. */ }
}

function emit(key, value) {
  for (const { match, fn } of listeners) {
    if (key === match || (match.endsWith('.') && key.startsWith(match)) || match === '*') {
      try { fn(key, value); } catch (e) { console.error('[prefs]', e); }
    }
  }
}

export const prefs = {
  get(key) {
    if (!(key in DEFAULTS)) throw new Error(`Неизвестная настройка: ${key}`);
    return clone(values[key]);
  },
  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Неизвестная настройка: ${key}`);
    if (JSON.stringify(values[key]) === JSON.stringify(value)) return;
    values[key] = clone(value);
    persist();
    emit(key, clone(value));
  },
  /** match: точный ключ, префикс с точкой ('audio.') или '*'. Возвращает функцию отписки. */
  subscribe(match, fn) {
    const entry = { match, fn };
    listeners.add(entry);
    return () => listeners.delete(entry);
  },
  all() { return clone(values); },
  /** Сбросить раздел ('audio.' / 'appearance.' / …) или всё (без аргумента). */
  reset(prefix = '') {
    for (const k of Object.keys(DEFAULTS)) {
      if (k.startsWith(prefix)) this.set(k, clone(DEFAULTS[k]));
    }
  },

  getUserVolume(userId) {
    const v = values['audio.userVolumes'][userId];
    return Number.isFinite(v) ? v : 100;
  },
  setUserVolume(userId, volume) {
    const map = { ...values['audio.userVolumes'] };
    const v = Math.max(0, Math.min(200, Math.round(volume)));
    if (v === 100) delete map[userId]; else map[userId] = v;
    this.set('audio.userVolumes', map);
  },
  getStreamVolume(userId) {
    const v = values['audio.streamVolumes']?.[userId];
    return Number.isFinite(v) ? v : 100;
  },
  setStreamVolume(userId, volume) {
    const map = { ...values['audio.streamVolumes'] };
    const v = Math.max(0, Math.min(200, Math.round(volume)));
    if (v === 100) delete map[userId]; else map[userId] = v;
    this.set('audio.streamVolumes', map);
  },
  isUserMuted(userId) { return !!values['audio.userMuted'][userId]; },
  setUserMuted(userId, muted) {
    const map = { ...values['audio.userMuted'] };
    if (muted) map[userId] = true; else delete map[userId];
    this.set('audio.userMuted', map);
  },
};

// Синхронизация между вкладками
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = load();
    for (const k of Object.keys(DEFAULTS)) {
      if (JSON.stringify(next[k]) !== JSON.stringify(values[k])) { values[k] = next[k]; emit(k, clone(next[k])); }
    }
  });
} catch { /* не браузер */ }
