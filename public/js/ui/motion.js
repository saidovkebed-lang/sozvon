// Astra 2.0: мягкий переход при смене канала/сервера (Web Animations API: только opacity/transform,
// без принудительной перекладки). Уважает «уменьшение движения».
import { state, subscribe } from '../state.js';
import { motionReduced } from '../util.js';

let lastKey = null;

function onNav() {
  const key = `${state.currentServerId || ''}/${state.currentChannelId || ''}`;
  if (key === lastKey) return;
  const first = lastKey === null;
  lastKey = key;
  if (first || motionReduced()) return;
  const main = document.getElementById('main');
  if (!main || typeof main.animate !== 'function') return;
  for (const id of ['chat-view', 'voice-view', 'home-view']) {
    const el = document.getElementById(id);
    if (!el || el.hidden) continue;
    el.animate(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }
}

export function initMotion() {
  subscribe('nav', () => requestAnimationFrame(onNav));
}
