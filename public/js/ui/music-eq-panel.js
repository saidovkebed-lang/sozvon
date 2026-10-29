// Панель «Эквалайзер» плавающего плеера: 10 полос (32 Гц–16 кГц), предусиление, пресеты.
// Настройки — prefs 'music.eq' (только у этого слушателя); звук обрабатывает audio/music-eq.js.
import { $, h, icon } from '../util.js';
import { prefs } from '../prefs.js';
import { EQ_BANDS, EQ_PRESETS, EQ_LIMIT, EQ_PREAMP_MIN, EQ_PREAMP_MAX, EQ_DEFAULT, normEq, isFlat, musicEq } from '../audio/music-eq.js';

const KEY = 'music.eq';
const bandLabel = (f) => (f >= 1000 ? `${f / 1000}к` : String(f));
const fmtDb = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${String(Math.abs(v)).replace('.', ',')} дБ`;
let panel = null;
let unsub = null;

const get = () => normEq(prefs.get(KEY));
const set = (patch) => prefs.set(KEY, { ...get(), ...patch });

function presetOf(eq) {
  return EQ_PRESETS.find((p) => p.preamp === eq.preamp && p.gains.every((g, i) => g === eq.gains[i])) || null;
}

function paint() {
  if (!panel) return;
  const eq = get();
  const sw = $('#music-eq-on', panel);
  sw.checked = eq.on;
  panel.classList.toggle('is-off', !eq.on);
  for (const b of panel.querySelectorAll('[data-eq-preset]')) {
    const on = eq.preset === b.dataset.eqPreset;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const custom = $('[data-eq-custom]', panel);
  custom.hidden = eq.preset !== 'custom';
  for (const inp of panel.querySelectorAll('input[data-eq-band]')) {
    const i = Number(inp.dataset.eqBand);
    if (document.activeElement !== inp) inp.value = String(eq.gains[i]);
    inp.setAttribute('aria-valuetext', fmtDb(eq.gains[i]));
    inp.closest('.eq-band').querySelector('.eq-band__val').textContent = eq.gains[i] > 0 ? `+${eq.gains[i]}` : String(eq.gains[i]).replace('-', '−');
  }
  const pre = $('#music-eq-preamp', panel);
  if (document.activeElement !== pre) pre.value = String(eq.preamp);
  pre.setAttribute('aria-valuetext', fmtDb(eq.preamp));
  $('#music-eq-preamp-val', panel).textContent = fmtDb(eq.preamp);
  const info = musicEq.info();
  const note = $('.eq-panel__note', panel);
  if (!musicEq.supported || info.error) note.textContent = info.error || 'Браузер не поддерживает обработку звука — эквалайзер недоступен';
  else if (info.waitingGesture && !isFlat(eq)) note.textContent = 'Эквалайзер включится после первого клика или нажатия клавиши в окне.';
  else note.textContent = isFlat(eq) ? 'Сейчас звук не обрабатывается (эквалайзер выключен или «Ровно»).' : 'Настройки только у вас — остальные слышат музыку как обычно.';
  syncButton();
}

export function syncButton() {
  const btn = $('#btn-music-eq');
  if (!btn) return;
  const eq = get();
  const on = !isFlat(eq);
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? `Эквалайзер: ${presetOf(eq)?.name || 'свой'}` : 'Эквалайзер';
}

function build() {
  const presets = h('div', { class: 'eq-panel__presets', role: 'group', 'aria-label': 'Пресеты' },
    ...EQ_PRESETS.map((p) => h('button', {
      type: 'button', class: 'eq-preset', dataset: { eqPreset: p.id }, 'aria-pressed': 'false',
      onclick: () => prefs.set(KEY, { on: true, preset: p.id, gains: [...p.gains], preamp: p.preamp }),
    }, p.name)),
    h('span', { class: 'eq-preset is-active', dataset: { eqCustom: '' }, hidden: true }, 'Свой'));
  const bands = h('div', { class: 'eq-panel__bands' }, ...EQ_BANDS.map((f, i) => {
    const id = `music-eq-band-${i}`;
    const inp = h('input', {
      type: 'range', class: 'eq-slider', id, min: String(-EQ_LIMIT), max: String(EQ_LIMIT), step: '0.5',
      dataset: { eqBand: String(i) }, 'aria-label': `${bandLabel(f)}Гц`,
    });
    inp.addEventListener('input', () => {
      const gains = get().gains;
      gains[i] = Number(inp.value);
      const eq = { ...get(), on: true, gains };
      eq.preset = presetOf(eq)?.id || 'custom';
      prefs.set(KEY, eq);
    });
    inp.addEventListener('dblclick', () => {
      const gains = get().gains;
      gains[i] = 0;
      const eq = { ...get(), gains };
      eq.preset = presetOf(eq)?.id || 'custom';
      prefs.set(KEY, eq);
    });
    return h('div', { class: 'eq-band' },
      h('span', { class: 'eq-band__val' }, '0'),
      inp,
      h('label', { class: 'eq-band__label', for: id }, bandLabel(f)));
  }));
  const pre = h('input', {
    type: 'range', class: 'slider eq-preamp', id: 'music-eq-preamp', min: String(EQ_PREAMP_MIN), max: String(EQ_PREAMP_MAX), step: '0.5',
    'aria-label': 'Предусиление',
  });
  pre.addEventListener('input', () => {
    const eq = { ...get(), on: true, preamp: Number(pre.value) };
    eq.preset = presetOf(eq)?.id || 'custom';
    prefs.set(KEY, eq);
  });
  const sw = h('input', { type: 'checkbox', class: 'switch', id: 'music-eq-on', role: 'switch', 'aria-label': 'Эквалайзер включён' });
  sw.addEventListener('change', () => set({ on: sw.checked }));
  const el = h('div', {
    class: 'eq-panel', id: 'music-eq-panel', role: 'dialog', 'aria-label': 'Эквалайзер', tabindex: '-1',
  },
  h('div', { class: 'eq-panel__head' },
    h('h3', { class: 'eq-panel__title' }, icon('i-sliders', 'icon--sm'), 'Эквалайзер'),
    h('label', { class: 'eq-panel__switch', for: 'music-eq-on' }, 'Вкл.'), sw,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', title: 'Закрыть', onclick: () => closeEqPanel() }, icon('i-close'))),
  presets,
  h('div', { class: 'eq-panel__preamp' },
    h('label', { class: 'field__label', for: 'music-eq-preamp' }, 'Предусиление'), pre, h('output', { id: 'music-eq-preamp-val' }, '0 дБ')),
  bands,
  h('div', { class: 'eq-panel__foot' },
    h('p', { class: 'eq-panel__note' }),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { eqReset: '' }, onclick: () => prefs.set(KEY, { ...EQ_DEFAULT, gains: [...EQ_DEFAULT.gains] }) }, 'Сбросить')));
  return el;
}

function place() {
  if (!panel) return;
  if (matchMedia('(max-width: 639.98px)').matches) { panel.style.left = ''; panel.style.top = ''; panel.style.bottom = ''; return; }
  const btn = $('#btn-music-eq');
  const r = (btn && !btn.closest('[hidden]') ? btn : $('#music-player'))?.getBoundingClientRect();
  if (!r) return;
  const pr = panel.getBoundingClientRect();
  const pad = 12;
  let left = Math.min(window.innerWidth - pr.width - pad, Math.max(pad, r.right - pr.width));
  let top = r.top - pr.height - 8;
  if (top < pad) top = Math.min(window.innerHeight - pr.height - pad, r.bottom + 8);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.max(pad, Math.round(top))}px`;
}

function onOutside(e) {
  if (panel && !panel.contains(e.target) && !e.target.closest?.('#btn-music-eq')) closeEqPanel();
}
function onKey(e) { if (e.key === 'Escape' && panel) { e.stopPropagation(); closeEqPanel(true); } }

export function openEqPanel() {
  if (panel) return;
  panel = build();
  document.body.append(panel);
  paint();
  place();
  // граф строится асинхронно — подпись «обрабатывается/ждёт клика» перерисуем ещё раз чуть позже
  unsub = prefs.subscribe(KEY, () => { paint(); setTimeout(paint, 700); });
  $('#btn-music-eq')?.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  panel.focus({ preventScroll: true });
}

export function closeEqPanel(focusBack = false) {
  if (!panel) return;
  panel.remove();
  panel = null;
  unsub?.();
  unsub = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  const btn = $('#btn-music-eq');
  btn?.setAttribute('aria-expanded', 'false');
  if (focusBack) btn?.focus();
}

export function initEqPanel() {
  const btn = $('#btn-music-eq');
  if (!btn) return;
  btn.addEventListener('click', () => (panel ? closeEqPanel() : openEqPanel()));
  prefs.subscribe(KEY, syncButton);
  syncButton();
}
