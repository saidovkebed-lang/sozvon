// Общий клиент Telegram Bot API: отправка (оповещения, коды входа) и приём обновлений (long polling).
// Без внешних зависимостей. Вебхук НЕ используется: сервер сам опрашивает getUpdates — так не нужен
// входящий адрес, и это работает за NAT/без домена.
//
// Настройки (/etc/sozvon.env):
//   TELEGRAM_BOT_TOKEN — бот для входа через Telegram (2FA); если не задан — ALERT_TELEGRAM_TOKEN,
//                        затем BACKUP_TELEGRAM_TOKEN (тот же бот владельца, что для копий и оповещений).
//   TELEGRAM_API       — адрес Bot API (для тестов); иначе ALERT_TELEGRAM_API / BACKUP_TELEGRAM_API.
//   TELEGRAM_PROXY     — http://… : всегда через этот HTTP-прокси (CONNECT); off — только напрямую;
//                        не задан — сначала напрямую, при сетевой ошибке через SPOTIFY_PROXY (VPN-прокси,
//                        deploy/vpn-proxy.sh): api.telegram.org часто недоступен напрямую с VPS в РФ.
//
// Токен бота никогда не попадает в журналы, ответы API и тексты ошибок (см. scrub()).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

const DEFAULT_API = 'https://api.telegram.org';
const trimApi = (s) => String(s || DEFAULT_API).replace(/\/+$/, '');

/** Бот для входа через Telegram (2FA). */
export function botConfig() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || process.env.ALERT_TELEGRAM_TOKEN || process.env.BACKUP_TELEGRAM_TOKEN || '').trim();
  const api = trimApi(process.env.TELEGRAM_API || process.env.ALERT_TELEGRAM_API || process.env.BACKUP_TELEGRAM_API);
  return { token, api, configured: !!token };
}

/** Telegram из РФ бывает недоступен напрямую: { fixed } — всегда через прокси, { fallback } — запасной. */
export function telegramProxy() {
  const fixed = (process.env.TELEGRAM_PROXY || '').trim();
  if (fixed === 'off') return { fixed: null, fallback: null };
  if (fixed) return { fixed, fallback: null };
  return { fixed: null, fallback: (process.env.SPOTIFY_PROXY || '').trim() || null };
}

