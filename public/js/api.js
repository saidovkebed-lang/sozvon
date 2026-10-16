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
};
