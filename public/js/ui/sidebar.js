// Сайдбар: заголовок сервера, инвайт, каналы, участники голоса, voice-panel, user-panel
import { $, h, icon, avatar, setIcon, safeColor, firstLetter } from '../util.js';
import { state, subscribe, getServer, getChannel, isOwner, upsertServer, notify } from '../state.js';
import { emitAck } from '../socket.js';
import { selectChannel, sortedChannels } from '../nav.js';
import { openModal, closeModal, setModalError, confirmDialog } from './modals.js';
import { toast, toastOk, toastError } from './toasts.js';
import { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreen, toggleCamera } from '../voice/voice.js';

export function voiceUserEl(m) {
  const badges = h('div', { class: 'voice-user__badges' });
  if (m.isBot) badges.append(h('span', { class: 'badge badge--bot' }, 'БОТ'));
  if (m.deafened) badges.append(icon('i-headphones-off', 'icon--sm'));
  else if (m.muted) badges.append(icon('i-mic-off', 'icon--sm'));
  if (m.camera) badges.append(icon('i-camera', 'icon--sm'));
  if (m.streaming) badges.append(h('span', { class: 'badge badge--live' }, 'LIVE'));
  return h('div', {
    class: 'voice-user' + (state.speaking.has(m.socketId) ? ' is-speaking' : '') + (m.isBot ? ' voice-user--bot' : ''),
    dataset: { socketId: m.socketId, userId: m.userId },
  }, avatar({ username: m.username, color: m.color }, 'sm'), h('span', { class: 'voice-user__name' }, m.username), badges);
}

function channelEl(ch, owner) {
  const active = ch.id === state.currentChannelId;
  const inVoice = state.myVoice?.channelId === ch.id;
  const a = h('a', {
    class: 'channel' + (active ? ' is-active' : '') + (inVoice ? ' is-connected' : ''),
    href: '#',
    dataset: { channelId: ch.id, type: ch.type },
    'aria-current': active ? 'page' : null,
    title: ch.name,
  }, icon(ch.type === 'voice' ? 'i-volume' : 'i-hash'), h('span', { class: 'channel__name' }, ch.name));
  if (owner) {
    a.append(h('button', {
      type: 'button',
      class: 'icon-btn channel__delete',
      'aria-label': `Удалить канал ${ch.name}`,
      title: 'Удалить канал',
      dataset: { deleteChannel: ch.id },
    }, icon('i-trash', 'icon--sm')));
  }
  return a;
}

function renderChannels() {
  const box = $('#channels');
  const server = getServer();
  if (!server) {
    box.replaceChildren(h('p', { class: 'sidebar__empty' }, 'Выбери сервер слева или создай новый'));
    return;
  }
  const owner = isOwner(server);
  const groups = [
    { type: 'text', title: 'Текстовые каналы' },
    { type: 'voice', title: 'Голосовые каналы' },
  ];
  const chans = sortedChannels(server);
  box.replaceChildren(...groups.map((g) => {
    const header = h('div', { class: 'channel-group__header' }, h('span', null, g.title));
    if (owner) {
      header.append(h('button', {
        type: 'button',
        class: 'icon-btn',
        dataset: { addChannel: g.type },
        'aria-label': g.type === 'text' ? 'Создать текстовый канал' : 'Создать голосовой канал',
        title: 'Создать канал',
      }, icon('i-plus', 'icon--sm')));
    }
    const items = [];
    for (const ch of chans.filter((c) => c.type === g.type)) {
      items.push(channelEl(ch, owner));
      if (ch.type === 'voice') {
        const members = state.voice[ch.id] || [];
        items.push(h('div', { class: 'voice-users', dataset: { channelId: ch.id } }, members.map(voiceUserEl)));
      }
    }
    return h('div', { class: 'channel-group', dataset: { group: g.type } }, header, items);
  }));
}

function renderHeader() {
  const server = getServer();
  $('#server-name').textContent = server ? server.name : 'Созвон';
  $('#btn-server-menu').hidden = !server;
  $('#invite-box').hidden = !server;
  $('#invite-code').textContent = server ? server.inviteCode : '';
}

