// Мост для обновления установленного сервера со старой версии deploy/update.sh.
// Старый update.sh не знает о новых шагах (yt-dlp, таймер автообновления, новые службы systemd),
// но делает `npm ci` в /opt/sozvon от root — npm вызывает этот postinstall, и он доделывает
// установку: `deploy/update.sh --post-npm` (без перезапуска — его выполнит старый update.sh).
// В любом другом месте (разработка, тесты, install.sh/update.sh новой версии) ничего не делает.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const APP_DIR = '/opt/sozvon';
const skip =
  process.env.SOZVON_DEPLOY ||
  process.platform !== 'linux' ||
  typeof process.getuid !== 'function' || process.getuid() !== 0 ||
  path.resolve(process.cwd()) !== APP_DIR ||
  !fs.existsSync('/etc/sozvon.env') ||
  !fs.existsSync('/run/systemd/system') ||
  !fs.existsSync(path.join(APP_DIR, 'deploy', 'update.sh'));

if (!skip) {
  const r = spawnSync('bash', [path.join(APP_DIR, 'deploy', 'update.sh'), '--post-npm'], {
    stdio: 'inherit', env: { ...process.env, SOZVON_DEPLOY: '1' }, timeout: 20 * 60_000,
  });
  if (r.status !== 0) console.error('[sozvon] Доустановка не завершилась — запустите ещё раз: sudo bash /opt/sozvon/deploy/update.sh');
}
process.exit(0);
