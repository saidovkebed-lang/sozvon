// Колонка серверов + модалка «создать / войти по коду»
import { $, $$, h, initials, safeMediaUrl } from '../util.js';
import { state, subscribe, upsertServer, notify } from '../state.js';
import { emitAck } from '../socket.js';
import { selectServer } from '../nav.js';
import { openModal, closeModal, setModalError } from './modals.js';
import { toastOk } from './toasts.js';

function render() {
  const list = $('#servers-list');
  list.replaceChildren(...state.servers.map((s) => h('div', {
    class: 'servers__item' + (s.id === state.currentServerId ? ' is-active' : ''),
  }, h('button', {
    type: 'button',
    class: 'server-icon' + (s.id === state.currentServerId ? ' is-active' : ''),
    dataset: { serverId: s.id },
    title: s.name,
    'aria-label': s.name,
    'aria-current': s.id === state.currentServerId ? 'true' : null,
    onclick: () => selectServer(s.id),
  }, safeMediaUrl(s.icon) ? h('img', { src: safeMediaUrl(s.icon), alt: '' }) : initials(s.name)))));
  const home = $('#btn-home');
  home.classList.toggle('is-active', !state.currentServerId);
  home.closest('.servers__item').classList.toggle('is-active', !state.currentServerId);
}

function setTab(name) {
  const dlg = $('#modal-server');
  $$('.tab', dlg).forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $$('[data-tab-panel]', dlg).forEach((p) => { p.hidden = p.dataset.tabPanel !== name; });
  $('#modal-server-title').textContent = name === 'create' ? 'Создать сервер' : 'Войти по инвайт-коду';
  setModalError(dlg, '');
}

export function openServerModal(tab = 'create') {
  const dlg = $('#modal-server');
  $('#server-name-input').value = state.user ? `Сервер ${state.user.username}` : '';
  $('#invite-input').value = '';
  setTab(tab);
  openModal(dlg);
  (tab === 'create' ? $('#server-name-input') : $('#invite-input')).focus();
  if (tab === 'create') $('#server-name-input').select();
}

/** Принимает код или ссылку вида …?invite=abcd1234 / …/invite/abcd1234 */
function parseInvite(v) {
  const s = v.trim();
  const m = s.match(/(?:invite[=/])([a-z0-9]+)/i);
  return (m ? m[1] : s).toLowerCase();
}

export function initServers() {
  subscribe(['servers', 'nav'], render);
  $('#btn-add-server').addEventListener('click', () => openServerModal('create'));
  $('#btn-home').addEventListener('click', () => selectServer(null));
  $$('[data-open-server]').forEach((b) => b.addEventListener('click', () => openServerModal(b.dataset.openServer)));
  $$('#modal-server .tab').forEach((t) => t.addEventListener('click', () => {
    setTab(t.dataset.tab);
    (t.dataset.tab === 'create' ? $('#server-name-input') : $('#invite-input')).focus();
  }));

  $('#form-server-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dlg = $('#modal-server');
    const name = $('#server-name-input').value.trim();
    if (!name) { setModalError(dlg, 'Введите название'); return; }
    const btn = e.submitter || e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { server } = await emitAck('server:create', { name });
      upsertServer(server);
      notify('servers');
      closeModal(dlg);
      selectServer(server.id);
      toastOk(`Сервер «${server.name}» создан`);
    } catch (ex) {
      setModalError(dlg, ex.message);
    } finally { btn.disabled = false; }
  });

  $('#form-server-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dlg = $('#modal-server');
    const inviteCode = parseInvite($('#invite-input').value);
    if (!inviteCode) { setModalError(dlg, 'Введите инвайт-код'); return; }
    const btn = e.submitter || e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { server } = await emitAck('server:join', { inviteCode });
      upsertServer(server);
      notify('servers');
      closeModal(dlg);
      selectServer(server.id);
      toastOk(`Ты в «${server.name}»`);
    } catch (ex) {
      setModalError(dlg, ex.message);
    } finally { btn.disabled = false; }
  });
}
