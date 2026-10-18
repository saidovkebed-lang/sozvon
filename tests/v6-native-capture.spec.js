// v6: свой захват экрана приложения для ПК (Windows: sozvon-capture.exe, DXGI Desktop Duplication — не прячет
// курсор в играх, в отличие от захвата Chromium через Windows Graphics Capture).
// Здесь — Electron из исходников desktop/ под Xvfb с подделкой помощника (tests/fixtures/fake-capture.cjs,
// тот же протокол): кадры доходят до зрителя-браузера, пауза без зрителей, остановка, «окно закрыто», фолбэк.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { test, expect, loginViaToken, createServerUI, inviteCode, joinServerUI, joinVoiceUI, watchScreen } from './fixtures/ui.js';
import { ROOT, BASE_URL } from './fixtures/env.js';
import { registerApi, uniqueName, sleep } from './fixtures/api.js';

const DESKTOP = path.join(ROOT, 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-capture.cjs');

let xvfb = null;
test.beforeAll(async () => {
  if (!process.env.DISPLAY && fs.existsSync(ELECTRON)) {
    const disp = ':' + (80 + (Number(process.env.QA_PORT || 3200) % 9));
    xvfb = spawn('Xvfb', [disp, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    process.env.DISPLAY = disp;
    await sleep(800);
  }
});
test.afterAll(() => {
  if (!xvfb) return;
  process.kill(xvfb.pid, 'SIGTERM');
  delete process.env.DISPLAY; // дисплей был наш — следующим файлам тестов он не достаётся
});

// По умолчанию демонстрация идёт штатным захватом Chromium/Windows; свой захват — галочка в трее (ownCapture)
async function launch(env = {}, cfg = { ownCapture: true }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-nc-'));
  if (cfg) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(cfg));
  const logFile = path.join(userData, 'fake.log');
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--server=${BASE_URL}`, `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, SOZVON_ALLOW_INSECURE_LOCALHOST: '1', SOZVON_CAPTURE_FAKE: FAKE, SOZVON_CAPTURE_FAKE_LOG: logFile, ...env },
    timeout: 60_000,
  });
  let win;
  await expect.poll(async () => {
    for (const w of app.windows()) if (w.url().startsWith(BASE_URL)) { win = w; return true; }
    return false;
  }, { timeout: 40_000 }).toBe(true);
  await win.waitForLoadState('domcontentloaded');
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const reg = await registerApi(uniqueName('nc'));
  await win.evaluate((t) => localStorage.setItem('sozvon.token', t), reg.token);
  await win.reload();
  await expect(win.locator('#app')).toBeVisible({ timeout: 20_000 });
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  return { app, win, errors, readLog };
}

/** Электрон-стример A + браузер-зритель B в одном голосовом канале */
async function setup(makePage, env, cfg) {
  const A = await launch(env, cfg);
  await createServerUI(A.win, 'Свой захват');
  const code = await inviteCode(A.win);
  const pb = await makePage({ name: 'B' });
  await loginViaToken(pb, 'ncb');
  await joinServerUI(pb, code, 'Свой захват');
  await joinVoiceUI(A.win);
  await joinVoiceUI(pb);
  await expect(A.win.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });
  return { ...A, pb };
}

async function startShare(win) {
  await win.locator('#ctrl-screen').click();
  const modal = win.locator('#modal-stream');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.source-card').first()).toBeVisible({ timeout: 15000 });
  await modal.locator('#btn-stream-start').click();
  await expect(modal).toBeHidden();
}

const kindOfMyScreen = (win) => win.evaluate(() => {
  const t = window.__sozvon?.rtc?.local?.screen?.getVideoTracks()[0];
  return t ? t.constructor.name : null;
});

