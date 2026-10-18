// Полный аудит: все 19 прав по отдельности — «без права → отказ, роль с одним этим правом → можно».
// Уровень Socket.IO API, один независимый сервер на каждое право. owner: qa
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ack, textChannel, voiceChannel, waitEvent, http, sleep } from './fixtures/api.js';
import { MEDIA_DIR } from './fixtures/env.js';
import { P, DEFAULT_EVERYONE, guild, ok, denied, makeRole, viewOf, setEveryone, closeAll } from './fixtures/v3.js';

const opened = [];
test.afterEach(() => { closeAll(opened.splice(0)); });

/** owner + actor (кто проверяет право) + target (над кем действуют) */
async function setup() {
  const r = await guild(2, 'audit права');
  opened.push(...r.all);
  const [actor, target] = r.members;
  return { ...r, actor, target, tc: textChannel(r.srv), vc: voiceChannel(r.srv) };
}
async function grant(ctx, perm) {
  const role = await makeRole(ctx.owner, ctx.srv.id, { name: 'r' + perm, permissions: perm });
  await ok(ctx.owner.socket, 'member:roles', { serverId: ctx.srv.id, userId: ctx.actor.id, roleIds: [role.id] });
  return role;
}
async function uploadAttachment(user) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(MEDIA_DIR, 'qa-image.png'))], { type: 'image/png' }), 'p.png');
  const r = await http('POST', '/api/attachments', { token: user.token, body: fd });
  expect(r.status).toBe(200);
  return r.json;
}

