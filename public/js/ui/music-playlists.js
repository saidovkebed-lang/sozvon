// Плейлисты сервера (вкладка «Плейлисты» в модалке библиотеки) и «Добавить в плейлист».
// Сервер — server/music-playlists.js (REST), изменения приходят событием music:playlists.
// Включение — команда бота playlist (id:<id> [shuffle]) через music:command.
import { $, h, icon, fmtDuration } from '../util.js';
import { state, getChannel, getServer } from '../state.js';
import { can } from '../perms.js';
import { api } from '../api.js';
import { music } from '../music.js';
import { openModal, closeModal, confirmDialog } from './modals.js';
import { toastError, toastOk } from './toasts.js';
import { coverArt } from './covers.js';

let command = async () => false; // music-player.js передаёт свою функцию команд бота
let lists = [];          // плейлисты текущего сервера (без треков)
let openPl = null;       // открытый плейлист (с треками)
let pickItem = null;     // что добавляем через «В плейлист»

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const tracksText = (n) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;

/** Сервер плейлистов: где я в голосовом канале, иначе открытый сервер */
export function playlistServerId() {
  const vch = getChannel(state.myVoice?.channelId);
  return vch?.serverId || state.currentServerId || null;
}
const canUseMusic = () => {
  const s = getServer(playlistServerId());
  return !!s && can(s, 'USE_MUSIC_BOT');
};

function setError(text) { $('#pl-error').textContent = text || ''; }

const isPlaylistsTab = () => $('#modal-music')?.open && !$('#music-panel-playlists').hidden;

/** Элемент MusicState (трек или «ожидающий» элемент очереди) → элемент плейлиста для REST */
export function itemFromState(t) {
  if (!t) return null;
  if (t.pending) return t.ref ? { pending: true, title: t.title, artist: t.artist, duration: t.duration, source: t.source, ref: t.ref } : null;
  return t.id ? { trackId: t.id } : null;
}

