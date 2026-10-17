// Текстовый чат: сообщения, группировка, история, typing, вложения, composer
import { $, h, icon, avatar, fmtDate, fmtClock, fmtSize, renderMarkdown, safeColor, displayName } from '../util.js';
import { state, subscribe, notify, getChannel, getServer, findUser } from '../state.js';
import { can, roleColor } from '../perms.js';
import { mentionsMe } from './notifications.js';
import { emit, emitAck } from '../socket.js';
import { api } from '../api.js';
import { loadHistory, isLoading } from '../nav.js';
import { toast, toastError } from './toasts.js';

const GROUP_MS = 5 * 60 * 1000;
const TYPING_SEND_MS = 2500;
const TYPING_SHOW_MS = 5000;
const MAX_FILE = 100 * 1024 * 1024; // v3: UPLOAD_LIMIT_MB=100

let renderedChannel = null;
let pending = [];            // [{id, file, att?, uploading, error}]
let pendingSeq = 0;
let lastTypingSent = 0;

const box = () => $('#messages');

function nearBottom(el = box()) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollBottom() {
  const el = box();
  el.scrollTop = el.scrollHeight;
}

function isGrouped(prev, m) {
  return !!prev && !prev.system && !m.system && prev.author?.id === m.author?.id &&
    m.createdAt - prev.createdAt < GROUP_MS;
}

function attachmentEl(att) {
  const isImg = typeof att.type === 'string' && att.type.startsWith('image/') && /^\/media\//.test(att.url);
  if (isImg) {
    const img = h('img', { class: 'message__image', src: att.url, alt: att.name || 'изображение', loading: 'lazy' });
    img.addEventListener('load', () => { if (img.dataset.stick === '1') scrollBottom(); });
    return h('a', { href: att.url, target: '_blank', rel: 'noopener', class: 'message__image-link' }, img);
  }
  const safeUrl = /^\/media\//.test(att.url) ? att.url : '#';
  return h('a', { class: 'file-card', href: safeUrl, target: '_blank', rel: 'noopener', download: att.name || '' },
    icon('i-attach'),
    h('div', { class: 'file-card__info' },
      h('span', { class: 'file-card__name' }, att.name || 'файл'),
      h('span', { class: 'file-card__size' }, fmtSize(att.size))));
}

function messageEl(m, prev) {
  const grouped = isGrouped(prev, m);
  const author = m.author || { username: '?', color: '#888' };
  const server = getServer(getChannel(m.channelId)?.serverId);
  // свежие данные профиля участника (аватар/имя меняются без перезагрузки истории)
  const fresh = author.id ? findUser(author.id, server) : null;
  const who = fresh ? { ...author, ...fresh } : author;
  const rc = !m.system && author.id ? roleColor(server, author.id) : null;
  const meta = h('div', { class: 'message__meta' },
    h('span', {
      class: 'message__author' + (rc ? ' has-role-color' : ''), style: { color: rc || safeColor(who.color) },
      role: m.system ? null : 'button', tabindex: m.system ? null : '0',
    }, displayName(who)),
    author.isBot ? h('span', { class: 'badge badge--bot' }, 'БОТ') : null,
    h('time', { class: 'message__time', datetime: new Date(m.createdAt).toISOString(), title: new Date(m.createdAt).toLocaleString('ru-RU') },
      grouped ? fmtClock(m.createdAt) : fmtDate(m.createdAt)));
  const body = h('div', { class: 'message__body' }, meta);
  if (m.content) body.append(h('div', { class: 'message__content' }, renderMarkdown(m.content)));
  if (m.attachments?.length) body.append(h('div', { class: 'message__attachments' }, m.attachments.map(attachmentEl)));
  const mentioned = !m.system && author.id !== state.user?.id && (m.mentionEveryone || mentionsMe(m.content));
  const el = h('div', {
    class: 'message' + (grouped ? ' message--grouped' : '') + (m.system ? ' message--system' : '') + (mentioned ? ' message--mention' : ''),
    dataset: { messageId: m.id, authorId: author.id || '' },
  }, avatar(who), body);
  const canDelete = !m.system && state.user && (author.id === state.user.id || can(server, 'MANAGE_MESSAGES', m.channelId));
  if (canDelete) {
    el.append(h('button', {
      type: 'button', class: 'icon-btn message__delete',
      'aria-label': 'Удалить сообщение', title: 'Удалить сообщение',
      dataset: { deleteMessage: m.id },
    }, icon('i-trash', 'icon--sm')));
  }
  return el;
}

function emptyEl(ch) {
  return h('div', { class: 'chat__empty' },
    icon('i-hash', 'icon--lg'),
    h('h3', null, `Добро пожаловать в #${ch.name}!`),
    h('p', null, 'Это начало канала. Напиши первое сообщение — или позови друзей по инвайт-коду.'));
}

