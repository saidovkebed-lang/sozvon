// DJ Бот — отдельный процесс. Запуск: npm run bot
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { Player, fmtTime, trackLabel, IDLE_LEAVE_MS, MAX_FAILS_IN_ROW } from './player.js';

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
        else reject(Object.assign(new Error(json?.error || `Сервер ответил ${res.statusCode}`), { status: res.statusCode }));
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

export function searchTracks(tracks, query, minScore = 1) {
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
  return bestScore >= minScore ? best : null;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim()) || /^spotify:(playlist|album|track|user):\S+$/i.test(s.trim());
const SOURCE_RU = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', search: 'поиск' };
const DOWNLOAD_TIMEOUT_MS = 12 * 60_000; // сервер сам ограничивает yt-dlp (YTDLP_TIMEOUT_SEC), это — запас
const STRONG_MATCH = 40; // все слова запроса нашлись в библиотеке — иначе ищем в интернете

function fetchPending(item) {
  const { _p, loading, ...clean } = item; // eslint-disable-line no-unused-vars
  return api('POST', '/api/music/fetch', { item: clean, addedBy: item.addedBy }, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
    .then((r) => r.track);
}

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
      fetch: fetchPending,
      onTrackError: (pl, item, err, { gaveUp, dropped, hasNext }) => {
        console.warn(`[bot] Не скачался «${item.title}»: ${err.message}`);
        let text = `⚠️ Не получилось включить ${trackLabel(item)}: ${err.message}.`;
        if (gaveUp) {
          text += `\n⛔ Подряд не удалось включить ${MAX_FAILS_IN_ROW} ${plural(MAX_FAILS_IN_ROW, 'трек', 'трека', 'треков')} — похоже, источник недоступен с этого сервера.` +
            (dropped ? ` Убрал из очереди ещё ${dropped} не загруженных.` : '') +
            ' Попробуйте ссылку на SoundCloud; администратору — deploy/music-check.sh и docs/MUSIC.md.';
        } else {
          text += hasNext ? ' Включаю следующий.' : ' Очередь закончилась.';
        }
        say(pl.textChannelId, text);
      },
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
  '   ссылки: YouTube (видео, плейлист, Shorts), Spotify (плейлист, альбом, трек), SoundCloud (трек, сет)',
  '   не нашёл в библиотеке — ищу на YouTube/SoundCloud',
  '!play — продолжить после паузы',
  '!pause / !resume — пауза / продолжить',
  '!skip — следующий трек',
  '!np — что сейчас играет',
  '!queue — очередь',
  '!seek <1:23 | 83 | +10 | -10> — перемотать текущий трек',
  '!remove <номер> — убрать трек из очереди',
  '!move <откуда> <куда> — переставить трек в очереди',
  '!shuffle — перемешать очередь',
  '!stop — остановить, очистить очередь и выйти',
  '!leave — выйти из голосового канала',
  '!help — эта подсказка',
  'Свои файлы можно загрузить через кнопку «Библиотека» в плеере. Подробнее: docs/MUSIC.md',
].join('\n');

