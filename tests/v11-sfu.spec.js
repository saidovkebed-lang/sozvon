// v11: трансляции экрана через SFU (mediasoup на сервере). Стример кодирует одну копию и отдаёт её серверу,
// сервер раздаёт зрителям. Голос/камера — по-прежнему mesh. Смотреть — только по «Смотреть»; без зрителей
// трансляция на паузе. Нет права STREAM — сервер не принимает трансляцию. SFU=0 / клиент без SFU — mesh.
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  test, expect, loginViaToken, createServerUI, inviteCode, joinServerUI, joinVoiceUI, startScreenShare, watchScreen,
} from './fixtures/ui.js';
import { trackPeerConnections } from './fixtures/v2.js';
import { PORT, ROOT } from './fixtures/env.js';
import { sleep, httpAt, uniqueName } from './fixtures/api.js';

const sfuInfo = (p) => p.evaluate(() => window.__sozvon.rtc.sfu.debug());
const myId = (p) => p.evaluate(() => window.__sozvon.socket.id);
/** emit с ack из браузера (сырой Socket.IO — как это сделал бы чужой клиент) */
const wsAck = (p, ev, payload) => p.evaluate(([e, d]) => new Promise((res) => window.__sozvon.socket.timeout(8000).emit(e, d, (err, r) => res(err ? { ok: false, error: 'timeout' } : r))), [ev, payload]);

/** Исходящее видео по всем RTCPeerConnection страницы: сколько дорожек реально кодируется (байты растут) */
async function liveOutboundVideo(page, ms = 2000) {
  const snap = () => page.evaluate(async () => {
    const out = {};
    let i = 0;
    for (const pc of window.__qaPcs || []) {
      i++;
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out[`${i}:${r.ssrc}`] = r.bytesSent || 0; });
    }
    return out;
  });
  const a = await snap();
  await sleep(ms);
  const b = await snap();
  return Object.keys(b).filter((k) => b[k] > (a[k] || 0)).length;
}