function renderAll({ keepOffset = false } = {}) {
  const el = box();
  const ch = getChannel();
  if (!ch || ch.type !== 'text') { el.replaceChildren(); renderedChannel = null; return; }
  const switched = renderedChannel !== ch.id;
  const oldFromBottom = el.scrollHeight - el.scrollTop;
  const stick = switched || nearBottom(el);
  const msgs = state.messages[ch.id];
  const nodes = [];
  if (isLoading(ch.id)) nodes.push(h('div', { class: 'chat__loader' }, 'Загрузка…'));
  if (msgs) {
    if (!state.hasMore[ch.id] && !isLoading(ch.id)) nodes.push(emptyEl(ch));
    let prev = null;
    for (const m of msgs) { nodes.push(messageEl(m, prev)); prev = m; }
  }
  el.replaceChildren(...nodes);
  renderedChannel = ch.id;
  if (keepOffset && !switched) el.scrollTop = el.scrollHeight - oldFromBottom;
  else if (stick) { scrollBottom(); markStick(true); }
}

function markStick(v) {
  box().querySelectorAll('img.message__image').forEach((i) => { i.dataset.stick = v ? '1' : '0'; });
}

function appendMessage(m) {
  if (renderedChannel !== m.channelId) return;
  const el = box();
  const list = state.messages[m.channelId];
  const prev = list[list.length - 2] || null;
  const stick = nearBottom(el) || m.author?.id === state.user?.id;
  el.append(messageEl(m, prev));
  if (stick) { scrollBottom(); markStick(true); }
}

/* ---------- typing ---------- */
function renderTyping() {
  const el = $('#typing');
  const ch = state.currentChannelId;
  const t = state.typing[ch] || {};
  const now = Date.now();
  const names = Object.values(t).filter((x) => x.until > now).map((x) => displayName(findUser(x.user.id) || x.user));
  if (!names.length) { el.textContent = ''; return; }
  if (names.length === 1) el.textContent = `${names[0]} печатает…`;
  else if (names.length <= 3) el.textContent = `${names.join(', ')} печатают…`;
  else el.textContent = 'Несколько человек печатают…';
}

/* ---------- вложения ---------- */
function renderPending() {
  const wrap = $('#pending-attachments');
  wrap.replaceChildren(...pending.map((p) => h('div', {
    class: 'chip' + (p.uploading ? ' is-loading' : '') + (p.error ? ' is-error' : ''),
    title: p.file.name,
  }, h('span', { class: 'chip__name' }, (p.uploading ? '⏳ ' : '') + (p.file.name || 'файл')),
  h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': `Убрать ${p.file.name || 'файл'}`,
    onclick: () => { pending = pending.filter((x) => x !== p); renderPending(); },
  }, icon('i-close', 'icon--sm')))));
  wrap.hidden = !pending.length;
}

async function addFiles(files) {
  const ch = getChannel();
  if (!ch || ch.type !== 'text') return;
  for (const raw of files) {
    let file = raw;
    if (!file) continue;
    if (file.size > MAX_FILE) { toast(`«${file.name}» больше 100 МБ`); continue; }
    if (!file.name || file.name === 'image.png') {
      const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      file = new File([file], `вставка-${Date.now()}.${ext}`, { type: file.type });
    }
    const p = { id: ++pendingSeq, file, uploading: true };
    pending.push(p);
    renderPending();
    api.uploadAttachment(file).then((att) => {
      p.att = att;
      p.uploading = false;
    }).catch((e) => {
      pending = pending.filter((x) => x !== p);
      toastError(e);
    }).finally(renderPending);
  }
}

/* ---------- отправка ---------- */
async function send() {
  const ch = getChannel();
  if (!ch || ch.type !== 'text') return;
  const input = $('#composer-input');
  const content = input.value.trim();
  if (pending.some((p) => p.uploading)) { toast('Подожди, файлы ещё загружаются', '', 2500); return; }
  const attachments = pending.filter((p) => p.att).map((p) => p.att);
  if (!content && !attachments.length) return;
  if (content.length > 2000) { toast('Сообщение длиннее 2000 символов'); return; }
  const saved = { value: input.value, pending };
  input.value = '';
  pending = [];
  renderPending();
  autosize();
  try {
    const payload = { channelId: ch.id, content };
    if (attachments.length) payload.attachments = attachments;
    const res = await emitAck('message:send', payload);
    if (res.message) addMessage(res.message);
  } catch (e) {
    // вернуть текст, чтобы не потерять
    if (!input.value) input.value = saved.value;
    pending = saved.pending;
    renderPending();
    autosize();
    toastError(e);
  }
  lastTypingSent = 0;
}

