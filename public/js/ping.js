// Счётчик пинга (SPEC-v3 §3): RTT до сервера каждые 5 с (socket.io ack 'ping:rtt'), в голосе — WebRTC
// (RTT выбранной ICE-пары, потери, джиттер, битрейт, кодек, relay/direct). Значки .ping-badge в
// voice-panel и user-panel, попап «Подключение» с мини-графиком. Отладка: window.__sozvon.ping.
import { h, icon } from './util.js';
import { state, subscribe } from './state.js';
import { getSocket } from './socket.js';
import { rtc } from './voice/rtc.js';

const INTERVAL = 5000;
const KEEP = 30;

export const ping = {
  last: null,          // мс до сервера
  avg: null,
  history: [],         // последние 30 замеров (мс; null — потеря)
  voice: { rtt: null, loss: null, jitter: null, bitrate: null, codec: null, transport: null, turn: null, history: [] },
};

const level = (ms) => (ms == null ? 'none' : ms < 100 ? 'good' : ms < 250 ? 'mid' : 'bad');
const LABEL = { good: 'Отличное соединение', mid: 'Среднее соединение', bad: 'Плохое соединение', none: 'Нет данных' };

function measure() {
  const s = getSocket();
  if (!s?.connected) return;
  const t = performance.now();
  s.timeout(4000).emit('ping:rtt', { t: Date.now() }, (err) => {
    const ms = err ? null : Math.max(1, Math.round(performance.now() - t));
    push(ping.history, ms);
    if (ms != null) ping.last = ms;
    const ok = ping.history.filter((x) => x != null);
    ping.avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
    render();
  });
}

function push(arr, v) {
  arr.push(v);
  if (arr.length > KEEP) arr.splice(0, arr.length - KEEP);
}

/* ---------- WebRTC getStats ---------- */
const prevIn = new Map(); // peerId -> {bytes, ts, lost, recv}

async function voiceStats() {
  if (!state.myVoice || !rtc.peers.size) {
    Object.assign(ping.voice, { rtt: null, loss: null, jitter: null, bitrate: null, codec: null, transport: null, turn: null });
    ping.voice.history = [];
    prevIn.clear();
    render();
    return;
  }
  const rtts = []; const jitters = []; let lost = 0; let recv = 0; let bits = 0; let codec = null; let transport = null; let turn = null;
  for (const [id, peer] of rtc.peers) {
    if (!peer.connected) continue;
    let report;
    try { report = await peer.pc.getStats(); } catch { continue; }
    const byId = new Map();
    report.forEach((r) => byId.set(r.id, r));
    let pair = null;
    report.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair;
    });
    if (!pair) report.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = pair || r; });
    if (pair) {
      if (Number.isFinite(pair.currentRoundTripTime)) rtts.push(pair.currentRoundTripTime * 1000);
      const loc = byId.get(pair.localCandidateId);
      const rem = byId.get(pair.remoteCandidateId);
      const relay = loc?.candidateType === 'relay' || rem?.candidateType === 'relay';
      transport = transport === 'relay' || relay ? 'relay' : 'direct';
      if (loc?.candidateType === 'relay') turn = loc.url || loc.relayProtocol ? `${loc.address || loc.ip || ''}${loc.relayProtocol ? ` (${loc.relayProtocol.toUpperCase()})` : ''}` : turn;
      if (relay && !turn && rem?.candidateType === 'relay') turn = rem.address || rem.ip || null;
    }
    let bytes = 0; let pLost = 0; let pRecv = 0;
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'audio') return;
      bytes += r.bytesReceived || 0;
      pLost += Math.max(0, r.packetsLost || 0);
      pRecv += r.packetsReceived || 0;
      if (Number.isFinite(r.jitter)) jitters.push(r.jitter * 1000);
      const c = byId.get(r.codecId);
      if (c?.mimeType) codec = `${c.mimeType.replace(/^audio\//i, '')}${c.clockRate ? ` ${Math.round(c.clockRate / 1000)} кГц` : ''}`;
    });
    const prev = prevIn.get(id);
    const now = performance.now();
    if (prev) {
      const dt = (now - prev.ts) / 1000;
      if (dt > 0) bits += ((bytes - prev.bytes) * 8) / dt;
      lost += pLost - prev.lost;
      recv += pRecv - prev.recv;
    }
    prevIn.set(id, { bytes, ts: now, lost: pLost, recv: pRecv });
  }
  for (const id of prevIn.keys()) if (!rtc.peers.has(id)) prevIn.delete(id);
  const v = ping.voice;
  v.rtt = rtts.length ? Math.max(1, Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)) : null;
  v.jitter = jitters.length ? Math.round(Math.max(...jitters) * 10) / 10 : null;
  v.loss = lost + recv > 0 ? Math.round((Math.max(0, lost) / (Math.max(0, lost) + recv)) * 1000) / 10 : (v.rtt != null ? 0 : null);
  v.bitrate = bits > 0 ? Math.round(bits / 1000) : null;
  v.codec = codec;
  v.transport = transport;
  v.turn = turn;
  if (v.rtt != null) push(v.history, v.rtt);
  render();
}

