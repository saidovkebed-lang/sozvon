'use strict';
// KeyboardEvent.code (как хранит страница в prefs 'audio.pttKey') → keycode(ы) uiohook-napi.
// И разбор сочетаний вида 'Ctrl+Shift+M' (формат public/js/ui/keybinds.js: последний элемент — codeLabel()).

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** UiohookKey (из uiohook-napi) → { [KeyboardEvent.code]: number[] } */
function buildCodeMap(K) {
  const m = {};
  const add = (code, ...names) => {
    const vals = names.map((n) => K[n]).filter((v) => typeof v === 'number');
    if (vals.length) m[code] = vals;
  };
  for (const L of LETTERS) add(`Key${L}`, L);
  for (let d = 0; d <= 9; d++) add(`Digit${d}`, String(d));
  for (let f = 1; f <= 24; f++) add(`F${f}`, `F${f}`);
  // Цифровой блок: при выключенном NumLock uiohook отдаёт «навигационные» коды
  const numAlt = { 0: 'NumpadInsert', 1: 'NumpadEnd', 2: 'NumpadArrowDown', 3: 'NumpadPageDown', 4: 'NumpadArrowLeft',
    6: 'NumpadArrowRight', 7: 'NumpadHome', 8: 'NumpadArrowUp', 9: 'NumpadPageUp' };
  for (let d = 0; d <= 9; d++) add(`Numpad${d}`, `Numpad${d}`, ...(numAlt[d] ? [numAlt[d]] : []));
  add('NumpadDecimal', 'NumpadDecimal', 'NumpadDelete');
  for (const n of ['NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDivide', 'NumpadEnter']) add(n, n);
  for (const n of ['Backspace', 'Tab', 'Enter', 'CapsLock', 'Escape', 'Space', 'PageUp', 'PageDown', 'End', 'Home',
    'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete', 'Semicolon', 'Equal', 'Comma', 'Minus',
    'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote', 'NumLock', 'ScrollLock', 'PrintScreen']) add(n, n);
  add('ControlLeft', 'Ctrl'); add('ControlRight', 'CtrlRight');
  add('ShiftLeft', 'Shift'); add('ShiftRight', 'ShiftRight');
  add('AltLeft', 'Alt'); add('AltRight', 'AltRight');
  add('MetaLeft', 'Meta'); add('MetaRight', 'MetaRight');
  add('OSLeft', 'Meta'); add('OSRight', 'MetaRight');
  add('IntlBackslash', 'Backslash');
  return m;
}

// Обратное к codeLabel() из keybinds.js
const LABEL_TO_CODE = {
  'пробел': 'Space', enter: 'Enter', esc: 'Escape', backspace: 'Backspace', tab: 'Tab',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', capslock: 'CapsLock',
  'num enter': 'NumpadEnter', insert: 'Insert', delete: 'Delete', home: 'Home', end: 'End', pgup: 'PageUp', pgdn: 'PageDown',
  space: 'Space', escape: 'Escape', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};

function labelToCode(label) {
  const s = String(label || '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (LABEL_TO_CODE[low]) return LABEL_TO_CODE[low];
  if (/^[a-z]$/i.test(s)) return `Key${s.toUpperCase()}`;
  if (/^\d$/.test(s)) return `Digit${s}`;
  let m = /^num\s*(.+)$/i.exec(s);
  if (m) {
    const rest = m[1];
    if (/^\d$/.test(rest)) return `Numpad${rest}`;
    return `Numpad${rest[0].toUpperCase()}${rest.slice(1)}`;
  }
  m = /^f(\d{1,2})$/i.exec(s);
  if (m) return `F${m[1]}`;
  if (/^(Key|Digit|Numpad|Arrow)/.test(s) || /^[A-Z][A-Za-z]+$/.test(s)) return s; // уже code
  return null;
}

/**
 * 'Ctrl+Shift+M' → { ctrl, alt, shift, meta, code: 'KeyM' } | null.
 * '+' как клавиша не поддерживается (страница его и не выдаёт — там 'Equal' → '=').
 */
function parseCombo(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = { ctrl: false, alt: false, shift: false, meta: false, code: null };
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i].toLowerCase();
    if (p === 'ctrl' || p === 'control') out.ctrl = true;
    else if (p === 'alt' || p === 'option') out.alt = true;
    else if (p === 'shift') out.shift = true;
    else if (p === 'meta' || p === 'cmd' || p === 'win' || p === 'super') out.meta = true;
    else return null;
  }
  out.code = labelToCode(parts[parts.length - 1]);
  return out.code ? out : null;
}

/** KeyboardEvent.code → клавиша для Electron accelerator (globalShortcut). null — не поддерживается. */
function codeToAccelKey(code) {
  if (!code) return null;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return `F${m[1]}`;
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  const map = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    Pause: 'MediaPlayPause', ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen',
  };
  return map[code] || null;
}

/** Строка сочетания ('Ctrl+Shift+M') → accelerator ('Control+Shift+M') или null */
function comboToAccelerator(str) {
  const c = parseCombo(str);
  if (!c) return null;
  const key = codeToAccelKey(c.code);
  if (!key) return null;
  const mods = [];
  if (c.ctrl) mods.push('Control');
  if (c.alt) mods.push('Alt');
  if (c.shift) mods.push('Shift');
  if (c.meta) mods.push('Super');
  return [...mods, key].join('+');
}

module.exports = { buildCodeMap, parseCombo, labelToCode, codeToAccelKey, comboToAccelerator };