/** «1:23», «83», «+10», «-10», «1:02:03» → секунды (null — не разобрать) */
function parseSeek(arg, now = 0) {
  const m = String(arg || '').trim().match(/^([+-])?\s*(\d+(?::\d{1,2}){0,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const sec = m[2].split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
  if (!Number.isFinite(sec)) return null;
  if (m[1] === '+') return now + sec;
  if (m[1] === '-') return Math.max(0, now - sec);
  return sec;
}

function nowPlayingText(p) {
  if (!p.current && p.loading) return `⏳ Загружаю: ${trackLabel(p.loading)} — сейчас заиграет`;
  if (!p.current) return '🔇 Сейчас ничего не играет. Включи что-нибудь: !play <трек>';
  const pos = fmtTime(p.elapsed());
  const dur = p.current.duration ? fmtTime(p.current.duration) : '?:??';
  return `${p.paused ? '⏸ На паузе' : '🎵 Сейчас играет'}: ${trackLabel(p.current)} [${pos} / ${dur}]` +
    (p.current.addedBy ? ` · поставил(а) ${p.current.addedBy}` : '');
}

function queueText(p) {
  if (!p.current && !p.loading && !p.queue.length) return '📭 Очередь пуста. Добавь трек: !play <название>';
  const lines = [nowPlayingText(p)];
  if (p.queue.length) {
    lines.push('', `📜 В очереди (${p.queue.length}):`);
    p.queue.slice(0, 15).forEach((t, i) => lines.push(`${i + 1}. ${trackLabel(t)} (${fmtTime(t.duration)})${t.pending ? ' ⌛' : ''}`));
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

  const known = ['play', 'skip', 'stop', 'pause', 'resume', 'remove', 'move', 'seek', 'shuffle', 'leave'];
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
      const start = (track) => {
        const item = { ...track, addedBy: username };
        p.join(voiceChannelId);
        const pos = p.enqueue(item);
        return reply(pos === 0
          ? `🎵 Включаю: ${trackLabel(item)} (${fmtTime(item.duration)}) — для ${username}`
          : `🎵 Добавил в очередь: ${trackLabel(item)} — позиция ${pos}`);
      };
      const resolve = () => api('POST', '/api/music/resolve', { input: args, addedBy: username }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

      if (isUrl(args)) {
        reply('⏳ Разбираю ссылку и загружаю, это может занять немного времени…');
        let res;
        try { res = await resolve(); } catch (err) {
          return reply(`😕 Не получилось загрузить по ссылке: ${err.message}`);
        }
        if (res.track) {
          if (res.note === 'list') reply('ℹ️ Это видео из плейлиста — включаю только его. Весь плейлист: ссылка вида youtube.com/playlist?list=…');
          return start(res.track);
        }
        const items = (res.items || []).map((it) => ({ ...it, addedBy: username }));
        if (!items.length) return reply('📭 В плейлисте нет треков.');
        const pl = res.playlist || {};
        p.join(voiceChannelId);
        const startedNow = p.enqueueMany(items);
        if (pl.type === 'track' && items.length === 1) {
          return reply(`🎵 ${startedNow ? 'Включаю' : 'Добавил в очередь'}: ${trackLabel(items[0])} (Spotify) — ищу звук на YouTube/SoundCloud…`);
        }
        let text = `📜 Добавил в очередь ${items.length} ${plural(items.length, 'трек', 'трека', 'треков')} из «${pl.title || 'плейлист'}» (${SOURCE_RU[pl.source] || 'ссылка'})`;
        if (pl.truncated) {
          text += pl.total > items.length
            ? ` — всего в плейлисте ${pl.total}, взял первые ${items.length} (лимит MUSIC_PLAYLIST_LIMIT)`
            : ' — без ключей Spotify API видны только первые 100 треков плейлиста (см. docs/MUSIC.md)';
        }
        text += startedNow ? '. Первый трек загружается и сейчас заиграет 🎵' : '.';
        if (pl.source === 'spotify') text += '\nℹ️ Звук Spotify недоступен — каждый трек ищу на YouTube/SoundCloud перед воспроизведением.';
        return reply(text);
      }

      let tracks = [];
      let internet = false;
      try { ({ tracks, internet } = await api('GET', '/api/music')); } catch (err) {
        return reply(`😕 Не могу открыть библиотеку: ${err.message}`);
      }
      const strong = searchTracks(tracks, args, STRONG_MATCH);
      if (strong) return start(strong);
      const weak = searchTracks(tracks, args);
      if (!internet) {
        // yt-dlp на сервере нет — только библиотека (как раньше)
        if (weak) return start(weak);
        return reply(`🔍 Ничего не нашёл по запросу «${args.slice(0, 100)}». Загляни в библиотеку или попробуй другое название.` +
          (tracks.length ? '' : ' (Библиотека пуста: загрузите треки кнопкой «Библиотека» в плеере.)'));
      }
      reply('🔍 В библиотеке такого нет — ищу на YouTube/SoundCloud…');
      try {
        const res = await resolve();
        if (res.track) return start(res.track);
        return reply('🤔 По запросу нашёлся плейлист — пришлите на него ссылку.');
      } catch (err) {
        if (weak) return start(weak);
        if (err.status === 404) return reply(`🔍 Ничего не нашёл по запросу «${args.slice(0, 100)}» ни в библиотеке, ни в интернете.`);
        if (err.status === 503) {
          return reply(`🔍 Ничего не нашёл по запросу «${args.slice(0, 100)}» в библиотеке. Поиск в интернете недоступен: ${err.message}`);
        }
        return reply(`😕 Ничего не нашёл в библиотеке, а поиск в интернете не удался: ${err.message}`);
      }
    }
    case 'skip': {
      if (!p.current && !p.loading) return reply('🔇 Сейчас ничего не играет — нечего пропускать.');
      const skipped = p.current || p.loading;
      const nxt = p.next();
      return reply(`⏭ Пропускаю ${trackLabel(skipped)}.` +
        (nxt ? ` Дальше: ${trackLabel(nxt)}${nxt.pending ? ' (загружаю…)' : ''} 🎵` : ' Очередь закончилась.'));
    }
    case 'pause':
      if (!p.current && p.loading) return reply('⏳ Трек ещё загружается — поставить на паузу можно, когда заиграет.');
      if (!p.current) return reply('🔇 Сейчас ничего не играет.');
      if (!p.pause()) return reply('⏸ Уже на паузе. Продолжить: !resume');
      return reply(`⏸ Пауза: ${trackLabel(p.current)}. Продолжить: !resume`);
    case 'resume':
      if (!p.current) return reply('🔇 Сейчас ничего не играет. Включи: !play <трек>');
      if (!p.resume()) return reply('▶️ И так играет 🎵');
      return reply(`▶️ Продолжаю: ${trackLabel(p.current)}`);
    case 'seek': {
      if (!p.current && p.loading) return reply('⏳ Трек ещё загружается — перемотать можно, когда заиграет.');
      if (!p.current) return reply('🔇 Сейчас ничего не играет.');
      const sec = parseSeek(args, p.elapsed());
      if (sec === null) return reply('⏩ Укажи время: !seek 1:23, !seek 83, !seek +10 или !seek -10');
      const pos = p.seek(sec);
      return reply(`⏩ Перемотал ${trackLabel(p.current)} на ${fmtTime(pos) === '?:??' ? '0:00' : fmtTime(pos)}`);
    }
    case 'move': {
      if (p.queue.length < 2) return reply('📜 В очереди меньше двух треков — переставлять нечего.');
      const m = args.match(/^id:(\S+)\s+(\d+)$/);
      const from = m ? p.indexOfQid(m[1]) : Number.parseInt(args.split(/\s+/)[0], 10);
      const to = Number.parseInt(m ? m[2] : args.split(/\s+/)[1], 10);
      if (m && from === 0) return reply('⏳ Этот трек уже загружается и сейчас заиграет — его не переставить.');
      if (m && from === -1) return null; // элемент уже ушёл из очереди (сыграл/удалён) — молча
      const moved = p.move(from, to);
      if (!moved) return reply(`🔢 Укажи номера от 1 до ${p.queue.length}: !move <откуда> <куда> (номера — в !queue)`);
      return reply(`↕️ ${trackLabel(moved)} — теперь ${p.queue.indexOf(moved) + 1}-й в очереди`);
    }
    case 'remove': {
      const idm = args.match(/^id:(\S+)$/);
      if (idm) {
        const at = p.indexOfQid(idm[1]);
        if (at === -1) return null;
        if (at === 0) { // загружаемый сейчас — как !skip
          const skipped = p.loading;
          p.next();
          return reply(`🗑 Убрал из очереди: ${trackLabel(skipped)}`);
        }
        const removed = p.remove(at);
        return reply(`🗑 Убрал из очереди: ${trackLabel(removed)}`);
      }
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
