// «Astra Итоги»: полноэкранные «истории» с итогами сервера за месяц/год (server/stats.js, docs/RECAP.md).
// Вход — кнопка в шапке сервера (#btn-recap) и кнопка «Открыть» в объявлении бота (data-recap-period).
// «Поделиться» рисует карточку на <canvas> прямо в браузере → PNG: скачать или отправить в канал вложением.
import { $, h, safeColor, displayName, safeMediaUrl, motionReduced } from '../util.js';
import { state, getServer } from '../state.js';
import { api, getToken } from '../api.js';
import { emitAck } from '../socket.js';
import { can } from '../perms.js';
import { toast, toastOk, toastError } from './toasts.js';

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const AWARD_EMOJI = { voice: '🎙️', night: '🌙', dj: '🎧', director: '🎬', chatter: '💬', cinephile: '🍿', marathon: '🏃' };
const SVG_NS = 'http://www.w3.org/2000/svg';

let ov = null;      // {root, stage, bar, counter, select, slides, idx, data, serverId, period, lastFocus}

// ---------------------------------------------------------------- helpers --
async function request(method, url, body) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) throw new Error(data?.error || `Ошибка сервера (${res.status})`);
  return data;
}
const recapUrl = (sid, period) => `/api/servers/${encodeURIComponent(sid)}/recap${period ? `?period=${encodeURIComponent(period)}` : ''}`;

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const num = (n) => Number(n || 0).toLocaleString('ru-RU');
function fmtMinutes(min) {
  const m = Math.round(min || 0);
  if (m < 60) return `${m} ${plural(m, 'минута', 'минуты', 'минут')}`;
  const hrs = Math.round(m / 6) / 10;
  return `${hrs.toLocaleString('ru-RU')} ч`;
}
function fmtValue(award) {
  const v = award.value;
  switch (award.unit) {
    case 'min': return fmtMinutes(v);
    case 'tracks': return `${num(v)} ${plural(v, 'трек', 'трека', 'треков')}`;
    case 'messages': return `${num(v)} ${plural(v, 'сообщение', 'сообщения', 'сообщений')}`;
    default: return `${num(Math.round(v))} ${plural(Math.round(v), 'очко', 'очка', 'очков')} ночной активности`;
  }
}
function fmtDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'long' });
  return { big: `${d} ${MONTHS_GEN[m - 1]}`, small: wd };
}
const periodLabel = (p) => (/^\d{4}$/.test(p) ? `${p} год` : `${MONTHS_NOM[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`);
const nowMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

function chartIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  for (const d of ['M5 20V12', 'M12 20V5', 'M19 20v-9']) {
    const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.append(p);
  }
  return svg;
}

function userChip(u, size = 'md') {
  const av = h('span', { class: `recap-avatar recap-avatar--${size}`, style: { '--c': safeColor(u?.color) }, 'aria-hidden': 'true' },
    (displayName(u) || '?').slice(0, 1).toUpperCase());
  const src = safeMediaUrl(u?.avatar);
  if (src) av.append(h('img', { src, alt: '', loading: 'lazy' }));
  return av;
}

