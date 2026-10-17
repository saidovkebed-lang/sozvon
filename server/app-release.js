// Приложение для ПК (SPEC-v3 §4): описание релиза из DATA_DIR/app-release.json
// (его пишет deploy/update.sh / deploy/app-release.sh), файлы — DATA_DIR/downloads → /media/downloads/*.
import fs from 'node:fs';
import path from 'node:path';

const PLATFORMS = ['win', 'linux', 'mac'];
let cache = { mtimeMs: -1, value: null };

const EMPTY = () => ({ version: null, files: [] });

export function readAppRelease(dataDir) {
  const file = path.join(dataDir, 'app-release.json');
  const downloads = path.join(dataDir, 'downloads');
  let st;
  try { st = fs.statSync(file); } catch { cache = { mtimeMs: -1, value: null }; return EMPTY(); }
  if (cache.value && cache.mtimeMs === st.mtimeMs) return cache.value;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    console.error('[app] app-release.json повреждён:', err.message);
    return EMPTY();
  }
  const version = typeof raw?.version === 'string' && /^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(raw.version.replace(/^v/, ''))
    ? raw.version.replace(/^v/, '') : null;
  const files = [];
  for (const f of Array.isArray(raw?.files) ? raw.files : []) {
    const name = typeof f?.name === 'string' ? path.basename(f.name) : '';
    if (!name || name.startsWith('.')) continue;
    const local = path.join(downloads, name);
    let size = Number.isFinite(f.size) ? f.size : 0;
    try { size = fs.statSync(local).size; } catch { continue; } // отдаём только то, что реально лежит у нас
    files.push({
      name, url: '/media/downloads/' + encodeURIComponent(name), size,
      platform: PLATFORMS.includes(f.platform) ? f.platform : guessPlatform(name).platform,
      kind: typeof f.kind === 'string' ? f.kind.slice(0, 20) : guessPlatform(name).kind,
    });
  }
  const value = {
    version: files.length ? version : null,
    tag: typeof raw?.tag === 'string' ? raw.tag.slice(0, 64) : null,
    publishedAt: typeof raw?.publishedAt === 'string' ? raw.publishedAt.slice(0, 40) : null,
    notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 5000) : '',
    files,
  };
  cache = { mtimeMs: st.mtimeMs, value };
  return value;
}

export function guessPlatform(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.appimage')) return { platform: 'linux', kind: 'appimage' };
  if (n.endsWith('.deb')) return { platform: 'linux', kind: 'deb' };
  if (n.endsWith('.dmg')) return { platform: 'mac', kind: 'dmg' };
  if (n.endsWith('.exe')) return { platform: 'win', kind: n.includes('setup') ? 'installer' : 'portable' };
  if (n.endsWith('.zip')) return { platform: n.includes('mac') || n.includes('darwin') ? 'mac' : 'win', kind: 'portable' };
  return { platform: 'win', kind: 'other' };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = (n) => (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
const LABELS = {
  'win:installer': 'Windows — установщик', 'win:portable': 'Windows — портативная версия (zip)',
  'linux:appimage': 'Linux — AppImage', 'linux:deb': 'Linux — .deb', 'mac:dmg': 'macOS', 'mac:portable': 'macOS (zip)',
};

/** Простая страница /download (если у клиента нет public/download.html). */
export function renderDownloadPage(rel) {
  const items = rel.files.map((f) => `<li><a href="${esc(f.url)}" download>${esc(LABELS[`${f.platform}:${f.kind}`] || f.name)}</a>
    <span>${esc(f.name)} · ${mb(f.size)}</span></li>`).join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Созвон для ПК</title><style>
:root{color-scheme:dark}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;min-height:100vh}
main{max-width:560px;padding:32px 16px}h1{margin:0 0 8px;color:#fff}ul{list-style:none;padding:0}li{margin:12px 0;padding:14px 16px;background:#2b2d31;border-radius:8px}
a{color:#8ea1ff;font-weight:600}span{display:block;font-size:13px;color:#949ba4}p.small{font-size:13px;color:#949ba4}</style></head>
<body><main><h1>Созвон для ПК</h1>
${rel.version ? `<p>Версия ${esc(rel.version)}</p><ul>${items}</ul>
<p class="small">Приложение не подписано: Windows SmartScreen может предупредить — нажмите «Подробнее» → «Выполнить в любом случае».</p>`
    : '<p>Приложение для ПК пока не опубликовано на этом сервере. Пользуйтесь браузерной версией.</p>'}
<p><a href="/">← Вернуться в Созвон</a></p></main></body></html>`;
}
