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
export async function getScreen({ video = { frameRate: { ideal: 30 } }, audio = true } = {}) {
  ensureApi('getDisplayMedia');
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio });
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
      throw new MediaError('Демонстрация экрана отменена', { cancelled: true });
    }
    throw explain(e, 'экрану');
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
}
