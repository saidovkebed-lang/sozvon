// «События сервера» (как Scheduled Events в Discord): кнопка-календарь в шапке (#btn-events, счётчик ближайших),
// окно со списком и формой (#modal-events), RSVP «Иду» / «Может быть» / «Не иду», карточка напоминания
// с «Подключиться». Сервер — server/schedule-events.js (сокет sevent:*), время хранится в UTC (мс),
// вводится и показывается в часовом поясе браузера.
import { $, h, icon, avatar, displayName, fmtClock } from '../util.js';
import { state, subscribe, notify, getServer, getChannel, findUser } from '../state.js';
import { emitAck } from '../socket.js';
import { selectChannel } from '../nav.js';
import { joinVoice } from '../voice/voice.js';
import { can } from '../perms.js';
import { openModal, closeModal, confirmDialog } from './modals.js';
import { toast, toastError } from './toasts.js';
import { playSound } from './sounds.js';

const LIVE_MS = 2 * 3600_000;   // «идёт сейчас» (как на сервере)
const SOON_MS = 15 * 60_000;    // «Подключиться» на карточке — незадолго до начала
const DAY = 86400_000;
const RSVP = [['going', 'Иду', 'i-check'], ['maybe', 'Может быть', null], ['no', 'Не иду', null]];
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } })();

let dlg = null;
let editing = null;      // id редактируемого события, '' — новое, null — список
let focusId = null;      // подсветить карточку (из уведомления)
let loaded = new Set();  // серверы, чьи события уже загружены
let reminderBox = null;

