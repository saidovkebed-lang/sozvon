// «Слушает Spotify / Яндекс Музыка / …» — чистые функции без DOM и состояния (их проверяют тесты:
// tests/v22-now-playing.spec.js импортирует модуль напрямую).
//
// Источник сессии — по её app id из Windows (SourceAppUserModelId): «Spotify.exe», «chrome»,
// «A025C540.Yandex.Music_vfvw9svesycw6!App», «Chrome._crx_…» (сайт, установленный как приложение) и т.п.
// Категории: music — музыкальные сервисы и плееры; player — универсальные плееры (видео тоже);
// other — неизвестное приложение; browser — браузер (сайт не знаем: по умолчанию не учитываем).
// Порядок правил важен: «Яндекс Музыка» раньше «Яндекс Браузера», YouTube Music раньше браузеров.

const RULES = [
  { id: 'yandex-music', name: 'Яндекс Музыка', category: 'music', re: /yandex.*music|music.*yandex|яндекс.?музык/i },
  { id: 'spotify', name: 'Spotify', category: 'music', re: /spotify/i },
  { id: 'soundcloud', name: 'SoundCloud', category: 'music', re: /soundcloud/i },
  // PWA YouTube Music из Chrome/Edge: Chrome._crx_cinhimbnkkaeohfgghhklpknlkffjgod
  { id: 'youtube-music', name: 'YouTube Music', category: 'music', re: /youtube.?music|cinhimbnkkaeohfgghhklpknlkffjgod/i },
  { id: 'vk-music', name: 'VK Музыка', category: 'music', re: /vk.?music|vk музык|vkontakte|вконтакте|(^|[^a-z])vk([^a-z]|$)|(^|[^а-яё])вк([^а-яё]|$)/i },
  { id: 'apple-music', name: 'Apple Music', category: 'music', re: /applemusic|apple music|itunes/i },
  { id: 'zvuk', name: 'Звук', category: 'music', re: /sberzvuk|zvuk|сберзвук/i },
  { id: 'deezer', name: 'Deezer', category: 'music', re: /deezer/i },
  { id: 'tidal', name: 'TIDAL', category: 'music', re: /tidal/i },
  { id: 'telegram', name: 'Telegram', category: 'music', re: /telegram/i },
  { id: 'aimp', name: 'AIMP', category: 'music', re: /aimp/i },
  { id: 'foobar2000', name: 'foobar2000', category: 'music', re: /foobar/i },
  { id: 'musicbee', name: 'MusicBee', category: 'music', re: /musicbee/i },
  { id: 'winamp', name: 'Winamp', category: 'music', re: /winamp/i },
  { id: 'vlc', name: 'VLC', category: 'player', re: /vlc/i },
  { id: 'media-player', name: 'Медиаплеер', category: 'player', re: /zunemusic|zunevideo|microsoft\.?media\.?player|wmplayer|mediaplayer/i },
  { id: 'yandex-browser', name: 'Яндекс Браузер', category: 'browser', re: /yandex|^browser(\.exe)?$/i },
  { id: 'edge', name: 'Edge', category: 'browser', re: /msedge|microsoftedge/i },
  { id: 'chrome', name: 'Chrome', category: 'browser', re: /chrome|chromium/i },
  // Firefox называет себя хэшем папки установки: 308046B0AF4A39CB (и другие 16 hex-цифр у форков)
  { id: 'firefox', name: 'Firefox', category: 'browser', re: /firefox|librewolf|floorp|waterfox|^[0-9a-f]{16}$/i },
  { id: 'opera', name: 'Opera', category: 'browser', re: /opera/i },
  { id: 'vivaldi', name: 'Vivaldi', category: 'browser', re: /vivaldi/i },
  { id: 'brave', name: 'Brave', category: 'browser', re: /brave/i },
  { id: 'arc', name: 'Arc', category: 'browser', re: /thebrowsercompany|(^|\.)arc(\.exe)?$/i },
];

export const CATEGORY_RANK = { music: 0, player: 1, other: 2, browser: 3 };
export const CATEGORY_LABELS = { music: 'Музыка', player: 'Плеер', other: 'Приложение', browser: 'Браузер' };

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Имя неизвестного приложения из его app id: «C:\…\Foo Player.exe» → «Foo Player», «Vendor.App_hash!App» → «App» */
function fallbackName(app) {
  let s = String(app || '').split(/[\\/]/).pop();
  s = s.replace(/![^!]*$/, '').replace(/_[a-z0-9]{13}$/i, '').replace(/\.exe$/i, '');
  if (s.includes('.') && !/\s/.test(s)) s = s.split('.').filter(Boolean).pop() || s;
  return clip(s, 40) || 'Приложение';
}

/**
 * Источник по app id: {id, name, category}. Неизвестное приложение — id 'app:<app id>', category 'other'.
 * Сайт, установленный как приложение («Chrome._crx_…», «MSEdge._crx_…»), без известного правила — браузер.
 */
