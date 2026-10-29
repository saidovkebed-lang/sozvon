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
import { livePosition, fmtTime } from '../media-sources.js';

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

/* ============================================================
   «Слушает Spotify / Яндекс Музыка / …» — что играет на ПК (приложение для Windows, public/js/now-playing.js).
   Сервер присылает только тем, кто делит с пользователем сервер или ЛС (событие listening → state.pcListening).
   Музыка бота в голосовом канале важнее: если человек слушает бота — показываем «Сейчас слушает» бота.
   ============================================================ */

/** Что играет у пользователя на ПК: {source, title, artist, album, durationMs, positionMs, at, cover?} или null */
export function pcListeningOf(u) {
  if (!u?.id || u.isBot || u.showListening === false) return null;
  const np = state.pcListening?.[u.id];
  return np && np.title ? np : null;
}

const pcText = (np) => [np.artist, np.title].filter(Boolean).join(' — ');

/** Строка в списке участников: «🎵 Spotify: Исполнитель — Название» */
export function pcListeningLine(np) {
  return h('span', { class: 'member__status member__listening member__listening--pc', title: `Слушает ${np.source}: ${pcText(np)}` },
    coverArt(np.cover, { size: 'xs' }),
    h('span', { class: 'member__listening-text' }, `🎵 ${np.source}: ${pcText(np)}`));
}

/** Полоса прогресса «0:42 ━━━──── 3:15»; живёт от общего таймера (раз в секунду) */
function progressEl(np) {
  if (!np.durationMs) return null;
  const pos = livePosition(np);
  return h('div', { class: 'np-progress', dataset: { npBar: '1', pos: String(np.positionMs), at: String(np.at), dur: String(np.durationMs) } },
    h('span', { class: 'np-progress__time np-progress__cur' }, fmtTime(pos)),
    h('span', {
      class: 'np-progress__track', role: 'progressbar', 'aria-label': 'Позиция трека',
      'aria-valuemin': '0', 'aria-valuemax': String(Math.round(np.durationMs / 1000)), 'aria-valuenow': String(Math.round(pos / 1000)),
    }, h('span', { class: 'np-progress__fill', style: { width: `${(100 * pos) / np.durationMs}%` } })),
    h('span', { class: 'np-progress__time' }, fmtTime(np.durationMs)));
}

let ticker = null;
function tickProgress() {
  const bars = document.querySelectorAll('[data-np-bar]');
  if (!bars.length) { clearInterval(ticker); ticker = null; return; }
  const now = Date.now();
  for (const b of bars) {
    const np = { positionMs: Number(b.dataset.pos), at: Number(b.dataset.at), durationMs: Number(b.dataset.dur) };
    const pos = livePosition(np, now);
    b.querySelector('.np-progress__cur').textContent = fmtTime(pos);
    b.querySelector('.np-progress__fill').style.width = `${(100 * pos) / np.durationMs}%`;
    b.querySelector('.np-progress__track').setAttribute('aria-valuenow', String(Math.round(pos / 1000)));
  }
}
function ensureTicker() { if (!ticker) ticker = setInterval(tickProgress, 1000); }

/** «Включить в Astra»: можно ли (вы в голосовом канале, есть право управлять музыкой, бот запущен) */
export function canPlayInAstra() {
  const ch = state.myVoice?.channelId ? getChannel(state.myVoice.channelId) : null;
  if (!ch) return { ok: false, reason: 'Зайдите в голосовой канал, чтобы включить трек в Astra' };
  if (!can(getServer(ch.serverId), 'USE_MUSIC_BOT', ch.id)) return { ok: false, reason: 'Нет права управлять музыкой в этом канале' };
  if (!state.botOnline) return { ok: false, reason: 'Музыкальный бот не запущен' };
  return { ok: true, reason: '' };
}

async function playInAstra(np) {
  const q = [np.artist, np.title].filter(Boolean).join(' ').slice(0, 300);
  try {
    const [{ emitAck }, { toastOk }] = await Promise.all([import('../socket.js'), import('./toasts.js')]);
    await emitAck('music:command', { command: 'play', args: q });
    toastOk(`В очередь: ${pcText(np)}`);
  } catch (e) { toastError(e); }
}

/** Секция профиля «Слушает Spotify»: обложка, название, исполнитель, альбом, живой прогресс, кнопки */
export function pcListeningSection(np, { self = false } = {}) {
  const play = canPlayInAstra();
  const q = encodeURIComponent([np.artist, np.title].filter(Boolean).join(' '));
  const sec = h('section', { class: 'profile-popup__section profile-listening profile-listening--pc', dataset: { source: np.source } },
    h('h4', null, `Слушает ${np.source}`),
    h('div', { class: 'profile-listening__row' },
      coverArt(np.cover, { size: 'md' }),
      h('div', { class: 'profile-listening__text' },
        h('div', { class: 'profile-listening__title', title: np.title }, np.title),
        np.artist ? h('div', { class: 'profile-listening__artist', title: np.artist }, np.artist) : null,
        np.album ? h('div', { class: 'profile-listening__album', title: np.album }, np.album) : null)),
    progressEl(np),
    h('div', { class: 'profile-listening__actions' },
      h('a', {
        class: 'btn btn--sm btn--block-soft profile-listening__yt', dataset: { action: 'np-youtube' },
        href: `https://www.youtube.com/results?search_query=${q}`, target: '_blank', rel: 'noopener noreferrer',
      }, icon('i-search'), 'Найти на YouTube'),
      self ? null : h('button', {
        type: 'button', class: 'btn btn--sm btn--block-soft profile-listening__play', dataset: { action: 'np-play' },
        disabled: !play.ok, title: play.ok ? 'Добавить этот трек в очередь DJ Бота в вашем голосовом канале' : play.reason,
        onclick: () => playInAstra(np),
      }, icon('i-play'), 'Включить в Astra')));
  if (np.durationMs) ensureTicker();
  return sec;
}
