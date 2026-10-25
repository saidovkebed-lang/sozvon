// Звук экрана без звука самого приложения (приложение для ПК, Windows 11): помощник sozvon-capture.exe
// (--audio-exclude-pid, WASAPI process loopback) отдаёт системный звук БЕЗ «Astra» по http://127.0.0.1 —
// здесь он складывается в звуковую дорожку (MediaStreamTrackGenerator). Голоса звонка в неё не попадают,
// поэтому звук игры/видео в трансляции не нужно приглушать, когда кто-то говорит.
// Протокол — desktop/native/capture/capture.cpp: заголовок 24 байта ('SZA1', rate, channels, length, ts µs) + PCM s16.

const MAGIC = 0x31415a53; // 'SZA1'
const HEADER = 24;

const D = () => (window.sozvonDesktop?.isDesktop ? window.sozvonDesktop : null);

export const nativeAudioSupported = () =>
  !!(D()?.startNativeAudio && typeof window.MediaStreamTrackGenerator === 'function' && typeof window.AudioData === 'function');

/** Разбор потока пакетов: onPacket({rate, ch, ts, pcm: Int16Array}) */
async function readPackets(url, signal, onPacket) {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const joined = new Uint8Array(buf.length + value.length);
    joined.set(buf);
    joined.set(value, buf.length);
    let off = 0;
    while (joined.length - off >= HEADER) {
      const hv = new DataView(joined.buffer, joined.byteOffset + off, HEADER);
      if (hv.getUint32(0, true) !== MAGIC) throw new Error('неверный поток звука');
      const len = hv.getUint32(12, true);
      if (joined.length - off - HEADER < len) break;
      const pcm = new Int16Array(joined.slice(off + HEADER, off + HEADER + len).buffer);
      onPacket({ rate: hv.getUint32(4, true), ch: hv.getUint32(8, true), ts: Number(hv.getBigUint64(16, true)), pcm });
      off += HEADER + len;
    }
    buf = joined.subarray(off);
  }
}

/**
 * Запустить звук экрана без «Astra». Возвращает { track, stop() } или null — API нет (Windows 10, другая ОС)
 * или звук не пошёл; тогда остаётся обычный системный звук с приглушением голосов звонка.
 */
export async function startNativeAudio() {
  const d = D();
  if (!nativeAudioSupported()) return null;
  const res = await d.startNativeAudio();
  if (!res?.ok || !res.url) {
    if (res?.error && res.error !== 'unavailable') console.info('[native-audio] недоступно:', res.error);
    return null;
  }
  const token = res.token;
  const gen = new window.MediaStreamTrackGenerator({ kind: 'audio' });
  const writer = gen.writable.getWriter();
  const ctl = new AbortController();
  let stopped = false;
  let first;
  const gotFirst = new Promise((r) => { first = r; });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    ctl.abort();
    first(false);
    writer.close().catch(() => {});
    d.nativeCaptureControl(token, 'stop');
  };
  const unsubscribe = d.onNativeCaptureEnded?.((m) => { if (m.token === token) stop(); });

  const onPacket = ({ rate, ch, ts, pcm }) => {
    if (stopped || !ch) return;
    const frames = pcm.length / ch;
    if (!frames) return;
    // дорожка не успевает — пакет пропускаем, а не копим задержку
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
    // s16 interleaved → f32-planar (формат, который дорожка принимает везде)
    const out = new Float32Array(pcm.length);
    for (let c = 0; c < ch; c++) {
      const base = c * frames;
      for (let i = 0; i < frames; i++) out[base + i] = pcm[i * ch + c] / 32768;
    }
    let ad = null;
    try {
      ad = new window.AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: frames, numberOfChannels: ch, timestamp: ts, data: out });
      writer.write(ad).catch(() => {});
      first(true);
    } catch (e) {
      try { ad?.close(); } catch { /* ignore */ }
      console.warn('[native-audio] пакет', e);
    }
  };
  readPackets(res.url, ctl.signal, onPacket).then(stop, (e) => { if (!stopped) console.warn('[native-audio]', e?.message || e); stop(); });

  // помощник шлёт пакеты (хотя бы тишину) сразу; нет — значит не работает
  const ok = await Promise.race([gotFirst, new Promise((r) => setTimeout(() => r(false), 3000))]);
  if (!ok) { stop(); return null; }
  return { track: gen, stop };
}
