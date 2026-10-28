// Ошибка с HTTP-статусом (обработчик ошибок REST отдаёт { error, code? }).
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}
