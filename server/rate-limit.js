// Защита от перебора паролей и массовой регистрации (в памяти процесса — для сервера друзей хватает).
// Включено всегда; запросы с самого сервера (127.0.0.1/::1) не ограничиваются, если сервер работает
// не за прокси (за nginx с TRUST_PROXY=1 req.ip — настоящий адрес клиента).
const TRUST_PROXY = ['1', 'true'].includes(String(process.env.TRUST_PROXY));
const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

export class Limiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.map = new Map(); // key → { count, reset }
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.reset <= now) this.map.delete(k);
    }, Math.min(windowMs, 10 * 60_000)).unref();
  }

  /** Сколько секунд ещё ждать (0 — можно) */
  blockedFor(key) {
    const v = this.map.get(key);
    if (!v || v.reset <= Date.now() || v.count < this.limit) return 0;
    return Math.ceil((v.reset - Date.now()) / 1000);
  }

  hit(key) {
    const now = Date.now();
    const v = this.map.get(key);
    if (!v || v.reset <= now) this.map.set(key, { count: 1, reset: now + this.windowMs });
    else v.count += 1;
  }

  clear(key) { this.map.delete(key); }
}

export const exempt = (ip) => !TRUST_PROXY && LOOPBACK.test(String(ip || ''));

export function waitText(sec) {
  const m = Math.ceil(sec / 60);
  return m <= 1 ? 'минуту' : `${m} мин`;
}
