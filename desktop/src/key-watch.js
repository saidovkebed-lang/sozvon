'use strict';
// Клавиша рации на Windows БЕЗ перехватчиков ввода: помощник sozvon-capture.exe --keys слушает клавиатуру через
// Raw Input (RIDEV_INPUTSINK), как Discord. Перехватчик uiohook (WH_KEYBOARD_LL + WH_MOUSE_LL) пропускал через
// приложение каждое движение мыши — в соревновательных играх (Valorant, CS2…) с мышью 1000 Гц и античитом ядра
// это приводило к намертво зависшей игре. Протокол — desktop/native/capture/capture.cpp («Клавиши»).
const { spawn } = require('node:child_process');

/**
 * createKeyWatch({ helperCommand, onDown(vk), onUp(vk), log }) → { start(vks), setKeys(vks), stop(), running }
 * Если помощник упал — перезапуск с паузой (не чаще 5 раз подряд), затем onFail().
 */
function createKeyWatch({ helperCommand, onDown, onUp, onFail = () => {}, log = console.log }) {
  let proc = null;
  let keys = [];
  let wanted = false;
  let fails = 0;
  let timer = null;

  function launch() {
    const hc = helperCommand();
    if (!hc) { onFail(new Error('помощник не найден')); return; }
    const p = spawn(hc.cmd, [...hc.pre, '--keys', '--watch', keys.join(',')], { env: hc.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (s) => {
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'READY') { fails = 0; log('[hotkeys] клавиша рации: Raw Input (без перехвата ввода)'); continue; }
        const m = /^([du]) (\d+)$/.exec(line);
        if (m) (m[1] === 'd' ? onDown : onUp)(Number(m[2]));
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (s) => { for (const l of s.split('\n')) if (l.trim()) log(l.trim()); });
    p.stdin.on('error', () => { /* вышел */ });
    p.on('error', (e) => log(`[hotkeys] помощник клавиш: ${e.message}`));
    p.on('exit', (code) => {
      if (proc !== p) return;
      proc = null;
      if (!wanted) return;
      fails++;
      if (fails > 5) { log(`[hotkeys] помощник клавиш падает (код ${code}) — запасной способ`); wanted = false; onFail(new Error(`код ${code}`)); return; }
      timer = setTimeout(() => { timer = null; if (wanted && !proc) launch(); }, 1000 * fails);
    });
  }

  return {
    start(vks) {
      keys = [...new Set(vks)];
      wanted = true;
      if (proc) { this.setKeys(keys); return; }
      if (!timer) launch();
    },
    setKeys(vks) {
      keys = [...new Set(vks)];
      try { proc?.stdin.write(`watch ${keys.join(',')}\n`); } catch { /* ignore */ }
    },
    stop() {
      wanted = false;
      clearTimeout(timer);
      timer = null;
      const p = proc;
      proc = null;
      if (!p) return;
      try { p.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { if (p.exitCode === null) p.kill(); } catch { /* ignore */ } }, 1500);
    },
    get running() { return wanted; },
  };
}

module.exports = { createKeyWatch };
