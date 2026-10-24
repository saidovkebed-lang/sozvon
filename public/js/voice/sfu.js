// SFU трансляций экрана (mediasoup-client, вендорено: public/vendor/mediasoup-client.js).
// Стример отдаёт одну копию видео/звука экрана серверу, сервер раздаёт зрителям. Голос и камера — в mesh (rtc.js).
// Любая ошибка (SFU выключен, нет mediasoup на сервере, не соединилось) → rtc.js возвращается к mesh.
//
// Сигналы (Socket.IO, с ack): sfu:join → {rtpCapabilities, producers}, sfu:transport, sfu:connect, sfu:produce,
// sfu:close-producer, sfu:consume, sfu:resume, sfu:close-consumer, sfu:leave.
// От сервера: sfu:producer, sfu:producer-closed, sfu:consumer-closed, sfu:viewers, sfu:reset.

import { emitAck } from '../socket.js';
import { state } from '../state.js';

const VENDOR = new URL('../../vendor/mediasoup-client.js', import.meta.url).href;
const CONNECT_TIMEOUT = 10_000; // транспорт не соединился за это время — считаем, что SFU недоступен
const VIDEO_START_KBPS = 2500;  // как в mesh (rtc.js)
const VIDEO_MIN_KBPS = 600;

let libPromise = null;
const loadLib = () => (libPromise ||= import(VENDOR));

/** Отключить SFU на этом клиенте (отладка/тесты): localStorage['sozvon.sfu'] = 'off' */
function clientDisabled() {
  try { return localStorage.getItem('sozvon.sfu') === 'off'; } catch { return false; }
}

/** Ждать, пока транспорт соединится; false — не соединился (UDP/TCP до сервера закрыты) */
function waitConnected(transport, ms = CONNECT_TIMEOUT) {
  if (transport.connectionState === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); transport.off?.('connectionstatechange', h); resolve(v); };
    const h = (st) => {
      if (st === 'connected') done(true);
      else if (st === 'failed' || st === 'closed') done(false);
    };
    const t = setTimeout(() => done(false), ms);
    transport.on('connectionstatechange', h);
  });
}

export class SfuClient {
  constructor(mgr) {
    this.mgr = mgr;            // RtcManager
    this.reset();
  }

  reset() {
    this.joined = null;        // Promise<boolean> текущего sfu:join
    this.available = false;    // сервер принял join (знаем список трансляций)
    this.device = null;        // загружен — можем отправлять/принимать
    this.sendTransport = null;
    this.recvTransport = null;
    this.recvReady = null;
    this.producers = {};       // kind -> Producer (моя трансляция)
    this.producing = false;
    this.viewers = 0;          // сколько зрителей у моей трансляции через SFU
    this.remote = new Map();   // socketId -> Map(producerId -> kind) — чужие трансляции на сервере
    this.consumers = new Map(); // socketId -> { list: Consumer[], stream: MediaStream|null, pending: Promise|null }
    this.failed = new Set();   // socketId, которые не удалось смотреть через SFU (смотрим через mesh)
    this.placeholders = new Map();
  }

  /** Подключиться к SFU голосового канала (после voice:join) */
  join() {
    this.leave({ silent: true });
    const run = (async () => {
      let res;
      try {
        res = await emitAck('sfu:join', {});
      } catch (e) {
        console.info('[sfu] недоступен — трансляции через mesh:', e.message);
        return false;
      }
      if (this.joined !== run) return false;
      this.available = true;
      for (const p of res.producers || []) this.addRemote(p);
      if (clientDisabled()) return false;
      try {
        const { Device } = await loadLib();
        const device = new Device();
        await device.load({ routerRtpCapabilities: res.rtpCapabilities });
        if (this.joined !== run) return false;
        this.device = device;
        return true;
      } catch (e) {
        console.warn('[sfu] браузер не поддерживает SFU — трансляции через mesh:', e.message);
        return false;
      }
    })();
    this.joined = run;
    if (this.remote.size) this.mgr.changed();
    run.then(() => {
      if (this.joined !== run) return;
      // «Сразу смотреть трансляции»: уже идущие трансляции (через SFU или, если он не загрузился, напрямую)
      if (this.mgr.autoWatch?.()) for (const id of this.remote.keys()) if (!this.mgr.watching.has(id)) this.mgr.setWatching(id, true);
      this.mgr.changed();
    });
    return run;
  }

  leave({ silent = false } = {}) {
    const had = this.joined;
    this.closeProducers({ notify: false });
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    try { this.recvTransport?.close(); } catch { /* ignore */ }
    for (const c of this.consumers.values()) for (const x of c.list) { try { x.close(); } catch { /* ignore */ } }
    this.reset();
    if (had && !silent && state.myVoice) emitAck('sfu:leave').catch(() => {});
  }

