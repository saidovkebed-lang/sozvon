// «Админ-панель» экземпляра (полноэкранная). Разделы: серверы, пользователи, состояние сервера,
// оповещения, обновление, журнал. Все данные — /api/admin/* (server/admin/routes.js). docs/ADMIN.md
import { h, icon, $, $$, avatar, fmtDate, fmtSize, safeMediaUrl, firstLetter } from '../util.js';
import { state } from '../state.js';
import { adminFetch, adminState } from './admin.js';
import { toast } from './toasts.js';

const SECTIONS = [
  { id: 'servers', title: 'Серверы', icon: 'i-hash' },
  { id: 'users', title: 'Пользователи', icon: 'i-users' },
  { id: 'health', title: 'Состояние сервера', icon: 'i-signal' },
  { id: 'alerts', title: 'Оповещения', icon: 'i-bell' },
  { id: 'update', title: 'Обновить Astra', icon: 'i-download' },
  { id: 'audit', title: 'Журнал действий', icon: 'i-inbox' },
];

const ACTIONS = {
  'server.rename': 'переименовал сервер', 'server.transfer': 'передал владение сервером', 'server.delete': 'удалил сервер',
  'server.join': 'вошёл на сервер как участник', 'member.kick': 'выгнал участника', 'member.ban': 'заблокировал участника на сервере',
  'member.unban': 'разблокировал участника на сервере', 'member.roles': 'изменил роли участника', 'role.update': 'изменил роль',
  'role.delete': 'удалил роль', 'channel.read': 'открыл сообщения канала', 'channel.delete': 'удалил канал',
  'message.delete': 'удалил сообщение', 'user.ban': 'заблокировал аккаунт', 'user.unban': 'разблокировал аккаунт',
  'user.logout': 'завершил все сеансы', 'user.reset_password': 'сбросил пароль', 'admin.grant': 'выдал права администратора',
  'admin.revoke': 'снял права администратора', 'alerts.toggles': 'изменил оповещения', 'alerts.test': 'отправил тестовое уведомление',
  'update.check': 'проверил обновления', 'update.run': 'запустил обновление', 'settings.require2fa': 'изменил требование 2FA',
};

let dlg = null;
let current = 'servers';
let healthTimer = null;
let updateTimer = null;
const ui = {};

const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} ГБ`;
  return fmtSize(n);
};
const fmtUptime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} д ${hh} ч` : hh ? `${hh} ч ${m} мин` : `${m} мин`;
};
const when = (ms) => (ms ? fmtDate(ms) : '—');

function serverIcon(s) {
  const url = safeMediaUrl(s.icon);
  return h('span', { class: 'admin-sicon' }, url ? h('img', { src: url, alt: '' }) : firstLetter(s.name));
}

/* ------------------------------------------------------------------ диалоги */
/** Вопрос/подтверждение поверх панели. input: {label, value, placeholder, match, type} → строка; без input → true. */
function ask({ title, text = '', input = null, ok = 'Подтвердить', danger = false, extra = null }) {
  return new Promise((resolve) => {
    const err = h('p', { class: 'form__error', role: 'alert' });
    const field = input ? h('input', {
      class: 'input', id: 'admin-ask-input', type: input.type || 'text', value: input.value || '', placeholder: input.placeholder || '',
      autocomplete: 'off', maxlength: String(input.max || 300),
    }) : null;
    const okBtn = h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, id: 'admin-ask-ok' }, ok);
    const form = h('form', { class: 'modal__body form', method: 'dialog', novalidate: true },
      text ? h('p', { class: 'modal__text' }, text) : null,
      field ? h('label', { class: 'field' }, h('span', { class: 'field__label' }, input.label || ''), field) : null,
      extra, err,
      h('div', { class: 'modal__footer admin-ask__footer' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => d.close('cancel') }, 'Отмена'), okBtn));
    const d = h('dialog', { class: 'modal admin-ask', 'aria-labelledby': 'admin-ask-title' },
      h('div', { class: 'modal__header' }, h('h2', { class: 'modal__title', id: 'admin-ask-title' }, title)), form);
    if (input?.match !== undefined) {
      okBtn.disabled = true;
      field.addEventListener('input', () => { okBtn.disabled = field.value !== input.match; });
    }
    let result = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input?.match !== undefined && field.value !== input.match) { err.textContent = 'Название не совпадает'; return; }
      result = field ? field.value : true;
      d.close('ok');
    });
    d.addEventListener('close', () => { d.remove(); resolve(d.returnValue === 'ok' ? result : null); });
    (dlg || document.body).append(d);
    d.showModal();
    (field || okBtn).focus();
  });
}

function showSecret(title, text, secret) {
  const code = h('code', { class: 'admin-secret', id: 'admin-temp-password' }, secret);
  const copy = h('button', {
    type: 'button', class: 'btn btn--sm',
    onclick: async () => { try { await navigator.clipboard.writeText(secret); toast('Скопировано', 'ok', 2000); } catch { /* нет буфера */ } },
  }, icon('i-copy'), 'Копировать');
  return ask({ title, text, ok: 'Готово', extra: h('div', { class: 'admin-secret-row' }, code, copy) });
}

