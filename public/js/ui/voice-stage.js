// Сцена голосового канала: тайлы участников, видео камеры/экрана, speaking, фокус/fullscreen
import { $, h, icon, avatar } from '../util.js';
import { state, subscribe, getChannel } from '../state.js';
import { socketId } from '../socket.js';
import { rtc } from '../voice/rtc.js';
import { moreButton } from './context-menu.js';
import { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreen, toggleCamera } from '../voice/voice.js';

const tiles = new Map();   // key -> { el, stream, sig }
let focusedKey = null;

function liveVideo(stream) {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
}

function plural(n) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'участник';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'участника';
  return 'участников';
}

function buildTile(key) {
  const el = h('div', { class: 'tile', dataset: { key }, tabindex: '0', role: 'button' });
  el.addEventListener('click', (e) => {
    if (e.target.closest('.tile__expand')) return;
    focusedKey = focusedKey === key ? null : key;
    render();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
  el.addEventListener('dblclick', () => toggleFullscreen(el));
  return el;
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen?.().catch(() => {});
}

function fillTile(entry, d) {
  const { el } = entry;
  const { member: m, kind, stream, self, peer } = d;
  el.dataset.socketId = m.socketId;
  if (m.userId) el.dataset.userId = m.userId;
  el.dataset.kind = kind;
  if (self) el.dataset.self = 'true'; else delete el.dataset.self;
  if (peer) el.dataset.connected = String(peer.connected);
  else delete el.dataset.connected;
  el.classList.toggle('tile--video', !!stream);
  el.classList.toggle('tile--screen', kind === 'screen');
  el.classList.toggle('tile--bot', !!m.isBot);
  el.classList.toggle('tile--focused', focusedKey === el.dataset.key);
  el.classList.toggle('is-speaking', kind === 'main' && state.speaking.has(m.socketId));
  el.setAttribute('aria-label', kind === 'screen' ? `Экран: ${m.username}` : m.username);

  const sig = [stream?.id || '', m.username, m.color, m.muted, m.deafened, kind, m.streaming, m.isBot].join('|');
  if (entry.sig === sig && entry.streamRef === stream) return;
  entry.sig = sig;

  if (entry.streamRef !== stream || !el.firstChild) {
    entry.streamRef = stream;
    const media = el.querySelector('.tile__video, .avatar');
    let next;
    if (stream) {
      next = h('video', {
        class: 'tile__video' + (self && kind === 'main' ? ' tile__video--mirror' : ''),
        autoplay: true, playsInline: true, muted: true,
      });
      next.muted = true;
      next.srcObject = stream;
      next.play().catch(() => {});
    } else {
      next = avatar({ username: m.username, color: m.color }, 'xl');
    }
    if (media) {
      if (media.tagName === 'VIDEO') media.srcObject = null;
      media.replaceWith(next);
    } else el.prepend(next);
  }

  // подписи и бейджи
  el.querySelectorAll('.tile__label, .badge, .tile__expand, .tile__more').forEach((x) => x.remove());
  const label = h('div', { class: 'tile__label' }, h('span', null, kind === 'screen' ? `${m.username} — экран` : m.username));
  if (kind === 'main') {
    if (m.deafened) label.append(icon('i-headphones-off', 'icon--sm'));
    else if (m.muted) label.append(icon('i-mic-off', 'icon--sm'));
  }
  el.append(label);
  if (kind === 'screen') el.append(h('span', { class: 'badge badge--live' }, 'LIVE'));
  if (m.isBot) el.append(h('span', { class: 'badge badge--bot' }, 'БОТ'));
  el.append(h('button', {
    type: 'button', class: 'icon-btn tile__expand',
    'aria-label': 'Во весь экран', title: 'Во весь экран',
    onclick: (e) => { e.stopPropagation(); toggleFullscreen(el); },
  }, icon('i-expand', 'icon--sm')));
  if (!self) {
    const more = moreButton(m.username);
    more.classList.add('tile__more');
    el.append(more);
  }
}

function render() {
  const view = $('#voice-view');
  const ch = getChannel();
  const grid = $('#stage-grid');
  if (!ch || ch.type !== 'voice') {
    for (const [k, t] of tiles) { t.el.querySelector('video')?.remove(); t.el.remove(); tiles.delete(k); }
    return;
  }
  const inThis = state.myVoice?.channelId === ch.id;
  const me = socketId();
  let members = (state.voice[ch.id] || []).map((m) => ({ ...m }));
  if (inThis && me && !members.some((m) => m.socketId === me) && state.user) {
    members.unshift({
      socketId: me, userId: state.user.id, username: state.user.username, color: state.user.color,
      isBot: false, muted: state.muted || state.deafened, deafened: state.deafened, streaming: state.streaming, camera: state.camera,
    });
  }
  // себя — первым
  members.sort((a, b) => (b.socketId === me) - (a.socketId === me));

  const wanted = [];
  for (const m of members) {
    const self = inThis && m.socketId === me;
    const peer = inThis && !self && !m.isBot ? rtc.peers.get(m.socketId) || null : null;
    let cam = null; let scr = null;
    if (self) {
      if (state.muted || state.deafened) m.muted = true;
      m.deafened = state.deafened;
      cam = liveVideo(rtc.local.camera) ? rtc.local.camera : null;
      scr = liveVideo(rtc.local.screen) ? rtc.local.screen : null;
    } else if (peer) {
      cam = liveVideo(peer.remote.camera) && m.camera !== false ? peer.remote.camera : null;
      scr = liveVideo(peer.remote.screen) && m.streaming !== false ? peer.remote.screen : null;
    }
    wanted.push({ key: `${m.socketId}:main`, member: m, kind: 'main', stream: cam, self, peer: peer || (inThis && !self && !m.isBot ? { connected: false } : null) });
    if (scr) wanted.push({ key: `${m.socketId}:screen`, member: m, kind: 'screen', stream: scr, self, peer });
  }

  const keys = new Set(wanted.map((w) => w.key));
  if (focusedKey && !keys.has(focusedKey)) focusedKey = null;
  for (const [k, t] of tiles) {
    if (!keys.has(k)) {
      const v = t.el.querySelector('video');
      if (v) v.srcObject = null;
      t.el.remove();
      tiles.delete(k);
    }
  }
  wanted.forEach((w, i) => {
    let t = tiles.get(w.key);
    if (!t) { t = { el: buildTile(w.key) }; tiles.set(w.key, t); }
    fillTile(t, w);
    if (grid.children[i] !== t.el) grid.insertBefore(t.el, grid.children[i] || null);
  });
  grid.classList.toggle('has-focus', !!focusedKey);
  grid.dataset.count = String(wanted.length);

  // join / controls
  const join = $('#voice-join');
  join.hidden = inThis;
  $('#stage-controls').hidden = !inThis;
  if (!inThis) {
    const n = members.filter((m) => !m.isBot).length;
    $('#voice-join-text').textContent = n ? `Сейчас в канале ${n} ${plural(n)}` : 'В канале пока никого нет';
  }
  view.classList.toggle('is-connected', inThis);
}

function updateSpeaking() {
  for (const t of tiles.values()) {
    if (t.el.dataset.kind === 'main') t.el.classList.toggle('is-speaking', state.speaking.has(t.el.dataset.socketId));
  }
}

export function initStage() {
  subscribe(['nav', 'voice', 'me', 'servers'], render);
  subscribe('speaking', updateSpeaking);
  rtc.onChange(render);
  $('#btn-voice-join').addEventListener('click', () => {
    const ch = getChannel();
    if (ch?.type === 'voice') joinVoice(ch.id);
  });
  $('#ctrl-mute').addEventListener('click', toggleMute);
  $('#ctrl-deafen').addEventListener('click', toggleDeafen);
  $('#ctrl-camera').addEventListener('click', toggleCamera);
  $('#ctrl-screen').addEventListener('click', toggleScreen);
  $('#ctrl-leave').addEventListener('click', () => leaveVoice());
}
