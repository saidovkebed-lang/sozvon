// Самоподписанный сертификат (selfsigned) с SAN: localhost, 127.0.0.1 и все локальные IPv4.
// Пересоздаётся, если у машины появился новый IPv4-адрес (например, подключили VPN-оверлей).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';

export function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      const v4 = ni.family === 'IPv4' || ni.family === 4;
      if (v4 && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

export function ensureCerts(dataDir) {
  const dir = path.join(dataDir, 'certs');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const metaFile = path.join(dir, 'meta.json');
  const ips = ['127.0.0.1', ...localIPv4()];

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* нет meta — считаем валидным */ }
    const covered = !meta || ips.every((ip) => meta.ips?.includes(ip));
    const fresh = !meta?.expires || meta.expires > Date.now() + 7 * 864e5;
    if (covered && fresh) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), regenerated: false };
    }
    console.log('[certs] Набор IP-адресов изменился или сертификат истекает — генерирую новый…');
  }

  fs.mkdirSync(dir, { recursive: true });
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const days = 825;
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'Sozvon local server' }, { name: 'organizationName', value: 'Sozvon' }],
    {
      keySize: 2048,
      days,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ ips, expires: Date.now() + days * 864e5 }, null, 2));
  console.log(`[certs] Создан самоподписанный сертификат: ${certFile}`);
  return { key: pems.private, cert: pems.cert, regenerated: true };
}
