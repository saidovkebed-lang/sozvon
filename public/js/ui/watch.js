// «Смотреть вместе»: панель видео на сцене голосового канала + синхронное воспроизведение (как MusicSync).
// Состояние приходит от сервера (watch:state, server/watch.js), позиция считается по serverNow/updatedAt.
import { $, h, icon, fmtDuration } from '../util.js';
import { state, subscribe, notify, getChannel, getServer } from '../state.js';
import * as sock from '../socket.js';
import { getToken } from '../api.js';
import { can } from '../perms.js';
import { prefs } from '../prefs.js';
import { toast } from './toasts.js';

const DRIFT_MAX = 1;      // с: больше — жёсткая перемотка
const DRIFT_SOFT = 0.3;   // с: больше — подтягиваем скоростью 0.95/1.05
const VOL_KEY = 'watch.volume';
const STAGE_RU = { queued: 'в очереди на скачивание', meta: 'получаю информацию', download: 'скачиваю', process: 'готовлю файл' };

state.watch = {}; // channelId → WatchState (+ _skew)
let token = null;
let limits = null;
let collapsed = false;   // пользователь свернул панель (до следующего нового видео)
let opened = false;      // пользователь открыл панель кнопкой (пустую — чтобы вставить ссылку)
let focusMode = false;   // «кинотеатр»: панель на всю сцену, плитки скрыты
let lastVideoKey = null;
let uploading = null;    // {name, pct, xhr}
let seekDrag = null;     // перетаскивание ползунка: {pct}
const el = {};

export const watchElapsed = (ws) => {
  if (!ws?.video) return 0;
  const now = Date.now() + (ws._skew || 0);
  return Math.max(0, ws.position + (ws.paused ? 0 : (now - ws.updatedAt) / 1000));
};
const myState = () => {
  const ch = state.myVoice?.channelId;
  return ch ? state.watch[ch] || null : null;
};
const canControl = () => {
  const ch = state.myVoice?.channelId && getChannel(state.myVoice.channelId);
  const srv = ch && getServer(ch.serverId);
  return !!srv && can(srv, 'USE_MUSIC_BOT', ch.id);
};

// ---------------------------------------------------------------- синхронизация --
class WatchSync {
  constructor() { this.v = null; this.url = null; this.seq = new Map(); this.seekPending = false; this.blocked = false; this.errAt = 0; }

  init(video) {
    this.v = video;
    this.applyVolume();
    prefs.subscribe(VOL_KEY, () => { this.applyVolume(); paintVolume(); });
    video.addEventListener('loadedmetadata', () => this.sync(true));
    video.addEventListener('error', () => this.onError());
    setInterval(() => this.sync(false), 1000);
  }

  applyVolume() {
    const n = Number(prefs.get(VOL_KEY));
    if (this.v) this.v.volume = Math.min(100, Math.max(0, Number.isFinite(n) ? n : 80)) / 100;
  }

  setState(ws) {
    if (!ws?.channelId) return;
    ws._skew = typeof ws.serverNow === 'number' ? ws.serverNow - Date.now() : 0;
    const seq = Number(ws.seekSeq) || 0;
    if (this.seq.has(ws.channelId) && this.seq.get(ws.channelId) !== seq && state.myVoice?.channelId === ws.channelId) this.seekPending = true;
    this.seq.set(ws.channelId, seq);
    if (!ws.video && !ws.queue?.length && !ws.loading?.length) delete state.watch[ws.channelId];
    else state.watch[ws.channelId] = ws;
    if (state.myVoice?.channelId === ws.channelId) this.sync(true);
    notify('watch');
  }

  async onError() {
    if (!this.v.getAttribute('src')) return;
    // ссылка с истёкшим токеном (или сервер перезапущен) — новый токен и повторная загрузка, не чаще раза в 30 с
    if (Date.now() - this.errAt < 30_000) { console.warn('[watch] не удалось загрузить видео', this.url); return; }
    this.errAt = Date.now();
    await refresh().catch(() => {});
    this.url = null;
    this.sync(true);
  }