async function doAction(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText, 'ok', 2500);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/* ------------------------------------------------------------------ каркас */
function build() {
  if (dlg) return dlg;
  const nav = h('div', { class: 'admin__nav-list', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Разделы админ-панели' },
    ...SECTIONS.map((s) => h('button', {
      type: 'button', class: 'admin__tab', role: 'tab', id: `admin-tab-${s.id}`, dataset: { section: s.id },
      'aria-controls': 'admin-content', onclick: () => show(s.id),
    }, icon(s.icon, 'icon--sm'), h('span', null, s.title))));
  ui.title = h('h2', { class: 'admin__title', id: 'admin-title' }, 'Админ-панель');
  ui.content = h('div', { class: 'admin__content', id: 'admin-content', role: 'tabpanel', tabindex: '-1' });
  dlg = h('dialog', { class: 'admin', id: 'admin-panel', 'aria-labelledby': 'admin-heading' },
    h('div', { class: 'admin__layout' },
      h('nav', { class: 'admin__nav', 'aria-label': 'Админ-панель' },
        h('div', { class: 'admin__brand' }, icon('i-shield'), h('span', { id: 'admin-heading' }, 'Админ-панель')),
        nav),
      h('div', { class: 'admin__main' },
        h('header', { class: 'admin__bar' }, ui.title,
          h('button', { type: 'button', class: 'icon-btn admin__close', 'aria-label': 'Закрыть админ-панель', title: 'Закрыть (Esc)', onclick: () => dlg.close() }, icon('i-close'))),
        ui.content)));
  dlg.addEventListener('close', () => {
    clearInterval(healthTimer); healthTimer = null;
    const t = $('#toasts');
    if (t && t.parentElement !== document.body) document.body.append(t);
  });
  document.body.append(dlg);
  return dlg;
}

export async function openAdminPanel(section) {
  build();
  if (!dlg.open) {
    dlg.showModal();
    const t = $('#toasts');
    if (t) dlg.append(t); // тосты — поверх панели
  }
  // доступ и 2FA проверяет сервер; здесь — понятный экран вместо ошибок
  try { adminState.info = await adminFetch('GET', '/api/admin/me'); } catch { /* покажет раздел */ }
  if (adminState.info && !adminState.info.admin) { dlg.close(); toast('Нет доступа к админ-панели', 'error'); return; }
  if (adminState.info && !adminState.info.active) { show2faGate(); return; }
  show(section || current);
}

function show2faGate() {
  $$('.admin__tab', dlg).forEach((t) => { t.disabled = true; t.classList.remove('is-active'); });
  ui.title.textContent = 'Нужна двухфакторная защита';
  ui.content.replaceChildren(h('div', { class: 'admin-gate', id: 'admin-2fa-gate' },
    icon('i-lock', 'admin-gate__icon'),
    h('h3', null, 'Включите двухфакторную защиту, чтобы открыть админ-панель'),
    h('p', null, 'Админ-панель даёт полный доступ ко всем серверам и аккаунтам. Поэтому она открывается только при включённой 2FA (код из приложения-аутентификатора при входе).'),
    h('button', {
      type: 'button', class: 'btn btn--primary', id: 'admin-open-security',
      onclick: async () => { dlg.close(); const m = await import('./user-settings.js'); m.openUserSettings('security'); },
    }, icon('i-shield'), 'Открыть настройки безопасности')));
}

function show(id) {
  current = id;
  $$('.admin__tab', dlg).forEach((t) => {
    t.disabled = false;
    const on = t.dataset.section === id;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  ui.title.textContent = SECTIONS.find((s) => s.id === id)?.title || 'Админ-панель';
  clearInterval(healthTimer); healthTimer = null;
  ui.content.replaceChildren(h('p', { class: 'admin-muted' }, 'Загрузка…'));
  ({ servers: renderServers, users: renderUsers, health: renderHealth, alerts: renderAlerts, update: renderUpdate, audit: renderAudit })[id]?.();
}

function failBox(e) {
  if (e.code === 'admin_2fa_required') { show2faGate(); return null; }
  return h('p', { class: 'form__error' }, e.message);
}

function searchBox(placeholder, onInput, id) {
  let t = null;
  const input = h('input', { class: 'input admin-search', id, type: 'search', placeholder, 'aria-label': placeholder });
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onInput(input.value.trim()), 200); });
  return h('div', { class: 'admin-search-wrap' }, icon('i-search', 'icon--sm'), input);
}

/* ------------------------------------------------------------------ серверы */
async function renderServers() {
  const list = h('div', { class: 'admin-list', id: 'admin-servers-list' });
  const count = h('span', { class: 'admin-muted' });
  const load = async (q = '') => {
    try {
      const r = await adminFetch('GET', `/api/admin/servers?q=${encodeURIComponent(q)}`);
      count.textContent = `Всего серверов: ${r.total}`;
      list.replaceChildren(...(r.servers.length ? r.servers.map(serverRowEl) : [h('p', { class: 'admin-muted' }, 'Ничего не найдено')]));
    } catch (e) { list.replaceChildren(failBox(e) || ''); }
  };
  ui.content.replaceChildren(
    h('div', { class: 'admin-toolbar' }, searchBox('Поиск: название, владелец', load, 'admin-servers-search'), count),
    list);
  load();
}

function serverRowEl(s) {
  return h('button', { type: 'button', class: 'admin-row', dataset: { serverId: s.id }, onclick: () => openServer(s.id) },
    serverIcon(s),
    h('span', { class: 'admin-row__main' },
      h('span', { class: 'admin-row__title' }, s.name),
      h('span', { class: 'admin-row__sub' }, `Владелец: ${s.owner ? (s.owner.displayName || s.owner.username) : '—'} · создан ${when(s.createdAt)}`)),
    h('span', { class: 'admin-row__stats' },
      h('span', { title: 'Участники' }, icon('i-users', 'icon--sm'), String(s.members)),
      h('span', { title: 'Каналы: текстовые / голосовые' }, icon('i-hash', 'icon--sm'), `${s.channels.text}/${s.channels.voice}`),
      h('span', { class: 'admin-row__time', title: 'Последняя активность' }, when(s.lastActivity))),
    icon('i-chevron-right', 'icon--sm'));
}

