// Обложки треков (сервер: server/covers.js). Клиент получает только наши адреса /media/covers/<id>.jpg —
// чужие ссылки (YouTube, Spotify, Deezer…) сюда не попадают. Нет обложки (сервер отвечает 204) — значок ноты.
import { h, icon } from '../util.js';

const COVER_RE = /^\/media\/covers\/[a-f0-9]{20}\.jpg$/;
/** Адрес обложки, если это наш адрес; иначе null */
export const safeCover = (url) => (typeof url === 'string' && COVER_RE.test(url) ? url : null);
/** Обложки, которые уже загрузились (для Media Session отдаём только их — иначе ОС покажет пустую картинку) */
const loaded = new Set();
export const coverLoaded = (url) => loaded.has(url);

/**
 * Квадратная обложка: значок ноты, поверх — картинка, когда загрузится.
 * size: 'xs' (16px, список участников) | 'sm' (32px, очередь/библиотека) | 'md' (48px, профиль)
 */
export function coverArt(url, { size = 'sm', cls = '' } = {}) {
  const wrap = h('span', { class: `cover cover--${size}${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, icon('i-music'));
  setCover(wrap, url);
  return wrap;
}

/** Поставить/сменить картинку в обёртке .cover (или .music-player__art) */
export function setCover(wrap, url) {
  const src = safeCover(url);
  const cur = wrap.querySelector('img.cover__img');
  if ((cur?.getAttribute('src') || null) === src) return;
  cur?.remove();
  wrap.classList.remove('has-img');
  if (!src) return;
  const img = h('img', { class: 'cover__img', src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('load', () => {
    if (!img.naturalWidth) return;
    loaded.add(src);
    if (img.isConnected) wrap.classList.add('has-img');
    wrap.dispatchEvent(new CustomEvent('cover-load', { bubbles: true }));
  });
  img.addEventListener('error', () => { img.remove(); wrap.classList.remove('has-img'); });
  wrap.append(img);
}

/* ---------- Media Session API: обложка и название в системном оверлее медиа ---------- */
let lastMeta = '';
/**
 * @param {object|null} track — текущий трек (null — ничего не играет)
 * @param {{paused?:boolean, actions?:{play?,pause?,nexttrack?}}} opts
 */
export function updateMediaSession(track, { paused = false, actions = null } = {}) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  if (!ms || typeof window.MediaMetadata !== 'function') return;
  if (!track) {
    if (lastMeta) { ms.metadata = null; ms.playbackState = 'none'; lastMeta = ''; }
    return;
  }
  const cover = safeCover(track.cover) && coverLoaded(track.cover) ? track.cover : null;
  const key = JSON.stringify([track.qid || track.id, track.title, track.artist, cover]);
  if (key !== lastMeta) {
    lastMeta = key;
    ms.metadata = new window.MediaMetadata({
      title: track.title || 'Без названия',
      artist: track.artist || '',
      album: 'DJ Бот · Astra',
      artwork: cover ? [{ src: new URL(cover, location.origin).href, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
    for (const [action, fn] of Object.entries(actions || {})) {
      try { ms.setActionHandler(action, fn || null); } catch { /* действие не поддерживается */ }
    }
  }
  ms.playbackState = paused ? 'paused' : 'playing';
}
