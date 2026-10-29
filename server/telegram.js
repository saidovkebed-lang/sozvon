// Общий клиент Telegram Bot API: отправка (оповещения, коды входа, меню бота) и приём обновлений (long polling).
// Без внешних зависимостей. Вебхук НЕ используется: сервер сам опрашивает getUpdates — так не нужен
// входящий адрес, и это работает за NAT/без домена.
//
// Настройки (/etc/sozvon.env):
//   TELEGRAM_BOT_TOKEN — бот Astra (вход через Telegram, меню, уведомления); если не задан — ALERT_TELEGRAM_TOKEN,
//                        затем BACKUP_TELEGRAM_TOKEN (тот же бот владельца, что для копий и оповещений).
//   TELEGRAM_API       — адрес Bot API (для тестов); иначе ALERT_TELEGRAM_API / BACKUP_TELEGRAM_API.
//   TELEGRAM_PROXY     — http://… : всегда через этот HTTP-прокси (CONNECT); off — только напрямую;
//                        не задан — сначала напрямую, при сетевой ошибке через SPOTIFY_PROXY (VPN-прокси,
//                        deploy/vpn-proxy.sh): api.telegram.org часто недоступен напрямую с VPS в РФ.
//   TELEGRAM_POLLING   — 0: не опрашивать бота постоянно (только пока ждём привязку/подтверждение входа,
//                        как до появления меню). По умолчанию опрос идёт всё время, пока задан токен.
//   TELEGRAM_BUTTON_STYLE — 0: не использовать цветные кнопки (style) даже если Bot API их поддерживает.
//
// Токен бота никогда не попадает в журналы, ответы API и тексты ошибок (см. scrub()).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

const DEFAULT_API = 'https://api.telegram.org';
const trimApi = (s) => String(s || DEFAULT_API).replace(/\/+$/, '');

/** Бот Astra (вход через Telegram, меню). */
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
    this.kind = kind;            // 'network' — Telegram недоступен; 'api' — Telegram ответил ошибкой; 'config'; 'too_big'
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

const tooBig = () => Object.assign(new Error('слишком большой ответ'), { code: 'ETOOBIG' });

