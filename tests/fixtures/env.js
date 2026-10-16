import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = 3200;
export const BASE_URL = `https://localhost:${PORT}`;
export const DATA_DIR = process.env.QA_DATA_DIR || path.join(os.tmpdir(), 'sozvon-qa-data');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MEDIA_DIR = path.join(ROOT, 'tests', 'fixtures', 'media');

// Музыкальный стенд v2: отдельный сервер с фейковым yt-dlp и фейковым Spotify embed
export const MUSIC_PORT = 3210;
export const MUSIC_BASE_URL = `https://localhost:${MUSIC_PORT}`;
export const MUSIC_DATA_DIR = process.env.QA_MUSIC_DATA_DIR || path.join(os.tmpdir(), 'sozvon-qa-music-data');
export const SPOTIFY_FAKE_PORT = 3291;
export const FAKE_YTDLP = path.join(ROOT, 'tests', 'fixtures', 'fake-yt-dlp.mjs');
export const YTDLP_LOG = path.join(MUSIC_DATA_DIR + '-ytdlp-calls.log');
