// Оповещения владельцу в Telegram: раз в 5 минут проверки состояния; по каждому инциденту — одно сообщение
// при начале и одно при восстановлении. Состояние — DATA_DIR/alerts-state.json (переживает перезапуск).
//
// Настройки (/etc/sozvon.env): ALERT_TELEGRAM_TOKEN, ALERT_TELEGRAM_CHAT_ID — если не заданы, берутся
// BACKUP_TELEGRAM_TOKEN / BACKUP_TELEGRAM_CHAT_ID (тот же бот, что для резервных копий). ALERT_TELEGRAM_API —
// адрес Bot API (для тестов), ALERT_INTERVAL_MS (по умолчанию 300000; 0 — без периодических проверок).
// Пороги: ALERT_DISK_PCT (85), ALERT_RAM_PCT (90), ALERT_BACKUP_MAX_HOURS (36), ALERT_CERT_DAYS (14),
// ALERT_ERROR_BURST (20 ошибок за 5 минут), ALERT_COOKIES_MAX_DAYS (30). Других внешних сервисов нет.
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, getSettings, updateSettings } from './access.js';
import { collectHealth } from './health.js';

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const ALERTS = [
  { key: 'vpn', title: 'VPN-прокси (Spotify/YouTube)' },
  { key: 'cookies', title: 'Cookies YouTube устарели' },
  { key: 'botcheck', title: 'YouTube требует «подтвердите, что вы не бот»' },
  { key: 'disk', title: 'Мало места на диске' },
  { key: 'ram', title: 'Не хватает памяти' },
  { key: 'backup', title: 'Резервная копия' },
  { key: 'sfu', title: 'Сервер трансляций (SFU)' },
  { key: 'errors', title: 'Всплеск ошибок сервера' },
  { key: 'cert', title: 'Сертификат HTTPS истекает' },
];

let dataDir = null;
let state = { active: {}, lastRun: null, ramHigh: 0, lastError: null };
let running = null;
let timer = null;

const stateFile = () => path.join(dataDir, 'alerts-state.json');
function saveState() { try { writeJsonAtomic(stateFile(), state); } catch (err) { console.warn('[alerts] Не удалось сохранить состояние:', err.message); } }

