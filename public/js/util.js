// Общие DOM-хелперы. Пользовательский текст вставляется только через textContent / text-узлы.

const SVG_NS = 'http://www.w3.org/2000/svg';
export const ICONS = '/assets/icons.svg';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', ('icon ' + extraClass).trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(svg, name) {
  const use = svg?.querySelector('use');
  if (use) use.setAttribute('href', `${ICONS}#${name}`);
}

export function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#5865f2';
}

export function firstLetter(name) {
  const s = String(name || '?').trim();
  return (Array.from(s)[0] || '?').toUpperCase();
}

export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return words.slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase();
}

/** Отображаемое имя: displayName (v3) или username */
export function displayName(user) {
  const d = user?.displayName;
  return (typeof d === 'string' && d.trim()) ? d.trim() : (user?.username || '?');
}

/** Безопасный url медиа: только свои /media/… (или data:/blob: для предпросмотра) */
export function safeMediaUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^\/media\//.test(url) || /^(blob|data:image)\b/.test(url)) return url;
  try {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) return u.pathname + u.search;
  } catch { /* не url */ }
  return null;
}

/**
 * Аватар: круг с буквой на фоне --c; если у пользователя есть картинка — <img class="avatar__img">.
 * Анимированная версия лежит в data-animated и включается при наведении на строку (initAvatarHover)
 * или всегда, если animate=true (попап профиля). Уважает уменьшение движения.
 */
export function avatar(user, size = '', { animate = false } = {}) {
  const el = h('div', {
    class: 'avatar' + (size ? ` avatar--${size}` : ''),
    style: { '--c': safeColor(user?.color) },
    'aria-hidden': 'true',
  }, firstLetter(user?.username));
  setAvatarImage(el, user, { animate });
  // Astra 2.0: рамка аватара (рисует CSS по data-frame; на мелких аватарах не показываем)
  const frame = user?.avatarFrame;
  if (size !== 'sm' && typeof frame === 'string' && /^[a-z]{3,20}$/.test(frame)) el.dataset.frame = frame;
  return el;
}

/** Обновить картинку существующего .avatar (user-panel, тайлы) */
export function setAvatarImage(el, user, { animate = false } = {}) {
  if (!el) return;
  const stat = safeMediaUrl(user?.avatar);
  const anim = safeMediaUrl(user?.avatarAnimated);
  let img = el.querySelector(':scope > img.avatar__img');
  if (!stat && !anim) {
    img?.remove();
    el.classList.remove('has-img');
    if (!el.firstChild || el.firstChild.nodeType !== 3) el.prepend(firstLetter(user?.username));
    return;
  }
  const want = animate && anim && !motionReduced() ? anim : (stat || anim);
  if (!img) {
    img = document.createElement('img');
    img.className = 'avatar__img';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', () => { img.remove(); el.classList.remove('has-img'); });
    el.append(img);
  }
  img.dataset.static = stat || anim;
  if (anim && anim !== stat) img.dataset.animated = anim; else delete img.dataset.animated;
  if (img.getAttribute('src') !== want) img.src = want;
  el.classList.add('has-img');
  // буква остаётся текстовым узлом под картинкой (фолбэк, если файл не загрузится)
}

export function motionReduced() {
  const rm = document.documentElement.dataset.reduceMotion;
  if (rm === 'on') return true;
  if (rm === 'off') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Анимированные аватары оживают при наведении на сообщение / участника / голосового участника */
export function initAvatarHover() {
  const ROW = '.message, .member, .voice-user, .tile, .sm-member, .context-menu__head, .role-member';
  const swap = (row, on) => {
    row.querySelectorAll('img.avatar__img[data-animated]').forEach((img) => {
      if (img.closest('.profile-popup')) return;
      const next = on && !motionReduced() ? img.dataset.animated : img.dataset.static;
      if (next && img.getAttribute('src') !== next) img.src = next;
    });
  };
  document.addEventListener('pointerover', (e) => {
    const row = e.target.closest?.(ROW);
    if (row && !row.contains(e.relatedTarget)) swap(row, true);
  });
  document.addEventListener('pointerout', (e) => {
    const row = e.target.closest?.(ROW);
    if (row && !row.contains(e.relatedTarget)) swap(row, false);
  });
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfDay) return `Сегодня в ${fmtClock(ms)}`;
  if (ms >= startOfDay - 86400000) return `Вчера в ${fmtClock(ms)}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${fmtClock(ms)}`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}

/* ---------- markdown-лайт → DOM (без innerHTML) ---------- */

const TOKEN_RE = /(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|(https?:\/\/[^\s<>"]+)/g;

function linkNode(url) {
  // обрезаем завершающую пунктуацию
  let trail = '';
  const m = url.match(/[.,!?;:)\]]+$/);
  if (m) { trail = m[0]; url = url.slice(0, -trail.length); }
  let safe = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') safe = u.href;
  } catch { /* не ссылка */ }
  const nodes = [];
  if (safe) nodes.push(h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
  else nodes.push(document.createTextNode(url));
  if (trail) nodes.push(document.createTextNode(trail));
  return nodes;
}

function inline(text, depth = 0) {
  const out = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const [tok, code, bold, ital, url] = m;
    if (code) out.push(h('code', null, code.slice(1, -1)));
    else if (bold) out.push(h('strong', null, depth < 3 ? inline(bold.slice(2, -2), depth + 1) : bold.slice(2, -2)));
    else if (ital) out.push(h('em', null, depth < 3 ? inline(ital.slice(1, -1), depth + 1) : ital.slice(1, -1)));
    else if (url) out.push(...linkNode(url));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  String(text || '').split('\n').forEach((line, i) => {
    if (i > 0) frag.append(h('br'));
    frag.append(...inline(line));
  });
  return frag;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function lsGet(key, def = null) {
  try { const v = localStorage.getItem(key); return v == null ? def : v; } catch { return def; }
}
export function lsSet(key, val) {
  try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, String(val)); } catch { /* ignore */ }
}