// Для каждого права: before(ctx) — действие без права должно быть отклонено/не иметь эффекта;
// after(ctx) — то же действие с ролью, где только это право, проходит.
const CASES = {
  ADMINISTRATOR: {
    before: async (c) => {
      await denied(c.actor.socket, 'server:update', { serverId: c.srv.id, name: 'x' });
      await denied(c.actor.socket, 'member:kick', { serverId: c.srv.id, userId: c.target.id });
    },
    after: async (c) => {
      await ok(c.actor.socket, 'server:update', { serverId: c.srv.id, name: 'Админ переименовал' });
      await ok(c.actor.socket, 'channel:create', { serverId: c.srv.id, name: 'админский', type: 'text' });
      await ok(c.actor.socket, 'member:kick', { serverId: c.srv.id, userId: c.target.id });
      // но не удаление сервера/передача владения и не кик владельца
      await denied(c.actor.socket, 'server:delete', { serverId: c.srv.id });
      await denied(c.actor.socket, 'server:transfer', { serverId: c.srv.id, userId: c.actor.id });
      await denied(c.actor.socket, 'member:kick', { serverId: c.srv.id, userId: c.owner.id });
    },
  },
  MANAGE_SERVER: {
    before: async (c) => {
      await denied(c.actor.socket, 'server:update', { serverId: c.srv.id, description: 'x' });
      await denied(c.actor.socket, 'server:rename', { serverId: c.srv.id, name: 'x' });
    },
    after: async (c) => {
      await ok(c.actor.socket, 'server:update', { serverId: c.srv.id, description: 'Описание', regenerateInvite: true });
      await ok(c.actor.socket, 'server:rename', { serverId: c.srv.id, name: 'Новое имя' });
      await denied(c.actor.socket, 'channel:create', { serverId: c.srv.id, name: 'x', type: 'text' });
    },
  },
  MANAGE_ROLES: {
    before: async (c) => { await denied(c.actor.socket, 'role:create', { serverId: c.srv.id, name: 'x' }); },
    after: async (c) => {
      const r = await ok(c.actor.socket, 'role:create', { serverId: c.srv.id, name: 'младшая' });
      await ok(c.actor.socket, 'member:roles', { serverId: c.srv.id, userId: c.target.id, roleIds: [r.role.id] });
      // нельзя выдать роли право, которого нет у себя
      await denied(c.actor.socket, 'role:create', { serverId: c.srv.id, name: 'адм', permissions: P.ADMINISTRATOR });
      await denied(c.actor.socket, 'role:update', { serverId: c.srv.id, roleId: r.role.id, permissions: P.BAN_MEMBERS });
    },
  },
  MANAGE_CHANNELS: {
    before: async (c) => {
      await denied(c.actor.socket, 'channel:create', { serverId: c.srv.id, name: 'x', type: 'voice' });
      await denied(c.actor.socket, 'channel:update', { channelId: c.vc.id, name: 'x' });
      await denied(c.actor.socket, 'channel:delete', { channelId: c.vc.id });
    },
    after: async (c) => {
      const ch = (await ok(c.actor.socket, 'channel:create', { serverId: c.srv.id, name: 'новый', type: 'voice' })).channel;
      await ok(c.actor.socket, 'channel:update', { channelId: c.vc.id, name: 'Переименованный голос' });
      const v = await viewOf(c.target, c.srv.id);
      expect(v.channels.find((x) => x.id === c.vc.id).name).toBe('Переименованный голос');
      await ok(c.actor.socket, 'channel:delete', { channelId: ch.id });
    },
  },
  KICK_MEMBERS: {
    before: async (c) => { await denied(c.actor.socket, 'member:kick', { serverId: c.srv.id, userId: c.target.id }); },
    after: async (c) => {
      const removed = waitEvent(c.target.socket, 'server:removed', (d) => d.serverId === c.srv.id);
      await ok(c.actor.socket, 'member:kick', { serverId: c.srv.id, userId: c.target.id });
      expect(await removed).toMatchObject({ reason: 'kick' });
    },
  },
  BAN_MEMBERS: {
    before: async (c) => { await denied(c.actor.socket, 'member:ban', { serverId: c.srv.id, userId: c.target.id }); },
    after: async (c) => {
      await ok(c.actor.socket, 'member:ban', { serverId: c.srv.id, userId: c.target.id, reason: 'тест' });
      const code = (await viewOf(c.owner, c.srv.id)).inviteCode;
      await denied(c.target.socket, 'server:join', { inviteCode: code }, /заблокированы/);
      await ok(c.actor.socket, 'member:unban', { serverId: c.srv.id, userId: c.target.id });
      await ok(c.target.socket, 'server:join', { inviteCode: code });
    },
  },
  CREATE_INVITE: {
    everyoneWithout: true,
    before: async (c) => { expect((await viewOf(c.actor, c.srv.id)).inviteCode).toBeNull(); },
    after: async (c) => { expect((await viewOf(c.actor, c.srv.id)).inviteCode).toMatch(/^[a-z0-9]{8}$/); },
  },
  VIEW_CHANNEL: {
    everyoneWithout: true,
    before: async (c) => {
      const v = await viewOf(c.actor, c.srv.id);
      expect(v.channels.length, 'без VIEW_CHANNEL каналы не отдаются').toBe(0);
      await denied(c.actor.socket, 'message:history', { channelId: c.tc.id });
    },
    after: async (c) => {
      const v = await viewOf(c.actor, c.srv.id);
      expect(v.channels.length).toBe(2);
      await ok(c.actor.socket, 'message:history', { channelId: c.tc.id });
    },
  },
  SEND_MESSAGES: {
    everyoneWithout: true,
    before: async (c) => { await denied(c.actor.socket, 'message:send', { channelId: c.tc.id, content: 'hi' }); },
    after: async (c) => { await ok(c.actor.socket, 'message:send', { channelId: c.tc.id, content: 'hi' }); },
  },
  ATTACH_FILES: {
    everyoneWithout: true,
    before: async (c) => {
      const att = await uploadAttachment(c.actor);
      await denied(c.actor.socket, 'message:send', { channelId: c.tc.id, content: '', attachments: [att] });
    },
    after: async (c) => {
      const att = await uploadAttachment(c.actor);
      await ok(c.actor.socket, 'message:send', { channelId: c.tc.id, content: '', attachments: [att] });
    },
  },
  MANAGE_MESSAGES: {
    before: async (c) => {
      const m = (await ok(c.target.socket, 'message:send', { channelId: c.tc.id, content: 'чужое' })).message;
      c.msgId = m.id;
      await denied(c.actor.socket, 'message:delete', { messageId: m.id });
    },
    after: async (c) => { await ok(c.actor.socket, 'message:delete', { messageId: c.msgId }); },
  },
  MENTION_EVERYONE: {
    before: async (c) => {
      const m = (await ok(c.actor.socket, 'message:send', { channelId: c.tc.id, content: 'внимание @everyone' })).message;
      expect(m.mentionEveryone, 'без права @everyone не подсвечивается').toBeFalsy();
    },
    after: async (c) => {
      const m = (await ok(c.actor.socket, 'message:send', { channelId: c.tc.id, content: 'внимание @everyone' })).message;
      expect(m.mentionEveryone).toBe(true);
    },
  },
  CONNECT: {
    everyoneWithout: true,
    before: async (c) => { await denied(c.actor.socket, 'voice:join', { channelId: c.vc.id }); },
    after: async (c) => { await ok(c.actor.socket, 'voice:join', { channelId: c.vc.id }); },
  },
  SPEAK: {
    everyoneWithout: true,
    before: async (c) => {
      await ok(c.actor.socket, 'voice:join', { channelId: c.vc.id });
      const s = await viewVoice(c);
      expect(s.serverMute, 'без SPEAK — серверный mute').toBe(true);
      await ok(c.actor.socket, 'voice:leave');
    },
    after: async (c) => {
      await ok(c.actor.socket, 'voice:join', { channelId: c.vc.id });
      const s = await viewVoice(c);
      expect(s.serverMute).toBeFalsy();
    },
  },
  STREAM: {
    everyoneWithout: true,
    before: async (c) => {
      await ok(c.actor.socket, 'voice:join', { channelId: c.vc.id });
      c.actor.socket.emit('voice:state', { streaming: true, camera: true });
      await sleep(300);
      const s = await viewVoice(c);
      expect(s.streaming || s.camera).toBeFalsy();
    },
    after: async (c) => {
      c.actor.socket.emit('voice:state', { streaming: true });
      await expect.poll(async () => (await viewVoice(c)).streaming).toBe(true);
    },
  },
  MUTE_MEMBERS: {
    before: async (c) => {
      await ok(c.target.socket, 'voice:join', { channelId: c.vc.id });
      await denied(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, serverMute: true });
    },
    after: async (c) => {
      await ok(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, serverMute: true });
      await denied(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, serverDeafen: true });
      await denied(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, moveTo: null });
    },
  },
  DEAFEN_MEMBERS: {
    before: async (c) => {
      await ok(c.target.socket, 'voice:join', { channelId: c.vc.id });
      await denied(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, serverDeafen: true });
    },
    after: async (c) => {
      await ok(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, serverDeafen: true });
      await denied(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, serverMute: true });
    },
  },
  MOVE_MEMBERS: {
    before: async (c) => {
      await ok(c.target.socket, 'voice:join', { channelId: c.vc.id });
      await denied(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, moveTo: null });
    },
    after: async (c) => {
      const gone = waitEvent(c.owner.socket, 'voice:members', (d) => d.channelId === c.vc.id && !d.members.some((m) => m.userId === c.target.id));
      await ok(c.actor.socket, 'member:voice', { serverId: c.srv.id, userId: c.target.id, moveTo: null });
      await gone;
    },
  },
  USE_MUSIC_BOT: {
    everyoneWithout: true,
    before: async (c) => {
      await ok(c.actor.socket, 'voice:join', { channelId: c.vc.id });
      await denied(c.actor.socket, 'music:command', { command: 'queue' }, /Нет права/);
    },
    after: async (c) => {
      // бот в этом прогоне может быть офлайн — главное, что ошибка уже не про права
      const r = await ack(c.actor.socket, 'music:command', { command: 'queue' });
      if (!r.ok) expect(r.error).not.toMatch(/Нет права/);
    },
  },
};

