// ICE-серверы для WebRTC. STUN хватает для большинства домашних сетей;
// TURN — запасной ретранслятор для «строгих» NAT (мобильный интернет, офисы, CGNAT).
//
// Варианты TURN (любой, по желанию):
//   1) Cloudflare Realtime TURN (бесплатно до 1000 ГБ/мес):
//        CF_TURN_KEY_ID=...  CF_TURN_API_TOKEN=...
//   2) Любой свой/арендованный TURN:
//        TURN_URL="turn:host:3478,turns:host:5349"  TURN_USERNAME=...  TURN_CREDENTIAL=...
//   3) Полный ручной список: ICE_SERVERS='[{"urls":"stun:..."}, ...]'

const DEFAULT_STUN = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

function staticServers() {
  if (process.env.ICE_SERVERS) {
    try {
      const v = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(v)) return v;
      console.warn('[ice] ICE_SERVERS должен быть JSON-массивом — использую STUN по умолчанию');
    } catch (err) {
      console.warn('[ice] Не удалось разобрать ICE_SERVERS:', err.message);
    }
  }
  const list = [...DEFAULT_STUN];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return list;
}

const STATIC = staticServers();
const CF_KEY = process.env.CF_TURN_KEY_ID;
const CF_TOKEN = process.env.CF_TURN_API_TOKEN;
const CF_TTL = 24 * 3600; // сек

let cfCache = null; // { servers, expires }
let cfInflight = null;

async function cloudflareTurn() {
  if (!CF_KEY || !CF_TOKEN) return [];
  if (cfCache && cfCache.expires - Date.now() > 2 * 3600 * 1000) return cfCache.servers;
  if (!cfInflight) {
    cfInflight = (async () => {
      try {
        const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CF_KEY}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: CF_TTL }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const servers = (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers])
          .filter(Boolean)
          // Порт 53 часто режут браузеры/провайдеры — убираем, как советует Cloudflare
          .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
        cfCache = { servers, expires: Date.now() + CF_TTL * 1000 };
        return servers;
      } catch (err) {
        console.warn('[ice] Cloudflare TURN недоступен:', err.message);
        return cfCache?.servers || [];
      } finally {
        cfInflight = null;
      }
    })();
  }
  return cfInflight;
}

export const turnConfigured = () => Boolean((CF_KEY && CF_TOKEN) || process.env.TURN_URL
  || STATIC.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u))));

export async function getIceServers() {
  return [...STATIC, ...(await cloudflareTurn())];
}
