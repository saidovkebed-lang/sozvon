// Service worker «Astra»: кэширует только оболочку приложения (HTML/CSS/JS/иконки),
// чтобы PWA ставилась и быстро открывалась. Всё живое (API, сокеты, медиа) — только из сети.
//  - HTML (навигация): network-first, офлайн — последняя сохранённая оболочка;
//  - статика (/css, /js, /assets, манифест): stale-while-revalidate;
//  - /api/, /socket.io/, /media/ и любые не-GET запросы SW не трогает вообще.
// Push: личные сообщения и упоминания (сервер шлёт, только когда ни одно окно Astra не на виду);
// клик по уведомлению открывает нужный чат в уже открытом окне или в новом.
// При изменении списка/логики — поднять VERSION: старые кэши удалятся при activate.

const VERSION = 'v4-astra-2.0.2';
const CACHE = `sozvon-shell-${VERSION}`;

const SHELL = [
  '/',
  '/css/tokens.css',
  '/css/app.css',
  '/css/watch.css',
  '/css/recap.css', '/js/ui/recap.js', // «Astra Итоги»
  '/css/astra2.css',
  '/css/music-extras.css', '/js/ui/covers.js', '/js/ui/listening.js', '/js/ui/music-eq-panel.js', '/js/audio/music-eq.js', // обложки, эквалайзер, «Сейчас слушает»
  '/js/main.js',
  '/js/api.js',
  '/js/music.js',
  '/js/nav.js',
  '/js/socket.js',
  '/js/state.js',
  '/js/util.js',
  '/js/pwa.js',
  '/js/prefs.js',
  '/js/theme-boot.js',
  '/js/perms.js',
  '/js/ping.js',
  '/js/desktop.js',
  '/js/download.js',
  '/js/ui/auth.js',
  '/js/ui/chat.js', '/js/ui/lightbox.js', '/js/ui/dms.js', '/js/ui/inbox.js', '/js/push.js',
  '/js/ui/members.js',
  '/js/ui/modals.js',
  '/js/ui/music-player.js',
  '/js/ui/music-playlists.js',
  '/js/ui/watch.js',
  '/js/ui/servers.js',
  '/js/ui/sidebar.js',
  '/js/ui/toasts.js',
  '/js/ui/voice-stage.js',
  '/js/ui/appearance.js',
  '/js/ui/cosmos.js', '/js/ui/cosmetics.js', '/js/ui/server-theme.js', '/js/ui/motion.js',
  '/js/ui/context-menu.js',
  '/js/ui/keybinds.js',
  '/js/ui/notifications.js',
  '/js/ui/sounds.js',
  '/js/ui/user-settings.js',
  '/js/ui/server-settings.js',
  '/js/ui/mod-actions.js',
  '/js/ui/profile.js',
  '/js/ui/cropper.js',
  '/js/ui/stream.js',
  '/js/ui/palette.js',
  '/js/voice/media.js',
  '/js/voice/native-capture.js',
  '/js/voice/rtc.js',
  '/js/voice/voice.js',
  '/js/audio/engine.js',
  '/js/audio/mic-chain.js',
  '/js/audio/rnnoise.js',
  '/js/audio/gate-worklet.js',
  '/assets/icons.svg',
  '/assets/logo.svg',
  '/assets/astra-ui.svg',
  '/assets/cosmos/stars-far.svg',
  '/assets/cosmos/stars-near.svg',
  '/assets/favicon.svg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/maskable-192.png',
  '/assets/icons/maskable-512.png',
  '/assets/icons/apple-touch-icon.png',
  '/manifest.webmanifest',
];

const NEVER = /^\/(api|socket\.io|media)(\/|$)/;
const STATIC = /^\/(css|js|assets)\/|^\/manifest\.webmanifest$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // по одному: отсутствие одного файла не должно ломать установку SW
    await Promise.all(SHELL.map((url) =>
      fetch(url, { cache: 'no-cache' })
        .then((res) => (res.ok ? cache.put(url, res) : null))
        .catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('sozvon-shell-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.test(url.pathname)) return;
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    // только сама оболочка; прочие HTML-страницы (styleguide и т.п.) — как есть
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    event.respondWith(networkFirst(req));
    return;
  }
  if (STATIC.test(url.pathname)) event.respondWith(staleWhileRevalidate(event, url.pathname));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req); // RequestInit с navigate-запросом нельзя
    if (res.ok && res.type === 'basic') await cache.put('/', res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match('/');
    if (cached) return cached;
    throw e;
  }
}

let updateNotified = false;

async function staleWhileRevalidate(event, key) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  const network = fetch(event.request).then(async (res) => {
    if (res.ok && res.type === 'basic') {
      const oldTag = cached?.headers.get('etag');
      const newTag = res.headers.get('etag');
      await cache.put(key, res.clone());
      // оболочка обновилась на сервере, а страница загружена из старого кэша — подскажем перезагрузить
      if (cached && oldTag && newTag && oldTag !== newTag) notifyUpdate();
    }
    return res;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

async function notifyUpdate() {
  if (updateNotified) return;
  updateNotified = true;
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage({ type: 'sozvon:shell-updated' });
}

// ---------- push-уведомления ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  const title = String(data.title || 'Astra').slice(0, 120);
  const count = Number(data.count) > 1 ? ` (${data.count})` : '';
  event.waitUntil(self.registration.showNotification(title + count, {
    body: String(data.body || 'Новое сообщение').slice(0, 300),
    tag: String(data.tag || 'sozvon'),
    renotify: true,
    // иконка сервера / аватар автора ЛС — чтобы было видно, откуда уведомление
    icon: typeof data.icon === 'string' && data.icon.startsWith('/') && !data.icon.startsWith('//') ? data.icon : '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/', channelId: data.channelId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', channelId = null } = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus().catch(() => {});
      win.postMessage({ type: 'sozvon:open', channelId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
