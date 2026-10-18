// Плавающий плеер DJ Бота + модалка библиотеки
import { $, $$, h, icon, setIcon, fmtDuration } from '../util.js';
import { state, subscribe, musicElapsed, getChannel, getServer } from '../state.js';
import { can } from '../perms.js';
import { emitAck } from '../socket.js';
import { api } from '../api.js';
import { music } from '../music.js';
import { prefs } from '../prefs.js';
import { openModal, confirmDialog } from './modals.js';
import { toastError, toastOk } from './toasts.js';

async function command(cmd, args = '') {
  try {
    await emitAck('music:command', { command: cmd, args: String(args) });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** Можно ли управлять музыкой в моём голосовом канале (USE_MUSIC_BOT) */
function musicAllowed() {
  const vch = getChannel(state.myVoice?.channelId);
  return !vch || can(getServer(vch.serverId), 'USE_MUSIC_BOT', vch.id);
}

const trackName = (t) => [t?.artist, t?.title].filter(Boolean).join(' — ') || t?.title || 'Без названия';

function renderPlayer() {
  const ms = music.currentState();
  const player = $('#music-player');
  const ready = !!(ms?.track && ms.track.url && !ms.track.pending);
  const loadingItem = !ready ? (ms?.queue || []).find((q) => q.loading) || (ms?.queue?.[0]?.pending ? ms.queue[0] : null) : null;
  const show = !!(state.myVoice && ms && (ready || loadingItem));
  player.hidden = !show;
  renderQueue();
  if (!show) return;
  player.classList.toggle('is-loading', !ready);
  if (!ready) {
    $('#music-title').textContent = `Загрузка: ${loadingItem.title || 'трек'}`;
    $('#music-title').title = loadingItem.title || '';
    $('#music-artist').textContent = loadingItem.artist ? `${loadingItem.artist} · загружается…` : 'загружается…';
    $('#music-progress-bar').style.width = '0%';
    $('#music-time-cur').textContent = '0:00';
    $('#music-time-total').textContent = loadingItem.duration ? fmtDuration(loadingItem.duration) : '—';
    $('#btn-music-unlock').hidden = true;
    $('#music-progress').setAttribute('aria-disabled', 'true');
    return;
  }
  const t = ms.track;
  $('#music-title').textContent = t.title || 'Без названия';
  $('#music-title').title = t.title || '';
  const queued = ms.queue?.length ? ` · в очереди: ${ms.queue.length}` : '';
  $('#music-artist').textContent = (t.artist || 'Неизвестный исполнитель') + queued;
  const tog = $('#btn-music-toggle');
  tog.dataset.music = ms.paused ? 'resume' : 'pause';
  tog.setAttribute('aria-label', ms.paused ? 'Продолжить' : 'Пауза');
  tog.title = ms.paused ? 'Продолжить' : 'Пауза';
  setIcon(tog.querySelector('svg'), ms.paused ? 'i-play' : 'i-pause');
  player.classList.toggle('is-paused', !!ms.paused);
  $('#btn-music-unlock').hidden = !music.blocked;
  // v3: без USE_MUSIC_BOT кнопки управления недоступны (сервер всё равно ответит «Нет права управлять музыкой»)
  const allowed = musicAllowed();
  $$('#music-player .music-player__controls [data-music]').forEach((b) => {
    b.disabled = !allowed;
    if (!allowed) b.title = 'Нет права управлять музыкой';
  });
  const prog = $('#music-progress');
  const canSeek = allowed && !!t.duration;
  prog.setAttribute('aria-disabled', String(!canSeek));
  prog.tabIndex = canSeek ? 0 : -1;
  prog.title = !allowed ? 'Нет права управлять музыкой' : (t.duration ? 'Перемотать' : 'Длительность неизвестна — перемотка недоступна');
  tickProgress();
}

/** Очередь в модалке библиотеки: готовые и «ожидающие» (pending, без url) элементы.
 *  Убрать / выше / ниже / перетащить — команды бота remove/move по qid (номера сдвигаются, пока качается трек). */
function renderQueue() {
  const ms = music.currentState();
  const q = ms?.queue || [];
  const badge = $('#music-queue-badge');
  if (badge) { badge.hidden = !q.length; badge.textContent = q.length > 99 ? '99+' : String(q.length); }
  const box = $('#music-queue');
  if (!box) return;
  box.hidden = !q.length;
  if (!q.length) { box.querySelector('.queue-list')?.replaceChildren(); return; }
  $('#music-queue-count').textContent = String(q.length);
  const list = box.querySelector('.queue-list');
  if (list.querySelector('.is-dragging')) return; // не перерисовываем под курсором — после броска придёт новое состояние
  const allowed = musicAllowed();
  list.classList.toggle('is-readonly', !allowed);
  const offset = q[0]?.loading ? 1 : 0; // загружаемый элемент — не часть p.queue бота
  const movable = q.length - offset;
  const shown = q.slice(0, 50);
  const btn = (kind, ic, label, disabled) => h('button', {
    type: 'button', class: 'icon-btn', dataset: { q: kind }, 'aria-label': label, title: label, disabled: disabled || !allowed,
  }, icon(ic));
  list.replaceChildren(...shown.map((t, i) => {
    const pos = i - offset + 1; // позиция в очереди бота (1..n), 0 — загружается
    const canMove = allowed && !t.loading && !!t.qid && movable > 1;
    return h('li', {
      class: 'queue-item' + (t.pending ? ' is-pending' : '') + (t.loading ? ' is-loading' : ''),
      dataset: { queueId: t.id || '', qid: t.qid || '', pos: String(pos) },
      draggable: canMove ? 'true' : 'false',
    },
    h('span', { class: 'queue-item__grip', 'aria-hidden': 'true', title: canMove ? 'Перетащите, чтобы изменить порядок' : '' }, icon('i-grip')),
    h('span', { class: 'queue-item__n' }, String(i + 1)),
    h('div', { class: 'queue-item__info' },
      h('div', { class: 'queue-item__title' }, t.title || 'Без названия'),
      h('div', { class: 'queue-item__meta' }, [
        t.artist || null,
        t.loading ? 'загружается…' : (t.pending ? 'скачается перед воспроизведением' : null),
        t.addedBy ? `добавил ${t.addedBy}` : null,
      ].filter(Boolean).join(' · '))),
    t.loading ? h('span', { class: 'spinner', role: 'img', 'aria-label': 'загружается' }) : null,
    h('span', { class: 'queue-item__dur' }, t.duration ? fmtDuration(t.duration) : '—'),
    t.qid ? h('div', { class: 'queue-item__actions' },
      btn('up', 'i-chevron-right', `Выше: «${t.title}»`, !canMove || pos <= 1),
      btn('down', 'i-chevron-right', `Ниже: «${t.title}»`, !canMove || pos >= movable),
      btn('remove', 'i-trash', `Убрать из очереди «${t.title}»`, false)) : null);
  }));
  if (q.length > shown.length) list.append(h('li', { class: 'queue-item queue-item--more' }, `…и ещё ${q.length - shown.length}`));
}

function queueMove(qid, to) { return command('move', `id:${qid} ${to}`); }

function initQueueEditing() {
  const list = $('#music-queue .queue-list');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]');
    const li = b?.closest('.queue-item');
    if (!li?.dataset.qid || b.disabled) return;
    const pos = Number(li.dataset.pos);
    if (b.dataset.q === 'remove') {
      li.classList.add('is-pending');
      command('remove', `id:${li.dataset.qid}`);
    } else if (b.dataset.q === 'up') queueMove(li.dataset.qid, pos - 1);
    else if (b.dataset.q === 'down') queueMove(li.dataset.qid, pos + 1);
  });
  // перетаскивание (HTML5 drag-and-drop)
  let dragged = null;
  const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('.queue-item[draggable="true"]');
    if (!li) return;
    dragged = li;
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.qid);
  });
  const target = (e) => {
    const li = e.target.closest?.('.queue-item');
    return li && li !== dragged && li.dataset.qid && Number(li.dataset.pos) >= 1 ? li : null;
  };
  list.addEventListener('dragover', (e) => {
    if (!dragged) return;
    const li = target(e);
    clearMarks();
    if (!li) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    const li = target(e);
    if (!dragged || !li) return;
    e.preventDefault();
    const from = Number(dragged.dataset.pos);
    const before = li.classList.contains('drop-before');
    let to = Number(li.dataset.pos) + (before ? 0 : 1);
    if (from < to) to -= 1; // элемент сначала вынимается из списка
    const qid = dragged.dataset.qid;
    clearMarks();
    if (to !== from) queueMove(qid, to);
  });
  list.addEventListener('dragend', () => {
    dragged?.classList.remove('is-dragging');
    dragged = null;
    clearMarks();
    renderQueue();
  });
}

