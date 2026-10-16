// Правая колонка: участники сервера с онлайн-статусом
import { $, h, icon, avatar } from '../util.js';
import { subscribe, getServer } from '../state.js';

function memberEl(u, server) {
  const av = avatar(u);
  av.append(h('span', { class: 'avatar__status', 'aria-hidden': 'true' }));
  const el = h('div', {
    class: 'member' + (u.online ? '' : ' is-offline') + (u.isBot ? ' member--bot' : ''),
    dataset: { userId: u.id },
    title: `${u.username} — ${u.online ? 'в сети' : 'не в сети'}`,
  }, av, h('span', { class: 'member__name' }, u.username));
  if (u.id === server.ownerId) el.append(icon('i-crown', 'icon--sm member__crown'));
  else if (u.isBot) el.append(icon('i-bot', 'icon--sm member__bot'));
  return el;
}

function render() {
  const box = $('#members');
  const server = getServer();
  if (!server) { box.replaceChildren(); return; }
  const byName = (a, b) => a.username.localeCompare(b.username, 'ru');
  const online = server.members.filter((m) => m.online).sort(byName);
  const offline = server.members.filter((m) => !m.online).sort(byName);
  const nodes = [h('h3', { class: 'members__title' }, `В сети — ${online.length}`), ...online.map((u) => memberEl(u, server))];
  if (offline.length) nodes.push(h('h3', { class: 'members__title' }, `Не в сети — ${offline.length}`), ...offline.map((u) => memberEl(u, server)));
  box.replaceChildren(...nodes);
}

export function initMembers() {
  subscribe(['servers', 'nav', 'presence'], render);
}