/* ---------- вкладки ---------- */
export function showMusicTab(tab) {
  const pls = tab === 'playlists';
  document.querySelectorAll('#modal-music [data-music-tab]').forEach((b) => {
    const on = b.dataset.musicTab === tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('#music-panel-library').hidden = pls;
  $('#music-panel-playlists').hidden = !pls;
  if (pls) { setError(''); showBrowse(); loadLists(); }
}

/* ---------- список ---------- */
async function loadLists() {
  const sid = playlistServerId();
  const box = $('#pl-list');
  if (!sid) { box.replaceChildren(h('p', { class: 'track-list__empty' }, 'Откройте сервер, чтобы увидеть его плейлисты.')); return; }
  if (!lists.length) box.replaceChildren(h('p', { class: 'track-list__empty' }, 'Загрузка…'));
  try {
    lists = (await api.playlists(sid)).playlists || [];
    renderLists();
  } catch (e) {
    lists = [];
    box.replaceChildren(h('p', { class: 'track-list__empty' }, e.message));
  }
}

function plMeta(pl) {
  return [tracksText(pl.count), pl.duration ? fmtDuration(pl.duration) : null, `создал ${pl.createdBy?.username || '?'}`].filter(Boolean).join(' · ');
}

async function playPl(pl, shuffle, btn) {
  if (btn) btn.disabled = true;
  if (await command('playlist', `id:${pl.id}${shuffle ? ' shuffle' : ''}`)) toastOk(`Плейлист «${pl.name}»${shuffle ? ' вперемешку' : ''} — в очереди`);
  if (btn) btn.disabled = false;
}

function renderLists() {
  const box = $('#pl-list');
  const allowed = canUseMusic();
  $('#form-pl-create').querySelectorAll('input, button').forEach((el) => { el.disabled = !allowed; });
  if (!lists.length) {
    box.replaceChildren(h('p', { class: 'track-list__empty' }, 'Плейлистов пока нет. Введите название и нажмите «Создать» или сохраните текущую очередь.'));
    return;
  }
  box.replaceChildren(...lists.map((pl) => h('div', { class: 'track playlist', dataset: { playlistId: pl.id } },
    h('button', { type: 'button', class: 'playlist__open', dataset: { plOpen: pl.id }, title: 'Открыть плейлист', onclick: () => openDetail(pl.id) },
      h('span', { class: 'track__info' },
        h('span', { class: 'track__title' }, pl.name),
        h('span', { class: 'track__artist' }, plMeta(pl)))),
    h('button', {
      type: 'button', class: 'icon-btn', dataset: { plShuffle: pl.id }, disabled: !allowed || !pl.count,
      'aria-label': `Включить «${pl.name}» вперемешку`, title: 'Вперемешку', onclick: (e) => playPl(pl, true, e.currentTarget),
    }, icon('i-shuffle')),
    h('button', {
      type: 'button', class: 'icon-btn', dataset: { plPlay: pl.id, play: '' }, disabled: !allowed || !pl.count,
      'aria-label': `Включить «${pl.name}»`, title: 'Включить', onclick: (e) => playPl(pl, false, e.currentTarget),
    }, icon('i-play')))));
}

function showBrowse() {
  openPl = null;
  $('#pl-browse').hidden = false;
  $('#pl-detail').hidden = true;
}

/* ---------- открытый плейлист ---------- */
async function openDetail(pid) {
  setError('');
  try {
    const { playlist } = await api.playlist(playlistServerId(), pid);
    openPl = playlist;
    $('#pl-browse').hidden = true;
    $('#pl-detail').hidden = false;
    $('#form-pl-rename').hidden = true;
    renderDetail();
  } catch (e) { setError(e.message); }
}

function renderDetail() {
  const pl = openPl;
  if (!pl) return;
  $('#pl-detail-name').textContent = pl.name;
  $('#pl-detail-meta').textContent = plMeta(pl) + (pl.canEdit ? '' : ' · менять может автор или администратор');
  const allowed = canUseMusic();
  $('#btn-pl-detail-play').disabled = !allowed || !pl.count;
  $('#btn-pl-detail-shuffle').disabled = !allowed || !pl.count;
  $('#btn-pl-rename').hidden = !pl.canEdit;
  $('#btn-pl-delete').hidden = !pl.canEdit;
  $('#pl-add').hidden = !pl.canEdit;
  const cur = music.currentState()?.track;
  $('#btn-pl-add-current').disabled = !cur?.id;
  $('#btn-pl-add-current').title = cur?.id ? `Добавить «${cur.title}»` : 'Сейчас ничего не играет';
  const list = $('#pl-items');
  list.classList.toggle('is-readonly', !pl.canEdit);
  if (!pl.items.length) {
    list.replaceChildren(h('li', { class: 'queue-item queue-item--more' }, 'Плейлист пуст. Добавьте трек: «Сейчас играет», ссылка, или «+» у трека в библиотеке и очереди.'));
    return;
  }
  const n = pl.items.length;
  const btn = (kind, ic, label, disabled) => h('button', {
    type: 'button', class: 'icon-btn', dataset: { p: kind }, 'aria-label': label, title: label, disabled: disabled || !pl.canEdit,
  }, icon(ic));
  list.replaceChildren(...pl.items.map((it, i) => h('li', {
    class: 'queue-item' + (it.ready ? '' : ' is-pending'), dataset: { iid: it.iid, pos: String(i + 1) },
  },
  h('span', { class: 'queue-item__n' }, String(i + 1)),
  coverArt(it.cover, { size: 'sm', cls: 'queue-item__cover' }),
  h('div', { class: 'queue-item__info' },
    h('div', { class: 'queue-item__title' }, it.title || 'Без названия'),
    h('div', { class: 'queue-item__meta' }, [it.artist || null, it.ready ? null : 'скачается перед воспроизведением'].filter(Boolean).join(' · '))),
  h('span', { class: 'queue-item__dur' }, it.duration ? fmtDuration(it.duration) : '—'),
  pl.canEdit ? h('div', { class: 'queue-item__actions' },
    btn('up', 'i-chevron-right', `Выше: «${it.title}»`, i === 0),
    btn('down', 'i-chevron-right', `Ниже: «${it.title}»`, i === n - 1),
    btn('remove', 'i-trash', `Убрать из плейлиста «${it.title}»`, false)) : null)));
}

async function detailAction(fn) {
  setError('');
  try {
    const r = await fn();
    if (r?.playlist) { openPl = r.playlist; renderDetail(); }
    return r;
  } catch (e) { setError(e.message); return null; }
}

/* ---------- «В плейлист» ---------- */
export async function openPlaylistPicker(item, label) {
  const sid = playlistServerId();
  if (!item) { toastError(new Error('Этот трек нельзя добавить в плейлист')); return; }
  if (!sid) { toastError(new Error('Откройте сервер')); return; }
  pickItem = item;
  $('#pl-pick-track').textContent = label ? `Трек: ${label}` : '';
  $('#pl-pick-error').textContent = '';
  const box = $('#pl-pick-list');
  box.replaceChildren(h('p', { class: 'track-list__empty' }, 'Загрузка…'));
  openModal('modal-pl-pick');
  try {
    lists = (await api.playlists(sid)).playlists || [];
  } catch (e) { box.replaceChildren(h('p', { class: 'track-list__empty' }, e.message)); return; }
  const mine = lists.filter((p) => p.canEdit);
  if (!mine.length) { box.replaceChildren(h('p', { class: 'track-list__empty' }, 'Нет плейлистов, которые вы можете менять. Создайте новый:')); return; }
  box.replaceChildren(...mine.map((pl) => h('button', {
    type: 'button', class: 'pl-pick', dataset: { pickId: pl.id },
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await api.playlistAdd(sid, pl.id, pickItem.trackId ? { trackId: pickItem.trackId } : { item: pickItem });
        toastOk(`Добавлено в «${pl.name}»`);
        closeModal('modal-pl-pick');
      } catch (ex) { $('#pl-pick-error').textContent = ex.message; b.disabled = false; }
    },
  }, h('span', { class: 'pl-pick__name' }, pl.name), h('span', { class: 'pl-pick__meta' }, tracksText(pl.count)))));
}

