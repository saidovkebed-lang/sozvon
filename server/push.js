// Web Push без внешних библиотек: VAPID (RFC 8292) + шифрование содержимого aes128gcm (RFC 8291).
// Ключи VAPID создаются при первом запуске: DATA_DIR/vapid.json (не публиковать privateKey).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

let vapid = null; // { publicKey: base64url(65 байт), privateKey: KeyObject, subject }

/** Загрузить или создать ключи VAPID. subject — mailto: или https: адрес владельца сервера. */
export function initPush(dataDir, { subject } = {}) {
  const file = path.join(dataDir, 'vapid.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет — создадим */ }
  let privateKey;
  let publicKey;
  if (saved?.privateJwk && saved?.publicKey) {
    privateKey = crypto.createPrivateKey({ key: saved.privateJwk, format: 'jwk' });
    publicKey = saved.publicKey;
  } else {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = pair.privateKey;
    publicKey = b64u(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-65));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ publicKey, privateJwk: privateKey.export({ format: 'jwk' }) }), { mode: 0o600 });
  }
  vapid = { publicKey, privateKey, subject: subject || 'mailto:admin@sozvon.invalid' };
  return publicKey;
}

export const pushPublicKey = () => vapid?.publicKey || null;

/** JWT VAPID (ES256) для origin сервиса доставки */
function vapidJwt(audience, ttlSec = 12 * 3600) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: vapid.subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

/**
 * Шифрование по RFC 8291 (aes128gcm, одна запись). uaPublic/authSecret — из подписки браузера (base64url).
 * opts.asPrivate / opts.salt — только для проверки по эталону RFC.
 */
export function encryptPayload(plaintext, uaPublicB64, authSecretB64, opts = {}) {
  const uaPublic = unb64u(uaPublicB64);
  const authSecret = unb64u(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (authSecret.length < 16) throw new Error('bad auth');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(unb64u(opts.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ? unb64u(opts.salt) : crypto.randomBytes(16);
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 — последняя запись, без дополнения
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Проверка, что подписка выглядит как настоящая (https endpoint, ключи нужной длины) */
export function validSubscription(sub) {
  try {
    const u = new URL(sub?.endpoint);
    // автотесты: локальный приёмник по http (только 127.0.0.1 и только с SOZVON_PUSH_ALLOW_HTTP=1)
    const testHttp = process.env.SOZVON_PUSH_ALLOW_HTTP === '1' && u.protocol === 'http:' && u.hostname === '127.0.0.1';
    if ((u.protocol !== 'https:' && !testHttp) || String(sub.endpoint).length > 1024) return false;
    if (unb64u(sub.keys?.auth).length < 16) return false;
    const pub = unb64u(sub.keys?.p256dh);
    if (pub.length !== 65 || pub[0] !== 4) return false;
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub); // бросит, если это не точка кривой P-256
    return true;
  } catch { return false; }
}

/**
 * Отправить push. payload — объект (JSON). Возвращает { ok, gone } — gone: подписка больше не действует
 * (404/410), её нужно удалить.
 */
export async function sendPush(sub, payload, { ttl = 3600, urgency = 'high' } = {}) {
  if (!vapid) return { ok: false };
  let endpoint;
  let body;
  try {
    endpoint = new URL(sub.endpoint);
    body = encryptPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  } catch (e) {
    console.warn(`[push] битая подписка: ${e.message}`);
    return { ok: false, gone: true };
  }
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: `vapid t=${vapidJwt(endpoint.origin)}, k=${vapid.publicKey}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true };
    if (!res.ok) console.warn(`[push] ${endpoint.host}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return { ok: res.ok };
  } catch (e) {
    console.warn(`[push] ${endpoint.host}: ${e.message}`);
    return { ok: false };
  }
}