/** Входящее видео по mesh-соединениям (rtc.peers) — байты */
const meshInboundVideo = (page) => page.evaluate(async () => {
  let bytes = 0;
  for (const p of window.__sozvon.rtc.peers.values()) (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') bytes += r.bytesReceived || 0; });
  return bytes;
});
const sfuInboundVideo = async (page) => ((await sfuInfo(page)).recv?.inVideo || []).reduce((n, v) => n + v.bytes, 0);
const screenWidth = (page) => page.locator('.tile--screen video').first().evaluate((v) => v.videoWidth).catch(() => 0);

/** Стример A и зрители B, C в одном голосовом канале */
async function threeInVoice(makePage, name, { base } = {}) {
  const pages = [];
  for (const n of ['A', 'B', 'C']) {
    const p = await makePage({ name: n });
    await trackPeerConnections(p);
    pages.push(p);
  }
  const [pa, pb, pc] = pages;
  if (base) for (const p of pages) await loginAt(p, base); else for (const p of pages) await loginViaToken(p, 'sfu');
  await createServerUI(pa, name);
  const code = await inviteCode(pa);
  await joinServerUI(pb, code, name);
  await joinServerUI(pc, code, name);
  for (const p of pages) await joinVoiceUI(p);
  for (const p of pages) await expect(p.locator('.tile[data-connected="true"]')).toHaveCount(2, { timeout: 20000 });
  return { pa, pb, pc };
}

test.describe('v11: трансляции через SFU', () => {
  test.setTimeout(120_000);

  test('стример + 2 зрителя: видео через сервер, у стримера одна копия; смотреть/выйти; пауза без зрителей', async ({ makePage }) => {
    const { pa, pb, pc } = await threeInVoice(makePage, 'SFU трое');
    const aId = await myId(pa);
    await expect.poll(async () => (await sfuInfo(pa)).device, { message: 'SFU доступен клиенту' }).toBe(true);

    await startScreenShare(pa, '720p30');
    await expect.poll(async () => (await sfuInfo(pa)).producing, { timeout: 15000 }).toBe(true);
    // H.264, если браузер умеет его кодировать, иначе VP8
    const codec = (await sfuInfo(pa)).codec;
    const h264 = await pa.evaluate(() => (RTCRtpSender.getCapabilities('video')?.codecs || []).some((c) => /h264/i.test(c.mimeType)));
    expect(codec).toBe(h264 ? 'video/H264' : 'video/VP8');
    test.info().annotations.push({ type: 'codec', description: codec });
    // зрители видят плитку с «Смотреть», но ничего не принимают (по запросу)
    for (const p of [pb, pc]) {
      await expect(p.locator('#stage-grid .tile--screen .tile__watch')).toBeVisible({ timeout: 15000 });
      expect((await sfuInfo(p)).remote).toContain(aId);
    }
    // никто не смотрит → стример ничего не кодирует
    expect(await liveOutboundVideo(pa)).toBe(0);

    await watchScreen(pb);
    await watchScreen(pc);
    for (const p of [pb, pc]) {
      await expect.poll(() => screenWidth(p), { timeout: 20000 }).toBeGreaterThan(0);
      await expect.poll(() => sfuInboundVideo(p), { timeout: 15000 }).toBeGreaterThan(0);
      expect((await sfuInfo(p)).consuming).toContain(aId);
      expect(await meshInboundVideo(p), 'видео трансляции не идёт по mesh').toBe(0);
    }
    // одна кодируемая копия на сервер, зрителей — двое
    await expect.poll(async () => (await sfuInfo(pa)).viewers, { timeout: 10000 }).toBe(2);
    expect(await liveOutboundVideo(pa)).toBe(1);
    const srv = await wsAck(pa, 'sfu:debug', {});
    expect(srv.ok).toBe(true);
    expect(srv.producers.map((p) => p.kind)).toContain('video');
    expect(srv.viewers).toBe(2);
    // качество: maxBitrate/maxFramerate 720p30 на сендере SFU; смена на лету
    const enc = () => pa.evaluate(() => window.__sozvon.rtc.screenEncodings().filter((e) => e.peer === 'sfu'));
    await expect.poll(async () => (await enc())[0]?.maxBitrate, { timeout: 10000 }).toBe(2_500_000);
    await pa.evaluate(async () => (await import('/js/voice/voice.js')).setStreamQuality('1080p60'));
    await expect.poll(async () => (await enc())[0], { timeout: 10000 }).toMatchObject({ maxBitrate: 6_000_000, maxFramerate: 60 });

    // B выходит из трансляции → у стримера 1 зритель; C продолжает смотреть
    await pb.locator('#stage-grid .tile--screen .tile__unwatch').click();
    await expect(pb.locator('#stage-grid .tile--screen .tile__watch')).toBeVisible();
    await expect.poll(async () => (await sfuInfo(pa)).viewers, { timeout: 10000 }).toBe(1);
    expect((await sfuInfo(pb)).consuming).not.toContain(aId);
    const before = await screenWidth(pc);
    expect(before).toBeGreaterThan(0);
    // C тоже выходит → пауза: стример не кодирует ничего
    await pc.locator('#stage-grid .tile--screen .tile__unwatch').click();
    await expect.poll(async () => (await sfuInfo(pa)).viewers, { timeout: 10000 }).toBe(0);
    await expect.poll(() => pa.evaluate(() => window.__sozvon.rtc.sfu.producers.video?.rtpSender?.track ?? null), { timeout: 5000 }).toBe(null);
    expect(await liveOutboundVideo(pa)).toBe(0);
    // B снова смотрит — картинка возвращается
    await watchScreen(pb);
    await expect.poll(async () => (await sfuInfo(pa)).viewers, { timeout: 10000 }).toBe(1);
    await expect.poll(() => screenWidth(pb), { timeout: 20000 }).toBeGreaterThan(0);

    // остановка трансляции → плитки пропадают у всех, на сервере продюсеров нет
    await pa.locator('#ctrl-screen').click();
    for (const p of [pb, pc]) await expect(p.locator('.tile--screen')).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => (await wsAck(pa, 'sfu:debug', {})).producers.length).toBe(0);
  });

  test('зритель без SFU (не смог подключиться) смотрит напрямую, остальные — через сервер', async ({ makePage }) => {
    const { pa, pb, pc } = await threeInVoice(makePage, 'SFU смешанно');
    const aId = await myId(pa);
    // у C SFU «не работает»: клиент не загружает mediasoup (как при недоступном порте/старом браузере)
    await pc.evaluate(() => localStorage.setItem('sozvon.sfu', 'off'));
    await pc.locator('#btn-disconnect').click();
    await expect(pc.locator('#voice-panel')).toBeHidden();
    await joinVoiceUI(pc);
    await expect(pc.locator('.tile[data-connected="true"]')).toHaveCount(2, { timeout: 20000 });
    expect((await sfuInfo(pc)).device).toBe(false);

    await startScreenShare(pa, '720p30');
    await expect.poll(async () => (await sfuInfo(pa)).producing, { timeout: 15000 }).toBe(true);
    await watchScreen(pb);
    await watchScreen(pc);
    await expect.poll(() => screenWidth(pb), { timeout: 20000 }).toBeGreaterThan(0);
    await expect.poll(() => screenWidth(pc), { timeout: 20000 }).toBeGreaterThan(0);
    expect((await sfuInfo(pb)).consuming).toContain(aId);
    await expect.poll(() => meshInboundVideo(pc), { timeout: 15000 }).toBeGreaterThan(0);
    // стример: одна копия на сервер + одна напрямую для C
    await expect.poll(() => liveOutboundVideo(pa), { timeout: 15000 }).toBe(2);
    await pc.evaluate(() => localStorage.removeItem('sozvon.sfu'));
  });

  test('без права STREAM сервер не принимает трансляцию; смотреть может только участник голосового канала', async ({ makePage }) => {
    const pa = await makePage({ name: 'A' });
    const pb = await makePage({ name: 'B' });
    const pc = await makePage({ name: 'C' });
    await loginViaToken(pa, 'sfa'); await loginViaToken(pb, 'sfb'); await loginViaToken(pc, 'sfc');
    await createServerUI(pa, 'SFU права');
    const code = await inviteCode(pa);
    await joinServerUI(pb, code, 'SFU права');
    await joinServerUI(pc, code, 'SFU права');
    // владелец снимает STREAM у @everyone
    await pa.evaluate(async () => {
      const s = window.__sozvon.state.servers[0];
      const ev = s.roles.find((r) => r.id === s.id);
      const P = window.__sozvon.perms.PERMS;
      await new Promise((res) => window.__sozvon.socket.emit('role:update', { serverId: s.id, roleId: s.id, permissions: ev.permissions & ~P.STREAM }, res));
    });
    // C не в голосовом канале: SFU закрыт
    const notIn = await wsAck(pc, 'sfu:join', {});
    expect(notIn.ok).toBe(false);
    expect(notIn.error).toMatch(/не в голосовом/);

    await joinVoiceUI(pa);
    await joinVoiceUI(pb);
    await expect.poll(async () => (await sfuInfo(pb)).device, { timeout: 15000 }).toBe(true);
    const send = await wsAck(pb, 'sfu:transport', { direction: 'send' });
    expect(send.ok).toBe(false);
    expect(send.error).toMatch(/Нет права/);
    const prod = await wsAck(pb, 'sfu:produce', { transportId: 'x', kind: 'video', rtpParameters: {} });
    expect(prod.ok).toBe(false);
    expect(prod.error).toMatch(/Нет права/);
    // приём — можно (смотреть чужие трансляции право STREAM не нужно)
    expect((await wsAck(pb, 'sfu:transport', { direction: 'recv' })).ok).toBe(true);
    // владелец (у него все права) — транслирует через SFU
    await startScreenShare(pa, '720p30');
    await expect.poll(async () => (await sfuInfo(pa)).producing, { timeout: 15000 }).toBe(true);
    // C (не в канале) не может смотреть, даже зная id продюсера
    const producerId = await pa.evaluate(() => window.__sozvon.rtc.sfu.producers.video?.id);
    expect(producerId).toBeTruthy();
    const steal = await wsAck(pc, 'sfu:consume', { producerId, rtpCapabilities: {} });
    expect(steal.ok).toBe(false);
    await watchScreen(pb);
    await expect.poll(() => screenWidth(pb), { timeout: 20000 }).toBeGreaterThan(0);
  });
});