export class TelegramError extends Error {
  constructor(message, { kind = 'api', status = 0, description = '', retryAfter = 0 } = {}) {
    super(message);
    this.kind = kind;            // 'network' — Telegram недоступен; 'api' — Telegram ответил ошибкой; 'config'
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

/** Убрать токен из любого текста (адрес запроса может оказаться в сообщении об ошибке). */
function scrub(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('***');
  return s.replace(/bot\d+:[\w-]{20,}/g, 'bot***');
}

/** POST JSON через HTTP-прокси (CONNECT-туннель) — как запросы к Spotify через VPN-прокси */
function postViaProxy(url, json, proxyUrl, timeoutMs) {
  const proxy = new URL(proxyUrl);
  const target = new URL(url);
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const auth = proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
  const payload = Buffer.from(JSON.stringify(json));
  return new Promise((resolve, reject) => {
    let req = null;
    const conn = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${target.hostname}:${port}`, headers: { host: `${target.hostname}:${port}`, ...auth } });
    const timer = setTimeout(() => { req?.destroy(); conn.destroy(); reject(Object.assign(new Error('таймаут'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    const fail = (e) => { clearTimeout(timer); reject(e); };
    conn.on('error', fail);
    conn.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) { socket.destroy(); fail(new Error(`прокси ответил ${pres.statusCode}`)); return; }
      const lib = target.protocol === 'https:' ? https : http;
      req = lib.request(target, {
        method: 'POST',
        headers: { host: target.host, 'content-type': 'application/json', 'content-length': payload.length },
        createConnection: () => (target.protocol === 'https:' ? tls.connect({ socket, servername: target.hostname }) : socket),
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => { clearTimeout(timer); resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
        r.on('error', fail);
      });
      req.on('error', fail);
      req.end(payload);
    });
    conn.end();
  });
}

// Если напрямую Telegram не отвечает, следующие 10 минут сразу идём через запасной прокси (не ждём таймаут).
const STICKY_PROXY_MS = 10 * 60_000;
const directFailedUntil = new Map(); // адрес Bot API → до какого момента идём сразу через прокси

/**
 * Вызов метода Bot API. Возвращает body.result; иначе бросает TelegramError (без токена в тексте).
 * opts: { token, api } — другой бот (оповещения); timeoutMs — для long polling больше.
 */
export async function tgCall(method, params = {}, { token, api, timeoutMs = 15_000 } = {}) {
  const cfg = botConfig();
  const tok = token ?? cfg.token;
  const base = trimApi(api ?? cfg.api);
  if (!tok) throw new TelegramError('Telegram-бот не настроен', { kind: 'config' });
  const url = `${base}/bot${tok}/${method}`;
  const { fixed, fallback } = telegramProxy();
  let status;
  let raw;
  const viaProxy = async (p) => {
    try { ({ status, text: raw } = await postViaProxy(url, params, p, timeoutMs + 5_000)); } catch (err) {
      throw new TelegramError(`Telegram недоступен и через VPN-прокси (${scrub(err.code || err.message, tok)})`, { kind: 'network' });
    }
  };
  if (fixed) await viaProxy(fixed);
  else if (fallback && (directFailedUntil.get(base) || 0) > Date.now()) await viaProxy(fallback);
  else {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
        signal: AbortSignal.timeout(fallback && timeoutMs <= 15_000 ? 10_000 : timeoutMs), // long polling — полный срок
      });
      status = res.status;
      raw = await res.text();
      if (fallback) directFailedUntil.delete(base);
    } catch (err) {
      const why = scrub(err.cause?.code || err.name || 'сеть', tok);
      if (!fallback) throw new TelegramError(`Telegram недоступен с этого сервера (${why}). Настройте VPN-прокси: sudo bash /opt/sozvon/deploy/vpn-proxy.sh`, { kind: 'network' });
      directFailedUntil.set(base, Date.now() + STICKY_PROXY_MS);
      await viaProxy(fallback);
    }
  }
  let body = null;
  try { body = JSON.parse(raw); } catch { /* не JSON */ }
  if (status < 200 || status >= 300 || !body?.ok) {
    const description = scrub(String(body?.description || status), tok).slice(0, 200);
    throw new TelegramError(`Telegram ответил ошибкой: ${description}`, { kind: 'api', status, description, retryAfter: Number(body?.parameters?.retry_after) || 0 });
  }
  return body.result;
}

/* ---------------- методы ---------------- */
export const sendMessage = (chatId, text, extra = {}, opts) =>
  tgCall('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }, opts);

export const editMessageText = (chatId, messageId, text, extra = {}, opts) =>
  tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }, opts);

export const answerCallbackQuery = (id, text = '', extra = {}, opts) =>
  tgCall('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: String(text).slice(0, 190) } : {}), ...extra }, opts);

export const setMyCommands = (commands, opts) => tgCall('setMyCommands', { commands }, opts);

let meCache = null; // { token, me, at }
/** getMe (кэш на час): { id, username, first_name } — для ссылки t.me/<username>. */
export async function getMe() {
  const { token } = botConfig();
  if (meCache && meCache.token === token && Date.now() - meCache.at < 3600_000) return meCache.me;
  const me = await tgCall('getMe');
  meCache = { token, me, at: Date.now() };
  return me;
}

/* ---------------- приём обновлений: long polling getUpdates ---------------- */
// Опрос идёт, только пока он кому-то нужен (wanted() — например, ждём нажатия «Start» при привязке,
// «Это я»/«Это не я» при входе): бот владельца используется и для резервных копий (deploy/backup.sh setup
// сам читает getUpdates, чтобы узнать chat id) — постоянный опрос забирал бы у него сообщения.
// Смещение (offset) хранится в DATA_DIR/telegram-offset.json — после перезапуска старые обновления
// повторно не обрабатываются.
const POLL_TIMEOUT_SEC = 25;
const MAX_BACKOFF_MS = 60_000;

export function createPoller({ dataDir, wanted, onUpdate, log = console }) {
  const file = dataDir ? path.join(dataDir, 'telegram-offset.json') : null;
  let offset = 0;
  try { offset = Number(JSON.parse(fs.readFileSync(file, 'utf8')).offset) || 0; } catch { /* нет файла */ }
  let running = false;
  let stopped = false;
  let backoff = 0;
  let lastError = null;
  let wakeTimer = null;

  const persist = () => {
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ offset }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) { log.warn('[telegram] Не удалось сохранить смещение:', err.message); }
  };
  const sleep = (ms) => new Promise((r) => { wakeTimer = setTimeout(r, ms); wakeTimer.unref?.(); });

  async function loop() {
    running = true;
    try {
      while (!stopped && botConfig().configured && wanted()) {
        let updates;
        try {
          updates = await tgCall('getUpdates', { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query'] },
            { timeoutMs: (POLL_TIMEOUT_SEC + 10) * 1000 });
          if (lastError) log.log('[telegram] Связь с Telegram восстановлена');
          backoff = 0;
          lastError = null;
        } catch (err) {
          // сеть, 409 (кто-то ещё читает getUpdates этого бота), 429 — ждём с нарастающей паузой до 60 с
          backoff = Math.min(MAX_BACKOFF_MS, Math.max(err.retryAfter * 1000 || 0, backoff ? backoff * 2 : 1000));
          if (lastError !== err.message) log.warn(`[telegram] Приём обновлений: ${err.message}; повтор через ${Math.round(backoff / 1000)} с`);
          lastError = err.message;
          await sleep(backoff);
          continue;
        }
        if (!Array.isArray(updates)) { await sleep(1000); continue; }
        for (const u of updates) {
          if (!Number.isFinite(u?.update_id)) continue;
          offset = Math.max(offset, u.update_id + 1);
          try { await onUpdate(u); } catch (err) { log.warn('[telegram] Ошибка обработки обновления:', err.message); }
        }
        if (updates.length) persist();
      }
    } finally {
      running = false;
      // пока цикл завершался, могла появиться новая потребность
      if (!stopped && botConfig().configured && wanted()) setImmediate(kick);
    }
  }

  function kick() {
    if (stopped || running || !botConfig().configured || !wanted()) return;
    loop().catch((err) => log.warn('[telegram] Опрос остановлен:', err.message));
  }

  return {
    /** Запустить опрос, если он нужен и ещё не идёт. */
    kick,
    stop() { stopped = true; clearTimeout(wakeTimer); },
    get running() { return running; },
    get offset() { return offset; },
  };
}