/* ---------- перемотка ---------- */
let seekDrag = null; // { sec } пока тянут ползунок — прогресс не прыгает назад

function seekDuration() {
  const ms = music.currentState();
  return ms?.track?.url && !ms.track.pending ? (ms.track.duration || 0) : 0;
}

function paintProgress(cur, dur) {
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  const prog = $('#music-progress');
  $('#music-progress-bar').style.width = `${pct.toFixed(2)}%`;
  prog.setAttribute('aria-valuemax', String(Math.round(dur || 0)));
  prog.setAttribute('aria-valuenow', String(Math.round(cur)));
  prog.setAttribute('aria-valuetext', `${fmtDuration(cur)} из ${dur ? fmtDuration(dur) : '—'}`);
  $('#music-time-cur').textContent = fmtDuration(cur);
  $('#music-time-total').textContent = dur ? fmtDuration(dur) : '—';
}

function seekTo(sec) {
  const dur = seekDuration();
  if (!dur) return;
  const s = Math.max(0, Math.min(dur - 1, sec));
  command('seek', String(Math.round(s * 10) / 10));
}

function initSeek() {
  const prog = $('#music-progress');
  const tip = $('#music-seek-tip');
  const enabled = () => prog.getAttribute('aria-disabled') !== 'true' && seekDuration() > 0;
  const secAt = (clientX) => {
    const r = prog.getBoundingClientRect();
    const f = r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
    return f * seekDuration();
  };
  const preview = (sec) => {
    seekDrag = { sec };
    paintProgress(sec, seekDuration());
    tip.hidden = false;
    tip.textContent = fmtDuration(sec);
    tip.style.left = `${(sec / seekDuration()) * 100}%`;
  };
  prog.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !enabled()) return;
    e.preventDefault();
    prog.setPointerCapture?.(e.pointerId);
    prog.classList.add('is-seeking');
    preview(secAt(e.clientX));
  });
  prog.addEventListener('pointermove', (e) => {
    if (seekDrag) preview(secAt(e.clientX));
  });
  const finish = (e, apply) => {
    if (!seekDrag) return;
    const { sec } = seekDrag;
    prog.classList.remove('is-seeking');
    tip.hidden = true;
    try { prog.releasePointerCapture?.(e.pointerId); } catch { /* уже отпущен */ }
    if (apply) {
      // держим превью, пока бот не пришлёт новую позицию (иначе полоса на миг прыгнет назад)
      seekDrag = { sec, until: Date.now() + 1500 };
      seekTo(sec);
    } else seekDrag = null;
  };
  prog.addEventListener('pointerup', (e) => finish(e, true));
  prog.addEventListener('pointercancel', (e) => finish(e, false));
  prog.addEventListener('lostpointercapture', (e) => { if (seekDrag && !seekDrag.until) finish(e, true); });
  prog.addEventListener('keydown', (e) => {
    if (!enabled()) return;
    const ms = music.currentState();
    const cur = seekDrag?.sec ?? musicElapsed(ms);
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }[e.key];
    let to = null;
    if (step) to = cur + step;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = seekDuration() - 1;
    if (to === null) return;
    e.preventDefault();
    const sec = Math.max(0, Math.min(seekDuration() - 1, to));
    seekDrag = { sec, until: Date.now() + 1500 };
    paintProgress(sec, seekDuration());
    seekTo(sec);
  });
}

