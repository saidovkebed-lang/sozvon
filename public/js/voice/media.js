// Захват медиа: микрофон, камера, экран. Ошибки → понятные русские сообщения.

export class MediaError extends Error {
  constructor(message, { cancelled = false } = {}) { super(message); this.cancelled = cancelled; }
}

export function ensureMediaApi(method) {
  return ensureApi(method);
}

function ensureApi(method) {
  if (!window.isSecureContext) throw new MediaError('Голос и видео работают только по HTTPS (или на localhost)');
  if (!navigator.mediaDevices?.[method]) throw new MediaError('Браузер не поддерживает захват медиа');
}

export function explainMediaError(err, what) {
  return explain(err, what);
}

function explain(err, what) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return new MediaError(`Нет доступа к ${what}: разрешение отклонено`, { cancelled: true });
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new MediaError(`Не найдено устройство: ${what}`);
  if (name === 'NotReadableError' || name === 'AbortError') return new MediaError(`Устройство занято другим приложением: ${what}`);
  return new MediaError(`Не удалось получить ${what}: ${err?.message || name || 'ошибка'}`);
}

export async function getMic() {
  ensureApi('getUserMedia');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) { throw explain(e, 'микрофону'); }
}

export async function getCamera() {
  ensureApi('getUserMedia');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (e) { throw explain(e, 'камере'); }
}

/** video — констрейнты качества (v3 §2.4), audio — передавать звук экрана */
// Звук экрана БЕЗ звука самого «Созвона»: иначе в трансляцию попадают голоса звонка и зрители
// слышат себя и собеседников дважды (restrictOwnAudio — Chrome/Edge/Яндекс 138+, Electron).
function screenAudioConstraints() {
  const sup = navigator.mediaDevices.getSupportedConstraints?.() || {};
  const a = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (sup.restrictOwnAudio) a.restrictOwnAudio = true;
  if (sup.suppressLocalAudioPlayback) a.suppressLocalAudioPlayback = false;
  return a;
}

export const screenAudioIsolated = () => !!navigator.mediaDevices?.getSupportedConstraints?.().restrictOwnAudio;

export async function getScreen({ video = { frameRate: { ideal: 30 } }, audio = true } = {}) {
  ensureApi('getDisplayMedia');
  const opts = (withAudio) => ({
    video,
    audio: withAudio ? screenAudioConstraints() : false,
    systemAudio: withAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  });
  try {
    return await navigator.mediaDevices.getDisplayMedia(opts(audio));
  } catch (e) {
    if (e?.name === 'NotAllowedError' || (e?.name === 'AbortError' && !audio)) {
      throw new MediaError('Демонстрация экрана отменена', { cancelled: true });
    }
    // «Устройство занято» (NotReadableError) почти всегда — системный звук: на части компьютеров
    // Windows не отдаёт его. Повторяем без звука, чтобы трансляция всё равно запустилась.
    if (audio && (e?.name === 'NotReadableError' || e?.name === 'AbortError' || e?.name === 'OverconstrainedError' || e?.name === 'TypeError')) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia(opts(false));
        s.audioFallback = true;
        return s;
      } catch (e2) {
        if (e2?.name === 'NotAllowedError' || e2?.name === 'AbortError') throw new MediaError('Демонстрация экрана отменена', { cancelled: true });
        throw explain(e2, 'экрану');
      }
    }
    throw explain(e, 'экрану');
  }
}

/**
 * Только звук системы для своего захвата экрана (приложение для ПК, Windows): getDisplayMedia, где мост
 * отдаёт вместо картинки кадр самой страницы (без захвата экрана ОС) — картинку сразу останавливаем.
 * null — звук недоступен.
 */
export async function getScreenAudio(sourceId) {
  const D = window.sozvonDesktop;
  if (D?.platform !== 'win32' || !D.selectScreenSource) return null;
  try {
    if (await D.selectScreenSource(sourceId, { audioOnly: true }) === false) return null;
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: screenAudioConstraints(), systemAudio: 'include' });
    s.getVideoTracks().forEach((t) => t.stop());
    return s.getAudioTracks()[0] || null;
  } catch (e) {
    console.warn('[media] звук экрана', e);
    return null;
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
}
