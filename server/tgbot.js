// Telegram-бот Astra: меню с кнопками, уведомления и ответы из Telegram, приглашения, безопасность.
// Клиент Bot API — server/telegram.js; привязка аккаунта и коды входа — server/tg2fa.js (обновления сначала
// идут туда: /start <токен>, кнопки ok:/no:), остальное — здесь.
//
// Меню: /start (для привязанных), /menu, «☰ Меню» (setMyCommands + кнопка меню чата). Навигация правит то же
// сообщение (editMessageText) с кнопкой «‹ Назад». Все callback_data короткие и непрозрачные; при каждом нажатии
// аккаунт заново определяется по чату (кнопку из чужого/пересланного сообщения не принять), права — заново.
//
// Уведомления: ЛС, упоминания и @everyone (те же события, что «Входящие»/push, server/realtime.js notifyUser) —
// в привязанный чат, если пользователь сейчас не в Astra (нет видимой вкладки; настраивается), не «Не беспокоить»
// и не на паузе (server/tg-settings.js). Ответ — reply на уведомление или «↩️ Ответить» и следующее сообщение:
// текст уходит от имени пользователя теми же проверками прав и лимитами, что и из приложения.
//
// Служебное (только для администратора экземпляра с выполненным требованием 2FA, server/admin/access.js; описано
// только здесь, в публичной документации его нет): «🛡 Управление сервером» — состояние, обновление и бэкап через
// root-помощника (файл-запрос с фиксированным словом, server/admin/update.js), проверка VPN, cookies YouTube
// файлом, уведомления о новых пользователях, /status /update /backup /vpn. Каждое действие — в журнал аудита.
// Если ADMIN_ALLOW_TG_2FA=0, доступ к чату вторым фактором не считается: меню откроется после кода из приложения.
import crypto from 'node:crypto';
import path from 'node:path';
import { db, save } from './db.js';
import { findUser, findServer, userServers, isMember } from './model.js';
import { PERMS, can } from './permissions.js';
import {
  botConfig, sendMessage, editMessageText, answerCallbackQuery, deleteMessage, setMyCommands, setChatMenuButton,
  downloadFile, TelegramError,
} from './telegram.js';
import {
  setUpdateHandler, setLinkedHook, handleTg2faUpdate, telegramAvailable, unlinkTelegramFromBot, kickPoller,
} from './tg2fa.js';
import { sendResetLink, handleResetCallback } from './pwreset.js';
import { notifySettings, updateNotifySettings, publicBase, urlButtonOk } from './tg-settings.js';
import { on as onEvent } from './events.js';
import { verifyUserTotp } from './totp.js';
import { isInstanceAdmin, requireAdmin2FA, admin2faRequired, adminAllowTg2fa, mustChangePassword, readJson, writeJsonAtomic } from './admin/access.js';
import { audit } from './admin/audit.js';
import { collectHealth, probeProxy } from './admin/health.js';
import { activeAlerts, telegramConfig as alertsConfig, sendTelegram as sendAlert } from './admin/alerts.js';
import { currentVersion, updateState, requestUpdate, UpdateError, backupRunState, backupStatusFile } from './admin/update.js';
import { cookiesStatus, cookiesTarget, validateCookies, writeCookies, MAX_COOKIES_BYTES } from './cookies.js';
import { probeYouTube } from './music-sources.js';

const envMs = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };
const STATE_POLL_MS = () => envMs('TGBOT_STATE_POLL_MS', 3000);
const CHECK_TIMEOUT_MS = () => envMs('TGBOT_CHECK_TIMEOUT_MS', 120_000);
const BATCH_MS = () => envMs('TGBOT_BATCH_MS', 60_000);
const AWAIT_MS = 10 * 60_000;
const RELAY_TTL_MS = 3 * 24 * 3600_000;
const RELAY_MAX = 3000;

let ctx = { dataDir: null, realtime: null };
const stateFile = () => path.join(ctx.dataDir, 'telegram-bot.json'); // ожидающие итоги обновления/бэкапа

/* ---------------- служебное ---------------- */
const nameOf = (u) => (u?.displayName ? `${u.displayName} (@${u.username})` : u?.username ? `@${u.username}` : 'Кто-то');
const shortName = (u) => u?.displayName || u?.username || 'Кто-то';
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const newRef = () => crypto.randomBytes(9).toString('base64url'); // 12 символов
const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const urlBtn = (text, url, style) => ({ text, url, ...(style ? { style } : {}) });
const back = (to = 'm') => btn('‹ Назад', to);
const fmtAgo = (ms) => {
  const h = (Date.now() - ms) / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} мин назад`;
  if (h < 48) return `${Math.round(h)} ч назад`;
  return `${Math.round(h / 24)} дн. назад`;
};
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)} %` : '?');
const mb = (b) => (Number.isFinite(b) ? `${Math.round(b / 1048576)} МБ` : '?');

/** Аккаунт, привязанный к личному чату (последний привязанный, если их несколько). */
function userForChat(chatId) {
  let best = null;
  for (const u of db.data.users) {
    if (u.isBot || u.tg2fa !== true || String(u.tgChatId) !== chatId) continue;
    if (!best || (u.tgLinkedAt || 0) > (best.tgLinkedAt || 0)) best = u;
  }
  return best;
}
const blocked = (u) => !!u?.instanceBan || mustChangePassword(u);

/** Доступно ли пользователю «Управление сервером»: 'ok' | 'code' (нужен код приложения) | null. */
const adminUnlocks = new Map(); // userId → до какого момента (после кода приложения, если Telegram не считается 2FA)
function adminGate(u) {
  if (!u || !isInstanceAdmin(u) || !requireAdmin2FA(u)) return null;
  if (!admin2faRequired() || adminAllowTg2fa()) return 'ok';
  return (adminUnlocks.get(u.id) || 0) > Date.now() ? 'ok' : 'code';
}

/* ---------------- отправка/правка ---------------- */
async function show(chatId, messageId, text, kb) {
  const extra = { reply_markup: { inline_keyboard: kb } };
  if (messageId) {
    try { return await editMessageText(chatId, messageId, text, extra); } catch (err) {
      if (/not modified/i.test(err.description || '')) return null;
      // старое/удалённое сообщение — пришлём новое
    }
  }
  return sendMessage(chatId, text, extra);
}
const say = (chatId, text, extra = {}) => sendMessage(chatId, text, extra).catch((err) => { console.warn('[tgbot]', err.message); return null; });

