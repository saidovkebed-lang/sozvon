// REST API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { pushPublicKey, validSubscription } from './push.js';
import { addPushSub, removePushSub } from './inbox.js';
import multer from 'multer';
import { register, login, requireAuth, HttpError, updateProfile, changePassword } from './auth.js';
import { publicUser, publicServer, findServer, isMember, findUserByName, userServers } from './model.js';
import { db, save } from './db.js';
import { PERMS, can } from './permissions.js';
import { MEDIA_KINDS, processImage, removeMediaUrl, mediaTmpDir } from './media.js';
import { readAppRelease } from './app-release.js';
import { Limiter, exempt, waitText } from './rate-limit.js';
import { syncLibrary, hasYtDlp, addUploadedFile, MUSIC_MAX_BYTES, fixMulterName, sanitizeFileName, getMusicDir, findTrackRec, deleteTrack } from './music-library.js';
import { importFromUrl, resolveInput, fetchPending, similarTracks } from './music-sources.js';
import { createPlaylistRouter } from './music-playlists.js';
import { tracksAddedBy, BADGE_RULES } from './cosmetics.js';
import { createTwoFactorRouter } from './twofa-routes.js';

const limitMb = Number(process.env.UPLOAD_LIMIT_MB);
export const ATTACHMENT_LIMIT_MB = Number.isFinite(limitMb) && limitMb > 0 ? limitMb : 100;
export const ATTACHMENT_MAX_BYTES = Math.floor(ATTACHMENT_LIMIT_MB * 1024 * 1024);