  unload() {
    if (!this.url) return;
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    this.url = null;
  }

  sync(force) {
    const v = this.v;
    if (!v) return;
    const ws = myState();
    if (!ws?.video || !token) { this.unload(); return; }
    const el0 = watchElapsed(ws);
    if (this.url !== ws.video.url) {
      this.url = ws.video.url;
      this.blocked = false;
      v.muted = !!state.deafened;
      v.src = `${ws.video.url}?t=${encodeURIComponent(token)}`;
      try { v.currentTime = el0; } catch { /* до loadedmetadata */ }
      force = true;
    }
    if (!this.blocked) v.muted = !!state.deafened;
    if (ws.paused) {
      if (!v.paused) v.pause();
      v.playbackRate = 1;
      if (v.readyState >= 1) this.seekPending = false;
      if (force && v.readyState >= 1 && Math.abs(v.currentTime - el0) > 0.25) { try { v.currentTime = el0; } catch { /* */ } }
      paintTime();
      return;
    }
    const dur = ws.video.duration || v.duration || Infinity;
    if (el0 >= dur) { if (!v.paused) v.pause(); return; }
    if (v.readyState >= 1) {
      const drift = el0 - v.currentTime;
      if (Math.abs(drift) > (this.seekPending ? 0.25 : DRIFT_MAX)) {
        try { v.currentTime = el0; } catch { /* */ }
        v.playbackRate = 1;
      } else {
        v.playbackRate = Math.abs(drift) > DRIFT_SOFT ? (drift > 0 ? 1.05 : 0.95) : 1;
      }
      this.seekPending = false;
    }
    if (v.paused && el0 > 0) {
      v.play().catch((e) => {
        if (e?.name !== 'NotAllowedError') return;
        // браузер запретил звук без жеста: играем без звука и показываем «Включить звук»
        this.blocked = true;
        v.muted = true;
        v.play().catch(() => {});
        paint();
      });
    }
    paintTime();
  }

  /** Кнопка «▶ Включить звук» (жест пользователя) */
  unlock() {
    this.blocked = false;
    this.v.muted = !!state.deafened;
    this.v.play().catch(() => {});
    this.sync(true);
    paint();
  }
}
export const watchSync = new WatchSync();

// ---------------------------------------------------------------- сервер --
async function refresh() {
  const res = await sock.emitAck('watch:sync');
  token = res.token;
  limits = res.limits || null;
  const seen = new Set();
  for (const ws of res.states || []) { seen.add(ws.channelId); watchSync.setState(ws); }
  for (const id of Object.keys(state.watch)) if (!seen.has(id)) delete state.watch[id];
  watchSync.sync(true);
  notify('watch');
}

async function control(action, extra = {}) {
  try {
    await sock.emitAck('watch:control', { action, ...extra });
  } catch (e) {
    toast(e.message);
  }
}

async function startUrl(url) {
  setError('');
  try {
    await sock.emitAck('watch:start', { url });
    el.input.value = '';
  } catch (e) {
    setError(e.message);
  }
}

function upload(file) {
  if (!file) return;
  setError('');
  if (limits?.maxMb && file.size > limits.maxMb * 1024 * 1024) { setError(`Файл больше ${limits.maxMb} МБ`); return; }
  const xhr = new XMLHttpRequest();
  uploading = { name: file.name, pct: 0, xhr };
  xhr.open('POST', `/api/watch/upload?channelId=${encodeURIComponent(state.myVoice?.channelId || '')}`);
  xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable && uploading) { uploading.pct = e.loaded / e.total; paintLists(); } };
  xhr.onload = () => {
    uploading = null;
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
    if (xhr.status !== 200) setError(data?.error || `Не удалось загрузить файл (${xhr.status})`);
    paint();
  };
  xhr.onerror = () => { uploading = null; setError('Нет связи с сервером'); paint(); };
  const fd = new FormData();
  fd.append('file', file, file.name);
  xhr.send(fd);
  paint();
}

