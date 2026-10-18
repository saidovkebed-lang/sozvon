// v5: переименование канала из шестерёнки, просмотр фото/видео внутри приложения,
// H.264 для демонстрации экрана (аппаратное кодирование).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, twoUsersOneServer, joinVoiceUI, startScreenShare, watchScreen, openTextChannel } from './fixtures/ui.js';
import { connectUser, ack, http } from './fixtures/api.js';

const socks = [];
test.afterEach(() => { for (const s of socks.splice(0)) s.close(); });

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// WebM (VP8): тестовый Chromium — сборка без H.264-декодера; в Chrome/Edge/приложении для ПК mp4 тоже играет
function makeVideo() {
  const f = path.join(os.tmpdir(), `sozvon-test-${process.pid}.webm`);
  if (!fs.existsSync(f)) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2',
      '-c:v', 'libvpx', '-b:v', '300k', f]);
  }
  return fs.readFileSync(f);
}

async function upload(token, name, type, buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await http('POST', '/api/attachments', { token, body: fd });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

test.describe('v5', () => {
  test('голосовой канал переименовывается из шестерёнки (без открытия настроек сервера)', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Ренейм');
    const row = pa.locator('a.channel[data-type="voice"]').first();
    await row.hover();
    await row.locator('[data-edit-channel]').click();
    const input = pa.locator('#channel-edit-name');
    await expect(input).toHaveAttribute('maxlength', '32');
    await input.fill('Игровая комната');
    await pa.locator('#btn-channel-perms-save').click();
    await expect(pa.locator('#modal-channel-perms')).toBeHidden();
    await expect(pa.locator('a.channel[data-type="voice"]').first()).toContainText('Игровая комната');
    await expect(pb.locator('a.channel[data-type="voice"]').first()).toContainText('Игровая комната');
  });

  test('фото и видео открываются внутри приложения: просмотрщик, листание, Esc', async ({ makePage }) => {
    const { pa, ua } = await twoUsersOneServer(makePage, 'Медиа');
    const sa = await connectUser(ua.token); socks.push(sa);
    const srv = (await ack(sa, 'bootstrap')).servers.find((s) => s.name === 'Медиа');
    const text = srv.channels.find((c) => c.type === 'text');
    const img = await upload(ua.token, 'кот.png', 'image/png', PNG_1x1);
    const vid = await upload(ua.token, 'ролик.webm', 'video/webm', makeVideo());
    await ack(sa, 'message:send', { channelId: text.id, content: 'фото', attachments: [img] });
    await ack(sa, 'message:send', { channelId: text.id, content: 'видео', attachments: [vid] });
    await openTextChannel(pa);

    // ссылки «в новом окне» для медиа больше нет
    await expect(pa.locator('.message__image-link')).toHaveCount(1);
    await expect(pa.locator('a[target="_blank"] img.message__image')).toHaveCount(0);
    // видео — встроенный плеер
    const inline = pa.locator('video.message__video');
    await expect(inline).toHaveCount(1);
    await expect.poll(() => inline.evaluate((v) => v.readyState), { timeout: 15000 }).toBeGreaterThan(0);

    // клик по фото → просмотрщик, 1 / 2
    await pa.locator('.message__image-link').click();
    const lb = pa.locator('.lightbox');
    await expect(lb).toBeVisible();
    await expect(lb.locator('img.lightbox__media')).toHaveAttribute('src', img.url);
    await expect(lb.locator('.lightbox__count')).toHaveText('1 / 2');
    await expect(lb.locator('[data-lb="download"]')).toHaveAttribute('href', img.url);
    // → следующее — видео
    await pa.keyboard.press('ArrowRight');
    await expect(lb.locator('video.lightbox__media')).toHaveAttribute('src', vid.url);
    await expect(lb.locator('.lightbox__count')).toHaveText('2 / 2');
    // Esc закрывает, страница не уходит
    await pa.keyboard.press('Escape');
    await expect(lb).toBeHidden();
    expect(new URL(pa.url()).pathname).toBe('/');

    // кнопка «развернуть» у видео
    await pa.locator('.message__video-wrap').hover();
    await pa.locator('.message__video-expand').click();
    await expect(lb.locator('video.lightbox__media')).toBeVisible();
    // клик по фону закрывает
    await lb.locator('.lightbox__stage').click({ position: { x: 5, y: 5 } });
    await expect(lb).toBeHidden();
  });

  test('демонстрация экрана предпочитает H.264 (аппаратное кодирование), если он есть', async ({ makePage }) => {
    const { pa, pb } = await twoUsersOneServer(makePage, 'Кодек');
    await joinVoiceUI(pa);
    await joinVoiceUI(pb);
    await expect(pa.locator('.tile[data-connected="true"]').first()).toBeVisible({ timeout: 20000 });
    const hasH264 = await pa.evaluate(() => (RTCRtpSender.getCapabilities('video')?.codecs || []).some((c) => /h264/i.test(c.mimeType)));
    await startScreenShare(pa, '720p30');
    await watchScreen(pb);
    await expect.poll(() => pb.locator('.tile--screen video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    const codec = await pa.evaluate(async () => {
      const p = [...window.__sozvon.rtc.peers.values()][0];
      const stats = await p.pc.getStats();
      let mime = null;
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video' && r.codecId) {
          const c = stats.get(r.codecId);
          if (c) mime = c.mimeType;
        }
      });
      return mime;
    });
    test.info().annotations.push({ type: 'codec', description: `H.264 в браузере: ${hasH264}; кодек трансляции: ${codec}` });
    if (hasH264) expect(codec).toMatch(/h264/i);
  });
});