  /** Готов ли SFU (ждёт join) */
  async ready() {
    if (!this.joined) return false;
    return (await this.joined) && !!this.device;
  }

  // ---------- трансляции других участников ----------
  addRemote({ socketId, producerId, kind }) {
    if (!socketId || !producerId) return;
    let m = this.remote.get(socketId);
    if (!m) this.remote.set(socketId, (m = new Map()));
    m.set(producerId, kind);
  }

  /** Сервер: у участника появилась дорожка трансляции */
  onProducer(p) {
    if (!this.available) return;
    const isNew = !this.remote.has(p.socketId);
    this.addRemote(p);
    this.failed.delete(p.socketId);
    const c = this.consumers.get(p.socketId);
    // уже смотрим — добираем дорожку (видео и звук экрана объявляются по отдельности)
    if (c) this.consumeOne(p.socketId, p.producerId).catch((e) => this.consumeFailed(p.socketId, e));
    else if (this.mgr.watching.has(p.socketId) || (isNew && this.mgr.autoWatch?.())) this.mgr.setWatching(p.socketId, true);
    this.mgr.changed();
  }

  onProducerClosed({ socketId, producerId }) {
    const m = this.remote.get(socketId);
    if (!m) return;
    m.delete(producerId);
    if (!m.size) {
      this.remote.delete(socketId);
      this.dropConsumers(socketId);
      this.placeholders.delete(socketId);
      this.mgr.sfuRemoteGone(socketId);
    }
    this.mgr.changed();
  }

  onConsumerClosed({ consumerId, socketId }) {
    const c = this.consumers.get(socketId);
    if (!c) return;
    const x = c.list.find((k) => k.id === consumerId);
    if (!x) return;
    try { x.close(); } catch { /* ignore */ }
    c.list = c.list.filter((k) => k !== x);
    this.rebuild(socketId);
  }

  /** Участник вышел из голосового канала */
  forget(socketId) {
    this.remote.delete(socketId);
    this.dropConsumers(socketId);
    this.placeholders.delete(socketId);
    this.failed.delete(socketId);
  }

  /** Участник транслирует через SFU (знаем о трансляции, даже если ещё не смотрим) */
  hasRemote(socketId) { return this.remote.has(socketId); }

  /** Смотрим трансляцию участника через SFU (или подключаемся) */
  consuming(socketId) { return this.consumers.has(socketId); }

  /** Можно ли смотреть через SFU (иначе — mesh) */
  canConsume(socketId) { return !!this.device && this.hasRemote(socketId) && !this.failed.has(socketId); }

  /** Поток трансляции для плитки: живой поток или заглушка «есть трансляция, ещё не смотрим» */
  screenOf(socketId) {
    if (!this.hasRemote(socketId)) return null;
    const c = this.consumers.get(socketId);
    if (c?.stream) return c.stream;
    let ph = this.placeholders.get(socketId);
    if (!ph) this.placeholders.set(socketId, (ph = new MediaStream()));
    return ph;
  }

  /** Живые потоки трансляций (для звука экрана) */
  liveStreams() {
    const out = [];
    for (const [socketId, c] of this.consumers) if (c.stream) out.push({ socketId, stream: c.stream });
    return out;
  }

  /** Транспорт приёма — один на все трансляции (создаётся при первом «Смотреть») */
  ensureRecv() {
    if (this.recvReady && !this.recvTransport?.closed) return this.recvReady;
    const gen = this.joined;
    const ready = (async () => {
      const info = await emitAck('sfu:transport', { direction: 'recv' });
      if (this.joined !== gen || !this.device) throw new Error('SFU переподключился');
      const t = this.device.createRecvTransport({ ...info, iceServers: this.mgr.iceServers, iceTransportPolicy: 'all' });
      this.recvTransport = t;
      t.on('connect', ({ dtlsParameters }, ok, fail) => {
        emitAck('sfu:connect', { transportId: t.id, dtlsParameters }).then(() => ok(), fail);
      });
      t.on('connectionstatechange', (st) => {
        if (st === 'failed' && this.recvTransport === t) {
          console.warn('[sfu] приём трансляций не соединился — переходим на mesh');
          this.recvTransport = null;
          this.recvReady = null;
          try { t.close(); } catch { /* ignore */ }
          for (const id of [...this.consumers.keys()]) this.consumeFailed(id, new Error('транспорт'));
        }
      });
      return t;
    })();
    this.recvReady = ready;
    ready.catch(() => { if (this.recvReady === ready) this.recvReady = null; });
    return ready;
  }

