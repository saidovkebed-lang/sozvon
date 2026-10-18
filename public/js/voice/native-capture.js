// Свой захват экрана приложения для ПК (Windows): помощник sozvon-capture.exe (DXGI Desktop Duplication)
// отдаёт кадры I420 по http://127.0.0.1 (одноразовый адрес от моста window.sozvonDesktop); здесь они
// складываются в видеодорожку (MediaStreamTrackGenerator) — дальше она идёт в трансляцию как обычная.
// Захват Chromium (Windows Graphics Capture) прячет курсор в играх.

const COLOR = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
const MAGIC = 0x31435a53; // 'SZC1'
const HEADER = 24;

const D = () => (window.sozvonDesktop?.isDesktop ? window.sozvonDesktop : null);

export const nativeCaptureSupported = () =>
  !!(D()?.startNativeCapture && typeof window.MediaStreamTrackGenerator === 'function' && typeof window.VideoFrame === 'function');

/** Читает поток кадров по url и вызывает onFrame({w, h, ts, data: ArrayBuffer}); resolve — поток закончился */
async function readFrames(url, signal, onFrame) {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  let byob = null;
  try { byob = res.body.getReader({ mode: 'byob' }); } catch { /* старый движок — обычное чтение */ }
  if (!byob) return readFramesChunks(res.body.getReader(), onFrame);
  // BYOB: данные пишутся сразу в буфер кадра — без промежуточных кусков и лишних копий
  const fill = async (n) => {
    let ab = new ArrayBuffer(n);
    let off = 0;
    while (off < n) {
      const { value, done } = await byob.read(new Uint8Array(ab, off, n - off));
      if (done || !value) return null;
      ab = value.buffer;
      off += value.byteLength;
    }
    return ab;
  };
  for (;;) {
    const hb = await fill(HEADER);
    if (!hb) return;
    const hv = new DataView(hb);
    if (hv.getUint32(0, true) !== MAGIC) throw new Error('неверный поток кадров');
    const data = await fill(hv.getUint32(12, true));
    if (!data) return;
    onFrame({ w: hv.getUint32(4, true), h: hv.getUint32(8, true), ts: Number(hv.getBigUint64(16, true)), data });
  }
}

async function readFramesChunks(reader, onFrame) {
  const hdr = new Uint8Array(HEADER);
  const hv = new DataView(hdr.buffer);
  let hFill = 0;
  let frame = null; // { w, h, ts, data, fill }
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    let off = 0;
    while (off < value.length) {
      if (!frame) {
        const k = Math.min(HEADER - hFill, value.length - off);
        hdr.set(value.subarray(off, off + k), hFill);
        hFill += k;
        off += k;
        if (hFill < HEADER) break;
        hFill = 0;
        if (hv.getUint32(0, true) !== MAGIC) throw new Error('неверный поток кадров');
        const len = hv.getUint32(12, true);
        frame = { w: hv.getUint32(4, true), h: hv.getUint32(8, true), ts: Number(hv.getBigUint64(16, true)), data: new Uint8Array(len), fill: 0 };
      }
      const k = Math.min(frame.data.length - frame.fill, value.length - off);
      frame.data.set(value.subarray(off, off + k), frame.fill);
      frame.fill += k;
      off += k;
      if (frame.fill === frame.data.length) {
        onFrame({ w: frame.w, h: frame.h, ts: frame.ts, data: frame.data.buffer });
        frame = null;
      }
    }
  }
}

/**
 * Запустить захват источника. Возвращает сессию { track, update(params), pause(on), stop(), onEnded(fn) }
 * или null, если свой захват недоступен/не заработал (тогда — обычный getDisplayMedia).
 * params: { maxWidth, maxHeight, fps }
 */
export async function startNativeCapture(sourceId, params) {
  const d = D();
  if (!nativeCaptureSupported() || !sourceId) return null;
  const res = await d.startNativeCapture({ sourceId, ...params });
  if (!res?.ok || !res.url) {
    if (res?.error && res.error !== 'unavailable') console.warn('[native-capture]', res.error);
    return null;
  }
  const token = res.token;
  const gen = new window.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = gen.writable.getWriter();
  const endedFns = new Set();
  let stopped = false;
  let abort = null;
  let firstFrame;
  const gotFirst = new Promise((r) => { firstFrame = r; });

  const finish = (reason) => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    abort?.abort();
    firstFrame(false);
    // сначала обработчики (причина важна), потом закрытие дорожки: её 'ended' приходит синхронно
    for (const fn of endedFns) { try { fn(reason); } catch (e) { console.error(e); } }
    writer.close().catch(() => {});
  };
  const unsubscribe = d.onNativeCaptureEnded?.((m) => { if (m.token === token) finish(m.reason || 'exit'); });

  const onFrame = (f) => {
    if (stopped) return;
    // дорожка не успевает (энкодер занят) — кадр пропускаем, чтобы не копить задержку
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
    let vf = null;
    try {
      // transfer: буфер отдаётся кадру без копирования
      vf = new window.VideoFrame(f.data, { format: 'I420', codedWidth: f.w, codedHeight: f.h, timestamp: f.ts, colorSpace: COLOR, transfer: [f.data] });
      writer.write(vf).catch(() => {}); // кадр закрывает сама дорожка
      firstFrame(true);
    } catch (e) {
      try { vf?.close(); } catch { /* ignore */ }
      console.warn('[native-capture] кадр', e);
    }
  };

  const pump = (url) => {
    abort?.abort();
    const ctl = new AbortController();
    abort = ctl;
    // поток оборвался: причину (например, «окно закрыто») пришлёт мост — ждём её чуть-чуть
    const ended = (e) => {
      if (ctl.signal.aborted || stopped || abort !== ctl) return;
      if (e) console.warn('[native-capture]', e?.message || e);
      setTimeout(() => { if (abort === ctl) finish('exit'); }, 1500);
    };
    readFrames(url, ctl.signal, onFrame).then(() => ended(null), ended);
  };
  pump(res.url);

  // помощник должен прислать кадр быстро; иначе — считаем, что не работает (фолбэк на захват Chromium)
  const ok = await Promise.race([gotFirst, new Promise((r) => setTimeout(() => r(false), 6000))]);
  if (!ok) {
    const wasStopped = stopped;
    finish('failed');
    d.nativeCaptureControl(token, 'stop');
    if (!wasStopped) console.warn('[native-capture] нет кадров — обычный захват');
    return null;
  }

  return {
    track: gen,
    update: async (p) => {
      const r = await d.nativeCaptureControl(token, 'update', p);
      if (r?.ok && r.url && !stopped) pump(r.url);
    },
    pause: (on) => d.nativeCaptureControl(token, on ? 'pause' : 'resume'),
    stop: () => { finish('stopped'); d.nativeCaptureControl(token, 'stop'); },
    onEnded: (fn) => endedFns.add(fn),
  };
}
