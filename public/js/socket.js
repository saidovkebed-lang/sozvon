// Обёртка Socket.IO: emitAck → Promise
let socket = null;
const handlers = [];

export function connect(token) {
  /* global io */
  socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
  for (const [ev, fn] of handlers) socket.on(ev, fn);
  return socket;
}

export function getSocket() { return socket; }
export function socketId() { return socket?.id || null; }

/** Подписка (работает и до connect) */
export function on(ev, fn) {
  handlers.push([ev, fn]);
  if (socket) socket.on(ev, fn);
}

export function emit(ev, payload) {
  if (socket?.connected) socket.emit(ev, payload);
}

export function emitAck(ev, payload, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) { reject(new Error('Нет соединения с сервером')); return; }
    const args = payload === undefined ? [] : [payload];
    socket.timeout(timeout).emit(ev, ...args, (err, res) => {
      if (err) reject(new Error('Сервер не ответил'));
      else if (!res || res.ok === false) reject(new Error(res?.error || 'Ошибка'));
      else resolve(res);
    });
  });
}

export function disconnect() {
  if (socket) { socket.disconnect(); socket = null; }
}
