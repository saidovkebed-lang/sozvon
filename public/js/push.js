// Push-уведомления (Web Push): личные сообщения и упоминания приходят, даже когда Созвон закрыт.
// Подписка — на это устройство/браузер; сервер шлёт push, только если ни одно окно Созвона не на виду.
// В приложении для ПК не нужно (оно работает в трее и показывает уведомления само).
import { state, notify } from './state.js';
import { api } from './api.js';
import { prefs } from './prefs.js';
import { isDesktop } from './desktop.js';

const PREF = 'notifications.push';
let active = false; // подписка этого устройства действует (тогда страница сама не дублирует уведомления о ЛС/упоминаниях)

export const pushActive = () => active;

/** 'ok' | 'desktop' | 'unsupported' | 'insecure' | 'ios-install' | 'server-off' */
export function pushSupport() {
  if (isDesktop()) return 'desktop';
  if (!window.isSecureContext) return 'insecure';
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification !== 'function') return ios && !standalone ? 'ios-install' : 'unsupported';
  if (!state.pushKey) return 'server-off';
  return 'ok';
}

function keyBytes(b64u) {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (sub) => {
  const k = sub?.options?.applicationServerKey;
  if (!k || !state.pushKey) return true;
  const a = new Uint8Array(k);
  const b = keyBytes(state.pushKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

async function registration() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Service worker не запустился')), 10000))]);
}

/** Включить push на этом устройстве (вызывать по жесту пользователя). Возвращает статус строкой. */
export async function enablePush() {
  const sup = pushSupport();
  if (sup !== 'ok') return sup;
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission().catch(() => Notification.permission);
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'default';
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.pushKey) });
  await api.pushSubscribe(sub.toJSON());
  prefs.set(PREF, true);
  active = true;
  notify('push');
  return 'granted';
}

/** Выключить push на этом устройстве */
export async function disablePush({ silent = false } = {}) {
  active = false;
  if (!silent) prefs.set(PREF, false);
  if (pushSupport() !== 'ok') return;
  const reg = await registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  notify('push');
}

/** После входа/переподключения: подписка, включённая раньше, снова привязывается к аккаунту на сервере */
export async function syncPushSubscription() {
  if (!prefs.get(PREF) || pushSupport() !== 'ok' || Notification.permission !== 'granted') { active = false; return; }
  try {
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.pushKey) });
    await api.pushSubscribe(sub.toJSON());
    active = true;
  } catch (e) {
    active = false;
    console.warn('[push]', e?.message || e);
  }
  notify('push');
}

export function initPush() {
  // разрешение отозвали в настройках браузера — подписка больше не работает
  if (typeof Notification === 'function' && Notification.permission === 'denied') active = false;
}
