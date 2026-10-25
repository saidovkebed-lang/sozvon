// v16: качество голоса — «церковный хор» (эхо/двойной звук) и нейросетевое шумоподавление RNNoise.
//  1. Каждый удалённый поток играет ровно одним путём (элемент <audio> ИЛИ WebAudio при усилении > 100 %),
//     элементы — в выбранном устройстве вывода (по ним Chromium выбирает опору эхоподавления).
//  2. Констрейнты захвата: echoCancellation/autoGainControl по настройкам, noiseSuppression браузера
//     выключен, пока работает RNNoise (без двойной обработки), и включён в «Стандартном».
//  3. RNNoise реально подавляет шум (тон + белый шум с фейкового микрофона из WAV-файла).
//  4. Фолбэк: worklet не загрузился / молча выдаёт тишину → «Стандартное» + тост.
//  5. Звук экрана без изоляции (приложение для ПК): голоса звонка в нём приглушаются (фильтр своего звука).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, _electron as electron } from '@playwright/test';
import {
  test, expect, loginViaToken, createServerUI, joinServerUI, inviteCode, joinVoiceUI,
  watchScreen,
} from './fixtures/ui.js';
import { openSection, closeSettings, setPrefUI } from './fixtures/v2.js';
import { BASE_URL, ROOT } from './fixtures/env.js';

async function pairInVoice(makePage, serverName, opts = {}) {
  const pa = await makePage({ name: 'A', ...(opts.a || {}) });
  const pb = await makePage({ name: 'B', ...(opts.b || {}) });
  if (opts.initA) await pa.addInitScript(opts.initA);
  const ua = await loginViaToken(pa, 'au');
  const ub = await loginViaToken(pb, 'bu');
  await createServerUI(pa, serverName);
  const code = await inviteCode(pa);
  await joinServerUI(pb, code, serverName);
  await joinVoiceUI(pa);
  await joinVoiceUI(pb);
  for (const [p, u] of [[pa, ub], [pb, ua]]) {
    const tile = p.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: u.user.username }).first();
    await expect(tile).toHaveAttribute('data-connected', 'true', { timeout: 20000 });
  }
  return { pa, pb, ua, ub };
}

const paths = (p) => p.evaluate(() => window.__sozvon.audio.playbackPaths());

/** Все медиа-элементы страницы, которые сейчас реально играют звук этого трека. */
const audibleElementsPerTrack = (p) => p.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('audio, video')) {
    const s = el.srcObject;
    if (!s || el.muted || el.volume === 0 || el.paused) continue;
    for (const t of s.getAudioTracks()) out[t.id] = (out[t.id] || 0) + 1;
  }
  return out;
});

const rawSettings = (p) => p.evaluate(() => {
  const c = window.__sozvon.audio.engine.voiceChain;
  const t = c?.rawTrack;
  if (!t) return null;
  const s = t.getSettings();
  return { mode: c.activeMode, echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl };
});

