// REST-клиент + хранение токена
import { lsGet, lsSet } from './util.js';

const TOKEN_KEY = 'sozvon.token';

export const getToken = () => lsGet(TOKEN_KEY);
export const setToken = (t) => lsSet(TOKEN_KEY, t);

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, body, { auth = true } = {}) {
  const headers = {};
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError('Нет связи с сервером', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) {
    const msg = data?.error || (res.status === 413 ? 'Файл слишком большой' : `Ошибка сервера (${res.status})`);
    throw new ApiError(msg, res.status);
  }
  return data;
}

export const api = {
  register: (username, password) => request('POST', '/api/register', { username, password }, { auth: false }),
  login: (username, password) => request('POST', '/api/login', { username, password }, { auth: false }),
  me: () => request('GET', '/api/me'),
  config: () => request('GET', '/api/config', undefined, { auth: false }),
  uploadAttachment(file) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'image.png');
    return request('POST', '/api/attachments', fd);
  },
  musicList: () => request('GET', '/api/music'),
  musicUpload(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request('POST', '/api/music/upload', fd);
  },
  musicImport: (url) => request('POST', '/api/music/import', { url }),
  musicDelete: (id) => request('DELETE', `/api/music/${encodeURIComponent(id)}`),
  // v3: профиль
  patchMe: (body) => request('PATCH', '/api/me', body),
  uploadAvatar: (file, crop) => request('POST', '/api/me/avatar', mediaForm(file, crop)),
  deleteAvatar: () => request('DELETE', '/api/me/avatar'),
  uploadBanner: (file, crop) => request('POST', '/api/me/banner', mediaForm(file, crop)),
  deleteBanner: () => request('DELETE', '/api/me/banner'),
  // v3: иконка/баннер сервера (MANAGE_SERVER)
  uploadServerIcon: (serverId, file, crop) => request('POST', `/api/servers/${encodeURIComponent(serverId)}/icon`, mediaForm(file, crop)),
  uploadServerBanner: (serverId, file, crop) => request('POST', `/api/servers/${encodeURIComponent(serverId)}/banner`, mediaForm(file, crop)),
  // v3: приложение для ПК
  appLatest: () => request('GET', '/api/app/latest', undefined, { auth: false }),
  // push-уведомления (Web Push)
  pushSubscribe: (subscription) => request('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => request('POST', '/api/push/unsubscribe', { endpoint }),
};

/** multipart: file + необязательное кадрирование {x,y,size} или {x,y,width,height} в пикселях исходника */
function mediaForm(file, crop) {
  const fd = new FormData();
  if (crop) for (const [k, v] of Object.entries(crop)) if (Number.isFinite(v)) fd.append(k, String(Math.round(v)));
  fd.append('file', file, file.name || 'image.png');
  return fd;
}