/* ---------- UI ---------- */
function badgeValue(which) {
  if (which === 'voice' && ping.voice.rtt != null) return ping.voice.rtt;
  return ping.last;
}

function render() {
  for (const el of document.querySelectorAll('.ping-badge')) {
    const which = el.id === 'ping-voice' ? 'voice' : 'server';
    const ms = badgeValue(which);
    const lv = state.connected ? level(ms) : 'bad';
    el.dataset.level = lv;
    const txt = state.connected ? (ms == null ? '— мс' : `${ms} мс`) : 'нет связи';
    const out = el.querySelector('.ping-badge__ms');
    if (out && out.textContent !== txt) out.textContent = txt;
    el.title = `${LABEL[lv]}${ms != null ? ` · ${ms} мс` : ''} — нажмите для подробностей`;
    el.setAttribute('aria-label', `Подключение: ${txt}`);
  }
  if (popup) fillPopup();
}

/* ---------- попап «Подключение» ---------- */
let popup = null;
let popupAnchor = null;

function chart(values) {
  const W = 248; const H = 64; const P = 4;
  const vals = values.slice(-KEEP);
  const ok = vals.filter((v) => v != null);
  const max = Math.max(100, ...ok) * 1.15;
  const step = (W - P * 2) / Math.max(1, KEEP - 1);
  const off = KEEP - vals.length;
  const pts = vals.map((v, i) => (v == null ? null : [P + (i + off) * step, H - P - (v / max) * (H - P * 2)]));
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'ping-chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `График пинга, последние ${vals.length} замеров`);
  const mk = (tag, attrs) => { const e = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  // пороги 100 / 250 мс
  for (const [ms, cls] of [[100, 'ping-chart__thr--good'], [250, 'ping-chart__thr--mid']]) {
    if (ms > max) continue;
    const y = H - P - (ms / max) * (H - P * 2);
    svg.append(mk('line', { x1: P, x2: W - P, y1: y, y2: y, class: `ping-chart__thr ${cls}` }));
  }
  const segs = [];
  let cur = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);
  for (const seg of segs) {
    const d = seg.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    if (seg.length > 1) svg.append(mk('path', { d: `${d}L${seg[seg.length - 1][0].toFixed(1)},${H - P}L${seg[0][0].toFixed(1)},${H - P}Z`, class: 'ping-chart__area' }));
    svg.append(mk('path', { d, class: 'ping-chart__line' }));
  }
  const lastP = [...pts].reverse().find(Boolean);
  if (lastP) svg.append(mk('circle', { cx: lastP[0], cy: lastP[1], r: 3, class: `ping-chart__dot ping-chart__dot--${level(ok[ok.length - 1])}` }));
  pts.forEach((p, i) => { if (!p && vals[i] === null) svg.append(mk('line', { x1: P + (i + off) * step, x2: P + (i + off) * step, y1: P, y2: H - P, class: 'ping-chart__lost' })); });
  return svg;
}

function row(label, value, cls = '') {
  return h('div', { class: 'ping-popup__row' }, h('span', null, label), h('strong', { class: cls }, value));
}

