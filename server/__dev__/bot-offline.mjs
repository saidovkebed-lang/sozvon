// Бот играет → бот убит → слушатель получает bot:status false, music:state track:null, бот пропал из voice:members.
// node server/__dev__/bot-offline.mjs https://localhost:3311 <botPid>
import { io } from 'socket.io-client';
import https from 'node:https';

const [BASE, BOT_PID] = process.argv.slice(2);
const agent = new https.Agent({ rejectUnauthorized: false });
const api = (p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = https.request(new URL(p, BASE), { method: 'POST', agent, headers: { 'content-type': 'application/json' } }, (res) => {
    let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve(JSON.parse(buf)));
  });
  req.on('error', reject); req.write(data); req.end();
});
const waitFor = (s, ev, pred = () => true, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout ' + ev)), ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } };
  s.on(ev, h);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const u = await api('/api/register', { username: 'off_' + Math.random().toString(36).slice(2, 6), password: 'pass1234' });
const s = io(BASE, { auth: { token: u.token }, rejectUnauthorized: false, transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
const { server } = await emit(s, 'server:create', { name: 'Офлайн-тест' });
const text = server.channels[0], vch = server.channels[1];
await emit(s, 'voice:join', { channelId: vch.id });
const playing = waitFor(s, 'music:state', (d) => d.track);
await emit(s, 'message:send', { channelId: text.id, content: '!play синус' });
await playing; console.log('✔ играет');
const status = waitFor(s, 'bot:status', (d) => d.online === false);
const nul = waitFor(s, 'music:state', (d) => d.track === null && d.channelId === vch.id);
const mem = waitFor(s, 'voice:members', (d) => d.channelId === vch.id && !d.members.some((m) => m.isBot));
const pres = waitFor(s, 'presence', (d) => d.online === false);
process.kill(Number(BOT_PID), 'SIGKILL');
await status; console.log('✔ bot:status {online:false}');
await nul; console.log('✔ music:state track:null');
await mem; console.log('✔ бот убран из voice:members');
console.log('✔ presence бота:', JSON.stringify(await pres));
const sys = waitFor(s, 'message:new', (d) => d.message.system);
await emit(s, 'message:send', { channelId: text.id, content: '!skip' });
console.log('✔ system:', (await sys).message.content);
s.close(); process.exit(0);
