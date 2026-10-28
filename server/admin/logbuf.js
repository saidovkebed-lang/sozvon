// Кольцевой буфер последних ошибок сервера (console.error / console.warn) для админ-панели и оповещений.
// Подключается первым импортом в server/index.js. Строки обрезаются, похожие на секреты фрагменты скрываются.
import util from 'node:util';

const MAX = 100;
const buf = [];      // [{at, level, text}]
let errorTimes = []; // время console.error за последний час — для «всплеска ошибок»
let botChecks = [];  // время ошибок yt-dlp «подтвердите, что вы не бот» (server/music-sources.js пишет console.warn)
const BOT_CHECK = /yt-dlp.*(sign in to confirm|not a bot|confirm you.re not)/i;

/** Скрыть то, что похоже на токены: токены ботов Telegram, длинные hex/base64-строки, пароли в URL. */
export function redact(text) {
  return String(text)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[скрыто]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[скрыто]')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[скрыто]@')
    .replace(/((?:token|password|secret|passphrase|cookie)s?["'=:\s]+)[^\s"',;]{6,}/gi, '$1[скрыто]');
}

function push(level, args) {
  let text;
  try { text = util.format(...args); } catch { text = String(args[0]); }
  text = redact(text).slice(0, 600);
  const at = Date.now();
  buf.push({ at, level, text });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  if (BOT_CHECK.test(text)) { botChecks.push(at); if (botChecks.length > 1000) botChecks = botChecks.slice(-1000); }
  if (level === 'error') {
    errorTimes.push(at);
    if (errorTimes.length > 5000) errorTimes = errorTimes.slice(-5000);
  }
}

if (!console.__astraLogbuf) {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args) => { push('error', args); origError(...args); };
  console.warn = (...args) => { push('warn', args); origWarn(...args); };
  console.__astraLogbuf = true;
}

export function recentLogs(limit = MAX) {
  return buf.slice(-limit).reverse();
}

/** Сколько console.error было за последние ms. */
export function errorsSince(ms) {
  const from = Date.now() - ms;
  errorTimes = errorTimes.filter((t) => t >= Date.now() - 3600_000);
  return errorTimes.filter((t) => t >= from).length;
}

/** Строки буфера за последние ms, подходящие под регулярное выражение. */
export function matchingSince(re, ms) {
  const from = Date.now() - ms;
  return buf.filter((e) => e.at >= from && re.test(e.text));
}

/** Ошибки «не бот» у yt-dlp за последние ms: {count, last}. */
export function botCheckFailures(ms) {
  const from = Date.now() - ms;
  const list = botChecks.filter((t) => t >= from);
  return { count: list.length, last: botChecks.length ? botChecks[botChecks.length - 1] : null };
}