/** Используется ли медиафайл кем-то ещё (общий файл не удаляем). */
function mediaInUse(url) {
  return db.data.servers.some((s) => s.icon === url || s.banner === url)
    || db.data.users.some((u) => u.avatar === url || u.avatarAnimated === url || u.banner === url || u.bannerAnimated === url);
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createApiRouter({
  uploadsDir, dataDir, getIceServers, getPublicUrl, turnConfigured, forceRelay, isBotOnline,
  onUserUpdated = () => {}, onSessionsRevoked = () => {}, onServerUpdated = () => {},
  onMusicPlaylists = () => {}, onMusicSettings = () => {},
}) {
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  const attachmentUpload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(sanitizeFileName(fixMulterName(file.originalname))).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
        cb(null, crypto.randomBytes(12).toString('hex') + ext);
      },
    }),
    limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 10 },
  });

  const musicUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, getMusicDir()),
      filename: (_req, _file, cb) => cb(null, `.upload-${crypto.randomBytes(8).toString('hex')}`),
    }),
    limits: { fileSize: MUSIC_MAX_BYTES, files: 1, fields: 10 },
    fileFilter: (_req, file, cb) => {
      const mime = String(file.mimetype || '').toLowerCase();
      const ext = path.extname(fixMulterName(file.originalname)).toLowerCase();
      const ok = mime.startsWith('audio/') || ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm', '.weba'].includes(ext);
      if (!ok) return cb(new HttpError(400, 'Можно загружать только аудиофайлы (mp3, m4a, ogg, opus, wav, flac…)'));
      cb(null, true);
    },
  });

  // аватары/баннеры/иконки: во временный каталог, дальше — media.js
  const imageUpload = (kind) => multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, mediaTmpDir()),
      filename: (_req, _file, cb) => cb(null, `.upload-${crypto.randomBytes(8).toString('hex')}`),
    }),
    limits: { fileSize: MEDIA_KINDS[kind].maxBytes, files: 1, fields: 10 },
  }).single('file');
  const cropOf = (body) => {
    const out = {};
    for (const k of ['x', 'y', 'size', 'width', 'height']) {
      if (body?.[k] !== undefined && body[k] !== '') {
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Кадрирование: x, y, size — неотрицательные числа');
        out[k] = n;
      }
    }
    return Object.keys(out).length ? out : null;
  };
  const cleanupUpload = (req) => { if (req.file?.path) fs.rmSync(req.file.path, { force: true }); };
  const notBot = (req) => { if (req.isBot) throw new HttpError(403, 'Недоступно для бота'); };

  // профиль: kind avatar|banner → поля пользователя
  const USER_MEDIA = { avatar: ['avatar', 'avatarAnimated'], banner: ['banner', 'bannerAnimated'] };
  function setUserMedia(user, kind, url, animatedUrl) {
    const [k1, k2] = USER_MEDIA[kind];
    const old = [user[k1], user[k2]];
    user[k1] = url; user[k2] = animatedUrl;
    save();
    for (const u of old) if (u && u !== user[k1] && u !== user[k2]) removeMediaUrl(u, mediaInUse);
  }
  for (const kind of ['avatar', 'banner']) {
    router.post(`/me/${kind}`, requireAuth, (req, res, next) => { try { notBot(req); next(); } catch (e) { next(e); } },
      imageUpload(kind), wrap(async (req, res) => {
        try {
          if (!req.file) throw new HttpError(400, 'Файл не получен (поле «file»)');
          const r = await processImage(req.file, { kind, prefix: req.user.id, crop: cropOf(req.body) });
          setUserMedia(req.user, kind, r.url, r.animatedUrl);
          onUserUpdated(req.user);
          res.json({ user: publicUser(req.user, { self: true }), processed: r.processed });
        } finally { cleanupUpload(req); }
      }));
    router.delete(`/me/${kind}`, requireAuth, (req, res) => {
      notBot(req);
      setUserMedia(req.user, kind, null, null);
      onUserUpdated(req.user);
      res.json({ user: publicUser(req.user, { self: true }) });
    });
  }

  // иконка/баннер сервера (MANAGE_SERVER)
  function requireManageServer(req) {
    notBot(req);
    const server = findServer(req.params.id);
    if (!server || !isMember(server, req.user.id)) throw new HttpError(404, 'Сервер не найден');
    if (!can(server, req.user.id, PERMS.MANAGE_SERVER)) throw new HttpError(403, 'Недостаточно прав');
    return server;
  }
  for (const [field, kind] of [['icon', 'icon'], ['banner', 'banner']]) {
    router.post(`/servers/:id/${field}`, requireAuth, (req, res, next) => { try { requireManageServer(req); next(); } catch (e) { next(e); } },
      imageUpload(kind), wrap(async (req, res) => {
        try {
          const server = requireManageServer(req);
          if (!req.file) throw new HttpError(400, 'Файл не получен (поле «file»)');
          const r = await processImage(req.file, { kind, prefix: 's' + server.id, crop: cropOf(req.body) });
          // у сервера одна версия: анимированная (если есть) — она и показывается
          const url = r.animatedUrl || r.url;
          const old = server[field];
          server[field] = url;
          save();
          if (r.animatedUrl && r.url !== r.animatedUrl) removeMediaUrl(r.url, mediaInUse);
          if (old && old !== url) removeMediaUrl(old, mediaInUse);
          onServerUpdated(server);
          res.json({ server: publicServer(server, req.user.id), processed: r.processed });
        } finally { cleanupUpload(req); }
      }));
    router.delete(`/servers/:id/${field}`, requireAuth, (req, res) => {
      const server = requireManageServer(req);
      const old = server[field];
      server[field] = null;
      save();
      if (old) removeMediaUrl(old, mediaInUse);
      onServerUpdated(server);
      res.json({ server: publicServer(server, req.user.id) });
    });
  }

  // приложение для ПК (SPEC-v3 §4)
  router.get('/app/latest', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(readAppRelease(dataDir));
  });

  const addedByOf = (req) => (req.isBot && typeof req.body?.addedBy === 'string' ? req.body.addedBy.slice(0, 24) : req.user.username);

  // Защита от перебора: 10 неудачных входов в один аккаунт с одного адреса за 10 мин,
  // 30 неудачных входов с адреса за 10 мин (любые логины), 10 регистраций с адреса за час.
  const loginByUser = new Limiter({ limit: 10, windowMs: 10 * 60_000 });
  const loginByIp = new Limiter({ limit: 30, windowMs: 10 * 60_000 });
  const registerByIp = new Limiter({ limit: 10, windowMs: 60 * 60_000 });
  const tooMany = (res, sec, what) => {
    res.set('Retry-After', String(sec));
    throw new HttpError(429, `${what} Подождите ${waitText(sec)} и попробуйте снова.`);
  };

  router.post('/register', wrap(async (req, res) => {
    const ip = req.ip;
    if (!exempt(ip)) {
      const wait = registerByIp.blockedFor(ip);
      if (wait) tooMany(res, wait, 'Слишком много регистраций с вашего адреса.');
    }
    const out = await register(req.body);
    if (!exempt(ip)) registerByIp.hit(ip);
    res.json(out);
  }));

  router.post('/login', wrap(async (req, res) => {
    const ip = req.ip;
    const userKey = `${ip}|${String(req.body?.username || '').trim().toLowerCase().slice(0, 64)}`;
    if (!exempt(ip)) {
      const wait = Math.max(loginByUser.blockedFor(userKey), loginByIp.blockedFor(ip));
      if (wait) tooMany(res, wait, 'Слишком много неудачных попыток входа.');
    }
    try {
      const out = await login(req.body, { ip, ua: req.get('user-agent') || '' });
      loginByUser.clear(userKey);
      res.json(out);
    } catch (e) {
      if (e?.status === 401 && !exempt(ip)) { loginByUser.hit(userKey); loginByIp.hit(ip); }
      throw e;
    }
  }));

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user, { self: !req.isBot }) });
  });

  router.patch('/me', requireAuth, (req, res) => {
    if (req.isBot) throw new HttpError(403, 'Недоступно для бота');
    const { user, statusChanged } = updateProfile(req.user, req.body);
    onUserUpdated(req.user, { statusChanged });
    res.json({ user });
  });

  router.post('/me/password', requireAuth, wrap(async (req, res) => {
    if (req.isBot) throw new HttpError(403, 'Недоступно для бота');
    const revoked = await changePassword(req.user, req.token, req.body, { ip: req.ip });
    onSessionsRevoked(req.user.id, revoked);
    res.json({ ok: true });
  }));

  router.use(createTwoFactorRouter({ onUserUpdated, onSessionsRevoked, dataDir })); // 2FA: /login/2fa, /me/2fa/*

  router.get('/config', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      iceServers: await getIceServers(),
      relay: turnConfigured(),
      forceRelay: forceRelay(),
      publicUrl: getPublicUrl(),
      botOnline: isBotOnline(),
    });
  }));

  // ---------- Web Push ----------
  router.get('/push/key', (_req, res) => {
    const key = pushPublicKey();
    if (!key) throw new HttpError(404, 'Push-уведомления выключены на сервере');
    res.json({ key });
  });

  router.post('/push/subscribe', requireAuth, (req, res) => {
    if (req.isBot) throw new HttpError(403, 'Недоступно для бота');
    const sub = req.body?.subscription;
    if (!validSubscription(sub)) throw new HttpError(400, 'Некорректная подписка на уведомления');
    addPushSub(req.user.id, sub, req.get('user-agent') || '', req.token);
    res.json({ ok: true });
  });

  router.post('/push/unsubscribe', requireAuth, (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    res.json({ ok: true, removed: removePushSub(req.user.id, endpoint) });
  });

  router.post('/attachments', requireAuth, attachmentUpload.single('file'), (req, res) => {
    const f = req.file;
    if (!f) throw new HttpError(400, 'Файл не получен (поле «file»)');
    const name = sanitizeFileName(fixMulterName(f.originalname)).slice(0, 200);
    res.json({ url: '/media/uploads/' + f.filename, name, type: f.mimetype || 'application/octet-stream', size: f.size });
  });

  // Удалить трек библиотеки может тот, кто его добавил, или управляющий сервером (MANAGE_SERVER),
  // где состоит добавивший; трек без автора (положили на диск) — управляющий любым сервером, где есть кто-то ещё
  function canDeleteTrack(user, rec) {
    if (!rec || user.isBot) return false;
    if (rec.addedBy && rec.addedBy.toLowerCase() === user.username.toLowerCase()) return true;
    const author = rec.addedBy ? findUserByName(rec.addedBy) : null;
    return userServers(user.id).some((srv) => can(srv, user.id, PERMS.MANAGE_SERVER)
      && (author ? srv.memberIds.includes(author.id) : srv.memberIds.length > 1));
  }

  router.get('/music', requireAuth, wrap(async (req, res) => {
    // internet: можно ли искать/качать треки из интернета (установлен yt-dlp)
    const tracks = await syncLibrary();
    res.json({ tracks: tracks.map((t) => ({ ...t, canDelete: canDeleteTrack(req.user, findTrackRec(t.id)) })), internet: hasYtDlp() });
  }));

  router.delete('/music/:id', requireAuth, wrap(async (req, res) => {
    const rec = findTrackRec(String(req.params.id));
    if (!rec) throw new HttpError(404, 'Трек не найден');
    if (!canDeleteTrack(req.user, rec)) throw new HttpError(403, 'Удалить трек может тот, кто его добавил, или администратор сервера');
    const track = await deleteTrack(rec.id);
    res.json({ ok: true, track });
  }));

  // значок «Меломан»: как только добавивший набрал порог треков — разослать обновлённый профиль
  const melomaneCheck = (username) => {
    const u = username ? findUserByName(username) : null;
    if (u && !u.isBot && tracksAddedBy(u.username) === BADGE_RULES.melomaneTracks) onUserUpdated(u);
  };

  router.post('/music/upload', requireAuth, musicUpload.single('file'), wrap(async (req, res) => {
    const track = await addUploadedFile(req.file, req.user.username);
    melomaneCheck(req.user.username);
    res.json({ track });
  }));

  router.post('/music/import', requireAuth, wrap(async (req, res) => {
    const track = await importFromUrl(req.body?.url, addedByOf(req));
    melomaneCheck(addedByOf(req));
    res.json({ track });
  }));

  // Музыка из интернета (вызывает бот; людям тоже можно — те же проверки)
  router.post('/music/resolve', requireAuth, wrap(async (req, res) => {
    const input = typeof req.body?.input === 'string' ? req.body.input.trim().slice(0, 1000) : '';
    if (!input) throw new HttpError(400, 'Укажите ссылку или название трека');
    res.json(await resolveInput(input, { addedBy: addedByOf(req) }));
  }));

  router.post('/music/fetch', requireAuth, wrap(async (req, res) => {
    const track = await fetchPending(req.body?.item, { addedBy: addedByOf(req) });
    res.json({ track });
  }));

  // Автоплей (вызывает бот): похожие треки по радио-миксу YouTube → «ожидающие» элементы
  router.post('/music/similar', requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await similarTracks(b.seed, { exclude: Array.isArray(b.exclude) ? b.exclude : [], count: b.count }));
  }));

  // Сохранённые плейлисты и настройки музыки серверов
  router.use(createPlaylistRouter({ onChanged: onMusicPlaylists, onSettings: onMusicSettings }));

  router.use((_req, res) => res.status(404).json({ error: 'Не найдено' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, _next) => {
    if (req.file?.path && fs.existsSync(req.file.path) && (path.basename(req.file.path).startsWith('.upload-') || req.path.startsWith('/attachments'))) {
      fs.rmSync(req.file.path, { force: true });
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        let mb = ATTACHMENT_LIMIT_MB;
        if (req.path.startsWith('/music')) mb = 50;
        else if (/banner$/.test(req.path)) mb = MEDIA_KINDS.banner.maxBytes / 1048576;
        else if (/(avatar|icon)$/.test(req.path)) mb = MEDIA_KINDS.avatar.maxBytes / 1048576;
        return res.status(413).json({ error: `Файл слишком большой (максимум ${mb} МБ)` });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Файл нужно передать в поле «file»' });
      return res.status(400).json({ error: 'Ошибка загрузки файла' });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON в запросе' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    if (err instanceof HttpError) {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
    }
    console.error('[api]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return router;
}
