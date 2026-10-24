// Сцена голосового канала: тайлы участников, видео камеры/экрана, speaking, фокус/fullscreen
import { $, h, icon, avatar, displayName } from '../util.js';
import { state, subscribe, getChannel, getServer, findUser } from '../state.js';
import { can } from '../perms.js';
import { socketId } from '../socket.js';
import { rtc } from '../voice/rtc.js';
import { moreButton } from './context-menu.js';
import { audioEngine } from '../audio/engine.js';
import { prefs } from '../prefs.js';
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
  const { member: m, kind, stream, self, peer, watching, hasStream } = d;
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

  const u = { ...m, ...(findUser(m.userId) || {}), id: m.userId };
  const avatarSig = `${u.avatar}|${u.avatarAnimated}|${u.color}`;
  const name = displayName(u);
  const sig = [stream?.id || '', hasStream?.id || '', watching ? 1 : 0, stream?.getAudioTracks().length || 0, name, u.color, u.avatar, u.avatarAnimated, m.muted, m.deafened, m.serverMute, m.serverDeafen, kind, m.streaming, m.isBot].join('|');
  if (entry.sig === sig && entry.streamRef === stream) return;
  entry.sig = sig;

  if (entry.streamRef !== stream || !el.firstChild || (!stream && entry.avatarSig !== avatarSig)) {
    entry.avatarSig = avatarSig;
    entry.streamRef = stream;
    const media = el.querySelector(':scope > .tile__video, :scope > .tile__cover, :scope > .avatar');
    let next;
    if (stream) {
      next = h('video', {
        class: 'tile__video' + (self && kind === 'main' ? ' tile__video--mirror' : ''),
        autoplay: true, playsInline: true, muted: true,
      });
      next.muted = true;
      next.srcObject = stream;
      next.play().catch(() => {});
    } else if (kind === 'screen') {
      next = h('div', { class: 'tile__cover' }, avatar(u, 'xl'),
        h('div', { class: 'tile__cover-text' }, self ? 'Вы показываете экран' : `${name} показывает экран`));
    } else {
      next = avatar(u, 'xl');
    }
    if (media) {
      if (media.tagName === 'VIDEO') media.srcObject = null;
      media.replaceWith(next);
    } else el.prepend(next);
  }

  // подписи и бейджи
  el.querySelectorAll('.tile__label, .badge, .tile__expand, .tile__more, .tile__action').forEach((x) => x.remove());
  const label = h('div', { class: 'tile__label' }, h('span', null, kind === 'screen' ? `${name} — экран` : name));
  if (kind === 'main') {
    if (m.deafened || m.serverDeafen) label.append(icon('i-headphones-off', 'icon--sm'));
    else if (m.muted || m.serverMute) label.append(icon('i-mic-off', 'icon--sm'));
  }
  el.append(label);
  if (kind === 'screen') el.append(h('span', { class: 'badge badge--live' }, 'LIVE'));
  if (kind === 'screen') {
    const act = (cls, ic, text, title, fn) => h('button', {
      type: 'button', class: `btn btn--sm tile__action ${cls}`, title,
      onclick: (e) => { e.stopPropagation(); fn(); },
    }, icon(ic, 'icon--sm'), text);
    if (self) {
      el.append(act('btn--danger tile__stopshare', 'i-close', 'Остановить демонстрацию', 'Остановить демонстрацию экрана', () => toggleScreen()));
    } else if (!watching) {
      el.append(act('btn--primary tile__watch', 'i-play', 'Смотреть трансляцию', 'Начать смотреть — видео пойдёт только после нажатия', () => rtc.setWatching(m.socketId, true)));
    } else {
      el.append(act('btn--ghost tile__unwatch', 'i-close', 'Выйти из трансляции', 'Перестать смотреть (экономит интернет и процессор)', () => {
        if (focusedKey === el.dataset.key) focusedKey = null;
        if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
        rtc.setWatching(m.socketId, false);
      }));
    }
  }
  // Звук трансляции у зрителя: кнопка + ползунок громкости (0–200 %, свой для каждого стримера, запоминается).
  // Элемент не пересоздаётся при перерисовке плитки — иначе ползунок обрывался бы посреди перетаскивания.
  const hasSound = kind === 'screen' && !self && !!stream?.getAudioTracks().length;
  let vol = el.querySelector('.tile__volume');
  if (vol && (!hasSound || vol.dataset.socketId !== m.socketId)) { vol.remove(); vol = null; }
  if (hasSound && !vol) el.append(streamVolumeEl(m));
  else if (vol) vol.paint();
  if (m.isBot) el.append(h('span', { class: 'badge badge--bot' }, 'БОТ'));
  el.append(h('button', {
    type: 'button', class: 'icon-btn tile__expand',
    'aria-label': 'Во весь экран', title: 'Во весь экран',
    onclick: (e) => { e.stopPropagation(); toggleFullscreen(el); },
  }, icon('i-expand', 'icon--sm')));
  if (!self) {
    const more = moreButton(name);
    more.classList.add('tile__more');
    el.append(more);
  }
}

