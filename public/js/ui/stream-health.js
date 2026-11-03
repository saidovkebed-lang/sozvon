// Качество трансляции экрана. Стример: значок на своей плитке трансляции и точка на кнопке «Демонстрация»
// (зелёный/жёлтый/красный), по клику — панель: реальные кадры/с, разрешение, битрейт, кодек и кто кодирует,
// причина ограничения (процессор / интернет на отдачу), зрители, пинг и потери — и совет, что выбрать.
// Долго (≈10 с) меньше 15 к/с при 30/60 — один ненавязчивый тост за трансляцию.
// Зритель: по наведению на плитку чужой трансляции — получаемые кадры/с и разрешение.
// getStats() опрашивается только пока трансляция идёт, значок на экране, вкладка видна (раз в 2 с; панель открыта — раз в 1 с);
// у зрителя — только пока курсор над плиткой. Отладка: window.__sozvon.streamStats.
import { h, icon } from '../util.js';
import { state } from '../state.js';
import { rtc } from '../voice/rtc.js';
import { screenSendStats, screenRecvStats } from '../voice/stream-stats.js';
import { STREAM_QUALITY } from '../voice/voice.js';
import { toast } from './toasts.js';

const SLOW = 2000;            // значок на плитке
const FAST = 1000;            // панель открыта / зритель навёл курсор
const LOW_FPS = 15;
const LOW_FOR = 10_000;       // столько подряд мало кадров — совет тостом (один раз за трансляцию)

const LIMIT = { cpu: 'не хватает процессора', bandwidth: 'не хватает интернета на отдачу', other: 'ограничено браузером', none: 'нет' };
const LEVEL = { good: 'Всё хорошо', mid: 'Есть проблемы', bad: 'Зрители видят рывки', none: 'Нет данных', idle: 'Никто не смотрит' };

export const health = {
  active: false,   // идёт опрос стримера
  polls: 0,        // сколько раз опрошен getStats стримера (тесты: опрос остановился)
  last: null,      // последняя сводка (voice/stream-stats.js → screenSendStats)
  level: 'none',
  toasted: false,  // совет тостом уже показан в этой трансляции
  viewer: { active: 0, polls: 0, last: null },
};

const target = () => (STREAM_QUALITY[state.streamQuality] || STREAM_QUALITY['720p30']).maxFramerate;
const limited = (s) => s.limitation === 'cpu' || s.limitation === 'bandwidth';
// захват даёт кадры, а уходит мало — узкое место кодировщик/канал; захват сам даёт мало — картинка просто не меняется
const sourceBusy = (s) => s.sourceFps != null && s.sourceFps >= 20;
const lowFps = (s) => s.fps != null && s.fps < LOW_FPS && (limited(s) || sourceBusy(s));

export function levelOf(s) {
  if (!s) return 'none';
  if (!s.senders) return s.viewers ? 'none' : 'idle';
  if (s.fps == null) return 'none';
  if (lowFps(s) || s.loss > 10) return 'bad';
  const short = s.fps < Math.min(24, target() * 0.8) && sourceBusy(s);
  if (limited(s) || short || s.loss > 3 || s.rtt > 300) return 'mid';
  return 'good';
}

/** Понятный совет по сводке; null — всё хорошо */
export function adviceOf(s) {
  if (!s?.senders) return null;
  const q = state.streamQuality;
  const mesh = s.via !== 'sfu' && s.senders > 1;
  if (s.limitation === 'bandwidth') {
    return q !== '720p30'
      ? 'Не хватает интернета на отдачу — выберите 720p 30.'
      : `Не хватает интернета на отдачу — закройте загрузки и торренты или подключитесь по кабелю.${mesh ? ' Каждому зрителю сейчас уходит своя копия трансляции.' : ''}`;
  }
  if (s.limitation === 'cpu') {
    return q !== '720p30'
      ? `Процессор не успевает — выберите качество ниже или закройте лишнее.${s.hw === false ? ' Кодирует процессор: видеокарта для трансляции недоступна.' : ''}`
      : 'Процессор не успевает — закройте лишние программы и вкладки.';
  }
  if (s.loss > 3) return 'Теряются пакеты — сеть нестабильна. Если вы по Wi-Fi, попробуйте кабель.';
  if (lowFps(s)) return q !== '720p30' ? 'Кадров мало — выберите 720p 30.' : 'Кадров мало — закройте лишние программы.';
  if (s.fps != null && s.fps < LOW_FPS && !sourceBusy(s)) return 'Картинка почти не меняется — кадры отправляются только при изменениях, это нормально.';
  return null;
}