// ---------------------------------------------------------------- slides --
function buildSlides(d) {
  const t = d.totals;
  const S = [];
  const slide = (kind, theme, ...children) => S.push({ kind, el: h('section', { class: `recap-slide recap-slide--${theme}`, dataset: { slide: kind } }, ...children) });
  const big = (text) => h('div', { class: 'recap-big' }, text);
  const kicker = (text) => h('div', { class: 'recap-kicker' }, text);
  const cap = (text) => h('p', { class: 'recap-caption' }, text);

  slide('intro', 'violet', kicker('Astra Итоги'), big(d.label), cap(d.server.name),
    h('p', { class: 'recap-hint' }, d.empty ? '' : 'Листайте стрелками или касанием →'));
  if (d.empty) {
    slide('empty', 'night', kicker('Пока тихо'), big('🌱'), cap(d.kind === 'year'
      ? 'За этот год активности ещё не было. Зовите друзей в голосовой!'
      : 'За этот месяц ещё нет активности. Зайдите в голосовой канал или напишите в чат — и итоги появятся.'));
  } else {
    if (t.voiceMinutes > 0) {
      slide('hours', 'blue', kicker('Вместе в голосе'), big(fmtMinutes(t.voiceMinutes)),
        cap(t.voiceMinutes >= 60 ? 'провели вместе в голосовых каналах' : 'в голосовых каналах — это только начало'),
        h('ul', { class: 'recap-facts' },
          h('li', null, `${num(t.sessions)} ${plural(t.sessions, 'заход', 'захода', 'заходов')} в голос`),
          t.peakUsers > 1 ? h('li', null, `до ${t.peakUsers} человек одновременно`) : null));
    }
    if (t.messages > 0) {
      slide('messages', 'pink', kicker('Чат'), big(num(t.messages)), cap(plural(t.messages, 'сообщение', 'сообщения', 'сообщений') + ' в каналах сервера'),
        t.attachments ? h('ul', { class: 'recap-facts' }, h('li', null, `${num(t.attachments)} ${plural(t.attachments, 'вложение', 'вложения', 'вложений')}: фото, видео, файлы`)) : null);
    }
    if (d.busiestDay) {
      const day = fmtDay(d.busiestDay.date);
      slide('day', 'orange', kicker('Самый жаркий день'), big(day.big), cap(day.small),
        h('ul', { class: 'recap-facts' },
          d.busiestDay.voiceMinutes ? h('li', null, `${fmtMinutes(d.busiestDay.voiceMinutes)} в голосе`) : null,
          d.busiestDay.messages ? h('li', null, `${num(d.busiestDay.messages)} ${plural(d.busiestDay.messages, 'сообщение', 'сообщения', 'сообщений')}`) : null,
          d.busiestHour ? h('li', null, `час пик — ${String(d.busiestHour.hour).padStart(2, '0')}:00`) : null));
    }
    for (const a of d.awards) {
      slide(`award-${a.id}`, a.id === 'night' ? 'night' : 'gold', kicker(`${AWARD_EMOJI[a.id] || '🏆'} ${a.title}`),
        h('div', { class: 'recap-winner' }, userChip(a.user, 'xl'), h('div', { class: 'recap-big recap-big--name' }, displayName(a.user))),
        cap(a.caption), h('p', { class: 'recap-value' }, fmtValue(a)));
    }
    if (t.music.plays > 0) {
      slide('music', 'green', kicker('Музыка'), big(`${num(t.music.plays)} ${plural(t.music.plays, 'трек', 'трека', 'треков')}`),
        cap(`${fmtMinutes(t.music.minutes)} музыки · ${num(t.music.manual)} поставили сами, ${num(t.music.autoplay)} — автоплей`),
        d.topTracks.length ? h('ol', { class: 'recap-list', 'aria-label': 'Топ-5 треков' }, d.topTracks.map((tr) =>
          h('li', null, h('span', { class: 'recap-list__title' }, tr.title), tr.artist ? h('span', { class: 'recap-list__sub' }, tr.artist) : null,
            h('span', { class: 'recap-list__n' }, `×${tr.plays}`)))) : null,
        d.topArtists[0] ? h('p', { class: 'recap-value' }, `Главный артист: ${d.topArtists[0].name}`) : null);
    }
    if (t.watch.videos > 0) {
      slide('watch', 'red', kicker('Смотреть вместе'), big(`${num(t.watch.videos)} ${plural(t.watch.videos, 'видео', 'видео', 'видео')}`),
        cap(`${fmtMinutes(t.watch.minutes)} совместного просмотра`),
        d.topVideos.length ? h('ol', { class: 'recap-list' }, d.topVideos.map((v) => h('li', null, h('span', { class: 'recap-list__title' }, v.title)))) : null);
    }
    if (t.streamMinutes > 0) {
      slide('streams', 'blue', kicker('Трансляции'), big(fmtMinutes(t.streamMinutes)), cap('показывали экран друзьям'),
        t.streamViewersPeak ? h('ul', { class: 'recap-facts' }, h('li', null, `до ${t.streamViewersPeak} ${plural(t.streamViewersPeak, 'зрителя', 'зрителей', 'зрителей')} в канале`)) : null);
    }
    if (t.newMembers > 0) {
      slide('joins', 'violet', kicker('Новенькие'), big(`+${num(t.newMembers)}`), cap(`${plural(t.newMembers, 'человек присоединился', 'человека присоединились', 'человек присоединились')} к серверу`));
    }
    if (d.me.participate && d.me.stats) {
      const m = d.me.stats;
      const facts = [
        m.voiceMinutes ? `${fmtMinutes(m.voiceMinutes)} в голосе` : null,
        m.longestSessionMinutes ? `самая долгая сессия — ${fmtMinutes(m.longestSessionMinutes)}` : null,
        m.messages ? `${num(m.messages)} ${plural(m.messages, 'сообщение', 'сообщения', 'сообщений')}` : null,
        m.tracksAdded ? `${num(m.tracksAdded)} ${plural(m.tracksAdded, 'трек поставлен', 'трека поставлено', 'треков поставлено')}` : null,
        m.streamMinutes ? `${fmtMinutes(m.streamMinutes)} трансляций` : null,
        m.watchMinutes ? `${fmtMinutes(m.watchMinutes)} совместного просмотра` : null,
      ].filter(Boolean);
      if (facts.length) {
        slide('me', 'pink', kicker('А это ты'), h('div', { class: 'recap-winner' }, userChip(d.me.user, 'xl'), h('div', { class: 'recap-big recap-big--name' }, displayName(d.me.user))),
          h('ul', { class: 'recap-facts' }, facts.map((f) => h('li', null, f))));
      }
    }
  }
  S.push({ kind: 'share', el: shareSlide(d) });
  return S;
}