/* ---------- время ---------- */
const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** «Сегодня в 21:00» / «Завтра в 21:00» / «пт, 7 ноября в 21:00» */
export function fmtWhen(ms, now = Date.now()) {
  const diff = Math.round((dayStart(ms) - dayStart(now)) / DAY);
  const t = fmtClock(ms);
  if (diff === 0) return `Сегодня в ${t}`;
  if (diff === 1) return `Завтра в ${t}`;
  if (diff === -1) return `Вчера в ${t}`;
  const opts = { weekday: 'short', day: 'numeric', month: 'long' };
  if (new Date(ms).getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return `${new Date(ms).toLocaleDateString('ru-RU', opts)} в ${t}`;
}

/** «через 2 ч» / «через 15 мин» / «идёт сейчас» / «прошло» */
export function fmtRel(ms, now = Date.now()) {
  const d = ms - now;
  if (d <= 0) return -d < LIVE_MS ? 'идёт сейчас' : 'прошло';
  const min = Math.ceil(d / 60_000);
  if (min < 60) return `через ${min} мин`;
  const hr = Math.round(d / 3600_000);
  if (hr < 24) return `через ${hr} ч`;
  const days = Math.round(d / DAY);
  return `через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`;
}

const phase = (ev, now = Date.now()) => (ev.startAt > now ? 'upcoming' : now - ev.startAt < LIVE_MS ? 'live' : 'past');

/* ---------- данные ---------- */
const eventsOf = (serverId) => Object.values(state.scheduledEvents)
  .filter((e) => e.serverId === serverId).sort((a, b) => a.startAt - b.startAt);
/** Ближайшие: ещё не начались или идут сейчас */
const activeOf = (serverId, now = Date.now()) => eventsOf(serverId).filter((e) => phase(e, now) !== 'past');

function upsert(ev) {
  if (!ev?.id) return;
  state.scheduledEvents[ev.id] = ev;
  notify('events');
}

async function loadServer(serverId) {
  loaded.add(serverId);
  try {
    const { events } = await emitAck('sevent:list', { serverId });
    for (const id of Object.keys(state.scheduledEvents)) if (state.scheduledEvents[id].serverId === serverId) delete state.scheduledEvents[id];
    for (const ev of events || []) state.scheduledEvents[ev.id] = ev;
    notify('events');
  } catch { loaded.delete(serverId); }
}

/** Бутстрап: события всех серверов (main.js) */
export function setEvents(list) {
  state.scheduledEvents = {};
  for (const ev of list || []) state.scheduledEvents[ev.id] = ev;
  loaded = new Set(state.servers.map((s) => s.id));
  notify('events');
}

/** Серверы изменились: новые — догрузить, ушедшие — забыть */
function syncServers() {
  const ids = new Set(state.servers.map((s) => s.id));
  let changed = false;
  for (const [id, ev] of Object.entries(state.scheduledEvents)) if (!ids.has(ev.serverId)) { delete state.scheduledEvents[id]; changed = true; }
  for (const s of state.servers) if (!loaded.has(s.id) && state.connected) loadServer(s.id);
  for (const id of [...loaded]) if (!ids.has(id)) loaded.delete(id);
  if (changed) notify('events');
}

/* ---------- кнопка в шапке ---------- */
function renderButton() {
  const btn = $('#btn-events');
  if (!btn) return;
  const srv = getServer();
  btn.hidden = !srv;
  if (!srv) return;
  const now = Date.now();
  const list = activeOf(srv.id, now);
  const n = list.length;
  let b = btn.querySelector('.badge-count');
  if (!n) b?.remove();
  else {
    if (!b) { b = h('span', { class: 'badge-count badge-count--corner badge-count--event' }); btn.append(b); }
    b.textContent = n > 99 ? '99+' : String(n);
  }
  // скоро (в ближайшие сутки) или уже идёт — кнопка подсвечена
  btn.classList.toggle('is-soon', list.some((e) => e.startAt - now < DAY));
  const label = n ? `События сервера: ближайших ${n}` : 'События сервера';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/* ---------- карточка ---------- */
function peopleEl(ev, server) {
  const going = ev.rsvp.going || [];
  const shown = going.slice(0, 6);
  const stack = h('span', { class: 'event-card__avatars' }, shown.map((id) => {
    const u = findUser(id, server) || { id, username: '?' };
    const a = avatar(u, 'sm');
    a.title = displayName(u);
    return a;
  }), going.length > shown.length ? h('span', { class: 'event-card__more' }, `+${going.length - shown.length}`) : null);
  const parts = [`Идут: ${going.length}`];
  if (ev.rsvp.maybe?.length) parts.push(`может быть: ${ev.rsvp.maybe.length}`);
  return h('div', { class: 'event-card__people' }, going.length ? stack : null,
    h('span', { class: 'event-card__count', dataset: { going: String(going.length), maybe: String(ev.rsvp.maybe?.length || 0) } }, parts.join(' · ')));
}

function canJoin(ev, server) {
  return !!ev.channelId && !!getChannel(ev.channelId) && can(server, 'CONNECT', ev.channelId);
}

function cardEl(ev, now) {
  const server = getServer(ev.serverId);
  const ph = phase(ev, now);
  const d = new Date(ev.startAt);
  const author = findUser(ev.authorId, server) || ev.author;
  const ch = ev.channelId ? getChannel(ev.channelId) : null;
  const joinable = canJoin(ev, server) && (ph === 'live' || (ph === 'upcoming' && ev.startAt - now <= SOON_MS));
  return h('article', {
    class: `event-card event-card--${ph}${ev.id === focusId ? ' is-focus' : ''}`, role: 'listitem',
    dataset: { eventId: ev.id }, 'aria-label': ev.title,
  },
  h('div', { class: 'event-card__date', 'aria-hidden': 'true' },
    h('span', { class: 'event-card__month' }, d.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')),
    h('span', { class: 'event-card__day' }, String(d.getDate()))),
  h('div', { class: 'event-card__main' },
    h('div', { class: 'event-card__when' },
      h('time', { class: 'event-card__time', datetime: d.toISOString() }, fmtWhen(ev.startAt, now)),
      h('span', { class: `event-card__rel${ph === 'live' ? ' is-live' : ''}` }, fmtRel(ev.startAt, now))),
    h('h4', { class: 'event-card__title' }, ev.title),
    ev.description ? h('p', { class: 'event-card__desc' }, ev.description) : null,
    h('div', { class: 'event-card__meta' },
      ch ? h('span', { class: 'event-card__channel' }, icon('i-volume', 'icon--sm'), ch.name) : null,
      h('span', { class: 'event-card__author' }, avatar(author, 'sm'), h('span', null, 'Автор: ', h('b', null, displayName(author))))),
    peopleEl(ev, server),
    h('div', { class: 'event-card__actions' },
      ph === 'past' ? null : h('div', { class: 'event-rsvp', role: 'group', 'aria-label': 'Ваш ответ' },
        RSVP.map(([st, label, ic]) => h('button', {
          type: 'button', class: `event-rsvp__btn event-rsvp__btn--${st}${ev.me === st ? ' is-on' : ''}`,
          'aria-pressed': String(ev.me === st), dataset: { rsvp: st },
        }, ic && ev.me === st ? icon(ic, 'icon--sm') : null, label))),
      joinable ? h('button', { type: 'button', class: 'btn btn--primary btn--sm event-card__join', dataset: { eventJoin: ev.channelId } }, icon('i-headphones', 'icon--sm'), 'Подключиться') : null,
      ev.canManage ? h('span', { class: 'event-card__manage' },
        ph === 'past' ? null : h('button', { type: 'button', class: 'icon-btn', dataset: { eventEdit: ev.id }, 'aria-label': 'Изменить событие', title: 'Изменить' }, icon('i-pencil')),
        h('button', { type: 'button', class: 'icon-btn icon-btn--danger', dataset: { eventDelete: ev.id }, 'aria-label': 'Удалить событие', title: 'Удалить' }, icon('i-trash'))) : null)));
}

function renderList() {
  if (!dlg?.open || editing !== null) return;
  const srv = getServer();
  if (!srv) { closeModal(dlg); return; }
  $('#modal-events-title').textContent = `События · ${srv.name}`;
  const now = Date.now();
  const list = eventsOf(srv.id);
  const box = $('#events-list');
  const top = box.scrollTop;
  box.replaceChildren(...(list.length ? list.map((e) => cardEl(e, now)) : [h('div', { class: 'events__empty' },
    icon('i-calendar', 'icon--lg'),
    h('p', null, 'Предстоящих событий пока нет'),
    h('p', { class: 'events__hint' }, 'Создайте событие — например, «Катка в 21:00», — и друзья отметят, кто идёт. Идущим придёт напоминание за 15 минут.'))]));
  box.scrollTop = top;
  if (focusId) {
    box.querySelector(`[data-event-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest' });
    focusId = null;
  }
}

/* ---------- форма ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dateVal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeVal = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function showForm(ev) {
  editing = ev ? ev.id : '';
  const srv = getServer();
  const form = $('#event-form');
  $('#events-list').hidden = true;
  $('#btn-event-new').hidden = true;
  form.hidden = false;
  $('#modal-events-title').textContent = ev ? 'Изменить событие' : 'Новое событие';
  $('#event-form-submit').textContent = ev ? 'Сохранить' : 'Создать';
  $('#event-form-error').textContent = '';
  const start = ev ? ev.startAt : Math.ceil((Date.now() + 30 * 60_000) / 3600_000) * 3600_000; // ближайший целый час
  $('#event-title').value = ev?.title || '';
  $('#event-description').value = ev?.description || '';
  $('#event-date').value = dateVal(start);
  $('#event-date').min = dateVal(Date.now());
  $('#event-time').value = timeVal(start);
  $('#event-tz').textContent = TZ ? `Время — по вашему часовому поясу (${TZ}); у друзей покажется в их поясе.` : '';
  const sel = $('#event-channel');
  const voice = (srv?.channels || []).filter((c) => c.type === 'voice').sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  sel.replaceChildren(h('option', { value: '' }, 'Без голосового канала'), ...voice.map((c) => h('option', { value: c.id }, `🔊 ${c.name}`)));
  sel.value = ev?.channelId || '';
  $('#event-title').focus();
}

function showList() {
  editing = null;
  $('#event-form').hidden = true;
  $('#events-list').hidden = false;
  $('#btn-event-new').hidden = false;
  renderList();
}

async function submitForm(e) {
  e.preventDefault();
  const err = $('#event-form-error');
  err.textContent = '';
  const date = $('#event-date').value;
  const time = $('#event-time').value;
  const startAt = date && time ? new Date(`${date}T${time}`).getTime() : NaN;
  if (!$('#event-title').value.trim()) { err.textContent = 'Введите название'; $('#event-title').focus(); return; }
  if (!Number.isFinite(startAt)) { err.textContent = 'Укажите дату и время начала'; return; }
  const body = {
    title: $('#event-title').value, description: $('#event-description').value,
    startAt, channelId: $('#event-channel').value || null,
  };
  const btn = $('#event-form-submit');
  btn.disabled = true;
  try {
    const res = editing
      ? await emitAck('sevent:update', { eventId: editing, ...body })
      : await emitAck('sevent:create', { serverId: state.currentServerId, tz: TZ, ...body });
    upsert(res.event);
    focusId = res.event.id;
    showList();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- действия ---------- */
async function rsvp(id, status) {
  const ev = state.scheduledEvents[id];
  if (!ev) return;
  const next = ev.me === status ? null : status; // повторный клик снимает ответ
  try {
    const res = await emitAck('sevent:rsvp', { eventId: id, status: next, tz: TZ });
    upsert(res.event);
  } catch (ex) { toastError(ex); }
}

async function remove(id) {
  const ev = state.scheduledEvents[id];
  if (!ev) return;
  const yes = await confirmDialog({ title: 'Удалить событие?', text: `«${ev.title}» исчезнет у всех участников сервера.`, ok: 'Удалить' });
  if (!yes) return;
  try {
    await emitAck('sevent:delete', { eventId: id });
    delete state.scheduledEvents[id];
    notify('events');
  } catch (ex) { toastError(ex); }
}

/** Подключиться к голосовому каналу события (по жесту пользователя) */
export function joinEventChannel(channelId) {
  const ch = getChannel(channelId);
  if (!ch || ch.type !== 'voice') { toast('Голосовой канал недоступен'); return; }
  const srv = getServer(ch.serverId);
  if (srv && !can(srv, 'CONNECT', ch.id)) { toast('Нет права подключаться к этому каналу', '', 3000); return; }
  closeModal(dlg);
  closeReminder();
  selectChannel(ch.id);
  joinVoice(ch.id);
}

/** Открыть окно событий сервера (eventId — подсветить карточку) */
export function openEvents(serverId = state.currentServerId, eventId = null) {
  if (!dlg) return;
  if (serverId && serverId !== state.currentServerId && getServer(serverId)) {
    const srv = getServer(serverId);
    const ch = srv.channels.find((c) => c.id === state.lastChannel[srv.id]) || srv.channels.find((c) => c.type === 'text') || srv.channels[0];
    if (ch) selectChannel(ch.id);
  }
  if (!getServer()) return;
  focusId = eventId;
  editing = null;
  openModal(dlg);
  showList();
  if (state.connected) loadServer(state.currentServerId); // права (canManage) могли поменяться
}

/* ---------- карточка-напоминание (in-app) ---------- */
function closeReminder() {
  reminderBox?.remove();
  reminderBox = null;
}

function showReminder(n) {
  closeReminder();
  const srv = getServer(n.serverId);
  if (!srv) return;
  const ev = state.scheduledEvents[n.eventId];
  const ch = n.channelId ? getChannel(n.channelId) : null;
  const text = n.kind === 'start' ? 'Начинается сейчас' : `Начнётся ${fmtRel(n.startAt)}`;
  reminderBox = h('div', { class: 'event-reminder', id: 'event-reminder', role: 'alert', dataset: { eventId: n.eventId, kind: n.kind } },
    h('span', { class: 'event-reminder__icon' }, icon('i-calendar')),
    h('div', { class: 'event-reminder__text' },
      h('span', { class: 'event-reminder__src' }, `${srv.name} · событие`),
      h('b', { class: 'event-reminder__title' }, ev?.title || n.preview),
      h('span', { class: 'event-reminder__when' }, ch ? `${text} · 🔊 ${ch.name}` : text)),
    h('div', { class: 'event-reminder__actions' },
      ch ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', dataset: { eventJoin: ch.id } }, icon('i-headphones', 'icon--sm'), 'Подключиться') : null,
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { eventOpen: n.eventId, eventServer: n.serverId } }, 'Открыть'),
      h('button', { type: 'button', class: 'icon-btn', dataset: { reminderClose: '1' }, 'aria-label': 'Закрыть' }, icon('i-close'))));
  document.body.append(reminderBox);
  playSound('message');
  const box = reminderBox;
  setTimeout(() => { if (reminderBox === box) closeReminder(); }, 30_000);
}

/* ---------- инициализация ---------- */
export function initEvents(on) {
  dlg = $('#modal-events');
  const btn = $('#btn-events');
  if (!dlg || !btn) return;
  btn.addEventListener('click', () => openEvents());
  $('#btn-event-new').addEventListener('click', () => showForm(null));
  $('#event-form-cancel').addEventListener('click', showList);
  $('#event-form').addEventListener('submit', submitForm);
  dlg.addEventListener('close', () => { editing = null; $('#event-form').hidden = true; $('#events-list').hidden = false; $('#btn-event-new').hidden = false; });
  // Esc в форме — назад к списку, а не закрыть окно
  dlg.addEventListener('cancel', (e) => { if (editing !== null) { e.preventDefault(); showList(); } });
  dlg.addEventListener('click', (e) => {
    const r = e.target.closest('[data-rsvp]');
    if (r) { rsvp(r.closest('[data-event-id]').dataset.eventId, r.dataset.rsvp); return; }
    const ed = e.target.closest('[data-event-edit]');
    if (ed) { const ev = state.scheduledEvents[ed.dataset.eventEdit]; if (ev) showForm(ev); return; }
    const del = e.target.closest('[data-event-delete]');
    if (del) remove(del.dataset.eventDelete);
  });
  // «Подключиться» / «Открыть» — в окне, в карточке-напоминании и во «Входящих»
  document.addEventListener('click', (e) => {
    const j = e.target.closest?.('[data-event-join]');
    if (j) { e.preventDefault(); joinEventChannel(j.dataset.eventJoin); return; }
    const o = e.target.closest?.('[data-event-open]');
    if (o) { e.preventDefault(); closeReminder(); openEvents(o.dataset.eventServer, o.dataset.eventOpen); return; }
    if (e.target.closest?.('[data-reminder-close]')) closeReminder();
  }, true);

  subscribe(['events', 'nav', 'servers'], () => { renderButton(); renderList(); });
  subscribe('servers', syncServers);
  subscribe(['presence', 'profile'], renderList);
  // относительное время («через 5 мин») и «идёт сейчас» — раз в 30 с
  setInterval(() => { renderButton(); renderList(); }, 30_000);

  on('sevent:upsert', ({ event } = {}) => upsert(event));
  on('sevent:removed', ({ id } = {}) => {
    if (!state.scheduledEvents[id]) return;
    delete state.scheduledEvents[id];
    if (editing === id) showList();
    notify('events');
  });
  on('notification:new', ({ notification: n } = {}) => {
    if (n?.type === 'event' && Date.now() - n.createdAt < 120_000) showReminder(n);
  });
  renderButton();
}
