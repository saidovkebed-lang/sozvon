// Точка входа сервера «Astra».
import './admin/logbuf.js'; // первым: последние ошибки для админ-панели (console.error/warn)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as IOServer } from 'socket.io';
import { initDb, flushSync } from './db.js';
import { initPush } from './push.js';
import { ensureBotUser, migrateDb } from './model.js';
import { initMedia, ffmpegCaps } from './media.js';
import { readAppRelease, renderDownloadPage } from './app-release.js';
import { initBotToken } from './auth.js';
import { ensureCerts, localIPv4 } from './certs.js';
import { createApiRouter } from './routes.js';
import { attachRealtime } from './realtime.js';
import { initMusicLibrary, syncLibrary, hasYtDlp } from './music-library.js';
import { getIceServers, turnConfigured, forceRelay } from './ice.js';
import { startTunnel, getPublicUrl } from './tunnel.js';
import { createSfu } from './sfu.js';
import { initStats, flushStats, createRecapRouter } from './stats.js';
import { initAdmin, mountAdmin } from './admin/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const USE_HTTPS = !['0', 'false', 'no', 'off'].includes(String(process.env.HTTPS ?? '1').toLowerCase());
const PUBLIC_DIR = path.join(ROOT, 'public');

const SHARE = process.argv.includes('--share') || ['1', 'true', 'yes', 'on'].includes(String(process.env.SHARE).toLowerCase());

