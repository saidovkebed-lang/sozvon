// Astra 2.0: «живой» фон — звёзды и туманность за оболочкой приложения.
// Сам фон — чистый CSS (body::before / body::after в css/astra2.css, анимации только transform/opacity,
// их считает компоновщик, а не JS). Здесь только решаем, можно ли ему двигаться:
//   <html data-cosmos="live">  — анимация идёт;
//   <html data-cosmos="still"> — пауза (кадр замирает, ноль работы), причина — в data-cosmos-why.
// Пауза, если: вкладка скрыта / окно свёрнуто или не в фокусе, выключена настройка «Анимированный фон»,
// включено «уменьшение движения», идёт трансляция/камера или играет любое видео, вы в голосовом канале
// (чтобы не мешать стримам и играм в Electron), светлая тема (звёзд не видно).
import { prefs } from '../prefs.js';
import { state, subscribe } from '../state.js';
import { motionReduced } from '../util.js';

let started = false;
let raf = 0;

function mediaBusy() {
  if (document.fullscreenElement) return true;
  if (state.streaming || state.camera) return true;
  const ch = state.myVoice?.channelId;
  if (ch && (state.voice[ch] || []).some((m) => m.streaming || m.camera)) return true;
  for (const v of document.getElementsByTagName('video')) {
    if (!v.paused && !v.ended && v.readyState > 1) return true;
  }
  return false;
}

/** Причина паузы или '' — фон может двигаться. */
export function cosmosReason() {
  const html = document.documentElement;
  if (html.dataset.theme === 'light') return 'theme';
  if (prefs.get('appearance.animatedBg') === false) return 'pref';
  if (motionReduced()) return 'motion';
  if (document.visibilityState !== 'visible') return 'hidden';
  if (!document.hasFocus()) return 'blur';
  if (mediaBusy()) return 'media';
  // в голосовом канале фон тоже стоит: звонок часто идёт вместе с игрой/стримом — ни кадра лишней работы
  if (state.myVoice) return 'voice';
  return '';
}

function apply() {
  raf = 0;
  const why = cosmosReason();
  const html = document.documentElement;
  const next = why ? 'still' : 'live';
  if (html.dataset.cosmos !== next) html.dataset.cosmos = next;
  if (why) html.dataset.cosmosWhy = why; else delete html.dataset.cosmosWhy;
}

/** Пересчитать в ближайшем кадре (события приходят пачками). */
export function updateCosmos() {
  if (!started) return;
  if (raf) return;
  // в скрытой вкладке rAF не срабатывает — применяем сразу
  if (document.visibilityState !== 'visible') { apply(); return; }
  raf = requestAnimationFrame(apply);
}

export function initCosmos() {
  if (started) return;
  started = true;
  apply();
  document.addEventListener('visibilitychange', updateCosmos);
  window.addEventListener('focus', updateCosmos);
  window.addEventListener('blur', updateCosmos);
  document.addEventListener('fullscreenchange', updateCosmos);
  // play/pause у <video> не всплывают — ловим на погружении
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, updateCosmos, true);
  prefs.subscribe('appearance.', updateCosmos);
  try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', updateCosmos); } catch { /* старые движки */ }
  subscribe(['voice', 'me', 'nav'], updateCosmos);
  window.__sozvon = Object.assign(window.__sozvon || {}, { cosmos: { reason: cosmosReason, update: updateCosmos } });
}
