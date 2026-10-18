// Звуки событий и системные уведомления браузера.
//  - вход/выход в моём голосовом канале (свой и чужой), mute/deafen;
//  - новое сообщение: звук, если оно не в открытом канале или вкладка неактивна;
//    системное уведомление — если вкладка не в фокусе (mentionsOnly — только при @нике).
import { state, subscribe, getChannel, getServer } from '../state.js';
import { socketId } from '../socket.js';
import { selectChannel } from '../nav.js';
import { prefs } from '../prefs.js';
import { playSound } from './sounds.js';
import { bumpUnread, focusApp } from '../desktop.js';
import { displayName } from '../util.js';
import { pushActive } from '../push.js';

/** «Не беспокоить» (v3): без звуков и системных уведомлений */
export const isDnd = () => state.user?.status === 'dnd';

let lastChannel = null;       // в каком голосовом канале были при прошлом рендере
let lastMembers = new Set();  // socketId участников этого канала
let lastMuted = null;
let lastDeafened = null;

function voiceChanged() {
  const ch = state.myVoice?.channelId || null;
  const me = socketId();
  const now = new Set((ch && state.voice[ch] || []).map((m) => m.socketId).filter((id) => id !== me));
  if (ch !== lastChannel) {
    if (ch && !lastChannel) playSound('join');
    else if (!ch && lastChannel) playSound('leave');
    else if (ch && lastChannel) playSound('join'); // переход между каналами
  } else if (ch && !state.deafened) {
    let joined = false; let left = false;
    for (const id of now) if (!lastMembers.has(id)) joined = true;
    for (const id of lastMembers) if (!now.has(id)) left = true;
    if (joined) playSound('join');
    else if (left) playSound('leave');
  }
  lastChannel = ch;
  lastMembers = now;
}

function meChanged() {
  const muted = !!(state.muted || state.deafened);
  const deaf = !!state.deafened;
  if (lastMuted !== null) {
    if (deaf !== lastDeafened) playSound(deaf ? 'deafen' : 'undeafen');
    else if (muted !== lastMuted) playSound(muted ? 'mute' : 'unmute');
  }
  lastMuted = muted;
  lastDeafened = deaf;
}

export function mentionsMe(text, username = state.user?.username) {
  if (!text || !username) return false;
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${esc}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

export function canNotify() {
  return typeof window.Notification === 'function';
}

function showDesktop(m) {
  if (isDnd()) return;
  if (!prefs.get('notifications.desktop') || !canNotify() || Notification.permission !== 'granted') return;
  if (document.hasFocus() && document.visibilityState === 'visible') return;
  const ch = getChannel(m.channelId);
  const important = !!ch?.dm || mentionsMe(m.content) || !!m.mentionEveryone;
  // личные сообщения уведомляют всегда; остальное — по настройке «Только упоминания»
  if (prefs.get('notifications.mentionsOnly') && !important) return;
  // push на этом устройстве включён — о ЛС и упоминаниях уведомит он (без дублей)
  if (important && pushActive()) return;
  const srv = ch && !ch.dm ? getServer(ch.serverId) : null;
  const who = m.author ? displayName(m.author) : 'Кто-то';
  let body = (m.content || '').replace(/\s+/g, ' ').trim();
  if (!body && m.attachments?.length) body = `📎 ${m.attachments.length > 1 ? `Вложения (${m.attachments.length})` : (m.attachments[0].name || 'Вложение')}`;
  if (body.length > 140) body = body.slice(0, 139) + '…';
  try {
    const n = new Notification(ch?.dm ? who : `${who}${ch ? ` · #${ch.name}` : ''}${srv ? ` (${srv.name})` : ''}`, {
      body,
      tag: `sozvon-${m.channelId}`,
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png',
      silent: true, // свой звук играем сами
    });
    n.onclick = () => { focusApp(); if (ch) selectChannel(ch.id); n.close(); };
  } catch { /* например, Android Chrome требует SW.showNotification — молча пропускаем */ }
}

function onMessage({ message: m } = {}) {
  if (!m || m.system || !state.user || m.author?.id === state.user.id) return;
  const visible = document.visibilityState === 'visible' && document.hasFocus();
  const here = m.channelId === state.currentChannelId && visible;
  if (!here && !state.deafened) playSound('message');
  if (!here) bumpUnread();
  showDesktop(m);
}

/** Запросить разрешение (только по жесту пользователя). Возвращает итоговый статус. */
export async function requestDesktopPermission() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export function initNotifications(on) {
  subscribe(['voice', 'me'], voiceChanged);
  subscribe('me', meChanged);
  on('message:new', onMessage);
}
