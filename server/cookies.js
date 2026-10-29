// Файл cookies YouTube для yt-dlp (обход «подтвердите, что вы не бот»).
//
// Где лежит:
//   • YTDLP_COOKIES=/путь/cookies.txt в /etc/sozvon.env — как раньше (файл должен читаться пользователем sozvon);
//   • если YTDLP_COOKIES не задан — DATA_DIR/cookies.txt (по умолчанию /var/lib/sozvon/cookies.txt): используется
//     автоматически, как только файл появился. Так cookies можно прислать боту Astra (server/tgbot.js) без правки
//     /etc/sozvon.env и перезапуска: сервер пишет файл сам (права 600), а музыка (server/music-sources.js)
//     подхватывает новый файл по mtime.
// Проверка содержимого — validateCookies(): Netscape-формат, домены YouTube/Google, cookies входа (SAPISID…).
import fs from 'node:fs';
import path from 'node:path';

let dataDir = null;
export function initCookies(dir) { dataDir = dir; }

const defaultPath = () => (dataDir ? path.join(dataDir, 'cookies.txt') : null);
export const MAX_COOKIES_BYTES = 1024 * 1024;

/** Файл для yt-dlp: YTDLP_COOKIES, иначе DATA_DIR/cookies.txt, если он есть; null — без cookies. */
export function cookiesSource() {
  if (process.env.YTDLP_COOKIES) return process.env.YTDLP_COOKIES;
  const d = defaultPath();
  try { if (d && fs.statSync(d).isFile()) return d; } catch { /* нет файла */ }
  return null;
}

/** Куда записывать присланный файл. */
export function cookiesTarget() {
  return process.env.YTDLP_COOKIES || defaultPath();
}

/** Для «Состояния сервера»: { configured, exists, mtime, ageDays, path, source: 'env' | 'default' }. */
export function cookiesStatus() {
  const src = cookiesSource();
  if (!src) return { configured: false };
  const source = process.env.YTDLP_COOKIES ? 'env' : 'default';
  try {
    const st = fs.statSync(src);
    return { configured: true, exists: true, mtime: st.mtimeMs, ageDays: Math.round(((Date.now() - st.mtimeMs) / 86400_000) * 10) / 10, source };
  } catch (err) {
    return { configured: true, exists: false, error: err.code || 'нет доступа', source };
  }
}

const AUTH_NAMES = /^(SAPISID|__Secure-[13]PAPISID|__Secure-[13]PSID|__Secure-3PSIDTS|SID|HSID|SSID|APISID|LOGIN_INFO)$/;
const STRONG = /^(SAPISID|__Secure-[13]PAPISID|__Secure-[13]PSID|LOGIN_INFO)$/;
const DOMAIN_OK = /(^|\.)(youtube\.com|google\.com)$/i;

/**
 * Проверить cookies.txt. → { ok: true, count, text } | { ok: false, error }.
 * Требования: ≤ 1 МБ, текст без двоичных данных, Netscape-заголовок или строки из 7 полей через табуляцию,
 * есть cookies для youtube.com/.google.com и среди них — cookies входа (SAPISID / __Secure-…PSID / LOGIN_INFO).
 */
export function validateCookies(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'Файл пустой' };
  if (buf.length > MAX_COOKIES_BYTES) return { ok: false, error: 'Файл больше 1 МБ' };
  if (buf.includes(0)) return { ok: false, error: 'Это не текстовый файл cookies' };
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const header = /^#\s*(Netscape )?HTTP Cookie File/i.test(lines.find((l) => l.trim()) || '');
  let rows = 0, yt = 0, strong = false;
  const names = new Set();
  for (const raw of lines) {
    let l = raw;
    if (l.startsWith('#HttpOnly_')) l = l.slice('#HttpOnly_'.length);
    else if (!l.trim() || l.startsWith('#')) continue;
    const f = l.split('\t');
    if (f.length !== 7) continue;
    if (!/^(TRUE|FALSE)$/i.test(f[1]) || !/^-?\d+$/.test(f[4].trim())) continue;
    rows++;
    const domain = f[0].trim().replace(/^\./, '');
    if (!DOMAIN_OK.test(domain)) continue;
    yt++;
    names.add(f[5]);
    if (STRONG.test(f[5])) strong = true;
  }
  if (!header && !rows) return { ok: false, error: 'Это не cookies.txt в формате Netscape (нужен экспорт расширением «Get cookies.txt LOCALLY»)' };
  if (!yt) return { ok: false, error: 'В файле нет cookies для youtube.com / google.com' };
  if (!strong || ![...names].some((n) => AUTH_NAMES.test(n))) {
    return { ok: false, error: 'Нет cookies входа (SAPISID / __Secure-3PSID): войдите в YouTube в браузере и экспортируйте заново' };
  }
  return { ok: true, count: yt, text };
}

/** Записать атомарно (tmp в том же каталоге + rename), права 600. → путь. */
export function writeCookies(text) {
  const target = cookiesTarget();
  if (!target) throw new Error('Не задан каталог данных');
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.cookies.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`Не удалось записать ${target}: ${err.code || err.message}. ${process.env.YTDLP_COOKIES ? 'Файл из YTDLP_COOKIES должен быть доступен на запись пользователю sozvon (или уберите YTDLP_COOKIES из /etc/sozvon.env — тогда используется /var/lib/sozvon/cookies.txt).' : ''}`.trim());
  }
  return target;
}