const res = (w, hh) => (w && hh ? `${w}×${hh}` : '—');
const kbps = (v) => (v == null ? '—' : v >= 1000 ? `${String(Math.round(v / 100) / 10).replace('.', ',')} Мбит/с` : `${v} кбит/с`);
const viaText = { sfu: 'через сервер (SFU)', mesh: 'напрямую каждому зрителю', mixed: 'через сервер + напрямую' };

/* ---------- опрос стримера ---------- */
let timer = null;
let lastPoll = 0;
let lowSince = 0;
let streamRef = null;
let pollSeq = 0;

const shown = (el) => !!el && !el.hidden && (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
const visible = () => !document.hidden && [...document.querySelectorAll('.tile__q, #ctrl-screen-q')].some(shown);

/** Запустить/остановить опрос по обстановке (рендер сцены, видимость вкладки, начало/конец трансляции) */
export function syncHealth() {
  if (rtc.local.screen !== streamRef) {
    // новая трансляция — новый тост и новая история
    streamRef = rtc.local.screen;
    health.toasted = false;
    health.last = null;
    lowSince = 0;
  }
  paint(); // сначала показать/спрятать точку на кнопке — по ней видно, на экране ли индикатор
  const want =!!state.streaming && !!rtc.local.screen && visible();
  if (want && !timer) schedule(0);
  if (!want) stop();
  paint();
}

function stop() {
  clearTimeout(timer);
  timer = null;
  health.active = false;
  if (!state.streaming) { health.last = null; health.level = 'none'; }
}

function schedule(ms) {
  clearTimeout(timer);
  health.active = true;
  timer = setTimeout(tick, ms);
}

async function tick() {
  const seq = ++pollSeq;
  if (!state.streaming || !rtc.local.screen || !visible()) { stop(); paint(); return; }
  let s = null;
  try { s = await screenSendStats(); } catch (e) { console.warn('[stream] getStats', e); }
  if (seq !== pollSeq || !timer) return;
  health.polls++;
  const now = performance.now();
  if (now - lastPoll > 5000) lowSince = 0; // был перерыв (вкладка скрыта) — считаем заново
  lastPoll = now;
  health.last = s;
  health.level = levelOf(s);
  watchLow(s, now);
  paint();
  schedule(popup ? FAST : SLOW);
}

function watchLow(s, now) {
  if (!s || health.toasted || target() < 30 || !lowFps(s)) { lowSince = 0; return; }
  if (!lowSince) { lowSince = now; return; }
  if (now - lowSince < LOW_FOR) return;
  health.toasted = true;
  toast(`Зрители видят ${s.fps} к/с. ${adviceOf(s) || 'Выберите качество ниже.'}`, '', 9000);
}

/* ---------- значки ---------- */
function shortText(s, lv) {
  if (lv === 'idle') return 'пауза';
  return s?.fps != null ? `${s.fps} к/с` : '…';
}

function titleOf(s, lv) {
  if (lv === 'idle') return 'Никто не смотрит — трансляция на паузе';
  const parts = [LEVEL[lv]];
  if (s?.fps != null) parts.push(`${s.fps} к/с · ${res(s.width, s.height)}`);
  const a = adviceOf(s);
  if (a) parts.push(a);
  return `${parts.join(' — ')} (нажмите для подробностей)`;
}

function paint() {
  const s = health.last;
  const lv = state.streaming ? (s ? health.level : 'none') : 'none';
  for (const el of document.querySelectorAll('.tile__q')) {
    el.dataset.level = lv;
    const t = shortText(s, lv);
    const out = el.querySelector('.tile__q-text');
    if (out && out.textContent !== t) out.textContent = t;
    el.title = titleOf(s, lv);
    el.setAttribute('aria-label', `Качество трансляции: ${LEVEL[lv]}${s?.fps != null ? `, ${s.fps} кадров в секунду` : ''}`);
  }
  const dot = document.getElementById('ctrl-screen-q');
  if (dot) { dot.dataset.level = lv; dot.hidden = !state.streaming; }
  if (popup && !popupAnchor?.isConnected) closePopup();
  if (popup) fillPopup();
}

/** Значок качества для своей плитки трансляции (элемент живёт между перерисовками плитки) */
export function streamHealthBadge() {
  const el = h('button', {
    type: 'button', class: 'tile__q', dataset: { level: 'none' }, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); openPopup(el); },
  }, h('span', { class: 'tile__q-dot', 'aria-hidden': 'true' }), h('span', { class: 'tile__q-text' }, '…'));
  for (const ev of ['pointerdown', 'mousedown', 'dblclick', 'keydown']) el.addEventListener(ev, (e) => e.stopPropagation());
  queueMicrotask(syncHealth);
  return el;
}

