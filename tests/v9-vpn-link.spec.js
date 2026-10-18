// v9: deploy/vpn-link.mjs — ссылка из v2RayNG → конфиг Xray (VPN-прокси для Spotify, deploy/vpn-proxy.sh).
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';

const run = (input, ...args) => spawnSync(process.execPath, ['deploy/vpn-link.mjs', ...args], { input, encoding: 'utf8' });
const conf = (link) => { const r = run(link); expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout); };
const UUID = '11111111-2222-3333-4444-555555555555';

test('vless reality / ws+tls, vmess, trojan, ss → outbound «vpn», прокси только на 127.0.0.1', () => {
  const c = conf(`vless://${UUID}@vpn.example.com:443?type=tcp&security=reality&pbk=PUBKEY&sni=www.microsoft.com&fp=chrome&sid=ab&flow=xtls-rprx-vision#NL`);
  expect(c.inbounds.every((i) => i.listen === '127.0.0.1')).toBe(true);
  expect(c.inbounds.map((i) => i.port)).toEqual([10808, 10809]);
  const o = c.outbounds[0];
  expect(o.tag).toBe('vpn');
  expect(o.settings.vnext[0]).toMatchObject({ address: 'vpn.example.com', port: 443, users: [{ id: UUID, flow: 'xtls-rprx-vision' }] });
  expect(o.streamSettings).toMatchObject({ network: 'tcp', security: 'reality', realitySettings: { publicKey: 'PUBKEY', serverName: 'www.microsoft.com', shortId: 'ab' } });

  const ws = conf(`vless://${UUID}@1.2.3.4:8443?type=ws&security=tls&host=cdn.example.com&path=%2Fws&sni=cdn.example.com#x`).outbounds[0];
  expect(ws.streamSettings).toMatchObject({ network: 'ws', security: 'tls', wsSettings: { path: '/ws', host: 'cdn.example.com' }, tlsSettings: { serverName: 'cdn.example.com' } });

  const vm = Buffer.from(JSON.stringify({ v: '2', ps: 'DE', add: 'de.example.com', port: '443', id: UUID, aid: '0', net: 'grpc', path: 'svc', tls: 'tls', sni: 'de.example.com' })).toString('base64');
  const v = conf(`vmess://${vm}`).outbounds[0];
  expect(v.protocol).toBe('vmess');
  expect(v.streamSettings).toMatchObject({ network: 'grpc', security: 'tls', grpcSettings: { serviceName: 'svc' } });

  const t = conf('trojan://pass%40word@tr.example.com:443?sni=tr.example.com#T').outbounds[0];
  expect(t.settings.servers[0]).toMatchObject({ address: 'tr.example.com', password: 'pass@word' });
  expect(t.streamSettings.security).toBe('tls');
  // allowInsecure в Xray 26 удалён — с ним конфиг не запускается
  expect(JSON.stringify(conf('trojan://p@tr.example.com:443?allowInsecure=1&insecure=1#T'))).not.toContain('allowInsecure');

  const ss = conf(`ss://${Buffer.from('chacha20-ietf-poly1305:secret').toString('base64')}@ss.example.com:8388#S`).outbounds[0];
  expect(ss.settings.servers[0]).toMatchObject({ address: 'ss.example.com', port: 8388, method: 'chacha20-ietf-poly1305', password: 'secret' });
});

test('плохие ссылки — понятная ошибка, код 2, пустой stdout', () => {
  for (const bad of ['http2://x', `vless://${UUID}@h:443?security=reality`, 'vmess://не-base64', '']) {
    const r = run(bad);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Ошибка/);
  }
});

test('подписка с заглушкой «Приложение не поддерживается» для v2rayNG → пробуем другие клиенты; одни заглушки → понятная ошибка', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const stub = `vless://${UUID}@0.0.0.0:1?type=tcp#${encodeURIComponent('Приложение не поддерживается')}`;
  const real = `vless://${UUID}@nl.example.com:443?type=tcp&security=reality&pbk=K&sni=a.com#NL\nvless://${UUID}@de.example.com:443?type=tcp&security=tls#DE`;
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ ua: req.headers['user-agent'], hwid: req.headers['x-hwid'] });
    const ok = req.url === '/sub' && /^Happ\//.test(req.headers['user-agent']) && req.headers['x-hwid'];
    res.end(Buffer.from(ok ? real : stub).toString('base64'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const go = (input, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['deploy/vpn-link.mjs', ...args]);
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (status) => resolve({ status, out, err }));
    p.stdin.end(input);
  });
  try {
    const list = await go(`${base}/sub`, '--list');
    expect(list.status, list.err).toBe(0);
    expect(list.err).toContain('0: NL');
    expect(list.err).toContain('1: DE');
    expect(list.err).not.toContain('0.0.0.0');
    const r = await go(`${base}/sub`, '--index', '1');
    expect(r.status, r.err).toBe(0);
    expect(JSON.parse(r.out).outbounds[0].settings.vnext[0].address).toBe('de.example.com');
    expect(seen[0].ua).toMatch(/^v2rayNG\//);
    expect(seen.every((s) => /^[0-9a-f]{16}$/.test(s.hwid))).toBe(true);

    const bad = await go(`${base}/only-stub`);
    expect(bad.status).toBe(2);
    expect(bad.out).toBe('');
    expect(bad.err).toContain('заглушку');
    expect(bad.err).toContain('Приложение не поддерживается');
  } finally { srv.close(); }
});
