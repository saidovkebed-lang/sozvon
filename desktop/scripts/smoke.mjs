// Smoke-тест приложения под xvfb: стартует бинарь (или `electron .`), подключается по CDP и проверяет мост.
//   xvfb-run -a node scripts/smoke.mjs [путь-к-бинарю] --server=http://localhost:3850
// Playwright берётся из корня проекта (../node_modules) — в desktop/ его не ставим.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const require = createRequire(path.resolve(desktopDir, '../package.json'));
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const server = (args.find((a) => a.startsWith('--server=')) || '--server=http://localhost:3850').slice(9);
const bin = args.find((a) => !a.startsWith('--'));
const port = 9300 + Math.floor(Math.random() * 500);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-smoke-'));

const cmd = bin ? path.resolve(bin) : path.join(desktopDir, 'node_modules/electron/dist/electron');
const cmdArgs = [...(bin ? [] : [desktopDir]), '--no-sandbox', `--remote-debugging-port=${port}`, `--server=${server}`];
const env = { ...process.env, XDG_CONFIG_HOME: home, SOZVON_SMOKE: '1', APPIMAGE_EXTRACT_AND_RUN: '1' };
console.log('$', cmd, cmdArgs.join(' '));
const child = spawn(cmd, cmdArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(`[app] ${d}`); });
child.stderr.on('data', (d) => { out += d; if (/smoke|error|fatal/i.test(String(d))) process.stdout.write(`[app:err] ${d}`); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(500); }
  }
  if (!browser) throw new Error('CDP не поднялся');
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(server));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error(`страница ${server} не открылась; есть: ${browser.contexts().flatMap((c) => c.pages()).map((p) => p.url())}`);
  await page.waitForLoadState('domcontentloaded');
  const res = await page.evaluate(async () => {
    const D = window.sozvonDesktop;
    const sources = D ? await D.getScreenSources({ thumbnailWidth: 160, thumbnailHeight: 90 }) : [];
    const sel = D && sources[0] ? await D.selectScreenSource(sources[0].id, { audio: false }) : null;
    let stream = null;
    if (sel) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const t = s.getVideoTracks()[0];
        stream = { label: t.label, settings: t.getSettings() };
        s.getTracks().forEach((x) => x.stop());
      } catch (e) { stream = { error: `${e.name}: ${e.message}` }; }
    }
    D?.setBadge(3);
    D?.setSettings({ pttEnabled: true, pttKey: 'KeyV', toggleMute: 'Ctrl+Shift+M', toggleDeafen: 'Ctrl+Shift+D' });
    D?.setVoiceState({ inVoice: true, muted: true, deafened: false });
    return {
      url: location.href,
      title: document.title,
      isDesktop: D?.isDesktop,
      version: D?.version,
      platform: D?.platform,
      keys: D ? Object.keys(D) : [],
      ua: navigator.userAgent,
      sources: sources.map((s) => ({ id: s.id, name: s.name, type: s.type, thumb: s.thumbnail.slice(0, 30) + `… (${s.thumbnail.length} chars)` })),
      selectScreenSource: sel,
      getDisplayMedia: stream,
      hasRequire: typeof window.require,
      hasProcess: typeof window.process,
    };
  });
  console.log(JSON.stringify(res, null, 2));
  // Глобальная рация: нажатие V через XTEST (xdotool), страница должна получить onPttChange(true/false)
  await page.evaluate(() => { window.__pttLog = []; window.sozvonDesktop?.onPttChange((p) => window.__pttLog.push(p)); });
  await sleep(1500);
  let ptt = 'xdotool не найден';
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('xdotool', ['keydown', 'v']); await sleep(300); execFileSync('xdotool', ['keyup', 'v']); await sleep(500);
    ptt = await page.evaluate(() => window.__pttLog);
  } catch (e) { ptt = `ошибка: ${e.message}`; }
  console.log('PTT events from global hook:', JSON.stringify(ptt));
  ok = res.isDesktop === true && res.hasRequire === 'undefined' && res.hasProcess === 'undefined';
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
  await browser.close().catch(() => {});
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
} finally {
  child.kill('SIGTERM');
  await sleep(800);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