export function telegramConfig() {
  const token = process.env.ALERT_TELEGRAM_TOKEN || process.env.BACKUP_TELEGRAM_TOKEN || '';
  const chat = process.env.ALERT_TELEGRAM_CHAT_ID || process.env.BACKUP_TELEGRAM_CHAT_ID || '';
  const api = (process.env.ALERT_TELEGRAM_API || process.env.BACKUP_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
  const source = process.env.ALERT_TELEGRAM_TOKEN ? 'ALERT_TELEGRAM_*' : (process.env.BACKUP_TELEGRAM_TOKEN ? 'BACKUP_TELEGRAM_*' : null);
  return { token, chat, api, configured: !!(token && chat), source };
}

/** Отправить сообщение в Telegram. Токен в ответы/журналы не попадает. */
export async function sendTelegram(text) {
  const cfg = telegramConfig();
  if (!cfg.configured) throw new Error('Telegram не настроен: задайте ALERT_TELEGRAM_TOKEN и ALERT_TELEGRAM_CHAT_ID (или BACKUP_TELEGRAM_*) в /etc/sozvon.env');
  let res;
  try {
    res = await fetch(`${cfg.api}/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chat, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Telegram недоступен (${err.cause?.code || err.name || 'сеть'})`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* не JSON */ }
  if (!res.ok || !body?.ok) throw new Error(`Telegram ответил ошибкой: ${String(body?.description || res.status).slice(0, 200)}`);
  return true;
}

export function toggles() {
  const t = getSettings().alertToggles || {};
  return Object.fromEntries(ALERTS.map((a) => [a.key, t[a.key] !== false]));
}

export function setToggles(patch) {
  const cur = toggles();
  for (const a of ALERTS) if (typeof patch?.[a.key] === 'boolean') cur[a.key] = patch[a.key];
  updateSettings({ alertToggles: cur });
  return cur;
}

const fmtPct = (n) => `${Math.round(n)} %`;

/** Текущие проблемы по снимку состояния: {key: текст} */
function evaluate(h) {
  const out = {};
  const T = {
    disk: num(process.env.ALERT_DISK_PCT, 85), ram: num(process.env.ALERT_RAM_PCT, 90),
    backupH: num(process.env.ALERT_BACKUP_MAX_HOURS, 36), certDays: num(process.env.ALERT_CERT_DAYS, 14),
    burst: num(process.env.ALERT_ERROR_BURST, 20), cookiesDays: num(process.env.ALERT_COOKIES_MAX_DAYS, 30),
  };
  if (h.vpn?.configured && !h.vpn.ok) out.vpn = `VPN-прокси ${h.vpn.proxy || ''} не отвечает (${h.vpn.error || 'ошибка'}). Spotify и YouTube через прокси недоступны. Проверка: sudo bash /opt/sozvon/deploy/vpn-proxy.sh --check`;
  const ck = h.music?.cookies;
  if (ck?.configured && (!ck.exists || ck.ageDays > T.cookiesDays)) {
    out.cookies = ck.exists ? `Файлу cookies YouTube уже ${Math.floor(ck.ageDays)} дн. — обновите его (docs/MUSIC.md)` : `Файл cookies YouTube (YTDLP_COOKIES) не читается: ${ck.error || 'нет файла'}`;
  }
  const bc = h.music?.botChecksHour ?? 0;
  if (bc >= 2) out.botcheck = `За последний час ${bc} раз(а) YouTube потребовал «подтвердите, что вы не бот» — нужны свежие cookies (YTDLP_COOKIES) или прокси`;
  for (const d of h.system?.disks || []) {
    if (Number.isFinite(d.pct) && d.pct > T.disk) { out.disk = `Диск ${d.path} заполнен на ${fmtPct(d.pct)} (свободно ${Math.round((d.free || 0) / 1073741824 * 10) / 10} ГБ)`; break; }
  }
  if (h.system?.memory?.pct > T.ram) {
    state.ramHigh = (state.ramHigh || 0) + 1;
    if (state.ramHigh >= 2) out.ram = `Память занята на ${fmtPct(h.system.memory.pct)} уже несколько проверок подряд`;
  } else state.ramHigh = 0;
  if (h.backup?.known) {
    if (!h.backup.ok) out.backup = `Резервная копия не удалась${h.backup.error ? `: ${h.backup.error}` : ''}. Журнал: journalctl -u sozvon-backup -n 50`;
    else if (h.backup.ageHours > T.backupH) out.backup = `Последней резервной копии ${Math.floor(h.backup.ageHours)} ч — таймер sozvon-backup не срабатывает?`;
  }
  if (h.sfu?.enabled && h.sfu.wasReady && !h.sfu.ready) out.sfu = 'Сервер трансляций (SFU, mediasoup) остановился — трансляции идут напрямую между участниками';
  if (h.errors?.last5min >= T.burst) out.errors = `За 5 минут ${h.errors.last5min} ошибок сервера. Журнал: journalctl -u sozvon -n 100`;
  if (h.cert && Number.isFinite(h.cert.daysLeft) && h.cert.source !== 'self-signed' && h.cert.daysLeft < T.certDays) {
    out.cert = `Сертификат HTTPS${h.cert.host ? ` (${h.cert.host})` : ''} истекает через ${Math.max(0, Math.floor(h.cert.daysLeft))} дн. Проверьте certbot: systemctl list-timers | grep certbot`;
  }
  return out;
}

const host = () => process.env.SOZVON_DOMAIN || (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : os.hostname());

/** Одна проверка: новые проблемы → сообщение, исчезнувшие → «восстановлено». */
export function runChecks() {
  if (running) return running;
  running = (async () => {
    const h = await collectHealth({ fresh: true });
    const found = evaluate(h);
    const on = toggles();
    const sent = [];
    const cfg = telegramConfig();
    for (const a of ALERTS) {
      const problem = on[a.key] ? found[a.key] : null;
      const cur = state.active[a.key];
      if (problem && !cur) state.active[a.key] = { since: Date.now(), text: problem, notified: false };
      else if (problem && cur) cur.text = problem;
      else if (!problem && cur) {
        delete state.active[a.key];
        if (cur.notified && cfg.configured && on[a.key]) {
          const text = `✅ Astra (${host()}): восстановлено — ${a.title}`;
          try { await sendTelegram(text); sent.push({ key: a.key, kind: 'recovery' }); } catch (err) { state.lastError = err.message; console.warn('[alerts]', err.message); }
        }
      }
    }
    for (const a of ALERTS) {
      const cur = state.active[a.key];
      if (!cur || cur.notified || !cfg.configured) continue;
      try {
        await sendTelegram(`⚠️ Astra (${host()}): ${a.title}\n${cur.text}`);
        cur.notified = true;
        sent.push({ key: a.key, kind: 'alert' });
      } catch (err) { state.lastError = err.message; console.warn('[alerts]', err.message); }
    }
    state.lastRun = Date.now();
    saveState();
    return { at: state.lastRun, active: activeAlerts(), sent };
  })().finally(() => { running = null; });
  return running;
}

export function activeAlerts() {
  return Object.entries(state.active).map(([key, v]) => ({ key, title: ALERTS.find((a) => a.key === key)?.title || key, since: v.since, text: v.text, notified: !!v.notified }));
}

export function alertsInfo() {
  const cfg = telegramConfig();
  return {
    telegram: { configured: cfg.configured, source: cfg.source },
    alerts: ALERTS.map((a) => ({ ...a, enabled: toggles()[a.key] })),
    active: activeAlerts(),
    lastRun: state.lastRun,
    lastError: state.lastError,
    intervalMs: intervalMs(),
  };
}

function intervalMs() {
  const v = num(process.env.ALERT_INTERVAL_MS, 300_000);
  return v <= 0 ? 0 : Math.max(1000, v);
}

export function initAlerts(dir) {
  dataDir = dir;
  const s = readJson(stateFile());
  if (s && typeof s === 'object') state = { active: {}, lastRun: null, ramHigh: 0, lastError: null, ...s };
  const every = intervalMs();
  if (!every) return;
  const first = Math.min(every, num(process.env.ALERT_FIRST_DELAY_MS, 90_000));
  const tick = () => runChecks().catch((err) => console.warn('[alerts] Проверка не удалась:', err.message));
  setTimeout(() => {
    tick();
    timer = setInterval(tick, every);
    timer.unref();
  }, first).unref();
}
