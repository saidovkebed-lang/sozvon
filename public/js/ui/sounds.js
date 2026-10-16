// Звуки интерфейса, синтезированные WebAudio (без файлов): вход/выход в голосовом, сообщение, mute/deafen.
//   playSound('join')   — с учётом настроек notifications.*
//   previewSound('join') — всегда (кнопка «прослушать» в настройках)
import { prefs } from '../prefs.js';

let ctx = null;
let master = null;
let sinkApplied = null;

function audio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0.9;
      // мягкий компрессор, чтобы аккорды не клиппили
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
    } catch { ctx = null; return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  applySink();
  return ctx;
}

function applySink() {
  if (!ctx || typeof ctx.setSinkId !== 'function') return;
  const id = prefs.get('audio.outputDeviceId');
  const want = id && id !== 'default' ? id : '';
  if (sinkApplied === want) return;
  sinkApplied = want;
  ctx.setSinkId(want).catch(() => { sinkApplied = null; });
}

/** Один «колокольчик»: синус + тихий обертон, быстрая атака, экспоненциальный спад. */
function tone(freq, start, dur, { gain = 0.16, type = 'sine', glideTo = null, overtone = 0.25 } = {}) {
  const c = ctx;
  const t0 = c.currentTime + start;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  env.connect(master);
  const voices = [[type, 1, 1], ['sine', 2, overtone]];
  for (const [wave, mult, level] of voices) {
    if (!level) continue;
    const o = c.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(freq * mult, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo * mult, t0 + dur * 0.6);
    const g = c.createGain();
    g.gain.value = level;
    o.connect(g).connect(env);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
}

const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, E6: 1318.5, G4: 392, C4: 261.63, E4: 329.63, A4: 440 };

const SOUNDS = {
  // восходящая терция → кварта: «кто-то пришёл»
  join() { tone(N.E5, 0, 0.22); tone(N.A5, 0.09, 0.32); },
  // зеркально вниз: «ушёл»
  leave() { tone(N.A5, 0, 0.22); tone(N.E5, 0.09, 0.32, { gain: 0.14 }); },
  // короткий «плинк» — новое сообщение
  message() { tone(N.C6, 0, 0.16, { gain: 0.12, overtone: 0.15 }); tone(N.G5 * 1.5, 0.06, 0.28, { gain: 0.1, overtone: 0.1 }); },
  // щелчок вниз — микрофон выключен
  mute() { tone(N.A4, 0, 0.12, { gain: 0.14, type: 'triangle', glideTo: N.E4, overtone: 0 }); },
  // щелчок вверх — микрофон включён
  unmute() { tone(N.E4, 0, 0.12, { gain: 0.14, type: 'triangle', glideTo: N.A4, overtone: 0 }); },
  // два низких тона вниз — звук выключен
  deafen() { tone(N.G4, 0, 0.14, { gain: 0.15, type: 'triangle', overtone: 0.1 }); tone(N.C4, 0.08, 0.22, { gain: 0.15, type: 'triangle', overtone: 0.1 }); },
  // два тона вверх — звук включён
  undeafen() { tone(N.C4, 0, 0.14, { gain: 0.15, type: 'triangle', overtone: 0.1 }); tone(N.G4, 0.08, 0.22, { gain: 0.15, type: 'triangle', overtone: 0.1 }); },
};

const GROUP = {
  join: 'notifications.soundJoinLeave', leave: 'notifications.soundJoinLeave',
  message: 'notifications.soundMessage',
  mute: 'notifications.soundMute', unmute: 'notifications.soundMute',
  deafen: 'notifications.soundMute', undeafen: 'notifications.soundMute',
};

export const SOUND_NAMES = Object.keys(SOUNDS);

export function previewSound(name) {
  if (!SOUNDS[name] || !audio()) return false;
  try { SOUNDS[name](); return true; } catch { return false; }
}

export function playSound(name) {
  if (!SOUNDS[name]) return false;
  if (!prefs.get('notifications.sounds')) return false;
  if (GROUP[name] && !prefs.get(GROUP[name])) return false;
  // без жеста пользователя браузер не даст играть — не создаём контекст зря
  if (!ctx && navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
  return previewSound(name);
}

// AudioContext создаём лениво — при первом звуке (после жеста пользователя страница уже «активирована»);
// если он уже есть и был приостановлен — возобновляем на жест.
function unlockOnce() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
export function initSounds() {
  window.addEventListener('pointerdown', unlockOnce, { capture: true, passive: true });
  window.addEventListener('keydown', unlockOnce, { capture: true });
  prefs.subscribe('audio.outputDeviceId', () => applySink());
}