/* ---------- панель ---------- */
let popup = null;
let popupAnchor = null;

function row(label, value, cls = '') {
  return h('div', { class: 'ping-popup__row' }, h('span', null, label), h('strong', { class: cls }, value));
}

function fillPopup() {
  const s = health.last;
  const lv = state.streaming ? (s ? health.level : 'none') : 'none';
  const t = target();
  const rows = [];
  if (s?.senders) {
    const scaled = s.sourceWidth && s.width && s.sourceWidth > s.width + 8;
    rows.push(
      row('Кадры/с', s.fps != null ? `${s.fps} из ${t}` : '—', lowFps(s) ? 'is-bad' : ''),
      row('Разрешение', `${res(s.width, s.height)}${scaled ? ` (захват ${res(s.sourceWidth, s.sourceHeight)})` : ''}`),
      row('Битрейт', kbps(s.kbps)),
      row('Кодек', s.codec ? `${s.codec}${s.hw == null ? '' : s.hw ? ' · видеокарта' : ' · процессор'}` : '—'),
      row('Ограничение', LIMIT[s.limitation] || s.limitation, limited(s) ? 'is-bad' : ''),
    );
    if (s.sourceFps != null) rows.push(row('Захват экрана', `${s.sourceFps} к/с`));
    rows.push(
      row('Пинг · потери', `${s.rtt != null ? `${s.rtt} мс` : '—'} · ${s.loss != null ? `${String(s.loss).replace('.', ',')} %` : '—'}`, s.loss > 3 ? 'is-bad' : ''),
      row('Маршрут', viaText[s.via] || '—'),
    );
    if (s.encoder) rows.push(row('Кодировщик', s.encoder));
  }
  rows.push(row('Зрители', String(s?.viewers ?? rtc.screenViewers())));
  const advice = adviceOf(s);
  const q = STREAM_QUALITY[state.streamQuality];
  popup.replaceChildren(...[
    h('div', { class: 'ping-popup__head' },
      h('span', { class: 'ping-popup__icon', dataset: { level: lv === 'idle' ? 'none' : lv } }, icon('i-screen')),
      h('div', null,
        h('div', { class: 'ping-popup__title' }, 'Трансляция'),
        h('div', { class: `ping-popup__state ping-popup__state--${lv}` }, state.streaming ? LEVEL[lv] : 'Трансляция остановлена')),
      h('div', { class: 'ping-popup__big' }, s?.fps != null ? String(s.fps) : '—', h('small', null, ' к/с'))),
    h('div', { class: 'ping-popup__rows' }, ...rows),
    advice ? h('p', { class: `stream-popup__advice${lv === 'bad' || lv === 'mid' ? ' is-warn' : ''}` }, advice) : null,
    lv === 'idle' ? h('p', { class: 'ping-popup__hint' }, 'Никто не смотрит — ничего не кодируется и не отправляется. Цифры появятся, когда кто-нибудь нажмёт «Смотреть».') : null,
    h('div', { class: 'stream-popup__foot' },
      h('span', { class: 'ping-popup__hint' }, `Выбрано: ${q?.label || '—'}`),
      h('button', {
        type: 'button', class: 'btn btn--sm btn--ghost stream-popup__quality',
        onclick: async () => { closePopup(); (await import('./stream.js')).openStreamModal(); },
      }, 'Сменить качество'))].filter(Boolean));
}

