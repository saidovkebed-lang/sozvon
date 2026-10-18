#!/usr/bin/env node
// Ссылка из v2RayNG / подписки → конфиг Xray-клиента для сервера Astra (deploy/vpn-proxy.sh).
// Поддержка: vless:// (tcp/raw, ws, grpc, xhttp, httpupgrade; none/tls/reality), vmess:// (base64 JSON),
// trojan://, ss:// (SIP002 и старый base64), а также https-ссылка на подписку (список таких ссылок).
// Xray слушает ТОЛЬКО внутри сервера: SOCKS 127.0.0.1:10808 и HTTP 127.0.0.1:10809.
//
//   node vpn-link.mjs <ссылка> [--index N] [--list]   — конфиг JSON в stdout, описание — в stderr
//   ссылку можно передать и через stdin (так она не попадёт в историю команд)

const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;

const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const index = Number(flag('--index') || 0);
const listOnly = args.includes('--list') && args.splice(args.indexOf('--list'), 1);
const die = (m) => { console.error(`Ошибка: ${m}`); process.exit(2); };

const b64 = (s) => {
  const t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64').toString('utf8');
};
const qs = (u) => Object.fromEntries(new URL(u).searchParams);
const nameOf = (u) => { try { return decodeURIComponent(new URL(u).hash.slice(1)) || ''; } catch { return ''; } };

const bad = (m) => { throw new Error(m); };

/** Параметры транспорта/шифрования в streamSettings Xray */
function stream(p) {
  const net = (p.type || p.net || 'tcp').toLowerCase();
  const st = { network: net === 'raw' ? 'tcp' : net };
  const host = p.host || '';
  const path = p.path || '/';
  if (net === 'ws') st.wsSettings = { path, ...(host ? { host, headers: { Host: host } } : {}) };
  else if (net === 'grpc') st.grpcSettings = { serviceName: p.serviceName || p.path || '', multiMode: p.mode === 'multi' };
  else if (net === 'xhttp' || net === 'splithttp') { st.network = 'xhttp'; st.xhttpSettings = { path, ...(host ? { host } : {}), ...(p.mode ? { mode: p.mode } : {}) }; }
  else if (net === 'httpupgrade') st.httpupgradeSettings = { path, ...(host ? { host } : {}) };
  else if (net === 'tcp' || net === 'raw') {
    if ((p.headerType || p.type2) === 'http') st.tcpSettings = { header: { type: 'http', request: { path: [path], headers: host ? { Host: [host] } : {} } } };
  } else bad(`транспорт «${net}» не поддерживается`);

  const sec = (p.security || (p.tls === 'tls' ? 'tls' : '') || 'none').toLowerCase();
  const alpn = p.alpn ? String(p.alpn).split(',').filter(Boolean) : undefined;
  if (sec === 'tls') {
    st.security = 'tls';
    st.tlsSettings = { serverName: p.sni || p.host || p.add || p.server, ...(p.fp ? { fingerprint: p.fp } : {}), ...(alpn ? { alpn } : {}),
      ...(p.allowInsecure === '1' || p.insecure === '1' ? { allowInsecure: true } : {}) };
  } else if (sec === 'reality') {
    if (!p.pbk) bad('в ссылке REALITY нет pbk (публичного ключа)');
    st.security = 'reality';
    st.realitySettings = { serverName: p.sni || '', fingerprint: p.fp || 'chrome', publicKey: p.pbk, shortId: p.sid || '', spiderX: p.spx || '' };
  } else st.security = 'none';
  return st;
}

function parseLink(link) {
  const s = link.trim();
  const scheme = s.slice(0, s.indexOf('://')).toLowerCase();
  if (scheme === 'vless' || scheme === 'trojan') {
    const u = new URL(s);
    const p = { ...qs(s), server: u.hostname };
    const port = Number(u.port) || 443;
    const id = decodeURIComponent(u.username);
    const out = scheme === 'vless'
      ? { protocol: 'vless', settings: { vnext: [{ address: u.hostname.replace(/^\[|\]$/g, ''), port, users: [{ id, encryption: p.encryption || 'none', ...(p.flow ? { flow: p.flow } : {}) }] }] } }
      : { protocol: 'trojan', settings: { servers: [{ address: u.hostname.replace(/^\[|\]$/g, ''), port, password: id }] } };
    if (scheme === 'trojan' && !p.security) p.security = 'tls';
    out.streamSettings = stream(p);
    return { name: nameOf(s), proto: scheme, host: u.hostname, port, out };
  }
  if (scheme === 'vmess') {
    let j;
    try { j = JSON.parse(b64(s.slice(8).split('#')[0])); } catch { bad('vmess-ссылка не читается (ожидался base64 JSON)'); }
    const p = { ...j, type: j.net, headerType: j.type, server: j.add };
    const out = { protocol: 'vmess', settings: { vnext: [{ address: j.add, port: Number(j.port), users: [{ id: j.id, alterId: Number(j.aid) || 0, security: j.scy || 'auto' }] }] } };
    out.streamSettings = stream(p);
    return { name: j.ps || '', proto: 'vmess', host: j.add, port: Number(j.port), out };
  }
  if (scheme === 'ss') {
    const body = s.slice(5).split('#')[0];
    let method; let password; let host; let port;
    const at = body.lastIndexOf('@');
    if (at > 0) { // SIP002: base64(method:password)@host:port
      const cred = decodeURIComponent(body.slice(0, at));
      const dec = cred.includes(':') ? cred : b64(cred);
      [method, password] = [dec.slice(0, dec.indexOf(':')), dec.slice(dec.indexOf(':') + 1)];
      const hp = body.slice(at + 1).split(/[/?]/)[0];
      host = hp.slice(0, hp.lastIndexOf(':')).replace(/^\[|\]$/g, ''); port = Number(hp.slice(hp.lastIndexOf(':') + 1));
    } else { // старый формат: base64(method:password@host:port)
      const dec = b64(body);
      const m = dec.match(/^([^:]+):(.*)@([^@]+):(\d+)$/);
      if (!m) bad('ss-ссылка не читается');
      [, method, password, host] = m; port = Number(m[4]);
    }
    return { name: nameOf(s), proto: 'shadowsocks', host, port, out: { protocol: 'shadowsocks', settings: { servers: [{ address: host, port, method, password }] } } };
  }
  bad(`тип ссылки «${scheme || s.slice(0, 10)}» не поддерживается (нужны vless/vmess/trojan/ss или ссылка на подписку)`);
}