/* ---------------- меню ---------------- */
function unlinkedMenu() {
  const base = publicBase();
  const text = [
    '👋 Это бот Astra.',
    'Чтобы получать сюда уведомления, отвечать на сообщения, входить без пароля и сбрасывать пароль, привяжите аккаунт:',
    'Astra → «Настройки» → «Моя учётная запись» → «Двухфакторная защита» → «Привязать Telegram» (или «Уведомления» → «Telegram»).',
    'Откройте ссылку, которую покажет Astra, и нажмите «Start».',
  ].join('\n\n');
  const kb = [];
  if (urlButtonOk(base)) kb.push([urlBtn('🌐 Открыть Astra', base, 'primary')]);
  kb.push([btn('❓ Помощь', 'h')]);
  return { text: base && !urlButtonOk(base) ? `${text}\n\nAstra: ${base}` : text, kb };
}

function mainMenu(u) {
  const base = publicBase();
  const n = notifySettings(u);
  const paused = n.pauseUntil ? ` · ⏸ до ${new Date(n.pauseUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '';
  const text = `☰ Astra · ${u.username}${paused}\nВыберите действие:`;
  const kb = [
    [btn('💬 Уведомления', 'n'), btn('🔐 Безопасность', 's')],
    [btn('🎟 Пригласить друга', 'i', 'primary')],
    [...(urlButtonOk(base) ? [urlBtn('🌐 Открыть Astra', base)] : []), btn('❓ Помощь', 'h')],
  ];
  if (adminGate(u)) kb.push([btn('🛡 Управление сервером', 'a', 'primary')]);
  return { text, kb };
}

function helpMenu(linked) {
  const text = [
    '❓ Бот Astra умеет:',
    '• 💬 присылать личные сообщения и упоминания, пока вас нет в Astra; чтобы ответить — ответьте (reply) на уведомление или нажмите «↩️ Ответить» (только текст);',
    '• 🔐 сбросить пароль по одноразовой ссылке, выйти на всех устройствах, отвязать Telegram;',
    '• 🔓 входить в Astra без пароля — кнопкой «✅ Войти» здесь (включается в настройках Astra);',
    '• 🎟 давать ссылку-приглашение на ваш сервер.',
    '',
    'Команды: /menu — меню, /help — эта справка, /cancel — отменить ввод.',
  ].join('\n');
  return { text, kb: [[back(linked ? 'm' : 'u')]] };
}

const onOff = (v) => (v ? '✅' : '▫️');
function notifyMenu(u) {
  const n = notifySettings(u);
  const lines = ['💬 Уведомления в Telegram', 'Пересылать сюда:'];
  lines.push(`${onOff(n.dm)} личные сообщения`, `${onOff(n.mention)} упоминания @${u.username}`, `${onOff(n.everyone)} @everyone и @here`);
  lines.push(`${onOff(n.onlyAway)} только когда меня нет в Astra`);
  if (u.status === 'dnd') lines.push('', '⛔ У вас статус «Не беспокоить» — уведомления не приходят.');
  if (n.pauseUntil) lines.push('', `⏸ Пауза до ${new Date(n.pauseUntil).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
  lines.push('', 'То же — в Astra: «Настройки» → «Уведомления» → «Telegram».');
  const kb = [
    [btn(`${onOff(n.dm)} ЛС`, 'nt:dm'), btn(`${onOff(n.mention)} Упоминания`, 'nt:mention')],
    [btn(`${onOff(n.everyone)} @everyone`, 'nt:everyone'), btn(`${onOff(n.onlyAway)} Только не в Astra`, 'nt:away')],
    n.pauseUntil ? [btn('▶️ Снять паузу', 'np:0', 'success')] : [btn('⏸ Пауза 1 ч', 'np:60'), btn('⏸ Пауза 8 ч', 'np:480')],
    [back()],
  ];
  return { text: lines.join('\n'), kb };
}

function securityMenu(u) {
  const lines = ['🔐 Безопасность', `Аккаунт: ${u.username}`,
    `Вход без пароля через Telegram: ${u.tgLogin === true ? 'включён' : 'выключен'}`,
    u.totpEnabled ? 'Приложение-аутентификатор: включено' : 'Приложение-аутентификатор: не подключено'];
  const kb = [
    [btn('🔑 Сбросить пароль', 'sr')],
    [btn('📱 Выйти на всех устройствах', 'so')],
    [u.tgLogin === true ? btn('🔓 Выключить вход без пароля', 'sp') : btn('🔓 Вход без пароля: как включить', 'si')],
    [btn('⛔ Отвязать Telegram', 'su', 'danger')],
    [back()],
  ];
  return { text: lines.join('\n'), kb };
}

function inviteMenu(u) {
  const list = userServers(u.id).filter((s) => can(s, u.id, PERMS.CREATE_INVITE)).slice(0, 12);
  if (!list.length) return { text: '🎟 Пригласить друга\nНет серверов, куда вы можете приглашать (нужно право «Создавать приглашения»).', kb: [[back()]] };
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((s) => btn(`🏠 ${cut(s.name, 28)}`, `iv:${s.id}`)));
  rows.push([back()]);
  return { text: '🎟 Пригласить друга\nВыберите сервер:', kb: rows };
}

function inviteResult(u, server) {
  const base = publicBase();
  const code = server.inviteCode;
  const link = base ? `${base}/invite/${code}` : null;
  const text = link
    ? [`🎟 Приглашение на «${server.name}»`, '', `Ссылка: ${link}`, `Код: ${code}`, '', 'Перешлите ссылку другу: он зарегистрируется в Astra и сразу окажется на сервере.'].join('\n')
    : [`🎟 Приглашение на «${server.name}»`, '', `Код: ${code}`, '', 'Друг открывает Astra → «+» (добавить сервер) → «Присоединиться» и вводит код.'].join('\n');
  const share = `Заходи ко мне в Astra на «${server.name}»${link ? '' : ` — код приглашения: ${code}`}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link || code)}&text=${encodeURIComponent(share)}`;
  return { text, kb: [[urlBtn('📤 Поделиться', shareUrl, 'primary')], [back('i')]] };
}

