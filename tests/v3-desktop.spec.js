// v3: приложение для ПК (SPEC-v3 §4, §5.6) — smoke собранного Electron под xvfb. owner: qa
// Запускается, только если есть desktop/dist/linux-unpacked (иначе skip с причиной).
// Под headless-окружением без DISPLAY: `xvfb-run -a npx playwright test tests/v3-desktop.spec.js`
// (или тест сам поднимает Xvfb, если он установлен).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import { ROOT, BASE_URL } from './fixtures/env.js';
import { sleep } from './fixtures/api.js';

const UNPACKED = path.join(ROOT, 'desktop', 'dist', 'linux-unpacked');

function findExe() {
  if (!fs.existsSync(UNPACKED)) return null;
  const skip = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);
  const cands = fs.readdirSync(UNPACKED).filter((f) => {
    const p = path.join(UNPACKED, f);
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) && !skip.has(f) && !/\.(so|so\.\d+|bin|pak|dat|json)$/.test(f);
  });
  return cands.length ? path.join(UNPACKED, cands.find((c) => /sozvon/i.test(c)) || cands[0]) : null;
}

let xvfb = null;
test.beforeAll(async () => {
  if (!process.env.DISPLAY && findExe()) {
    // свой Xvfb на свободном дисплее
    const disp = ':' + (90 + (Number(process.env.QA_PORT || 3200) % 9));
    xvfb = spawn('Xvfb', [disp, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    process.env.DISPLAY = disp;
    await sleep(800);
  }
});
test.afterAll(() => { if (xvfb) process.kill(xvfb.pid, 'SIGTERM'); });

test('desktop: окно открывается, грузит страницу сервера, мост window.sozvonDesktop.isDesktop === true', async () => {
  const exe = findExe();
  test.skip(!exe, `нет сборки ${path.relative(ROOT, UNPACKED)} (desktop: npm run pack в desktop/) — smoke пропущен`);
  test.setTimeout(90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-desktop-qa-'));
  const app = await electron.launch({
    executablePath: exe,
    args: [`--server=${BASE_URL}`, `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, SOZVON_ALLOW_INSECURE_LOCALHOST: '1', SOZVON_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 60_000,
  });
  try {
    // главное окно — то, что открыло наш сервер (не окно настройки/выбора экрана)
    let win;
    await expect.poll(async () => {
      for (const w of app.windows()) if (w.url().startsWith(BASE_URL)) { win = w; return true; }
      return false;
    }, { timeout: 40_000, message: `окно с ${BASE_URL}` }).toBe(true);
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('#auth-screen, #app').locator('visible=true').first()).toBeVisible({ timeout: 20_000 });
    const bridge = await win.evaluate(() => ({
      isDesktop: window.sozvonDesktop?.isDesktop, version: window.sozvonDesktop?.version,
      fns: ['onPttChange', 'onToggleMute', 'onToggleDeafen', 'setBadge', 'getScreenSources', 'setSettings']
        .filter((k) => typeof window.sozvonDesktop?.[k] === 'function'),
      nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      htmlDesktop: document.documentElement.classList.contains('is-desktop'),
    }));
    expect(bridge.isDesktop).toBe(true);
    expect(typeof bridge.version).toBe('string');
    expect(bridge.fns).toEqual(['onPttChange', 'onToggleMute', 'onToggleDeafen', 'setBadge', 'getScreenSources', 'setSettings']);
    expect(bridge.nodeLeak, 'contextIsolation: в странице нет require/process').toBe(false);
    expect(bridge.htmlDesktop, 'html.is-desktop — «Скачать приложение» скрыто').toBe(true);
    // кнопка скачивания скрыта внутри приложения
    const dl = win.locator('#btn-download-app');
    if (await dl.count()) await expect(dl).toBeHidden();
    // настройки окна в main-процессе
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => {
      const p = w.webContents.getLastWebPreferences?.() || {};
      return { url: w.webContents.getURL(), contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration };
    }));
    const main = prefs.find((p) => p.url.startsWith(BASE_URL));
    expect(main).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    await win.screenshot({ path: 'tests/screens-qa/v3/desktop-linux.png' }).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
});