function tickProgress() {
  const ms = music.currentState();
  if (!ms?.track?.url || $('#music-player').hidden || $('#music-player').classList.contains('is-loading')) return;
  const audio = $('#music-audio');
  const dur = ms.track.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
  if (seekDrag) {
    // тянут ползунок или ждём подтверждения перемотки от бота
    const done = seekDrag.until && (Date.now() > seekDrag.until || Math.abs(musicElapsed(ms) - seekDrag.sec) < 1.5);
    if (!done) { paintProgress(seekDrag.sec, dur); return; }
    seekDrag = null;
  }
  paintProgress(Math.min(musicElapsed(ms), dur || Infinity), dur);
}

/* ---------- библиотека ---------- */
async function loadLibrary() {
  const list = $('#track-list');
  list.replaceChildren(h('p', { class: 'track-list__empty' }, 'Загрузка…'));
  try {
    const { tracks } = await api.musicList();
    renderLibrary(tracks || []);
  } catch (e) {
    list.replaceChildren(h('p', { class: 'track-list__empty' }, e.message));
  }
}

function renderLibrary(tracks) {
  const list = $('#track-list');
  if (!tracks.length) {
    list.replaceChildren(h('p', { class: 'track-list__empty' }, 'Библиотека пуста. Загрузи файл или вставь ссылку.'));
    return;
  }
  const playing = music.currentState()?.track?.id;
  list.replaceChildren(...tracks.map((t) => h('div', { class: 'track' + (t.id === playing ? ' is-playing' : ''), dataset: { trackId: t.id } },
    h('div', { class: 'track__info' },
      h('div', { class: 'track__title' }, t.title || 'Без названия'),
      h('div', { class: 'track__artist' }, [t.artist || 'Неизвестный исполнитель', t.addedBy ? ` · добавил ${t.addedBy}` : ''].join(''))),
    h('span', { class: 'track__duration' }, t.duration ? fmtDuration(t.duration) : '—'),
    t.canDelete ? h('button', {
      type: 'button', class: 'icon-btn', dataset: { delete: t.id },
      'aria-label': `Удалить «${t.title}» из библиотеки`, title: 'Удалить из библиотеки',
      onclick: async (e) => {
        const b = e.currentTarget;
        const ok = await confirmDialog({
          title: 'Удалить трек?',
          text: `«${trackName(t)}» будет удалён из библиотеки вместе с файлом на сервере. Если он стоит в очереди, он не сыграет.`,
          ok: 'Удалить',
        });
        if (!ok) return;
        b.disabled = true;
        try {
          await api.musicDelete(t.id);
          toastOk(`Удалено: ${t.title}`);
          loadLibrary();
        } catch (ex) { b.disabled = false; toastError(ex); }
      },
    }, icon('i-trash')) : null,
    h('button', {
      type: 'button', class: 'icon-btn', dataset: { play: t.title },
      'aria-label': `Включить «${t.title}»`, title: 'Включить',
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        if (await command('play', t.title)) toastOk(`«${t.title}» — в очереди`);
        b.disabled = false;
      },
    }, icon('i-play')))));
}

