// DJ Бот — отдельный процесс. Запуск: npm run bot
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { Player, fmtTime, trackLabel, IDLE_LEAVE_MS } from './player.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const SERVER_URL = (process.env.BOT_SERVER_URL || 'https://localhost:3000').replace(/\/+$/, '');
const TOKEN_FILE = path.join(DATA_DIR, 'bot-token.txt');

function readToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

// ---------- REST (с самоподписанным сертификатом) ----------
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function api(method, pathname, body, { timeoutMs = 15_000 } = {}) {
  const url = new URL(pathname, SERVER_URL + '/');
  const isHttps = url.protocol === 'https:';
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(url, {
      method,
      agent: isHttps ? httpsAgent : undefined,
      headers: {
        authorization: `Bot ${currentToken}`,
        accept: 'application/json',
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) resolve(json);
        else reject(new Error(json?.error || `Сервер ответил ${res.statusCode}`));
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('сервер не ответил вовремя')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- поиск по библиотеке ----------
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function fileNameOf(track) {
  try { return decodeURIComponent(track.url.split('/').pop() || ''); } catch { return ''; }
}

export function searchTracks(tracks, query) {
  const q = norm(query);
  if (!q) return null;
  const tokens = q.split(' ');
  let best = null;
  let bestScore = 0;
  for (const t of tracks) {
    const title = norm(t.title);
    const hay = `${title} ${norm(t.artist)} ${norm(fileNameOf(t))}`;
    let score = 0;
    if (title === q) score = 100;
    else if (`${norm(t.artist)} ${title}` === q || norm(fileNameOf(t).replace(/\.[^.]+$/, '')) === q) score = 90;
    else if (hay.includes(q)) score = 60 + (title.includes(q) ? 10 : 0);
    else {
      const hit = tokens.filter((tok) => hay.includes(tok)).length;
      if (hit === tokens.length) score = 40;
      else if (hit > 0 && hit / tokens.length >= 0.5) score = 10 + hit;
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());

// ---------- сокет ----------
let currentToken = readToken();
const players = new Map(); // serverId -> Player

const socket = io(SERVER_URL, {
  auth: (cb) => { currentToken = readToken(); cb({ botToken: currentToken || '' }); },
  rejectUnauthorized: false,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10_000,
  transports: ['websocket', 'polling'],
});

function getPlayer(serverId) {
  let p = players.get(serverId);
  if (!p) {
    p = new Player(serverId, {
      emitState: (state) => socket.emit('bot:music-state', state),
      joinVoice: (channelId) => socket.emit('bot:voice-join', { channelId }),
      leaveVoice: (channelId) => socket.emit('bot:voice-leave', { channelId }),
      onIdleLeave: (pl) => say(pl.textChannelId, `💤 ${Math.max(1, Math.round(IDLE_LEAVE_MS / 60000))} мин. тишины — я пошёл отдыхать. Позовёте снова: !play <трек> 🎵`),
    });
    players.set(serverId, p);
  }
  return p;
}

function say(channelId, content) {
  if (channelId && content) socket.emit('bot:say', { channelId, content });
}

const HELP = [
  '🎵 Команды DJ Бота:',
  '!play <название | исполнитель | ссылка> — включить или добавить в очередь',
  '!play — продолжить после паузы',
  '!pause / !resume — пауза / продолжить',
  '!skip — следующий трек',
  '!np — что сейчас играет',
  '!queue — очередь',
  '!remove <номер> — убрать трек из очереди',
  '!shuffle — перемешать очередь',
  '!stop — остановить, очистить очередь и выйти',
  '!leave — выйти из голосового канала',
  '!help — эта подсказка',
  'Треки берутся из библиотеки (кнопка «Библиотека» в плеере) — туда можно загрузить свои файлы.',
].join('\n');

function nowPlayingText(p) {
  if (!p.current) return '🔇 Сейчас ничего не играет. Включи что-нибудь: !play <трек>';
  const pos = fmtTime(p.elapsed());
  const dur = p.current.duration ? fmtTime(p.current.duration) : '?:??';
  return `${p.paused ? '⏸ На паузе' : '🎵 Сейчас играет'}: ${trackLabel(p.current)} [${pos} / ${dur}]` +
    (p.current.addedBy ? ` · поставил(а) ${p.current.addedBy}` : '');
}

function queueText(p) {
  if (!p.current && !p.queue.length) return '📭 Очередь пуста. Добавь трек: !play <название>';
  const lines = [nowPlayingText(p)];
  if (p.queue.length) {
    lines.push('', `📜 В очереди (${p.queue.length}):`);
    p.queue.slice(0, 15).forEach((t, i) => lines.push(`${i + 1}. ${trackLabel(t)} (${fmtTime(t.duration)})`));
    if (p.queue.length > 15) lines.push(`…и ещё ${p.queue.length - 15}`);
  } else lines.push('Дальше в очереди пусто.');
  return lines.join('\n');
}

async function handleCommand(cmd) {
  const { command, username, serverId, textChannelId, voiceChannelId } = cmd;
  const args = String(cmd.args || '').trim();
  const p = getPlayer(serverId);
  if (textChannelId) p.textChannelId = textChannelId;
  const reply = (text) => say(textChannelId, text);

  // команды без голосового канала
  if (command === 'help') return reply(HELP);
  if (command === 'np') return reply(nowPlayingText(p));
  if (command === 'queue') return reply(queueText(p));

  const known = ['play', 'skip', 'stop', 'pause', 'resume', 'remove', 'shuffle', 'leave'];
  if (!known.includes(command)) return reply(`🤔 Не знаю команду !${command}. Напиши !help — там всё, что я умею.`);

  if (!voiceChannelId) return reply(`🎧 ${username}, зайди в голосовой канал — тогда я смогу включить музыку.`);
  if (p.active && p.voiceChannelId !== voiceChannelId && p.busy) {
    return reply('🎵 Я уже играю в другом голосовом канале этого сервера. Заходи туда или останови меня там: !stop');
  }

  switch (command) {
    case 'play': {
      if (!args) {
        if (p.paused && p.voiceChannelId === voiceChannelId) { p.resume(); return reply(`▶️ Продолжаю: ${trackLabel(p.current)}`); }
        if (p.current) return reply(nowPlayingText(p));
        return reply('🎵 Что включить? Напиши: !play <название, исполнитель или ссылка>');
      }
      let track;
      if (isUrl(args)) {
        reply('⏳ Загружаю трек по ссылке, это может занять немного времени…');
        try {
          ({ track } = await api('POST', '/api/music/import', { url: args, addedBy: username }, { timeoutMs: 11 * 60_000 }));
        } catch (err) {
          return reply(`😕 Не получилось загрузить трек: ${err.message}`);
        }
      } else {
        let tracks;
        try { ({ tracks } = await api('GET', '/api/music')); } catch (err) {
          return reply(`😕 Не могу открыть библиотеку: ${err.message}`);
        }
        if (!tracks.length) return reply('📭 Библиотека пуста. Загрузите треки через кнопку «Библиотека» в плеере или положите файлы в папку data/music.');
        track = searchTracks(tracks, args);
        if (!track) return reply(`🔍 Ничего не нашёл по запросу «${args.slice(0, 100)}». Загляни в библиотеку или попробуй другое название.`);
      }
      const item = { ...track, addedBy: username };
      p.join(voiceChannelId);
      const pos = p.enqueue(item);
      return reply(pos === 0
        ? `🎵 Включаю: ${trackLabel(item)} (${fmtTime(item.duration)}) — для ${username}`
        : `🎵 Добавил в очередь: ${trackLabel(item)} — позиция ${pos}`);
    }
    case 'skip': {
      if (!p.current) return reply('🔇 Сейчас ничего не играет — нечего пропускать.');
      const skipped = p.current;
      const nxt = p.next();
      return reply(`⏭ Пропускаю ${trackLabel(skipped)}.` + (nxt ? ` Дальше: ${trackLabel(nxt)} 🎵` : ' Очередь закончилась.'));
    }
    case 'pause':
      if (!p.current) return reply('🔇 Сейчас ничего не играет.');
      if (!p.pause()) return reply('⏸ Уже на паузе. Продолжить: !resume');
      return reply(`⏸ Пауза: ${trackLabel(p.current)}. Продолжить: !resume`);
    case 'resume':
      if (!p.current) return reply('🔇 Сейчас ничего не играет. Включи: !play <трек>');
      if (!p.resume()) return reply('▶️ И так играет 🎵');
      return reply(`▶️ Продолжаю: ${trackLabel(p.current)}`);
    case 'remove': {
      const n = Number.parseInt(args, 10);
      if (!p.queue.length) return reply('📭 Очередь пуста — удалять нечего.');
      const removed = p.remove(n);
      if (!removed) return reply(`🔢 Укажи номер от 1 до ${p.queue.length}: !remove <номер> (номера — в !queue)`);
      return reply(`🗑 Убрал из очереди: ${trackLabel(removed)}`);
    }
    case 'shuffle': {
      if (p.queue.length < 2) return reply('🔀 В очереди меньше двух треков — перемешивать нечего.');
      p.shuffle();
      return reply(`🔀 Перемешал очередь (${p.queue.length} ${plural(p.queue.length, 'трек', 'трека', 'треков')})`);
    }
    case 'stop':
      if (!p.active) return reply('🔇 Я и так не играю.');
      p.stop();
      return reply('⏹ Остановил музыку и очистил очередь. До встречи! 👋');
    case 'leave':
      if (!p.active) return reply('👋 Меня и так нет в голосовом канале.');
      p.stop();
      return reply('👋 Выхожу из голосового канала. Позовёте — вернусь: !play <трек> 🎵');
    default:
      return undefined;
  }
}

socket.on('connect', () => {
  console.log(`[bot] 🎵 DJ Бот подключён к ${SERVER_URL}`);
  // после переподключения сервер нас «забыл» — начинаем с чистого листа
  for (const p of players.values()) p.reset();
});

socket.on('disconnect', (reason) => {
  console.log(`[bot] Отключён (${reason}). Переподключаюсь…`);
  for (const p of players.values()) p.reset();
  if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 3000);
});

socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') {
    console.error(`[bot] Сервер не принял токен бота. Проверьте ${TOKEN_FILE} или переменную BOT_TOKEN (DATA_DIR у бота и сервера должен совпадать). Повтор через 5 с…`);
    // после отказа middleware socket.io сам не переподключается
    setTimeout(() => { if (!socket.connected) socket.connect(); }, 5000);
  } else {
    console.error(`[bot] Не могу подключиться к ${SERVER_URL}: ${err.message}. Сервер запущен? Повторяю…`);
  }
});

socket.on('bot:command', (cmd) => {
  if (!cmd || typeof cmd.serverId !== 'string' || typeof cmd.command !== 'string') return;
  console.log(`[bot] ${cmd.username}: !${cmd.command} ${cmd.args || ''}`.trim());
  handleCommand(cmd).catch((err) => {
    console.error('[bot] Ошибка команды:', err);
    say(cmd.textChannelId, '😵 Что-то пошло не так. Попробуй ещё раз.');
  });
});

socket.on('bot:voice-empty', ({ channelId } = {}) => {
  for (const p of players.values()) {
    if (p.voiceChannelId === channelId) {
      const wasPlaying = p.busy;
      p.stop();
      if (wasPlaying) say(p.textChannelId, '👋 В голосовом канале никого не осталось — выключаю музыку.');
    }
  }
  // на всякий случай убираем бота, даже если плеер про канал не знал
  socket.emit('bot:voice-leave', { channelId });
});

if (!currentToken) {
  console.log(`[bot] Токен пока не найден (${TOKEN_FILE}). Запустите сервер (npm start) — бот подключится, как только токен появится.`);
}

function shutdown() {
  console.log('\n[bot] Выключаюсь…');
  for (const p of players.values()) p.stop();
  setTimeout(() => { socket.close(); process.exit(0); }, 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