// ---------- отдельные серверы: SFU=0 и SFU с недостижимым адресом ----------
async function startServer(port, env) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'tests', 'start-server.js')], {
    env: { ...process.env, QA_PORT: String(port), PORT: String(port), HTTPS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d; });
  proc.stderr.on('data', (d) => { proc.log += d; });
  const base = `https://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await httpAt(base, 'GET', '/api/config')).status === 200) break; } catch { /* ещё стартует */ }
    await sleep(250);
  }
  await sleep(300); // SFU запускается сразу после сервера
  return proc;
}

async function loginAt(page, base) {
  const username = uniqueName('msh');
  const r = await httpAt(base, 'POST', '/api/register', { body: { username, password: 'secret123' } });
  if (r.status !== 200) throw new Error(`register: ${r.status}`);
  await page.goto(base + '/');
  await page.evaluate((t) => localStorage.setItem('sozvon.token', t), r.json.token);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
}

test.describe('v11: SFU=0 — запасной путь mesh', () => {
  const port = PORT + 50;
  let server = null;
  test.setTimeout(120_000);
  test.beforeAll(async () => {
    server = await startServer(port, { SFU: '0' });
    expect(server.log).toMatch(/SFU=0/);
  });
  test.afterAll(() => { server?.kill('SIGTERM'); });

  test('SFU выключен: трансляция идёт напрямую каждому зрителю, по запросу', async ({ makePage }) => {
    const { pa, pb, pc } = await threeInVoice(makePage, 'Mesh трое', { base: `https://localhost:${port}` });
    await expect.poll(async () => (await sfuInfo(pa)).available).toBe(false);
    await startScreenShare(pa, '720p30');
    await expect(pb.locator('#stage-grid .tile--screen .tile__watch')).toBeVisible({ timeout: 15000 });
    expect((await sfuInfo(pa)).producing).toBe(false);
    expect(await liveOutboundVideo(pa)).toBe(0);
    await watchScreen(pb);
    await watchScreen(pc);
    for (const p of [pb, pc]) {
      await expect.poll(() => screenWidth(p), { timeout: 20000 }).toBeGreaterThan(0);
      await expect.poll(() => meshInboundVideo(p), { timeout: 15000 }).toBeGreaterThan(0);
    }
    // mesh: копия каждому зрителю
    await expect.poll(() => liveOutboundVideo(pa), { timeout: 15000 }).toBe(2);
    await pb.locator('#stage-grid .tile--screen .tile__unwatch').click();
    await expect.poll(() => liveOutboundVideo(pa), { timeout: 15000 }).toBe(1);
  });
});

