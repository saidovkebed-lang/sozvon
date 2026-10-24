// Сайдбар: заголовок сервера, инвайт, каналы, участники голоса, voice-panel, user-panel
import { $, h, icon, avatar, setIcon, safeColor, firstLetter, displayName, setAvatarImage, safeMediaUrl } from '../util.js';
import { state, subscribe, getServer, getChannel, notify, findUser, presenceOf, activeCustomStatus, STATUS_LABELS } from '../state.js';
import { can, roleColor, isPrivateChannel } from '../perms.js';
import { openChannelSettings } from './server-settings.js';
import { emitAck } from '../socket.js';
import { selectChannel, sortedChannels } from '../nav.js';
import { openModal, closeModal, setModalError, confirmDialog } from './modals.js';
import { statusDot } from './members.js';
import { toast, toastOk, toastError } from './toasts.js';
import { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreen, toggleCamera } from '../voice/voice.js';
import { prefs } from '../prefs.js';
import { moreButton, volumeBadge } from './context-menu.js';
import { renderDmSidebar } from './dms.js';

export function voiceUserEl(m) {
  const badges = h('div', { class: 'voice-user__badges' });
  if (m.isBot) badges.append(h('span', { class: 'badge badge--bot' }, 'БОТ'));
  if (m.serverDeafen) badges.append(svgTitled(icon('i-headphones-off', 'icon--sm is-server'), 'Звук отключён модератором'));
  else if (m.deafened) badges.append(icon('i-headphones-off', 'icon--sm'));
  else if (m.serverMute) badges.append(svgTitled(icon('i-mic-off', 'icon--sm is-server'), 'Микрофон отключён модератором'));
  else if (m.muted) badges.append(icon('i-mic-off', 'icon--sm'));
  if (m.camera) badges.append(icon('i-camera', 'icon--sm'));
  if (m.streaming) badges.append(h('span', { class: 'badge badge--live' }, 'LIVE'));
  const vb = volumeBadge(m.userId, m.isBot);
  if (vb) badges.prepend(vb);
  const self = !!state.user && m.userId === state.user.id;
  const u = { ...m, ...(findUser(m.userId) || {}), id: m.userId };
  const color = m.isBot ? null : roleColor(getServer(), m.userId);
  const el = h('div', {
    class: 'voice-user' + (state.speaking.has(m.socketId) ? ' is-speaking' : '') + (m.isBot ? ' voice-user--bot' : '') + (self ? ' voice-user--self' : ''),
    dataset: { socketId: m.socketId, userId: m.userId },
    tabindex: '-1',
  }, avatar(u, 'sm'), h('span', { class: 'voice-user__name', style: color ? { color } : null }, displayName(u)), badges);
  if (!self) el.append(moreButton(displayName(u)));
  return el;
}

function svgTitled(svg, text) {
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  t.textContent = text;
  svg.prepend(t);
  svg.removeAttribute('aria-hidden');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', text);
  return svg;
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
  }, icon(isPrivateChannel(getServer(ch.serverId), ch.id) ? (ch.type === 'voice' ? 'i-volume-lock' : 'i-hash-lock') : (ch.type === 'voice' ? 'i-volume' : 'i-hash')),
  h('span', { class: 'channel__name' }, ch.name));
  if (owner) {
    a.append(h('button', {
      type: 'button',
      class: 'icon-btn channel__edit',
      'aria-label': `Настройки канала ${ch.name}`,
      title: 'Настройки канала',
      dataset: { editChannel: ch.id },
    }, icon('i-settings', 'icon--sm')));
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
  if (!server) { renderDmSidebar(box); return; }
  const owner = can(server, 'MANAGE_CHANNELS');
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
        const watching = state.watch?.[ch.id]?.video; // «Смотреть вместе» (ui/watch.js)
        if (watching) items.push(h('div', { class: 'channel-watch', dataset: { channelId: ch.id }, title: watching.title }, icon('i-monitor', 'icon--sm'), h('span', null, `Сейчас смотрим: ${watching.title}`)));
      }
    }
    return h('div', { class: 'channel-group', dataset: { group: g.type } }, header, items);
  }));
}

function renderHeader() {
  const server = getServer();
  $('#server-name').textContent = server ? server.name : 'Личные сообщения';
  $('#btn-server-menu').hidden = !server;
  const banner = safeMediaUrl(server?.banner);
  const head = $('.sidebar__header');
  head.classList.toggle('has-banner', !!banner);
  if (banner) head.style.setProperty('--server-banner', `url("${banner.replace(/"/g, '%22')}")`); else head.style.removeProperty('--server-banner');
  $('#invite-box').hidden = !server?.inviteCode;
  $('#invite-code').textContent = server?.inviteCode || '';
}