function streamVolumeEl(m) {
  const stop = (e) => e.stopPropagation();
  const btn = h('button', { type: 'button', class: 'icon-btn tile__sound' });
  const range = h('input', {
    type: 'range', class: 'slider tile__volume-range', min: '0', max: '200', step: '5',
    'aria-label': `Громкость трансляции ${m.username}`, title: 'Громкость трансляции · двойной клик — 100 %',
  });
  const pct = h('span', { class: 'tile__volume-pct', 'aria-hidden': 'true' });
  const box = h('div', { class: 'tile__volume', dataset: { socketId: m.socketId } }, btn, range, pct);
  const uid = () => m.userId;
  box.paint = () => {
    const off = audioEngine.isStreamAudioMuted(m.socketId);
    const v = prefs.getStreamVolume(uid());
    if (document.activeElement !== range) range.value = String(v);
    range.style.setProperty('--val', `${(Number(range.value) / 200) * 100}%`);
    pct.textContent = off ? 'выкл' : `${range.value}%`;
    const silent = off || Number(range.value) === 0;
    btn.replaceChildren(icon(silent ? 'i-volume-x' : Number(range.value) < 60 ? 'i-volume-low' : 'i-volume', 'icon--sm'));
    btn.title = off ? 'Включить звук трансляции' : 'Выключить звук трансляции (если слышите эхо)';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(off));
    box.classList.toggle('is-muted', silent);
  };
  btn.addEventListener('click', (e) => {
    stop(e);
    audioEngine.setStreamAudioMuted(m.socketId, !audioEngine.isStreamAudioMuted(m.socketId));
    box.paint();
  });
  range.addEventListener('input', (e) => {
    stop(e);
    if (audioEngine.isStreamAudioMuted(m.socketId) && Number(range.value) > 0) audioEngine.setStreamAudioMuted(m.socketId, false);
    prefs.setStreamVolume(uid(), Number(range.value));
    box.paint();
  });
  range.addEventListener('dblclick', (e) => { stop(e); range.value = '100'; prefs.setStreamVolume(uid(), 100); box.paint(); });
  for (const ev of ['click', 'pointerdown', 'mousedown', 'keydown', 'wheel']) box.addEventListener(ev, stop);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    range.value = String(Math.max(0, Math.min(200, Number(range.value) + (e.deltaY < 0 ? 5 : -5))));
    range.dispatchEvent(new Event('input'));
  }, { passive: false });
  box.paint();
  return box;
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
      // напрямую (mesh) или через SFU: до «Смотреть» — пустой поток-заглушка (плитка с кнопкой)
      scr = m.streaming !== false ? rtc.screenOf(m.socketId) : null;
    }
    wanted.push({ key: `${m.socketId}:main`, member: m, kind: 'main', stream: cam, self, peer: peer || (inThis && !self && !m.isBot ? { connected: false } : null) });
    if (scr) {
      // Экономия процессора: свою трансляцию не рисуем (если не включено превью), чужую — только по «Смотреть»
      const watching = self ? !!prefs.get('stream.selfPreview') : rtc.isWatching(m.socketId);
      wanted.push({ key: `${m.socketId}:screen`, member: m, kind: 'screen', stream: watching && liveVideo(scr) ? scr : null, hasStream: scr, watching, self, peer });
    }
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
    const srv = getServer(ch.serverId);
    const allowed = !srv || can(srv, 'CONNECT', ch.id);
    $('#btn-voice-join').disabled = !allowed;
    $('#voice-join-text').textContent = !allowed ? 'У вас нет права подключаться к этому каналу'
      : (n ? `Сейчас в канале ${n} ${plural(n)}` : 'В канале пока никого нет');
  }
  view.classList.toggle('is-connected', inThis);
}

function updateSpeaking() {
  for (const t of tiles.values()) {
    if (t.el.dataset.kind === 'main') t.el.classList.toggle('is-speaking', state.speaking.has(t.el.dataset.socketId));
  }
}

export function initStage() {
  subscribe(['nav', 'voice', 'me', 'servers', 'profile'], render);
  subscribe('speaking', updateSpeaking);
  rtc.onChange(render);
  prefs.subscribe('stream.selfPreview', () => render());
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
