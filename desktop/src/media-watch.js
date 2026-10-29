'use strict';
// «Слушает Spotify / Яндекс Музыка / …»: помощник sozvon-capture.exe --media читает системные медиасессии Windows
// (то же, что регулятор громкости Windows 10/11 показывает над ползунком) и печатает строку JSON на каждое изменение.
// Здесь — только запуск/перезапуск помощника и очистка данных; что из этого показывать — решает страница
// (public/js/now-playing.js, правила источников — public/js/media-sources.js). Протокол — desktop/native/capture/capture.cpp («Медиа»).
const { spawn } = require('node:child_process');

const MAX_SESSIONS = 20;
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(v, 8.64e15) : 0);

/** Строка помощника → [{app, title, artist, album, albumArtist, durationMs, positionMs, updatedAt, playing, current}] | null */
function parseMediaLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (!m || m.t !== 'media' || !Array.isArray(m.sessions)) return null;
  return m.sessions.slice(0, MAX_SESSIONS).filter((s) => s && typeof s === 'object').map((s) => ({
    app: str(s.app), title: str(s.title), artist: str(s.artist), album: str(s.album), albumArtist: str(s.albumArtist),
    durationMs: num(s.durationMs), positionMs: num(s.positionMs), updatedAt: num(s.updatedAt),
    playing: s.playing === true, current: s.current === true,
  }));
}

/**
 * createMediaWatch({ helperCommand, onMedia(sessions), onUnavailable(), log }) → { start(), stop(), running, last }
 * Упал — перезапуск с растущей паузой (1, 2, 4 … 60 с); код 4 («медиасессии недоступны») три раза подряд — сдаёмся.
 */
function createMediaWatch({ helperCommand, onMedia, onUnavailable = () => {}, log = console.log }) {
  let proc = null;
  let wanted = false;
  let fails = 0;
  let unavailable = 0;
  let timer = null;
  let last = [];

  function emit(sessions) {
    last = sessions;
    try { onMedia(sessions); } catch (e) { log(`[media] ${e?.message || e}`); }
  }

  function launch() {
    const hc = helperCommand();
    if (!hc) { wanted = false; onUnavailable(new Error('помощник не найден')); return; }
    const p = spawn(hc.cmd, [...hc.pre, '--media'], { env: hc.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (s) => {
      buf += s;
      if (buf.length > 1 << 20) buf = ''; // мусор без переводов строк
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'READY') { fails = 0; unavailable = 0; log('[media] медиасессии Windows: слежу'); continue; }
        const sessions = parseMediaLine(line);
        if (sessions) emit(sessions);
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (s) => { for (const l of s.split('\n')) if (l.trim()) log(l.trim()); });
    p.stdin.on('error', () => { /* вышел */ });
    p.on('error', (e) => log(`[media] помощник: ${e.message}`));
    p.on('exit', (code) => {
      if (proc !== p) return;
      proc = null;
      if (last.length) emit([]); // что играло — неизвестно
      if (!wanted) return;
      if (code === 4 && ++unavailable >= 3) { log('[media] медиасессии недоступны на этой системе'); wanted = false; onUnavailable(new Error('код 4')); return; }
      fails++;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(fails - 1, 6));
      log(`[media] помощник завершился (код ${code}) — перезапуск через ${Math.round(delay / 1000)} с`);
      timer = setTimeout(() => { timer = null; if (wanted && !proc) launch(); }, delay);
    });
  }

  return {
    start() {
      wanted = true;
      if (!proc && !timer) launch();
    },
    stop() {
      wanted = false;
      clearTimeout(timer);
      timer = null;
      fails = 0;
      const p = proc;
      proc = null;
      last = [];
      if (!p) return;
      try { p.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { if (p.exitCode === null) p.kill(); } catch { /* ignore */ } }, 1500);
    },
    get running() { return wanted; },
    get last() { return last; },
  };
}

module.exports = { createMediaWatch, parseMediaLine };