/** Запрос через HTTP-прокси (CONNECT-туннель) — как запросы к Spotify через VPN-прокси. → { status, buf } */
function requestViaProxy(url, { method = 'POST', json = null, timeoutMs, maxBytes = 0 }, proxyUrl) {
  const proxy = new URL(proxyUrl);
  const target = new URL(url);
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const auth = proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
  const payload = json ? Buffer.from(JSON.stringify(json)) : null;
  return new Promise((resolve, reject) => {
    let req = null;
    const conn = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${target.hostname}:${port}`, headers: { host: `${target.hostname}:${port}`, ...auth } });
    const timer = setTimeout(() => { req?.destroy(); conn.destroy(); reject(Object.assign(new Error('таймаут'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    const fail = (e) => { clearTimeout(timer); reject(e); };
    conn.on('error', fail);
    conn.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) { socket.destroy(); fail(new Error(`прокси ответил ${pres.statusCode}`)); return; }
      const lib = target.protocol === 'https:' ? https : http;
      const headers = { host: target.host, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) };
      req = lib.request(target, {
        method, headers,
        createConnection: () => (target.protocol === 'https:' ? tls.connect({ socket, servername: target.hostname }) : socket),
      }, (r) => {
        const chunks = [];
        let size = 0;
        r.on('data', (c) => {
          size += c.length;
          if (maxBytes && size > maxBytes) { r.destroy(); req.destroy(); fail(tooBig()); return; }
          chunks.push(c);
        });
        r.on('end', () => { clearTimeout(timer); resolve({ status: r.statusCode, buf: Buffer.concat(chunks) }); });
        r.on('error', fail);
      });
      req.on('error', fail);
      req.end(payload || undefined);
    });
    conn.end();
  });
}

/** Прямой запрос (fetch) с ограничением размера ответа. → { status, buf } */
async function requestDirect(url, { method = 'POST', json = null, timeoutMs, maxBytes = 0 }) {
  const res = await fetch(url, {
    method, headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const len = Number(res.headers.get('content-length')) || 0;
  if (maxBytes && len > maxBytes) { res.body?.cancel?.().catch(() => {}); throw tooBig(); }
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const c of res.body) {
      size += c.length;
      if (maxBytes && size > maxBytes) throw tooBig();
      chunks.push(Buffer.from(c));
    }
  }
  return { status: res.status, buf: Buffer.concat(chunks) };
}

// Если напрямую Telegram не отвечает, следующие 10 минут сразу идём через запасной прокси (не ждём таймаут).
const STICKY_PROXY_MS = 10 * 60_000;
const directFailedUntil = new Map(); // адрес Bot API → до какого момента идём сразу через прокси

/** Запрос к Bot API (метод или файл): «напрямую → VPN-прокси». Ошибки — TelegramError без токена. */
async function transport(base, url, tok, opts) {
  const { fixed, fallback } = telegramProxy();
  const { timeoutMs } = opts;
  const viaProxy = async (p) => {
    try { return await requestViaProxy(url, { ...opts, timeoutMs: timeoutMs + 5_000 }, p); } catch (err) {
      if (err.code === 'ETOOBIG') throw new TelegramError('Файл слишком большой', { kind: 'too_big' });
      throw new TelegramError(`Telegram недоступен и через VPN-прокси (${scrub(err.code || err.message, tok)})`, { kind: 'network' });
    }
  };
  if (fixed) return viaProxy(fixed);
  if (fallback && (directFailedUntil.get(base) || 0) > Date.now()) return viaProxy(fallback);
  try {
    // long polling — полный срок; обычные запросы при запасном прокси — быстрый отказ
    const out = await requestDirect(url, { ...opts, timeoutMs: fallback && timeoutMs <= 15_000 ? 10_000 : timeoutMs });
    if (fallback) directFailedUntil.delete(base);
    return out;
  } catch (err) {
    if (err.code === 'ETOOBIG') throw new TelegramError('Файл слишком большой', { kind: 'too_big' });
    const why = scrub(err.cause?.code || err.name || 'сеть', tok);
    if (!fallback) throw new TelegramError(`Telegram недоступен с этого сервера (${why}). Настройте VPN-прокси: sudo bash /opt/sozvon/deploy/vpn-proxy.sh`, { kind: 'network' });
    directFailedUntil.set(base, Date.now() + STICKY_PROXY_MS);
    return viaProxy(fallback);
  }
}

// ---------- цветные кнопки: поля style (primary | success | danger) и icon_custom_emoji_id ----------
// Появились в Bot API 9.4 (InlineKeyboardButton/KeyboardButton). Старый или сторонний Bot API-сервер может их
// не знать, а «пропустить неизвестное поле» Telegram не умеет — поэтому определение по факту: отправляем со
// style; если Bot API отвечает 400 из-за поля кнопки — повторяем без style/icon и запоминаем это на сутки
// для этого бота. TELEGRAM_BUTTON_STYLE=0 — не использовать вовсе.
const STYLE_KEYS = ['style', 'icon_custom_emoji_id'];
const STYLE_ERR = /style|icon_custom_emoji|unknown field|can't parse inline keyboard|BUTTON_TYPE_INVALID|button.*invalid/i;
const styleUnsupported = new Map(); // токен → до какого момента не отправлять style
const styleOff = () => ['0', 'false', 'off', 'no'].includes(String(process.env.TELEGRAM_BUTTON_STYLE || '').toLowerCase());
const hasStyle = (params) => Array.isArray(params?.reply_markup?.inline_keyboard)
  && params.reply_markup.inline_keyboard.some((row) => Array.isArray(row) && row.some((b) => b && STYLE_KEYS.some((k) => k in b)));
function stripStyle(params) {
  const kb = params.reply_markup.inline_keyboard.map((row) => row.map((b) => {
    const c = { ...b };
    for (const k of STYLE_KEYS) delete c[k];
    return c;
  }));
  return { ...params, reply_markup: { ...params.reply_markup, inline_keyboard: kb } };
}
/** Для тестов/диагностики: false — бот не принимает цветные кнопки; null — неизвестно/принимает. */
export const buttonStyleSupported = (token = botConfig().token) => ((styleUnsupported.get(token) || 0) > Date.now() ? false : null);

/**
 * Вызов метода Bot API. Возвращает body.result; иначе бросает TelegramError (без токена в тексте).
 * opts: { token, api } — другой бот (оповещения); timeoutMs — для long polling больше.
 */
export async function tgCall(method, params = {}, opts = {}) {
  const tok = opts?.token ?? botConfig().token;
  if (hasStyle(params) && (styleOff() || (styleUnsupported.get(tok) || 0) > Date.now())) return rawCall(method, stripStyle(params), opts);
  try {
    return await rawCall(method, params, opts);
  } catch (err) {
    if (!(err instanceof TelegramError) || err.kind !== 'api' || err.status !== 400 || !hasStyle(params) || !STYLE_ERR.test(err.description)) throw err;
    styleUnsupported.set(tok, Date.now() + 24 * 3600_000);
    console.warn('[telegram] Bot API не принимает цветные кнопки (style) — отправляю без них');
    return rawCall(method, stripStyle(params), opts);
  }
}

async function rawCall(method, params, { token, api, timeoutMs = 15_000 } = {}) {
  const cfg = botConfig();
  const tok = token ?? cfg.token;
  const base = trimApi(api ?? cfg.api);
  if (!tok) throw new TelegramError('Telegram-бот не настроен', { kind: 'config' });
  const { status, buf } = await transport(base, `${base}/bot${tok}/${method}`, tok, { method: 'POST', json: params, timeoutMs });
  let body = null;
  try { body = JSON.parse(buf.toString('utf8')); } catch { /* не JSON */ }
  if (status < 200 || status >= 300 || !body?.ok) {
    const description = scrub(String(body?.description || status), tok).slice(0, 200);
    throw new TelegramError(`Telegram ответил ошибкой: ${description}`, { kind: 'api', status, description, retryAfter: Number(body?.parameters?.retry_after) || 0 });
  }
  return body.result;
}

/**
 * Скачать файл, присланный боту: getFile → <api>/file/bot<токен>/<file_path> (та же логика «напрямую → прокси»).
 * Больше maxBytes — TelegramError kind 'too_big' (скачивание обрывается, лишнее в память не читается).
 */
export async function downloadFile(fileId, { maxBytes = 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const f = await tgCall('getFile', { file_id: fileId });
  if (Number(f?.file_size) > maxBytes) throw new TelegramError('Файл слишком большой', { kind: 'too_big' });
  if (typeof f?.file_path !== 'string' || !/^[\w./-]{1,256}$/.test(f.file_path) || f.file_path.includes('..')) {
    throw new TelegramError('Telegram не отдал файл', { kind: 'api' });
  }
  const cfg = botConfig();
  const base = trimApi(cfg.api);
  const { status, buf } = await transport(base, `${base}/file/bot${cfg.token}/${f.file_path}`, cfg.token, { method: 'GET', timeoutMs, maxBytes });
  if (status !== 200) throw new TelegramError(`Telegram не отдал файл (${status})`, { kind: 'api', status });
  return buf;
}

/* ---------------- методы ---------------- */
export const sendMessage = (chatId, text, extra = {}, opts) =>
  tgCall('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }, opts);

export const editMessageText = (chatId, messageId, text, extra = {}, opts) =>
  tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }, opts);

export const answerCallbackQuery = (id, text = '', extra = {}, opts) =>
  tgCall('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: String(text).slice(0, 190) } : {}), ...extra }, opts);

export const setMyCommands = (commands, extra = {}, opts) => tgCall('setMyCommands', { commands, ...extra }, opts);
export const setChatMenuButton = (menuButton, extra = {}, opts) => tgCall('setChatMenuButton', { menu_button: menuButton, ...extra }, opts);
export const deleteMessage = (chatId, messageId, opts) => tgCall('deleteMessage', { chat_id: chatId, message_id: messageId }, opts);

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
// Опрос идёт постоянно, пока задан токен (меню бота, ответы на уведомления). Раньше он шёл только «по
// требованию», потому что deploy/backup.sh setup сам читал getUpdates, чтобы узнать chat id; теперь setup
// при работающем сервере спрашивает chat id у сервера (admin.sock, команда tg-chats — см. server/tgbot.js),
// а getUpdates вызывает, только когда служба остановлена. TELEGRAM_POLLING=0 — старое поведение (wanted()).
// Смещение (offset) хранится в DATA_DIR/telegram-offset.json — после перезапуска старые обновления повторно
// не обрабатываются; вдобавок последние update_id помнятся в памяти (повтор того же обновления не исполняется).
const POLL_TIMEOUT_SEC = 25;
const MAX_BACKOFF_MS = 60_000;
const SEEN_MAX = 1000;
export const continuousPolling = () => !['0', 'false', 'off', 'no'].includes(String(process.env.TELEGRAM_POLLING ?? '1').toLowerCase());

export function createPoller({ dataDir, wanted = () => true, onUpdate, log = console }) {
  const file = dataDir ? path.join(dataDir, 'telegram-offset.json') : null;
  let offset = 0;
  try { offset = Number(JSON.parse(fs.readFileSync(file, 'utf8')).offset) || 0; } catch { /* нет файла */ }
  let running = false;
  let stopped = false;
  let backoff = 0;
  let lastError = null;
  let wakeTimer = null;
  const seen = new Set();
  const want = () => continuousPolling() || wanted();

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
      while (!stopped && botConfig().configured && want()) {
        let updates;
        const startedAt = Date.now();
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
        // Telegram держит пустой getUpdates до POLL_TIMEOUT_SEC; если ответ пришёл мгновенно и пустой
        // (сбойный прокси, заглушка), не долбим его в цикле — не чаще раза в секунду
        if (!updates.length && Date.now() - startedAt < 1000) await sleep(1000 - (Date.now() - startedAt));
        for (const u of updates) {
          if (!Number.isFinite(u?.update_id) || u.update_id < offset || seen.has(u.update_id)) continue;
          offset = Math.max(offset, u.update_id + 1);
          seen.add(u.update_id);
          if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
          try { await onUpdate(u); } catch (err) { log.warn('[telegram] Ошибка обработки обновления:', err.message); }
        }
        if (updates.length) persist();
      }
    } finally {
      running = false;
      // пока цикл завершался, могла появиться новая потребность
      if (!stopped && botConfig().configured && want()) setTimeout(kick, 1000).unref?.();
    }
  }

  function kick() {
    if (stopped || running || !botConfig().configured || !want()) return;
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
