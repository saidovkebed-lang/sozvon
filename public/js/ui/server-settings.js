// Полноэкранная модалка «Настройки сервера» (#modal-settings, SPEC-v3 §1): Обзор, Роли, Участники, Баны,
// Каналы → права канала, Удалить сервер / Покинуть сервер. Разделы показываются по правам.
// DOM-контракт v1 сохранён: #btn-server-menu → #modal-settings, #server-rename-input + единственная
// button[type=submit] (сохранение обзора), #btn-server-delete (владелец), #btn-server-leave (не владелец).
import { $, $$, h, icon, avatar, displayName, initials, safeColor, safeMediaUrl, fmtDate } from '../util.js';
import { state, subscribe, getServer, getChannel, upsertServer, notify, presenceOf } from '../state.js';
import { emitAck } from '../socket.js';
import { api } from '../api.js';
import {
  PERMS, PERM_GROUPS, can, sortedRoles, memberRoles, memberRoleIds, canManageRole, isServerOwner, highestPosition, isPrivateChannel,
  roleColor,
} from '../perms.js';
import { sortedChannels } from '../nav.js';
import { openModal, closeModal, setModalError, confirmDialog } from './modals.js';
import { toast, toastOk, toastError } from './toasts.js';
import { act, applyServerFromAck, kickMember, banMember, unbanMember, toggleMemberRole, setMemberRoles, capabilities } from './mod-actions.js';
import { openMenuFor } from './context-menu.js';
import { openCropper } from './cropper.js';
import { AVATAR_PALETTE } from './palette.js';
import { themePanel, renderThemePanel } from './server-theme.js';

const MOBILE = '(max-width: 639.98px)';
const dlg = () => $('#modal-settings');
let current = 'overview';
let built = false;
let serverId = null;
let returnFocus = null;

const SECTIONS = [
  { id: 'overview', title: 'Обзор', icon: 'i-info', group: null, show: () => true },
  { id: 'roles', title: 'Роли', icon: 'i-shield', show: (s) => can(s, 'MANAGE_ROLES') },
  { id: 'members', title: 'Участники', icon: 'i-users', show: (s) => can(s, 'MANAGE_ROLES') || can(s, 'KICK_MEMBERS') || can(s, 'BAN_MEMBERS') },
  { id: 'bans', title: 'Баны', icon: 'i-ban', show: (s) => can(s, 'BAN_MEMBERS') },
  { id: 'channels', title: 'Каналы', icon: 'i-hash', show: (s) => can(s, 'MANAGE_CHANNELS') },
  { id: 'appearance', title: 'Оформление', icon: 'i-palette', show: (s) => can(s, 'MANAGE_SERVER') },
];

const srv = () => getServer(serverId);

/* ============================================================
   Обзор
   ============================================================ */
let overviewDirty = false;
let pendingIcon = undefined;   // undefined — без изменений, null — удалить, {file,crop,url} — новая
let pendingBanner = undefined;

function overviewPanel() {
  const iconBox = h('div', { class: 'ss-icon', id: 'ss-icon-preview' });
  const bannerBox = h('div', { class: 'ss-banner', id: 'ss-banner-preview' });
  const iconInput = h('input', { type: 'file', id: 'ss-icon-input', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  const bannerInput = h('input', { type: 'file', id: 'ss-banner-input', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  iconInput.addEventListener('change', () => pickImage(iconInput, 'icon'));
  bannerInput.addEventListener('change', () => pickImage(bannerInput, 'banner'));

  const desc = h('textarea', { class: 'input', id: 'server-description-input', name: 'description', maxlength: '300', rows: '3', placeholder: 'Расскажите, о чём этот сервер' });
  const count = h('span', { class: 'field__count', id: 'server-description-count' }, '0/300');
  desc.addEventListener('input', () => { count.textContent = `${desc.value.length}/300`; });

  const form = h('form', { class: 'form ss-overview', id: 'form-settings', novalidate: true },
    h('div', { class: 'ss-media' },
      h('div', { class: 'ss-media__icon' },
        iconBox,
        h('div', { class: 'ss-media__text' },
          h('div', { class: 'setting__label' }, 'Иконка сервера'),
          h('p', { class: 'setting__desc' }, 'Квадратная картинка от 256×256. Можно GIF.'),
          h('div', { class: 'ss-media__btns', dataset: { manage: '' } },
            h('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: () => iconInput.click() }, icon('i-upload'), 'Загрузить'),
            h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'ss-icon-remove', onclick: () => { pendingIcon = null; markDirty(); renderMedia(); } }, 'Убрать')),
          iconInput)),
      h('div', { class: 'ss-media__banner' },
        bannerBox,
        h('div', { class: 'ss-media__btns', dataset: { manage: '' } },
          h('button', { type: 'button', class: 'btn btn--sm', onclick: () => bannerInput.click() }, icon('i-image'), 'Баннер'),
          h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'ss-banner-remove', onclick: () => { pendingBanner = null; markDirty(); renderMedia(); } }, 'Убрать')),
        bannerInput)),
    h('div', { class: 'field' },
      h('label', { class: 'field__label', for: 'server-rename-input' }, 'Название сервера'),
      h('input', { class: 'input', id: 'server-rename-input', name: 'name', maxlength: '50', required: true, autocomplete: 'off' })),
    h('div', { class: 'field' },
      h('div', { class: 'field__row' }, h('label', { class: 'field__label', for: 'server-description-input' }, 'Описание'), count),
      desc),
    h('p', { class: 'form__error', id: 'ss-overview-error', 'data-error': '' }),
    h('p', { class: 'settings-note', id: 'ss-readonly-note', hidden: true }, icon('i-lock', 'icon--sm'), 'Только просмотр: менять сервер может участник с правом «Управлять сервером».'),
    h('div', { class: 'save-bar', id: 'ss-save-bar', role: 'region', 'aria-label': 'Несохранённые изменения', hidden: true },
      h('span', { class: 'save-bar__text' }, 'Есть несохранённые изменения'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => fillOverview(true) }, 'Сбросить'),
      h('button', { type: 'submit', class: 'btn btn--primary btn--sm', id: 'ss-save' }, 'Сохранить изменения')));
  form.addEventListener('input', (e) => { if (e.target.matches('#server-rename-input, #server-description-input')) markDirty(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); saveOverview(); });

  const invite = h('div', { class: 'invite-card', id: 'ss-invite' },
    h('div', { class: 'invite-card__text' },
      h('div', { class: 'setting__label' }, 'Инвайт-код'),
      h('code', { class: 'invite-card__code', id: 'ss-invite-code' })),
    h('button', { type: 'button', class: 'btn btn--sm', onclick: copyInviteLink }, icon('i-copy'), 'Скопировать ссылку'),
    h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'ss-invite-regen', dataset: { manage: '' }, onclick: regenerateInvite }, icon('i-reset'), 'Новый код'));

  const danger = h('div', { class: 'settings-block', id: 'ss-danger', hidden: true },
    h('h3', { class: 'settings-block__title' }, 'Опасная зона'),
    h('div', { class: 'setting setting--danger' },
      h('div', { class: 'setting__text' },
        h('span', { class: 'setting__label' }, 'Передать владение'),
        h('p', { class: 'setting__desc' }, 'Новый владелец получит все права, включая удаление сервера. Вы останетесь участником.')),
      h('div', { class: 'ss-transfer' },
        h('select', { class: 'input', id: 'ss-transfer-select', 'aria-label': 'Новый владелец' }),
        h('button', { type: 'button', class: 'btn btn--danger', id: 'btn-server-transfer', onclick: transferFromOverview }, 'Передать'))),
    h('div', { class: 'setting setting--danger' },
      h('div', { class: 'setting__text' },
        h('span', { class: 'setting__label' }, 'Удалить сервер'),
        h('p', { class: 'setting__desc' }, 'Каналы, история и роли будут удалены у всех участников. Это нельзя отменить.')),
      h('button', { type: 'button', class: 'btn btn--danger', id: 'btn-server-delete', onclick: deleteServer }, icon('i-trash'), 'Удалить сервер')));

  return [form, section('Приглашение', invite), danger];
}

