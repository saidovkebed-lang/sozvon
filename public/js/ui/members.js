// Правая колонка: участники сервера, сгруппированные по hoist-ролям, со статусами и цветом высшей роли
import { $, h, icon, avatar, displayName } from '../util.js';
import { subscribe, getServer, presenceOf, activeCustomStatus, STATUS_LABELS } from '../state.js';
import { roleColor, hoistRole, sortedRoles } from '../perms.js';
import { listeningOf, listeningLine } from './listening.js';

export function statusDot(status) {
  return h('span', { class: 'avatar__status', dataset: { status }, 'aria-hidden': 'true' });
}

function memberEl(u, server) {
  const status = presenceOf(u);
  const av = avatar(u);
  av.append(statusDot(status));
  const color = roleColor(server, u.id);
  const cs = activeCustomStatus(u);
  const listening = listeningOf(u); // «Слушает: …» вместо пользовательского статуса
  const name = displayName(u);
  const el = h('div', {
    class: 'member' + (status === 'offline' ? ' is-offline' : '') + (u.isBot ? ' member--bot' : ''),
    dataset: { userId: u.id, status },
    tabindex: '0',
    role: 'button',
    'aria-haspopup': 'dialog',
    title: `${name} — ${STATUS_LABELS[status] || ''}`,
  }, av,
  h('div', { class: 'member__text' },
    h('span', { class: 'member__name', style: color ? { color } : null }, name),
    listening ? listeningLine(listening)
      : cs ? h('span', { class: 'member__status' }, cs.emoji ? h('span', { class: 'member__emoji' }, cs.emoji) : null, cs.text || '') : null));
  if (u.id === server.ownerId) el.append(icon('i-crown', 'icon--sm member__crown'));
  else if (u.isBot) el.append(icon('i-bot', 'icon--sm member__bot'));
  return el;
}

function group(key, title, list, server) {
  return h('div', { class: 'members__group', dataset: { group: key } },
    h('h3', { class: 'members__title' }, `${title} — ${list.length}`),
    ...list.map((u) => memberEl(u, server)));
}

function render() {
  const box = $('#members');
  const server = getServer();
  if (!server) { box.replaceChildren(); return; }
  const byName = (a, b) => displayName(a).localeCompare(displayName(b), 'ru');
  const groups = new Map(); // roleId -> users
  const online = [];
  const offline = [];
  for (const m of server.members) {
    if (presenceOf(m) === 'offline') { offline.push(m); continue; }
    const hr = m.isBot ? null : hoistRole(server, m.id);
    if (hr) { if (!groups.has(hr.id)) groups.set(hr.id, []); groups.get(hr.id).push(m); } else online.push(m);
  }
  const nodes = [];
  for (const r of sortedRoles(server)) {
    const list = groups.get(r.id);
    if (list?.length) nodes.push(group(r.id, r.name, list.sort(byName), server));
  }
  if (online.length || !nodes.length) nodes.push(group('online', 'В сети', online.sort(byName), server));
  if (offline.length) nodes.push(group('offline', 'Не в сети', offline.sort(byName), server));
  box.replaceChildren(...nodes);
}

export function initMembers() {
  subscribe(['servers', 'nav', 'presence', 'profile', 'voice', 'music'], render);
  // кастомные статусы истекают сами
  setInterval(() => { if (getServer()) render(); }, 60_000);
}
