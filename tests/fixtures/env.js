import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// QA_PORT позволяет гонять несколько прогонов параллельно (разные агенты/окна) без конфликта портов и DATA_DIR.
export const PORT = Number(process.env.QA_PORT || 3200);
const SUFFIX = PORT === 3200 ? '' : `-${PORT}`;
export const BASE_URL = `https://localhost:${PORT}`;
export const DATA_DIR = process.env.QA_DATA_DIR || path.join(os.tmpdir(), `sozvon-qa-data${SUFFIX}`);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MEDIA_DIR = path.join(ROOT, 'tests', 'fixtures', 'media');

// Музыкальный стенд v2: отдельный сервер с фейковым yt-dlp и фейковым Spotify embed
export const MUSIC_PORT = Number(process.env.QA_MUSIC_PORT || PORT + 10);
export const MUSIC_BASE_URL = `https://localhost:${MUSIC_PORT}`;
export const MUSIC_DATA_DIR = process.env.QA_MUSIC_DATA_DIR || path.join(os.tmpdir(), `sozvon-qa-music-data${SUFFIX}`);
export const SPOTIFY_FAKE_PORT = Number(process.env.QA_SPOTIFY_PORT || PORT + 91);
export const FAKE_YTDLP = path.join(ROOT, 'tests', 'fixtures', 'fake-yt-dlp.mjs');
export const YTDLP_LOG = path.join(MUSIC_DATA_DIR + '-ytdlp-calls.log');

// SFU трансляций экрана (mediasoup): порт UDP+TCP основного тестового сервера
export const SFU_PORT = Number(process.env.QA_SFU_PORT || PORT + 30000);
