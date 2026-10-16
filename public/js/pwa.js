// PWA: регистрация service worker, кнопка «Установить приложение», подсказка для iOS.
import { $ } from './util.js';
import { toast, toastOk } from './ui/toasts.js';

const IOS_HINT_KEY = 'sozvon:ios-install-hint';
let deferredPrompt = null;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// iPadOS 13+ представляется Mac'ом — отличаем по тачу
const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } }

function showIosHint() {
  toast('Чтобы поставить Созвон как приложение: нажми «Поделиться» внизу Safari → «На экран „Домой“».', '', 10000);
}

function setInstallVisible(visible) {
  const btn = $('#btn-install');
  if (btn) btn.hidden = !visible;
}

function registerServiceWorker() {
  // SW работает только в secure context (HTTPS или localhost)
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => {
      // например, самоподписанный сертификат в LAN — приложение работает и без SW
      console.info('[pwa] service worker не зарегистрирован:', e?.message || e);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sozvon:shell-updated') {
      toast('Созвон обновился — перезагрузи страницу, чтобы получить новую версию.', '', 8000);
    }
  });
}

export function initPwa() {
  registerServiceWorker();

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // свой ненавязчивый вход вместо баннера браузера
    deferredPrompt = e;
    setInstallVisible(true);
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setInstallVisible(false);
    toastOk('Созвон установлен как приложение');
  });

  // на iOS нет beforeinstallprompt: кнопка показывает инструкцию
  if (isIos() && !isStandalone()) setInstallVisible(true);

  $('#btn-install')?.addEventListener('click', async () => {
    if (deferredPrompt) {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      try {
        await prompt.prompt();
        const { outcome } = await prompt.userChoice;
        if (outcome === 'accepted') setInstallVisible(false);
      } catch { /* prompt уже использован */ }
      if (!deferredPrompt && !isIos()) setInstallVisible(false);
    } else if (isIos()) {
      showIosHint();
      lsSet(IOS_HINT_KEY, '1');
    }
  });
}

/** Однократная подсказка на iOS — после входа, когда интерфейс уже на экране */
export function maybeShowInstallHint() {
  if (!isIos() || isStandalone() || lsGet(IOS_HINT_KEY)) return;
  lsSet(IOS_HINT_KEY, '1');
  setTimeout(showIosHint, 1500);
}