function section(title, ...children) {
  return h('div', { class: 'settings-block' }, title ? h('h3', { class: 'settings-block__title' }, title) : null, ...children);
}

function markDirty() {
  overviewDirty = true;
  if (can(srv(), 'MANAGE_SERVER')) $('#ss-save-bar').hidden = false;
}

function mediaUrl(kind) {
  const s = srv();
  const p = kind === 'icon' ? pendingIcon : pendingBanner;
  if (p === null) return null;
  if (p && p.url) return p.url;
  return safeMediaUrl(kind === 'icon' ? s?.icon : s?.banner);
}

function renderMedia() {
  const s = srv();
  if (!s) return;
  const ic = $('#ss-icon-preview');
  const iu = mediaUrl('icon');
  ic.replaceChildren(iu ? h('img', { src: iu, alt: '' }) : h('span', null, initials(s.name)));
  ic.classList.toggle('has-img', !!iu);
  const bn = $('#ss-banner-preview');
  const bu = mediaUrl('banner');
  bn.replaceChildren(bu ? h('img', { src: bu, alt: '' }) : h('span', { class: 'ss-banner__empty' }, icon('i-image'), 'Баннер сервера (2,8 : 1)'));
  bn.classList.toggle('has-img', !!bu);
  $('#ss-icon-remove').hidden = !iu;
  $('#ss-banner-remove').hidden = !bu;
}

async function pickImage(input, kind) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('Файл больше 15 МБ'); return; }
  const res = await openCropper(file, { aspect: kind === 'icon' ? 1 : 960 / 340, round: kind === 'icon', title: kind === 'icon' ? 'Иконка сервера' : 'Баннер сервера' });
  if (!res) return;
  const p = { file, crop: res.crop, url: res.previewUrl };
  if (kind === 'icon') pendingIcon = p; else pendingBanner = p;
  markDirty();
  renderMedia();
}

function fillOverview(reset = false) {
  const s = srv();
  if (!s) return;
  const manage = can(s, 'MANAGE_SERVER');
  if (reset || !overviewDirty) {
    $('#server-rename-input').value = s.name;
    $('#server-description-input').value = s.description || '';
    $('#server-description-count').textContent = `${(s.description || '').length}/300`;
    pendingIcon = undefined;
    pendingBanner = undefined;
    overviewDirty = false;
    $('#ss-save-bar').hidden = true;
    $('#ss-overview-error').textContent = '';
  }
  $('#server-rename-input').readOnly = !manage;
  $('#server-rename-input').required = manage;
  $('#server-description-input').readOnly = !manage;
  $('#ss-readonly-note').hidden = manage;
  $$('[data-manage]', dlg()).forEach((e) => { e.hidden = !manage; });
  renderMedia();
  // инвайт
  const code = s.inviteCode;
  $('#ss-invite').closest('.settings-block').hidden = !code;
  $('#ss-invite-code').textContent = code || '';
  // опасная зона — только владелец
  const owner = isServerOwner(s);
  $('#ss-danger').hidden = !owner;
  if (owner) {
    const sel = $('#ss-transfer-select');
    const keep = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'Выберите участника…'),
      ...s.members.filter((m) => !m.isBot && m.id !== state.user?.id)
        .sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'))
        .map((m) => h('option', { value: m.id }, `${displayName(m)} (@${m.username})`)));
    sel.value = keep;
    $('#btn-server-transfer').disabled = sel.options.length <= 1;
  }
}

async function saveOverview() {
  const s = srv();
  if (!s || !can(s, 'MANAGE_SERVER')) return;
  const err = $('#ss-overview-error');
  const name = $('#server-rename-input').value.trim();
  const description = $('#server-description-input').value.trim();
  if (!name) { err.textContent = 'Введите название'; $('#server-rename-input').focus(); return; }
  err.textContent = '';
  const btn = $('#ss-save');
  btn.disabled = true;
  try {
    if (name !== s.name) {
      // server:rename (v1) понимают и старый, и новый сервер
      await emitAck('server:rename', { serverId: s.id, name });
      s.name = name;
    }
    if (description !== (s.description || '')) {
      applyServerFromAck(await emitAck('server:update', { serverId: s.id, description }));
    }
    if (pendingIcon === null) applyServerFromAck(await emitAck('server:update', { serverId: s.id, icon: null }));
    else if (pendingIcon) { const r = await api.uploadServerIcon(s.id, pendingIcon.file, pendingIcon.crop); if (r?.server) upsertServer(r.server); }
    if (pendingBanner === null) applyServerFromAck(await emitAck('server:update', { serverId: s.id, banner: null }));
    else if (pendingBanner) { const r = await api.uploadServerBanner(s.id, pendingBanner.file, pendingBanner.crop); if (r?.server) upsertServer(r.server); }
    upsertServer(getServer(s.id) || s);
    notify('servers');
    overviewDirty = false;
    fillOverview(true);
    toastOk('Изменения сохранены');
    // контракт v1: после сохранения названия модалка закрывается (как прежний #modal-settings)
    closeModal(dlg());
  } catch (e) {
    err.textContent = e.message;
  } finally { btn.disabled = false; }
}