// ---------- данные ----------
initDb(DATA_DIR);
initAdmin({ dataDir: DATA_DIR, rootDir: ROOT }); // админ-панель экземпляра (server/admin, docs/ADMIN.md)
initStats(DATA_DIR); // «Astra Итоги»: DATA_DIR/stats.json (server/stats.js)
// контакт для push-сервисов (VAPID): PUSH_SUBJECT или публичный https-адрес сервера (Apple требует настоящий)
initPush(DATA_DIR, { subject: process.env.PUSH_SUBJECT || (/^https:\/\//.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL : undefined) });
migrateDb(); // v1/v2 → v3: роли, права, профили (идемпотентно, с копией старой базы)
initMedia(DATA_DIR);
const downloadsDir = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(downloadsDir, { recursive: true });
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
initMusicLibrary(DATA_DIR);
ensureBotUser();
initBotToken(DATA_DIR);

// ---------- HTTP(S) ----------
const app = express();
app.disable('x-powered-by');
// Заголовки безопасности: HTTPS навсегда (HSTS), запрет встраивания чужими сайтами, без утечки адресов
app.use((req, res, next) => {
  if (req.secure || req.get('x-forwarded-proto') === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), display-capture=(self), geolocation=()');
  next();
});
// За nginx (deploy/install.sh) — доверяем одному прокси, чтобы видеть реальные IP
app.set('trust proxy', ['1', 'true'].includes(String(process.env.TRUST_PROXY)) ? 1 : false);

const server = USE_HTTPS ? https.createServer(ensureCerts(DATA_DIR)) : http.createServer();
server.on('request', app);

const io = new IOServer(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 20_000,
  pingTimeout: 20_000,
  serveClient: true, // /socket.io/socket.io.esm.min.js и /socket.io/socket.io.min.js
});
// SFU трансляций экрана (mediasoup, необязателен): без него — как раньше, напрямую между участниками
const sfu = createSfu({ share: SHARE });
sfu.start().catch((err) => console.warn('[sfu] Ошибка запуска:', err.message));
const realtime = attachRealtime(io, { uploadsDir, dataDir: DATA_DIR, sfu });

app.use('/api', mountAdmin({ realtime, sfu })); // /api/admin/* + блокировки аккаунтов — до остальных /api
app.use('/api', createRecapRouter()); // «Astra Итоги»: /api/servers/:sid/recap
app.use('/api/watch', realtime.watch.router); // «Смотреть вместе»: загрузка видеофайла
app.use('/api', createApiRouter({
  uploadsDir,
  dataDir: DATA_DIR,
  getIceServers,
  getPublicUrl: () => process.env.PUBLIC_URL || getPublicUrl(),
  turnConfigured,
  forceRelay,
  isBotOnline: realtime.isBotOnline,
  onUserUpdated: realtime.emitUserUpdated,
  onSessionsRevoked: realtime.disconnectSessions,
  onServerUpdated: realtime.emitServerUpdated,
  onMusicPlaylists: realtime.emitMusicPlaylists,
  onMusicSettings: realtime.emitMusicSettings,
}));

// Аватары/баннеры/иконки: имя файла содержит хэш — кэш «навсегда»
for (const dir of ['avatars', 'banners', 'icons']) {
  app.use(`/media/${dir}`, express.static(path.join(DATA_DIR, 'media', dir), {
    dotfiles: 'deny', index: false, fallthrough: false, maxAge: '365d', immutable: true,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  }));
}
// Приложение для ПК: файлы релиза (кладёт deploy/update.sh), всегда как скачивание
app.use('/media/downloads', express.static(downloadsDir, {
  dotfiles: 'deny', index: false, fallthrough: false, maxAge: '1h',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    // описание последней версии для автообновления приложения — всегда свежее
    if (/latest[\w.-]*\.yml$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get(['/download', '/download/'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  const page = path.join(PUBLIC_DIR, 'download.html');
  if (fs.existsSync(page)) return res.sendFile(page);
  res.type('html').send(renderDownloadPage(readAppRelease(DATA_DIR)));
});

const INLINE_TYPES = /^(image|audio|video)\//;
app.use('/media/uploads', express.static(uploadsDir, {
  dotfiles: 'deny', index: false, fallthrough: false, maxAge: '7d',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    const type = express.static.mime.lookup(filePath);
    if (!INLINE_TYPES.test(type) || type === 'image/svg+xml') res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.use('/media/music', express.static(path.join(DATA_DIR, 'music'), {
  dotfiles: 'deny', index: false, fallthrough: false, maxAge: '1h',
  setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); },
}));
// «Смотреть вместе»: видео с Range, по подписанной ссылке (?t=) и только тем, кто видит канал
app.get('/media/watch/:file', realtime.watch.media);
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// Ошибки статики (404 медиа и т.п.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[http]', err);
  res.status(status).json({ error: status === 404 ? 'Файл не найден' : 'Ошибка сервера' });
});
app.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n[server] Порт ${PORT} уже занят. Закройте другой экземпляр или запустите с PORT=3001 npm start\n`);
  else console.error('[server] Ошибка:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const proto = USE_HTTPS ? 'https' : 'http';
  const lines = [`  ${proto}://localhost:${PORT}`, ...localIPv4().map((ip) => `  ${proto}://${ip}:${PORT}`)];
  console.log('\n🎧 Astra запущена! Адреса для входа:');
  console.log(lines.join('\n'));
  if (USE_HTTPS) {
    console.log('\n  Сертификат самоподписанный: при первом входе браузер предупредит —');
    console.log('  нажмите «Дополнительно» → «Перейти на сайт (небезопасно)».');
  } else {
    console.log('\n  ⚠ HTTPS выключен (HTTPS=0): микрофон и демонстрация экрана работают только на localhost.');
  }
  console.log(`\n  Данные: ${DATA_DIR}`);
  const ff = ffmpegCaps();
  if (!ff.ffmpeg) console.log('  ffmpeg не найден: аватары и баннеры сохраняются как есть, без обрезки.');
  const managed = Boolean(process.env.PUBLIC_URL); // установка на VPS (deploy/install.sh): бот и ссылка уже настроены
  if (managed) console.log(`  Публичный адрес: ${process.env.PUBLIC_URL}\n`);
  else console.log(`  Музыкальный бот: в другом окне выполните «npm run bot»${hasYtDlp() ? '' : ' (yt-dlp не найден — импорт с YouTube недоступен)'}\n`);
  if (SHARE) {
    startTunnel({
      dataDir: DATA_DIR,
      port: PORT,
      https: USE_HTTPS,
      onUrl: (url) => {
        const bar = '═'.repeat(url.length + 4);
        console.log(`\n🌍 Ссылка для друзей (работает через интернет, VPN не нужен):\n╔${bar}╗\n║  ${url}  ║\n╚${bar}╝`);
        console.log('  Сертификат у ссылки настоящий — предупреждений в браузере не будет.');
        console.log('  Ссылка новая при каждом запуске. Кнопка «копировать инвайт» в приложении даёт её сама.');
        if (!turnConfigured()) console.log('  Совет: если у кого-то не соединяется голос — настройте TURN (README → «Если не слышно друга»).');
        console.log('');
      },
    }).catch((err) => {
      console.error(`\n[share] Не удалось открыть публичную ссылку: ${err.message}`);
      console.error('[share] Сервер продолжает работать в локальной сети.\n');
    });
  } else if (!managed) {
    console.log('  Друзья не в вашей сети? Разместите «Astra» на VPS в РФ: docs/DEPLOY.md (одна команда).\n');
  }
  syncLibrary({ force: true })
    .then((tracks) => console.log(`[music] Треков в библиотеке: ${tracks.length}`))
    .catch((err) => console.error('[music] Ошибка сканирования библиотеки:', err.message));
});

// ---------- корректное завершение ----------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] Получен ${signal}, сохраняю данные и выключаюсь…`);
  flushStats({ final: true });
  flushSync();
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  sfu.close();
  io.close(() => {
    flushSync();
    process.exit(0);
  });
  server.closeAllConnections?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => { flushStats(); flushSync(); });
process.on('uncaughtException', (err) => {
  console.error('[server] Необработанная ошибка:', err);
  flushSync();
});
