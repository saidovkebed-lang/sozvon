// Полный аудит: музыкальный бот — пограничные случаи команд и кнопок плеера (бот — дочерний процесс). owner: qa
import { test, expect } from '@playwright/test';
import { ack, makeUser, createServer, textChannel, voiceChannel, waitEvent, startBot, sleep } from './fixtures/api.js';

const opened = [];
test.afterEach(() => { for (const u of opened.splice(0)) u.socket?.close(); });

test.describe('audit: музыкальный бот — пограничные случаи', () => {
  let bot;
  test.beforeAll(async () => { bot = await startBot(); });
  test.afterAll(async () => { await bot?.stop(); });

  async function room({ join = true } = {}) {
    const a = await makeUser('dj'); opened.push(a);
    const srv = await createServer(a);
    const ch = textChannel(srv); const vc = voiceChannel(srv);
    if (join) await ack(a.socket, 'voice:join', { channelId: vc.id });
    const say = async (content, re) => {
      const p = waitEvent(a.socket, 'message:new', (d) => d.message?.author?.isBot && d.message.channelId === ch.id && (!re || re.test(d.message.content)), 10000);
      await ack(a.socket, 'message:send', { channelId: ch.id, content });
      return (await p).message.content;
    };
    return { a, srv, ch, vc, say };
  }

  test('!play вне голосового канала → «Зайди в голосовой канал»; music:command вне голоса — тоже', async () => {
    const { a, say } = await room({ join: false });
    expect(await say('!play 440')).toMatch(/зайди в голосовой/i);
    const r = await ack(a.socket, 'music:command', { command: 'skip' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/зайди в голосовой/i);
  });

  test('!remove вне диапазона, !skip/!pause на пустой очереди, команды в ВЕРХНЕМ регистре', async () => {
    const { say } = await room();
    expect(await say('!skip')).toMatch(/\S/);
    expect(await say('!pause')).toMatch(/\S/);
    expect(await say('!remove 5')).toMatch(/нет|номер|очеред|пуст/i);
    await say('!PLAY 440', /440/);
    expect(await say('!remove 0')).toMatch(/нет|номер|пуст/i);
    expect(await say('!remove abc')).toMatch(/нет|номер|пуст/i);
    expect(await say('!NP', /440/)).toBeTruthy();
  });

  test('быстрые повторные «skip» кнопкой плеера: очередь не «проскакивает» больше, чем нажатий', async () => {
    test.setTimeout(60_000);
    const { a, vc, say } = await room();
    for (const t of ['440', '660', '880']) await say(`!play ${t}`, new RegExp(t));
    const states = [];
    a.socket.on('music:state', (d) => { if (d.channelId === vc.id) states.push(d); });
    await Promise.all([ack(a.socket, 'music:command', { command: 'skip' }), ack(a.socket, 'music:command', { command: 'skip' })]);
    await sleep(1500);
    const last = states.at(-1);
    expect(last.track?.title || '', 'после двух skip играет третий трек').toMatch(/880/);
    expect(last.queue.length).toBe(0);
  });

  test('!stop: очередь очищена, бот вышел; кнопка pause/resume плеера; music:command с мусором', async () => {
    const { a, vc, say } = await room();
    await say('!play 440', /440/);
    const paused = waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && d.paused === true, 10000);
    expect((await ack(a.socket, 'music:command', { command: 'pause' })).ok).toBe(true);
    await paused;
    const resumed = waitEvent(a.socket, 'music:state', (d) => d.channelId === vc.id && d.paused === false, 10000);
    expect((await ack(a.socket, 'music:command', { command: 'resume' })).ok).toBe(true);
    await resumed;
    for (const bad of [{ command: 'rm -rf' }, { command: '' }, { command: 'play', args: { x: 1 } }, null]) {
      const r = await ack(a.socket, 'music:command', bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const gone = waitEvent(a.socket, 'voice:members', (d) => d.channelId === vc.id && !d.members.some((m) => m.isBot), 10000);
    await say('!stop');
    await gone;
  });

  test('бот перезапускается во время воспроизведения: клиенты получают bot:status offline→online, команды снова работают', async () => {
    test.setTimeout(60_000);
    const { a, say } = await room();
    await say('!play 440', /440/);
    const off = waitEvent(a.socket, 'bot:status', (d) => d.online === false, 10000);
    await bot.stop();
    await off;
    expect(await say('!np')).toMatch(/не запущен/);
    const on = waitEvent(a.socket, 'bot:status', (d) => d.online === true, 15000);
    bot = await startBot();
    await on;
    expect(await say('!play 660', /660/)).toBeTruthy();
  });
});