function renderUserPanel() {
  const u = state.user;
  if (!u) return;
  const av = $('#me-avatar');
  av.style.setProperty('--c', safeColor(u.color));
  const st = presenceOf(u);
  if (!av.firstChild || av.firstChild.nodeType !== 3) av.prepend(firstLetter(u.username));
  else av.firstChild.textContent = firstLetter(u.username);
  setAvatarImage(av, u);
  let dot = av.querySelector('.avatar__status');
  if (!dot) { dot = statusDot(st); av.append(dot); }
  dot.dataset.status = state.connected ? (u.status === 'invisible' ? 'invisible' : st) : 'offline';
  av.setAttribute('aria-label', `Статус: ${STATUS_LABELS[u.status || 'online']}. Сменить`);
  $('#me-name').textContent = displayName(u);
  const cs = activeCustomStatus(u);
  $('#me-tag').textContent = !state.connected ? 'нет связи'
    : state.myVoice ? 'в голосовом'
      : cs ? [cs.emoji, cs.text].filter(Boolean).join(' ')
        : (u.status && u.status !== 'online' ? STATUS_LABELS[u.status].toLowerCase() : 'в сети');
  const muted = state.muted || state.deafened || state.serverMuted || state.serverDeafened;
  for (const id of ['#btn-mute', '#ctrl-mute']) {
    const b = $(id);
    b.classList.toggle('is-on', muted);
    b.setAttribute('aria-pressed', String(muted));
    b.setAttribute('aria-label', muted ? 'Включить микрофон' : 'Выключить микрофон');
    setIcon(b.querySelector('svg'), muted ? 'i-mic-off' : 'i-mic');
  }
  for (const id of ['#btn-deafen', '#ctrl-deafen']) {
    const b = $(id);
    const deaf = state.deafened || state.serverDeafened;
    b.classList.toggle('is-on', deaf);
    b.setAttribute('aria-pressed', String(deaf));
    b.setAttribute('aria-label', deaf ? 'Включить звук' : 'Выключить звук');
    setIcon(b.querySelector('svg'), deaf ? 'i-headphones-off' : 'i-headphones');
  }
  for (const id of ['#btn-mute', '#ctrl-mute']) {
    $(id).classList.toggle('is-server', !!state.serverMuted);
    $(id).title = state.serverMuted ? 'Микрофон отключён модератором' : 'Микрофон';
  }
  // права на стрим/камеру в текущем голосовом канале
  const vch = state.myVoice ? getChannel(state.myVoice.channelId) : null;
  const vsrv = vch ? getServer(vch.serverId) : null;
  const canStream = !vsrv || can(vsrv, 'STREAM', vch.id);
  for (const id of ['#btn-screen', '#ctrl-screen', '#btn-camera', '#ctrl-camera', '#ctrl-screen-opts']) {
    const b = $(id);
    if (!b) continue;
    const on = b.classList.contains('is-on');
    b.disabled = !canStream && !on;
    if (!canStream && !on) b.title = 'Нет права на видео и демонстрацию';
    else if (id.includes('screen') && !id.includes('opts')) b.title = 'Демонстрация экрана';
    else if (id.includes('camera')) b.title = 'Камера';
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
  subscribe(['servers', 'nav', 'voice', 'profile', 'dms', 'presence', 'watch'], renderChannels);
  subscribe(['servers', 'nav'], renderHeader);
  subscribe(['me', 'voice', 'servers', 'presence', 'profile'], renderUserPanel);
  subscribe('speaking', updateSpeaking);
  // индикатор громкости/заглушения у .voice-user
  prefs.subscribe('audio.userVolumes', () => notify('voice'));
  prefs.subscribe('audio.userMuted', () => notify('voice'));

  $('#channels').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit-channel]');
    if (edit) { e.preventDefault(); e.stopPropagation(); openChannelSettings(edit.dataset.editChannel); return; }
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
    if (a.dataset.type === 'voice' && state.myVoice?.channelId !== id) {
      const srv = getServer(getChannel(id)?.serverId);
      if (srv && !can(srv, 'CONNECT', id)) { toast('Нет права подключаться к этому каналу', '', 3000); return; }
      joinVoice(id);
    }
  });

  $('#btn-copy-invite').addEventListener('click', copyInvite);

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

  // голосовые кнопки
  $('#btn-mute').addEventListener('click', toggleMute);
  $('#btn-deafen').addEventListener('click', toggleDeafen);
  $('#btn-screen').addEventListener('click', toggleScreen);
  $('#btn-camera').addEventListener('click', toggleCamera);
  $('#btn-disconnect').addEventListener('click', () => leaveVoice());
  $('#voice-panel-channel').addEventListener('click', () => { if (state.myVoice) selectChannel(state.myVoice.channelId); });
}