export function inviteLink(code) {
  return `${state.publicUrl || location.origin}/?invite=${code}`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true' });
    ta.value = text;
    (document.querySelector('dialog[open]') || document.body).append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function copyInviteLink() {
  const code = srv()?.inviteCode;
  if (!code) return;
  if (await copyText(inviteLink(code))) toastOk('Ссылка-приглашение скопирована');
  else toast(`Скопируйте вручную: ${inviteLink(code)}`, '', 8000);
}

async function regenerateInvite() {
  const s = srv();
  if (!s) return;
  const yes = await confirmDialog({ title: 'Новый инвайт-код', text: 'Старая ссылка-приглашение перестанет работать. Участники сервера останутся.', ok: 'Создать новый', danger: false });
  if (!yes) return;
  const res = await act('server:update', { serverId: s.id, regenerateInvite: true }, 'Создан новый инвайт-код');
  if (res) fillOverview();
}

async function transferFromOverview() {
  const s = srv();
  const userId = $('#ss-transfer-select').value;
  if (!s || !userId) { toast('Выберите нового владельца', '', 2500); return; }
  const { transferOwnership } = await import('./mod-actions.js');
  if (await transferOwnership(s, userId)) render();
}

async function deleteServer() {
  const s = srv();
  if (!s) return;
  closeModal(dlg());
  const yes = await confirmDialog({ title: 'Удалить сервер', text: `Сервер «${s.name}» будет удалён для всех участников. Это нельзя отменить.`, ok: 'Удалить' });
  if (!yes) return;
  try { await emitAck('server:delete', { serverId: s.id }); } catch (ex) { toastError(ex); }
}

async function leaveServer() {
  const s = srv();
  if (!s) return;
  closeModal(dlg());
  const yes = await confirmDialog({ title: 'Покинуть сервер', text: `Покинуть «${s.name}»? Вернуться можно по инвайт-коду.`, ok: 'Покинуть' });
  if (!yes) return;
  try { await emitAck('server:leave', { serverId: s.id }); } catch (ex) { toastError(ex); }
}

/* ============================================================
   Роли
   ============================================================ */
let selectedRole = null;
let roleTab = 'display';
let roleSearch = '';
let permSearch = '';
const roleTimers = new Map();

function rolesPanel() {
  return [
    h('p', { class: 'settings-lead' }, 'Роли группируют участников и дают им права. Порядок важен: роль выше в списке главнее — модераторы управляют только ролями и участниками ниже своей высшей роли. Перетаскивайте роли, чтобы поменять порядок.'),
    h('div', { class: 'roles-layout', id: 'roles-layout' },
      h('div', { class: 'roles-side' },
        h('div', { class: 'roles-side__top' },
          h('div', { class: 'search-input' }, icon('i-search', 'icon--sm'),
            h('input', { class: 'input', id: 'role-search', placeholder: 'Поиск ролей', 'aria-label': 'Поиск ролей', oninput: (e) => { roleSearch = e.target.value; renderRoleList(); } })),
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'btn-role-create', onclick: createRole }, icon('i-plus'), 'Создать')),
        h('div', { class: 'role-list', id: 'role-list', role: 'listbox', 'aria-label': 'Роли' })),
      h('div', { class: 'role-editor', id: 'role-editor' })),
  ];
}

function memberCount(s, roleId) {
  if (roleId === s.id) return s.members.filter((m) => !m.isBot).length;
  return Object.values(s.memberRoles || {}).filter((ids) => ids.includes(roleId)).length;
}

function renderRoleList() {
  const s = srv();
  const box = $('#role-list');
  if (!s || !box) return;
  const q = roleSearch.trim().toLowerCase();
  const roles = sortedRoles(s);
  if (!selectedRole || !roles.some((r) => r.id === selectedRole)) selectedRole = roles.find((r) => r.id !== s.id)?.id || s.id;
  box.replaceChildren(...roles.filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => {
    const everyone = r.id === s.id;
    const editable = !everyone && canManageRole(s, r);
    const row = h('div', {
      class: 'role-row' + (r.id === selectedRole ? ' is-active' : '') + (everyone ? ' role-row--everyone' : '') + (editable ? '' : ' is-locked'),
      role: 'option', tabindex: '0', 'aria-selected': String(r.id === selectedRole),
      dataset: { roleId: r.id }, draggable: editable && !q ? 'true' : 'false',
      style: { '--rc': r.color || 'var(--text-faint)' },
    },
    h('span', { class: 'role-row__grip', 'aria-hidden': 'true' }, editable && !q ? icon('i-grip', 'icon--sm') : null),
    h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'role-row__name' }, everyone ? '@everyone' : r.name),
    !editable && !everyone ? icon('i-lock', 'icon--sm role-row__lock') : null,
    h('span', { class: 'role-row__count', title: 'Участников с ролью' }, icon('i-user', 'icon--sm'), String(memberCount(s, r.id))));
    return row;
  }));
}

function selectRole(id) {
  selectedRole = id;
  renderRoleList();
  renderRoleEditor();
}

function roleById(id) { return srv()?.roles?.find((r) => r.id === id) || null; }

/** Оптимистичное изменение роли + role:update (текст/цвет — с задержкой) */
function updateRole(roleId, patch, { delay = 0 } = {}) {
  const s = srv();
  const r = roleById(roleId);
  if (!s || !r) return;
  Object.assign(r, patch);
  notify('servers');
  const send = async () => {
    roleTimers.delete(roleId + Object.keys(patch).join());
    try {
      applyServerFromAck(await emitAck('role:update', { serverId: s.id, roleId, ...patch }));
    } catch (e) { toastError(e); }
  };
  const key = roleId + Object.keys(patch).join();
  clearTimeout(roleTimers.get(key));
  if (delay) roleTimers.set(key, setTimeout(send, delay)); else send();
}

async function createRole() {
  const s = srv();
  if (!s) return;
  try {
    const res = applyServerFromAck(await emitAck('role:create', { serverId: s.id, name: 'Новая роль', color: null, permissions: 0 }));
    if (res?.role) {
      if (!roleById(res.role.id)) { s.roles = [...(s.roles || []), res.role]; notify('servers'); }
      roleTab = 'display';
      selectRole(res.role.id);
      $('#role-name-input')?.select();
    }
  } catch (e) { toastError(e); }
}

async function deleteRole(r) {
  const s = srv();
  const yes = await confirmDialog({ title: `Удалить роль «${r.name}»`, text: 'Роль снимут со всех участников. Это нельзя отменить.', ok: 'Удалить' });
  if (!yes) return;
  const res = await act('role:delete', { serverId: s.id, roleId: r.id }, 'Роль удалена');
  if (res) {
    s.roles = (s.roles || []).filter((x) => x.id !== r.id);
    selectedRole = null;
    renderRoleList();
    renderRoleEditor();
  }
}