// Заглушка вместо сервера: панели (Remnawave, Marzban…) так отвечают неизвестному приложению
const isStub = (l) => { try { const p = parseLink(l); return !p.host || p.host === '0.0.0.0' || p.host === '127.0.0.1' || p.port <= 1; } catch { return false; } };
const toLinks = (text) => {
  const plain = /:\/\//.test(text) ? text : b64(text);
  return plain.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(vless|vmess|trojan|ss):\/\//i.test(l));
};
/** Подписку скачиваем, представляясь разными клиентами, пока не придут настоящие серверы */
async function fetchSubscription(url) {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const { hostname } = await import('node:os');
  let mid = hostname();
  try { mid = readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* нет machine-id */ }
  const hwid = createHash('sha256').update(`astra-vpn:${mid}`).digest('hex').slice(0, 16);
  const device = { 'x-hwid': hwid, 'x-device-os': 'Android', 'x-ver-os': '14', 'x-device-model': 'Astra server' };
  const agents = process.env.VPN_SUB_UA ? [process.env.VPN_SUB_UA]
    : ['v2rayNG/1.10.23', 'Happ/3.7.0', 'v2RayTun/5.13.0', 'Hiddify/2.5.7', 'v2rayN/7.13.8', 'Streisand/1.6.48'];
  let stubs = []; let lastErr = '';
  for (const ua of agents) {
    let text;
    try {
      const res = await fetch(url, { headers: { 'user-agent': ua, accept: '*/*', ...device }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) { lastErr = `подписка ответила ${res.status}`; continue; }
      text = await res.text();
    } catch (e) { lastErr = `не удалось загрузить подписку: ${e.message}`; continue; }
    const all = toLinks(text);
    const real = all.filter((l) => !isStub(l));
    if (real.length) { if (ua !== agents[0]) console.error(`(подписка выдана для клиента ${ua.split('/')[0]})`); return real; }
    if (all.length) stubs = all;
  }
  if (stubs.length) {
    const why = stubs.map((l) => { try { return parseLink(l).name; } catch { return ''; } }).filter(Boolean).join('; ');
    die(`подписка выдаёт заглушку вместо серверов${why ? ` («${why}»)` : ''}. Возьмите ссылку на отдельный сервер: в v2RayNG «⋮» у сервера → «Поделиться» → «Копировать в буфер» (vless://…)`);
  }
  die(lastErr || 'в подписке нет поддерживаемых серверов');
}

async function readInput() {
  if (args[0]) return args[0];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const input = (await readInput()).trim();
if (!input) die('пустая ссылка');
let links = [input];
if (/^https?:\/\//i.test(input)) { // подписка
  links = await fetchSubscription(input);
}
const errors = [];
const parsed = links.map((l) => { try { return parseLink(l); } catch (e) { errors.push(e.message); return null; } }).filter(Boolean);
if (!parsed.length) die(errors[0] || 'ссылка не распознана');
if (listOnly) {
  parsed.forEach((p, i) => console.error(`${i}: ${p.name || '(без имени)'} — ${p.proto} ${p.host}:${p.port}`));
  process.exit(0);
}
const pick = parsed[index];
if (!pick) die(`сервера №${index} нет (всего ${parsed.length})`);
console.error(`Сервер: ${pick.name || '(без имени)'} — ${pick.proto} ${pick.host}:${pick.port}${links.length > 1 ? ` (из подписки: ${index + 1} из ${parsed.length})` : ''}`);

const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    { tag: 'socks', listen: '127.0.0.1', port: SOCKS_PORT, protocol: 'socks', settings: { udp: true } },
    { tag: 'http', listen: '127.0.0.1', port: HTTP_PORT, protocol: 'http', settings: {} },
  ],
  outbounds: [{ tag: 'vpn', ...pick.out }, { tag: 'direct', protocol: 'freedom' }],
};
process.stdout.write(JSON.stringify(config, null, 2) + '\n');