function shareSlide(d) {
  const preview = h('img', { class: 'recap-card-preview', alt: `Карточка итогов: ${d.server.name}, ${d.label}` });
  const status = h('p', { class: 'recap-share-status', role: 'status' });
  let blob = null;
  renderCard(d).then((b) => { blob = b; preview.src = URL.createObjectURL(b); preview.dataset.ready = '1'; }).catch(() => { status.textContent = 'Не удалось нарисовать карточку'; });
  const fileName = `astra-itogi-${d.period}.png`;

  const download = h('button', { type: 'button', class: 'btn btn--primary', dataset: { recapAction: 'download' } }, 'Скачать PNG');
  download.addEventListener('click', async () => {
    blob ||= await renderCard(d);
    const a = h('a', { href: URL.createObjectURL(blob), download: fileName });
    document.body.append(a); a.click(); a.remove();
  });

  const server = getServer(d.server.id);
  const textChannels = (server?.channels || []).filter((c) => c.type === 'text' && can(server, 'SEND_MESSAGES', c.id) && can(server, 'ATTACH_FILES', c.id));
  const select = h('select', { class: 'recap-select', 'aria-label': 'Канал для отправки' }, textChannels.map((c) => h('option', { value: c.id }, `#${c.name}`)));
  const send = h('button', { type: 'button', class: 'btn', dataset: { recapAction: 'post' }, disabled: !textChannels.length }, 'Отправить в канал');
  send.addEventListener('click', async () => {
    if (!select.value) return;
    send.disabled = true; status.textContent = 'Отправляю…';
    try {
      blob ||= await renderCard(d);
      const att = await api.uploadAttachment(new File([blob], fileName, { type: 'image/png' }));
      await emitAck('message:send', { channelId: select.value, content: `📊 Итоги «${d.server.name}» — ${d.label}`, attachments: [att] });
      status.textContent = 'Отправлено!';
      toastOk('Карточка итогов отправлена');
    } catch (e) { status.textContent = ''; toastError(e); } finally { send.disabled = false; }
  });

  const part = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: 'recap-participate', checked: !!d.me.participate });
  part.addEventListener('change', async () => {
    try {
      const r = await request('PUT', '/api/me/recap', { participate: part.checked });
      toastOk(r.participate ? 'Вы снова участвуете в Итогах' : 'Вы больше не попадаете в рейтинги Итогов');
      load(ov.serverId, ov.period, { keepSlide: 'share' });
    } catch (e) { part.checked = !part.checked; toastError(e); }
  });
  const settings = h('div', { class: 'recap-settings' },
    h('label', { class: 'recap-toggle', for: 'recap-participate' }, part,
      h('span', null, h('b', null, 'Участвовать в Итогах'), h('small', null, 'Выключите — и вас не будет в рейтингах и наградах, ваши личные цифры удалятся. В общие итоги сервера активность войдёт без имени.'))));
  if (d.settings.canManage) {
    const ann = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: 'recap-announce', checked: !!d.settings.announce });
    ann.addEventListener('change', async () => {
      try {
        await request('PUT', `/api/servers/${encodeURIComponent(d.server.id)}/recap/settings`, { announce: ann.checked });
        toastOk(ann.checked ? 'Бот будет объявлять Итоги' : 'Объявления Итогов выключены');
      } catch (e) { ann.checked = !ann.checked; toastError(e); }
    });
    settings.append(h('label', { class: 'recap-toggle', for: 'recap-announce' }, ann,
      h('span', null, h('b', null, 'Объявлять Итоги в чате'), h('small', null, '1-го числа бот пишет в первый текстовый канал, а в начале января — про весь год.'))));
  }
  return h('section', { class: 'recap-slide recap-slide--share', dataset: { slide: 'share' } },
    h('div', { class: 'recap-kicker' }, 'Поделиться'),
    preview,
    h('div', { class: 'recap-share-actions' }, download, h('div', { class: 'recap-share-post' }, select, send)),
    status, settings);
}

