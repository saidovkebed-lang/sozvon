// Playwright config for Sozvon QA (owner: qa)
import { defineConfig } from '@playwright/test';
import { PORT, BASE_URL, DATA_DIR, MUSIC_PORT, MUSIC_BASE_URL } from './tests/fixtures/env.js';

// Параллельные прогоны (QA_PORT≠3200) пишут артефакты в отдельный каталог, чтобы не мешать друг другу.
const RESULTS = PORT === 3200 ? 'tests/.results' : `tests/.results/p${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js$/,
  // Один сервер и один бот на весь прогон -> последовательно.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `${RESULTS}/results.json` }]],
  outputDir: `${RESULTS}/artifacts`,
  globalSetup: './tests/global-setup.js',
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    permissions: ['microphone', 'camera'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--auto-accept-this-tab-capture',
        '--autoplay-policy=no-user-gesture-required',
        '--ignore-certificate-errors',
      ],
    },
  },
  projects: [
    { name: 'chromium' },
    {
      // Реальная политика автозапуска Chrome (без --autoplay-policy=no-user-gesture-required):
      // звук должен заиграть благодаря жесту пользователя (клик «Подключиться»).
      name: 'chromium-real-autoplay',
      grep: /@autoplay/,
      use: {
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
            '--auto-accept-this-tab-capture',
            '--ignore-certificate-errors',
          ],
        },
      },
    },
  ],
  webServer: [{
    // tests/start-server.js очищает DATA_DIR и затем импортирует server/index.js.
    // (webServer в Playwright стартует ДО globalSetup, поэтому очистка — здесь, иначе
    //  globalSetup снёс бы данные уже работающего сервера.)
    command: 'node tests/start-server.js',
    url: `${BASE_URL}/api/config`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // SOZVON_PUSH_ALLOW_HTTP: тестовый приёмник push на http://127.0.0.1 (в бою только https)
    env: { PORT: String(PORT), HTTPS: '1', DATA_DIR, SOZVON_PUSH_ALLOW_HTTP: '1' },
  }, {
    // v2: музыкальный стенд — фейковые yt-dlp и Spotify embed (tests/start-server-music.js)
    command: 'node tests/start-server-music.js',
    url: `${MUSIC_BASE_URL}/api/config`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PORT: String(MUSIC_PORT), HTTPS: '1' },
  }],
});
