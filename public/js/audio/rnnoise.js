// Загрузка RNNoise (вендорено: public/vendor/web-noise-suppressor, MIT + Apache-2.0 + BSD-3, см. LICENSE*).
// Никаких CDN: worklet и wasm отдаёт наш сервер.

const VENDOR = new URL('../../vendor/web-noise-suppressor/', import.meta.url);
const PROCESSOR = '@sapphi-red/web-noise-suppressor/rnnoise';
const GATE_URL = new URL('./gate-worklet.js', import.meta.url);

let wasmPromise = null;
const modules = new WeakMap(); // AudioContext -> { rnnoise?: Promise, gate?: Promise }
let rnnoiseLoaded = false;

export function rnnoiseSupported() {
  try {
    return !!window.isSecureContext
      && typeof AudioWorkletNode === 'function'
      && typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function';
  } catch { return false; }
}

export function isRnnoiseLoaded() { return rnnoiseLoaded; }

function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3,
      2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}

async function fetchWasm() {
  const file = simdSupported() ? 'rnnoise_simd.wasm' : 'rnnoise.wasm';
  const res = await fetch(new URL(file, VENDOR));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // проверяем бинарник здесь: если он битый, worklet молча выдавал бы тишину
  await WebAssembly.compile(buf);
  return buf;
}

function slot(ctx) {
  let s = modules.get(ctx);
  if (!s) { s = {}; modules.set(ctx, s); }
  return s;
}

/** Создать узел RNNoise в контексте (ожидается 48 кГц). Бросает, если что-то не загрузилось. */
export async function createRnnoiseNode(ctx) {
  if (!rnnoiseSupported() || !ctx.audioWorklet) throw new Error('AudioWorklet/WebAssembly недоступны');
  if (!wasmPromise) wasmPromise = fetchWasm().catch((e) => { wasmPromise = null; throw e; });
  const s = slot(ctx);
  if (!s.rnnoise) {
    s.rnnoise = ctx.audioWorklet.addModule(new URL('rnnoise-worklet.js', VENDOR).href)
      .catch((e) => { s.rnnoise = null; throw e; });
  }
  const [wasmBinary] = await Promise.all([wasmPromise, s.rnnoise]);
  const node = new AudioWorkletNode(ctx, PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { maxChannels: 1, wasmBinary },
  });
  node.destroy = () => { try { node.port.postMessage('destroy'); } catch { /* ignore */ } };
  rnnoiseLoaded = true;
  return node;
}

/** Создать узел гейта/измерителя (наш собственный worklet). */
export async function createGateNode(ctx, processorOptions) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') throw new Error('AudioWorklet недоступен');
  const s = slot(ctx);
  if (!s.gate) s.gate = ctx.audioWorklet.addModule(GATE_URL.href).catch((e) => { s.gate = null; throw e; });
  await s.gate;
  return new AudioWorkletNode(ctx, 'sozvon-gate', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions,
  });
}
