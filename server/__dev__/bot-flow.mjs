// Dev-проверка бота: очередь, skip, конец трека по таймеру, idle-выход, stop, remove/shuffle, import URL.
// node server/__dev__/bot-flow.mjs https://localhost:3311 http://127.0.0.1:8765/file.mp3
import { io } from 'socket.io-client';
import https from 'node:https';
import assert from 'node:assert/strict';

const BASE = process.argv[2];
const IMPORT_URL = process.argv[3];
const agent = new https.Agent({ rejectUnauthorized: false });
const api = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = https.request(new URL(p, BASE), { method, agent, headers: data ? { 'content-type': 'application/json' } : {} }, (res) => {
    let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve(JSON.parse(buf)));
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});
const connect = (token) => new Promise((res, rej) => {
  const s = io(BASE, { auth: { token }, rejectUnauthorized: false, transports: ['websocket'] });
  s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const waitFor = (s, ev, pred = () => true, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { s.off(ev, h); reject(new Error('timeout ' + ev)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } };
  s.on(ev, h);
});
const log = (...a) => console.log('✔', ...a);
const botSays = (s, re, ms) => waitFor(s, 'message:new', (d) => d.message.author.isBot && re.test(d.message.content), ms).then((d) => d.message.content);

const sfx = Math.random().toString(36).slice(2, 6);
const a = await api('POST', '/api/register', { username: 'dj_' + sfx, password: 'pass1234' });
const b = await api('POST', '/api/register', { username: 'lis_' + sfx, password: 'pass1234' });
const sa = await connect(a.token);
const sb = await connect(b.token);
const { server } = await emit(sa, 'server:create', { name: 'Музыка' });
await emit(sb, 'server:join', { inviteCode: server.inviteCode });
const text = server.channels.find((c) => c.type === 'text');
const vch = server.channels.find((c) => c.type === 'voice');
const send = (content) => emit(sa, 'message:send', { channelId: text.id, content });

// не в голосе
let r = botSays(sb, /голосовой канал/);
await send('!play short');
log('не в голосе →', await r);
r = botSays(sb, /Не знаю команду/); await send('!бубубу'); log('неизвестная →', await r);
r = botSays(sb, /Команды/); await send('!help'); log('!help ok');

await emit(sa, 'voice:join', { channelId: vch.id });
const jb = await emit(sb, 'voice:join', { channelId: vch.id });
assert.equal(jb.music, null);

r = botSays(sb, /Ничего не нашёл/); await send('!play несуществующийтрек'); log('не найдено →', await r);

r = botSays(sb, /Включаю/); await send('!play short'); log(await r);
r = botSays(sb, /очередь.*позиция 1/); await send('!play синус'); log(await r);
r = botSays(sb, /позиция 2/); await send('!play short'); log(await r);
r = botSays(sb, /позиция 3/); await send('!play тестовый'); log(await r);
r = botSays(sb, /Перемешал/); await send('!shuffle'); log(await r);
r = botSays(sb, /Убрал/); await send('!remove 3'); log(await r);
r = botSays(sb, /Укажи номер/); await send('!remove 9'); log('remove 9 →', await r);

// skip через кнопку плеера (music:command)
let st = waitFor(sb, 'music:state', (d) => d.track && d.queue.length === 1);
assert.ok((await emit(sb, 'music:command', { command: 'skip' })).ok);
st = await st; log('music:command skip → играет', st.track.title, 'в очереди', st.queue.length);

// skip до последнего, затем ждём конца по таймеру
await send('!skip');
st = await waitFor(sb, 'music:state', (d) => d.track && d.queue.length === 0);
log('последний трек:', st.track.title, st.track.duration + 'с');
const nul = waitFor(sb, 'music:state', (d) => d.track === null);
await send('!skip'); await nul;
const playing = waitFor(sb, 'music:state', (d) => d.track?.title === 'short');
await send('!play short'); await playing;
const t0 = Date.now();
const ended = await waitFor(sb, 'music:state', (d) => d.track === null, 30000);
log(`конец трека по таймеру через ${((Date.now() - t0) / 1000).toFixed(1)} с → track:null`, JSON.stringify(ended).slice(0, 80));

// idle (BOT_IDLE_MS=4000 в тесте) → бот выходит
const idle = botSays(sb, /тишины/, 15000);
const gone = waitFor(sb, 'voice:members', (d) => d.channelId === vch.id && !d.members.some((m) => m.isBot), 15000);
log('idle →', await idle); await gone; log('бот покинул канал после простоя');

// stop
r = botSays(sb, /Включаю/); await send('!play синус'); await r;
const cleared = waitFor(sb, 'music:state', (d) => d.track === null && d.queue.length === 0);
r = botSays(sb, /Остановил/); await send('!stop'); log(await r); await cleared; log('stop → state очищен');

// импорт по прямой ссылке
if (IMPORT_URL) {
  r = botSays(sb, /Включаю|Не получилось/, 30000);
  await send('!play ' + IMPORT_URL);
  log('import →', await r);
  r = botSays(sb, /Выхожу/); await send('!leave'); log(await r);
}

// бот уже в голосе, музыка играет → новый участник получает music в ack voice:join
r = botSays(sb, /Включаю/); await send('!play синус'); await r;
await emit(sb, 'voice:leave');
const rej = await emit(sb, 'voice:join', { channelId: vch.id });
assert.ok(rej.music?.track); assert.ok(rej.peers.some((p) => p.isBot)); log('voice:join ack: music.track =', rej.music.track.title, '; peers с ботом');
const boot = await emit(sb, 'bootstrap');
assert.ok(boot.music[vch.id].track); assert.ok(boot.voice[vch.id].some((m) => m.isBot)); log('bootstrap содержит music и бота в voice');

sa.close(); sb.close();
console.log('\nБОТ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(0);
