// ICE-серверы для WebRTC.
//
// Боевой режим (сервер в РФ, deploy/install.sh): свой coturn на том же сервере.
//   TURN_SECRET=<static-auth-secret coturn>  TURN_HOST=<домен>  [TURN_PORT=3478] [TURNS_PORT=5349]
//   Учётки выдаются на 24 ч по схеме TURN REST API (HMAC-SHA1), как ожидает coturn с use-auth-secret.
//   Зарубежные STUN в этом режиме не используются вообще.
// Дополнительно:
//   FORCE_RELAY=1 — весь голос/видео только через свой TURN (скрывает IP участников, обходит любые NAT).
//   TURN_URL / TURN_USERNAME / TURN_CREDENTIAL — сторонний TURN со статическими учётками.
//   ICE_SERVERS='[...]' — полный ручной список.
import crypto from 'node:crypto';

const TTL = 24 * 3600;
const env = process.env;
const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

const TURN_SECRET = env.TURN_SECRET || '';
const TURN_HOST = env.TURN_HOST || '';
const TURN_PORT = Number(env.TURN_PORT) || 3478;
const TURNS_PORT = Number(env.TURNS_PORT) || 5349;

function manualServers() {
  if (!env.ICE_SERVERS) return null;
  try {
    const v = JSON.parse(env.ICE_SERVERS);
    if (Array.isArray(v)) return v;
    console.warn('[ice] ICE_SERVERS должен быть JSON-массивом — игнорирую');
  } catch (err) {
    console.warn('[ice] Не удалось разобрать ICE_SERVERS:', err.message);
  }
  return null;
}

const MANUAL = manualServers();

function ownTurn() {
  if (!TURN_SECRET || !TURN_HOST) return [];
  const username = `${Math.floor(Date.now() / 1000) + TTL}:sozvon`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [
    { urls: [`stun:${TURN_HOST}:${TURN_PORT}`] },
    {
      urls: [
        `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
        `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
        `turns:${TURN_HOST}:${TURNS_PORT}?transport=tcp`,
      ],
      username,
      credential,
    },
  ];
}

function staticTurn() {
  if (!env.TURN_URL) return [];
  return [{
    urls: env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
    username: env.TURN_USERNAME || '',
    credential: env.TURN_CREDENTIAL || '',
  }];
}

const FALLBACK_STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export const turnConfigured = () => Boolean((TURN_SECRET && TURN_HOST) || env.TURN_URL
  || (MANUAL || []).some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u))));

/** Принудительный relay имеет смысл только если TURN действительно есть. */
export const forceRelay = () => flag(env.FORCE_RELAY) && turnConfigured();

export async function getIceServers() {
  if (MANUAL) return MANUAL;
  const own = ownTurn();
  const list = [...own, ...staticTurn()];
  // Свой STUN есть — чужие не нужны (в РФ зарубежные STUN могут быть недоступны)
  return own.length ? list : [...FALLBACK_STUN, ...list];
}
