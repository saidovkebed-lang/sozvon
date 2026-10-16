// REST API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { register, login, requireAuth, HttpError } from './auth.js';
import { publicUser } from './model.js';
import { syncLibrary, addUploadedFile, importFromUrl, MUSIC_MAX_BYTES, fixMulterName, sanitizeFileName, getMusicDir } from './music-library.js';

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createApiRouter({ uploadsDir, getIceServers, getPublicUrl, turnConfigured, forceRelay, isBotOnline }) {
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

  router.post('/register', wrap(async (req, res) => {
    res.json(await register(req.body));
  }));

  router.post('/login', wrap(async (req, res) => {
    res.json(await login(req.body));
  }));

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

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

  router.post('/attachments', requireAuth, attachmentUpload.single('file'), (req, res) => {
    const f = req.file;
    if (!f) throw new HttpError(400, 'Файл не получен (поле «file»)');
    const name = sanitizeFileName(fixMulterName(f.originalname)).slice(0, 200);
    res.json({ url: '/media/uploads/' + f.filename, name, type: f.mimetype || 'application/octet-stream', size: f.size });
  });

  router.get('/music', requireAuth, wrap(async (_req, res) => {
    res.json({ tracks: await syncLibrary() });
  }));

  router.post('/music/upload', requireAuth, musicUpload.single('file'), wrap(async (req, res) => {
    const track = await addUploadedFile(req.file, req.user.username);
    res.json({ track });
  }));

  router.post('/music/import', requireAuth, wrap(async (req, res) => {
    const addedBy = req.isBot && typeof req.body?.addedBy === 'string' ? req.body.addedBy.slice(0, 24) : req.user.username;
    const track = await importFromUrl(req.body?.url, addedBy);
    res.json({ track });
  }));

  router.use((_req, res) => res.status(404).json({ error: 'Не найдено' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, _next) => {
    if (req.file?.path && fs.existsSync(req.file.path) && path.basename(req.file.path).startsWith('.upload-')) {
      fs.rmSync(req.file.path, { force: true });
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = req.path.startsWith('/music') ? 50 : 25;
        return res.status(413).json({ error: `Файл слишком большой (максимум ${mb} МБ)` });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Файл нужно передать в поле «file»' });
      return res.status(400).json({ error: 'Ошибка загрузки файла' });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON в запросе' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('[api]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return router;
}
