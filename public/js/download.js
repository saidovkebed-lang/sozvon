// «Скачать приложение для ПК» (SPEC-v3 §4): данные из GET /api/app/latest
// → {version, publishedAt?, notes?, files:[{name,url,size,platform:'win'|'linux'|'mac',kind}]}.
// Используется на экране входа, в «О приложении» и на странице /download. Внутри приложения — скрыто.
import { h, icon, fmtSize } from './util.js';

let cache = null;

export function fetchLatest() {
  if (!cache) {
    cache = fetch('/api/app/latest', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { version: null, files: [] }))
      .catch(() => ({ version: null, files: [] }))
      .then((d) => ({ version: d?.version || null, publishedAt: d?.publishedAt || null, notes: d?.notes || '', files: Array.isArray(d?.files) ? d.files : [] }));
  }
  return cache;
}

export function detectPlatform() {
  const ua = navigator.userAgent || '';
  const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (/android|iphone|ipad|ipod/i.test(ua)) return 'mobile';
  if (p.includes('win') || /windows/i.test(ua)) return 'win';
  if (p.includes('mac') || /mac os/i.test(ua)) return 'mac';
  if (p.includes('linux') || /linux/i.test(ua)) return 'linux';
  return 'win';
}

const PLATFORM = {
  win: { name: 'Windows', icon: 'i-windows' },
  linux: { name: 'Linux', icon: 'i-linux' },
  mac: { name: 'macOS', icon: 'i-apple' },
};

const KIND = {
  installer: 'Установщик',
  portable: 'Портативная версия (.zip)',
  appimage: 'AppImage',
  dmg: 'Образ диска (.dmg)',
  deb: 'Пакет .deb',
};

export const normPlatform = (p) => {
  const s = String(p || '').toLowerCase();
  if (s.startsWith('win')) return 'win';
  if (s.startsWith('mac') || s === 'darwin') return 'mac';
  if (s.startsWith('linux')) return 'linux';
  return s || 'win';
};

function kindLabel(f) {
  if (KIND[f.kind]) return KIND[f.kind];
  if (/\.exe$/i.test(f.name)) return 'Установщик';
  if (/\.zip$/i.test(f.name)) return 'Портативная версия (.zip)';
  if (/\.appimage$/i.test(f.name)) return 'AppImage';
  return f.name;
}

/** Главный файл для платформы: установщик → остальное */
export function primaryFile(files, platform) {
  const list = files.filter((f) => normPlatform(f.platform) === platform);
  const order = ['installer', 'appimage', 'dmg', 'portable'];
  return list.sort((a, b) => (order.indexOf(a.kind) + 10) % 10 - (order.indexOf(b.kind) + 10) % 10)[0] || null;
}

function safeHref(url) {
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#';
  } catch { return '#'; }
}

/** Карточка загрузок (для «О приложении» и /download) */
export async function renderDownloads(box, { full = false } = {}) {
  box.replaceChildren(h('p', { class: 'dl__loading' }, 'Проверяю последнюю версию…'));
  const data = await fetchLatest();
  const me = detectPlatform();
  if (!data.version || !data.files.length) {
    box.replaceChildren(h('div', { class: 'dl__empty' }, icon('i-monitor', 'icon--lg'),
      h('div', null, h('strong', null, 'Приложение для ПК скоро появится'),
        h('p', null, 'Сборка ещё не опубликована на этом сервере. Пока можно установить Astra как веб-приложение (кнопка в адресной строке браузера).'))));
    return data;
  }
  const main = primaryFile(data.files, me === 'mobile' ? 'win' : me);
  const nodes = [];
  if (main) {
    nodes.push(h('a', { class: 'btn btn--primary dl__main download-file', href: safeHref(main.url), download: main.name, dataset: { platform: normPlatform(main.platform), kind: main.kind || '' } },
      icon('i-download'),
      h('span', null, `Скачать для ${PLATFORM[normPlatform(main.platform)]?.name || main.platform}`),
      main.size ? h('small', null, fmtSize(main.size)) : null));
  }
  const groups = ['win', 'linux', 'mac'].map((p) => ({ p, files: data.files.filter((f) => normPlatform(f.platform) === p) })).filter((g) => g.files.length);
  nodes.push(h('div', { class: 'dl__grid' + (full ? ' dl__grid--full' : '') }, ...groups.map((g) => h('div', { class: 'dl__platform' + (g.p === me ? ' is-current' : '') },
    h('div', { class: 'dl__platform-head' }, icon(PLATFORM[g.p]?.icon || 'i-monitor'), h('span', null, PLATFORM[g.p]?.name || g.p)),
    ...g.files.map((f) => h('a', { class: 'dl__file download-file', href: safeHref(f.url), download: f.name, dataset: { platform: g.p, kind: f.kind || '' } },
      h('span', { class: 'dl__file-name' }, kindLabel(f)),
      h('span', { class: 'dl__file-size' }, f.size ? fmtSize(f.size) : ''),
      icon('i-download', 'icon--sm')))))));
  if (!data.files.some((f) => normPlatform(f.platform) === 'mac')) {
    nodes.push(h('p', { class: 'dl__note' }, 'Сборки для macOS пока нет: её нельзя собрать на Linux-сервере.'));
  }
  if (full) {
    nodes.push(h('p', { class: 'dl__note' }, icon('i-info', 'icon--sm'),
      'Приложение не подписано сертификатом, поэтому Windows может показать «Система Windows защитила ваш компьютер». Нажмите «Подробнее» → «Выполнить в любом случае».'));
  }
  box.replaceChildren(...nodes);
  return data;
}

/** Кнопка на экране входа: версия + прямая ссылка на главный файл */
export async function initAuthDownload(link) {
  if (!link || window.sozvonDesktop?.isDesktop) return;
  const me = detectPlatform();
  if (me === 'mobile') return;
  link.hidden = false;
  const data = await fetchLatest();
  const ver = link.querySelector('#auth-download-ver');
  if (data.version && ver) ver.textContent = `Версия ${data.version} · ${PLATFORM[me]?.name || ''}`.trim();
}
