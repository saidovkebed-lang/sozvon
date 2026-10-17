// v3: профили «Нитро для всех» (SPEC-v3 §2) — REST + ffmpeg-проверки файлов. owner: qa
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { http, httpAt, ack, makeUser, waitEvent, sleep, registerApi } from './fixtures/api.js';
import { BASE_URL, ROOT } from './fixtures/env.js';
import { guild, ok, withId, closeAll, ensureV3Media, probe, upload, download, viewOf, startStandalone, LIMIT_PORT } from './fixtures/v3.js';

const opened = [];
test.afterEach(() => { closeAll(opened.splice(0)); });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-qa-v3-'));
let media;
test.beforeAll(() => { media = ensureV3Media(); });

test.describe('v3 аватар и баннер (ffmpeg)', () => {
  test('PNG 640×360 → avatar 256×256 (центр-кроп), avatarAnimated=null; user:updated другому; кэш-заголовки; DELETE', async () => {
    const { owner: a, members: [b] } = await guild(1); opened.push(a, b);
    const upd = waitEvent(b.socket, 'user:updated', (d) => d.user?.id === a.id && d.user.avatar);
    const r = await upload(BASE_URL, '/api/me/avatar', a.token, media.png, 'image/png');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const u = r.json.user;
    expect(u.avatar).toMatch(/^\/media\/avatars\//);
    expect(u.avatarAnimated).toBeNull();
    expect((await upd).user.avatar).toBe(u.avatar);
    const { file, headers } = await download(BASE_URL, u.avatar, path.join(TMP, 'a.png'));
    expect(probe(file)).toMatchObject({ width: 256, height: 256 });
    expect(headers.get('cache-control') || '', 'кэш для файлов с хэшем в имени').toMatch(/max-age=\d{4,}|immutable/);
    // GET /api/me и bootstrap у b
    expect((await http('GET', '/api/me', { token: a.token })).json.user.avatar).toBe(u.avatar);
    const del = await http('DELETE', '/api/me/avatar', { token: a.token });
    expect(del.status).toBe(200);
    expect(del.json.user.avatar).toBeNull();
    expect(del.json.user.avatarAnimated).toBeNull();
  });

  test('GIF (анимированный, 20 кадров) → avatarAnimated ≤256×256 с анимацией + статичный первый кадр 256×256', async () => {
    const a = await registerApi();
    const r = await upload(BASE_URL, '/api/me/avatar', a.token, media.gif, 'image/gif');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const u = r.json.user;
    expect(u.avatar).toBeTruthy();
    expect(u.avatarAnimated).toBeTruthy();
    expect(u.avatarAnimated).not.toBe(u.avatar);
    const st = probe((await download(BASE_URL, u.avatar, path.join(TMP, 'st'))).file);
    expect(st).toMatchObject({ width: 256, height: 256 });
    expect(st.frames, 'статичная версия — один кадр').toBe(1);
    const an = await download(BASE_URL, u.avatarAnimated, path.join(TMP, 'an'));
    expect(an.headers.get('content-type')).toMatch(/image\/(gif|webp)/);
    const ap = probe(an.file);
    expect(ap.width).toBeLessThanOrEqual(256); expect(ap.height).toBeLessThanOrEqual(256);
    expect(ap.width).toBe(ap.height);
    expect(ap.frames, 'анимация сохранена').toBeGreaterThan(5);
    expect(fs.statSync(an.file).size).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  test('кадрирование x,y,size из UI учитывается (PNG)', async () => {
    const a = await registerApi();
    // левый верхний квадрат 100×100 testsrc — заведомо другой контент, чем центр
    // (старый файл аватара удаляется при замене — скачиваем сразу)
    const r1 = await upload(BASE_URL, '/api/me/avatar', a.token, media.png, 'image/png', { x: 0, y: 0, size: 100 });
    expect(r1.status).toBe(200);
    const f1 = (await download(BASE_URL, r1.json.user.avatar, path.join(TMP, 'c1.png'))).file;
    const r2 = await upload(BASE_URL, '/api/me/avatar', a.token, media.png, 'image/png');
    expect(r2.status).toBe(200);
    const f2 = (await download(BASE_URL, r2.json.user.avatar, path.join(TMP, 'c2.png'))).file;
    expect(probe(f1)).toMatchObject({ width: 256, height: 256 });
    expect(fs.readFileSync(f1).equals(fs.readFileSync(f2)), 'кроп x,y,size даёт другой результат, чем центр').toBe(false);
  });

  test('баннер PNG → 960×340; анимированный баннер → bannerAnimated; DELETE; мусор → 400', async () => {
    const a = await registerApi();
    const r = await upload(BASE_URL, '/api/me/banner', a.token, media.banner, 'image/png');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(probe((await download(BASE_URL, r.json.user.banner, path.join(TMP, 'b.png'))).file)).toMatchObject({ width: 960, height: 340 });
    const g = await upload(BASE_URL, '/api/me/banner', a.token, media.bannerGif, 'image/gif');
    expect(g.status).toBe(200);
    expect(g.json.user.bannerAnimated).toBeTruthy();
    const gp = probe((await download(BASE_URL, g.json.user.bannerAnimated, path.join(TMP, 'bg'))).file);
    expect(gp.frames).toBeGreaterThan(3);
    const del = await http('DELETE', '/api/me/banner', { token: a.token });
    expect(del.json.user.banner).toBeNull();
    // не картинка
    const txt = path.join(TMP, 'x.png'); fs.writeFileSync(txt, 'not an image at all');
    const bad = await upload(BASE_URL, '/api/me/avatar', a.token, txt, 'image/png');
    expect(bad.status).toBeGreaterThanOrEqual(400); expect(bad.status).toBeLessThan(500);
    expect(bad.json.error).toBeTruthy();
    const pdf = path.join(TMP, 'x.txt'); fs.writeFileSync(pdf, 'hello');
    const bad2 = await upload(BASE_URL, '/api/me/avatar', a.token, pdf, 'text/plain');
    expect(bad2.status).toBe(400);
    // без авторизации
    const noauth = await upload(BASE_URL, '/api/me/avatar', '', media.png, 'image/png');
    expect(noauth.status).toBe(401);
  });

  test('аватар > 10 МБ → 413/400 с {error}', async () => {
    const a = await registerApi();
    const big = path.join(TMP, 'big.png'); fs.writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 7));
    const r = await upload(BASE_URL, '/api/me/avatar', a.token, big, 'image/png');
    expect([400, 413]).toContain(r.status);
    expect(r.json.error).toBeTruthy();
  });

  test('иконка/баннер сервера: MANAGE_SERVER; иконка 256×256', async () => {
    const { srv, owner, members: [b] } = await guild(1); opened.push(owner, b);
    const no = await upload(BASE_URL, `/api/servers/${srv.id}/icon`, b.token, media.png, 'image/png');
    expect(no.status).toBe(403);
    const upd = waitEvent(b.socket, 'server:updated', (d) => d.server?.id === srv.id && d.server.icon);
    const r = await upload(BASE_URL, `/api/servers/${srv.id}/icon`, owner.token, media.png, 'image/png');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const icon = (await upd).server.icon;
    expect(icon).toMatch(/^\/media\/icons\//);
    expect(probe((await download(BASE_URL, icon, path.join(TMP, 'i.png'))).file)).toMatchObject({ width: 256, height: 256 });
    const rb = await upload(BASE_URL, `/api/servers/${srv.id}/banner`, owner.token, media.banner, 'image/png');
    expect(rb.status).toBe(200);
    expect((await viewOf(b, srv.id)).banner).toBeTruthy();
  });
});

test.describe('v3 PATCH /api/me: профиль и статус', () => {
  test('displayName/about(190)/pronouns(40)/bannerColor/profileTheme/customStatus — валидация и рассылка', async () => {
    const { owner: a, members: [b] } = await guild(1); opened.push(a, b);
    const body = {
      displayName: 'Красивое Имя', about: 'о'.repeat(190), pronouns: 'он/его', bannerColor: '#123456',
      profileTheme: { primary: '#ff0000', accent: '#0000ff' }, customStatus: { emoji: '🎮', text: 'играю', expiresAt: null },
    };
    const upd = waitEvent(b.socket, 'user:updated', (d) => d.user?.id === a.id && d.user.displayName === 'Красивое Имя');
    const r = await http('PATCH', '/api/me', { token: a.token, body });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.user).toMatchObject(body);
    expect((await upd).user).toMatchObject(body);
    // старое поле color тоже работает
    expect((await http('PATCH', '/api/me', { token: a.token, body: { color: '#3ba55d' } })).json.user.color).toBe('#3ba55d');
    for (const bad of [
      { about: 'о'.repeat(191) }, { pronouns: 'x'.repeat(41) }, { displayName: 'x'.repeat(33) },
      { bannerColor: 'blue' }, { profileTheme: { primary: 'red', accent: '#000000' } }, { status: 'away' },
      { customStatus: { emoji: null, text: 'x'.repeat(129), expiresAt: null } },
    ]) {
      const x = await http('PATCH', '/api/me', { token: a.token, body: bad });
      expect(x.status, `мусор ${JSON.stringify(bad).slice(0, 60)} → 400`).toBe(400);
      expect(x.json.error).toBeTruthy();
    }
    expect((await http('GET', '/api/me', { token: a.token })).json.user.about).toBe('о'.repeat(190));
    // displayName можно сбросить
    expect((await http('PATCH', '/api/me', { token: a.token, body: { displayName: null } })).json.user.displayName).toBeNull();
  });

  test('статус invisible → для других offline (presence/members), себе — invisible; dnd/idle видны', async () => {
    const { srv, owner: a, members: [b] } = await guild(1); opened.push(a, b);
    expect((await viewOf(b, srv.id)).members.find((m) => m.id === a.id).online).toBe(true);
    const off = Promise.race([
      waitEvent(b.socket, 'presence', (d) => d.userId === a.id && d.online === false),
      waitEvent(b.socket, 'user:updated', (d) => d.user?.id === a.id && d.user.online === false),
    ]);
    const leak = [];
    b.socket.on('user:updated', (d) => { if (d.user?.id === a.id) leak.push(d.user.status); });
    const r = await http('PATCH', '/api/me', { token: a.token, body: { status: 'invisible' } });
    expect(r.json.user.status).toBe('invisible');
    await off;
    const m = (await viewOf(b, srv.id)).members.find((x) => x.id === a.id);
    expect(m.online).toBe(false);
    expect(m.status).toBe('offline');
    expect(leak, 'статус invisible не утекает другим').not.toContain('invisible');
    expect((await ack(a.socket, 'bootstrap')).user.status).toBe('invisible');
    const on = waitEvent(b.socket, 'user:updated', (d) => d.user?.id === a.id && d.user.status === 'dnd');
    await http('PATCH', '/api/me', { token: a.token, body: { status: 'dnd' } });
    await on;
    expect((await viewOf(b, srv.id)).members.find((x) => x.id === a.id)).toMatchObject({ online: true, status: 'dnd' });
  });

  test('кастомный статус с истечением: после expiresAt не отдаётся', async () => {
    const { srv, owner: a, members: [b] } = await guild(1); opened.push(a, b);
    const r = await http('PATCH', '/api/me', { token: a.token, body: { customStatus: { emoji: '☕', text: 'перерыв', expiresAt: Date.now() + 1500 } } });
    expect(r.status).toBe(200);
    expect((await viewOf(b, srv.id)).members.find((x) => x.id === a.id).customStatus).toMatchObject({ text: 'перерыв' });
    await sleep(2200);
    expect((await viewOf(b, srv.id)).members.find((x) => x.id === a.id).customStatus).toBeNull();
    expect((await http('GET', '/api/me', { token: a.token })).json.user.customStatus).toBeNull();
    // в прошлом — отклоняется или сразу null
    const p = await http('PATCH', '/api/me', { token: a.token, body: { customStatus: { emoji: null, text: 'x', expiresAt: Date.now() - 1000 } } });
    if (p.status === 200) expect(p.json.user.customStatus).toBeNull();
    else expect(p.status).toBe(400);
  });
});

test.describe('v3 лимит вложений 100 МБ', () => {
  test('конфиг: multer = UPLOAD_LIMIT_MB (100 по умолчанию), nginx client_max_body_size ≥ 100m', async () => {
    const sizes = [];
    const all = fs.readdirSync(path.join(ROOT, 'deploy'), { recursive: true }).map(String);
    const any = all.some((f) => /client_max_body_size/.test(fs.statSync(path.join(ROOT, 'deploy', f)).isFile() ? fs.readFileSync(path.join(ROOT, 'deploy', f), 'utf8') : ''));
    expect(any, 'client_max_body_size есть в deploy/').toBe(true);
    const re = /client_max_body_size\s+(\d+)([mMgG])/g;
    for (const f of all) {
      const p = path.join(ROOT, 'deploy', f);
      if (!fs.statSync(p).isFile()) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(re)) sizes.push(Number(m[1]) * (/g/i.test(m[2]) ? 1024 : 1));
    }
    expect(Math.min(...sizes), `client_max_body_size: ${sizes.join(',')} МБ`).toBeGreaterThanOrEqual(100);
    const src = fs.readFileSync(path.join(ROOT, 'server', 'routes.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    expect(src).toMatch(/UPLOAD_LIMIT_MB/);
  });

  test('отдельный сервер с UPLOAD_LIMIT_MB=2: 1.5 МБ проходит, 3 МБ → 413 с текстом лимита (поток, без 100 МБ в памяти)', async () => {
    const dir = path.join(os.tmpdir(), `sozvon-qa-limit-${LIMIT_PORT}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const s = await startStandalone({ port: LIMIT_PORT, dataDir: dir, env: { UPLOAD_LIMIT_MB: '2' } });
    try {
      const reg = await httpAt(s.base, 'POST', '/api/register', { body: { username: 'limit' + Date.now().toString(36).slice(-6), password: 'secret123' } });
      const tok = reg.json.token;
      const send = async (bytes) => {
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.alloc(bytes, 3)], { type: 'application/octet-stream' }), 'f.bin');
        return httpAt(s.base, 'POST', '/api/attachments', { token: tok, body: fd });
      };
      expect((await send(1.5 * 1024 * 1024)).status).toBe(200);
      const big = await send(3 * 1024 * 1024);
      expect(big.status).toBe(413);
      expect(big.json.error).toMatch(/2\s*МБ/);
    } finally { await s.stop(); }
  });

  test('основной сервер: 30 МБ (больше старого лимита 25) принимается', async () => {
    const a = await registerApi();
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(30 * 1024 * 1024, 1)], { type: 'application/octet-stream' }), 'mid.bin');
    const r = await http('POST', '/api/attachments', { token: a.token, body: fd });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.size).toBe(30 * 1024 * 1024);
  });
});

test.describe('v3 пинг (сервер)', () => {
  test('ping:rtt → ack {now}', async () => {
    const a = await makeUser(); opened.push(a);
    const t = Date.now();
    const r = await a.socket.timeout(3000).emitWithAck('ping:rtt', { t });
    expect(typeof r.now).toBe('number');
    expect(Math.abs(r.now - Date.now())).toBeLessThan(5000);
  });
});