test.describe('v6: свой захват экрана (приложение для ПК)', () => {
  test.skip(!fs.existsSync(ELECTRON), 'нет desktop/node_modules (npm ci в desktop/)');
  test.setTimeout(150_000);

  test('кадры помощника доходят до зрителя; без зрителей — пауза; остановка завершает помощник', async ({ makePage }) => {
    const { app, win, errors, readLog, pb } = await setup(makePage);
    try {
      expect(await win.evaluate(() => window.sozvonDesktop.nativeCapture)).toBe(true);
      await startShare(win);
      await expect.poll(() => kindOfMyScreen(win), { timeout: 15000 }).toBe('MediaStreamTrackGenerator');
      expect(readLog()).toMatch(/start --monitor \d+,\d+,\d+,\d+ --max-width 1280 --max-height 720 --fps 30/);
      // никто не смотрит → через ~3 с помощник на паузе
      await expect.poll(() => /pause/.test(readLog()), { timeout: 10000 }).toBe(true);

      await watchScreen(pb);
      await expect.poll(() => /resume/.test(readLog()), { timeout: 10000 }).toBe(true);
      const video = pb.locator('.tile--screen video');
      await expect.poll(() => video.evaluate((v) => v.videoWidth), { timeout: 20000 }).toBe(1280);
      // картинка живая: кадры меняются (бегущий квадрат)
      const snap = () => video.evaluate((v) => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 36;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
        return Array.from(g.getImageData(0, 0, 64, 36).data.filter((_, i) => i % 4 === 0)).join(',');
      });
      const s1 = await snap();
      await pb.waitForTimeout(700);
      expect(await snap()).not.toBe(s1);

      // смена качества на лету → помощник перезапущен с 1080p60
      await win.evaluate(async () => (await import('/js/voice/voice.js')).setStreamQuality('1080p60'));
      await expect.poll(() => /--max-width 1920 --max-height 1080 --fps 60/.test(readLog()), { timeout: 10000 }).toBe(true);

      // остановка демонстрации → оба помощника (до и после смены качества) завершились
      await win.locator('#ctrl-screen').click();
      await expect(win.locator('#ctrl-screen')).not.toHaveClass(/is-on/);
      await expect.poll(() => (readLog().match(/^\d+ exit/gm) || []).length, { timeout: 10000 }).toBe(2);
      expect((readLog().match(/^\d+ start/gm) || []).length).toBe(2);
      await expect(pb.locator('.tile--screen')).toHaveCount(0, { timeout: 20000 });
      expect(errors).toEqual([]);
    } finally {
      await app.close().catch(() => {});
    }
  });

  test('в голосовом канале окно не «засыпает» в фоне (стрим не теряет качество при свёрнутой Astra)', async ({ makePage }) => {
    const { app, win } = await setup(makePage);
    try {
      const bg = () => app.evaluate(({ BrowserWindow, app: a }) => {
        const w = BrowserWindow.getAllWindows().find((x) => /^https?:/.test(x.webContents.getURL()));
        return { throttling: w.webContents.getBackgroundThrottling(), noBackgrounding: a.commandLine.hasSwitch('disable-renderer-backgrounding') };
      });
      // setup() уже зашёл в голосовой
      await expect.poll(bg).toEqual({ throttling: false, noBackgrounding: true });
      await win.locator('#btn-disconnect').click();
      await expect(win.locator('#voice-panel')).toBeHidden();
      await expect.poll(bg).toEqual({ throttling: true, noBackgrounding: true });
      await joinVoiceUI(win);
      await expect.poll(bg).toEqual({ throttling: false, noBackgrounding: true });
      // перезагрузка страницы = выход из голоса
      await win.reload();
      await expect.poll(bg).toEqual({ throttling: true, noBackgrounding: true });
    } finally {
      await app.close().catch(() => {});
    }
  });

  test('окно закрыто (помощник выходит с кодом 3) → демонстрация останавливается с понятным сообщением', async ({ makePage }) => {
    const { app, win, pb, readLog } = await setup(makePage, { SOZVON_CAPTURE_FAKE_MODE: 'exit3' });
    try {
      await startShare(win);
      await expect(win.locator('.toast', { hasText: 'Окно закрыто' })).toBeVisible({ timeout: 15000 });
      await expect(win.locator('#ctrl-screen')).not.toHaveClass(/is-on/);
      await expect(pb.locator('.tile--screen')).toHaveCount(0, { timeout: 20000 });
    } finally {
      await app.close().catch(() => {});
    }
  });

  test('по умолчанию — штатный захват Windows/Chromium: помощник не запускается, трансляция идёт', async ({ makePage }) => {
    const { app, win, readLog, pb } = await setup(makePage, {}, null);
    try {
      expect(await win.evaluate(() => window.sozvonDesktop.nativeCapture)).toBe(false);
      await startShare(win);
      await expect.poll(() => kindOfMyScreen(win), { timeout: 20000 }).toBe('MediaStreamTrack');
      await watchScreen(pb);
      await expect.poll(() => pb.locator('.tile--screen video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
      expect(readLog()).toBe(''); // sozvon-capture не запускался
    } finally {
      await app.close().catch(() => {});
    }
  });

  test('помощник не прислал кадров → обычный захват Chromium (демонстрация всё равно идёт)', async ({ makePage }) => {
    const { app, win, readLog, pb } = await setup(makePage, { SOZVON_CAPTURE_FAKE_MODE: 'silent' });
    try {
      await startShare(win);
      await expect.poll(() => kindOfMyScreen(win), { timeout: 20000 }).toBe('MediaStreamTrack');
      await expect.poll(() => /^\d+ exit/m.test(readLog()), { timeout: 10000 }).toBe(true);
      await watchScreen(pb);
      await expect.poll(() => pb.locator('.tile--screen video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    } finally {
      await app.close().catch(() => {});
    }
  });
});

// Замер (PERF=1): процессор Electron (без помощника) при передаче 1080p60 через свой захват
test('нагрузка: свой захват (PERF_Q=1080p60 по умолчанию)', async ({ makePage }) => {
  test.skip(!process.env.PERF || !fs.existsSync(ELECTRON), 'замер — только с PERF=1');
  test.setTimeout(150_000);
  const { app, win, pb } = await setup(makePage, process.env.PERF_LEGACY ? { SOZVON_CAPTURE_FAKE: '/nonexistent' } : {});
  try {
    await win.evaluate(async (q) => (await import('/js/prefs.js')).prefs.set('stream.quality', q), process.env.PERF_Q || '1080p60');
    await startShare(win);
    if (!process.env.PERF_NOWATCH) {
      await watchScreen(pb);
      await expect.poll(() => pb.locator('.tile--screen video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    }
    await pb.waitForTimeout(3000);
    const ticks = () => {
      const out = { electron: 0, helper: 0, main: 0, renderer: 0, gpu: 0, other: 0 };
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (!cmd.includes(path.join('desktop', 'node_modules', 'electron'))) continue;
          const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
          const t = Number(f[11]) + Number(f[12]);
          if (cmd.includes('fake-capture')) { out.helper += t; continue; }
          out.electron += t;
          const type = (cmd.match(/--type=([a-z-]+)/) || [])[1];
          if (!type) out.main += t; else if (type === 'renderer') out.renderer += t; else if (type === 'gpu-process') out.gpu += t; else out.other += t;
        } catch { /* ignore */ }
      }
      return out;
    };
    const fps = () => pb.locator('.tile--screen video').evaluate((v) => v.getVideoPlaybackQuality?.().totalVideoFrames || 0, null, { timeout: 2000 }).catch(() => 0);
    const t0 = ticks(); const f0 = await fps();
    await pb.waitForTimeout(10000);
    const t1 = ticks(); const f1 = await fps();
    const size = await pb.locator('.tile--screen video').evaluate((v) => `${v.videoWidth}x${v.videoHeight}`, null, { timeout: 2000 }).catch(() => '-');
    const line = `${process.env.PERF_LEGACY ? 'захват Chromium' : 'свой захват'} ${size}: Electron ${(t1.electron - t0.electron) / 10}% ядра, подделка помощника ${(t1.helper - t0.helper) / 10}%, у зрителя ${(f1 - f0) / 10} кадр/с; main ${(t1.main - t0.main) / 10}% renderer ${(t1.renderer - t0.renderer) / 10}% gpu ${(t1.gpu - t0.gpu) / 10}% other ${(t1.other - t0.other) / 10}%`;
    console.log(line);
    test.info().annotations.push({ type: 'perf', description: line });
  } finally {
    await app.close().catch(() => {});
  }
});
