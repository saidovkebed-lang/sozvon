// Действия модерации (SPEC-v3 §1.5): кик/бан с причиной, роли участника, серверный mute/deafen,
// перемещение/отключение из голоса, передача владения. Используются контекстным меню, попапом профиля
// и настройками сервера. Права проверяются здесь для UI; окончательно — сервером.
import { $, displayName } from '../util.js';
import { state, getServer, upsertServer, notify, findUser } from '../state.js';
import { emitAck } from '../socket.js';
import { can, outranks, canManageRole, memberRoleIds, isServerOwner } from '../perms.js';
import { openModal, closeModal, confirmDialog } from './modals.js';
import { toastOk, toastError } from './toasts.js';

/** Ответ сервера может содержать обновлённый сервер — применяем сразу (не ждём server:updated) */
export function applyServerFromAck(res) {
  if (res?.server?.id) { upsertServer(res.server); notify('servers'); }
  return res;
}

export async function act(event, payload, okText) {
  try {
    const res = applyServerFromAck(await emitAck(event, payload));
    if (okText) toastOk(okText);
    return res || { ok: true };
  } catch (e) {
    toastError(e);
    return null;
  }
}

/** Где сейчас в голосе пользователь на этом сервере */
export function voiceMemberOf(server, userId) {
  for (const ch of server?.channels || []) {
    if (ch.type !== 'voice') continue;
    const m = (state.voice[ch.id] || []).find((x) => x.userId === userId && !x.isBot);
    if (m) return { channel: ch, member: m };
  }
  return null;
}

/** Что текущий пользователь может сделать с участником (для меню/попапа) */
export function capabilities(server, userId) {
  const self = userId === state.user?.id;
  const target = findUser(userId, server);
  const isBot = !!target?.isBot;
  const over = !self && !isBot && outranks(server, userId);
  const inVoice = voiceMemberOf(server, userId);
  return {
    self,
    isBot,
    inVoice,
    roles: !isBot && can(server, 'MANAGE_ROLES') && (self || over || isServerOwner(server)),
    kick: over && can(server, 'KICK_MEMBERS'),
    ban: over && can(server, 'BAN_MEMBERS'),
    mute: !!inVoice && !isBot && (over || (self && isServerOwner(server))) && can(server, 'MUTE_MEMBERS'),
    deafen: !!inVoice && !isBot && (over || (self && isServerOwner(server))) && can(server, 'DEAFEN_MEMBERS'),
    move: !!inVoice && !isBot && (over || self) && can(server, 'MOVE_MEMBERS'),
    transfer: !self && !isBot && isServerOwner(server),
  };
}

/* ---------- причина кика/бана ---------- */
let reasonResolve = null;
function askReason({ title, text, ok, withDelete = false }) {
  const dlg = $('#modal-reason');
  $('#modal-reason-title').textContent = title;
  $('#modal-reason-text').textContent = text;
  $('#reason-ok').textContent = ok;
  $('#reason-input').value = '';
  $('#reason-delete-wrap').hidden = !withDelete;
  $('#reason-delete').checked = false;
  if (reasonResolve) reasonResolve(null);
  return new Promise((resolve) => {
    reasonResolve = resolve;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      if (reasonResolve !== resolve) return;
      reasonResolve = null;
      resolve(dlg.returnValue === 'ok'
        ? { reason: $('#reason-input').value.trim(), deleteMessages: $('#reason-delete').checked }
        : null);
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    openModal(dlg);
    $('#reason-input').focus();
  });
}

export function initModActions() {
  $('#form-reason')?.addEventListener('submit', (e) => {
    e.preventDefault();
    $('#modal-reason').close('ok');
  });
  $('#reason-ok')?.addEventListener('click', () => $('#modal-reason').close('ok'));
}

export async function kickMember(server, userId) {
  const u = findUser(userId, server);
  const r = await askReason({
    title: `Выгнать ${displayName(u)}`,
    text: `${displayName(u)} будет удалён с сервера «${server.name}». Вернуться можно по новому инвайту.`,
    ok: 'Выгнать',
  });
  if (!r) return false;
  return !!(await act('member:kick', { serverId: server.id, userId, reason: r.reason || undefined }, `${displayName(u)} выгнан с сервера`));
}

export async function banMember(server, userId) {
  const u = findUser(userId, server);
  const r = await askReason({
    title: `Забанить ${displayName(u)}`,
    text: `${displayName(u)} будет удалён и не сможет вернуться по инвайту, пока бан не снимут.`,
    ok: 'Забанить',
    withDelete: true,
  });
  if (!r) return false;
  return !!(await act('member:ban', { serverId: server.id, userId, reason: r.reason || undefined, deleteMessages: r.deleteMessages || undefined }, `${displayName(u)} забанен`));
}

export function unbanMember(server, userId) {
  return act('member:unban', { serverId: server.id, userId }, 'Бан снят');
}

export function setServerMute(server, userId, serverMute) {
  return act('member:voice', { serverId: server.id, userId, serverMute });
}
export function setServerDeafen(server, userId, serverDeafen) {
  return act('member:voice', { serverId: server.id, userId, serverDeafen });
}
export function moveMember(server, userId, channelId) {
  return act('member:voice', { serverId: server.id, userId, moveTo: channelId }, channelId ? 'Участник перемещён' : 'Участник отключён');
}

/** Оптимистично выставить роли участника */
export async function setMemberRoles(server, userId, roleIds) {
  const prev = server.memberRoles?.[userId] || [];
  server.memberRoles = { ...(server.memberRoles || {}), [userId]: roleIds };
  notify('servers');
  const res = await act('member:roles', { serverId: server.id, userId, roleIds });
  if (!res) { server.memberRoles = { ...server.memberRoles, [userId]: prev }; notify('servers'); }
  return !!res;
}

export function toggleMemberRole(server, userId, roleId, on) {
  const cur = new Set(memberRoleIds(server, userId));
  if (on) cur.add(roleId); else cur.delete(roleId);
  return setMemberRoles(server, userId, [...cur]);
}

/** Роли, которые текущий пользователь может выдавать/снимать */
export function assignableRoles(server) {
  return (server?.roles || []).filter((r) => r.id !== server.id && canManageRole(server, r));
}

export async function transferOwnership(server, userId) {
  const u = findUser(userId, server);
  const yes = await confirmDialog({
    title: 'Передать владение',
    text: `Передать сервер «${server.name}» участнику ${displayName(u)}? Вы потеряете права владельца — вернуть их сможет только новый владелец.`,
    ok: 'Передать',
  });
  if (!yes) return false;
  return !!(await act('server:transfer', { serverId: server.id, userId }, `Теперь владелец — ${displayName(u)}`));
}

export function currentServerOr(id) { return getServer(id) || getServer(); }
export { closeModal };
