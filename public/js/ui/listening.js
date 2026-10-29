// «Сейчас слушает» и «Слушать вместе».
// Ничего нового сервер не отслеживает: участник голосового канала + музыка бота в этом канале — это те же
// voice:members / music:state, которые сервер и так присылает только тем, кто видит канал (emitToViewers).
// Поэтому показываем только для каналов, которые видит смотрящий. Пользователь может скрыть это
// настройкой «Показывать, что я слушаю» (user.showListening, по умолчанию — да).
import { h, icon } from '../util.js';
import { state, getChannel, getServer } from '../state.js';
import { can } from '../perms.js';
import { coverArt } from './covers.js';
import { confirmDialog } from './modals.js';
import { toastError } from './toasts.js';

/**
 * Что сейчас слушает пользователь: {channelId, channel, serverId, track, paused} или null.
 * Не показываем: бота, скрывших (showListening=false), заглушивших звук (deafen), «ожидающие» треки.
 */
export function listeningOf(u) {
  if (!u?.id || u.isBot || u.showListening === false) return null;
  for (const [channelId, list] of Object.entries(state.voice)) {
    const m = (list || []).find((x) => !x.isBot && x.userId === u.id);
    if (!m) continue;
    if (m.deafened || m.serverDeafen) return null;
    const ms = state.music[channelId];
    const t = ms?.track;
    if (!t || t.pending || !t.url) return null;
    const channel = getChannel(channelId);
    if (!channel) return null;
    return { channelId, channel, serverId: channel.serverId, track: t, paused: !!ms.paused };
  }
  return null;
}

export const trackText = (t) => [t?.artist, t?.title].filter(Boolean).join(' — ') || t?.title || 'Без названия';

/** Можно ли подключиться к каналу слушающего: {ok, reason} */
export function canListenTogether(info) {
  if (!info) return { ok: false, reason: 'Сейчас ничего не слушает' };
  if (state.myVoice?.channelId === info.channelId) return { ok: false, reason: 'Вы уже в этом канале' };
  const srv = getServer(info.serverId);
  if (!srv || !can(srv, 'CONNECT', info.channelId)) return { ok: false, reason: 'Нет права подключаться к этому каналу' };
  return { ok: true, reason: '' };
}

/** «Слушать вместе»: подтвердить и подключиться к голосовому каналу слушающего */
export async function listenTogether(info, { onAction } = {}) {
  const chk = canListenTogether(info);
  if (!chk.ok) return false;
  const yes = await confirmDialog({
    title: 'Слушать вместе',
    text: `Подключиться к голосовому каналу «${info.channel.name}»? Сейчас играет: ${trackText(info.track)}.`
      + (state.myVoice ? ' Вы выйдете из текущего голосового канала.' : ''),
    ok: 'Подключиться', danger: false,
  });
  if (!yes) return false;
  onAction?.();
  try {
    const [{ selectChannel }, { joinVoice }] = await Promise.all([import('../nav.js'), import('../voice/voice.js')]);
    selectChannel(info.channelId);
    await joinVoice(info.channelId);
    return true;
  } catch (e) { toastError(e); return false; }
}

/** Строка в списке участников: «🎵 Слушает: Исполнитель — Название» с маленькой обложкой */
export function listeningLine(info) {
  return h('span', { class: 'member__status member__listening', title: `Слушает: ${trackText(info.track)}${info.paused ? ' (пауза)' : ''}` },
    coverArt(info.track.cover, { size: 'xs' }),
    h('span', { class: 'member__listening-text' }, `🎵 Слушает: ${trackText(info.track)}`));
}

/** Секция профиля «Сейчас слушает» + кнопка «Слушать вместе» (self — свой профиль, без кнопки) */
export function listeningSection(info, { self = false, onAction = null } = {}) {
  const chk = canListenTogether(info);
  return h('section', { class: 'profile-popup__section profile-listening', dataset: { channelId: info.channelId } },
    h('h4', null, info.paused ? 'Слушает (пауза)' : 'Сейчас слушает'),
    h('div', { class: 'profile-listening__row' },
      coverArt(info.track.cover, { size: 'md' }),
      h('div', { class: 'profile-listening__text' },
        h('div', { class: 'profile-listening__title' }, `🎵 ${info.track.title || 'Без названия'}`),
        info.track.artist ? h('div', { class: 'profile-listening__artist' }, info.track.artist) : null,
        h('div', { class: 'profile-listening__where' }, icon('i-volume', 'icon--sm'), info.channel.name))),
    self ? null : h('button', {
      type: 'button', class: 'btn btn--sm btn--block-soft profile-listening__join', dataset: { action: 'listen-together' },
      disabled: !chk.ok, title: chk.ok ? 'Подключиться к этому голосовому каналу' : chk.reason,
      onclick: () => listenTogether(info, { onAction }),
    }, icon('i-headphones'), 'Слушать вместе'),
    !self && !chk.ok ? h('p', { class: 'profile-listening__reason' }, chk.reason) : null);
}