function setError(text) { el.error.textContent = text || ''; }

// ---------------------------------------------------------------- разметка --
function build() {
  const btn = (id, ic, label, onclick, cls = 'icon-btn') => h('button', { type: 'button', class: cls, id, 'aria-label': label, title: label, onclick }, icon(ic));
  el.video = h('video', { class: 'watch__video', id: 'watch-video', playsInline: true, preload: 'auto' });
  el.video.setAttribute('playsinline', '');
  el.unlock = h('button', { type: 'button', class: 'btn btn--primary watch__unlock', id: 'btn-watch-unlock', hidden: true, onclick: () => watchSync.unlock() },
    icon('i-play', 'icon--sm'), ' Включить звук');
  el.placeholder = h('div', { class: 'watch__placeholder', id: 'watch-placeholder' });
  el.play = btn('watch-play', 'i-play', 'Смотреть', () => { const ws = myState(); if (ws?.video) control(ws.paused ? 'play' : 'pause'); });
  el.bar = h('div', { class: 'progress progress--seek watch__progress', id: 'watch-progress', role: 'slider', tabindex: '0',
    'aria-label': 'Перемотка видео', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0' },
  el.barFill = h('div', { class: 'progress__bar', id: 'watch-progress-bar' }));
  el.cur = h('span', { class: 'watch__time', id: 'watch-time-cur' }, '0:00');
  el.total = h('span', { class: 'watch__time', id: 'watch-time-total' }, '0:00');
  el.volBtn = btn('watch-mute', 'i-volume', 'Звук видео', () => {
    const v = Number(prefs.get(VOL_KEY));
    if (v > 0) { el.volBtn.dataset.prev = String(v); prefs.set(VOL_KEY, 0); } else prefs.set(VOL_KEY, Number(el.volBtn.dataset.prev) || 80);
  });
  el.vol = h('input', { type: 'range', class: 'slider watch__volume', id: 'watch-volume', min: '0', max: '100', step: '1', 'aria-label': 'Громкость видео (только у вас)', title: 'Громкость видео — только у вас' });
  el.vol.addEventListener('input', () => prefs.set(VOL_KEY, Number(el.vol.value)));
  el.focus = btn('watch-focus', 'i-window', 'Кинотеатр: видео на всю сцену', () => { focusMode = !focusMode; paint(); });
  el.full = btn('watch-fullscreen', 'i-expand', 'Во весь экран', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.screen.requestFullscreen?.().catch(() => {});
  });
  el.controls = h('div', { class: 'watch__controls' }, el.play, el.cur, el.bar, el.total, h('div', { class: 'watch__vol' }, el.volBtn, el.vol), el.focus, el.full);
  el.screen = h('div', { class: 'watch__screen', id: 'watch-screen' }, el.video, el.placeholder, el.unlock, el.controls);
  el.screen.addEventListener('dblclick', (e) => { if (!e.target.closest('.watch__controls')) el.full.click(); });

  el.now = h('div', { class: 'watch__now', id: 'watch-now' });
  el.skip = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'watch-skip', onclick: () => control('skip') }, icon('i-skip', 'icon--sm'), ' Дальше');
  el.stop = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'watch-stop', onclick: () => control('stop') }, icon('i-stop', 'icon--sm'), ' Стоп');
  el.close = btn('watch-close', 'i-close', 'Свернуть панель', () => { collapsed = true; opened = false; focusMode = false; paint(); });
  el.input = h('input', { class: 'input watch__input', id: 'watch-url', type: 'url', name: 'url', placeholder: 'Ссылка: YouTube, VK Видео, Rutube, mp4…', 'aria-label': 'Ссылка на видео', autocomplete: 'off' });
  el.file = h('input', { type: 'file', id: 'watch-file', accept: 'video/*,.mp4,.webm,.mov,.mkv,.m4v', hidden: true });
  el.file.addEventListener('change', () => { upload(el.file.files[0]); el.file.value = ''; });
  el.submit = h('button', { type: 'submit', class: 'btn btn--primary', id: 'watch-submit' }, 'Смотреть');
  el.uploadBtn = h('button', { type: 'button', class: 'btn btn--ghost', id: 'watch-upload', title: 'Загрузить видеофайл', onclick: () => el.file.click() }, icon('i-upload', 'icon--sm'), h('span', { class: 'watch__upload-text' }, ' Файл'));
  el.form = h('form', { class: 'watch__form', id: 'watch-form' }, el.input, el.submit, el.uploadBtn, el.file);
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = el.input.value.trim();
    if (url) startUrl(url); else el.input.focus();
  });
  el.hint = h('p', { class: 'watch__hint', id: 'watch-hint' });
  el.error = h('p', { class: 'form__error watch__error', id: 'watch-error', role: 'alert' });
  el.loading = h('ul', { class: 'watch__loading', id: 'watch-loading' });
  el.queue = h('ol', { class: 'watch__queue', id: 'watch-queue' });
  el.side = h('div', { class: 'watch__side' },
    h('div', { class: 'watch__head' }, el.now, el.skip, el.stop, el.close), el.form, el.hint, el.error, el.loading, el.queue);
  el.panel = h('section', { class: 'watch', id: 'watch-panel', hidden: true, 'aria-label': 'Смотреть вместе' }, el.screen, el.side);
  $('#voice-view').insertBefore(el.panel, $('#stage-grid'));

  el.ctrl = h('button', { type: 'button', class: 'ctrl', id: 'ctrl-watch', 'aria-label': 'Смотреть вместе', 'aria-pressed': 'false', title: 'Смотреть вместе',
    onclick: () => {
      const shown = !el.panel.hidden;
      if (shown) { collapsed = true; opened = false; focusMode = false; } else { collapsed = false; opened = true; }
      paint();
      if (!shown && !myState()?.video) el.input.focus();
    } }, icon('i-monitor'));
  $('#stage-controls').insertBefore(el.ctrl, $('#ctrl-leave'));

  initSeek();
}

