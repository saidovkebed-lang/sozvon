// Запуск сервера для тестов: чистый DATA_DIR на каждый прогон.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './fixtures/env.js';
import { ensureMedia } from './fixtures/media.js';

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA_DIR, 'music'), { recursive: true });
// Предзаполняем библиотеку бота тестовыми треками (бот ищет по data/music)
const files = ensureMedia();
for (const f of files.library) fs.copyFileSync(f, path.join(DATA_DIR, 'music', path.basename(f)));
process.env.DATA_DIR = DATA_DIR;
// обложки треков: без выхода в интернет (Deezer/iTunes — недостижимый адрес, картинки — только с 127.0.0.1)
Object.assign(process.env, { COVERS_DEEZER_BASE: 'http://127.0.0.1:9', COVERS_ITUNES_BASE: 'http://127.0.0.1:9', COVERS_IMAGE_HOSTS: '127.0.0.1' });
await import(path.join(ROOT, 'server', 'index.js'));