// ---------------------------------------------------------- PNG-карточка --
async function renderCard(d) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2a1a6e'); bg.addColorStop(0.55, '#6a45ff'); bg.addColorStop(1, '#eb459e');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.beginPath(); g.arc(W - 120, 160, 260, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(80, H - 120, 220, 0, Math.PI * 2); g.fill();
  const font = (w, s) => `${w} ${s}px Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const fit = (text, w, size, max) => { let s = size; g.font = font(w, s); while (g.measureText(text).width > max && s > 20) { s -= 2; g.font = font(w, s); } return s; };
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  g.font = font(700, 40); g.globalAlpha = 0.85; g.fillText('ASTRA ИТОГИ', 80, 130); g.globalAlpha = 1;
  fit(d.label, 800, 96, W - 160); g.fillText(d.label, 80, 240);
  fit(d.server.name, 600, 54, W - 160); g.globalAlpha = 0.9; g.fillText(d.server.name, 80, 315); g.globalAlpha = 1;

  const t = d.totals;
  const tiles = [
    [fmtMinutes(t.voiceMinutes), 'вместе в голосе'],
    [num(t.messages), plural(t.messages, 'сообщение', 'сообщения', 'сообщений')],
    [num(t.music.plays), plural(t.music.plays, 'трек', 'трека', 'треков')],
    [num(t.watch.videos), 'видео вместе'],
  ];
  tiles.forEach(([v, l], i) => {
    const x = 80 + (i % 2) * 470, y = 380 + Math.floor(i / 2) * 230;
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.roundRect ? g.roundRect(x, y, 440, 200, 28) : g.rect(x, y, 440, 200); g.fill();
    g.fillStyle = '#fff'; fit(v, 800, 76, 380); g.fillText(v, x + 32, y + 110);
    g.font = font(500, 32); g.globalAlpha = 0.85; g.fillText(l, x + 32, y + 162); g.globalAlpha = 1;
  });
  let y = 900;
  g.font = font(700, 36); g.fillText('Награды', 80, y); y += 20;
  for (const a of d.awards.slice(0, 4)) {
    y += 58;
    const line = `${a.title} — ${displayName(a.user)}`;
    fit(line, 500, 38, W - 160); g.fillText(line, 80, y);
  }
  if (!d.awards.length) { y += 58; g.font = font(500, 36); g.fillText('Награды ещё впереди', 80, y); }
  if (d.topTracks[0]) {
    y = Math.max(y + 80, 1190);
    const tr = `♫ ${d.topTracks[0].title}${d.topTracks[0].artist ? ' — ' + d.topTracks[0].artist : ''}`;
    fit(tr, 600, 36, W - 160); g.fillText(tr, 80, y);
  }
  g.font = font(500, 28); g.globalAlpha = 0.75; g.fillText('Astra — голос и чат для своих', 80, H - 60); g.globalAlpha = 1;
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png'));
}

// ------------------------------------------------------------- оверлей --
function show(i, { focus = false } = {}) {
  const n = ov.slides.length;
  ov.idx = Math.max(0, Math.min(n - 1, i));
  const s = ov.slides[ov.idx];
  ov.stage.replaceChildren(s.el);
  s.el.classList.toggle('is-animated', !motionReduced());
  ov.bar.replaceChildren(...ov.slides.map((_, k) => h('span', { class: 'recap-seg' + (k < ov.idx ? ' is-done' : k === ov.idx ? ' is-current' : '') })));
  ov.counter.textContent = `${ov.idx + 1} / ${n}`;
  ov.prev.disabled = ov.idx === 0;
  ov.next.disabled = ov.idx === n - 1;
  ov.root.dataset.slide = s.kind;
  if (focus) ov.stage.focus({ preventScroll: true });
}

async function load(serverId, period, { keepSlide = null } = {}) {
  ov.serverId = serverId;
  ov.period = period;
  ov.stage.replaceChildren(h('div', { class: 'recap-loading' }, 'Считаем итоги…'));
  try {
    const d = await request('GET', recapUrl(serverId, period));
    if (!ov || ov.serverId !== serverId) return;
    ov.data = d;
    ov.period = d.period;
    fillPeriods(d);
    ov.slides = buildSlides(d);
    const k = keepSlide ? ov.slides.findIndex((s) => s.kind === keepSlide) : 0;
    show(Math.max(0, k));
  } catch (e) {
    ov.stage.replaceChildren(h('div', { class: 'recap-loading' }, e.message || 'Не удалось загрузить итоги'));
  }
}

function fillPeriods(d) {
  const months = new Set([nowMonth(), ...d.available.months, d.kind === 'month' ? d.period : null].filter(Boolean));
  const years = new Set([...d.available.years, String(new Date().getFullYear()), d.kind === 'year' ? d.period : null].filter(Boolean));
  const opts = [
    h('optgroup', { label: 'Месяцы' }, [...months].sort().reverse().map((p) => h('option', { value: p }, periodLabel(p)))),
    h('optgroup', { label: 'Годы' }, [...years].sort().reverse().map((p) => h('option', { value: p }, periodLabel(p)))),
  ];
  ov.select.replaceChildren(...opts);
  ov.select.value = d.period;
}

function onKey(e) {
  if (!ov) return;
  if (e.key === 'Escape') { e.preventDefault(); closeRecap(); return; }
  const tag = e.target?.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(ov.idx + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(ov.idx - 1); }
  else if (e.key === 'Home') { e.preventDefault(); show(0); }
  else if (e.key === 'End') { e.preventDefault(); show(ov.slides.length - 1); }
  else if (e.key === 'Tab') trapFocus(e);
}

function trapFocus(e) {
  const f = [...ov.root.querySelectorAll('button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null || el === ov.stage);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function openRecap(serverId = state.currentServerId, period) {
  if (!serverId) return;
  if (ov) closeRecap({ restore: false });
  ensureCss();
  const lastFocus = document.activeElement;
  const close = h('button', { type: 'button', class: 'recap-icon-btn', 'aria-label': 'Закрыть итоги', title: 'Закрыть (Esc)', dataset: { recapAction: 'close' } }, '✕');
  const select = h('select', { class: 'recap-select recap-period', 'aria-label': 'Период итогов' });
  const prev = h('button', { type: 'button', class: 'recap-nav recap-nav--prev', 'aria-label': 'Предыдущий слайд' }, '‹');
  const next = h('button', { type: 'button', class: 'recap-nav recap-nav--next', 'aria-label': 'Следующий слайд' }, '›');
  const stage = h('div', { class: 'recap-stage', tabindex: '-1', 'aria-live': 'polite', 'aria-roledescription': 'слайды' });
  const bar = h('div', { class: 'recap-bar', 'aria-hidden': 'true' });
  const counter = h('span', { class: 'recap-counter', 'aria-live': 'off' });
  const settingsBtn = h('button', { type: 'button', class: 'recap-icon-btn', 'aria-label': 'Поделиться и настройки', title: 'Поделиться и настройки' }, '⤴');
  const root = h('div', { class: 'recap', id: 'recap', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Astra Итоги' },
    bar,
    h('header', { class: 'recap-top' }, h('span', { class: 'recap-brand' }, chartIcon(), 'Итоги'), select, h('span', { class: 'recap-spacer' }), counter, settingsBtn, close),
    stage, prev, next);
  ov = { root, stage, bar, counter, select, prev, next, slides: [], idx: 0, data: null, serverId, period, lastFocus };
  close.addEventListener('click', () => closeRecap());
  prev.addEventListener('click', () => show(ov.idx - 1));
  next.addEventListener('click', () => show(ov.idx + 1));
  settingsBtn.addEventListener('click', () => show(ov.slides.length - 1));
  select.addEventListener('change', () => load(serverId, select.value));
  // касание: левая треть — назад, остальное — вперёд; свайп влево/вправо
  let down = null;
  stage.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  stage.addEventListener('pointerup', (e) => {
    if (!down || e.target.closest('button, a, select, input, label, ol, ul')) { down = null; return; }
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { show(ov.idx + (dx < 0 ? 1 : -1)); return; }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const r = stage.getBoundingClientRect();
    show(ov.idx + (e.clientX - r.left < r.width / 3 ? -1 : 1));
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  document.documentElement.classList.add('recap-open');
  stage.focus({ preventScroll: true });
  load(serverId, period);
}

export function closeRecap({ restore = true } = {}) {
  if (!ov) return;
  document.removeEventListener('keydown', onKey, true);
  ov.root.remove();
  document.documentElement.classList.remove('recap-open');
  const f = ov.lastFocus;
  ov = null;
  if (restore && f?.focus) f.focus();
}

function ensureCss() {
  if (document.querySelector('link[data-recap-css]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: '/css/recap.css', dataset: { recapCss: '1' } }));
}

// --------------------------------------------------------------- вход --
export function initRecap() {
  ensureCss();
  const menu = $('#btn-server-menu');
  if (menu && !$('#btn-recap')) {
    const btn = h('button', { class: 'icon-btn', id: 'btn-recap', type: 'button', 'aria-label': 'Итоги сервера', title: 'Итоги', hidden: true }, chartIcon());
    menu.before(btn);
    btn.addEventListener('click', () => openRecap(state.currentServerId));
    const sync = () => { btn.hidden = !getServer(); };
    // шапку перерисовывает sidebar.js: следим за видимостью кнопки настроек сервера
    new MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }
  // кнопка «Открыть» в объявлении бота (chat.js рисует её для сообщений с recap)
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-recap-period]');
    if (!b) return;
    e.preventDefault();
    if (!getServer(b.dataset.recapServer)) { toast('Сервер недоступен'); return; }
    openRecap(b.dataset.recapServer, b.dataset.recapPeriod);
  });
}
