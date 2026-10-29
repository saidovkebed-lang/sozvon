// Внутренние события сервера для необязательных модулей (Telegram-бот server/tgbot.js и т. п.), без
// циклических импортов: realtime.js/routes.js сообщают, подписчики реагируют. Ошибка подписчика никогда
// не ломает основное действие.
//   notify     (userId, notification, message, { active })  — новое уведомление («Входящие»/push)
//   registered (user)                                      — новый аккаунт
//   joined     (server, user, { via })                     — пользователь вошёл на сервер
const subs = new Map();

export function on(event, fn) {
  if (!subs.has(event)) subs.set(event, []);
  subs.get(event).push(fn);
}

export function emit(event, ...args) {
  for (const fn of subs.get(event) || []) {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((err) => console.warn(`[events] ${event}:`, err?.message || err));
    } catch (err) {
      console.warn(`[events] ${event}:`, err?.message || err);
    }
  }
}
