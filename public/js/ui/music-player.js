// Плавающий плеер DJ Бота + модалка библиотеки
import { $, $$, h, icon, setIcon, fmtDuration } from '../util.js';
import { state, subscribe, musicElapsed, getChannel, getServer } from '../state.js';
import { can } from '../perms.js';
import { emitAck } from '../socket.js';
import { api } from '../api.js';
import { music } from '../music.js';
import { prefs } from '../prefs.js';
import { openModal } from './modals.js';
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
  const vch = getChannel(state.myVoice?.channelId);
  const allowed = !vch || can(getServer(vch.serverId), 'USE_MUSIC_BOT', vch.id);
  $$('#music-player .music-player__controls [data-music]').forEach((b) => {
    b.disabled = !allowed;
    if (!allowed) b.title = 'Нет права управлять музыкой';
  });
  tickProgress();
}

/** Очередь в модалке библиотеки: готовые и «ожидающие» (pending, без url) элементы */
function renderQueue() {
  const box = $('#music-queue');
  if (!box) return;
  const ms = music.currentState();
  const q = ms?.queue || [];
  box.hidden = !q.length;
  if (!q.length) { box.querySelector('.queue-list')?.replaceChildren(); return; }
  $('#music-queue-count').textContent = String(q.length);
  const list = box.querySelector('.queue-list');
  const shown = q.slice(0, 50);
  list.replaceChildren(...shown.map((t, i) => h('li', {
    class: 'queue-item' + (t.pending ? ' is-pending' : '') + (t.loading ? ' is-loading' : ''),
    dataset: { queueId: t.id || '' },
  },
  h('span', { class: 'queue-item__n' }, String(i + 1)),
  h('div', { class: 'queue-item__info' },
    h('div', { class: 'queue-item__title' }, t.title || 'Без названия'),
    h('div', { class: 'queue-item__meta' }, [
      t.artist || null,
      t.loading ? 'загружается…' : (t.pending ? 'скачается перед воспроизведением' : null),
      t.addedBy ? `добавил ${t.addedBy}` : null,
    ].filter(Boolean).join(' · '))),
  t.loading ? h('span', { class: 'spinner', role: 'img', 'aria-label': 'загружается' }) : null,
  h('span', { class: 'queue-item__dur' }, t.duration ? fmtDuration(t.duration) : '—'))));
  if (q.length > shown.length) list.append(h('li', { class: 'queue-item queue-item--more' }, `…и ещё ${q.length - shown.length}`));
}

function tickProgress() {
  const ms = music.currentState();
  if (!ms?.track?.url || $('#music-player').hidden || $('#music-player').classList.contains('is-loading')) return;
  const audio = $('#music-audio');
  const dur = ms.track.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
  const cur = Math.min(musicElapsed(ms), dur || Infinity);
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  $('#music-progress-bar').style.width = `${pct.toFixed(2)}%`;
  $('#music-progress').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('#music-time-cur').textContent = fmtDuration(cur);
  $('#music-time-total').textContent = dur ? fmtDuration(dur) : '—';
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
