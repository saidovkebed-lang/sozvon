// v20: двухфакторная защита (TOTP, RFC 6238) — server/totp.js, server/twofa-routes.js, public/js/ui/two-factor.js.
// API-проверки — на отдельном сервере с TRUST_PROXY=1 (адрес клиента через X-Forwarded-For, чтобы проверить
// лимиты по адресу); UI — на основном тестовом сервере. Коды считаются в тесте своей реализацией RFC 6238.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, openApp, ensureAuthMode, fillAuth, loginViaToken } from './fixtures/ui.js';
import { httpAt, http, uniqueName, collect, ack } from './fixtures/api.js';
import { PORT, ROOT } from './fixtures/env.js';
import { startStandalone, guild, closeAll } from './fixtures/v3.js';
import { openSection, closeSettings } from './fixtures/v2.js';

const TFA_PORT = PORT + 47;

/* ---------- эталонная реализация в тесте (независимо от сервера) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of s.toUpperCase().replace(/[\s=]/g, '')) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotpRef(key, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const o = mac[19] & 15;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
const stepNow = () => Math.floor(Date.now() / 30000);
/** Код для шага «сейчас + offset» (окно сервера ±1). */
const codeFor = (secret, offset = 0) => hotpRef(b32decode(secret), stepNow() + offset);

test.describe('v20 2FA: алгоритм', () => {
  test('RFC 6238 (SHA1, 8 цифр) — тестовые векторы: эталон теста и server/totp.js; base32; RFC 4226 HOTP', async () => {
    const totpMod = await import(path.join(ROOT, 'server', 'totp.js'));
    const key = Buffer.from('12345678901234567890');
    const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
      [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, want] of vectors) {
      expect(hotpRef(key, Math.floor(t / 30), 8), `эталон T=${t}`).toBe(want);
      expect(totpMod.totp(key, t * 1000, { digits: 8 }), `server/totp.js T=${t}`).toBe(want);
    }
    // RFC 4226, приложение D (6 цифр)
    const hotpVectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    hotpVectors.forEach((want, i) => expect(totpMod.hotp(key, i)).toBe(want));
    expect(totpMod.base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI'); // RFC 4648
    expect(totpMod.base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const s = totpMod.generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/); // 160 бит
    expect(totpMod.base32Decode(s).length).toBe(20);
  });

  test('QR-генератор (public/js/qr.js): эталонная матрица (сверена с segno), служебные узоры, формат M', async () => {
    const { encodeQr } = await import(path.join(ROOT, 'public', 'js', 'qr.js'));
    const uri = 'otpauth://totp/Astra%3Aivan?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Astra&algorithm=SHA1&digits=6&period=30';
    const r = encodeQr(uri, { mask: 0 });
    expect([r.version, r.size]).toEqual([7, 45]);
    const hash = crypto.createHash('sha256').update(r.modules.map((x) => x.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex');
    expect(hash).toBe('53c7d04ddd11880000dac218e3f8d0e72c046ccb245e8e198417f257d8a18b7a');
    // авто-маска: поисковые узоры по углам, тёмный модуль, длинные имена (кириллица) влезают
    const a = encodeQr(`otpauth://totp/${encodeURIComponent('Astra:Очень длинное имя польз')}?secret=${'A'.repeat(32)}&issuer=Astra&algorithm=SHA1&digits=6&period=30`);
    const m = a.modules, n = a.size;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let i = 0; i < 7; i++) { expect(m[y][x + i]).toBe(true); expect(m[y + 6][x + i]).toBe(true); }
      expect(m[y + 3][x + 3]).toBe(true);
      expect(m[y + 1][x + 1]).toBe(false);
    }
    expect(m[n - 8][8]).toBe(true);
    // формат: читаем 15 бит первой копии и снимаем маску 0x5412 → уровень M (00) и маска a.mask
    const bitsAt = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    let fmt = 0;
    bitsAt.forEach(([x, y], i) => { if (m[y][x]) fmt |= 1 << i; });
    fmt ^= 0x5412;
    expect(fmt >>> 13).toBe(0); // M
    expect((fmt >>> 10) & 7).toBe(a.mask);
  });
});