function adminMenu(u) {
  const text = ['🛡 Управление сервером', 'Действия записываются в журнал. Опасные — с подтверждением.'].join('\n');
  const kb = [
    [btn('📊 Состояние', 'as'), btn('🌐 Проверить VPN', 'av')],
    [btn('🔄 Обновить Astra', 'au', 'primary'), btn('💾 Бэкап сейчас', 'ab')],
    [btn('🍪 Cookies YouTube', 'ac'), btn(`👥 Новые: ${u.tgNewUsers === false ? 'выкл' : 'вкл'}`, 'an')],
    [btn('🔔 Тест уведомлений', 'at')],
    [back()],
  ];
  return { text, kb };
}

/* ---------------- состояние сервера (без секретов) ---------------- */
export async function statusText() {
  const h = await collectHealth();
  const v = h.version || {};
  const st = updateState();
  const lines = ['📊 Состояние Astra'];
  lines.push(`Версия: ${v.version || '?'}${v.short ? ` · ${v.short}` : ''}${v.branch ? ` (${v.branch})` : ''}`);
  const chk = st.check;
  if (chk?.error) lines.push('Обновления: проверка не удалась');
  else if (chk && Number.isFinite(chk.behind)) lines.push(chk.behind > 0 ? `Обновления: доступно (${chk.behind} нов. коммит.)` : 'Обновления: установлена последняя версия');
  else lines.push('Обновления: не проверялись');
  const disk = (h.system?.disks || []).filter((d) => Number.isFinite(d.pct)).map((d) => pct(d.pct));
  lines.push(`CPU: нагрузка ${h.system?.load?.[0] ?? '?'} (${h.system?.cpus ?? '?'} яд.) · RAM ${pct(h.system?.memory?.pct)} · Диск ${disk[0] || '?'}`);
  lines.push(`Процесс: ${mb(h.process?.rss)}, работает ${Math.round((h.process?.uptime || 0) / 3600)} ч`);
  const live = h.live || {};
  lines.push(`В сети: ${live.online ?? '?'} из ${live.users ?? '?'} · в голосе: ${live.voice ?? '?'} · трансляций: ${live.streams ?? '?'}`);
  lines.push(`VPN-прокси: ${!h.vpn?.configured ? 'не настроен' : h.vpn.ok ? `✅ работает (${h.vpn.ms} мс)` : `❌ ${h.vpn.error || 'ошибка'}`}`);
  const ck = h.music?.cookies;
  lines.push(`Cookies YouTube: ${!ck?.configured ? 'нет' : !ck.exists ? '❌ файл не читается' : `${ck.ageDays} дн.`}`);
  const b = h.backup;
  lines.push(`Бэкап: ${!b?.known ? 'нет данных' : `${b.ok ? '✅' : '❌'} ${b.at ? fmtAgo(b.at) : ''}`}`);
  lines.push(`Музыкальный бот: ${live.botOnline ? 'в сети' : 'не в сети'}`);
  const al = activeAlerts();
  if (al.length) lines.push('', '⚠️ Проблемы:', ...al.map((a) => `• ${a.title}`));
  return lines.join('\n');
}

/* ---------------- ожидание ввода (ответ, код, файл) ---------------- */
const awaiting = new Map(); // chatId → { kind: 'reply'|'unlink'|'cookies'|'admincode', userId, ref?, exp, after? }
function setAwait(chatId, data) { awaiting.set(chatId, { ...data, exp: Date.now() + AWAIT_MS }); }
function getAwait(chatId, u) {
  const a = awaiting.get(chatId);
  if (!a || a.exp <= Date.now() || a.userId !== u?.id) { awaiting.delete(chatId); return null; }
  return a;
}

/* ---------------- уведомления → Telegram ---------------- */
const relays = new Map(); // ref → { userId, chatId, channelId, exp }
const relayByMsg = new Map(); // `${chatId}:${messageId}` → ref
const relaySends = new Map(); // userId → [время…] — не больше 20 за 10 минут

function relayAllowed(userId) {
  const now = Date.now();
  const list = (relaySends.get(userId) || []).filter((t) => t > now - 10 * 60_000);
  if (list.length >= 20) { relaySends.set(userId, list); return false; }
  list.push(now);
  relaySends.set(userId, list);
  return true;
}

function attachmentNote(message) {
  const a = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!a.length) return '';
  const kind = a.every((x) => String(x.type).startsWith('image/')) ? 'фото' : a.every((x) => String(x.type).startsWith('video/')) ? 'видео' : 'файл';
  return `📎 Вложение: ${kind}${a.length > 1 ? ` (${a.length})` : ''} — откройте Astra`;
}

async function relayNotification(userId, n, message, { active }) {
  const u = findUser(userId);
  if (!u || u.isBot || u.tg2fa !== true || !u.tgChatId || blocked(u) || !telegramAvailable()) return;
  const s = notifySettings(u);
  const want = n.type === 'dm' ? s.dm : n.type === 'everyone' ? s.everyone : s.mention;
  if (!want || s.pauseUntil || u.status === 'dnd' || (s.onlyAway && active)) return;
  if (!relayAllowed(u.id)) return;
  const author = findUser(message.authorId);
  const body = cut(String(message.content || '').trim(), 1500);
  const head = n.type === 'dm'
    ? `💬 Личные сообщения · ${shortName(author)}`
    : `🔔 ${n.serverName || 'Сервер'} · #${n.channelName || 'канал'}`;
  const who = n.type === 'dm' ? null : `${shortName(author)}${n.type === 'everyone' ? ' (@everyone)' : ' упомянул(а) вас'}:`;
  const lines = [head, ...(who ? [who] : []), ...(body ? [body] : []), ...(attachmentNote(message) ? [attachmentNote(message)] : [])];
  lines.push('', '↩️ Ответьте на это сообщение, чтобы написать в Astra (только текст).');
  const ref = newRef();
  const chatId = String(u.tgChatId);
  relays.set(ref, { userId: u.id, chatId, channelId: n.channelId, exp: Date.now() + RELAY_TTL_MS });
  const base = publicBase();
  const openUrl = base ? `${base}/?c=${encodeURIComponent(n.channelId)}` : null;
  const kb = [[btn('↩️ Ответить', `rp:${ref}`, 'primary'), ...(urlButtonOk(openUrl) ? [urlBtn('🌐 Открыть', openUrl)] : [])]];
  try {
    const m = await sendMessage(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: kb } });
    if (m?.message_id) relayByMsg.set(`${chatId}:${m.message_id}`, ref);
  } catch (err) {
    relays.delete(ref);
    console.warn(`[tgbot] Уведомление не отправлено (${u.username}): ${err.message}`);
  }
  if (relays.size > RELAY_MAX) {
    const drop = relays.size - RELAY_MAX;
    let i = 0;
    for (const k of relays.keys()) { if (i++ >= drop) break; relays.delete(k); }
  }
}