function renderUserPanel() {
  const u = state.user;
  if (!u) return;
  const av = $('#me-avatar');
  av.style.setProperty('--c', safeColor(u.color));
  av.textContent = firstLetter(u.username);
  $('#me-name').textContent = u.username;
  $('#me-tag').textContent = state.myVoice ? 'в голосовом' : (state.connected ? 'в сети' : 'нет связи');
  const muted = state.muted || state.deafened;
  for (const id of ['#btn-mute', '#ctrl-mute']) {
    const b = $(id);
    b.classList.toggle('is-on', muted);
    b.setAttribute('aria-pressed', String(muted));
    b.setAttribute('aria-label', muted ? 'Включить микрофон' : 'Выключить микрофон');
    setIcon(b.querySelector('svg'), muted ? 'i-mic-off' : 'i-mic');
  }
  for (const id of ['#btn-deafen', '#ctrl-deafen']) {
    const b = $(id);
    b.classList.toggle('is-on', state.deafened);
    b.setAttribute('aria-pressed', String(state.deafened));
    b.setAttribute('aria-label', state.deafened ? 'Включить звук' : 'Выключить звук');
    setIcon(b.querySelector('svg'), state.deafened ? 'i-headphones-off' : 'i-headphones');
  }
  for (const id of ['#btn-screen', '#ctrl-screen']) {
    const b = $(id);
    b.classList.toggle('is-on', state.streaming);
    b.setAttribute('aria-pressed', String(state.streaming));
    b.setAttribute('aria-label', state.streaming ? 'Остановить демонстрацию' : 'Демонстрация экрана');
  }
  for (const id of ['#btn-camera', '#ctrl-camera']) {
    const b = $(id);
    b.classList.toggle('is-on', state.camera);
    b.setAttribute('aria-pressed', String(state.camera));
    b.setAttribute('aria-label', state.camera ? 'Выключить камеру' : 'Включить камеру');
    setIcon(b.querySelector('svg'), state.camera ? 'i-camera-off' : 'i-camera');
  }
  // voice-panel
  const vp = $('#voice-panel');
  vp.hidden = !state.myVoice;
  if (state.myVoice) {
    const ch = getChannel(state.myVoice.channelId);
    const srv = getServer(state.myVoice.serverId);
    $('#voice-panel-channel').textContent = [ch?.name, srv?.name].filter(Boolean).join(' / ');
  }
}

function updateSpeaking() {
  document.querySelectorAll('.voice-user[data-socket-id]').forEach((el) => {
    el.classList.toggle('is-speaking', state.speaking.has(el.dataset.socketId));
  });
}

/* ---------- модалки каналов и настроек ---------- */
function openChannelModal(type = 'text') {
  const dlg = $('#modal-channel');
  const form = $('#form-channel');
  form.reset();
  form.querySelector(`input[name=type][value=${type}]`).checked = true;
  openModal(dlg);
  $('#channel-name-input').focus();
}

function openSettings() {
  const server = getServer();
  if (!server) return;
  const dlg = $('#modal-settings');
  const owner = isOwner(server);
  dlg.querySelectorAll('[data-owner-only]').forEach((e) => { e.hidden = !owner; });
  dlg.querySelectorAll('[data-member-only]').forEach((e) => { e.hidden = owner; });
  $('#server-rename-input').value = server.name;
  $('#server-rename-input').required = owner;
  $('#modal-settings-title').textContent = owner ? 'Настройки сервера' : server.name;
  openModal(dlg);
}