function fillPopup() {
  const inVoice = !!state.myVoice;
  const v = ping.voice;
  const main = inVoice && v.rtt != null ? v.rtt : ping.last;
  const lv = level(main);
  const hist = inVoice && v.history.length ? v.history : ping.history;
  const okHist = hist.filter((x) => x != null);
  const avg = okHist.length ? Math.round(okHist.reduce((a, b) => a + b, 0) / okHist.length) : null;
  const rows = [
    row('Пинг до сервера', ping.last != null ? `${ping.last} мс` : '—'),
    row('Средний', avg != null ? `${avg} мс` : '—'),
  ];
  if (inVoice) {
    rows.push(
      row('Голос (WebRTC)', v.rtt != null ? `${v.rtt} мс` : 'подключение…'),
      row('Потери пакетов', v.loss != null ? `${String(v.loss).replace('.', ',')} %` : '—', v.loss > 3 ? 'is-bad' : ''),
      row('Джиттер', v.jitter != null ? `${String(v.jitter).replace('.', ',')} мс` : '—'),
      row('Входящий поток', v.bitrate != null ? `${v.bitrate} кбит/с` : '—'),
      row('Кодек', v.codec || '—'),
      row('Маршрут', v.transport === 'relay' ? 'через TURN (relay)' : v.transport === 'direct' ? 'напрямую (P2P)' : (state.forceRelay ? 'через TURN (relay)' : '—')),
    );
    if (v.transport === 'relay' || state.forceRelay) rows.push(row('Сервер TURN', v.turn || (state.relay ? 'свой coturn' : '—')));
  }
  popup.replaceChildren(
    h('div', { class: 'ping-popup__head' },
      h('span', { class: 'ping-popup__icon', dataset: { level: lv } }, icon('i-signal')),
      h('div', null,
        h('div', { class: 'ping-popup__title' }, 'Подключение'),
        h('div', { class: `ping-popup__state ping-popup__state--${lv}` }, state.connected ? LABEL[lv] : 'Нет связи с сервером')),
      h('div', { class: 'ping-popup__big' }, main != null ? String(main) : '—', h('small', null, ' мс'))),
    h('div', { class: 'ping-popup__chart' }, chart(hist), h('div', { class: 'ping-popup__axis' }, h('span', null, `${KEEP * INTERVAL / 1000} с назад`), h('span', null, 'сейчас'))),
    h('div', { class: 'ping-popup__rows' }, ...rows),
    h('p', { class: 'ping-popup__hint' }, inVoice ? 'Голос идёт напрямую между участниками или через TURN-сервер — поэтому его пинг может отличаться от пинга до сервера.' : 'Зайдите в голосовой канал, чтобы видеть качество звонка.'));
}

function closePopup() {
  if (!popup) return;
  popup.remove();
  popup = null;
  popupAnchor?.setAttribute('aria-expanded', 'false');
  popupAnchor = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
function onOutside(e) { if (popup && !popup.contains(e.target) && !e.target.closest('.ping-badge')) closePopup(); }
function onKey(e) { if (e.key === 'Escape' && popup) { e.preventDefault(); e.stopPropagation(); const a = popupAnchor; closePopup(); a?.focus(); } }

function openPopup(anchor) {
  if (popup && popupAnchor === anchor) { closePopup(); return; }
  closePopup();
  popup = h('div', { class: 'ping-popup', role: 'dialog', 'aria-label': 'Подключение' });
  popupAnchor = anchor;
  fillPopup();
  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  const pr = { width: popup.offsetWidth, height: popup.offsetHeight };
  const vw = document.documentElement.clientWidth;
  popup.style.left = `${Math.max(8, Math.min(r.left, vw - pr.width - 8))}px`;
  popup.style.top = `${Math.max(8, r.top - pr.height - 8)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  document.addEventListener('keydown', onKey, true);
}

export function initPing() {
  window.__sozvon = window.__sozvon || {};
  window.__sozvon.ping = ping;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.ping-badge');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    openPopup(b);
  }, true);
  setInterval(measure, INTERVAL);
  setInterval(voiceStats, INTERVAL);
  subscribe('me', () => {
    // сразу после (пере)подключения — первый замер
    if (state.connected && ping.history.length === 0) setTimeout(measure, 300);
    render();
  });
  subscribe('voice', () => { if (state.myVoice && ping.voice.rtt == null) setTimeout(voiceStats, 1500); });
  render();
}

export function measureNow() { measure(); }