function setLibError(text) { $('#music-error').textContent = text || ''; }

export function openLibrary() {
  setLibError('');
  $('#music-hint').hidden = false;
  openModal('modal-music');
  loadLibrary();
}

export function initMusicPlayer(on) {
  music.init();
  const vol = $('#music-volume');
  const paintVol = () => {
    if (document.activeElement !== vol) vol.value = String(music.volume);
    vol.style.setProperty('--val', `${vol.value}%`);
    vol.setAttribute('aria-valuetext', `${vol.value}%`);
    vol.title = `Громкость музыки: ${vol.value}%`;
  };
  paintVol();
  prefs.subscribe('audio.musicVolume', paintVol);
  on('music:state', (ms) => music.setState(ms));
  subscribe(['music', 'voice', 'me'], renderPlayer);
  setInterval(tickProgress, 500);

  $$('#music-player [data-music]').forEach((b) => b.addEventListener('click', () => command(b.dataset.music)));
  vol.addEventListener('input', (e) => {
    music.setVolume(e.target.value);
    paintVol();
  });
  $('#btn-music-unlock').addEventListener('click', () => music.forcePlay());
  $('#btn-music-library').addEventListener('click', openLibrary);
  $('#btn-music-queue').addEventListener('click', () => {
    openLibrary();
    requestAnimationFrame(() => $('#music-queue')?.scrollIntoView({ block: 'start' }));
  });
  initSeek();
  initQueueEditing();
  $('#btn-open-music').addEventListener('click', openLibrary);

  $('#music-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLibError('');
    const label = $('.music-add__upload');
    label.classList.add('is-loading');
    try {
      const { track } = await api.musicUpload(file);
      toastOk(`Загружено: ${track?.title || file.name}`);
      loadLibrary();
    } catch (ex) { setLibError(ex.message); } finally { label.classList.remove('is-loading'); }
  });
  // label как кнопка — доступность с клавиатуры
  $('.music-add__upload').setAttribute('tabindex', '0');
  $('.music-add__upload').setAttribute('role', 'button');
  $('.music-add__upload').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#music-file-input').click(); }
  });

  $('#form-music-import').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#music-url-input');
    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) { setLibError('Нужна ссылка http(s)://…'); return; }
    setLibError('');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Импорт…';
    try {
      const { track } = await api.musicImport(url);
      input.value = '';
      toastOk(`Импортировано: ${track?.title || url}`);
      loadLibrary();
    } catch (ex) { setLibError(ex.message); } finally { btn.disabled = false; btn.textContent = 'Импорт'; }
  });
}