async function viewVoice(c) {
  const b = await ack(c.owner.socket, 'bootstrap');
  return (b.voice[c.vc.id] || []).find((m) => m.userId === c.actor.id) || {};
}

test.describe('audit: каждое из 19 прав отдельно', () => {
  test('в матрице ровно 19 прав из контракта', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(P).sort());
  });
  for (const [name, cs] of Object.entries(CASES)) {
    test(`${name}: без права — отказ, с ролью — можно`, async () => {
      const c = await setup();
      const bit = P[name];
      // право, которое есть у @everyone по умолчанию, сначала снимаем
      if (cs.everyoneWithout) await setEveryone(c.owner, c.srv.id, DEFAULT_EVERYONE & ~bit);
      await cs.before(c);
      await grant(c, bit);
      await sleep(100);
      await cs.after(c);
    });
  }
});

test.describe('audit: иерархия и отказы', () => {
  test('модератор не действует на равного/старшего; не выдаёт роль не ниже своей; не кикает владельца', async () => {
    const r = await guild(2, 'иерархия'); opened.push(...r.all);
    const { srv, owner, members: [mod, peer] } = r;
    const role = await makeRole(owner, srv.id, { name: 'Мод', permissions: P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_ROLES | P.MUTE_MEMBERS });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: mod.id, roleIds: [role.id] });
    await ok(owner.socket, 'member:roles', { serverId: srv.id, userId: peer.id, roleIds: [role.id] });
    await denied(mod.socket, 'member:kick', { serverId: srv.id, userId: peer.id });
    await denied(mod.socket, 'member:ban', { serverId: srv.id, userId: peer.id });
    await denied(mod.socket, 'member:kick', { serverId: srv.id, userId: owner.id });
    await denied(mod.socket, 'member:ban', { serverId: srv.id, userId: owner.id });
    await denied(mod.socket, 'role:update', { serverId: srv.id, roleId: role.id, name: 'Я главный' });
    await denied(mod.socket, 'role:delete', { serverId: srv.id, roleId: role.id });
    // себе роль выше выдать нельзя
    const higher = await makeRole(owner, srv.id, { name: 'Выше', permissions: 0 });
    await ok(owner.socket, 'role:reorder', { serverId: srv.id, roleIds: [higher.id, role.id] });
    await denied(mod.socket, 'member:roles', { serverId: srv.id, userId: mod.id, roleIds: [role.id, higher.id] });
    // кик себя / бан себя / бан бота
    await denied(mod.socket, 'member:kick', { serverId: srv.id, userId: mod.id });
    await denied(mod.socket, 'member:ban', { serverId: srv.id, userId: mod.id });
  });

  test('отказ в правах: некорректные payload не роняют сервер (мусор → ok:false)', async () => {
    const r = await guild(1, 'мусор'); opened.push(...r.all);
    const { owner } = r;
    const junk = [null, 42, 'str', [], { serverId: {} }, { serverId: 'nope', userId: 1 }, { channelId: ['x'] }];
    for (const ev of ['server:update', 'server:rename', 'channel:create', 'channel:update', 'channel:delete', 'role:create',
      'role:update', 'role:delete', 'role:reorder', 'member:roles', 'member:kick', 'member:ban', 'member:unban', 'member:voice',
      'message:send', 'message:delete', 'message:history', 'voice:join', 'server:join', 'server:leave', 'server:transfer']) {
      for (const p of junk) {
        const res = await ack(owner.socket, ev, p);
        expect(res.ok, `${ev} ${JSON.stringify(p)}`).toBe(false);
        expect(res.error, `${ev} ${JSON.stringify(p)} — понятная ошибка, не «Внутренняя ошибка»`).not.toMatch(/Внутренняя ошибка/);
      }
    }
    // сервер жив
    await ok(owner.socket, 'bootstrap');
  });
});