async function openServer(id) {
  ui.content.replaceChildren(h('p', { class: 'admin-muted' }, 'Загрузка…'));
  let r;
  try { r = await adminFetch('GET', `/api/admin/servers/${encodeURIComponent(id)}`); } catch (e) { ui.content.replaceChildren(failBox(e) || ''); return; }
  const s = r.server;
  const back = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => show('servers') }, icon('i-arrow-left', 'icon--sm'), 'Все серверы');
  const reload = () => openServer(id);
  const roleName = (rid) => s.roles.find((x) => x.id === rid)?.name || '?';

  const actions = h('div', { class: 'admin-actions' },
    h('button', {
      type: 'button', class: 'btn btn--sm', id: 'admin-server-rename',
      onclick: async () => {
        const name = await ask({ title: 'Переименовать сервер', input: { label: 'Новое название', value: s.name, max: 50 }, ok: 'Сохранить' });
        if (name == null) return;
        if (await doAction(() => adminFetch('PATCH', `/api/admin/servers/${id}`, { name }), 'Сервер переименован')) reload();
      },
    }, icon('i-pencil', 'icon--sm'), 'Переименовать'),
    h('button', {
      type: 'button', class: 'btn btn--sm', id: 'admin-server-join', disabled: r.isMember,
      onclick: async () => { if (await doAction(() => adminFetch('POST', `/api/admin/servers/${id}/join`), 'Вы теперь участник сервера')) reload(); },
    }, icon('i-door', 'icon--sm'), r.isMember ? 'Вы участник' : 'Войти как участник'),
    h('button', {
      type: 'button', class: 'btn btn--danger btn--sm', id: 'admin-server-delete',
      onclick: async () => {
        const v = await ask({
          title: 'Удалить сервер навсегда?', danger: true, ok: 'Удалить сервер',
          text: `Будут удалены все каналы и сообщения сервера «${s.name}». Отменить нельзя. Чтобы подтвердить, введите название сервера.`,
          input: { label: 'Название сервера', match: s.name, max: 60 },
        });
        if (v == null) return;
        if (await doAction(() => adminFetch('DELETE', `/api/admin/servers/${id}`, { confirmName: v }), 'Сервер удалён')) show('servers');
      },
    }, icon('i-trash', 'icon--sm'), 'Удалить сервер'));

  const members = h('div', { class: 'admin-list admin-list--compact', id: 'admin-server-members' }, ...r.members.map((m) => h('div', { class: 'admin-row admin-row--static', dataset: { userId: m.id } },
    avatar(m, 'sm'),
    h('span', { class: 'admin-row__main' },
      h('span', { class: 'admin-row__title' }, m.displayName || m.username, m.owner ? h('span', { class: 'admin-badge admin-badge--star' }, 'владелец') : null),
      h('span', { class: 'admin-row__sub' }, `@${m.username}${m.roles.length ? ' · ' + m.roles.map(roleName).join(', ') : ''}`)),
    h('span', { class: 'admin-row__btns' },
      h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', title: 'Роли участника',
        onclick: () => editMemberRoles(s, m, reload),
      }, icon('i-tag', 'icon--sm'), 'Роли'),
      m.owner ? null : h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', title: 'Сделать владельцем',
        onclick: async () => {
          if (!await ask({ title: 'Передать владение?', text: `Владельцем «${s.name}» станет ${m.displayName || m.username}.`, ok: 'Передать' })) return;
          if (await doAction(() => adminFetch('POST', `/api/admin/servers/${id}/transfer`, { userId: m.id }), 'Владение передано')) reload();
        },
      }, icon('i-crown', 'icon--sm')),
      m.owner ? null : h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', dataset: { action: 'kick' }, title: 'Выгнать',
        onclick: async () => {
          if (!await ask({ title: 'Выгнать участника?', text: `${m.displayName || m.username} сможет вернуться по инвайту.`, ok: 'Выгнать', danger: true })) return;
          if (await doAction(() => adminFetch('POST', `/api/admin/servers/${id}/members/${m.id}/kick`), 'Участник выгнан')) reload();
        },
      }, icon('i-door', 'icon--sm')),
      m.owner ? null : h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm admin-danger-text', dataset: { action: 'ban' }, title: 'Заблокировать на сервере',
        onclick: async () => {
          const reason = await ask({ title: 'Заблокировать на сервере?', text: `${m.displayName || m.username} не сможет вернуться на «${s.name}».`, input: { label: 'Причина (необязательно)' }, ok: 'Заблокировать', danger: true });
          if (reason == null) return;
          if (await doAction(() => adminFetch('POST', `/api/admin/servers/${id}/members/${m.id}/ban`, { reason }), 'Участник заблокирован')) reload();
        },
      }, icon('i-ban', 'icon--sm'))))));

  const channels = h('div', { class: 'admin-list admin-list--compact', id: 'admin-server-channels' }, ...r.channels.map((c) => h('div', { class: 'admin-row admin-row--static', dataset: { channelId: c.id } },
    icon(c.type === 'voice' ? 'i-volume' : 'i-hash', 'icon--sm'),
    h('span', { class: 'admin-row__main' }, h('span', { class: 'admin-row__title' }, c.name), h('span', { class: 'admin-row__sub' }, c.type === 'voice' ? 'голосовой' : `сообщений: ${c.messages}`)),
    h('span', { class: 'admin-row__btns' },
      c.type === 'text' ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { action: 'messages' }, onclick: () => openMessages(s, c) }, icon('i-message', 'icon--sm'), 'Сообщения') : null,
      h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm admin-danger-text', dataset: { action: 'delete-channel' }, title: 'Удалить канал',
        onclick: async () => {
          if (!await ask({ title: 'Удалить канал?', text: `Канал «${c.name}» и все его сообщения будут удалены.`, ok: 'Удалить', danger: true })) return;
          if (await doAction(() => adminFetch('DELETE', `/api/admin/channels/${c.id}`), 'Канал удалён')) reload();
        },
      }, icon('i-trash', 'icon--sm'))))));

  const roles = h('div', { class: 'admin-list admin-list--compact', id: 'admin-server-roles' }, ...[...s.roles].sort((a, b) => b.position - a.position).map((ro) => h('div', { class: 'admin-row admin-row--static' },
    h('span', { class: 'admin-role-dot', style: { '--rc': ro.color || 'var(--text-faint)' } }),
    h('span', { class: 'admin-row__main' }, h('span', { class: 'admin-row__title' }, ro.name), h('span', { class: 'admin-row__sub' }, ro.id === s.id ? 'все участники' : `позиция ${ro.position}`)),
    ro.id === s.id ? null : h('span', { class: 'admin-row__btns' },
      h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', title: 'Переименовать роль',
        onclick: async () => {
          const name = await ask({ title: 'Переименовать роль', input: { label: 'Название', value: ro.name, max: 32 }, ok: 'Сохранить' });
          if (name == null) return;
          if (await doAction(() => adminFetch('PATCH', `/api/admin/servers/${id}/roles/${ro.id}`, { name }), 'Роль изменена')) reload();
        },
      }, icon('i-pencil', 'icon--sm')),
      h('button', {
        type: 'button', class: 'btn btn--ghost btn--sm admin-danger-text', title: 'Удалить роль',
        onclick: async () => {
          if (!await ask({ title: 'Удалить роль?', text: `Роль «${ro.name}» снимется со всех участников.`, ok: 'Удалить', danger: true })) return;
          if (await doAction(() => adminFetch('DELETE', `/api/admin/servers/${id}/roles/${ro.id}`), 'Роль удалена')) reload();
        },
      }, icon('i-trash', 'icon--sm'))))));

  const bans = Object.entries(s.bans || {});
  const bansEl = h('div', { class: 'admin-list admin-list--compact' }, ...(bans.length ? bans.map(([uid, b]) => h('div', { class: 'admin-row admin-row--static' },
    avatar(b.user, 'sm'),
    h('span', { class: 'admin-row__main' }, h('span', { class: 'admin-row__title' }, b.user.displayName || b.user.username), h('span', { class: 'admin-row__sub' }, b.reason || 'без причины')),
    h('button', {
      type: 'button', class: 'btn btn--ghost btn--sm',
      onclick: async () => { if (await doAction(() => adminFetch('DELETE', `/api/admin/servers/${id}/bans/${uid}`), 'Блокировка снята')) reload(); },
    }, 'Разблокировать'))) : [h('p', { class: 'admin-muted' }, 'Никто не заблокирован')]));

  ui.title.textContent = s.name;
  ui.content.replaceChildren(
    h('div', { class: 'admin-toolbar' }, back),
    h('div', { class: 'admin-hero', id: 'admin-server-detail', dataset: { serverId: s.id } },
      serverIcon(s),
      h('div', { class: 'admin-hero__main' },
        h('div', { class: 'admin-hero__title' }, s.name),
        h('div', { class: 'admin-row__sub' }, `Владелец: ${s.owner ? (s.owner.displayName || s.owner.username) : '—'} · участников ${s.memberCount} · создан ${when(s.createdAt)} · активность ${when(s.lastActivity)}`),
        s.inviteCode ? h('div', { class: 'admin-row__sub' }, `Инвайт: ${s.inviteCode}`) : null),
      actions),
    section('Участники', members), section('Каналы', channels), section('Роли', roles), section('Заблокированные', bansEl));
}