/* ---------- инициализация ---------- */
export function initPlaylists({ command: cmd, on }) {
  command = cmd;
  document.querySelectorAll('#modal-music [data-music-tab]').forEach((b) => b.addEventListener('click', () => showMusicTab(b.dataset.musicTab)));
  $('#modal-music').addEventListener('close', () => showMusicTab('library'));

  $('#form-pl-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#pl-name-input');
    const name = input.value.trim();
    if (!name) { setError('Введите название плейлиста'); input.focus(); return; }
    setError('');
    try {
      const { playlist } = await api.playlistCreate(playlistServerId(), { name });
      input.value = '';
      toastOk(`Плейлист «${playlist.name}» создан`);
      await loadLists();
      openDetail(playlist.id);
    } catch (ex) { setError(ex.message); }
  });

  $('#btn-pl-save-queue').addEventListener('click', async () => {
    const ms = music.currentState();
    const items = [ms?.track, ...(ms?.queue || [])].map(itemFromState).filter(Boolean);
    if (!items.length) { setError('Очередь пуста — сохранять нечего. Зайдите в голосовой канал и включите треки.'); return; }
    const input = $('#pl-name-input');
    const d = new Date();
    const name = input.value.trim() || `Очередь ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    setError('');
    try {
      const { playlist } = await api.playlistCreate(playlistServerId(), { name, items });
      input.value = '';
      toastOk(`Очередь сохранена: «${playlist.name}» (${tracksText(playlist.count)})`);
      loadLists();
    } catch (ex) { setError(ex.message); }
  });

  $('#btn-pl-back').addEventListener('click', () => { showBrowse(); loadLists(); });
  $('#btn-pl-detail-play').addEventListener('click', (e) => openPl && playPl(openPl, false, e.currentTarget));
  $('#btn-pl-detail-shuffle').addEventListener('click', (e) => openPl && playPl(openPl, true, e.currentTarget));
  $('#btn-pl-rename').addEventListener('click', () => {
    $('#form-pl-rename').hidden = false;
    $('#pl-rename-input').value = openPl?.name || '';
    $('#pl-rename-input').focus();
  });
  $('#btn-pl-rename-cancel').addEventListener('click', () => { $('#form-pl-rename').hidden = true; });
  $('#form-pl-rename').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!openPl) return;
    const r = await detailAction(() => api.playlistPatch(playlistServerId(), openPl.id, { name: $('#pl-rename-input').value }));
    if (r) $('#form-pl-rename').hidden = true;
  });
  $('#btn-pl-delete').addEventListener('click', async () => {
    const pl = openPl;
    if (!pl) return;
    const ok = await confirmDialog({ title: 'Удалить плейлист?', text: `Плейлист «${pl.name}» (${tracksText(pl.count)}) будет удалён. Треки останутся в библиотеке.`, ok: 'Удалить' });
    if (!ok) return;
    showBrowse(); // до ответа: событие music:playlists не должно перезапрашивать удалённый плейлист
    try {
      await api.playlistDelete(playlistServerId(), pl.id);
      toastOk(`Плейлист «${pl.name}» удалён`);
    } catch (ex) { setError(ex.message); }
    loadLists();
  });
  $('#btn-pl-add-current').addEventListener('click', () => {
    const it = itemFromState(music.currentState()?.track);
    if (!openPl || !it) return;
    detailAction(() => api.playlistAdd(playlistServerId(), openPl.id, it));
  });
  $('#form-pl-add-url').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#pl-url-input');
    const url = input.value.trim();
    if (!openPl || !url) return;
    const b = e.target.querySelector('button');
    b.disabled = true;
    b.textContent = 'Загрузка…';
    const r = await detailAction(() => api.playlistAdd(playlistServerId(), openPl.id, { url }));
    b.disabled = false;
    b.textContent = 'Добавить';
    if (r) { input.value = ''; toastOk(`Добавлено: ${tracksText(r.added)}`); }
  });
  $('#pl-items').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    const li = b?.closest('.queue-item');
    if (!li || b.disabled || !openPl) return;
    const sid = playlistServerId();
    const pos = Number(li.dataset.pos);
    if (b.dataset.p === 'remove') detailAction(() => api.playlistRemoveItem(sid, openPl.id, li.dataset.iid));
    else detailAction(() => api.playlistPatch(sid, openPl.id, { move: { iid: li.dataset.iid, to: b.dataset.p === 'up' ? pos - 1 : pos + 1 } }));
  });

  $('#form-pl-pick-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#pl-pick-name').value.trim();
    if (!name || !pickItem) { $('#pl-pick-error').textContent = 'Введите название плейлиста'; return; }
    try {
      const { playlist } = await api.playlistCreate(playlistServerId(), { name, items: [pickItem] });
      $('#pl-pick-name').value = '';
      toastOk(`Добавлено в новый плейлист «${playlist.name}»`);
      closeModal('modal-pl-pick');
    } catch (ex) { $('#pl-pick-error').textContent = ex.message; }
  });

  // кто-то изменил плейлисты сервера — обновляем открытую вкладку
  on('music:playlists', ({ serverId } = {}) => {
    if (serverId !== playlistServerId() || !isPlaylistsTab()) return;
    if (openPl) {
      api.playlist(serverId, openPl.id).then(({ playlist }) => { openPl = playlist; renderDetail(); }, () => { showBrowse(); loadLists(); });
    } else loadLists();
  });
}
