// Горячие клавиши mute/deafen по сочетаниям из prefs (keybinds.*). Формат: 'Ctrl+Shift+M'.
// Не срабатывают при вводе текста и во время захвата сочетания в настройках.
import { prefs } from '../prefs.js';
import { toggleMute, toggleDeafen } from '../voice/voice.js';

const MOD_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);

const CODE_NAMES = {
  Space: 'Пробел', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', CapsLock: 'CapsLock',
  ControlLeft: 'Ctrl', ControlRight: 'Правый Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Правый Shift',
  AltLeft: 'Alt', AltRight: 'Правый Alt', MetaLeft: 'Meta', MetaRight: 'Правый Meta',
  NumpadEnter: 'Num Enter', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
};

/** Человекочитаемое имя клавиши по KeyboardEvent.code */
export function codeLabel(code) {
  if (!code) return '';
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit(\d)$/.exec(code); if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code); if (m) return `Num ${m[1]}`;
  return code;
}

/** Сочетание из события: 'Ctrl+Shift+M'. null — если нажат только модификатор. */
export function comboFromEvent(e) {
  if (MOD_CODES.has(e.code) || !e.code) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(codeLabel(e.code));
  return parts.join('+');
}

export function isModifierCode(code) { return MOD_CODES.has(code); }

/** Поле ввода в фокусе — горячие клавиши не перехватываем */
export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(t);
  }
  return false;
}

let capturing = false;
/** Настройки ставят флаг на время «нажмите клавишу…» */
export function setCapturing(v) { capturing = !!v; }

function onKeydown(e) {
  if (capturing || e.repeat || e.defaultPrevented) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  const combo = comboFromEvent(e);
  if (!combo) return;
  const norm = (s) => String(s || '').toLowerCase();
  if (norm(combo) === norm(prefs.get('keybinds.toggleMute'))) {
    e.preventDefault();
    toggleMute();
  } else if (norm(combo) === norm(prefs.get('keybinds.toggleDeafen'))) {
    e.preventDefault();
    toggleDeafen();
  }
}

export function initKeybinds() {
  window.addEventListener('keydown', onKeydown);
}