function initSeek() {
  const pctAt = (x) => { const r = el.bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / (r.width || 1))); };
  const dur = () => myState()?.video?.duration || el.video.duration || 0;
  el.bar.addEventListener('pointerdown', (e) => {
    if (!myState()?.video || !canControl() || !dur()) return;
    el.bar.setPointerCapture?.(e.pointerId);
    seekDrag = { pct: pctAt(e.clientX) };
    paintTime();
  });
  el.bar.addEventListener('pointermove', (e) => { if (seekDrag && e.buttons) { seekDrag.pct = pctAt(e.clientX); paintTime(); } });
  const finish = (e) => {
    if (!seekDrag) return;
    const pct = e.type === 'pointercancel' ? null : pctAt(e.clientX);
    seekDrag = null;
    if (pct != null) control('seek', { position: pct * dur() });
    paintTime();
  };
  el.bar.addEventListener('pointerup', finish);
  el.bar.addEventListener('pointercancel', finish);
  el.bar.addEventListener('keydown', (e) => {
    const ws = myState();
    if (!ws?.video || !canControl()) return;
    const cur = watchElapsed(ws);
    const to = { ArrowRight: cur + 10, ArrowLeft: cur - 10, Home: 0, End: dur() - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    control('seek', { position: Math.max(0, to) });
  });
  // пробел/K на панели — пауза
  el.screen.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'k') && !e.target.closest('input, button, [role=slider]')) { e.preventDefault(); el.play.click(); }
  });
}

// ---------------------------------------------------------------- отрисовка --
function paintVolume() {
  const v = Math.round(Number(prefs.get(VOL_KEY)) || 0);
  if (document.activeElement !== el.vol) el.vol.value = String(v);
  el.vol.style.setProperty('--val', `${v}%`);
  el.volBtn.replaceChildren(icon(v === 0 ? 'i-volume-x' : v < 50 ? 'i-volume-low' : 'i-volume'));
}

