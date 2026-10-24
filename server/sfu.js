// SFU для трансляций экрана (mediasoup v3, в процессе сервера).
//
// Зачем: в mesh стример кодирует видео отдельно для каждого зрителя (N зрителей = N кодировщиков и N× исходящий
// канал). Через SFU стример отдаёт одну копию серверу, а сервер раздаёт её зрителям. Голос и камера остаются в mesh.
//
// Сеть: один порт UDP+TCP на всех (mediasoup WebRtcServer). TCP — для сетей, где UDP закрыт.
//   SFU=0                 — выключить (клиенты сами переходят на mesh, как раньше)
//   SFU_PORT=40000        — порт UDP и TCP (открыть в файрволе)
//   SFU_ANNOUNCED_IP=…    — внешний адрес сервера (по умолчанию — из PUBLIC_URL; без него — адрес в локальной сети)
//   SFU_LISTEN_IP=0.0.0.0 — на каком адресе слушать
// mediasoup — необязательная зависимость: если она не установилась (нет готового бинарника под систему),
// сервер работает как раньше, только на mesh.
import dns from 'node:dns/promises';
import net from 'node:net';
import { localIPv4 } from './certs.js';

const env = process.env;
const off = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  // H.264 — кодирует видеокарта у стримера; VP8 — запасной (есть везде)
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1 } },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];

const START_BITRATE = 2_500_000;   // стартовая оценка канала к зрителю (как x-google-start-bitrate в mesh)
const MAX_INCOMING = 12_000_000;   // потолок от стримера (самое высокое качество — 8 Мбит/с)
const MAX_CONSUMERS = 64;

/** Внешний адрес для ICE-кандидатов сервера */
async function announcedAddress({ share }) {
  if (env.SFU_ANNOUNCED_IP) return env.SFU_ANNOUNCED_IP.trim();
  let host = '';
  try { host = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).hostname : ''; } catch { /* ignore */ }
  host = host.replace(/^\[|\]$/g, '');
  if (host && net.isIP(host)) return host;
  if (host && host !== 'localhost') {
    try { return (await dns.lookup(host, { family: 4 })).address; } catch (e) { console.warn(`[sfu] Не удалось узнать IP ${host}: ${e.message}`); }
  }
  // --share: ссылка-туннель пробрасывает только HTTPS, порт SFU снаружи недоступен
  if (share) return null;
  return localIPv4()[0] || '127.0.0.1';
}