export function resolveSource(app) {
  const a = String(app || '');
  for (const r of RULES) {
    if (!r.re.test(a)) continue;
    // сайт, установленный как приложение (Chrome._crx_…), — не сам браузер; известные (YouTube Music) найдены выше
    if (r.category === 'browser' && /_crx_/i.test(a)) break;
    return { id: r.id, name: r.name, category: r.category };
  }
  if (/_crx_/i.test(a)) return { id: 'pwa', name: 'Веб-приложение', category: 'browser' };
  return { id: `app:${a.toLowerCase().slice(0, 80)}`, name: fallbackName(a), category: 'other' };
}

// Пометки, которые сайты добавляют к названиям: (Official Video), [HD] …
const JUNK = /\s*[([](?:official\s+)?(?:music\s+|lyrics?\s+)?(?:video|audio|visuali[sz]er|lyrics?)(?:\s+video)?[)\]]|\s*[([](?:hd|hq|4k|official|клип|премьера клипа|премьера)[)\]]/gi;

/**
 * Сессия из помощника → трек для статуса: обрезка полей, чистка названия, «Исполнитель - Название» из заголовка
 * вкладки, если исполнителя нет, «Исполнитель - Topic»/«…VEVO» → «Исполнитель».
 */
export function normalizeSession(s, now = Date.now()) {
  if (!s || typeof s !== 'object') return null;
  const app = clip(s.app, 300);
  let title = clip(s.title, 300).replace(JUNK, '').trim();
  let artist = clip(s.artist, 300) || clip(s.albumArtist, 300);
  if (!artist) {
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
    if (m) { artist = m[1].trim(); title = m[2].trim(); }
  }
  artist = artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').trim();
  if (!title && !artist) return null;
  if (!title) { title = artist; artist = ''; }
  const num = (v, max) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), max) : 0);
  const durationMs = num(s.durationMs, 24 * 3600 * 1000);
  let positionMs = num(s.positionMs, 24 * 3600 * 1000);
  const playing = !!s.playing;
  // позиция — на момент updatedAt; пересчитать на «сейчас»
  const updatedAt = Number.isFinite(s.updatedAt) && s.updatedAt > 0 ? s.updatedAt : 0;
  if (playing && updatedAt && now > updatedAt) positionMs += now - updatedAt;
  if (durationMs && positionMs > durationMs) positionMs = durationMs;
  return {
    app, source: resolveSource(app),
    title: title.slice(0, 200), artist: artist.slice(0, 200), album: clip(s.album, 200),
    durationMs, positionMs, at: now, playing, current: !!s.current,
  };
}

export const trackKey = (t) => (t ? `${t.app}|${t.artist}|${t.title}` : '');

/** Учитывается ли источник: opts.browsers — браузеры; opts.hidden — {sourceId: true} выключенные вручную */
export function sourceAllowed(source, { browsers = false, hidden = {} } = {}) {
  if (!source) return false;
  if (hidden && hidden[source.id]) return false;
  if (source.category === 'browser' && !browsers) return false;
  return true;
}

/**
 * Что показывать: из играющих (не на паузе) и разрешённых — музыкальные сервисы раньше плееров, неизвестных
 * приложений и браузеров; с известной длиной раньше без неё (лента видео в браузере обычно без длины);
 * затем уже показанный (prevKey — без «прыжков» между двумя играющими), затем тот, что Windows считает текущим.
 * sessions — сырые сессии помощника или уже normalizeSession(). null — показывать нечего.
 */
export function pickSession(sessions, { browsers = false, hidden = {}, prevKey = '', now = Date.now() } = {}) {
  const list = (Array.isArray(sessions) ? sessions : [])
    .map((s) => (s && s.source && 'at' in s ? s : normalizeSession(s, now)))
    .filter((t) => t && t.playing && sourceAllowed(t.source, { browsers, hidden }));
  if (!list.length) return null;
  const score = (t) => [CATEGORY_RANK[t.source.category] ?? 2, t.durationMs > 0 ? 0 : 1, trackKey(t) === prevKey ? 0 : 1, t.current ? 0 : 1];
  list.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  return list[0];
}

/** Источники, о которых сейчас сообщает Windows (для списка «Источники» в настройках), без повторов */
export function listSources(sessions) {
  const out = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const src = s?.source || resolveSource(s?.app);
    if (!out.has(src.id)) out.set(src.id, { ...src, playing: !!s?.playing });
    else if (s?.playing) out.get(src.id).playing = true;
  }
  return [...out.values()].sort((a, b) => (CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]) || a.name.localeCompare(b.name, 'ru'));
}

/** Где сейчас трек (мс) по данным статуса {positionMs, at, durationMs, playing?} */
export function livePosition(np, now = Date.now()) {
  if (!np) return 0;
  let p = Number(np.positionMs) || 0;
  if (np.playing !== false && Number.isFinite(np.at)) p += Math.max(0, now - np.at);
  const d = Number(np.durationMs) || 0;
  return d > 0 ? Math.min(p, d) : p;
}

export const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