function renderRoleEditor() {
  const s = srv();
  const box = $('#role-editor');
  if (!s || !box) return;
  const r = roleById(selectedRole);
  if (!r) { box.replaceChildren(h('p', { class: 'settings-hint' }, 'Выберите роль слева')); return; }
  const everyone = r.id === s.id;
  const editable = everyone ? can(s, 'MANAGE_ROLES') && (isServerOwner(s) || can(s, 'ADMINISTRATOR')) || can(s, 'MANAGE_ROLES') : canManageRole(s, r);
  if (everyone && roleTab === 'display') roleTab = 'perms';
  if (everyone && roleTab === 'members') roleTab = 'perms';
  const tabs = h('div', { class: 'tabs role-tabs', role: 'tablist' },
    ...[['display', 'Отображение'], ['perms', 'Права'], ['members', `Участники (${memberCount(s, r.id)})`]]
      .filter(([id]) => !everyone || id === 'perms')
      .map(([id, label]) => h('button', {
        type: 'button', class: 'tab' + (roleTab === id ? ' is-active' : ''), role: 'tab', 'aria-selected': String(roleTab === id),
        dataset: { roleTab: id }, onclick: () => { roleTab = id; renderRoleEditor(); },
      }, label)));
  const head = h('div', { class: 'role-editor__head' },
    h('button', { type: 'button', class: 'icon-btn role-editor__back', 'aria-label': 'К списку ролей', onclick: () => $('#roles-layout').classList.remove('is-editing') }, icon('i-arrow-left')),
    h('div', { class: 'role-editor__title', style: { '--rc': r.color || 'var(--text-faint)' } },
      h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }), everyone ? '@everyone' : r.name),
    !everyone && editable ? h('button', { type: 'button', class: 'icon-btn icon-btn--danger', id: 'btn-role-delete', 'aria-label': `Удалить роль ${r.name}`, title: 'Удалить роль', onclick: () => deleteRole(r) }, icon('i-trash')) : null);
  let body;
  if (roleTab === 'display') body = roleDisplay(r, editable);
  else if (roleTab === 'members') body = roleMembers(r, editable);
  else body = rolePerms(r, editable, everyone);
  box.replaceChildren(...[head,
    !editable ? h('p', { class: 'settings-note settings-note--warn' }, icon('i-lock', 'icon--sm'), 'Эта роль не ниже вашей высшей роли — менять её нельзя.') : null,
    everyone ? h('p', { class: 'settings-hint' }, 'Права @everyone есть у всех участников сервера. Остальные роли добавляют права поверх них.') : null,
    tabs, body].filter(Boolean));
}

function roleDisplay(r, editable) {
  const name = h('input', { class: 'input', id: 'role-name-input', maxlength: '32', value: r.name, disabled: !editable, autocomplete: 'off' });
  name.addEventListener('input', () => {
    const v = name.value.trim();
    if (v) updateRole(r.id, { name: v.slice(0, 32) }, { delay: 500 });
    $('.role-editor__title', dlg())?.lastChild && ($('.role-editor__title', dlg()).lastChild.textContent = v || r.name);
    renderRoleList();
  });
  const cur = (r.color || '').toLowerCase();
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Цвет роли' },
    h('button', {
      type: 'button', class: 'swatch swatch--none' + (!r.color ? ' is-selected' : ''), role: 'radio', 'aria-checked': String(!r.color),
      title: 'Без цвета', 'aria-label': 'Без цвета', disabled: !editable, dataset: { roleColor: '' },
    }, icon('i-close', 'swatch__check')),
    ...AVATAR_PALETTE.map((c) => h('button', {
      type: 'button', class: 'swatch' + (cur === c ? ' is-selected' : ''), role: 'radio', 'aria-checked': String(cur === c),
      style: { '--c': c }, title: c, 'aria-label': `Цвет ${c}`, disabled: !editable, dataset: { roleColor: c },
    }, icon('i-check', 'swatch__check'))),
    h('label', { class: 'swatch swatch--custom' + (r.color && !AVATAR_PALETTE.includes(cur) ? ' is-selected' : ''), title: 'Свой цвет' },
      h('input', { type: 'color', id: 'role-color-custom', value: r.color || '#99aab5', 'aria-label': 'Свой цвет роли', disabled: !editable }),
      icon('i-palette', 'swatch__icon')));
  swatches.addEventListener('click', (e) => {
    const b = e.target.closest('[data-role-color]');
    if (!b || b.disabled) return;
    updateRole(r.id, { color: b.dataset.roleColor || null });
    renderRoleEditor();
    renderRoleList();
  });
  swatches.addEventListener('input', (e) => {
    if (e.target.id !== 'role-color-custom') return;
    updateRole(r.id, { color: e.target.value }, { delay: 400 });
    $$('.swatch', swatches).forEach((x) => x.classList.toggle('is-selected', x.classList.contains('swatch--custom')));
    renderRoleList();
  });
  const flag = (key, label, desc) => {
    const id = `role-flag-${key}`;
    const cb = h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', dataset: { roleFlag: key }, disabled: !editable });
    cb.checked = !!r[key];
    cb.addEventListener('change', () => updateRole(r.id, { [key]: cb.checked }));
    return h('div', { class: 'setting' }, h('div', { class: 'setting__text' }, h('label', { class: 'setting__label', for: id }, label), h('p', { class: 'setting__desc' }, desc)), cb);
  };
  return h('div', { class: 'role-pane' },
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'role-name-input' }, 'Название роли'), name),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Цвет роли'), h('p', { class: 'setting__desc' }, 'Ники участников окрашиваются в цвет их высшей роли с цветом.'), swatches),
    flag('hoist', 'Показывать отдельно', 'Участники с этой ролью собираются в свою группу в списке участников.'),
    flag('mentionable', 'Разрешить упоминать роль', 'Любой участник сможет упомянуть эту роль в сообщении.'));
}

function rolePerms(r, editable, everyone) {
  const s = srv();
  const search = h('div', { class: 'search-input' }, icon('i-search', 'icon--sm'),
    h('input', { class: 'input', id: 'perm-search', placeholder: 'Поиск прав', 'aria-label': 'Поиск прав', value: permSearch }));
  const groups = h('div', { class: 'perm-groups' });
  const fill = () => {
    const q = permSearch.trim().toLowerCase();
    groups.replaceChildren(...PERM_GROUPS.map((g) => {
      const rows = g.perms.filter(([, label, desc]) => !q || label.toLowerCase().includes(q) || desc.toLowerCase().includes(q)).map(([key, label, desc]) => {
        const id = `perm-${key}`;
        const bit = PERMS[key];
        // нельзя выдать право, которого нет у себя (кроме владельца)
        const canGrant = isServerOwner(s) || can(s, bit);
        const cb = h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', dataset: { perm: key }, disabled: !editable || !canGrant });
        cb.checked = ((r.permissions || 0) & bit) === bit;
        cb.addEventListener('change', () => {
          const p = cb.checked ? (r.permissions | bit) : (r.permissions & ~bit);
          updateRole(r.id, { permissions: p });
        });
        return h('div', { class: 'setting perm-row' + (key === 'ADMINISTRATOR' ? ' perm-row--admin' : '') },
          h('div', { class: 'setting__text' }, h('label', { class: 'setting__label', for: id }, label), h('p', { class: 'setting__desc' }, desc)), cb);
      });
      if (!rows.length) return null;
      return h('div', { class: 'perm-group' }, h('h4', { class: 'perm-group__title' }, g.title), ...rows);
    }).filter(Boolean));
    if (!groups.children.length) groups.append(h('p', { class: 'settings-hint' }, 'Ничего не найдено'));
  };
  search.querySelector('input').addEventListener('input', (e) => { permSearch = e.target.value; fill(); });
  fill();
  return h('div', { class: 'role-pane' },
    search,
    !everyone && editable ? h('div', { class: 'role-pane__actions' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { updateRole(r.id, { permissions: 0 }); renderRoleEditor(); } }, icon('i-reset'), 'Снять все права')) : null,
    groups);
}