function section(title, ...children) {
  return h('section', { class: 'admin-section' }, h('h3', { class: 'admin-section__title' }, title), ...children);
}

async function editMemberRoles(s, m, reload) {
  const boxes = s.roles.filter((r) => r.id !== s.id).sort((a, b) => b.position - a.position).map((r) => {
    const cb = h('input', { type: 'checkbox', value: r.id, checked: m.roles.includes(r.id) });
    return h('label', { class: 'admin-check' }, cb, h('span', { class: 'admin-role-dot', style: { '--rc': r.color || 'var(--text-faint)' } }), r.name);
  });
  const box = h('div', { class: 'admin-checks' }, ...(boxes.length ? boxes : [h('p', { class: 'admin-muted' }, 'На сервере нет ролей')]));
  if (!await ask({ title: `Роли: ${m.displayName || m.username}`, extra: box, ok: 'Сохранить' })) return;
  const roleIds = $$('input:checked', box).map((i) => i.value);
  if (await doAction(() => adminFetch('PUT', `/api/admin/servers/${s.id}/members/${m.id}/roles`, { roleIds }), 'Роли сохранены')) reload();
}

async function openMessages(s, c) {
  const list = h('div', { class: 'admin-messages', id: 'admin-messages' }, h('p', { class: 'admin-muted' }, 'Загрузка…'));
  const back = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => openServer(s.id) }, icon('i-arrow-left', 'icon--sm'), s.name);
  ui.title.textContent = `#${c.name}`;
  ui.content.replaceChildren(h('div', { class: 'admin-toolbar' }, back, h('span', { class: 'admin-muted' }, 'Последние 50 сообщений. Просмотр записывается в журнал.')), list);
  try {
    const r = await adminFetch('GET', `/api/admin/channels/${c.id}/messages`);
    list.replaceChildren(...(r.messages.length ? r.messages.map((m) => h('div', { class: 'admin-msg', dataset: { messageId: m.id } },
      avatar(m.author, 'sm'),
      h('div', { class: 'admin-msg__body' },
        h('div', { class: 'admin-msg__head' }, h('b', null, m.author.displayName || m.author.username), h('span', { class: 'admin-muted' }, fmtDate(m.createdAt))),
        h('div', { class: 'admin-msg__text' }, m.content || (m.attachments?.length ? `📎 ${m.attachments.map((a) => a.name).join(', ')}` : ''))),
      h('button', {
        type: 'button', class: 'icon-btn admin-danger-text', title: 'Удалить сообщение', 'aria-label': 'Удалить сообщение', dataset: { action: 'delete-message' },
        onclick: async (e) => {
          const row = e.currentTarget.closest('.admin-msg');
          if (await doAction(() => adminFetch('DELETE', `/api/admin/messages/${m.id}`), 'Сообщение удалено')) row.remove();
        },
      }, icon('i-trash', 'icon--sm')))) : [h('p', { class: 'admin-muted' }, 'В канале нет сообщений')]));
  } catch (e) { list.replaceChildren(failBox(e) || ''); }
}

/* ------------------------------------------------------------------ пользователи */
function flagBadges(f) {
  return [
    f.admin ? h('span', { class: 'admin-badge admin-badge--accent' }, f.envAdmin ? 'админ (env)' : 'админ') : null,
    f.banned ? h('span', { class: 'admin-badge admin-badge--danger' }, 'заблокирован') : null,
    f.totpEnabled ? h('span', { class: 'admin-badge admin-badge--ok' }, '2FA') : null,
    f.mustChangePassword ? h('span', { class: 'admin-badge admin-badge--warn' }, 'временный пароль') : null,
  ];
}