export function createSfu({ share = false } = {}) {
  let ms = null;        // модуль mediasoup
  let worker = null;
  let webRtcServer = null;
  let ready = false;
  let restarts = 0;
  let notify = null;    // (socketId, event, payload) — из realtime
  const rooms = new Map(); // channelId -> { router, peers: Map<socketId, Peer> }
  // Peer: { socketId, channelId, transports: Map, producers: Map, consumers: Map, viewers: number }

  async function start() {
    if (off(env.SFU)) { console.log('[sfu] Выключен (SFU=0): трансляции идут напрямую между участниками (mesh)'); return false; }
    try {
      ms = await import('mediasoup');
    } catch (e) {
      console.warn(`[sfu] mediasoup не установлен (${e.code || e.message}) — трансляции идут напрямую (mesh)`);
      return false;
    }
    const announced = await announcedAddress({ share });
    if (!announced) { console.log('[sfu] Режим --share без SFU_ANNOUNCED_IP: трансляции идут напрямую (mesh)'); return false; }
    const port = Number(env.SFU_PORT) || 40000;
    const ip = env.SFU_LISTEN_IP || '0.0.0.0';
    try {
      worker = await ms.createWorker({ logLevel: 'error' });
      worker.on('died', (err) => onDied(err));
      webRtcServer = await worker.createWebRtcServer({
        listenInfos: [
          { protocol: 'udp', ip, announcedAddress: announced, port },
          { protocol: 'tcp', ip, announcedAddress: announced, port },
        ],
      });
    } catch (e) {
      console.warn(`[sfu] Не удалось запустить (${e.message}) — трансляции идут напрямую (mesh)`);
      try { worker?.close(); } catch { /* ignore */ }
      worker = null; webRtcServer = null;
      return false;
    }
    ready = true;
    console.log(`[sfu] Трансляции экрана через сервер: ${announced}:${port} (UDP и TCP), mediasoup ${ms.version}`);
    return true;
  }

  function onDied(err) {
    console.error('[sfu] Процесс mediasoup упал:', err?.message || err);
    ready = false;
    worker = null; webRtcServer = null;
    for (const [, room] of rooms) for (const sid of room.peers.keys()) notify?.(sid, 'sfu:reset', {});
    rooms.clear();
    if (restarts++ < 5) setTimeout(() => { start().catch(() => {}); }, 3000 * restarts).unref?.();
  }

  // ---------- состояние комнат ----------
  async function roomFor(channelId) {
    let room = rooms.get(channelId);
    if (room) return room.ready;
    room = { peers: new Map(), router: null };
    rooms.set(channelId, room);
    room.ready = worker.createRouter({ mediaCodecs: MEDIA_CODECS }).then((router) => { room.router = router; return room; });
    try { return await room.ready; } catch (e) { rooms.delete(channelId); throw e; }
  }

  function closeRoomIfEmpty(channelId) {
    const room = rooms.get(channelId);
    if (!room || room.peers.size) return;
    rooms.delete(channelId);
    try { room.router?.close(); } catch { /* ignore */ }
  }

  /** Участник вышел из голосового канала (или отключился): закрыть всё его */
  function removePeer(socketId) {
    for (const [channelId, room] of rooms) {
      const peer = room.peers.get(socketId);
      if (!peer) continue;
      room.peers.delete(socketId);
      for (const t of peer.transports.values()) { try { t.close(); } catch { /* ignore */ } }
      // закрытие транспорта закрывает его producers/consumers → события ниже разошлют уведомления
      for (const [id, p] of peer.producers) { peer.producers.delete(id); producerGone(room, socketId, p); }
      recountAll(room);
      closeRoomIfEmpty(channelId);
    }
  }

  function producerGone(room, socketId, producer) {
    for (const sid of room.peers.keys()) if (sid !== socketId) notify?.(sid, 'sfu:producer-closed', { socketId, producerId: producer.id });
  }

  /** Сколько участников смотрит трансляцию стримера (активные consumers его видео) */
  function viewersOf(room, ownerId) {
    const owner = room.peers.get(ownerId);
    if (!owner) return 0;
    const ids = new Set([...owner.producers.values()].map((p) => p.id));
    let n = 0;
    for (const [sid, peer] of room.peers) {
      if (sid === ownerId) continue;
      if ([...peer.consumers.values()].some((c) => ids.has(c.producerId) && !c.paused && !c.closed)) n++;
    }
    return n;
  }

  function recount(room, ownerId) {
    const owner = room.peers.get(ownerId);
    if (!owner) return;
    const n = owner.producers.size ? viewersOf(room, ownerId) : 0;
    if (n === owner.viewers) return;
    owner.viewers = n;
    notify?.(ownerId, 'sfu:viewers', { count: n });
  }
  function recountAll(room) { for (const sid of room.peers.keys()) recount(room, sid); }

  /**
   * Socket.IO-обработчики для одного сокета.
   * ctx: { on, fail, socket, channelOf(): channelId|null, canStream(channelId): bool, members(channelId): socketId[] }
   */
  function attach(ctx) {
    const { on, fail, socket } = ctx;
    notify ||= (sid, ev, payload) => socket.nsp.to(sid).emit(ev, payload);

    /** Участник SFU, проверенный на членство в голосовом канале */
    function requirePeer() {
      if (!ready) fail('SFU недоступен');
      const channelId = ctx.channelOf();
      if (!channelId) fail('Вы не в голосовом канале');
      const room = rooms.get(channelId);
      const peer = room?.peers.get(socket.id);
      if (!peer || peer.channelId !== channelId) fail('Сначала sfu:join');
      return { room, peer, channelId };
    }
    const transportOf = (peer, id, dir) => {
      const t = typeof id === 'string' ? peer.transports.get(id) : null;
      if (!t || (dir && t.appData.direction !== dir)) fail('Транспорт не найден');
      return t;
    };

    on('sfu:join', async () => {
      if (!ready) fail('SFU недоступен');
      const channelId = ctx.channelOf();
      if (!channelId) fail('Вы не в голосовом канале');
      removePeer(socket.id); // переподключение / другой канал — начинаем с чистого листа
      const room = await roomFor(channelId);
      if (ctx.channelOf() !== channelId) { closeRoomIfEmpty(channelId); fail('Вы не в голосовом канале'); }
      room.peers.set(socket.id, { socketId: socket.id, channelId, transports: new Map(), producers: new Map(), consumers: new Map(), viewers: 0 });
      const producers = [];
      for (const [sid, p] of room.peers) {
        for (const pr of p.producers.values()) producers.push({ socketId: sid, producerId: pr.id, kind: pr.kind });
      }
      return { rtpCapabilities: room.router.rtpCapabilities, producers };
    });

    on('sfu:leave', () => { removePeer(socket.id); });

    on('sfu:transport', async ({ direction }) => {
      const { room, peer, channelId } = requirePeer();
      if (direction !== 'send' && direction !== 'recv') fail('Некорректное направление');
      if (direction === 'send' && !ctx.canStream(channelId)) fail('Нет права на демонстрацию экрана');
      for (const t of peer.transports.values()) if (t.appData.direction === direction) { t.close(); peer.transports.delete(t.id); }
      const t = await room.router.createWebRtcTransport({
        webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true,
        initialAvailableOutgoingBitrate: START_BITRATE,
        appData: { direction },
      });
      if (direction === 'send') await t.setMaxIncomingBitrate(MAX_INCOMING).catch(() => {});
      peer.transports.set(t.id, t);
      t.on('dtlsstatechange', (st) => { if (st === 'failed' || st === 'closed') { try { t.close(); } catch { /* ignore */ } } });
      t.observer.on('close', () => { peer.transports.delete(t.id); });
      return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
    });

    on('sfu:connect', async ({ transportId, dtlsParameters }) => {
      const { peer } = requirePeer();
      if (!dtlsParameters || typeof dtlsParameters !== 'object') fail('Нет параметров DTLS');
      await transportOf(peer, transportId).connect({ dtlsParameters });
    });

    on('sfu:produce', async ({ transportId, kind, rtpParameters }) => {
      const { room, peer, channelId } = requirePeer();
      if (!ctx.canStream(channelId)) fail('Нет права на демонстрацию экрана');
      if (kind !== 'audio' && kind !== 'video') fail('Некорректный тип');
      if (!rtpParameters || typeof rtpParameters !== 'object') fail('Нет параметров RTP');
      // одна трансляция: не больше одного видео и одного звука экрана
      for (const p of peer.producers.values()) if (p.kind === kind) { p.close(); peer.producers.delete(p.id); producerGone(room, socket.id, p); }
      const t = transportOf(peer, transportId, 'send');
      let producer;
      try {
        producer = await t.produce({ kind, rtpParameters, appData: { source: 'screen' } });
      } catch (e) { fail(`Сервер не принял трансляцию: ${e.message}`); }
      peer.producers.set(producer.id, producer);
      producer.observer.on('close', () => {
        if (peer.producers.delete(producer.id)) producerGone(room, socket.id, producer);
        recount(room, socket.id);
      });
      for (const sid of room.peers.keys()) if (sid !== socket.id) notify(sid, 'sfu:producer', { socketId: socket.id, producerId: producer.id, kind });
      return { id: producer.id };
    });

    on('sfu:close-producer', ({ producerId }) => {
      const { peer } = requirePeer();
      const p = peer.producers.get(producerId);
      p?.close();
    });

    on('sfu:consume', async ({ producerId, rtpCapabilities }) => {
      const { room, peer } = requirePeer();
      let owner = null;
      for (const [sid, p] of room.peers) if (p.producers.has(producerId)) owner = sid;
      if (!owner) fail('Трансляция не найдена');
      if (owner === socket.id) fail('Это своя трансляция');
      if (peer.consumers.size >= MAX_CONSUMERS) fail('Слишком много трансляций');
      if (!rtpCapabilities || !room.router.canConsume({ producerId, rtpCapabilities })) fail('Кодек трансляции не поддерживается');
      const t = [...peer.transports.values()].find((x) => x.appData.direction === 'recv');
      if (!t) fail('Нет транспорта для приёма');
      for (const c of peer.consumers.values()) if (c.producerId === producerId) { c.close(); peer.consumers.delete(c.id); }
      const consumer = await t.consume({ producerId, rtpCapabilities, paused: true, appData: { owner } });
      peer.consumers.set(consumer.id, consumer);
      const gone = () => {
        if (!peer.consumers.delete(consumer.id)) return;
        notify(socket.id, 'sfu:consumer-closed', { consumerId: consumer.id, socketId: owner });
        recount(room, owner);
      };
      consumer.on('producerclose', gone);
      consumer.on('transportclose', gone);
      return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, socketId: owner };
    });

    on('sfu:resume', async ({ consumerId }) => {
      const { room, peer } = requirePeer();
      const c = peer.consumers.get(consumerId);
      if (!c) fail('Не найдено');
      await c.resume();
      recount(room, c.appData.owner);
      // стример мог стоять на паузе (никто не смотрел) — новый зритель должен сразу получить ключевой кадр
      if (c.kind === 'video') setTimeout(() => { if (!c.closed) c.requestKeyFrame().catch(() => {}); }, 600).unref?.();
    });

    on('sfu:close-consumer', ({ consumerId }) => {
      const { room, peer } = requirePeer();
      const c = peer.consumers.get(consumerId);
      if (!c) return;
      peer.consumers.delete(c.id);
      c.close();
      recount(room, c.appData.owner);
    });

    /** Отладка/тесты: что сервер знает об этом участнике */
    on('sfu:debug', () => {
      if (!ready) return { ready: false };
      const channelId = ctx.channelOf();
      const room = channelId && rooms.get(channelId);
      const peer = room?.peers.get(socket.id);
      return {
        ready: true,
        peers: room ? room.peers.size : 0,
        producers: peer ? [...peer.producers.values()].map((p) => ({ kind: p.kind, codec: p.rtpParameters.codecs[0]?.mimeType, paused: p.paused })) : [],
        consumers: peer ? [...peer.consumers.values()].map((c) => ({ kind: c.kind, owner: c.appData.owner, paused: c.paused })) : [],
        viewers: peer?.viewers || 0,
      };
    });
  }

  return {
    start,
    attach,
    removePeer,
    get ready() { return ready; },
    close() { try { worker?.close(); } catch { /* ignore */ } },
  };
}