function roleMembers(r, editable) {
  const s = srv();
  const holders = s.members.filter((m) => !m.isBot && memberRoleIds(s, m.id).includes(r.id));
  const others = s.members.filter((m) => !m.isBot && !memberRoleIds(s, m.id).includes(r.id));
  const sel = h('select', { class: 'input', id: 'role-add-member-select', 'aria-label': 'Участник', disabled: !editable || !others.length },
    h('option', { value: '' }, others.length ? 'Выберите участника…' : 'Все участники уже с этой ролью'),
    ...others.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru')).map((m) => h('option', { value: m.id }, `${displayName(m)} (@${m.username})`)));
  const add = h('button', {
    type: 'button', class: 'btn btn--primary btn--sm', id: 'btn-role-add-member', disabled: !editable || !others.length,
    onclick: async () => {
      if (!sel.value) { sel.focus(); return; }
      if (await toggleMemberRole(s, sel.value, r.id, true)) renderRoleEditor();
    },
  }, icon('i-plus'), 'Добавить');
  const list = h('div', { class: 'role-members', id: 'role-members' },
    ...(holders.length ? holders.map((m) => h('div', { class: 'role-member', dataset: { userId: m.id } },
      avatar(m, 'sm'),
      h('span', { class: 'role-member__name' }, displayName(m)),
      h('span', { class: 'role-member__user' }, `@${m.username}`),
      editable && (capabilities(s, m.id).roles) ? h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `Убрать роль у ${displayName(m)}`, title: 'Убрать из роли',
        onclick: async () => { if (await toggleMemberRole(s, m.id, r.id, false)) renderRoleEditor(); },
      }, icon('i-close', 'icon--sm')) : null))
      : [h('p', { class: 'settings-hint role-members__empty' }, 'У этой роли пока нет участников')]));
  return h('div', { class: 'role-pane' }, h('div', { class: 'role-add' }, sel, add), list);
}

/* drag & drop порядка ролей (мышь/тач — HTML5 DnD; клавиатура — Alt+↑/↓) */
function initRoleDnd() {
  const box = $('#role-list');
  let dragId = null;
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.role-row');
    if (!row) return;
    selectRole(row.dataset.roleId);
    $('#roles-layout').classList.add('is-editing');
  });
  box.addEventListener('keydown', (e) => {
    const row = e.target.closest('.role-row');
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && row.draggable) {
      e.preventDefault();
      moveRole(row.dataset.roleId, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const rows = $$('.role-row', box);
      const i = rows.indexOf(row);
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))]?.focus();
    }
  });
  box.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.role-row[draggable="true"]');
    if (!row) { e.preventDefault(); return; }
    dragId = row.dataset.roleId;
    row.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch { /* ignore */ }
  });
  box.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const row = e.target.closest('.role-row');
    if (!row || row.dataset.roleId === dragId || row.classList.contains('role-row--everyone') || row.classList.contains('is-locked')) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    $$('.role-row', box).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) $$('.role-row', box).forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
  box.addEventListener('drop', (e) => {
    const row = e.target.closest('.role-row.drop-before, .role-row.drop-after');
    if (!row || !dragId) return;
    e.preventDefault();
    const after = row.classList.contains('drop-after');
    reorder(dragId, row.dataset.roleId, after);
  });
  box.addEventListener('dragend', () => {
    dragId = null;
    $$('.role-row', box).forEach((x) => x.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  });
}

function reorder(movedId, targetId, after) {
  const s = srv();
  const ids = sortedRoles(s).filter((r) => r.id !== s.id).map((r) => r.id).filter((id) => id !== movedId);
  let i = ids.indexOf(targetId);
  if (i < 0) return;
  if (after) i += 1;
  ids.splice(i, 0, movedId);
  applyOrder(ids);
}

