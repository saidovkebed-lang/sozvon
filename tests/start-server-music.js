// Музыкальный стенд v2: отдельный сервер (MUSIC_PORT) с фейковым yt-dlp (YTDLP_PATH) и фейковым
// Spotify embed (SPOTIFY_EMBED_BASE) — чтобы не влиять на основной сервер старого набора.
import fs from 'node:fs';
import path from 'node:path';
import { MUSIC_DATA_DIR, ROOT, SPOTIFY_FAKE_PORT, FAKE_YTDLP, YTDLP_LOG, COVERS_FAKE_PORT, COVERS_FAKE_BASE, COVERS_LOG } from './fixtures/env.js';
import { startFakeSpotify } from './fixtures/fake-spotify.js';
import { startFakeCovers } from './fixtures/fake-covers.js';

fs.rmSync(MUSIC_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(MUSIC_DATA_DIR, 'music'), { recursive: true });
for (const f of [YTDLP_LOG, YTDLP_LOG + '.search', MUSIC_DATA_DIR + '-spotify.log', COVERS_LOG]) fs.rmSync(f, { force: true, recursive: true });
fs.chmodSync(FAKE_YTDLP, 0o755);
await startFakeSpotify(SPOTIFY_FAKE_PORT, MUSIC_DATA_DIR + '-spotify.log');
// обложки: фейковые Deezer/iTunes/картинки (tests/fixtures/fake-covers.js); в интернет — никогда
await startFakeCovers(COVERS_FAKE_PORT, COVERS_LOG);
Object.assign(process.env, {
  DATA_DIR: MUSIC_DATA_DIR,
  YTDLP_PATH: FAKE_YTDLP,
  QA_YTDLP_LOG: YTDLP_LOG,
  SPOTIFY_EMBED_BASE: `http://127.0.0.1:${SPOTIFY_FAKE_PORT}/embed`,
  // Web API не используем: недостижимые адреса, чтобы случайные ключи из окружения не увели в сеть
  SPOTIFY_API_BASE: 'http://127.0.0.1:9', SPOTIFY_ACCOUNTS_BASE: 'http://127.0.0.1:9',
  // «Смотреть вместе» (tests/v14-watch): маленькие лимиты, чтобы проверить отказ по размеру, LRU и уборку
  // «Astra Итоги» (tests/v18-recap): тестовые часы статистики POST /api/__test/stats
  SOZVON_TEST_HOOKS: '1',
  WATCH_MAX_MB: '2', WATCH_CACHE_GB: '0.001', WATCH_IDLE_SEC: '3',
  QA_COVERS_BASE: COVERS_FAKE_BASE, // фейковый yt-dlp/Spotify отдают миниатюры с этого адреса
  COVERS_DEEZER_BASE: `${COVERS_FAKE_BASE}/deezer`, COVERS_ITUNES_BASE: `${COVERS_FAKE_BASE}/itunes`,
  COVERS_IMAGE_HOSTS: '127.0.0.1', COVERS_MIN_INTERVAL_MS: '20',
});
delete process.env.COVERS; delete process.env.COVERS_PROXY;
delete process.env.SPOTIFY_CLIENT_ID; delete process.env.SPOTIFY_CLIENT_SECRET;
delete process.env.YTDLP_COOKIES; delete process.env.YTDLP_PROXY;
await import(path.join(ROOT, 'server', 'index.js'));