function closePopup() {
  if (!popup) return;
  popup.remove();
  popup = null;
  popupAnchor?.setAttribute('aria-expanded', 'false');
  popupAnchor = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
function onOutside(e) { if (popup && !popup.contains(e.target) && !e.target.closest('.tile__q')) closePopup(); }
function onKey(e) { if (e.key === 'Escape' && popup) { e.preventDefault(); e.stopPropagation(); const a = popupAnchor; closePopup(); a?.focus(); } }

function openPopup(anchor) {
  if (popup && popupAnchor === anchor) { closePopup(); return; }
  closePopup();
  popup = h('div', { class: 'ping-popup stream-popup', role: 'dialog', 'aria-label': 'Качество трансляции' });
  popupAnchor = anchor;
  fillPopup();
  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  popup.style.left = `${Math.max(8, Math.min(r.left, vw - popup.offsetWidth - 8))}px`;
  popup.style.top = `${Math.max(8, Math.min(r.bottom + 8, vh - popup.offsetHeight - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  document.addEventListener('keydown', onKey, true);
  if (timer) schedule(0); else syncHealth(); // свежие цифры сразу, дальше раз в секунду
}

/* ---------- зритель ---------- */
/** Подпись «к/с · разрешение» в углу чужой трансляции; опрос — только пока курсор над плиткой */
export function viewerStatsEl(tile, socketId) {
  const el = h('div', { class: 'tile__rx', dataset: { socketId }, 'aria-hidden': 'true' });
  let t = null;
  let on = false;
  const run = async () => {
    if (!on || !el.isConnected || document.hidden) { halt(); return; }
    let s = null;
    try { s = await screenRecvStats(socketId); } catch { /* ignore */ }
    if (!on) return;
    health.viewer.polls++;
    health.viewer.last = s;
    el.textContent = s?.fps != null ? `${s.fps} к/с · ${res(s.width, s.height)}` : '…';
    el.title = s ? [s.kbps != null ? kbps(s.kbps) : null, s.codec, s.loss ? `потери ${String(s.loss).replace('.', ',')} %` : null].filter(Boolean).join(' · ') : '';
    t = setTimeout(run, FAST);
  };
  const halt = () => {
    clearTimeout(t);
    t = null;
    if (on) health.viewer.active = Math.max(0, health.viewer.active - 1);
    on = false;
  };
  const start = () => {
    if (on) return;
    on = true;
    health.viewer.active++;
    el.textContent = '…';
    run();
  };
  el.start = start;
  el.halt = halt;
  if (!tile.dataset.rxWired) {
    // слушатели — на плитке один раз; подпись может пересоздаваться
    tile.dataset.rxWired = '1';
    tile.addEventListener('mouseenter', () => tile.querySelector(':scope > .tile__rx')?.start());
    tile.addEventListener('mouseleave', () => tile.querySelector(':scope > .tile__rx')?.halt());
  }
  // курсор уже над плиткой (нажали «Смотреть») — mouseenter не придёт
  queueMicrotask(() => { if (el.isConnected && tile.matches(':hover')) start(); });
  return el;
}

export function initStreamHealth() {
  document.addEventListener('visibilitychange', syncHealth);
  window.__sozvon = Object.assign(window.__sozvon || {}, {
    streamStats: Object.assign(health, { sample: screenSendStats, recv: screenRecvStats, levelOf, adviceOf }),
  });
}