function moveRole(id, dir) {
  const s = srv();
  const ids = sortedRoles(s).filter((r) => r.id !== s.id).map((r) => r.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  const target = roleById(ids[j]);
  if (!canManageRole(s, target)) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  applyOrder(ids);
  requestAnimationFrame(() => $(`.role-row[data-role-id="${id}"]`)?.focus());
}

async function applyOrder(ids) {
  const s = srv();
  const before = (s.roles || []).map((r) => ({ id: r.id, position: r.position }));
  // оптимистично: сверху вниз → позиции n..1
  ids.forEach((id, k) => { const r = roleById(id); if (r) r.position = ids.length - k; });
  renderRoleList();
  notify('servers');
  try {
    applyServerFromAck(await emitAck('role:reorder', { serverId: s.id, roleIds: ids }));
  } catch (e) {
    for (const b of before) { const r = roleById(b.id); if (r) r.position = b.position; }
    renderRoleList();
    notify('servers');
    toastError(e);
  }
}

/* ============================================================
   Участники
   ============================================================ */
let memberQuery = '';

function membersPanel() {
  return [
    h('div', { class: 'sm-toolbar' },
      h('div', { class: 'search-input' }, icon('i-search', 'icon--sm'),
        h('input', { class: 'input', id: 'sm-search', placeholder: 'Поиск участников', 'aria-label': 'Поиск участников', oninput: (e) => { memberQuery = e.target.value; renderMembers(); } })),
      h('span', { class: 'sm-count', id: 'sm-count' })),
    h('div', { class: 'sm-list', id: 'sm-list' }),
  ];
}

function renderMembers() {
  const s = srv();
  const box = $('#sm-list');
  if (!s || !box) return;
  const q = memberQuery.trim().toLowerCase();
  const list = s.members
    .filter((m) => !q || m.username.toLowerCase().includes(q) || displayName(m).toLowerCase().includes(q))
    .sort((a, b) => (highestPosition(s, b.id) - highestPosition(s, a.id)) || displayName(a).localeCompare(displayName(b), 'ru'));
  $('#sm-count').textContent = `${s.members.length} ${plural(s.members.length, ['участник', 'участника', 'участников'])}`;
  box.replaceChildren(...list.map((m) => {
    const caps = capabilities(s, m.id);
    const roles = memberRoles(s, m.id);
    const color = roleColor(s, m.id);
    const av = avatar(m, '');
    const row = h('div', { class: 'sm-member', dataset: { userId: m.id } },
      av,
      h('div', { class: 'sm-member__who' },
        h('div', { class: 'sm-member__name', style: color ? { color } : null }, displayName(m),
          m.id === s.ownerId ? icon('i-crown', 'icon--sm sm-member__crown') : null,
          m.isBot ? h('span', { class: 'badge badge--bot' }, 'БОТ') : null),
        h('div', { class: 'sm-member__user' }, `@${m.username}`, presenceOf(m) === 'offline' ? ' · не в сети' : '')),
      h('div', { class: 'sm-member__roles' },
        ...roles.map((r) => h('span', { class: 'role-pill role-pill--sm', dataset: { roleId: r.id }, style: { '--rc': r.color || 'var(--text-faint)' } },
          h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }), h('span', { class: 'role-pill__name' }, r.name))),
        caps.roles ? h('button', {
          type: 'button', class: 'role-pill role-pill--add role-pill--sm', 'aria-label': `Роли ${displayName(m)}`, title: 'Роли', dataset: { action: 'roles' },
          onclick: (e) => { const b = e.currentTarget.getBoundingClientRect(); openMenuFor(row, b.left, b.bottom + 4, { page: 'roles' }); },
        }, icon('i-plus', 'icon--sm')) : null),
      h('div', { class: 'sm-member__actions' },
        caps.kick ? h('button', { type: 'button', class: 'icon-btn', dataset: { action: 'kick' }, 'aria-label': `Выгнать ${displayName(m)}`, title: 'Выгнать', onclick: () => kickMember(s, m.id) }, icon('i-door', 'icon--sm')) : null,
        caps.ban ? h('button', { type: 'button', class: 'icon-btn icon-btn--danger', dataset: { action: 'ban' }, 'aria-label': `Забанить ${displayName(m)}`, title: 'Забанить', onclick: () => banMember(s, m.id) }, icon('i-ban', 'icon--sm')) : null,
        h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': `Действия: ${displayName(m)}`, title: 'Ещё', 'aria-haspopup': 'menu',
          onclick: (e) => { const b = e.currentTarget.getBoundingClientRect(); openMenuFor(row, b.left - 200, b.bottom + 4); },
        }, icon('i-more', 'icon--sm'))));
    return row;
  }));
  if (!list.length) box.append(h('p', { class: 'settings-hint sm-empty' }, 'Никого не нашли'));
}

function plural(n, [one, few, many]) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ============================================================
   Баны
   ============================================================ */
function bansPanel() {
  return [h('p', { class: 'settings-lead' }, 'Забаненные не могут вернуться по инвайту, пока бан не снимут.'), h('div', { class: 'ban-list', id: 'ban-list' })];
}

function renderBans() {
  const s = srv();
  const box = $('#ban-list');
  if (!s || !box) return;
  const bans = Object.entries(s.bans || {}).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
  if (!bans.length) {
    box.replaceChildren(h('div', { class: 'empty-state' }, icon('i-shield', 'icon--lg'), h('h4', null, 'Банов нет'), h('p', null, 'Здесь появятся заблокированные участники.')));
    return;
  }
  box.replaceChildren(...bans.map(([userId, b]) => {
    const u = b?.user || { id: userId, username: b?.username || userId.slice(0, 8), color: null };
    const by = s.members.find((m) => m.id === b?.by);
    return h('div', { class: 'ban-row', dataset: { userId } },
      avatar(u, ''),
      h('div', { class: 'ban-row__who' },
        h('div', { class: 'ban-row__name' }, displayName(u), h('span', { class: 'ban-row__user' }, ` @${u.username}`)),
        h('div', { class: 'ban-row__meta' },
          b?.reason ? `Причина: ${b.reason}` : 'Без причины',
          b?.at ? ` · ${fmtDate(b.at)}` : '',
          by ? ` · ${displayName(by)}` : '')),
      h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'unban' }, onclick: async (e) => { e.currentTarget.disabled = true; if (await unbanMember(s, userId)) { delete s.bans[userId]; renderBans(); } else e.currentTarget.disabled = false; } }, 'Разбанить'));
  }));
}

/* ============================================================
   Каналы
   ============================================================ */
function channelsPanel() {
  return [h('p', { class: 'settings-lead' }, 'Права канала уточняют права ролей: можно скрыть канал от всех, кроме нужных ролей, или запретить писать.'), h('div', { class: 'ch-list', id: 'ss-channels' })];
}

function renderChannelsList() {
  const s = srv();
  const box = $('#ss-channels');
  if (!s || !box) return;
  const chans = sortedChannels(s);
  box.replaceChildren(...['text', 'voice'].map((type) => h('div', { class: 'ch-group' },
    h('h4', { class: 'perm-group__title' }, type === 'text' ? 'Текстовые каналы' : 'Голосовые каналы'),
    ...chans.filter((c) => c.type === type).map((c) => {
      const priv = isPrivateChannel(s, c.id);
      const n = Object.keys(s.channelOverwrites?.[c.id] || {}).length;
      return h('div', { class: 'ch-row', dataset: { channelId: c.id } },
        icon(priv ? (type === 'text' ? 'i-hash-lock' : 'i-volume-lock') : (type === 'text' ? 'i-hash' : 'i-volume')),
        h('span', { class: 'ch-row__name' }, c.name),
        priv ? h('span', { class: 'ch-row__tag' }, 'приватный') : null,
        n ? h('span', { class: 'ch-row__meta' }, `${n} ${plural(n, ['настройка', 'настройки', 'настроек'])} прав`) : null,
        h('button', { type: 'button', class: 'btn btn--sm', dataset: { channelPerms: c.id }, onclick: () => openChannelSettings(c.id) }, icon('i-settings'), 'Права'));
    }))));
}

/* ============================================================
   Права канала (#modal-channel-perms)
   ============================================================ */
let chEdit = null; // { channelId, overwrites, roleId }

export function openChannelSettings(channelId) {
  const ch = getChannel(channelId);
  const s = ch && getServer(ch.serverId);
  if (!s || !can(s, 'MANAGE_CHANNELS')) return;
  build(); // обработчики модалки (в т.ч. «Сохранить») навешиваются здесь — даже если настройки сервера ещё не открывали
  chEdit = {
    channelId,
    serverId: s.id,
    name: ch.name,
    overwrites: JSON.parse(JSON.stringify(s.channelOverwrites?.[channelId] || {})),
    roleId: s.id,
  };
  $('#modal-channel-perms-title').textContent = `Настройки канала ${ch.type === 'text' ? '#' : ''}${ch.name}`;
  renderChannelPerms();
  openModal('modal-channel-perms');
  $('#channel-edit-name')?.focus();
}