function autosize() {
  const ta = $('#composer-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

export function addMessage(m) {
  const list = state.messages[m.channelId];
  if (!list) return; // история ещё не загружена — придёт с ней
  if (list.some((x) => x.id === m.id)) return;
  list.push(m);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  const t = state.typing[m.channelId];
  if (t && m.author) delete t[m.author.id];
  appendMessage(m);
  renderTyping();
}

function renderHeaderAndView() {
  const ch = getChannel();
  const server = getServer();
  const isText = ch?.type === 'text';
  $('#chat-view').hidden = !isText;
  $('#home-view').hidden = !!server;
  $('#voice-view').hidden = !(ch?.type === 'voice');
  const title = $('#channel-title');
  const iconEl = $('#channel-icon');
  iconEl.querySelector('use').setAttribute('href', `/assets/icons.svg#${ch?.type === 'voice' ? 'i-volume' : 'i-hash'}`);
  iconEl.style.display = ch ? '' : 'none';
  $('#members').hidden = !server;
  $('#app').classList.toggle('is-home', !server);
  title.textContent = ch ? ch.name : 'Созвон';
  $('#channel-topic').textContent = ch ? (server?.name || '') : '';
  document.title = ch ? `${ch.type === 'text' ? '#' : '🔊 '}${ch.name} — ${server?.name} · Созвон` : 'Созвон';
  if (isText) {
    const canSend = can(server, 'SEND_MESSAGES', ch.id);
    const canAttach = canSend && can(server, 'ATTACH_FILES', ch.id);
    const input = $('#composer-input');
    input.disabled = !canSend;
    $('#btn-send').disabled = !canSend;
    $('#btn-attach').hidden = !canAttach;
    $('#composer').classList.toggle('is-readonly', !canSend);
    input.placeholder = canSend ? `Написать в #${ch.name}` : 'У вас нет прав писать в этом канале';
    if (renderedChannel !== ch.id) {
      pending = [];
      renderPending();
      renderAll();
      renderTyping();
      if (matchMedia('(pointer: fine)').matches) $('#composer-input').focus({ preventScroll: true });
    }
  } else {
    renderedChannel = null;
  }
}

export function initChat(on) {
  subscribe(['nav', 'servers'], renderHeaderAndView);
  subscribe('messages', () => renderAll());
  // аватары/имена/роли поменялись — перерисовать видимые сообщения, сохранив прокрутку
  let lookSig = '';
  subscribe(['profile', 'servers'], () => {
    const el = box();
    if (!renderedChannel || !el) return;
    const srv = getServer();
    const sig = JSON.stringify([srv?.id, (srv?.roles || []).map((r) => [r.id, r.color, r.position]), srv?.memberRoles,
      (srv?.members || []).map((m) => [m.id, m.displayName, m.avatar, m.color]), srv?.channelOverwrites?.[renderedChannel]]);
    if (sig === lookSig) return;
    const first = !lookSig;
    lookSig = sig;
    if (first) return;
    const fromBottom = el.scrollHeight - el.scrollTop;
    const stick = nearBottom(el);
    renderAll();
    if (!stick) el.scrollTop = el.scrollHeight - fromBottom;
  });
  subscribe('history', () => renderAll({ keepOffset: true }));
  subscribe('typing', renderTyping);
  setInterval(renderTyping, 1000);

  on('message:new', ({ message }) => { if (message) addMessage(message); });
  on('message:deleted', ({ channelId, messageId }) => {
    const list = state.messages[channelId];
    if (!list) return;
    const i = list.findIndex((m) => m.id === messageId);
    if (i < 0) return;
    list.splice(i, 1);
    if (renderedChannel === channelId) {
      const el = box();
      const top = el.scrollTop;
      const stick = nearBottom(el);
      renderAll();
      if (!stick) el.scrollTop = top;
    }
  });
  on('typing', ({ channelId, user }) => {
    if (!user || user.id === state.user?.id) return;
    (state.typing[channelId] ||= {})[user.id] = { user, until: Date.now() + TYPING_SHOW_MS };
    notify('typing');
  });

  // подгрузка истории при прокрутке вверх
  box().addEventListener('scroll', () => {
    const el = box();
    const ch = state.currentChannelId;
    if (el.scrollTop < 80 && ch && state.hasMore[ch] && !isLoading(ch)) {
      const first = state.messages[ch]?.[0];
      if (first) loadHistory(ch, first.createdAt);
    }
    if (!nearBottom(el)) markStick(false);
  }, { passive: true });

  box().addEventListener('click', async (e) => {
    const b = e.target.closest('[data-delete-message]');
    if (!b) return;
    b.disabled = true;
    try { await emitAck('message:delete', { messageId: b.dataset.deleteMessage }); } catch (ex) { b.disabled = false; toastError(ex); }
  });

  const input = $('#composer-input');
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    autosize();
    const now = Date.now();
    if (input.value.trim() && now - lastTypingSent > TYPING_SEND_MS && state.currentChannelId) {
      lastTypingSent = now;
      emit('typing', { channelId: state.currentChannelId });
    }
  });
  input.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });

  const view = $('#chat-view');
  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  view.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; view.classList.add('is-dragover'); });
  view.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  view.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) view.classList.remove('is-dragover'); });
  view.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    view.classList.remove('is-dragover');
    addFiles(Array.from(e.dataTransfer.files || []));
  });
  renderPending();
}