test.describe('v20 2FA: API', () => {
  let srv, tmp;
  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-qa-2fa-'));
    srv = await startStandalone({ port: TFA_PORT, dataDir: tmp, env: { TRUST_PROXY: '1' } });
  });
  test.afterAll(async () => { await srv?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  let ipSeq = 0;
  const freshIp = () => `10.20.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  const call = (method, url, { token, body, ip = freshIp() } = {}) =>
    httpAt(srv.base, method, url, { token, body, headers: { 'X-Forwarded-For': ip } });

  async function register(prefix = 'tfa') {
    const username = uniqueName(prefix);
    const r = await call('POST', '/api/register', { body: { username, password: 'secret123' } });
    expect(r.status).toBe(200);
    return { username, password: 'secret123', token: r.json.token, id: r.json.user.id };
  }
  /** Включить 2FA; возвращает { secret, recoveryCodes }. Код подтверждения — шаг «сейчас». */
  async function enable(u) {
    const s = await call('POST', '/api/me/2fa/setup', { token: u.token, body: { password: u.password } });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const e = await call('POST', '/api/me/2fa/enable', { token: u.token, body: { code: codeFor(s.json.secret, 0) } });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    u.secret = s.json.secret; u.recoveryCodes = e.json.recoveryCodes;
    return u;
  }
  async function loginStep1(u, ip) {
    const r = await call('POST', '/api/login', { body: { username: u.username, password: u.password }, ip });
    expect(r.status).toBe(200);
    return r.json;
  }
  const dbJson = () => JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf8'));

  test('подключение: пароль обязателен, неверный код отклоняется, верный включает; 10 кодов восстановления; секрет зашифрован', async () => {
    const u = await register();
    expect((await call('POST', '/api/me/2fa/setup', { token: u.token, body: { password: 'wrong-pass' } })).status).toBe(400);
    expect((await call('POST', '/api/me/2fa/setup', { token: u.token, body: {} })).status).toBe(400);
    const s = await call('POST', '/api/me/2fa/setup', { token: u.token, body: { password: u.password } });
    expect(s.status).toBe(200);
    expect(s.json.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.json.uri).toBe(`otpauth://totp/${encodeURIComponent(`Astra:${u.username}`)}?secret=${s.json.secret}&issuer=Astra&algorithm=SHA1&digits=6&period=30`);
    // ещё не включена
    expect((await call('GET', '/api/me', { token: u.token })).json.user.totpEnabled).toBe(false);
    // неверный код (смещение далеко за окном) и мусор
    const bad = await call('POST', '/api/me/2fa/enable', { token: u.token, body: { code: codeFor(s.json.secret, 5) } });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('totp_invalid');
    expect((await call('POST', '/api/me/2fa/enable', { token: u.token, body: { code: 'abc' } })).status).toBe(400);
    const ok = await call('POST', '/api/me/2fa/enable', { token: u.token, body: { code: codeFor(s.json.secret, 0) } });
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodes).toHaveLength(10);
    for (const c of ok.json.recoveryCodes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(new Set(ok.json.recoveryCodes).size).toBe(10);
    expect(ok.json.user.totpEnabled).toBe(true);
    const st = await call('GET', '/api/me/2fa', { token: u.token });
    expect(st.json).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    // повторное подключение — нельзя
    expect((await call('POST', '/api/me/2fa/setup', { token: u.token, body: { password: u.password } })).status).toBe(400);
    // существующая сессия не завершена
    expect((await call('GET', '/api/me', { token: u.token })).status).toBe(200);

    // хранение: ключ DATA_DIR/totp-key (32 байта, 600), секрет зашифрован, коды — только хэши
    const keyFile = path.join(tmp, 'totp-key');
    expect(fs.statSync(keyFile).size).toBe(32);
    if (process.platform !== 'win32') expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    await expect.poll(() => dbJson().users.find((x) => x.id === u.id)?.totpEnabled, { message: 'db.json записан' }).toBe(true);
    const rec = dbJson().users.find((x) => x.id === u.id);
    const raw = fs.readFileSync(path.join(tmp, 'db.json'), 'utf8');
    expect(rec.totpSecret).toMatch(/^v1\./);
    expect(raw).not.toContain(s.json.secret);
    for (const c of ok.json.recoveryCodes) { expect(raw).not.toContain(c); expect(raw).not.toContain(c.replace('-', '')); }
    expect(rec.totpRecovery).toHaveLength(10);
    for (const h of rec.totpRecovery) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('вход: после пароля нужен второй шаг; верный код → сессия; повтор кода и повтор challenge отклоняются', async () => {
    const u = await enable(await register());
    const step1 = await loginStep1(u);
    expect(step1.twoFactor).toBe(true);
    expect(step1.token).toBeUndefined();
    expect(step1.user).toBeUndefined();
    expect(typeof step1.challenge).toBe('string');
    // challenge — не сессия
    expect((await call('GET', '/api/me', { token: step1.challenge })).status).toBe(401);
    // неверный код — общий текст ошибки
    const bad = await call('POST', '/api/login/2fa', { body: { challenge: step1.challenge, code: codeFor(u.secret, 7) } });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe('Неверный код');
    // код шага «+1» (в окне, новее использованного при подключении)
    const code = codeFor(u.secret, 1);
    const ok = await call('POST', '/api/login/2fa', { body: { challenge: step1.challenge, code } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(typeof ok.json.token).toBe('string');
    expect(ok.json.user.totpEnabled).toBe(true);
    expect((await call('GET', '/api/me', { token: ok.json.token })).status).toBe(200);
    // challenge одноразовый
    const again = await call('POST', '/api/login/2fa', { body: { challenge: step1.challenge, code } });
    expect(again.status).toBe(401);
    expect(again.json.code).toBe('challenge_invalid');
    // повтор того же кода с новым challenge — отклонён (защита от повтора)
    const step1b = await loginStep1(u);
    const replay = await call('POST', '/api/login/2fa', { body: { challenge: step1b.challenge, code } });
    expect(replay.status).toBe(401);
    // выдуманный challenge
    expect((await call('POST', '/api/login/2fa', { body: { challenge: 'x'.repeat(43), code } })).json.code).toBe('challenge_invalid');
    // неверный пароль при включённой 2FA — обычная ошибка, без challenge
    const wrongPw = await call('POST', '/api/login', { body: { username: u.username, password: 'nope-nope' } });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.json.challenge).toBeUndefined();
  });

  test('код восстановления срабатывает один раз', async () => {
    const u = await enable(await register());
    const rc = u.recoveryCodes[3];
    const a = await loginStep1(u);
    const ok = await call('POST', '/api/login/2fa', { body: { challenge: a.challenge, code: rc.toUpperCase().replace('-', ' ') } });
    expect(ok.status, 'регистр и разделители не важны').toBe(200);
    const b = await loginStep1(u);
    expect((await call('POST', '/api/login/2fa', { body: { challenge: b.challenge, code: rc } })).status).toBe(401);
    expect((await call('GET', '/api/me/2fa', { token: ok.json.token })).json.recoveryCodesLeft).toBe(9);
    // другой код по-прежнему работает
    expect((await call('POST', '/api/login/2fa', { body: { challenge: b.challenge, code: u.recoveryCodes[4] } })).status).toBe(200);
  });

  test('блокировка: 5 неверных кодов в аккаунт (с разных адресов) → 429 даже для верного кода; лимит по адресу', async () => {
    const u = await enable(await register());
    for (let i = 0; i < 5; i++) {
      const s = await loginStep1(u);
      const r = await call('POST', '/api/login/2fa', { body: { challenge: s.challenge, code: '000000' === codeFor(u.secret, 0) ? '111111' : '000000' } });
      expect([401, 429]).toContain(r.status);
      if (i < 4) expect(r.status).toBe(401);
      else { expect(r.status).toBe(429); expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0); }
    }
    const s = await loginStep1(u);
    const locked = await call('POST', '/api/login/2fa', { body: { challenge: s.challenge, code: codeFor(u.secret, 1) } });
    expect(locked.status).toBe(429);
    expect(locked.json.error).toMatch(/Слишком много неверных кодов.*Подождите/);
    // блокировка действует и на чувствительные действия
    const pw = await call('POST', '/api/me/password', { token: u.token, body: { oldPassword: u.password, newPassword: 'other-pass1', code: codeFor(u.secret, 1) } });
    expect(pw.status).toBe(429);

    // по адресу: 20 неверных кодов с одного адреса (в разные аккаунты, по 4 в каждый) → 21-й — 429
    const ip = '10.99.0.7';
    const victims = [];
    for (let i = 0; i < 6; i++) victims.push(await enable(await register('tip')));
    let n = 0;
    for (const v of victims.slice(0, 5)) {
      for (let i = 0; i < 4; i++) {
        const st = await loginStep1(v, ip);
        const r = await call('POST', '/api/login/2fa', { body: { challenge: st.challenge, code: 'zzzzz-zzzzz' }, ip });
        expect(r.status).toBe(401);
        n++;
      }
    }
    expect(n).toBe(20);
    const last = victims[5];
    const st = await loginStep1(last, ip);
    expect((await call('POST', '/api/login/2fa', { body: { challenge: st.challenge, code: codeFor(last.secret, 1) }, ip })).status).toBe(429);
    // тот же аккаунт с другого адреса — входит
    const st2 = await loginStep1(last);
    expect((await call('POST', '/api/login/2fa', { body: { challenge: st2.challenge, code: codeFor(last.secret, 1) } })).status).toBe(200);
  });

  test('challenge: после 3 неверных попыток аннулируется; смена пароля аннулирует challenge', async () => {
    const u = await enable(await register());
    const c = await loginStep1(u);
    for (let i = 0; i < 3; i++) expect((await call('POST', '/api/login/2fa', { body: { challenge: c.challenge, code: 'qqqqq-qqqqq' } })).json.code).toBe('totp_invalid');
    const dead = await call('POST', '/api/login/2fa', { body: { challenge: c.challenge, code: u.recoveryCodes[1] } });
    expect(dead.json.code).toBe('challenge_invalid');
    const s = await loginStep1(u);
    // смена пароля другим сеансом (с кодом)
    const pw = await call('POST', '/api/me/password', { token: u.token, body: { oldPassword: u.password, newPassword: 'newpass77', code: codeFor(u.secret, 1) } });
    expect(pw.status, JSON.stringify(pw.json)).toBe(200);
    const r = await call('POST', '/api/login/2fa', { body: { challenge: s.challenge, code: u.recoveryCodes[0] } });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('challenge_invalid');
  });

  test('смена пароля требует свежий код; отключение 2FA — пароль + код (или код восстановления)', async () => {
    const u = await enable(await register());
    const body = { oldPassword: u.password, newPassword: 'brandnew77' };
    const no = await call('POST', '/api/me/password', { token: u.token, body });
    expect(no.status).toBe(403);
    expect(no.json.code).toBe('totp_required');
    const wrong = await call('POST', '/api/me/password', { token: u.token, body: { ...body, code: codeFor(u.secret, 6) } });
    expect(wrong.status).toBe(403);
    expect(wrong.json.code).toBe('totp_invalid');
    // неверный старый пароль проверяется первым (код не тратится)
    expect((await call('POST', '/api/me/password', { token: u.token, body: { oldPassword: 'zzzz', newPassword: 'brandnew77', code: codeFor(u.secret, 1) } })).status).toBe(400);
    const ok = await call('POST', '/api/me/password', { token: u.token, body: { ...body, code: codeFor(u.secret, 1) } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    u.password = 'brandnew77';

    // новые коды восстановления: пароль + код
    expect((await call('POST', '/api/me/2fa/recovery-codes', { token: u.token, body: { password: u.password } })).status).toBe(403);
    const regen = await call('POST', '/api/me/2fa/recovery-codes', { token: u.token, body: { password: u.password, code: u.recoveryCodes[0] } });
    expect(regen.status).toBe(200);
    expect(regen.json.recoveryCodes).toHaveLength(10);
    // старые коды больше не действуют
    expect((await call('POST', '/api/me/2fa/disable', { token: u.token, body: { password: u.password, code: u.recoveryCodes[1] } })).status).toBe(403);

    // отключение
    expect((await call('POST', '/api/me/2fa/disable', { token: u.token, body: { password: 'bad-pass', code: regen.json.recoveryCodes[0] } })).status).toBe(400);
    expect((await call('POST', '/api/me/2fa/disable', { token: u.token, body: { password: u.password } })).json.code).toBe('totp_required');
    const off = await call('POST', '/api/me/2fa/disable', { token: u.token, body: { password: u.password, code: regen.json.recoveryCodes[0] } });
    expect(off.status).toBe(200);
    expect(off.json.user.totpEnabled).toBe(false);
    // вход снова одношаговый, секреты стёрты
    const l = await loginStep1(u);
    expect(typeof l.token).toBe('string');
    expect(l.twoFactor).toBeUndefined();
    await expect.poll(() => dbJson().users.find((x) => x.id === u.id)?.totpEnabled).toBe(false);
    const rec = dbJson().users.find((x) => x.id === u.id);
    expect(rec.totpSecret).toBeUndefined();
    expect(rec.totpRecovery).toBeUndefined();
    // смена пароля снова без кода
    expect((await call('POST', '/api/me/password', { token: u.token, body: { oldPassword: u.password, newPassword: 'third-pass1' } })).status).toBe(200);
  });

  test('«Выйти на других устройствах»: остальные сеансы завершены, текущий жив', async () => {
    const u = await register();
    const other = (await call('POST', '/api/login', { body: { username: u.username, password: u.password } })).json.token;
    expect((await call('GET', '/api/me', { token: other })).status).toBe(200);
    const r = await call('POST', '/api/me/sessions/revoke-others', { token: u.token });
    expect(r.status).toBe(200);
    expect(r.json.revoked).toBe(1);
    expect((await call('GET', '/api/me', { token: other })).status).toBe(401);
    expect((await call('GET', '/api/me', { token: u.token })).status).toBe(200);
  });

  test('бот не может включить 2FA; вход бота по токену не затронут', async () => {
    const botToken = fs.readFileSync(path.join(tmp, 'bot-token.txt'), 'utf8').trim();
    for (const [m, url] of [['GET', '/api/me/2fa'], ['POST', '/api/me/2fa/setup'], ['POST', '/api/me/2fa/enable'], ['POST', '/api/me/2fa/disable']]) {
      expect((await call(m, url, { token: `Bot ${botToken}`, body: m === 'GET' ? undefined : { password: 'x', code: '123456' } })).status, url).toBe(403);
    }
    expect((await call('GET', '/api/me', { token: `Bot ${botToken}` })).status).toBe(200);
  });
});

test.describe('v20 2FA: данные не утекают', () => {
  test('/api/me, user:updated и bootstrap: только totpEnabled (и только себе), никаких секретов', async () => {
    const g = await guild(1, '2fa leak');
    const owner = g.owner, mem = g.members[0];
    try {
      const updates = collect(owner.socket, 'user:updated');
      const selfUpdates = collect(mem.socket, 'user:updated');
      const s = await http('POST', '/api/me/2fa/setup', { token: mem.token, body: { password: mem.password } });
      expect(s.status).toBe(200);
      const e = await http('POST', '/api/me/2fa/enable', { token: mem.token, body: { code: codeFor(s.json.secret, 0) } });
      expect(e.status).toBe(200);
      const secret = s.json.secret;
      const forbidden = (obj) => {
        const t = JSON.stringify(obj);
        expect(t).not.toContain(secret);
        expect(t).not.toMatch(/totpSecret|totpRecovery|totpLastStep|passwordHash/);
        for (const c of e.json.recoveryCodes) expect(t).not.toContain(c);
      };
      const me = await http('GET', '/api/me', { token: mem.token });
      expect(me.json.user.totpEnabled).toBe(true);
      forbidden(me.json);
      await expect.poll(() => updates.some((x) => x.user?.id === mem.id)).toBe(true);
      await expect.poll(() => selfUpdates.some((x) => x.user?.totpEnabled === true)).toBe(true);
      for (const u of updates) { forbidden(u); expect('totpEnabled' in u.user, 'чужим — без флага 2FA').toBe(false); }
      forbidden(selfUpdates);
      const view = await ack(owner.socket, 'bootstrap');
      forbidden(view);
      const memView = (view.servers || []).flatMap((sv) => sv.members || []).find((m) => m.id === mem.id);
      expect(memView).toBeTruthy();
      expect('totpEnabled' in memView).toBe(false);
      forbidden(await ack(mem.socket, 'bootstrap'));
      forbidden((await http('GET', '/api/me/2fa', { token: mem.token })).json);
    } finally { closeAll(g.all); }
  });
});

test.describe('v20 2FA: интерфейс', () => {
  test('подключение в «Моя учётная запись», вход в два шага (ПК), код восстановления (узкий экран), смена пароля с кодом', async ({ makePage }) => {
    const page = await makePage({
      name: 'enroll',
      allowErrors: [/status of 4\d\d/],
    });
    const reg = await loginViaToken(page, 'tfaui');
    const acc = await openSection(page, 'account');
    const box = acc.locator('#settings-2fa');
    await expect(box).toContainText('выключена');
    await expect(acc.locator('#settings-password-2fa')).toBeHidden();
    await box.locator('#twofa-enable').click();
    await box.locator('#twofa-password').fill('wrong-pass');
    await box.locator('#twofa-setup-submit').click();
    await expect(box.locator('#twofa-error')).toContainText('Неверный пароль');
    await box.locator('#twofa-password').fill(reg.password);
    await box.locator('#twofa-setup-submit').click();
    await expect(box.locator('#twofa-qr svg')).toBeVisible();
    const qrBox = await box.locator('#twofa-qr svg').boundingBox();
    expect(qrBox.width).toBeGreaterThan(120);
    const secret = (await box.locator('#twofa-secret').innerText()).replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await box.locator('.twofa-uri summary').click();
    await expect(box.locator('#twofa-uri')).toHaveValue(new RegExp(`^otpauth://totp/Astra%3A${reg.username}\\?secret=${secret}&issuer=Astra`));
    // неверный код
    await box.locator('#twofa-code').fill(codeFor(secret, 5));
    await box.locator('#twofa-confirm').click();
    await expect(box.locator('#twofa-error')).toContainText('Неверный код');
    await box.locator('#twofa-code').fill(codeFor(secret, 0));
    await box.locator('#twofa-confirm').click();
    const list = box.locator('#twofa-recovery-list li');
    await expect(list).toHaveCount(10);
    const codes = (await list.allInnerTexts()).map((t) => t.trim());
    // скачать .txt
    const [dl] = await Promise.all([page.waitForEvent('download'), box.locator('#twofa-download').click()]);
    expect(dl.suggestedFilename()).toBe(`astra-recovery-codes-${reg.username}.txt`);
    const txt = fs.readFileSync(await dl.path(), 'utf8');
    for (const c of codes) expect(txt).toContain(c);
    await box.locator('#twofa-done').click();
    await expect(box.locator('#twofa-status')).toHaveAttribute('data-enabled', 'true');
    await expect(box).toContainText('осталось: 10');
    await expect(acc.locator('#settings-password-2fa')).toBeVisible();

    // смена пароля: без кода — подсказка клиента, с кодом — успех
    await acc.locator('#settings-old-password').fill(reg.password);
    await acc.locator('#settings-new-password').fill('brandnew77');
    await acc.locator('#settings-confirm-password').fill('brandnew77');
    await acc.locator('#form-password [type="submit"]').click();
    await expect(acc.locator('#settings-password-error')).toContainText('код');
    const usedStep = stepNow() + 1; // этот шаг израсходован — повтор будет отклонён
    await acc.locator('#settings-password-code').fill(codeFor(secret, 1));
    await acc.locator('#form-password [type="submit"]').click();
    await expect(acc.locator('#settings-password-error')).toHaveText('');
    await expect.poll(async () => (await http('POST', '/api/login', { body: { username: reg.username, password: 'brandnew77' } })).json.twoFactor).toBe(true);
    await closeSettings(page).catch(() => {});

    // новый браузер (ПК): пароль → второй шаг → код
    const p2 = await makePage({ name: 'login-desktop', allowErrors: [/status of 401/] });
    await openApp(p2);
    await ensureAuthMode(p2, 'login');
    await fillAuth(p2, reg.username, 'brandnew77');
    await expect(p2.locator('#auth-2fa-form')).toBeVisible();
    await expect(p2.locator('#auth-form')).toBeHidden();
    await expect(p2.locator('#auth-title')).toHaveText('Двухфакторная защита');
    await p2.locator('#auth-2fa-code').fill('12345');
    await p2.locator('#auth-2fa-submit').click();
    await expect(p2.locator('#auth-2fa-error')).toContainText('6 цифр');
    await p2.locator('#auth-2fa-code').fill(codeFor(secret, 6));
    await p2.locator('#auth-2fa-submit').click();
    await expect(p2.locator('#auth-2fa-error')).toHaveText('Неверный код');
    // «Назад» возвращает к паролю
    await p2.locator('#auth-2fa-back').click();
    await expect(p2.locator('#auth-form')).toBeVisible();
    await fillAuth(p2, reg.username, 'brandnew77');
    await expect(p2.locator('#auth-2fa-form')).toBeVisible();
    // шаг usedStep уже потрачен на смену пароля: нужен код новее → ждём, пока «сейчас+1» станет больше (≤ 30 с)
    await expect.poll(() => stepNow() + 1, { timeout: 35_000, intervals: [500] }).toBeGreaterThan(usedStep);
    await p2.locator('#auth-2fa-code').fill(codeFor(secret, 1));
    await p2.locator('#auth-2fa-submit').click();
    await expect(p2.locator('#app')).toBeVisible();
    await expect(p2.locator('#auth-screen')).toBeHidden();

    // узкий экран (PWA/телефон): вход по коду восстановления
    const p3 = await makePage({ name: 'login-mobile', viewport: { width: 390, height: 800 } });
    await openApp(p3);
    await ensureAuthMode(p3, 'login');
    await fillAuth(p3, reg.username, 'brandnew77');
    await expect(p3.locator('#auth-2fa-form')).toBeVisible();
    await p3.locator('#auth-2fa-recovery').click();
    await expect(p3.locator('#auth-2fa-label')).toHaveText('Код восстановления');
    await p3.locator('#auth-2fa-code').fill(codes[0]);
    await p3.locator('#auth-2fa-submit').click();
    await expect(p3.locator('#app')).toBeVisible();
    expect((await http('GET', '/api/me/2fa', { token: reg.token })).json.recoveryCodesLeft).toBe(9);

    // отключение из настроек кодом восстановления
    const acc2 = await openSection(p2, 'account');
    const box2 = acc2.locator('#settings-2fa');
    await expect(box2).toContainText('осталось: 9');
    await box2.locator('#twofa-disable').click();
    await box2.locator('#twofa-action-password').fill('brandnew77');
    await box2.locator('#twofa-action-code').fill(codes[1]);
    await box2.locator('#twofa-action-submit').click();
    await expect(box2.locator('#twofa-status')).toHaveAttribute('data-enabled', 'false');
    await expect(acc2.locator('#settings-password-2fa')).toBeHidden();
    const after = await http('POST', '/api/login', { body: { username: reg.username, password: 'brandnew77' } });
    expect(typeof after.json.token).toBe('string');
  });
});