function targetLabel(u, channelId) {
  const t = ctx.realtime?.describeTarget?.(u.id, channelId);
  if (!t) return null;
  return t.kind === 'dm' ? `ЛС с ${shortName(t.other)}` : `«${t.server.name}» · #${t.channel.name}`;
}

async function postReply(chatId, u, channelId, m) {
  if (typeof m.text !== 'string' || !m.text.trim()) {
    await say(chatId, '📝 Ответить из Telegram можно только текстом — фото и файлы отправьте в Astra.');
    return;
  }
  if (blocked(u)) { await say(chatId, '⛔ Не отправлено: аккаунт недоступен.'); return; }
  try {
    ctx.realtime.postAsUser(u.id, channelId, m.text);
    await say(chatId, `✅ Отправлено: ${targetLabel(u, channelId) || 'Astra'}`, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  } catch (err) {
    const msg = err instanceof ctx.realtime.WsError ? err.message : 'внутренняя ошибка';
    if (!(err instanceof ctx.realtime.WsError)) console.warn('[tgbot] Ответ из Telegram:', err);
    await say(chatId, `⛔ Не отправлено: ${msg}`);
  }
}

/* ---------------- новые пользователи → администраторам ---------------- */
const newcomers = new Map(); // userId → { registered, servers: [] }
let batchTimer = null;
function noteNewcomer(user, patch) {
  if (!user || user.isBot) return;
  const cur = newcomers.get(user.id) || { registered: false, servers: [] };
  if (patch.registered) cur.registered = true;
  if (patch.server && !cur.servers.includes(patch.server)) cur.servers.push(patch.server);
  newcomers.set(user.id, cur);
  if (!batchTimer) { batchTimer = setTimeout(flushNewcomers, BATCH_MS()); batchTimer.unref?.(); }
}
async function flushNewcomers() {
  batchTimer = null;
  const items = [...newcomers.entries()];
  newcomers.clear();
  if (!items.length || !telegramAvailable()) return;
  const admins = db.data.users.filter((a) => a.tg2fa === true && a.tgChatId && a.tgNewUsers !== false && adminGate(a));
  for (const a of admins) {
    const lines = [];
    for (const [uid, it] of items) {
      if (uid === a.id) continue;
      const u = findUser(uid);
      if (!u) continue;
      const where = it.servers.map((sid) => findServer(sid)).filter(Boolean).map((s) => `«${s.name}»`);
      const what = it.registered
        ? `зарегистрировался${where.length ? ` и зашёл на ${where.join(', ')} по приглашению` : ''}`
        : `зашёл на ${where.join(', ')} по приглашению`;
      if (!it.registered && !where.length) continue;
      lines.push(`• ${nameOf(u)} — ${what}`);
    }
    if (!lines.length) continue;
    const shown = lines.slice(0, 15);
    if (lines.length > shown.length) shown.push(`…и ещё ${lines.length - shown.length}`);
    const title = lines.length === 1 ? '🆕 Новый пользователь' : `🆕 Новые пользователи (${lines.length})`;
    await say(String(a.tgChatId), [title, ...shown].join('\n'));
  }
}

/* ---------------- обновление и бэкап: ожидание итога (переживает перезапуск сервера) ---------------- */
let pending = []; // [{ id, kind: 'update'|'backup', chatId, messageId, userId, since }]
const watching = new Set();
function savePending() { try { writeJsonAtomic(stateFile(), { pending }, 0o600); } catch (err) { console.warn('[tgbot] Не удалось сохранить состояние:', err.message); } }

function watchPending(p) {
  if (watching.has(p.id)) return;
  watching.add(p.id);
  const done = async (text) => {
    watching.delete(p.id);
    pending = pending.filter((x) => x.id !== p.id);
    savePending();
    await say(p.chatId, text);
  };
  const tick = async () => {
    if (!pending.some((x) => x.id === p.id)) { watching.delete(p.id); return; }
    if (Date.now() - p.since > 2 * 3600_000) { await done(`⌛ ${p.kind === 'update' ? 'Обновление' : 'Бэкап'}: итог так и не появился. Проверьте журнал: journalctl -u sozvon-self-update -n 50`); return; }
    try {
      if (p.kind === 'update') {
        const s = updateState().status;
        if (s && s.startedAt && s.startedAt >= p.since - 5000 && ['done', 'failed'].includes(s.state)) {
          if (s.state === 'done') await done(`✅ Обновлено до ${s.to || currentVersion().short || '?'}${s.from ? ` (было ${s.from})` : ''}. Astra перезапущена.`);
          else await done(`❌ Обновление не удалось (код ${s.exitCode ?? '?'}). Журнал: /var/lib/sozvon-state/update.log или sudo bash /opt/sozvon/deploy/update.sh`);
          return;
        }
      } else {
        const run = backupRunState();
        const bs = backupStatusFile();
        const at = Date.parse(bs?.time || '') || 0;
        if (run && run.startedAt >= p.since - 5000 && ['done', 'failed'].includes(run.state)) {
          if (bs && at >= p.since - 60_000 && bs.ok !== false) {
            await done(`✅ Бэкап готов: ${bs.file || '?'}${Number.isFinite(bs.size) ? ` (${mb(bs.size)})` : ''}${bs.telegram ? `\nTelegram: ${bs.telegram}` : ''}`);
          } else {
            await done(`❌ Бэкап не удался${bs?.error ? `: ${cut(bs.error, 300)}` : ` (код ${run.exitCode ?? '?'})`}. Журнал: journalctl -u sozvon-self-update -n 50`);
          }
          return;
        }
      }
    } catch (err) { console.warn('[tgbot] Итог запроса:', err.message); }
    setTimeout(tick, STATE_POLL_MS()).unref?.();
  };
  setTimeout(tick, STATE_POLL_MS()).unref?.();
}

function addPending(kind, chatId, messageId, userId) {
  const p = { id: newRef(), kind, chatId, messageId, userId, since: Date.now() };
  pending.push(p);
  savePending();
  watchPending(p);
  return p;
}

/** «Проверить обновления»: запрос check → ждём update-check.json новее запроса. */
async function runUpdateCheck(chatId, messageId) {
  const since = Date.now();
  requestUpdate('check');
  const until = since + CHECK_TIMEOUT_MS();
  while (Date.now() < until) {
    await new Promise((r) => { setTimeout(r, Math.min(STATE_POLL_MS(), 1000)).unref?.(); });
    const c = updateState().check;
    if (c?.checkedAt && c.checkedAt >= since - 1000 && !updateState().pending) return c;
  }
  return null;
}

/* ---------------- cookies YouTube файлом ---------------- */
async function receiveCookies(chatId, u, m) {
  const doc = m.document;
  const name = String(doc.file_name || 'cookies.txt').slice(0, 80);
  const finish = async (text, ok, extra = {}) => {
    deleteMessage(chatId, m.message_id).catch(() => {}); // файл с cookies не оставляем в чате
    audit(u, 'tgbot.cookies_upload', null, { ok, file: name, ...extra });
    await say(chatId, text);
  };
  if (Number(doc.file_size) > MAX_COOKIES_BYTES) return finish('❌ Файл больше 1 МБ — это не cookies.txt.', false, { error: 'too_big' });
  let buf;
  try { buf = await downloadFile(doc.file_id, { maxBytes: MAX_COOKIES_BYTES }); } catch (err) {
    return finish(err instanceof TelegramError && err.kind === 'too_big' ? '❌ Файл больше 1 МБ — это не cookies.txt.' : `❌ Не удалось скачать файл из Telegram: ${err.message}`, false, { error: err.kind || 'download' });
  }
  const v = validateCookies(buf);
  if (!v.ok) return finish(`❌ Файл не принят: ${v.error}.`, false, { error: 'invalid' });
  let where;
  try { where = writeCookies(v.text); } catch (err) { return finish(`❌ ${err.message}`, false, { error: 'write' }); }
  await say(chatId, `🍪 Cookies сохранены (${v.count} шт. для YouTube/Google). Проверяю YouTube…`);
  const probe = await probeYouTube();
  const note = process.env.YTDLP_COOKIES ? '' : `\nФайл: ${where} (используется автоматически, YTDLP_COOKIES не нужен).`;
  if (probe.ok) return finish(`✅ Cookies обновлены, YouTube работает.${note}`, true, { probe: 'ok' });
  return finish(`⚠️ Cookies сохранены, но проверка YouTube не прошла: ${cut(probe.error, 300)}${note}`, true, { probe: 'failed' });
}

/* ---------------- команды бота и кнопка меню ---------------- */
const BASE_COMMANDS = [
  { command: 'menu', description: '☰ Меню' },
  { command: 'help', description: 'Помощь' },
  { command: 'cancel', description: 'Отменить ввод' },
];
const ADMIN_COMMANDS = [
  { command: 'status', description: 'Состояние сервера' },
  { command: 'update', description: 'Обновить Astra' },
  { command: 'backup', description: 'Бэкап сейчас' },
  { command: 'vpn', description: 'Проверить VPN' },
];
let commandsSet = false;
let commandsTriedAt = 0;
async function setupCommands() {
  if (commandsSet || !telegramAvailable() || Date.now() - commandsTriedAt < 10 * 60_000) return;
  commandsTriedAt = Date.now();
  try {
    await setMyCommands(BASE_COMMANDS);
    await setChatMenuButton({ type: 'commands' });
    commandsSet = true;
    for (const a of db.data.users) if (a.tg2fa === true && a.tgChatId && adminGate(a)) await setupChatCommands(a);
  } catch (err) { console.warn('[tgbot] Команды бота не установлены:', err.message); }
}
async function setupChatCommands(u) {
  if (!u?.tgChatId) return;
  const admin = !!adminGate(u);
  await setMyCommands(admin ? [...BASE_COMMANDS, ...ADMIN_COMMANDS] : BASE_COMMANDS, { scope: { type: 'chat', chat_id: Number(u.tgChatId) || u.tgChatId } }).catch(() => {});
}

/* ---------------- /start-чаты для deploy/backup.sh setup (admin.sock: tg-chats) ---------------- */
const recentStarts = []; // [{ chatId, name, at }] — последние 15 минут, только в памяти
function noteStart(m) {
  const from = m.from || {};
  const name = (from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ')).slice(0, 64) || '?';
  const chatId = String(m.chat.id);
  const i = recentStarts.findIndex((x) => x.chatId === chatId);
  if (i >= 0) recentStarts.splice(i, 1);
  recentStarts.unshift({ chatId, name, at: Date.now() });
  recentStarts.length = Math.min(recentStarts.length, 10);
}
/** Для admin.sock (root): чаты, нажавшие /start за 15 минут, если backup.sh настраивает того же бота. */
export function startChatsFor(botHash) {
  const { token, configured } = botConfig();
  const own = configured ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
  if (!own || String(botHash || '') !== own) return { sameBot: false };
  const since = Date.now() - 15 * 60_000;
  return { sameBot: true, chats: recentStarts.filter((x) => x.at > since).map((x) => ({ chatId: x.chatId, name: x.name, at: x.at })) };
}

/* ---------------- обработка обновлений ---------------- */
const chatRate = new Map(); // chatId → { count, reset } — не больше 40 обновлений в минуту из одного чата
function chatAllowed(chatId) {
  const now = Date.now();
  const r = chatRate.get(chatId);
  if (!r || r.reset <= now) { chatRate.set(chatId, { count: 1, reset: now + 60_000 }); return true; }
  return ++r.count <= 40;
}

async function dispatch(u) {
  const m = u.message;
  if (m?.chat?.type === 'private' && typeof m.text === 'string' && /^\/start(@\w+)?(\s|$)/.test(m.text.trim())) noteStart(m);
  if (await handleTg2faUpdate(u)) return;
  setupCommands().catch(() => {});
  if (m) return onMessage(m);
  if (u.callback_query) return onCallback(u.callback_query);
  return undefined;
}

async function onMessage(m) {
  if (m?.chat?.type !== 'private' || !m.from || m.from.is_bot) return;
  const chatId = String(m.chat.id);
  if (String(m.from.id) !== chatId || !chatAllowed(chatId)) return;
  const u = userForChat(chatId);
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase() || (text === '☰ Меню' ? 'menu' : null);

  if (!u) {
    if (cmd === 'start' || cmd === 'menu') { const v = unlinkedMenu(); await show(chatId, null, v.text, v.kb).catch(() => {}); }
    else if (cmd === 'help') { const v = helpMenu(false); await show(chatId, null, v.text, v.kb).catch(() => {}); }
    return; // прочее от непривязанных — без ответа
  }

  // ответ (reply) на уведомление — всегда как текст в Astra
  const replyTo = m.reply_to_message?.message_id;
  const replyRef = replyTo ? relayByMsg.get(`${chatId}:${replyTo}`) : null;
  if (replyRef) {
    const r = relays.get(replyRef);
    if (r && r.userId === u.id && r.chatId === chatId && r.exp > Date.now()) { awaiting.delete(chatId); return postReply(chatId, u, r.channelId, m); }
    return say(chatId, '⌛ Это уведомление устарело — ответьте в Astra.');
  }

  const a = getAwait(chatId, u);
  if (cmd === 'cancel') { awaiting.delete(chatId); return say(chatId, a ? 'Отменено.' : 'Нечего отменять.'); }
  if (a && !cmd) {
    if (a.kind === 'reply') { awaiting.delete(chatId); return postReply(chatId, u, a.channelId, m); }
    if (a.kind === 'unlink') return unlinkWithCode(chatId, u, m);
    if (a.kind === 'admincode') return adminCode(chatId, u, m, a);
    if (a.kind === 'cookies' && m.document) { awaiting.delete(chatId); return withAdmin(chatId, u, () => receiveCookies(chatId, u, m)); }
  }
  if (cmd) awaiting.delete(chatId);
  // cookies документом без нажатия кнопки — только администратору и только похожий файл
  if (!cmd && m.document && /cookie/i.test(String(m.document.file_name || '')) && adminGate(u)) return withAdmin(chatId, u, () => receiveCookies(chatId, u, m));
  if (m.document || m.photo) return say(chatId, '📝 Здесь можно отправлять только текст. Меню: /menu');

  if (cmd === 'start' || cmd === 'menu') { const v = mainMenu(u); return show(chatId, null, v.text, v.kb).catch(() => {}); }
  if (cmd === 'help') { const v = helpMenu(true); return show(chatId, null, v.text, v.kb).catch(() => {}); }
  if (['status', 'update', 'backup', 'vpn'].includes(cmd)) {
    if (!adminGate(u)) return say(chatId, 'Команда недоступна.');
    const map = { status: 'as', update: 'au', backup: 'ab', vpn: 'av' };
    return withAdmin(chatId, u, () => adminAction(chatId, null, u, map[cmd]), map[cmd]);
  }
  if (cmd) return say(chatId, 'Неизвестная команда. Меню: /menu');
  return say(chatId, 'Чтобы ответить на сообщение из Astra, ответьте (reply) на уведомление. Меню: /menu');
}

async function unlinkWithCode(chatId, u, m) {
  const code = String(m.text || '').trim();
  deleteMessage(chatId, m.message_id).catch(() => {}); // код не оставляем в чате
  try {
    unlinkTelegramFromBot(u, code);
    awaiting.delete(chatId);
    audit(u, 'security.tg_unlinked_from_bot', { type: 'user', id: u.id, name: u.username });
  } catch (err) {
    if (err.code === 'totp_locked') awaiting.delete(chatId);
    await say(chatId, `⛔ ${err.message}. Попробуйте ещё раз или /cancel.`);
  }
}

async function adminCode(chatId, u, m, a) {
  const code = String(m.text || '').trim();
  deleteMessage(chatId, m.message_id).catch(() => {});
  if (!isInstanceAdmin(u) || !u.totpEnabled || !verifyUserTotp(u, code)) { await say(chatId, '⛔ Неверный код. Попробуйте ещё раз или /cancel.'); return; }
  awaiting.delete(chatId);
  adminUnlocks.set(u.id, Date.now() + 30 * 60_000);
  audit(u, 'tgbot.unlock', null, { method: 'totp' });
  if (a.after) await adminAction(chatId, null, u, a.after);
  else { const v = adminMenu(u); await show(chatId, null, v.text, v.kb); }
}

/** Действие администратора: с проверкой «нужен код приложения» (если Telegram не считается 2FA). */
async function withAdmin(chatId, u, fn, after = null) {
  const g = adminGate(u);
  if (!g) return say(chatId, 'Недоступно.');
  if (g === 'code') {
    setAwait(chatId, { kind: 'admincode', userId: u.id, after });
    return say(chatId, '🔐 Управление сервером: отправьте код из приложения-аутентификатора (сообщение с кодом бот удалит).');
  }
  return fn();
}

async function onCallback(q) {
  const chatId = String(q.message?.chat?.id ?? '');
  const answer = (text = '', alert = false) => answerCallbackQuery(q.id, text, alert ? { show_alert: true } : {}).catch(() => {});
  if (!chatId || q.message?.chat?.type !== 'private' || String(q.from?.id) !== chatId || !chatAllowed(chatId)) return answer('Недоступно');
  if (await handleResetCallback(q, chatId)) return undefined;
  const data = String(q.data || '');
  const mid = q.message.message_id;
  const u = userForChat(chatId);
  if (!u) {
    await answer();
    const v = data === 'h' ? helpMenu(false) : unlinkedMenu();
    return show(chatId, mid, v.text, v.kb).catch(() => {});
  }
  if (blocked(u)) return answer('Аккаунт недоступен', true);
  const render = async (v) => { await answer(); return show(chatId, mid, v.text, v.kb).catch((err) => console.warn('[tgbot]', err.message)); };

  if (data === 'm' || data === 'u') return render(mainMenu(u));
  if (data === 'h') return render(helpMenu(true));
  if (data === 'n') return render(notifyMenu(u));
  if (data === 's') return render(securityMenu(u));
  if (data === 'i') return render(inviteMenu(u));

  // уведомления
  let mm = data.match(/^nt:(dm|mention|everyone|away)$/);
  if (mm) {
    const key = mm[1] === 'away' ? 'onlyAway' : mm[1];
    updateNotifySettings(u, { [key]: !notifySettings(u)[key] });
    save();
    return render(notifyMenu(u));
  }
  mm = data.match(/^np:(0|60|480)$/);
  if (mm) {
    updateNotifySettings(u, { pauseMinutes: Number(mm[1]) });
    save();
    return render(notifyMenu(u));
  }

  // ответ на уведомление
  mm = data.match(/^rp:([A-Za-z0-9_-]{12})$/);
  if (mm) {
    const r = relays.get(mm[1]);
    if (!r || r.userId !== u.id || r.chatId !== chatId || r.exp <= Date.now()) return answer('Уведомление устарело — ответьте в Astra', true);
    setAwait(chatId, { kind: 'reply', userId: u.id, channelId: r.channelId });
    await answer();
    return say(chatId, `↩️ Напишите ответ одним сообщением (только текст) — он уйдёт в ${targetLabel(u, r.channelId) || 'Astra'}.\n/cancel — отмена.`);
  }

  // безопасность
  if (data === 'sr') {
    const r = sendResetLink(u, { source: 'bot' });
    if (r.ok) return answer('Ссылка для сброса пароля отправлена');
    const why = { limited: `Ссылку уже отправляли недавно — подождите ${r.wait} с`, locked: 'Временно недоступно (нажата «Это не я»)', no_url: 'На сервере не задан публичный адрес (PUBLIC_URL)', unavailable: 'Бот недоступен' }[r.why] || 'Недоступно';
    return answer(why, true);
  }
  if (data === 'so') return render({ text: '📱 Выйти на всех устройствах?\nВсе сеансы Astra (браузеры, приложения) будут завершены — войти снова можно паролем.', kb: [[btn('✅ Да, выйти везде', 'soy', 'danger')], [back('s')]] });
  if (data === 'soy') {
    const revoked = [];
    for (const [t, s] of Object.entries(db.data.sessions)) if (s.userId === u.id) { delete db.data.sessions[t]; revoked.push(t); }
    save();
    ctx.realtime?.disconnectSessions?.(u.id, revoked);
    audit(u, 'security.sessions_revoked_tg', { type: 'user', id: u.id, name: u.username }, { sessions: revoked.length });
    return render({ text: `✅ Готово: завершено сеансов — ${revoked.length}.`, kb: [[back('s')]] });
  }
  if (data === 'sp') {
    u.tgLogin = false;
    save();
    audit(u, 'security.tg_passwordless_off', { type: 'user', id: u.id, name: u.username }, { source: 'bot' });
    return render(securityMenu(u));
  }
  if (data === 'si') {
    return render({ text: '🔓 Вход без пароля через Telegram включается только в Astra (с вводом пароля): «Настройки» → «Уведомления» → «Telegram» → «Вход без пароля». Из бота его можно только выключить — так доступа к одному чату мало, чтобы войти в аккаунт.', kb: [[back('s')]] });
  }
  if (data === 'su') {
    setAwait(chatId, { kind: 'unlink', userId: u.id });
    return render({ text: '⛔ Отвязать Telegram?\nЧтобы подтвердить, отправьте сюда код восстановления (xxxxx-xxxxx) или код из приложения-аутентификатора — бот сразу удалит это сообщение.\nМожно и в Astra: «Настройки» → «Моя учётная запись» → «Двухфакторная защита» → «Отвязать».\n/cancel — отмена.', kb: [[back('s')]] });
  }

  // приглашения
  mm = data.match(/^iv:([A-Za-z0-9_-]{1,40})$/);
  if (mm) {
    const s = findServer(mm[1]);
    if (!s || !isMember(s, u.id) || !can(s, u.id, PERMS.CREATE_INVITE)) return answer('Нет доступа к этому серверу', true);
    return render(inviteResult(u, s));
  }

  // управление сервером
  if (/^a[a-z]*$/.test(data)) {
    if (!adminGate(u)) return answer('Недоступно', true);
    await answer();
    return withAdmin(chatId, u, () => adminAction(chatId, mid, u, data), data);
  }
  return answer('Кнопка устарела — откройте /menu');
}

async function adminAction(chatId, mid0, u, action) {
  let mid = mid0; // команда (/update) — первое сообщение новое, дальше правим его же
  const v = async (text, kb) => {
    const r = await show(chatId, mid, text, kb).catch((err) => { console.warn('[tgbot]', err.message); return null; });
    if (!mid && r?.message_id) mid = r.message_id;
    return r;
  };
  const back2 = [[back('a')]];
  switch (action) {
    case 'a': return v(adminMenu(u).text, adminMenu(u).kb);
    case 'as': {
      audit(u, 'tgbot.status');
      await v('📊 Собираю состояние…', back2);
      return v(await statusText(), [[btn('🔄 Обновить', 'as'), back('a')]]);
    }
    case 'av': {
      audit(u, 'tgbot.vpn_check');
      const p = await probeProxy();
      const text = !p.configured ? '🌐 VPN-прокси не настроен (SPOTIFY_PROXY / YTDLP_PROXY).'
        : p.ok ? `🌐 VPN-прокси работает: ${p.target} через ${p.proxy} за ${p.ms} мс.` : `🌐 ❌ VPN-прокси не отвечает (${p.error}). Проверка на сервере: sudo bash /opt/sozvon/deploy/vpn-proxy.sh --check`;
      return v(text, [[btn('🔄 Ещё раз', 'av'), back('a')]]);
    }
    case 'au': {
      audit(u, 'tgbot.update_check');
      const st = updateState();
      if (st.running) return v('🔄 Обновление уже идёт — дождитесь итога.', back2);
      await v('🔄 Проверяю обновления…', back2);
      let c;
      try { c = await runUpdateCheck(chatId, mid); } catch (err) {
        return v(`❌ ${err instanceof UpdateError ? err.message : 'Не удалось проверить обновления'}`, back2);
      }
      if (!c) return v('⌛ Проверка обновлений не ответила. Помощник установлен? sudo systemctl status sozvon-self-update.path', back2);
      if (c.error) return v(`❌ Проверка не удалась: ${cut(c.error, 300)}`, back2);
      if (!c.behind) return v(`✅ Установлена последняя версия (${(c.current || '').slice(0, 7) || currentVersion().short || '?'}).`, back2);
      const notes = (c.notes || []).slice(0, 8).map((n) => `• ${cut(n, 90)}`);
      return v([`🔄 Доступно новых коммитов: ${c.behind}`, ...notes, '', 'Во время обновления Astra перезапустится (около минуты).'].join('\n'),
        [[btn('✅ Обновить', 'auy', 'success')], [back('a')]]);
    }
    case 'auy': {
      try { requestUpdate('update'); } catch (err) { return v(`❌ ${err instanceof UpdateError ? err.message : 'Не удалось запустить обновление'}`, back2); }
      audit(u, 'tgbot.update', null, { from: currentVersion().short });
      addPending('update', chatId, mid, u.id);
      return v('⏳ Обновление запущено. Astra перезапустится; когда всё закончится, бот пришлёт итог.', back2);
    }
    case 'ab': return v('💾 Сделать резервную копию сейчас?\nКопия будет в /var/backups/sozvon (и в Telegram, если это настроено в backup.sh setup).', [[btn('✅ Сделать бэкап', 'aby', 'success')], [back('a')]]);
    case 'aby': {
      try { requestUpdate('backup'); } catch (err) { return v(`❌ ${err instanceof UpdateError ? err.message : 'Не удалось запустить бэкап'}`, back2); }
      audit(u, 'tgbot.backup');
      addPending('backup', chatId, mid, u.id);
      return v('⏳ Бэкап запущен — бот пришлёт итог.', back2);
    }
    case 'ac': {
      audit(u, 'tgbot.cookies_view');
      const c = cookiesStatus();
      const text = ['🍪 Cookies YouTube',
        !c.configured ? 'Файла нет — YouTube может требовать «подтвердите, что вы не бот».' : !c.exists ? `❌ Файл не читается (${c.error}).` : `Файл обновлён ${c.ageDays} дн. назад.`,
        '', 'Как обновить: в браузере войдите в YouTube, экспортируйте cookies расширением «Get cookies.txt LOCALLY» и отправьте файл сюда документом. Бот проверит его, сохранит и удалит сообщение с файлом.'].join('\n');
      return v(text, [[btn('🍪 Загрузить cookies', 'acu', 'primary')], [back('a')]]);
    }
    case 'acu': {
      setAwait(chatId, { kind: 'cookies', userId: u.id });
      return v(`🍪 Отправьте файл cookies.txt (Netscape, до 1 МБ) документом.\nСохраню в ${cookiesTarget()}.\n/cancel — отмена.`, back2);
    }
    case 'an': {
      u.tgNewUsers = u.tgNewUsers === false;
      save();
      audit(u, 'tgbot.newusers_toggle', null, { on: u.tgNewUsers });
      return v(adminMenu(u).text, adminMenu(u).kb);
    }
    case 'at': {
      audit(u, 'tgbot.test');
      await say(chatId, '🔔 Тестовое уведомление Astra: бот работает.');
      const ac = alertsConfig();
      let alerts = 'оповещения о проблемах сервера не настроены (ALERT_TELEGRAM_* / BACKUP_TELEGRAM_*)';
      if (ac.configured) {
        try { await sendAlert('🔔 Astra: тест канала оповещений о проблемах сервера.'); alerts = 'тест в канал оповещений отправлен'; } catch (err) { alerts = `канал оповещений: ${cut(err.message, 150)}`; }
      }
      return v(`🔔 Тест отправлен.\nТакже: ${alerts}.`, back2);
    }
    default: return v(adminMenu(u).text, adminMenu(u).kb);
  }
}

/* ---------------- запуск ---------------- */
export function initTelegramBot({ dataDir, realtime }) {
  ctx = { dataDir, realtime };
  const saved = readJson(stateFile());
  pending = Array.isArray(saved?.pending) ? saved.pending.filter((p) => p && typeof p.id === 'string' && ['update', 'backup'].includes(p.kind)) : [];
  for (const p of pending) watchPending(p); // обновление перезапустило сервер — допишем итог
  setUpdateHandler(dispatch);
  setLinkedHook(async (u) => {
    await setupChatCommands(u);
    const v = mainMenu(u);
    await show(String(u.tgChatId), null, `${v.text}\n\nСюда будут приходить личные сообщения и упоминания, пока вас нет в Astra (настройка — «💬 Уведомления»).`, v.kb).catch(() => {});
  });
  onEvent('notify', relayNotification);
  onEvent('registered', (u) => noteNewcomer(u, { registered: true }));
  onEvent('joined', (server, u) => noteNewcomer(u, { server: server.id }));
  setInterval(() => {
    const now = Date.now();
    for (const [k, r] of relays) if (r.exp <= now) relays.delete(k);
    for (const [k, ref] of relayByMsg) if (!relays.has(ref)) relayByMsg.delete(k);
    for (const [k, a] of awaiting) if (a.exp <= now) awaiting.delete(k);
    for (const [k, t] of adminUnlocks) if (t <= now) adminUnlocks.delete(k);
    for (const [k, r] of chatRate) if (r.reset <= now) chatRate.delete(k);
  }, 60_000).unref();
  if (telegramAvailable()) {
    setupCommands().catch(() => {});
    kickPoller();
  }
}
