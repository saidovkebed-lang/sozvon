// Публичная ссылка без VPN и без проброса портов: Cloudflare Quick Tunnel.
// Бесплатно, без аккаунта. cloudflared скачивается автоматически в DATA_DIR/bin.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
// api.trycloudflare.com встречается в сообщениях об ошибках — это не ссылка туннеля
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

let publicUrl = null;
let child = null;

export const getPublicUrl = () => publicUrl;

function assetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
  if (!arch) throw new Error(`архитектура ${process.arch} не поддерживается`);
  if (process.platform === 'win32') return `cloudflared-windows-${arch}.exe`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  throw new Error(`ОС ${process.platform} не поддерживается`);
}

function inPath() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`скачивание не удалось: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

async function ensureBinary(dataDir) {
  if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;
  const found = inPath();
  if (found) return found;

  const binDir = path.join(dataDir, 'bin');
  const exe = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(exe)) return exe;

  fs.mkdirSync(binDir, { recursive: true });
  const asset = assetName();
  console.log(`[share] Скачиваю cloudflared (${asset}, ~40 МБ, один раз)…`);
  if (asset.endsWith('.tgz')) {
    const tgz = path.join(binDir, asset);
    await download(RELEASES + asset, tgz);
    const r = spawnSync('tar', ['-xzf', tgz, '-C', binDir]);
    fs.rmSync(tgz, { force: true });
    if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('не удалось распаковать cloudflared');
  } else {
    await download(RELEASES + asset, exe);
  }
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  return exe;
}

/**
 * Запускает туннель к локальному серверу. Резолвится публичным URL.
 * При обрыве перезапускает cloudflared (URL при этом меняется — печатаем новый).
 */
export async function startTunnel({ dataDir, port, https: useHttps, onUrl }) {
  const bin = await ensureBinary(dataDir);
  const target = `${useHttps ? 'https' : 'http'}://localhost:${port}`;
  let stopped = false;
  let restarts = 0;

  const run = () => new Promise((resolve, reject) => {
    const args = ['tunnel', '--no-autoupdate', '--url', target];
    if (useHttps) args.push('--no-tls-verify');
    // Пустой конфиг: иначе ~/.cloudflared/config.yml пользователя ломает quick tunnel
    args.unshift('--config', path.join(os.tmpdir(), 'sozvon-cloudflared-none.yml'));
    fs.writeFileSync(path.join(os.tmpdir(), 'sozvon-cloudflared-none.yml'), '');

    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let got = false;
    let lastLine = '';
    const timer = setTimeout(() => {
      if (!got) reject(new Error('cloudflared не выдал ссылку за 45 с (нет интернета или Cloudflare недоступен)'));
    }, 45_000);
    const onData = (chunk) => {
      const text = String(chunk);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) lastLine = lines.at(-1).replace(/^\S+Z\s+\w{3}\s+/, '');
      const m = text.match(URL_RE);
      if (m && !got) {
        got = true;
        clearTimeout(timer);
        publicUrl = m[0];
        onUrl?.(publicUrl);
        resolve(publicUrl);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      publicUrl = null;
      if (!got) return reject(new Error(`cloudflared завершился с кодом ${code}: ${lastLine || 'без сообщения'}`));
      if (stopped) return;
      if (++restarts > 20) return console.error('[share] Туннель падает слишком часто — остановлен.');
      console.warn('[share] Туннель оборвался, переподключаюсь через 5 с (ссылка изменится)…');
      setTimeout(() => run().catch((e) => console.error('[share]', e.message)), 5000);
    });
  });

  const stop = () => { stopped = true; child?.kill(); };
  process.on('exit', stop);
  return { url: await run(), stop };
}
