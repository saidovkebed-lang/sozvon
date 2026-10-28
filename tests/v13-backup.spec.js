// v13: deploy/backup.sh — ежедневные резервные копии, ротация, шифрованная отправка в Telegram, восстановление.
// Скрипт гоняется на временных каталогах (DATA_DIR / SOZVON_ENV_FILE / BACKUP_DIR), systemctl — подменный (PATH),
// Telegram Bot API — локальный HTTP-сервер (BACKUP_TELEGRAM_API). Нужен root (chown, права 600) — иначе пропуск.
import { test, expect } from '@playwright/test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { ROOT } from './fixtures/env.js';

const SCRIPT = path.join(ROOT, 'deploy', 'backup.sh');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasZstd = spawnSync('zstd', ['--version']).status === 0;
const PASS = 'correct horse battery staple';
const TOKEN = '123456:TEST_token-abc';

test.skip(!isRoot, 'backup.sh работает только от root');

/** Временный стенд: каталог данных, env-файл, каталог копий и подменный systemctl. */
function makeBed() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-backup-'));
  const data = path.join(base, 'lib', 'sozvon');
  const w = (rel, content) => { const f = path.join(data, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  w('db.json', JSON.stringify({ version: 1, users: [{ id: 'u1', username: 'alice' }], messages: { c1: [{ id: 'm1', content: 'привет' }] } }));
  w('db.json.4242.tmp', 'half-written');
  w('vapid.json', '{"publicKey":"pub","privateKey":"priv"}');
  w('bot-token.txt', 'bot-secret');
  w('uploads/3f2a.png', 'PNGDATA');
  w('uploads/big.bin', crypto.randomBytes(6000)); // несжимаемое — чтобы копия делилась на части
  w('media/avatars/u1.webp', 'AVATAR');
  w('media/banners/u1.webp', 'BANNER');
  w('media/.tmp/.upload-1', 'tmp');
  w('music/Artist - Song.mp3', 'MP3DATA');
  w('music/.upload-abcd', 'partial upload');
  w('music/.dl-123/x.webm', 'partial download');
  w('music/.import-1', 'partial import');
  w('.cache/yt-dlp/youtube-sigfuncs/x.json', 'cache');
  w('downloads/Astra-Setup.exe', 'BIG APP');
  w('bin/cloudflared', 'binary');
  w('certs/cert.pem', 'CERT');
  const env = path.join(base, 'sozvon.env');
  fs.writeFileSync(env, 'PUBLIC_URL=https://astra.example\nTURN_SECRET=supersecret\n', { mode: 0o600 });
  const bin = path.join(base, 'fakebin');
  fs.mkdirSync(bin);
  const log = path.join(base, 'systemctl.log');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  return { base, data, env, log, backups: path.join(base, 'backups'), bin };
}

function run(bed, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PATH: `${bed.bin}:${process.env.PATH}`,
      DATA_DIR: bed.data, SOZVON_ENV_FILE: bed.env, BACKUP_DIR: bed.backups, APP_USER: 'root',
      ...extraEnv,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const p = spawn('bash', [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const archives = (bed) => fs.readdirSync(bed.backups).filter((f) => /^astra-\d{8}-\d{4}.*\.tar\.(zst|gz)$/.test(f)).sort();
function listArchive(file) {
  const cmd = file.endsWith('.zst') ? `zstd -dc '${file}' | tar -t` : `tar -tzf '${file}'`;
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }).split('\n').filter(Boolean);
}
function extractFile(file, member) {
  const dec = file.endsWith('.zst') ? `zstd -dc '${file}'` : `gzip -dc '${file}'`;
  return execFileSync('bash', ['-c', `${dec} | tar -xO '${member}'`], { encoding: 'utf8' });
}

/** Фейковый Telegram Bot API: запоминает запросы и тела загруженных документов. */
async function fakeTelegram({ fail = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const call = { url: req.url, body, text: body.toString('latin1') };
      const m = /boundary=(.+)$/.exec(req.headers['content-type'] || '');
      if (m) {
        const boundary = Buffer.from(`\r\n--${m[1]}`);
        const field = (name) => {
          const at = body.indexOf(`name="${name}"`);
          if (at < 0) return null;
          const start = body.indexOf('\r\n\r\n', at) + 4;
          return body.subarray(start, body.indexOf(boundary, start));
        };
        call.document = field('document');
        call.chatId = field('chat_id')?.toString();
        call.caption = field('caption')?.toString('utf8');
        const fn = /name="document"; filename="([^"]+)"/.exec(call.text);
        call.filename = fn && fn[1];
      }
      calls.push(call);
      res.setHeader('content-type', 'application/json');
      if (fail) res.end('{"ok":false,"error_code":413,"description":"Request Entity Too Large"}');
      else res.end('{"ok":true,"result":{"message_id":1}}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test.describe('deploy/backup.sh', () => {
  test('now: согласованный архив с данными и настройками, без кэшей и временных файлов, права 600', async () => {
    const bed = makeBed();
    const files = [];
    for (const compress of hasZstd ? ['zstd', 'gzip'] : ['gzip']) {
      const r = await run(bed, ['now'], { BACKUP_COMPRESS: compress });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('Копия:');
      const newest = archives(bed).pop();
      expect(newest.endsWith(compress === 'zstd' ? '.tar.zst' : '.tar.gz')).toBe(true);
      files.push(newest);
      fs.copyFileSync(path.join(bed.backups, newest), path.join(bed.base, newest)); // следующий запуск за тот же день её заменит
    }
    expect(fs.statSync(bed.backups).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(bed.backups, files.at(-1))).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(bed.backups, files.at(-1))).uid).toBe(0);
    for (const f of files) {
      const full = path.join(bed.base, f);
      const list = listArchive(full);
      for (const want of ['BACKUP-INFO.txt', 'env/sozvon.env', 'data/db.json', 'data/vapid.json', 'data/bot-token.txt',
        'data/uploads/3f2a.png', 'data/media/avatars/u1.webp', 'data/media/banners/u1.webp', 'data/music/Artist - Song.mp3', 'data/certs/cert.pem']) {
        expect(list, want).toContain(want);
      }
      const joined = list.join('\n');
      for (const bad of ['.cache', 'downloads', 'data/bin', 'db.json.4242.tmp', '.upload-', '.dl-', '.import-', 'media/.tmp']) {
        expect(joined, bad).not.toContain(bad);
      }
      expect(list.indexOf('data/db.json')).toBeLessThan(list.indexOf('data/uploads/3f2a.png')); // база — первой
      expect(JSON.parse(extractFile(full, 'data/db.json')).users[0].username).toBe('alice');
      expect(extractFile(full, 'env/sozvon.env')).toContain('TURN_SECRET=supersecret');
    }
    expect(fs.readFileSync(path.join(bed.backups, '.last-status'), 'utf8')).toContain('telegram=выключено');
    // v19: итог для админ-панели — в каталоге состояния root рядом с DATA_DIR (не в самом DATA_DIR)
    const stFile = path.join(path.dirname(bed.data), 'sozvon-state', 'backup-status.json');
    const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    expect(st).toMatchObject({ result: 'ok', ok: true, file: files.at(-1), telegram: 'выключено', error: '' });
    expect(Date.now() - Date.parse(st.time)).toBeLessThan(120_000);
    expect(fs.statSync(stFile).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(path.join(bed.data, 'backup-status.json'))).toBe(false);

    // BACKUP_MUSIC=0 — без музыкальной библиотеки
    fs.rmSync(bed.backups, { recursive: true });
    expect((await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip', BACKUP_MUSIC: '0' })).code).toBe(0);
    expect(listArchive(path.join(bed.backups, archives(bed)[0])).join('\n')).not.toContain('music');

    // list: копии, размеры, таймер (через systemctl из PATH)
    const l = await run(bed, ['list']);
    expect(l.code, l.out).toBe(0);
    expect(l.out).toMatch(/astra-\d{8}-\d{4}\.tar\.gz\s+\d/);
    expect(l.out).toContain('Telegram: выключен');
    expect(fs.readFileSync(bed.log, 'utf8')).toContain('list-timers sozvon-backup.timer');
    fs.rmSync(bed.base, { recursive: true, force: true });
  });

  test('ротация: 7 последних дней + по одной копии за 4 предыдущие недели', async () => {
    const bed = makeBed();
    fs.mkdirSync(bed.backups, { recursive: true });
    const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const now = new Date();
    for (let i = 1; i <= 60; i++) {
      const d = new Date(now.getTime() - i * 86400_000);
      fs.writeFileSync(path.join(bed.backups, `astra-${ymd(d)}-0430.tar.gz`), 'old');
      if (i === 2) fs.writeFileSync(path.join(bed.backups, `astra-${ymd(d)}-1200.tar.gz`), 'manual'); // две копии за день
    }
    const r = await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip', TZ: 'UTC' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Ротация');
    const left = archives(bed);
    expect(left.length).toBe(11);
    const days = left.map((f) => f.slice(6, 14));
    expect(new Set(days).size).toBe(11); // в каждом дне — одна (самая свежая) копия
    for (let i = 1; i <= 6; i++) expect(days).toContain(ymd(new Date(now.getTime() - i * 86400_000)));
    expect(left).toContain(`astra-${ymd(new Date(now.getTime() - 2 * 86400_000))}-1200.tar.gz`);
    const isoWeek = (s) => {
      const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const y = d.getUTCFullYear();
      return `${y}-${Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7)}`;
    };
    const weekly = days.slice().sort().reverse().slice(7);
    const dailyWeeks = new Set(days.slice().sort().reverse().slice(0, 7).map(isoWeek));
    expect(new Set(weekly.map(isoWeek)).size).toBe(4);
    for (const w of weekly) expect(dailyWeeks.has(isoWeek(w))).toBe(false);
    fs.rmSync(bed.base, { recursive: true, force: true });
  });

  test('Telegram: только зашифрованная копия, деление на части, расшифровка и склейка дают исходный архив', async () => {
    const bed = makeBed();
    const tg = await fakeTelegram();
    try {
      fs.appendFileSync(bed.env, `BACKUP_TELEGRAM_TOKEN=${TOKEN}\nBACKUP_TELEGRAM_CHAT_ID=-100500\nBACKUP_PASSPHRASE='${PASS}'\nBACKUP_TELEGRAM_API=${tg.url}\n`);
      // telegram-test → sendMessage
      const t = await run(bed, ['telegram-test']);
      expect(t.code, t.out).toBe(0);
      expect(tg.calls[0].url).toBe(`/bot${TOKEN}/sendMessage`);
      expect(decodeURIComponent(tg.calls[0].text.replace(/\+/g, ' '))).toContain('chat_id=-100500');

      const r = await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip', BACKUP_TELEGRAM_PART_SIZE: '2K' });
      expect(r.code, r.out).toBe(0);
      const docs = tg.calls.filter((c) => c.url === `/bot${TOKEN}/sendDocument`);
      expect(docs.length).toBeGreaterThan(1);
      const [local] = archives(bed);
      docs.forEach((d, i) => {
        expect(d.chatId).toBe('-100500');
        expect(d.filename).toBe(`${local}.enc.part${String(i).padStart(2, '0')}`);
        expect(d.document.length).toBeLessThanOrEqual(2048);
        expect(d.caption).toContain(`(${i + 1}/${docs.length})`);
      });
      const enc = Buffer.concat(docs.map((d) => d.document));
      expect(enc.subarray(0, 8).toString()).toBe('Salted__');
      expect(enc.includes(Buffer.from('supersecret'))).toBe(false);
      // расшифровка ровно той командой, что в docs/BACKUP.md
      const dir = fs.mkdtempSync(path.join(bed.base, 'dl-'));
      docs.forEach((d) => fs.writeFileSync(path.join(dir, d.filename), d.document));
      execFileSync('bash', ['-c', `cat ${local}.enc.part* > ${local}.enc && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ${local}.enc -out ${local} -pass env:PP`],
        { cwd: dir, env: { ...process.env, PP: PASS } });
      expect(fs.readFileSync(path.join(dir, local)).equals(fs.readFileSync(path.join(bed.backups, local)))).toBe(true);
      expect(fs.readFileSync(path.join(bed.backups, '.last-status'), 'utf8')).toContain('telegram=отправлено');

      // без разбиения: одна часть .enc
      tg.calls.length = 0;
      fs.rmSync(bed.backups, { recursive: true });
      expect((await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip' })).code).toBe(0);
      expect(tg.calls.length).toBe(1);
      expect(tg.calls[0].filename).toMatch(/^astra-\d{8}-\d{4}\.tar\.gz\.enc$/);

      // слишком много частей → не отправляем, но локальная копия есть (код 2 — таймер покажет ошибку)
      tg.calls.length = 0;
      const many = await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip', BACKUP_TELEGRAM_PART_SIZE: '1K', BACKUP_TELEGRAM_MAX_PARTS: '2' });
      expect(many.code).toBe(2);
      expect(many.out).toContain('не отправляю');
      expect(tg.calls.length).toBe(0);
    } finally {
      await tg.close();
      fs.rmSync(bed.base, { recursive: true, force: true });
    }
  });

  test('Telegram: без пароля ничего не отправляется; ошибка API → код 2, локальная копия цела', async () => {
    const bed = makeBed();
    const tg = await fakeTelegram({ fail: true });
    try {
      fs.appendFileSync(bed.env, `BACKUP_TELEGRAM_TOKEN=${TOKEN}\nBACKUP_TELEGRAM_CHAT_ID=42\nBACKUP_TELEGRAM_API=${tg.url}\n`);
      const r = await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip' });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('BACKUP_PASSPHRASE');
      expect(tg.calls.length).toBe(0);

      const f = await run(bed, ['now'], { BACKUP_COMPRESS: 'gzip', BACKUP_PASSPHRASE: PASS });
      expect(f.code, f.out).toBe(2);
      expect(f.out).toContain('Request Entity Too Large');
      expect(tg.calls.length).toBeGreaterThan(0);
      expect(archives(bed).length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(bed.backups, '.last-status'), 'utf8')).toContain('telegram=ОШИБКА');
    } finally {
      await tg.close();
      fs.rmSync(bed.base, { recursive: true, force: true });
    }
  });

  test('restore: без подтверждения ничего не трогает; с подтверждением — останавливает службы, откладывает данные, восстанавливает', async () => {
    const bed = makeBed();
    expect((await run(bed, ['now'], { BACKUP_COMPRESS: hasZstd ? 'zstd' : 'gzip' })).code).toBe(0);
    const [file] = archives(bed);
    const full = path.join(bed.backups, file);

    // данные «испортились» после копии
    fs.writeFileSync(path.join(bed.data, 'db.json'), '{"users":[]}');
    fs.rmSync(path.join(bed.data, 'uploads', '3f2a.png'));
    fs.writeFileSync(bed.env, 'TURN_SECRET=changed\n', { mode: 0o600 });

    // нет терминала и нет BACKUP_ASSUME_YES → отказ, данные на месте
    const no = await run(bed, ['restore', full]);
    expect(no.code).not.toBe(0);
    expect(no.out).toContain('подтверждение');
    expect(fs.readFileSync(path.join(bed.data, 'db.json'), 'utf8')).toBe('{"users":[]}');
    expect(fs.existsSync(bed.log) ? fs.readFileSync(bed.log, 'utf8') : '').not.toContain('stop');

    // настройки не восстанавливаем (по умолчанию «нет»)
    const ok = await run(bed, ['restore', file], { BACKUP_ASSUME_YES: '1', BACKUP_RESTORE_ENV: 'n' });
    expect(ok.code, ok.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(bed.data, 'db.json'), 'utf8')).users[0].username).toBe('alice');
    expect(fs.readFileSync(path.join(bed.data, 'uploads', '3f2a.png'), 'utf8')).toBe('PNGDATA');
    expect(fs.readFileSync(path.join(bed.data, 'music', 'Artist - Song.mp3'), 'utf8')).toBe('MP3DATA');
    expect(fs.existsSync(path.join(bed.data, '.cache'))).toBe(false);
    expect(fs.statSync(bed.data).mode & 0o777).toBe(0o750);
    expect(fs.readFileSync(bed.env, 'utf8')).toBe('TURN_SECRET=changed\n');
    const parent = path.dirname(bed.data);
    const baks = fs.readdirSync(parent).filter((f) => f.startsWith('sozvon.bak-'));
    expect(baks.length).toBe(1);
    expect(fs.readFileSync(path.join(parent, baks[0], 'db.json'), 'utf8')).toBe('{"users":[]}');
    expect(fs.readdirSync(parent).filter((f) => f.startsWith('.astra-restore'))).toEqual([]);
    const sys = fs.readFileSync(bed.log, 'utf8').split('\n').filter(Boolean);
    expect(sys).toEqual(['stop sozvon-bot sozvon', 'start sozvon-bot sozvon']);
    expect(ok.out).toContain('systemctl status sozvon');
    expect(ok.out).toContain('journalctl -u sozvon');

    // зашифрованная копия (как из Telegram, частями) + восстановление настроек
    const encDir = fs.mkdtempSync(path.join(bed.base, 'enc-'));
    const enc = path.join(encDir, `${file}.enc`);
    execFileSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-in', full, '-out', enc, '-pass', `pass:${PASS}`]);
    execFileSync('split', ['-b', '1K', '-d', '-a', '2', enc, `${enc}.part`]);
    fs.rmSync(enc);
    const bad = await run(bed, ['restore', `${enc}.part00`], { BACKUP_ASSUME_YES: '1', BACKUP_PASSPHRASE: 'wrong password!' });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('расшифровать');
    fs.writeFileSync(path.join(bed.data, 'db.json'), '{"users":[],"x":1}');
    await new Promise((r) => setTimeout(r, 1100)); // другое имя .bak-<секунды>
    const er = await run(bed, ['restore', `${enc}.part00`], { BACKUP_ASSUME_YES: '1', BACKUP_RESTORE_ENV: 'y', BACKUP_PASSPHRASE: PASS });
    expect(er.code, er.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(bed.data, 'db.json'), 'utf8')).users[0].username).toBe('alice');
    expect(fs.readFileSync(bed.env, 'utf8')).toContain('TURN_SECRET=supersecret');
    expect(fs.statSync(bed.env).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(bed.env)).some((f) => f.startsWith('sozvon.env.bak-'))).toBe(true);
    fs.rmSync(bed.base, { recursive: true, force: true });
  });

  test('restore понимает копии старого формата (sozvon/ + sozvon.env)', async () => {
    const bed = makeBed();
    const old = path.join(bed.base, 'sozvon-20260101-120000.tar.gz');
    const src = fs.mkdtempSync(path.join(bed.base, 'old-'));
    fs.mkdirSync(path.join(src, 'sozvon'));
    fs.writeFileSync(path.join(src, 'sozvon', 'db.json'), '{"users":[{"username":"legacy"}]}');
    fs.writeFileSync(path.join(src, 'sozvon.env'), 'TURN_SECRET=legacy\n');
    execFileSync('tar', ['-czf', old, '-C', src, 'sozvon', 'sozvon.env']);
    const missing = await run(bed, ['restore', 'astra-19990101-0000.tar.zst'], { BACKUP_ASSUME_YES: '1' });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('Файл не найден');
    const r = await run(bed, ['--restore', old], { BACKUP_ASSUME_YES: '1' });
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(path.join(bed.data, 'db.json'), 'utf8')).toContain('legacy');
    expect(fs.readFileSync(bed.env, 'utf8')).toContain('supersecret'); // настройки без согласия не меняются
    fs.rmSync(bed.base, { recursive: true, force: true });
  });

  test('systemd-таймер и подключение в install.sh / update.sh', () => {
    const timer = fs.readFileSync(path.join(ROOT, 'deploy/templates/sozvon-backup.timer'), 'utf8');
    expect(timer).toMatch(/OnCalendar=\*-\*-\* 04:30:00/);
    expect(timer).toMatch(/RandomizedDelaySec=\S+/);
    expect(timer).toContain('Persistent=true');
    const svc = fs.readFileSync(path.join(ROOT, 'deploy/templates/sozvon-backup.service'), 'utf8');
    expect(svc).toContain('ExecStart=/bin/bash @APP_DIR@/deploy/backup.sh now');
    for (const f of ['install.sh', 'update.sh']) {
      const s = fs.readFileSync(path.join(ROOT, 'deploy', f), 'utf8');
      expect(s, f).toContain('sozvon-backup.timer');
      expect(s, f).toMatch(/systemctl enable -q --now sozvon-backup\.timer/);
    }
  });
});
