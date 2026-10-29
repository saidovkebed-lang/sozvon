// Админ-панель экземпляра: инициализация и подключение к серверу.
import { initAdminAccess } from './access.js';
import { initAudit } from './audit.js';
import { initUpdate } from './update.js';
import { initHealth } from './health.js';
import { initAlerts } from './alerts.js';
import { startControl } from './control.js';
import { createAdminRouter } from './routes.js';

let dataDir = null;

/** Сразу после initDb: настройки, журнал, версия. */
export function initAdmin({ dataDir: d, rootDir }) {
  dataDir = d;
  initAdminAccess(d);
  initAudit(d);
  initUpdate({ dataDir: d, rootDir });
}

/** После attachRealtime: роутер /api (монтировать ДО основного API), проверки и канал для admin.sh. */
export function mountAdmin({ realtime, sfu }) {
  initHealth({ dataDir, sfu, realtime });
  initAlerts(dataDir);
  startControl(dataDir);
  return createAdminRouter({ realtime });
}
