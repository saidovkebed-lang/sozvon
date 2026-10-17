// Окно «Демонстрация экрана» (#modal-stream, SPEC-v3 §2.4): качество 720p30 / 1080p60 / Исходное,
// звук экрана, в приложении для ПК — выбор экрана/окна с превью (window.sozvonDesktop.getScreenSources).
// Выбор запоминается в prefs ('stream.quality', 'stream.audio').
import { $, $$, h, icon } from '../util.js';
import { state } from '../state.js';
import { prefs } from '../prefs.js';
import { openModal, closeModal } from './modals.js';
import { startScreen, setStreamQuality, STREAM_QUALITY } from '../voice/voice.js';
import { getServer, getChannel } from '../state.js';
import { can } from '../perms.js';
import { toast } from './toasts.js';

let wired = false;
let sources = [];
let sourceType = 'screen';
let selectedSource = null;
let loadSeq = 0;

const D = () => (window.sozvonDesktop?.isDesktop ? window.sozvonDesktop : null);

function syncQuality() {
  const q = prefs.get('stream.quality');
  $$('#stream-quality input[name=stream-quality]').forEach((r) => { r.checked = r.value === q; });
  if (!$$('#stream-quality input:checked').length) $('#stream-quality input[value="720p30"]').checked = true;
  $('#stream-audio').checked = !!prefs.get('stream.audio');
}

function renderSources() {
  const grid = $('#source-grid');
  const list = sources.filter((s) => s.type === sourceType);
  $$('#stream-source-tabs .tab').forEach((t) => {
    const on = t.dataset.sourceType === sourceType;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  if (!list.length) {
    grid.replaceChildren(h('p', { class: 'source-grid__empty' }, sources.length ? 'Нет доступных окон' : 'Загружаю источники…'));
    return;
  }
  if (!list.some((s) => s.id === selectedSource)) selectedSource = list[0].id;
  grid.replaceChildren(...list.map((s) => h('button', {
    type: 'button', class: 'source-card' + (s.id === selectedSource ? ' is-selected' : ''), role: 'option',
    'aria-selected': String(s.id === selectedSource), dataset: { sourceId: s.id }, title: s.name,
    onclick: () => { selectedSource = s.id; renderSources(); },
    ondblclick: () => { selectedSource = s.id; start(); },
  },
  h('span', { class: 'source-card__thumb' }, /^data:image\//.test(s.thumbnail || '') ? h('img', { src: s.thumbnail, alt: '' }) : icon(s.type === 'screen' ? 'i-monitor' : 'i-window')),
  h('span', { class: 'source-card__name' },
    /^data:image\//.test(s.appIcon || '') ? h('img', { class: 'source-card__app', src: s.appIcon, alt: '' }) : icon(s.type === 'screen' ? 'i-monitor' : 'i-window', 'icon--sm'),
    h('span', null, s.name)))));
}

async function loadSources() {
  const d = D();
  if (!d?.getScreenSources) return;
  const seq = ++loadSeq;
  sources = [];
  renderSources();
  let list = [];
  try { list = await d.getScreenSources({ types: ['screen', 'window'], thumbnailWidth: 320, thumbnailHeight: 180 }); } catch { list = []; }
  if (seq !== loadSeq) return;
  sources = Array.isArray(list) ? list : [];
  if (!sources.some((s) => s.type === sourceType) && sources.length) sourceType = sources[0].type;
  renderSources();
}

async function start() {
  const quality = $('#stream-quality input:checked')?.value || '720p30';
  const audio = $('#stream-audio').checked;
  prefs.set('stream.quality', quality);
  prefs.set('stream.audio', audio);
  if (state.streaming) {
    await setStreamQuality(quality);
    closeModal('modal-stream');
    toast(`Качество демонстрации: ${STREAM_QUALITY[quality].label}`, 'ok', 2000);
    return;
  }
  if (D() && !selectedSource) { toast('Выберите экран или окно'); return; }
  const btn = $('#btn-stream-start');
  btn.disabled = true;
  closeModal('modal-stream');
  try { await startScreen({ quality, audio, sourceId: D() ? selectedSource : null }); } finally { btn.disabled = false; }
}

function wire() {
  if (wired) return;
  wired = true;
  $('#btn-stream-start').addEventListener('click', start);
  $('#stream-source-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-source-type]');
    if (!t) return;
    sourceType = t.dataset.sourceType;
    renderSources();
  });
  $('#modal-stream').addEventListener('close', () => { loadSeq++; });
}

export function openStreamModal() {
  if (!state.myVoice) return;
  const ch = getChannel(state.myVoice.channelId);
  const srv = getServer(ch?.serverId);
  if (srv && !can(srv, 'STREAM', ch?.id)) { toast('Нет права на демонстрацию экрана в этом канале'); return; }
  wire();
  syncQuality();
  const live = !!state.streaming;
  const desktop = !!D();
  $('#stream-sources').hidden = live || !desktop;
  $('#stream-live-note').hidden = !live;
  $('#stream-audio').closest('.setting').hidden = live;
  $('#modal-stream-title').textContent = live ? 'Качество демонстрации' : 'Демонстрация экрана';
  $('#btn-stream-start').lastElementChild.textContent = live ? 'Применить' : 'Начать демонстрацию';
  // в браузере звук системы доступен только Chrome/Edge и не для всех источников
  $('#stream-audio-desc').textContent = desktop
    ? (window.sozvonDesktop.platform === 'win32' ? 'Передавать звук системы вместе с картинкой.' : 'Звук системы доступен только в Windows — на этой системе демонстрация будет без звука.')
    : 'Передавать звук вкладки или системы (браузер спросит при выборе экрана).';
  openModal('modal-stream');
  if (!live && desktop) loadSources();
  ($('#stream-quality input:checked') || $('#btn-stream-start')).focus();
}

export function initStream() {
  $('#ctrl-screen-opts')?.addEventListener('click', () => openStreamModal());
}