  /** Начать смотреть трансляцию участника */
  async watch(socketId) {
    if (this.consumers.has(socketId)) return this.consumers.get(socketId).pending;
    const entry = { list: [], stream: null, pending: null };
    this.consumers.set(socketId, entry);
    entry.pending = (async () => {
      const t = await this.ensureRecv();
      for (const producerId of [...(this.remote.get(socketId)?.keys() || [])]) await this.consumeOne(socketId, producerId);
      if (this.consumers.get(socketId) !== entry) return;
      if (!entry.list.length) throw new Error('нет дорожек');
      if (!(await waitConnected(t))) throw new Error('не соединилось с сервером');
    })();
    try {
      await entry.pending;
    } catch (e) {
      this.consumeFailed(socketId, e);
      throw e;
    }
  }

  async consumeOne(socketId, producerId) {
    const entry = this.consumers.get(socketId);
    if (!entry || entry.list.some((c) => c.producerId === producerId)) return;
    const t = await this.ensureRecv();
    const info = await emitAck('sfu:consume', { producerId, rtpCapabilities: this.device.rtpCapabilities });
    if (this.consumers.get(socketId) !== entry) { emitAck('sfu:close-consumer', { consumerId: info.id }).catch(() => {}); return; }
    const consumer = await t.consume({ id: info.id, producerId: info.producerId, kind: info.kind, rtpParameters: info.rtpParameters });
    entry.list.push(consumer);
    consumer.track.addEventListener('ended', () => this.rebuild(socketId));
    await emitAck('sfu:resume', { consumerId: consumer.id });
    this.rebuild(socketId);
  }

  rebuild(socketId) {
    const entry = this.consumers.get(socketId);
    if (!entry) return;
    const tracks = entry.list.filter((c) => !c.closed).map((c) => c.track);
    // новый объект потока — плитка и звук пересоберутся
    entry.stream = tracks.some((t) => t.kind === 'video') ? new MediaStream(tracks) : null;
    this.mgr.changed();
  }

  /** Перестать смотреть */
  unwatch(socketId) {
    const entry = this.consumers.get(socketId);
    if (!entry) return;
    this.consumers.delete(socketId);
    for (const c of entry.list) {
      emitAck('sfu:close-consumer', { consumerId: c.id }).catch(() => {});
      try { c.close(); } catch { /* ignore */ }
    }
    this.mgr.changed();
  }

  dropConsumers(socketId) {
    const entry = this.consumers.get(socketId);
    if (!entry) return;
    this.consumers.delete(socketId);
    for (const c of entry.list) { try { c.close(); } catch { /* ignore */ } }
  }

  consumeFailed(socketId, e) {
    if (!this.consumers.has(socketId) && this.failed.has(socketId)) return;
    console.warn('[sfu] не удалось смотреть через сервер — переходим на mesh:', e?.message || e);
    this.unwatch(socketId);
    this.failed.add(socketId);
    this.mgr.sfuWatchFailed(socketId);
  }