async function renderUsers() {
  const list = h('div', { class: 'admin-list', id: 'admin-users-list' });
  const count = h('span', { class: 'admin-muted' });
  const load = async (q = '') => {
    try {
      const r = await adminFetch('GET', `/api/admin/users?q=${encodeURIComponent(q)}`);
      count.textContent = `Всего аккаунтов: ${r.total}`;
      list.replaceChildren(...(r.users.length ? r.users.map((u) => h('button', { type: 'button', class: 'admin-row', dataset: { userId: u.id }, onclick: () => openUser(u.id) },
        avatar(u, 'sm'),
        h('span', { class: 'admin-row__main' },
          h('span', { class: 'admin-row__title' }, u.displayName || u.username, ...flagBadges(u.flags)),
          h('span', { class: 'admin-row__sub' }, `@${u.username} · создан ${when(u.createdAt)} · ${u.online ? 'в сети' : `был ${when(u.lastSeen)}`}`)),
        h('span', { class: 'admin-row__stats' }, h('span', { title: 'Серверов' }, icon('i-hash', 'icon--sm'), String(u.servers))),
        icon('i-chevron-right', 'icon--sm'))) : [h('p', { class: 'admin-muted' }, 'Ничего не найдено')]));
    } catch (e) { list.replaceChildren(failBox(e) || ''); }
  };
  ui.content.replaceChildren(h('div', { class: 'admin-toolbar' }, searchBox('Поиск: имя или ник', load, 'admin-users-search'), count), list);
  load();
}

async function openUser(id) {
  ui.content.replaceChildren(h('p', { class: 'admin-muted' }, 'Загрузка…'));
  let r;
  try { r = await adminFetch('GET', `/api/admin/users/${encodeURIComponent(id)}`); } catch (e) { ui.content.replaceChildren(failBox(e) || ''); return; }
  const u = r.user;
  const me = u.id === state.user?.id;
  const reload = () => openUser(id);
  const name = u.displayName || u.username;
  const actions = h('div', { class: 'admin-actions' },
    u.flags.banned
      ? h('button', { type: 'button', class: 'btn btn--sm', id: 'admin-user-unban', onclick: async () => { if (await doAction(() => adminFetch('POST', `/api/admin/users/${id}/unban`), 'Аккаунт разблокирован')) reload(); } }, 'Разблокировать')
      : h('button', {
        type: 'button', class: 'btn btn--danger btn--sm', id: 'admin-user-ban', disabled: me,
        onclick: async () => {
          const reason = await ask({ title: `Заблокировать ${name}?`, text: 'Вход в аккаунт будет запрещён, все сеансы завершатся сразу.', input: { label: 'Причина (необязательно)' }, ok: 'Заблокировать', danger: true });
          if (reason == null) return;
          if (await doAction(() => adminFetch('POST', `/api/admin/users/${id}/ban`, { reason }), 'Аккаунт заблокирован')) reload();
        },
      }, icon('i-ban', 'icon--sm'), 'Заблокировать'),
    h('button', {
      type: 'button', class: 'btn btn--sm', id: 'admin-user-logout',
      onclick: async () => {
        if (!await ask({ title: 'Завершить все сеансы?', text: `${name} выйдет на всех устройствах.`, ok: 'Завершить' })) return;
        const res = await doAction(() => adminFetch('POST', `/api/admin/users/${id}/logout`));
        if (res) { toast(`Завершено сеансов: ${res.sessions}`, 'ok', 2500); reload(); }
      },
    }, icon('i-logout', 'icon--sm'), 'Завершить сеансы'),
    h('button', {
      type: 'button', class: 'btn btn--sm', id: 'admin-user-reset', disabled: me,
      onclick: async () => {
        const cb = h('input', { type: 'checkbox', id: 'admin-reset-totp' });
        const extra = u.flags.totpEnabled ? h('label', { class: 'admin-check' }, cb, 'Также выключить 2FA (потерян телефон)') : null;
        if (!await ask({ title: `Сбросить пароль ${name}?`, text: 'Будет создан временный пароль — он покажется один раз. Все сеансы завершатся; при входе нужно будет придумать новый пароль.', extra, ok: 'Сбросить' })) return;
        const res = await doAction(() => adminFetch('POST', `/api/admin/users/${id}/reset-password`, { resetTotp: !!cb.checked }));
        if (!res) return;
        await showSecret('Временный пароль', `Передайте его ${name} лично. Больше он нигде не показывается.`, res.tempPassword);
        reload();
      },
    }, icon('i-lock', 'icon--sm'), 'Сбросить пароль'),
    h('button', {
      type: 'button', class: 'btn btn--sm', id: 'admin-user-admin', disabled: u.flags.envAdmin && u.flags.admin,
      title: u.flags.envAdmin ? 'Задан в ADMIN_USERS (/etc/sozvon.env)' : '',
      onclick: async () => {
        const grant = !u.flags.admin;
        if (!await ask({
          title: grant ? `Сделать ${name} администратором?` : `Снять права администратора с ${name}?`,
          text: grant ? 'Администратор видит и меняет все серверы и аккаунты. Выдавайте только тем, кому доверяете.' : '', ok: grant ? 'Выдать права' : 'Снять права', danger: !grant,
        })) return;
        if (await doAction(() => adminFetch('POST', `/api/admin/users/${id}/admin`, { grant }), grant ? 'Права выданы' : 'Права сняты')) reload();
      },
    }, icon(u.flags.admin ? 'i-shield-off' : 'i-shield', 'icon--sm'), u.flags.admin ? 'Снять права админа' : 'Сделать админом'));

  ui.title.textContent = name;
  ui.content.replaceChildren(
    h('div', { class: 'admin-toolbar' }, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => show('users') }, icon('i-arrow-left', 'icon--sm'), 'Все пользователи')),
    h('div', { class: 'admin-hero', id: 'admin-user-detail', dataset: { userId: u.id } },
      avatar(u, 'xl'),
      h('div', { class: 'admin-hero__main' },
        h('div', { class: 'admin-hero__title' }, name, ...flagBadges(u.flags)),
        h('div', { class: 'admin-row__sub' }, `@${u.username} · аккаунт создан ${when(u.createdAt)} · ${u.online ? 'сейчас в сети' : `был в сети ${when(u.lastSeen)}`} · активных сеансов: ${u.sessions}`),
        u.ban ? h('div', { class: 'admin-row__sub admin-danger-text' }, `Заблокирован ${when(u.ban.at)}${u.ban.by ? ` (${u.ban.by.username})` : ''}${u.ban.reason ? `: ${u.ban.reason}` : ''}`) : null),
      actions),
    section(`Серверы (${r.servers.length})`, h('div', { class: 'admin-list admin-list--compact', id: 'admin-user-servers' },
      ...(r.servers.length ? r.servers.map((s) => h('button', { type: 'button', class: 'admin-row', onclick: () => openServer(s.id) },
        serverIcon(s), h('span', { class: 'admin-row__main' }, h('span', { class: 'admin-row__title' }, s.name, s.owner ? h('span', { class: 'admin-badge admin-badge--star' }, 'владелец') : null)),
        icon('i-chevron-right', 'icon--sm'))) : [h('p', { class: 'admin-muted' }, 'Ни на одном сервере')]))),
    h('p', { class: 'admin-muted admin-note' }, icon('i-lock', 'icon--sm'), 'Личные сообщения пользователей администратору недоступны.'));
}