const TRI = [['deny', 'Запретить', 'i-close'], ['inherit', 'По умолчанию', 'i-minus-circle'], ['allow', 'Разрешить', 'i-check']];

function owState(ow, bit) {
  if (ow && (ow.allow & bit) === bit) return 'allow';
  if (ow && (ow.deny & bit) === bit) return 'deny';
  return 'inherit';
}

function setOw(roleId, bit, val) {
  const ow = chEdit.overwrites[roleId] || { allow: 0, deny: 0 };
  ow.allow &= ~bit; ow.deny &= ~bit;
  if (val === 'allow') ow.allow |= bit;
  if (val === 'deny') ow.deny |= bit;
  if (!ow.allow && !ow.deny) delete chEdit.overwrites[roleId]; else chEdit.overwrites[roleId] = ow;
}

function renderChannelPerms() {
  const s = getServer(chEdit.serverId);
  const ch = getChannel(chEdit.channelId);
  if (!s || !ch) { closeModal('modal-channel-perms'); return; }
  const body = $('#channel-perms-body');
  const priv = owState(chEdit.overwrites[s.id], PERMS.VIEW_CHANNEL) === 'deny';
  const name = h('input', { class: 'input', id: 'channel-edit-name', maxlength: '32', value: chEdit.name, autocomplete: 'off' });
  name.addEventListener('input', () => { chEdit.name = name.value; });
  const privSw = h('input', { type: 'checkbox', class: 'switch', id: 'channel-private-toggle', role: 'switch' });
  privSw.checked = priv;
  privSw.addEventListener('change', () => {
    setOw(s.id, PERMS.VIEW_CHANNEL, privSw.checked ? 'deny' : 'inherit');
    // свои роли не теряют доступ: разрешаем просмотр моим ролям (владелец/админ и так видят)
    if (privSw.checked && !isServerOwner(s) && !can(s, 'ADMINISTRATOR')) {
      for (const rid of memberRoleIds(s, state.user.id)) setOw(rid, PERMS.VIEW_CHANNEL, 'allow');
    }
    renderChannelPerms();
  });

  const applicable = PERM_GROUPS.flatMap((g) => g.perms.filter(([, , , scope]) => scope === 'all' || scope === ch.type).map((p) => ({ group: g.title, p })));
  const roles = sortedRoles(s);
  const withOw = roles.filter((r) => r.id === s.id || chEdit.overwrites[r.id] || r.id === chEdit.roleId);
  const addable = roles.filter((r) => !withOw.includes(r));
  if (!roles.some((r) => r.id === chEdit.roleId)) chEdit.roleId = s.id;
  const roleList = h('div', { class: 'ow-roles', role: 'tablist', 'aria-label': 'Роли' },
    ...withOw.map((r) => h('button', {
      type: 'button', class: 'ow-role' + (r.id === chEdit.roleId ? ' is-active' : ''), role: 'tab', 'aria-selected': String(r.id === chEdit.roleId),
      dataset: { roleId: r.id }, style: { '--rc': r.color || 'var(--text-faint)' },
      onclick: () => { chEdit.roleId = r.id; renderChannelPerms(); },
    }, h('span', { class: 'role-pill__dot', 'aria-hidden': 'true' }), h('span', null, r.id === s.id ? '@everyone' : r.name),
    chEdit.overwrites[r.id] ? h('span', { class: 'ow-role__mark', title: 'Есть настройки', 'aria-hidden': 'true' }) : null)),
    addable.length ? h('select', {
      class: 'input ow-add', 'aria-label': 'Добавить роль',
      onchange: (e) => { if (e.target.value) { chEdit.roleId = e.target.value; renderChannelPerms(); } },
    }, h('option', { value: '' }, '+ Добавить роль'), ...addable.map((r) => h('option', { value: r.id }, r.name))) : null);

  const ow = chEdit.overwrites[chEdit.roleId];
  let lastGroup = null;
  const rows = [];
  for (const { group, p: [key, label, desc] } of applicable) {
    if (group !== lastGroup) { rows.push(h('h4', { class: 'perm-group__title' }, group)); lastGroup = group; }
    const bit = PERMS[key];
    const st = owState(ow, bit);
    const nm = `ow-${key}`;
    rows.push(h('div', { class: 'ow-perm', dataset: { perm: key } },
      h('div', { class: 'setting__text' }, h('span', { class: 'setting__label' }, label), h('p', { class: 'setting__desc' }, desc)),
      h('div', { class: 'tri', role: 'radiogroup', 'aria-label': label },
        ...TRI.map(([v, t, ic]) => h('label', { class: `tri__opt tri__opt--${v}`, title: t },
          h('input', {
            type: 'radio', name: nm, value: v, checked: st === v, 'aria-label': `${label}: ${t}`,
            onchange: () => { setOw(chEdit.roleId, bit, v); if (key === 'VIEW_CHANNEL' && chEdit.roleId === s.id) renderChannelPerms(); else markRole(); },
          }), icon(ic, 'icon--sm'))))));
  }
  const markRole = () => {
    const btn = body.querySelector(`.ow-role[data-role-id="${chEdit.roleId}"]`);
    if (!btn) return;
    btn.querySelector('.ow-role__mark')?.remove();
    if (chEdit.overwrites[chEdit.roleId]) btn.append(h('span', { class: 'ow-role__mark', 'aria-hidden': 'true' }));
  };
  const curRole = roles.find((r) => r.id === chEdit.roleId);
  body.replaceChildren(
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'channel-edit-name' }, 'Название канала'), name),
    h('div', { class: 'setting private-card' + (priv ? ' is-on' : '') },
      icon('i-lock', 'private-card__icon'),
      h('div', { class: 'setting__text' },
        h('label', { class: 'setting__label', for: 'channel-private-toggle' }, 'Приватный канал'),
        h('p', { class: 'setting__desc' }, 'Канал увидят только роли, которым вы разрешите «Просматривать каналы», а также администраторы.')),
      privSw),
    h('div', { class: 'ow-layout' },
      roleList,
      h('div', { class: 'ow-perms' },
        h('div', { class: 'ow-perms__head' },
          h('span', null, 'Права для ', h('strong', { style: { color: curRole?.color || null } }, curRole?.id === s.id ? '@everyone' : curRole?.name || '')),
          chEdit.roleId !== s.id && chEdit.overwrites[chEdit.roleId] ? h('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { delete chEdit.overwrites[chEdit.roleId]; chEdit.roleId = s.id; renderChannelPerms(); },
          }, icon('i-trash'), 'Убрать роль') : null),
        h('div', { class: 'tri-legend', 'aria-hidden': 'true' }, ...TRI.map(([v, t, ic]) => h('span', { class: `tri-legend__item tri-legend__item--${v}` }, icon(ic, 'icon--sm'), t))),
        ...rows)));
}