test.describe('v11: порт SFU недоступен — клиенты сами переходят на mesh', () => {
  const port = PORT + 51;
  let server = null;
  test.setTimeout(120_000);
  test.beforeAll(async () => {
    // сервер объявляет адрес, до которого не дойти (TEST-NET-3): ICE к SFU не соединится
    server = await startServer(port, { SFU_PORT: String(PORT + 30051), SFU_ANNOUNCED_IP: '203.0.113.7' });
    expect(server.log).toMatch(/203\.0\.113\.7/);
  });
  test.afterAll(() => { server?.kill('SIGTERM'); });

  test('стример и зритель не соединились с SFU → трансляция всё равно доходит напрямую', async ({ makePage }) => {
    const { pa, pb } = await threeInVoice(makePage, 'SFU недоступен', { base: `https://localhost:${port}` });
    await expect.poll(async () => (await sfuInfo(pa)).device).toBe(true);
    await startScreenShare(pa, '720p30');
    // зритель жмёт «Смотреть» сразу, пока стример ещё пробует SFU
    await watchScreen(pb);
    await expect.poll(() => screenWidth(pb), { timeout: 45000 }).toBeGreaterThan(0);
    await expect.poll(() => meshInboundVideo(pb), { timeout: 15000 }).toBeGreaterThan(0);
    const info = await sfuInfo(pa);
    expect(info.producing).toBe(false);
    expect(await pa.evaluate(() => window.__sozvon.rtc.sfuScreen)).toBe(false);
  });
});