async function copyInvite() {
  const code = getServer()?.inviteCode;
  if (!code) return;
  // Публичная ссылка (npm run share) важнее локального адреса: по ней зайдут из любой сети
  const base = state.publicUrl || location.origin;
  const link = `${base}/?invite=${code}`;
  let ok = false;
  try {
    await navigator.clipboard.writeText(link);
    ok = true;
  } catch {
    // фолбэк для небезопасного контекста
    const ta = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true' });
    ta.value = link;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (ok) toastOk(state.publicUrl ? 'Ссылка-приглашение скопирована — отправь её друзьям' : `Ссылка-приглашение скопирована (код ${code})`);
  else toast(`Скопируй вручную: ${link}`, "", 8000);
}

export function initSidebar() {
  subscribe(['servers', 'nav', 'voice'], renderChannels);
  subscribe(['servers', 'nav'], renderHeader);
  subscribe(['me', 'voice', 'servers'], renderUserPanel);
  subscribe('speaking', updateSpeaking);

  $('#channels').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add-channel]');
    if (add) { openChannelModal(add.dataset.addChannel); return; }
    const del = e.target.closest('[data-delete-channel]');
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      const ch = getChannel(del.dataset.deleteChannel);
      if (!ch) return;
      const yes = await confirmDialog({ title: 'Удалить канал', text: `Канал «${ch.name}» и вся его история будут удалены.`, ok: 'Удалить' });
      if (!yes) return;
      try { await emitAck('channel:delete', { channelId: ch.id }); toastOk('Канал удалён'); } catch (ex) { toastError(ex); }
      return;
    }
    const a = e.target.closest('a.channel');
    if (!a) return;
    e.preventDefault();
    const id = a.dataset.channelId;
    selectChannel(id);
    if (a.dataset.type === 'voice' && state.myVoice?.channelId !== id) joinVoice(id);
  });

  $('#btn-copy-invite').addEventListener('click', copyInvite);
  $('#btn-server-menu').addEventListener('click', openSettings);

  $('#form-channel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dlg = $('#modal-channel');
    const server = getServer();
    const name = $('#channel-name-input').value.trim();
    const type = e.target.querySelector('input[name=type]:checked')?.value || 'text';
    if (!name) { setModalError(dlg, 'Введите название'); return; }
    try {
      const { channel } = await emitAck('channel:create', { serverId: server.id, name, type });
      if (channel && !server.channels.some((c) => c.id === channel.id)) server.channels.push(channel);
      closeModal(dlg);
      notify('servers');
      if (channel) selectChannel(channel.id);
    } catch (ex) { setModalError(dlg, ex.message); }
  });

  $('#form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dlg = $('#modal-settings');
    const server = getServer();
    const name = $('#server-rename-input').value.trim();
    if (!server || !name) return;
    try {
      await emitAck('server:rename', { serverId: server.id, name });
      server.name = name;
      upsertServer(server);
      notify('servers');
      closeModal(dlg);
    } catch (ex) { setModalError(dlg, ex.message); }
  });

  $('#btn-server-delete').addEventListener('click', async () => {
    const server = getServer();
    if (!server) return;
    closeModal('modal-settings');
    const yes = await confirmDialog({ title: 'Удалить сервер', text: `Сервер «${server.name}» будет удалён для всех участников. Это нельзя отменить.`, ok: 'Удалить' });
    if (!yes) return;
    try { await emitAck('server:delete', { serverId: server.id }); } catch (ex) { toastError(ex); }
  });

  $('#btn-server-leave').addEventListener('click', async () => {
    const server = getServer();
    if (!server) return;
    closeModal('modal-settings');
    const yes = await confirmDialog({ title: 'Покинуть сервер', text: `Покинуть «${server.name}»? Вернуться можно по инвайт-коду.`, ok: 'Покинуть' });
    if (!yes) return;
    try { await emitAck('server:leave', { serverId: server.id }); } catch (ex) { toastError(ex); }
  });

  // голосовые кнопки
  $('#btn-mute').addEventListener('click', toggleMute);
  $('#btn-deafen').addEventListener('click', toggleDeafen);
  $('#btn-screen').addEventListener('click', toggleScreen);
  $('#btn-camera').addEventListener('click', toggleCamera);
  $('#btn-disconnect').addEventListener('click', () => leaveVoice());
  $('#voice-panel-channel').addEventListener('click', () => { if (state.myVoice) selectChannel(state.myVoice.channelId); });
}