test.describe('v16: «хор» — один путь воспроизведения на собеседника', () => {
  test('элемент ИЛИ WebAudio, не оба; 200 % → WebAudio; deafen → 0 путей; звук идёт; устройство вывода у всех элементов', async ({ makePage }) => {
    test.setTimeout(150_000);
    const { pa, pb, ua, ub } = await pairInVoice(makePage, 'Хор');
    for (const [p, other] of [[pa, ub], [pb, ua]]) {
      await expect.poll(async () => (await paths(p)).filter((x) => x.kind === 'mic').map((x) => [x.path, x.paths]),
        { message: 'голос собеседника: ровно один путь — элемент', timeout: 15000 }).toEqual([['element', 1]]);
      // ни один трек не играет двумя элементами (например, <audio> + <video> плитки)
      const per = await audibleElementsPerTrack(p);
      expect(Object.values(per).every((n) => n === 1), JSON.stringify(per)).toBe(true);
      // звук реально доходит (уровень после громкости)
      await expect.poll(() => p.evaluate((id) => window.__sozvon.audio.getUserLevel(id), other.user.id),
        { message: 'уровень собеседника > 0', timeout: 10000, intervals: [100] }).toBeGreaterThan(0.01);
      // сразу после входа у всех элементов то же устройство вывода, что в настройках (по умолчанию — '')
      expect((await paths(p)).every((x) => x.sinkId === '' || x.sinkId === null)).toBe(true);
    }

    // усиление 200 % — через WebAudio, элемент заглушён: снова ровно один путь
    await pa.evaluate(async (id) => (await import('/js/prefs.js')).prefs.setUserVolume(id, 200), ub.user.id);
    await expect.poll(async () => (await paths(pa)).filter((x) => x.kind === 'mic').map((x) => [x.path, x.element, x.webaudio, x.paths]),
      { message: '200 %: только WebAudio' }).toEqual([['webaudio', false, true, 1]]);
    await expect.poll(() => pa.evaluate((id) => window.__sozvon.audio.getUserLevel(id), ub.user.id),
      { message: '200 %: уровень > 0', timeout: 10000, intervals: [100] }).toBeGreaterThan(0.01);
    // обратно 60 % — элемент с громкостью 0.6, шина отключена
    await pa.evaluate(async (id) => (await import('/js/prefs.js')).prefs.setUserVolume(id, 60), ub.user.id);
    await expect.poll(async () => (await paths(pa)).filter((x) => x.kind === 'mic').map((x) => [x.path, x.element, x.webaudio, x.paths, x.target]),
      { message: '60 %: только элемент' }).toEqual([['element', true, false, 1, 0.6]]);
    expect(await pa.evaluate(() => document.querySelector('audio.remote-audio').volume)).toBeCloseTo(0.6, 5);

    // deafen — ни одного пути
    await pa.locator('#ctrl-deafen').click();
    await expect.poll(async () => (await paths(pa)).map((x) => x.paths), { message: 'deafen: тишина' }).toEqual([0]);
    await pa.locator('#ctrl-deafen').click();
    await expect.poll(async () => (await paths(pa)).map((x) => x.paths)).toEqual([1]);
  });

  test('AEC-констрейнты: эхоподавление включено всегда, браузерное NS выключено при RNNoise и включено в «Стандартном»', async ({ makePage }) => {
    test.setTimeout(150_000);
    const { pa, pb, ua } = await pairInVoice(makePage, 'Констрейнты');
    await expect.poll(() => rawSettings(pa), { timeout: 15000 })
      .toEqual({ mode: 'rnnoise', echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    const senderTrack = () => pa.evaluate(() => {
      const p = [...window.__sozvon.rtc.peers.values()][0];
      return p?.micSender?.track?.id || null;
    });
    const before = await senderTrack();
    await openSection(pa, 'voice');
    await setPrefUI(pa, 'audio.noiseSuppression', 'standard');
    await expect.poll(() => rawSettings(pa)).toEqual({ mode: 'standard', echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    await setPrefUI(pa, 'audio.noiseSuppression', 'off');
    await expect.poll(() => rawSettings(pa)).toEqual({ mode: 'off', echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    await setPrefUI(pa, 'audio.autoGain', false);
    await expect.poll(() => rawSettings(pa)).toEqual({ mode: 'off', echoCancellation: true, noiseSuppression: false, autoGainControl: false });
    await setPrefUI(pa, 'audio.noiseSuppression', 'rnnoise');
    await expect.poll(() => rawSettings(pa)).toEqual({ mode: 'rnnoise', echoCancellation: true, noiseSuppression: false, autoGainControl: false });
    await closeSettings(pa);
    // смена обработки на лету не меняет отправляемый трек (без перезахода и пересогласования)
    expect(await senderTrack()).toBe(before);
    // индикатор «говорит» и звук после всех переключений работают
    const tileA = pb.locator('#stage-grid .tile[data-socket-id]').filter({ hasText: ua.user.username }).first();
    await expect(tileA).toHaveClass(/is-speaking/, { timeout: 15000 });
    await expect.poll(() => pb.evaluate((id) => window.__sozvon.audio.getUserLevel(id), ua.user.id),
      { timeout: 10000, intervals: [100] }).toBeGreaterThan(0.01);
  });
});

/* ---------------------------------------------------------------- RNNoise ---------------------------------- */

/** WAV 48 кГц моно 16 бит: тон 300 Гц + белый шум (детерминированный ГПСЧ). */
function writeToneNoiseWav(file, seconds = 6) {
  const rate = 48000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const v = 0.25 * Math.sin(2 * Math.PI * 300 * i / rate) + 0.12 * rnd();
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/** Средняя энергия полосы lo..hi Гц трека (дБ), за ms миллисекунд. */
async function bandDb(page, lo, hi, ms = 1500) {
  return page.evaluate(async ({ lo, hi, ms }) => {
    const t = [...window.__sozvon.audio.engine.tests][0].chain.processedTrack;
    const ctx = new AudioContext({ sampleRate: 48000 });
    const src = ctx.createMediaStreamSource(new MediaStream([t]));
    const an = ctx.createAnalyser();
    an.fftSize = 4096; an.smoothingTimeConstant = 0;
    src.connect(an);
    const buf = new Float32Array(an.frequencyBinCount);
    const binHz = ctx.sampleRate / an.fftSize;
    let acc = 0; let k = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 60));
      an.getFloatFrequencyData(buf);
      let e = 0; let c = 0;
      for (let i = Math.floor(lo / binHz); i < Math.ceil(hi / binHz); i++) { e += 10 ** (buf[i] / 10); c++; }
      acc += e / c; k++;
    }
    await ctx.close();
    return 10 * Math.log10(acc / k + 1e-20);
  }, { lo, hi, ms });
}

test.describe('v16: RNNoise', () => {
  test('фейковый микрофон «тон + белый шум»: RNNoise гасит шумовую полосу; переключение на лету', async ({}, testInfo) => {
    test.setTimeout(90_000);
    const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-v16-')), 'tone-noise.wav');
    writeToneNoiseWav(wav);
    const browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
        '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
    });
    const errors = [];
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'], baseURL: BASE_URL });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/');
      await page.waitForFunction(() => !!window.__sozvon?.audio?.engine);
      // гейт открыт всегда и без AGC — сравниваем только шумоподавление
      await page.evaluate(async () => {
        const { prefs } = await import('/js/prefs.js');
        prefs.set('audio.sensitivityAuto', false);
        prefs.set('audio.sensitivityDb', -100);
        prefs.set('audio.autoGain', false);
        prefs.set('audio.noiseSuppression', 'off');
        const { audioEngine } = await import('/js/audio/engine.js');
        window.__stopTest = await audioEngine.startMicTest({});
      });
      await expect.poll(() => page.evaluate(() => window.__sozvon.audio.getNoiseMode())).toBe('off');
      await page.waitForTimeout(800);
      const offNoise = await bandDb(page, 3000, 12000);
      // на лету — в RNNoise (та же цепочка, тот же выходной трек)
      const trackBefore = await page.evaluate(() => [...window.__sozvon.audio.engine.tests][0].chain.processedTrack.id);
      await page.evaluate(async () => (await import('/js/prefs.js')).prefs.set('audio.noiseSuppression', 'rnnoise'));
      await expect.poll(() => page.evaluate(() => window.__sozvon.audio.getNoiseMode())).toBe('rnnoise');
      await page.waitForTimeout(1200);
      const rnNoise = await bandDb(page, 3000, 12000);
      testInfo.annotations.push({ type: 'rnnoise', description: `шум 3–12 кГц: off ${offNoise.toFixed(1)} дБ → rnnoise ${rnNoise.toFixed(1)} дБ` });
      console.log(`[v16] шум 3–12 кГц: off ${offNoise.toFixed(1)} дБ → rnnoise ${rnNoise.toFixed(1)} дБ`);
      expect(offNoise, 'без шумоподавления шум на месте').toBeGreaterThan(-90);
      expect(offNoise - rnNoise, 'RNNoise гасит шум хотя бы на 10 дБ').toBeGreaterThan(10);
      expect(await page.evaluate(() => [...window.__sozvon.audio.engine.tests][0].chain.processedTrack.id), 'выходной трек не менялся').toBe(trackBefore);
      // RNNoise рассчитан на 48 кГц: контекст микрофона именно такой (иначе — фолбэк)
      expect(await page.evaluate(() => window.__sozvon.audio.engine.micCtx.sampleRate)).toBe(48000);
      // и обратно — шум возвращается (модель не «залипла»)
      await page.evaluate(async () => (await import('/js/prefs.js')).prefs.set('audio.noiseSuppression', 'off'));
      await expect.poll(() => page.evaluate(() => window.__sozvon.audio.getNoiseMode())).toBe('off');
      await page.waitForTimeout(800);
      expect(await bandDb(page, 3000, 12000)).toBeGreaterThan(rnNoise + 10);
      await page.evaluate(() => window.__stopTest());
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('worklet RNNoise не загрузился (404) → «Стандартное» + тост, голос и «говорит» работают', async ({ makePage }) => {
    test.setTimeout(90_000);
    const page = await makePage();
    // загрузка модуля worklet RNNoise падает (как при 404 / блокировке / нехватке ресурсов)
    await page.addInitScript(() => {
      const orig = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = function (url, ...rest) {
        if (String(url).includes('rnnoise-worklet')) return Promise.reject(new DOMException('qa: worklet недоступен', 'AbortError'));
        return orig.call(this, url, ...rest);
      };
    });
    await loginViaToken(page, 'nowk');
    await createServerUI(page, 'Без модели');
    await joinVoiceUI(page);
    await expect.poll(() => page.evaluate(() => window.__sozvon.audio.getNoiseMode()), { timeout: 15000 }).toBe('standard');
    await expect(page.locator('.toast').filter({ hasText: /шумоподавление.*стандартное/i }).first()).toBeVisible({ timeout: 10000 });
    expect(await rawSettings(page)).toMatchObject({ mode: 'standard', echoCancellation: true, noiseSuppression: true });
    await expect(page.locator('#stage-grid .tile.is-speaking').first(), 'микрофон работает (фейковый бип)').toBeVisible({ timeout: 15000 });
    const panel = await openSection(page, 'voice');
    await expect(panel.locator('#rnnoise-fallback')).toBeVisible();
    await closeSettings(page);
  });

  test('worklet RNNoise молча выдаёт тишину → сторож переключает на «Стандартное» + тост', async ({ makePage }) => {
    test.setTimeout(90_000);
    const page = await makePage();
    // подменяем процессор: регистрируется под тем же именем, но ничего не выдаёт (как модель, не загрузившаяся внутри worklet)
    await page.addInitScript(() => {
      const stub = URL.createObjectURL(new Blob([
        "registerProcessor('@sapphi-red/web-noise-suppressor/rnnoise', class extends AudioWorkletProcessor { process() { return true; } });",
      ], { type: 'text/javascript' }));
      const orig = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = function (url, ...rest) {
        return orig.call(this, String(url).includes('rnnoise-worklet') ? stub : url, ...rest);
      };
    });
    await loginViaToken(page, 'silent');
    await createServerUI(page, 'Тихая модель');
    await joinVoiceUI(page);
    await expect.poll(() => page.evaluate(() => window.__sozvon.audio.getNoiseMode()), { timeout: 20000 }).toBe('standard');
    await expect(page.locator('.toast').filter({ hasText: /шумоподавление.*стандартное/i }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#stage-grid .tile.is-speaking').first()).toBeVisible({ timeout: 15000 });
  });
});

/* ------------------------------------------------- звук экрана без звука самого «Astra» ------------------- */

test.describe('v16: звук экрана без голосов звонка', () => {
  test('фильтр своего звука: пока «Astra» играет звук звонка, звук экрана приглушается; один путь у фейкового собеседника', async ({ makePage }) => {
    test.setTimeout(60_000);
    const page = await makePage();
    await loginViaToken(page, 'duck');
    const r = await page.evaluate(async () => {
      const { engine } = await import('/js/audio/engine.js');
      engine.unlock();
      // «собеседник» — тон в отдельном контексте, громкость управляем
      const gen = new AudioContext();
      const osc = gen.createOscillator(); osc.frequency.value = 220;
      const vol = gen.createGain(); vol.gain.value = 0;
      const voice = gen.createMediaStreamDestination();
      osc.connect(vol).connect(voice); osc.start();
      engine.syncRemote([{ socketId: 'fake-peer', kind: 'mic', stream: voice.stream }]);
      // «системный звук» (loopback) — другой тон
      const osc2 = gen.createOscillator(); osc2.frequency.value = 880;
      const loop = gen.createMediaStreamDestination();
      osc2.connect(loop); osc2.start();
      const f = await engine.createOwnAudioFilter(loop.stream.getAudioTracks()[0]);
      window.__duck = { f, vol, gen, raw: loop.stream.getAudioTracks()[0] };
      return { ok: !!f, paths: engine.playbackPaths().map((x) => x.paths) };
    });
    expect(r.ok, 'фильтр создан').toBe(true);
    expect(r.paths).toEqual([1]);
    const st = () => page.evaluate(() => ({ ...window.__duck.f.state }));
    // собеседник молчит — звук экрана идёт как есть
    await expect.poll(async () => (await st()).gain, { timeout: 5000 }).toBeGreaterThan(0.9);
    // собеседник «говорит» — звук экрана приглушён
    await page.evaluate(() => { window.__duck.vol.gain.value = 0.3; });
    await expect.poll(async () => { const s = await st(); return s.ducked && s.gain < 0.1; }, { timeout: 5000 }).toBe(true);
    // замолчал — через hold звук экрана вернулся
    await page.evaluate(() => { window.__duck.vol.gain.value = 0; });
    await expect.poll(async () => (await st()).gain, { timeout: 5000 }).toBeGreaterThan(0.9);
    // собеседник заглушён у меня (0 %) — его голос не играет, глушить нечего
    await page.evaluate(() => { window.__duck.vol.gain.value = 0.3; });
    await page.evaluate(async () => (await import('/js/prefs.js')).prefs.set('audio.outputVolume', 0));
    await expect.poll(async () => (await st()).gain, { timeout: 5000 }).toBeGreaterThan(0.9);
    await page.waitForTimeout(800);
    expect((await st()).ducked, 'заглушённый собеседник не приглушает звук экрана').toBe(false);
    await page.evaluate(async () => (await import('/js/prefs.js')).prefs.set('audio.outputVolume', 100));
    // остановка отправляемого трека освобождает и сам захват
    const ended = await page.evaluate(() => { window.__duck.f.track.stop(); return window.__duck.raw.readyState; });
    expect(ended).toBe('ended');
    await page.evaluate(() => window.__duck.gen.close());
  });

  test('приложение для ПК: трансляция со звуком отправляет отфильтрованный звук, зритель его получает; стоп освобождает захват', async ({ makePage }) => {
    test.setTimeout(150_000);
    // мост приложения для ПК + getDisplayMedia «со звуком» (canvas + тон): в Electron это системный loopback
    const initA = () => {
      window.sozvonDesktop = { isDesktop: true, platform: 'win32', version: 'qa' };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 180;
        const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = `hsl(${Date.now() / 10 % 360} 60% 50%)`; g.fillRect(0, 0, 320, 180); }, 50);
        const s = c.captureStream(15);
        const ac = new AudioContext();
        const o = ac.createOscillator(); o.frequency.value = 660;
        const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
        window.__rawScreenAudio = d.stream.getAudioTracks()[0];
        s.addTrack(window.__rawScreenAudio);
        return s;
      };
    };
    const { pa, pb, ua } = await pairInVoice(makePage, 'Стрим без эха', { initA });
    expect(await pa.evaluate(async () => (await import('/js/voice/media.js')).screenAudioIsolated())).toBe(false);
    await pa.evaluate(async () => (await import('/js/prefs.js')).prefs.set('stream.audio', true));
    // в приложении окно выбора требует источник из моста — запускаем демонстрацию напрямую (как после выбора)
    expect(await pa.evaluate(async () => (await import('/js/voice/voice.js')).startScreen({ audio: true }))).toBe(true);
    await expect.poll(() => pa.evaluate(() => window.__sozvon.audio.engine.duckFilters || 0), { timeout: 10000 }).toBe(1);
    const sent = await pa.evaluate(() => {
      const a = window.__sozvon.rtc.local.screen.getAudioTracks();
      return { n: a.length, raw: a[0] === window.__rawScreenAudio };
    });
    expect(sent, 'в трансляцию уходит отфильтрованный трек, не сырой loopback').toEqual({ n: 1, raw: false });
    await watchScreen(pb);
    await expect.poll(async () => (await paths(pb)).some((x) => x.kind === 'screen' && x.paths === 1), { timeout: 20000 }).toBe(true);
    await expect.poll(() => pb.evaluate((uid) => {
      const e = window.__sozvon.audio.engine;
      const r = [...e.remotes.values()].find((x) => x.kind === 'screen' && e.userIdOf(x.socketId) === uid);
      if (!r?.gain) return 0;
      if (!r.an) { r.an = e.outCtx.createAnalyser(); r.gain.connect(r.an); r.b = new Float32Array(2048); }
      r.an.getFloatTimeDomainData(r.b);
      return Math.max(...r.b.map(Math.abs));
    }, ua.user.id), { message: 'зритель слышит звук экрана', timeout: 15000, intervals: [200] }).toBeGreaterThan(0.01);
    await pa.evaluate(async () => (await import('/js/voice/voice.js')).stopScreen());
    await expect.poll(() => pa.evaluate(() => window.__rawScreenAudio.readyState), { timeout: 10000 }).toBe('ended');
  });
});

/* ------------------------------------------------- приложение для ПК (Electron) ---------------------------- */

const UNPACKED = path.join(ROOT, 'desktop', 'dist', 'linux-unpacked');
function findDesktopExe() {
  if (!fs.existsSync(UNPACKED)) return null;
  const skip = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);
  const c = fs.readdirSync(UNPACKED).filter((f) => {
    const st = fs.statSync(path.join(UNPACKED, f));
    return st.isFile() && (st.mode & 0o111) && !skip.has(f) && !/\.(so|so\.\d+|bin|pak|dat|json)$/.test(f);
  });
  return c.length ? path.join(UNPACKED, c.find((x) => /sozvon|astra/i.test(x)) || c[0]) : null;
}

test.describe('v16: приложение для ПК', () => {
  test('Electron: worklet и wasm RNNoise грузятся с сервера и гасят шум; звук экрана считается неизолированным', async () => {
    const exe = findDesktopExe();
    test.skip(!exe, `нет сборки ${path.relative(ROOT, UNPACKED)} (desktop: npm run pack) — проверка в Electron пропущена`);
    test.setTimeout(120_000);
    let xvfb = null;
    if (!process.env.DISPLAY) {
      const disp = ':' + (80 + (Number(process.env.QA_PORT || 3200) % 9));
      xvfb = spawn('Xvfb', [disp, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 800));
      process.env.DISPLAY = disp;
    }
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-v16-desktop-'));
    const app = await electron.launch({
      executablePath: exe,
      args: [`--server=${BASE_URL}`, `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
      env: { ...process.env, SOZVON_ALLOW_INSECURE_LOCALHOST: '1', SOZVON_SMOKE: '1' },
      timeout: 60_000,
    });
    try {
      let win;
      await expect.poll(async () => {
        for (const w of app.windows()) if (w.url().startsWith(BASE_URL)) { win = w; return true; }
        return false;
      }, { timeout: 40_000 }).toBe(true);
      await win.waitForLoadState('domcontentloaded');
      await win.waitForFunction(() => !!window.__sozvon?.audio?.engine, null, { timeout: 20_000 });
      const r = await win.evaluate(async () => {
        const { createRnnoiseNode } = await import('/js/audio/rnnoise.js');
        const { screenAudioIsolated } = await import('/js/voice/media.js');
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const len = ctx.sampleRate * 3;
        const b = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = b.getChannelData(0);
        let seed = 7;
        for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = (seed / 2 ** 32 * 2 - 1) * 0.1; }
        const src = ctx.createBufferSource(); src.buffer = b; src.loop = true;
        const rn = await createRnnoiseNode(ctx);
        const aIn = ctx.createAnalyser(); const aOut = ctx.createAnalyser();
        aIn.fftSize = 8192; aOut.fftSize = 8192;
        src.connect(aIn); src.connect(rn).connect(aOut);
        const sink = ctx.createGain(); sink.gain.value = 0; aOut.connect(sink).connect(ctx.destination);
        src.start();
        await new Promise((res) => setTimeout(res, 1500));
        const x = new Float32Array(8192); const y = new Float32Array(8192);
        aIn.getFloatTimeDomainData(x); aOut.getFloatTimeDomainData(y);
        const rms = (v) => Math.sqrt(v.reduce((s, q) => s + q * q, 0) / v.length);
        const out = { inDb: 20 * Math.log10(rms(x) + 1e-12), outDb: 20 * Math.log10(rms(y) + 1e-12), rate: ctx.sampleRate, isolated: screenAudioIsolated() };
        rn.destroy(); await ctx.close();
        return out;
      });
      console.log(`[v16] Electron RNNoise: шум ${r.inDb.toFixed(1)} дБ → ${r.outDb.toFixed(1)} дБ`);
      expect(r.rate).toBe(48000);
      expect(r.inDb - r.outDb, 'RNNoise в Electron гасит белый шум').toBeGreaterThan(6);
      expect(r.isolated, 'Electron не исключает свой звук из loopback').toBe(false);
    } finally {
      await app.close().catch(() => {});
      if (xvfb) { process.kill(xvfb.pid, 'SIGTERM'); delete process.env.DISPLAY; }
    }
  });
});
