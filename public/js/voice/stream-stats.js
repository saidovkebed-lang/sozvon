// Качество трансляции экрана из RTCRtpSender/RTCRtpReceiver.getStats() (без своих замеров и без нагрузки):
// стример — outbound-rtp (кадры/с, разрешение, битрейт, кодек, qualityLimitationReason), remote-inbound-rtp
// (RTT, потери), media-source (сколько кадров даёт захват); зритель — inbound-rtp.
// Через SFU отправитель один (producers.video.rtpSender), в mesh — по сендеру на каждого зрителя:
// сводка берёт худшего зрителя (кадры/с, RTT, потери) и суммарный битрейт.
import { rtc } from './rtc.js';

const prev = new WeakMap(); // sender/receiver -> { bytes, frames, ts } — для битрейта и к/с между опросами

/** Программные кодировщики (процессор); остальное — видеокарта (ExternalEncoder, MediaFoundation, VideoToolbox, NVENC…) */
const SOFTWARE = /libvpx|openh264|libaom|dav1d|ffmpeg|software/i;

const codecName = (c) => (c?.mimeType ? c.mimeType.replace(/^video\//i, '') : null);

function rate(key, bytes, frames) {
  const now = performance.now();
  const p = prev.get(key);
  // внеочередной замер (панель открыли, отладка) сразу после предыдущего — отдаём прошлое значение
  if (p && now - p.ts < 500 && bytes >= p.bytes) return { kbps: p.kbps, fps: p.fps };
  const out = { kbps: null, fps: null };
  if (p && bytes >= p.bytes) {
    const dt = (now - p.ts) / 1000;
    out.kbps = Math.round(((bytes - p.bytes) * 8) / dt / 1000);
    out.fps = frames >= p.frames ? (frames - p.frames) / dt : null;
  }
  prev.set(key, { bytes, frames, ts: now, ...out });
  return out;
}

/** Статистика одного видеосендера трансляции или null (ничего не отправляет) */
async function senderStats(sender) {
  if (!sender?.track) return null; // никто не смотрит — трек снят (replaceTrack(null)), не кодируем
  let report;
  try { report = await sender.getStats(); } catch { return null; }
  const byId = new Map();
  report.forEach((r) => byId.set(r.id, r));
  let out = null;
  report.forEach((r) => {
    if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
    // несколько слоёв (simulcast) не используем, но на всякий случай — самый крупный
    if (!out || (r.frameWidth || 0) > (out.frameWidth || 0)) out = r;
  });
  if (!out) return null;
  let remote = null;
  report.forEach((r) => { if (r.type === 'remote-inbound-rtp' && (r.localId === out.id || r.ssrc === out.ssrc)) remote = r; });
  const src = byId.get(out.mediaSourceId);
  const codec = byId.get(out.codecId);
  const d = rate(sender, out.bytesSent || 0, out.framesSent ?? out.framesEncoded ?? 0);
  const impl = out.encoderImplementation || '';
  return {
    fps: d.fps != null ? Math.round(d.fps) : (Number.isFinite(out.framesPerSecond) ? Math.round(out.framesPerSecond) : null),
    width: out.frameWidth || 0,
    height: out.frameHeight || 0,
    kbps: d.kbps,
    codec: codecName(codec),
    encoder: impl || null,
    hw: typeof out.powerEfficientEncoder === 'boolean' ? out.powerEfficientEncoder : (impl ? !SOFTWARE.test(impl) : null),
    limitation: out.qualityLimitationReason || 'none',
    sourceFps: Number.isFinite(src?.framesPerSecond) ? Math.round(src.framesPerSecond) : null,
    sourceWidth: src?.width || 0,
    sourceHeight: src?.height || 0,
    rtt: Number.isFinite(remote?.roundTripTime) ? Math.round(remote.roundTripTime * 1000) : null,
    loss: Number.isFinite(remote?.fractionLost) ? Math.round(remote.fractionLost * 1000) / 10 : null,
  };
}

/** Видеосендеры моей трансляции: [{ via: 'sfu' | socketId зрителя, sender }] — только те, что сейчас отправляют */
export function screenSenders() {
  const out = [];
  const s = rtc.sfuScreen && rtc.sfu.producers.video;
  if (s && !s.closed && s.rtpSender?.track) out.push({ via: 'sfu', sender: s.rtpSender });
  for (const p of rtc.peers.values()) {
    if (p.closed || !p.screenWatched) continue;
    for (const sender of p.senders.screen) if (sender.track?.kind === 'video') out.push({ via: p.id, sender });
  }
  return out;
}

const LIMIT_RANK = { bandwidth: 3, cpu: 2, other: 1, none: 0 };

/**
 * Сводка отправки моей трансляции. null — трансляции нет.
 * { via: 'sfu'|'mesh'|'mixed'|null, viewers, senders, fps, width, height, kbps, codec, encoder, hw, limitation,
 *   sourceFps, sourceWidth, sourceHeight, rtt, loss, list: [{ via, ...stats }] }
 */
export async function screenSendStats() {
  if (!rtc.local.screen) return null;
  const senders = screenSenders();
  const list = (await Promise.all(senders.map(async ({ via, sender }) => {
    const st = await senderStats(sender);
    return st && { via, ...st };
  }))).filter(Boolean);
  const viewers = rtc.screenViewers();
  const sfu = list.some((x) => x.via === 'sfu');
  const mesh = list.some((x) => x.via !== 'sfu');
  const sum = { via: sfu && mesh ? 'mixed' : sfu ? 'sfu' : mesh ? 'mesh' : null, viewers, senders: list.length, list };
  if (!list.length) return Object.assign(sum, { fps: null, width: 0, height: 0, kbps: null, limitation: 'none' });
  // худший зритель — по кадрам/с (при равенстве — по разрешению)
  const worst = list.reduce((a, b) => ((b.fps ?? 1e9) < (a.fps ?? 1e9) || ((b.fps ?? 1e9) === (a.fps ?? 1e9) && b.width < a.width) ? b : a));
  const max = (k) => list.reduce((m, x) => (x[k] != null && (m == null || x[k] > m) ? x[k] : m), null);
  const kb = list.filter((x) => x.kbps != null);
  return Object.assign(sum, {
    fps: worst.fps, width: worst.width, height: worst.height,
    kbps: kb.length ? kb.reduce((n, x) => n + x.kbps, 0) : null,
    codec: worst.codec, encoder: worst.encoder, hw: worst.hw,
    limitation: list.reduce((m, x) => ((LIMIT_RANK[x.limitation] ?? 1) > (LIMIT_RANK[m] ?? 1) ? x.limitation : m), 'none'),
    sourceFps: worst.sourceFps, sourceWidth: worst.sourceWidth, sourceHeight: worst.sourceHeight,
    rtt: max('rtt'), loss: max('loss'),
  });
}

/** Приёмник видео чужой трансляции, которую я смотрю (SFU-consumer или mesh) */
function screenReceiver(socketId) {
  const vt = rtc.screenOf(socketId)?.getVideoTracks().find((t) => t.readyState === 'live');
  if (!vt) return null;
  const c = rtc.sfu.consumers.get(socketId)?.list.find((x) => !x.closed && x.track === vt);
  if (c?.rtpReceiver) return c.rtpReceiver;
  const pc = rtc.peers.get(socketId)?.pc;
  try { return pc?.getReceivers().find((r) => r.track === vt) || null; } catch { return null; }
}

/** Что получает зритель: { fps, width, height, kbps, codec, decoder, loss } или null */
export async function screenRecvStats(socketId) {
  const recv = screenReceiver(socketId);
  if (!recv) return null;
  let report;
  try { report = await recv.getStats(); } catch { return null; }
  const byId = new Map();
  report.forEach((r) => byId.set(r.id, r));
  let r = null;
  report.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') r = x; });
  if (!r) return null;
  const d = rate(recv, r.bytesReceived || 0, r.framesDecoded || 0);
  const lost = Math.max(0, r.packetsLost || 0);
  const got = r.packetsReceived || 0;
  return {
    fps: Number.isFinite(r.framesPerSecond) ? Math.round(r.framesPerSecond) : (d.fps != null ? Math.round(d.fps) : null),
    width: r.frameWidth || 0,
    height: r.frameHeight || 0,
    kbps: d.kbps,
    codec: codecName(byId.get(r.codecId)),
    decoder: r.decoderImplementation || null,
    loss: lost + got > 0 ? Math.round((lost / (lost + got)) * 1000) / 10 : null,
  };
}