/* ------------------------------------------------------------------ состояние */
function card(title, value, sub = null, level = '') {
  return h('div', { class: `admin-card${level ? ` admin-card--${level}` : ''}` },
    h('div', { class: 'admin-card__title' }, title), h('div', { class: 'admin-card__value' }, value), sub ? h('div', { class: 'admin-card__sub' }, sub) : null);
}
function bar(pct, warnAt = 85) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return h('div', { class: `admin-bar${p > warnAt ? ' is-bad' : p > warnAt - 15 ? ' is-warn' : ''}`, role: 'meter', 'aria-valuenow': String(Math.round(p)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('span', { style: { width: `${p}%` } }));
}

async function renderHealth() {
  const box = h('div', { id: 'admin-health' });
  const refresh = h('button', { type: 'button', class: 'btn btn--sm', onclick: () => load(true) }, icon('i-reset', 'icon--sm'), 'Обновить');
  ui.content.replaceChildren(h('div', { class: 'admin-toolbar' }, refresh, h('span', { class: 'admin-muted' }, 'Обновляется каждые 15 секунд')), box);
  const load = async (fresh = false) => {
    let r;
    try { r = await adminFetch('GET', `/api/admin/health${fresh ? '?fresh=1' : ''}`); } catch (e) { box.replaceChildren(failBox(e) || ''); return; }
    const x = r.health;
    const m = x.system.memory;
    const v = x.version;
    const ytd = x.music.ytdlp, ck = x.music.cookies;
    const cards = [
      card('Процессор', `${x.system.load[0]} / ${x.system.cpus} ядер`, `Нагрузка 1/5/15 мин: ${x.system.load.join(' · ')}`, x.system.load[0] > x.system.cpus ? 'warn' : ''),
      card('Память', `${Math.round(m.pct)} %`, [bar(m.pct, 90), `${fmtBytes(m.used)} из ${fmtBytes(m.total)}`], m.pct > 90 ? 'bad' : ''),
      ...x.system.disks.map((d) => card(`Диск ${d.path}`, d.error ? 'нет данных' : `${Math.round(d.pct)} %`, d.error ? d.error : [bar(d.pct), `свободно ${fmtBytes(d.free)} из ${fmtBytes(d.total)}`], d.pct > 85 ? 'bad' : '')),
      card('Astra', `${v.version || '?'}${v.short ? ` · ${v.short}` : ''}`, `${v.subject || ''}${v.date ? ` (${fmtDate(v.date)})` : ''}`),
      card('Процесс', `работает ${fmtUptime(x.process.uptime)}`, `Node ${x.process.node} · память ${fmtBytes(x.process.rss)} · сервер включён ${fmtUptime(x.system.uptime)}`),
      card('Сейчас', `${x.live.online} в сети`, `в голосе ${x.live.voice ?? '—'} · трансляций ${x.live.streams ?? '—'} · аккаунтов ${x.live.users} · серверов ${x.live.servers} · бот ${x.live.botOnline ? 'в сети' : 'не в сети'}`),
      card('Трансляции (SFU)', !x.sfu.enabled ? 'выключен' : x.sfu.ready ? 'работает' : 'не работает', x.sfu.enabled && !x.sfu.ready ? 'трансляции идут напрямую между участниками' : 'mediasoup', x.sfu.enabled && !x.sfu.ready ? 'warn' : ''),
      card('Трафик с запуска системы', x.traffic ? `↓ ${fmtBytes(x.traffic.rx)} · ↑ ${fmtBytes(x.traffic.tx)}` : 'нет данных', x.traffic ? x.traffic.interfaces.filter((i) => i.rx || i.tx).map((i) => i.name).join(', ') : null),
      card('yt-dlp', ytd.installed ? ytd.version : 'не установлен', ytd.updatedAt ? `обновлён ${fmtDate(ytd.updatedAt)}` : null, ytd.installed ? '' : 'warn'),
      card('Cookies YouTube', !ck.configured ? 'не заданы' : ck.exists ? `${Math.floor(ck.ageDays)} дн.` : 'файл не читается', ck.configured ? 'YTDLP_COOKIES' : 'необязательно (docs/MUSIC.md)', ck.configured && (!ck.exists || ck.ageDays > 30) ? 'warn' : ''),
      card('Проверка музыки', x.music.check ? `✓ ${x.music.check.ok} · ✗ ${x.music.check.failed}` : 'не запускалась', x.music.check ? [`${x.music.check.time ? fmtDate(Date.parse(x.music.check.time)) : ''}`, ...x.music.check.failures.map((f) => h('div', null, `✗ ${f}`))] : 'sudo bash /opt/sozvon/deploy/music-check.sh', x.music.check?.failed ? 'warn' : ''),
      card('«Не бот» YouTube за 6 ч', String(x.music.botChecks.count), x.music.botChecks.last ? `последний раз ${fmtDate(x.music.botChecks.last)}` : 'не было', x.music.botChecks.count ? 'warn' : ''),
      card('VPN-прокси', !x.vpn?.configured ? 'не настроен' : x.vpn.ok ? 'работает' : 'не отвечает', x.vpn?.configured ? `${x.vpn.proxy} → ${x.vpn.target}${x.vpn.ok ? ` · ${x.vpn.ms} мс` : ` · ${x.vpn.error || ''}`}` : 'SPOTIFY_PROXY / YTDLP_PROXY', x.vpn?.configured && !x.vpn.ok ? 'bad' : ''),
      card('Резервная копия', !x.backup.known ? 'нет данных' : x.backup.ok ? when(x.backup.at) : 'ошибка', x.backup.known ? (x.backup.ok ? [x.backup.file, x.backup.size != null ? fmtBytes(x.backup.size) : null, x.backup.telegram ? `Telegram: ${x.backup.telegram}` : null].filter(Boolean).join(' · ') : x.backup.error) : 'появится после первого ночного бэкапа', x.backup.known && (!x.backup.ok || x.backup.ageHours > 36) ? 'bad' : ''),
      card('Сертификат HTTPS', x.cert?.daysLeft != null ? `ещё ${Math.floor(x.cert.daysLeft)} дн.` : 'нет данных', x.cert ? (x.cert.error || `до ${fmtDate(x.cert.expiresAt)}${x.cert.source === 'self-signed' ? ' (самоподписанный)' : ''}`) : null, x.cert?.daysLeft < 14 && x.cert?.source !== 'self-signed' ? 'bad' : ''),
    ];
    const errs = x.errors.recent;
    box.replaceChildren(
      h('div', { class: 'admin-cards' }, ...cards),
      section(`Последние ошибки сервера (за час: ${x.errors.lastHour})`, errs.length
        ? h('div', { class: 'admin-log', id: 'admin-errors' }, ...errs.map((e) => h('div', { class: `admin-log__line admin-log__line--${e.level}` }, h('span', { class: 'admin-muted' }, fmtDate(e.at)), ' ', e.text)))
        : h('p', { class: 'admin-muted' }, 'Ошибок нет')));
  };
  await load();
  healthTimer = setInterval(() => { if (dlg?.open && current === 'health') load(); }, 15_000);
}

/* ------------------------------------------------------------------ оповещения */
async function renderAlerts() {
  let r;
  try { r = await adminFetch('GET', '/api/admin/alerts'); } catch (e) { ui.content.replaceChildren(failBox(e) || ''); return; }
  const status = h('div', { class: 'admin-note' },
    icon(r.telegram.configured ? 'i-check' : 'i-info', 'icon--sm'),
    r.telegram.configured
      ? `Telegram подключён (${r.telegram.source}). Проверка каждые ${Math.round(r.intervalMs / 60000) || '—'} мин; по каждой проблеме — одно сообщение и одно «восстановлено».`
      : 'Telegram не настроен: добавьте в /etc/sozvon.env ALERT_TELEGRAM_TOKEN и ALERT_TELEGRAM_CHAT_ID (или используется бот резервных копий BACKUP_TELEGRAM_*), затем systemctl restart sozvon.');
  const toggles = h('div', { class: 'admin-list admin-list--compact', id: 'admin-alert-toggles' }, ...r.alerts.map((a) => {
    const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: `admin-alert-${a.key}`, checked: a.enabled, dataset: { key: a.key } });
    sw.addEventListener('change', async () => {
      const res = await doAction(() => adminFetch('PATCH', '/api/admin/alerts', { toggles: { [a.key]: sw.checked } }), sw.checked ? 'Оповещение включено' : 'Оповещение выключено');
      if (!res) sw.checked = !sw.checked;
    });
    return h('label', { class: 'admin-row admin-row--static', for: `admin-alert-${a.key}` }, h('span', { class: 'admin-row__main' }, h('span', { class: 'admin-row__title' }, a.title)), sw);
  }));
  const active = h('div', { class: 'admin-list admin-list--compact', id: 'admin-alerts-active' }, ...(r.active.length ? r.active.map((a) => h('div', { class: 'admin-row admin-row--static admin-row--bad' },
    icon('i-info', 'icon--sm'), h('span', { class: 'admin-row__main' }, h('span', { class: 'admin-row__title' }, a.title), h('span', { class: 'admin-row__sub' }, `${a.text} · с ${fmtDate(a.since)}`)))) : [h('p', { class: 'admin-muted' }, 'Проблем нет')]));
  ui.content.replaceChildren(
    status,
    h('div', { class: 'admin-actions' },
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'admin-alert-test', disabled: !r.telegram.configured, onclick: () => doAction(() => adminFetch('POST', '/api/admin/alerts/test'), 'Тестовое уведомление отправлено') }, icon('i-bell', 'icon--sm'), 'Отправить тестовое уведомление'),
      h('button', { type: 'button', class: 'btn btn--sm', id: 'admin-alert-run', onclick: async () => { if (await doAction(() => adminFetch('POST', '/api/admin/alerts/run'), 'Проверка выполнена')) renderAlerts(); } }, icon('i-reset', 'icon--sm'), 'Проверить сейчас')),
    section('Сейчас', active, r.lastRun ? h('p', { class: 'admin-muted' }, `Последняя проверка: ${fmtDate(r.lastRun)}${r.lastError ? ` · ошибка отправки: ${r.lastError}` : ''}`) : null),
    section('Что проверять', toggles));
}

