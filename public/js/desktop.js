// Мост приложения для ПК (SPEC-v3 §4, desktop/preload): window.sozvonDesktop.
// Глобальная рация и mute/deafen (когда окно не в фокусе), настройки клавиш, состояние голоса для трея,
// бейдж непрочитанных. В браузере модуль ничего не делает.
import { state, subscribe } from './state.js';
import { prefs } from './prefs.js';

export const desktop = () => (window.sozvonDesktop?.isDesktop ? window.sozvonDesktop : null);
export const isDesktop = () => !!desktop();

let unread = 0;

function call(name, ...args) {
  try { return window.sozvonDesktop?.[name]?.(...args); } catch (e) { console.warn('[desktop]', name, e); return undefined; }
}

function pushSettings() {
  call('setSettings', {
    pttEnabled: prefs.get('audio.inputMode') === 'ptt',
    pttKey: prefs.get('audio.pttKey'),
    toggleMute: prefs.get('keybinds.toggleMute'),
    toggleDeafen: prefs.get('keybinds.toggleDeafen'),
  });
}

function pushVoice() {
  call('setVoiceState', { inVoice: !!state.myVoice, muted: !!(state.muted || state.deafened), deafened: !!state.deafened });
}

/** Новое сообщение не в фокусе → +1 к бейджу (вызывает notifications.js) */
export function bumpUnread() {
  if (!isDesktop()) return;
  if (document.hasFocus() && document.visibilityState === 'visible') return;
  unread += 1;
  call('setBadge', unread);
}

function clearUnread() {
  if (!unread) return;
  unread = 0;
  call('setBadge', 0);
}

export function focusApp() {
  call('focusWindow');
  try { window.focus(); } catch { /* ignore */ }
}

/** Подключить мост; voice — { toggleMute, toggleDeafen, setPttPressed } */
export function initDesktop({ toggleMute, toggleDeafen, setPttPressed }) {
  const d = desktop();
  if (!d) return;
  document.documentElement.classList.add('is-desktop');
  document.documentElement.dataset.platform = d.platform || '';
  try {
    d.onPttChange?.((pressed) => setPttPressed?.(!!pressed));
    d.onToggleMute?.(() => toggleMute());
    d.onToggleDeafen?.(() => toggleDeafen());
  } catch (e) { console.warn('[desktop] подписки', e); }
  pushSettings();
  for (const k of ['audio.inputMode', 'audio.pttKey', 'keybinds.toggleMute', 'keybinds.toggleDeafen']) prefs.subscribe(k, pushSettings);
  subscribe(['me', 'voice'], pushVoice);
  window.addEventListener('focus', clearUnread);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.hasFocus()) clearUnread(); });
}
