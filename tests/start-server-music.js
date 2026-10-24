// Музыкальный стенд v2: отдельный сервер (MUSIC_PORT) с фейковым yt-dlp (YTDLP_PATH) и фейковым
// Spotify embed (SPOTIFY_EMBED_BASE) — чтобы не влиять на основной сервер старого набора.
import fs from 'node:fs';
import path from 'node:path';
import { MUSIC_DATA_DIR, ROOT, SPOTIFY_FAKE_PORT, FAKE_YTDLP, YTDLP_LOG } from './fixtures/env.js';
import { startFakeSpotify } from './fixtures/fake-spotify.js';

fs.rmSync(MUSIC_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(MUSIC_DATA_DIR, 'music'), { recursive: true });
for (const f of [YTDLP_LOG, YTDLP_LOG + '.search', MUSIC_DATA_DIR + '-spotify.log']) fs.rmSync(f, { force: true, recursive: true });
fs.chmodSync(FAKE_YTDLP, 0o755);
await startFakeSpotify(SPOTIFY_FAKE_PORT, MUSIC_DATA_DIR + '-spotify.log');
Object.assign(process.env, {
  DATA_DIR: MUSIC_DATA_DIR,
  YTDLP_PATH: FAKE_YTDLP,
  QA_YTDLP_LOG: YTDLP_LOG,
  SPOTIFY_EMBED_BASE: `http://127.0.0.1:${SPOTIFY_FAKE_PORT}/embed`,
  // Web API не используем: недостижимые адреса, чтобы случайные ключи из окружения не увели в сеть
  SPOTIFY_API_BASE: 'http://127.0.0.1:9', SPOTIFY_ACCOUNTS_BASE: 'http://127.0.0.1:9',
  // «Смотреть вместе» (tests/v14-watch): маленькие лимиты, чтобы проверить отказ по размеру, LRU и уборку
  WATCH_MAX_MB: '2', WATCH_CACHE_GB: '0.001', WATCH_IDLE_SEC: '3',
});
delete process.env.SPOTIFY_CLIENT_ID; delete process.env.SPOTIFY_CLIENT_SECRET;
delete process.env.YTDLP_COOKIES; delete process.env.YTDLP_PROXY;
await import(path.join(ROOT, 'server', 'index.js'));
