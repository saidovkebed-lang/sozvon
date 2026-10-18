// Полный аудит: публикация приложения для ПК (deploy/app-release.sh --from-dir) → /api/app/latest,
// /download, файлы автообновления latest*.yml для electron-updater. Отдельный сервер, свой DATA_DIR. owner: qa
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { httpAt } from './fixtures/api.js';
import { ROOT, PORT } from './fixtures/env.js';
import { startStandalone } from './fixtures/v3.js';

const RELEASE_PORT = PORT + 35;
const SCRIPT = path.join(ROOT, 'deploy', 'app-release.sh');
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

function fakeRelease(dir, ver) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = Buffer.from(`MZ fake installer ${ver} ` + 'x'.repeat(4096));
  const img = Buffer.from(`fake appimage ${ver} ` + 'y'.repeat(2048));
  fs.writeFileSync(path.join(dir, `Sozvon-Setup-${ver}.exe`), exe);
  fs.writeFileSync(path.join(dir, `Sozvon-${ver}-x86_64.AppImage`), img);
  fs.writeFileSync(path.join(dir, `Sozvon-Setup-${ver}.exe.blockmap`), 'blockmap');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${ver}\nfiles:\n  - url: Sozvon-Setup-${ver}.exe\n    sha512: ${sha512(exe)}\n    size: ${exe.length}\npath: Sozvon-Setup-${ver}.exe\nsha512: ${sha512(exe)}\n`);
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), `version: ${ver}\nfiles:\n  - url: Sozvon-${ver}-x86_64.AppImage\n    sha512: ${sha512(img)}\n    size: ${img.length}\n`);
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'junk');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'junk');
  return { exe, img };
}
const run = (dataDir, ...args) => spawnSync('bash', [SCRIPT, ...args], { env: { ...process.env, DATA_DIR: dataDir, APP_USER: 'nobody-sozvon-qa' }, encoding: 'utf8' });

test.describe('audit: приложение для ПК — публикация и автообновление', () => {
  let tmp, dataDir, srv;
  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-qa-release-'));
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    srv = await startStandalone({ port: RELEASE_PORT, dataDir });
  });
  test.afterAll(async () => { await srv?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('без релиза: /api/app/latest пустой, /download говорит «не опубликовано»', async () => {
    const r = await httpAt(srv.base, 'GET', '/api/app/latest');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ version: null, files: [] });
    const page = await httpAt(srv.base, 'GET', '/download', { raw: true });
    expect(page.status).toBe(200);
  });

  test('--from-dir: программы видны в /api/app/latest, yml/blockmap раздаются, мусор — нет; sha512 совпадает', async () => {
    const src = path.join(tmp, 'r1');
    const { exe } = fakeRelease(src, '9.9.9');
    const out = run(dataDir, '--from-dir', src, '9.9.9');
    expect(out.status, out.stderr + out.stdout).toBe(0);
    const r = await httpAt(srv.base, 'GET', '/api/app/latest');
    expect(r.json.version).toBe('9.9.9');
    const names = r.json.files.map((f) => f.name).sort();
    expect(names).toEqual(['Sozvon-9.9.9-x86_64.AppImage', 'Sozvon-Setup-9.9.9.exe']);
    expect(r.json.files.find((f) => f.name.endsWith('.exe'))).toMatchObject({ platform: 'win', kind: 'installer', size: exe.length });
    // автообновление: generic-провайдер берёт <сервер>/media/downloads/latest.yml
    const yml = await httpAt(srv.base, 'GET', '/media/downloads/latest.yml', { raw: true });
    expect(yml.status).toBe(200);
    expect(yml.headers.get('cache-control')).toMatch(/no-cache/);
    const ytext = await yml.text();
    const url = ytext.match(/url: (\S+)/)[1];
    const want = ytext.match(/sha512: (\S+)/)[1];
    const bin = await httpAt(srv.base, 'GET', '/media/downloads/' + encodeURIComponent(url), { raw: true });
    expect(bin.status).toBe(200);
    expect(sha512(Buffer.from(await bin.arrayBuffer()))).toBe(want);
    expect((await httpAt(srv.base, 'GET', '/media/downloads/latest-linux.yml', { raw: true })).status).toBe(200);
    expect((await httpAt(srv.base, 'GET', '/media/downloads/Sozvon-Setup-9.9.9.exe.blockmap', { raw: true })).status).toBe(200);
    // Range (дифференциальная загрузка / докачка)
    const part = await httpAt(srv.base, 'GET', '/media/downloads/' + encodeURIComponent(url), { raw: true, headers: { Range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    // мусор не публикуется
    expect((await httpAt(srv.base, 'GET', '/media/downloads/notes.txt', { raw: true })).status).toBe(404);
    expect((await httpAt(srv.base, 'GET', '/media/downloads/builder-debug.yml', { raw: true })).status).toBe(404);
    // обход каталога
    expect([403, 404]).toContain((await httpAt(srv.base, 'GET', '/media/downloads/..%2fapp-release.json', { raw: true })).status);
    expect((await httpAt(srv.base, 'GET', '/media/downloads/.app-release.lock', { raw: true })).status).not.toBe(200);
  });

  test('новая версия заменяет старую: старые файлы удалены, latest.yml указывает на новую', async () => {
    const src = path.join(tmp, 'r2');
    fakeRelease(src, '9.9.10');
    const out = run(dataDir, '--from-dir', src, '9.9.10');
    expect(out.status, out.stderr).toBe(0);
    const r = await httpAt(srv.base, 'GET', '/api/app/latest');
    expect(r.json.version).toBe('9.9.10');
    expect(r.json.files.every((f) => f.name.includes('9.9.10'))).toBe(true);
    expect((await httpAt(srv.base, 'GET', '/media/downloads/Sozvon-Setup-9.9.9.exe', { raw: true })).status).toBe(404);
    const y = await (await httpAt(srv.base, 'GET', '/media/downloads/latest.yml', { raw: true })).text();
    expect(y).toContain('version: 9.9.10');
  });

  test('ошибки скрипта: нет версии / нет каталога / нет программ → код 1, прежний релиз цел', async () => {
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, 'readme.txt'), 'x');
    for (const args of [['--from-dir', path.join(tmp, 'r2')], ['--from-dir', path.join(tmp, 'nope'), '1.0.0'], ['--from-dir', empty, '1.0.0'], ['--bogus']]) {
      const out = run(dataDir, ...args);
      expect(out.status, args.join(' ')).toBe(1);
      expect.soft(out.stderr, `понятная ошибка для: ${args.join(' ')}`).toMatch(/✗/);
    }
    expect((await httpAt(srv.base, 'GET', '/api/app/latest')).json.version).toBe('9.9.10');
  });

  test('/download (страница клиента) показывает ссылки на файлы релиза', async ({ browser }) => {
    fakeRelease(path.join(tmp, 'r3'), '9.9.10');
    expect(run(dataDir, '--from-dir', path.join(tmp, 'r3'), '9.9.10').status).toBe(0);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.base + '/download');
    const api = await page.evaluate(() => fetch('/api/app/latest').then((r) => r.json()));
    test.info().annotations.push({ type: 'api', description: JSON.stringify(api).slice(0, 300) });
    await expect(page.locator('a[href*="/media/downloads/"]').first()).toBeVisible();
    await expect(page.locator('body')).toContainText('9.9.10');
    expect(await page.locator('a[href$=".yml"], a[href$=".blockmap"]').count()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('настоящая сборка desktop/dist: latest-linux.yml ссылается на существующий AppImage с верным sha512', async () => {
    const dist = path.join(ROOT, 'desktop', 'dist');
    const yml = path.join(dist, 'latest-linux.yml');
    test.skip(!fs.existsSync(yml), 'desktop/dist не собран');
    const y = fs.readFileSync(yml, 'utf8');
    const file = y.match(/path: (\S+)/)[1];
    const ver = y.match(/version: (\S+)/)[1];
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
    test.info().annotations.push({ type: 'dist', description: `dist ${ver}, desktop/package.json ${pkg.version}` });
    const buf = fs.readFileSync(path.join(dist, file));
    expect(sha512(buf)).toBe(y.match(/^sha512: (\S+)/m)[1]);
    expect(buf.length).toBe(Number(y.match(/size: (\d+)/)[1]));
  });
});

test('deploy: все *.sh проходят bash -n и shellcheck -S warning', () => {
  const dir = path.join(ROOT, 'deploy');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sh')).map((f) => path.join(dir, f));
  expect(files.length).toBeGreaterThan(3);
  for (const f of files) execFileSync('bash', ['-n', f]);
  const hasSc = spawnSync('shellcheck', ['--version']).status === 0;
  test.skip(!hasSc, 'shellcheck нет');
  const r = spawnSync('shellcheck', ['-S', 'warning', ...files], { encoding: 'utf8' });
  expect(r.stdout + r.stderr, 'shellcheck -S warning').toBe('');
});