async function saveChannelPerms() {
  const dlgEl = $('#modal-channel-perms');
  const name = chEdit.name.trim();
  if (!name) { setModalError(dlgEl, 'Введите название канала'); return; }
  const ch = getChannel(chEdit.channelId);
  const s = getServer(chEdit.serverId);
  const btn = $('#btn-channel-perms-save');
  btn.disabled = true;
  try {
    const payload = { channelId: chEdit.channelId, overwrites: chEdit.overwrites };
    if (name !== ch.name) payload.name = name;
    applyServerFromAck(await emitAck('channel:update', payload));
    // оптимистично (сервер пришлёт server:updated)
    if (s) { s.channelOverwrites = { ...(s.channelOverwrites || {}), [chEdit.channelId]: chEdit.overwrites }; }
    if (ch && payload.name) ch.name = name;
    notify('servers');
    closeModal(dlgEl);
    toastOk('Настройки канала сохранены');
  } catch (e) { setModalError(dlgEl, e.message); } finally { btn.disabled = false; }
}

/* ============================================================
   Каркас модалки
   ============================================================ */
const PANELS = { overview: overviewPanel, roles: rolesPanel, members: membersPanel, bans: bansPanel, channels: channelsPanel, appearance: themePanel };

function build() {
  if (built) return;
  built = true;
  const root = dlg();
  const nav = $('#ss-nav');
  const scroll = $('#ss-scroll');
  for (const s of SECTIONS) {
    nav.append(h('button', {
      type: 'button', class: 'settings__tab', role: 'tab', id: `ss-tab-${s.id}`,
      dataset: { ssection: s.id }, 'aria-controls': `ss-panel-${s.id}`, 'aria-selected': 'false', tabindex: '-1',
    }, icon(s.icon), h('span', null, s.title), icon('i-chevron-right', 'settings__chev')));
    scroll.append(h('section', {
      class: 'settings__panel', id: `ss-panel-${s.id}`, role: 'tabpanel', dataset: { spanel: s.id }, 'aria-labelledby': `ss-tab-${s.id}`, hidden: true,
    }, h('h2', { class: 'settings__title' }, s.title), ...PANELS[s.id]()));
  }
  nav.append(h('div', { class: 'settings__sep', role: 'presentation' }),
    h('button', { type: 'button', class: 'settings__tab settings__tab--danger', id: 'btn-server-leave', onclick: leaveServer }, icon('i-logout'), h('span', null, 'Покинуть сервер')),
    h('button', { type: 'button', class: 'settings__tab settings__tab--danger', id: 'ss-nav-delete', onclick: deleteServer }, icon('i-trash'), h('span', null, 'Удалить сервер')));
  initRoleDnd();
  nav.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ssection]');
    if (t) showSection(t.dataset.ssection, { focusPanel: matchMedia(MOBILE).matches });
  });
  nav.addEventListener('keydown', (e) => {
    const tabs = $$('.settings__tab[data-ssection]:not([hidden])', nav);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    if (j == null) return;
    e.preventDefault();
    tabs[j].focus();
    if (!matchMedia(MOBILE).matches) showSection(tabs[j].dataset.ssection);
  });
  $('.settings__back', root).addEventListener('click', () => {
    root.classList.remove('is-section-open');
    $(`.settings__tab[data-ssection="${current}"]`, root)?.focus();
  });
  root.addEventListener('close', () => {
    const t = $('#toasts');
    if (t && t.parentElement !== document.body) document.body.append(t);
    overviewDirty = false;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
  });
  subscribe(['servers', 'presence', 'profile'], () => { if (root.open) render(); });
  subscribe('voice', () => { if (root.open && current === 'members') renderMembers(); });
  $('#btn-channel-perms-save').addEventListener('click', saveChannelPerms);
  subscribe('servers', () => {
    if (chEdit && $('#modal-channel-perms').open && !getChannel(chEdit.channelId)) closeModal('modal-channel-perms');
  });
}

function isTypingIn(box) {
  const a = document.activeElement;
  if (!box || !a || !box.contains(a)) return false;
  return a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'color', 'range'].includes(a.type));
}

function render() {
  const s = srv();
  if (!s) { closeModal(dlg()); return; }
  const owner = isServerOwner(s);
  $('#modal-settings-title').textContent = s.name;
  $('#ss-bar-title').textContent = SECTIONS.find((x) => x.id === current)?.title || 'Настройки сервера';
  for (const sec of SECTIONS) {
    const tab = $(`#ss-tab-${sec.id}`);
    tab.hidden = !sec.show(s);
  }
  $('#btn-server-leave').hidden = owner;
  $('#ss-nav-delete').hidden = !owner;
  if (!SECTIONS.find((x) => x.id === current)?.show(s)) current = 'overview';
  fillOverview();
  if (current === 'roles') {
    renderRoleList();
    // Пока пользователь печатает в редакторе роли — не пересоздаём поля, иначе теряется фокус после каждой буквы
    if (!isTypingIn($('#role-editor'))) renderRoleEditor();
  }
  if (current === 'members') renderMembers();
  if (current === 'bans') renderBans();
  if (current === 'channels') renderChannelsList();
  if (current === 'appearance') renderThemePanel(s.id);
}

function showSection(id, { focusPanel = false } = {}) {
  const s = srv();
  const sec = SECTIONS.find((x) => x.id === id);
  if (!sec || !s || !sec.show(s)) id = 'overview';
  current = id;
  const root = dlg();
  $$('.settings__tab[data-ssection]', root).forEach((t) => {
    const on = t.dataset.ssection === id;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$('[data-spanel]', root).forEach((p) => { p.hidden = p.dataset.spanel !== id; });
  root.classList.add('is-section-open');
  $('#roles-layout')?.classList.remove('is-editing');
  $('#ss-scroll').scrollTop = 0;
  render();
  if (focusPanel) $('.settings__back', root).focus();
}

export function openServerSettings(id = state.currentServerId, section = null) {
  const s = getServer(id);
  if (!s) return;
  build();
  const root = dlg();
  if (serverId !== s.id) { selectedRole = null; memberQuery = ''; roleSearch = ''; overviewDirty = false; current = 'overview'; }
  serverId = s.id;
  if (!root.open) {
    returnFocus = document.activeElement;
    overviewDirty = false;
    root.showModal();
    const t = $('#toasts');
    if (t) root.append(t);
  }
  showSection(section || current || 'overview');
  const mobile = matchMedia(MOBILE).matches;
  if (mobile && !section) root.classList.remove('is-section-open');
  (mobile && !section ? $('.settings__tab.is-active', root) : $('.settings__close', root))?.focus();
}

export function initServerSettings() {
  $('#btn-server-menu').addEventListener('click', () => openServerSettings());
}

export { safeColor };