/* ------------------------------------------------------------------ обновление */
const pendingKey = 'astra.adminUpdate';
function setPending(v) { try { if (v) sessionStorage.setItem(pendingKey, JSON.stringify(v)); else sessionStorage.removeItem(pendingKey); } catch { /* приватный режим */ } }
function getPending() { try { return JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { return null; } }

let logOffset = 0;
async function renderUpdate() {
  let st;
  try { st = await adminFetch('GET', '/api/admin/update'); } catch (e) { ui.content.replaceChildren(failBox(e) || ''); return; }
  ui.upd = {
    info: h('div', { id: 'admin-update-info' }),
    log: h('pre', { class: 'admin-log admin-log--pre', id: 'admin-update-log', 'aria-live': 'polite' }),
    result: h('div', { id: 'admin-update-result', role: 'status' }),
  };
  ui.content.replaceChildren(ui.upd.info, ui.upd.result, section('Журнал обновления', ui.upd.log));
  logOffset = 0;
  paintUpdate(st);
  pollLog();
  if (st.running || st.pending || getPending()) watchUpdate();
}

function paintUpdate(st) {
  if (!ui.upd || !dlg?.open || current !== 'update') return;
  const c = st.current;
  const chk = st.check;
  const newer = chk && chk.behind > 0;
  const busy = st.running || !!st.pending;
  ui.upd.info.replaceChildren(
    h('div', { class: 'admin-hero' },
      icon('i-download', 'admin-hero__icon'),
      h('div', { class: 'admin-hero__main' },
        h('div', { class: 'admin-hero__title', id: 'admin-update-current' }, `Astra ${c.version || ''}${c.short ? ` · ${c.short}` : ''}`),
        h('div', { class: 'admin-row__sub' }, c.subject ? `${c.subject}${c.date ? ` (${fmtDate(c.date)})` : ''}` : 'Версия кода на сервере'),
        h('div', { class: 'admin-row__sub', id: 'admin-update-check' }, !chk ? 'Обновления ещё не проверялись'
          : chk.error ? `Проверка не удалась: ${chk.error}`
            : newer ? `Доступно обновление: новых изменений ${chk.behind} (до ${String(chk.latest || '').slice(0, 7)}), проверено ${fmtDate(chk.checkedAt)}`
              : `Установлена последняя версия (проверено ${fmtDate(chk.checkedAt)})`)),
      h('div', { class: 'admin-actions' },
        h('button', {
          type: 'button', class: 'btn btn--sm', id: 'admin-update-check-btn', disabled: busy || !st.helperInstalled,
          onclick: async () => { const r = await doAction(() => adminFetch('POST', '/api/admin/update/check'), 'Проверяю обновления…'); if (r) { paintUpdate(r); watchUpdate(); } },
        }, icon('i-reset', 'icon--sm'), 'Проверить обновления'),
        h('button', {
          type: 'button', class: 'btn btn--primary btn--sm', id: 'admin-update-run', disabled: busy || !st.helperInstalled,
          onclick: async () => {
            if (!await ask({ title: 'Обновить Astra?', text: 'Сервер скачает новую версию и перезапустится — у всех будет короткий разрыв связи (обычно 10–30 секунд), голосовые звонки переподключатся.', ok: 'Обновить' })) return;
            const r = await doAction(() => adminFetch('POST', '/api/admin/update/run', { confirm: true }), 'Обновление запущено');
            if (r) { setPending({ at: Date.now(), from: r.current?.short || null }); logOffset = 0; paintUpdate(r); watchUpdate(); }
          },
        }, icon('i-download', 'icon--sm'), 'Обновить Astra'))),
    !st.helperInstalled ? h('p', { class: 'admin-note admin-note--warn' }, icon('i-info', 'icon--sm'), 'Помощник обновления ещё не установлен. Один раз выполните на сервере: sudo bash /opt/sozvon/deploy/update.sh — дальше обновлять можно этой кнопкой.') : null,
    newer && chk.notes.length ? section('Что нового', h('ul', { class: 'admin-notes' }, ...chk.notes.map((n) => h('li', null, n)))) : null,
    busy ? h('p', { class: 'admin-note', id: 'admin-update-busy' }, icon('i-reset', 'icon--sm'), st.pending === 'check' ? 'Проверяю обновления…' : 'Идёт обновление — сервер перезапустится, страница переподключится сама.') : null);
}

async function pollLog() {
  if (!ui.upd || current !== 'update' || !dlg?.open) return;
  try {
    const r = await adminFetch('GET', `/api/admin/update/log?offset=${logOffset}`);
    if (r.offset < logOffset || logOffset === 0) ui.upd.log.textContent = '';
    ui.upd.log.textContent += r.text;
    logOffset = r.size;
    if (!ui.upd.log.textContent) ui.upd.log.textContent = 'Журнал пуст';
    ui.upd.log.scrollTop = ui.upd.log.scrollHeight;
  } catch { /* сервер перезапускается */ }
}

let watching = false;
/** Опрос состояния до завершения; переживает перезапуск сервера («Обновлено до …»). */
export async function watchUpdate() {
  if (watching) return;
  watching = true;
  let lost = false;
  const tick = async () => {
    let st = null;
    try { st = await adminFetch('GET', '/api/admin/update'); } catch (e) {
      if (e.status === 0 || e.status >= 500) {
        lost = true;
        if (ui.upd?.result && dlg?.open) ui.upd.result.replaceChildren(h('p', { class: 'admin-note' }, icon('i-reset', 'icon--sm'), 'Сервер перезапускается…'));
      }
    }
    if (st) {
      paintUpdate(st);
      pollLog();
      const pending = getPending();
      const finished = !st.running && !st.pending;
      if (finished && pending && st.status && st.status.startedAt >= pending.at - 60_000 && st.status.state !== 'running') {
        setPending(null);
        const ok = st.status.state === 'done';
        const text = ok ? `Обновлено до ${st.status.to || st.current.short || 'новой версии'}` : `Обновление не удалось (код ${st.status.exitCode}). Подробности — в журнале.`;
        toast(text, ok ? 'ok' : 'error', 8000);
        if (ui.upd?.result && dlg?.open) {
          ui.upd.result.replaceChildren(h('p', { class: `admin-note ${ok ? 'admin-note--ok' : 'admin-note--warn'}`, id: 'admin-update-done' }, icon(ok ? 'i-check' : 'i-info', 'icon--sm'), text,
            ok && lost ? h('button', { type: 'button', class: 'btn btn--sm', onclick: () => location.reload() }, 'Перезагрузить страницу') : null));
        }
        watching = false;
        return;
      }
      if (finished && !pending) { watching = false; return; }
    }
    updateTimer = setTimeout(tick, 2000);
  };
  clearTimeout(updateTimer);
  tick();
}

/* ------------------------------------------------------------------ журнал */
async function renderAudit() {
  let r;
  try { r = await adminFetch('GET', '/api/admin/audit?limit=300'); } catch (e) { ui.content.replaceChildren(failBox(e) || ''); return; }
  const fmtDetails = (d) => (d ? Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '');
  ui.content.replaceChildren(
    h('p', { class: 'admin-muted' }, 'Каждое действие администраторов (и admin.sh) записывается в DATA_DIR/admin-audit.jsonl.'),
    h('div', { class: 'admin-list admin-list--compact', id: 'admin-audit' }, ...(r.entries.length ? r.entries.map((e) => h('div', { class: 'admin-row admin-row--static', dataset: { action: e.action } },
      h('span', { class: 'admin-row__main' },
        h('span', { class: 'admin-row__title' }, h('b', null, e.actor?.username || '?'), ' ', ACTIONS[e.action] || e.action, e.target?.name ? ` «${e.target.name}»` : ''),
        h('span', { class: 'admin-row__sub' }, `${fmtDate(e.at)}${e.ip ? ` · ${e.ip}` : ''}${fmtDetails(e.details) ? ` · ${fmtDetails(e.details)}` : ''}`)))) : [h('p', { class: 'admin-muted' }, 'Журнал пуст')])));
}