function paintTime() {
  const ws = myState();
  if (!el.panel || !ws?.video) return;
  const d = ws.video.duration || el.video.duration || 0;
  const cur = seekDrag && d ? seekDrag.pct * d : watchElapsed(ws);
  const pct = d ? Math.min(100, (cur / d) * 100) : 0;
  el.barFill.style.width = `${pct}%`;
  el.cur.textContent = fmtDuration(Math.min(cur, d || cur));
  el.total.textContent = d ? fmtDuration(d) : '—';
  el.bar.setAttribute('aria-valuemax', String(Math.round(d)));
  el.bar.setAttribute('aria-valuenow', String(Math.round(cur)));
  el.bar.setAttribute('aria-valuetext', fmtDuration(cur));
}

function paintLists() {
  const ws = myState();
  const allowed = canControl();
  const loading = (ws?.loading || []).map((l) => {
    const pct = typeof l.progress === 'number' ? Math.round(l.progress * 100) : null;
    return h('li', { class: 'watch__load', dataset: { id: l.id } },
      h('div', { class: 'watch__load-text' },
        h('span', { class: 'watch__load-title' }, l.title || 'Видео'),
        h('span', { class: 'watch__load-stage' }, `${STAGE_RU[l.stage] || 'загружаю'}${pct != null && l.stage === 'download' ? ` · ${pct}%` : ''} · ${l.by?.name || ''}`)),
      h('div', { class: 'progress watch__load-bar' + (pct == null ? ' is-indeterminate' : '') }, h('div', { class: 'progress__bar', style: { width: `${pct ?? 100}%` } })),
      allowed ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Отменить', title: 'Отменить', onclick: () => control('cancel', { id: l.id }) }, icon('i-close', 'icon--sm')) : null);
  });
  if (uploading) {
    const pct = Math.round(uploading.pct * 100);
    loading.push(h('li', { class: 'watch__load watch__load--upload' },
      h('div', { class: 'watch__load-text' }, h('span', { class: 'watch__load-title' }, uploading.name), h('span', { class: 'watch__load-stage' }, `загружаю файл · ${pct}%`)),
      h('div', { class: 'progress watch__load-bar' }, h('div', { class: 'progress__bar', style: { width: `${pct}%` } })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Отменить загрузку', title: 'Отменить загрузку', onclick: () => { uploading?.xhr.abort(); uploading = null; paint(); } }, icon('i-close', 'icon--sm'))));
  }
  el.loading.replaceChildren(...loading);
  el.loading.hidden = !loading.length;
  const queue = (ws?.queue || []).map((q, i) => h('li', { class: 'watch__qitem', dataset: { qid: q.qid } },
    h('span', { class: 'watch__qnum' }, `${i + 1}.`),
    h('span', { class: 'watch__qtitle', title: q.title }, q.title),
    h('span', { class: 'watch__qmeta' }, `${q.duration ? fmtDuration(q.duration) + ' · ' : ''}${q.by?.name || ''}`),
    allowed ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Убрать из очереди', title: 'Убрать из очереди', onclick: () => control('remove', { qid: q.qid }) }, icon('i-close', 'icon--sm')) : null));
  el.queue.replaceChildren(...(queue.length ? [h('li', { class: 'watch__qhead' }, `Дальше (${queue.length})`), ...queue] : []));
  el.queue.hidden = !queue.length;
}

function paint() {
  if (!el.panel) return;
  const ch = getChannel();
  const ws = myState();
  const inThis = !!state.myVoice && ch?.type === 'voice' && ch.id === state.myVoice.channelId;
  const videoKey = ws?.video ? `${ws.channelId}:${ws.video.qid}` : null;
  if (videoKey && videoKey !== lastVideoKey) collapsed = false; // новое видео — панель снова показываем
  lastVideoKey = videoKey;
  if (!state.myVoice) { opened = false; focusMode = false; }
  const active = !!(ws?.video || ws?.loading?.length || ws?.queue?.length || uploading);
  const show = inThis && !collapsed && (opened || active);
  el.panel.hidden = !show;
  el.ctrl.classList.toggle('is-on', show);
  el.ctrl.setAttribute('aria-pressed', String(show));
  el.ctrl.classList.toggle('has-video', !!ws?.video);
  $('#voice-view').classList.toggle('is-watch-focus', show && focusMode && !!ws?.video);
  el.panel.classList.toggle('has-video', !!ws?.video);
  el.focus.classList.toggle('is-on', focusMode);
  el.focus.setAttribute('aria-pressed', String(focusMode));
  if (!show) return;

  const allowed = canControl();
  if (ws?.video) {
    el.now.replaceChildren(h('span', { class: 'watch__now-label' }, 'Сейчас смотрим: '), h('b', { title: ws.video.title }, ws.video.title),
      ws.video.by?.name ? h('span', { class: 'watch__now-by' }, ` · включил(а) ${ws.video.by.name}`) : null);
    el.placeholder.hidden = true;
  } else {
    el.now.replaceChildren(h('b', null, 'Смотреть вместе'));
    el.placeholder.hidden = false;
    el.placeholder.replaceChildren(icon('i-monitor'), h('p', null, ws?.loading?.length || uploading
      ? 'Видео скачивается на сервер — начнём, как только будет готово'
      : 'Вставьте ссылку на видео или загрузите файл — все в канале увидят его одновременно'));
  }
  el.play.replaceChildren(icon(ws?.paused || !ws?.video ? 'i-play' : 'i-pause'));
  el.play.setAttribute('aria-label', ws?.paused ? 'Продолжить для всех' : 'Пауза для всех');
  el.play.title = el.play.getAttribute('aria-label');
  el.play.disabled = !ws?.video || !allowed;
  el.bar.setAttribute('aria-disabled', String(!ws?.video || !allowed));
  el.controls.hidden = !ws?.video;
  el.skip.hidden = !ws?.video || !allowed;
  el.stop.hidden = !(ws?.video || ws?.queue?.length || ws?.loading?.length) || !allowed;
  el.unlock.hidden = !(ws?.video && watchSync.blocked);
  el.panel.classList.toggle('is-paused', !!ws?.paused);
  for (const x of [el.input, el.submit, el.uploadBtn]) x.disabled = !allowed;
  el.hint.textContent = !allowed ? 'Нет права включать видео (право «Музыка и «Смотреть вместе»»). Смотреть можно.'
    : `Сервер сам скачает видео (до ${limits?.maxDurationMin || 180} мин, до ${limits?.maxMb || 1500} МБ) — YouTube работает у всех. Громкость — только у вас.`;
  paintLists();
  paintTime();
  paintVolume();
}

// ---------------------------------------------------------------- init --
export function initWatch(on) {
  build();
  watchSync.init(el.video);
  on('watch:state', (ws) => watchSync.setState(ws));
  on('watch:error', (d) => {
    if (!d || state.myVoice?.channelId !== d.channelId) return;
    const text = `Видео${d.title ? ` «${d.title}»` : ''}: ${d.error}`;
    if (d.by?.id === state.user?.id) setError(text);
    toast(text, 'error', 7000);
  });
  on('connect', () => { refresh().catch((e) => console.warn('[watch] sync:', e.message)); });
  // токен на файлы живёт 48 ч — обновляем заранее (уже открытое видео не перезагружается)
  setInterval(() => { if (sock.getSocket()?.connected) refresh().catch(() => {}); }, 6 * 3600_000);
  subscribe(['watch', 'nav', 'voice', 'servers', 'me'], () => { watchSync.sync(false); paint(); });
  document.addEventListener('fullscreenchange', () => el.screen.classList.toggle('is-fullscreen', document.fullscreenElement === el.screen));
  window.__sozvon = Object.assign(window.__sozvon || {}, { watch: watchSync });
}