  // ---------- моя трансляция ----------
  /**
   * Отправить трансляцию на сервер. params — { maxBitrate, maxFramerate, degradation }.
   * true — идёт через SFU; false — не вышло (вызывающий переходит на mesh).
   */
  async produce(stream, params) {
    if (!(await this.ready())) return false;
    const gen = (this.gen = (this.gen || 0) + 1);
    try {
      const info = await emitAck('sfu:transport', { direction: 'send' });
      if (this.gen !== gen) return false; // трансляцию уже остановили
      const t = this.device.createSendTransport({ ...info, iceServers: this.mgr.iceServers, iceTransportPolicy: 'all' });
      this.sendTransport = t;
      t.on('connect', ({ dtlsParameters }, ok, fail) => {
        emitAck('sfu:connect', { transportId: t.id, dtlsParameters }).then(() => ok(), fail);
      });
      t.on('produce', ({ kind, rtpParameters }, ok, fail) => {
        emitAck('sfu:produce', { transportId: t.id, kind, rtpParameters }).then((r) => ok({ id: r.id }), fail);
      });
      t.on('connectionstatechange', (st) => {
        if (st === 'failed' && this.sendTransport === t) {
          console.warn('[sfu] отправка трансляции не соединилась — переходим на mesh');
          this.mgr.sfuProduceFailed();
        }
      });
      this.producing = true;
      // трансляцию остановили, пока шло согласование — закрыть то, что успело создаться
      const stale = (p) => {
        if (this.gen === gen && this.producing) return false;
        emitAck('sfu:close-producer', { producerId: p.id }).catch(() => {});
        try { p.close(); } catch { /* ignore */ }
        return true;
      };
      const vt = stream.getVideoTracks()[0];
      const at = stream.getAudioTracks()[0];
      const enc = {};
      if (params?.maxBitrate) enc.maxBitrate = params.maxBitrate;
      if (params?.maxFramerate) enc.maxFramerate = params.maxFramerate;
      if (vt) {
        const p = await t.produce({
          track: vt,
          encodings: [enc],
          codec: this.preferredCodec(),
          codecOptions: { videoGoogleStartBitrate: VIDEO_START_KBPS, videoGoogleMinBitrate: VIDEO_MIN_KBPS },
          stopTracks: false, disableTrackOnPause: false, zeroRtpOnPause: false,
          appData: { source: 'screen' },
        });
        if (stale(p)) return false;
        this.producers.video = p;
      }
      if (at) {
        const p = await t.produce({
          track: at, stopTracks: false, disableTrackOnPause: false, zeroRtpOnPause: false,
          codecOptions: { opusStereo: true, opusDtx: false },
          appData: { source: 'screen' },
        });
        if (stale(p)) return false;
        this.producers.audio = p;
      }
      this.applyParams(params);
      this.setPaused(this.viewers === 0);
      if (!(await waitConnected(t))) throw new Error('не соединилось с сервером');
      return this.producing && this.gen === gen;
    } catch (e) {
      if (!this.producing || this.gen !== gen) return false; // остановили сами
      console.warn('[sfu] трансляция через сервер не удалась — переходим на mesh:', e?.message || e);
      this.closeProducers();
      return false;
    }
  }

  /** H.264 (кодирует видеокарта), если его умеют браузер и сервер; иначе VP8 */
  preferredCodec() {
    const codecs = this.device?.rtpCapabilities?.codecs || [];
    return codecs.find((c) => /video\/h264/i.test(c.mimeType) && c.parameters?.['packetization-mode'] === 1)
      || codecs.find((c) => /video\/vp8/i.test(c.mimeType));
  }

  /** Качество (maxBitrate/maxFramerate/degradation) — на лету, без пересогласования */
  applyParams(params) {
    const s = this.producers.video?.rtpSender;
    if (s && params) this.mgr.applySenderParams(s, params);
  }

  /** Никто не смотрит — ничего не кодируем и не отправляем (как в mesh: replaceTrack(null)) */
  setPaused(paused) {
    for (const p of Object.values(this.producers)) {
      const s = p?.rtpSender;
      if (!s || p.closed) continue;
      const want = paused ? null : p.track;
      if (s.track !== want) s.replaceTrack(want).catch((e) => console.warn('[sfu] replaceTrack', e));
    }
    if (!paused) this.applyParams(this.mgr.screenParams);
  }

  onViewers(count) {
    this.viewers = Math.max(0, Number(count) || 0);
    if (this.producing) this.setPaused(this.viewers === 0);
    this.mgr.screenViewersChanged();
  }

  closeProducers({ notify = true } = {}) {
    const had = this.producing;
    this.gen = (this.gen || 0) + 1;
    this.producing = false;
    for (const p of Object.values(this.producers)) {
      if (!p) continue;
      if (notify && state.myVoice) emitAck('sfu:close-producer', { producerId: p.id }).catch(() => {});
      try { p.close(); } catch { /* ignore */ }
    }
    this.producers = {};
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    this.sendTransport = null;
    this.viewers = 0;
    return had;
  }

  /** Отладка (тесты): что идёт через SFU */
  async debug() {
    const stat = async (t) => {
      if (!t || t.closed) return null;
      const out = { state: t.connectionState, outVideo: [], inVideo: [] };
      (await t.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') out.outVideo.push({ bytes: r.bytesSent || 0, frames: r.framesEncoded || 0, width: r.frameWidth || 0 });
        if (r.type === 'inbound-rtp' && r.kind === 'video') out.inVideo.push({ bytes: r.bytesReceived || 0, frames: r.framesDecoded || 0, width: r.frameWidth || 0 });
      });
      return out;
    };
    return {
      available: this.available,
      device: !!this.device,
      producing: this.producing,
      codec: this.producers.video?.rtpParameters?.codecs?.[0]?.mimeType || null,
      viewers: this.viewers,
      remote: [...this.remote.keys()],
      consuming: [...this.consumers.entries()].filter(([, c]) => c.stream).map(([id]) => id),
      failed: [...this.failed],
      send: await stat(this.sendTransport),
      recv: await stat(this.recvTransport),
    };
  }
}
