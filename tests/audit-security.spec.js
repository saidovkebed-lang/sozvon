// Полный аудит: защита от перебора паролей и массовой регистрации (server/rate-limit.js).
// Отдельный сервер с TRUST_PROXY=1, адреса клиентов — через X-Forwarded-For. owner: qa
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { httpAt } from './fixtures/api.js';
import { PORT } from './fixtures/env.js';
import { startStandalone } from './fixtures/v3.js';

const RL_PORT = PORT + 36;

test.describe('audit: лимиты входа и регистрации', () => {
  let srv, tmp;
  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-qa-rl-'));
    srv = await startStandalone({ port: RL_PORT, dataDir: tmp, env: { TRUST_PROXY: '1' } });
  });
  test.afterAll(async () => { await srv?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const post = (url, body, ip) => httpAt(srv.base, 'POST', url, { body, headers: { 'X-Forwarded-For': ip } });

  test('вход: 10 неудач на адрес+логин → 429 с Retry-After и понятным текстом; другой адрес с верным паролем входит', async () => {
    expect((await post('/api/register', { username: 'victim', password: 'secret123' }, '10.0.0.1')).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post('/api/login', { username: 'victim', password: 'bad' + i }, '10.0.0.2')).status).toBe(401);
    const blocked = await post('/api/login', { username: 'victim', password: 'bad-x' }, '10.0.0.2');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.json.error).toMatch(/Слишком много.*Подождите/);
    // даже верный пароль с заблокированного адреса — 429 (иначе перебор продолжается)
    expect((await post('/api/login', { username: 'victim', password: 'secret123' }, '10.0.0.2')).status).toBe(429);
    // владелец аккаунта с другого адреса входит
    expect((await post('/api/login', { username: 'victim', password: 'secret123' }, '10.0.0.3')).status).toBe(200);
  });

  test('вход: перебор разных логинов с одного адреса — 30 неудач → 429', async () => {
    let first429 = null;
    for (let i = 0; i < 32; i++) {
      const r = await post('/api/login', { username: `nouser${i}`, password: 'x12345' }, '10.0.1.1');
      if (r.status === 429 && first429 === null) first429 = i;
    }
    expect(first429).toBe(30);
  });

  test('регистрация: 10 с адреса за час, 11-я → 429; с другого адреса — можно', async () => {
    for (let i = 0; i < 10; i++) expect((await post('/api/register', { username: `rl${i}x`, password: 'secret123' }, '10.0.2.1')).status).toBe(200);
    const r = await post('/api/register', { username: 'rl10x', password: 'secret123' }, '10.0.2.1');
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/[а-я]/i);
    expect((await post('/api/register', { username: 'rl11x', password: 'secret123' }, '10.0.2.2')).status).toBe(200);
  });

  test('основной сервер без TRUST_PROXY (loopback): локальный запуск и тесты не ограничиваются', async () => {
    // На основном тестовом сервере (без TRUST_PROXY, loopback) лимит выключен — 15 неудач подряд не дают 429.
    const { http } = await import('./fixtures/api.js');
    let got429 = false;
    for (let i = 0; i < 15; i++) if ((await http('POST', '/api/login', { body: { username: 'nobody-qa', password: 'x' + i } })).status === 429) got429 = true;
    expect(got429).toBe(false);
  });
});
