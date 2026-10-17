// Кадрирование картинки (#modal-crop): canvas, перетаскивание, колесо/ползунок/щипок — масштаб.
// Статичные картинки обрезаются в браузере (результат — готовый файл нужного размера, сервер его только
// пережимает). Анимированные (GIF, APNG, animated WebP) не перерисовываем, чтобы не потерять анимацию:
// отдаём исходник + кадр {x,y,size} / {x,y,width,height} в пикселях исходника — режет сервер (ffmpeg).
import { $ } from '../util.js';
import { openModal, closeModal } from './modals.js';
import { toast } from './toasts.js';

const OUT = { avatar: 512, bannerW: 960, bannerH: 340 };

/** GIF / APNG (acTL) / animated WebP (ANIM) */
export async function isAnimatedImage(file) {
  if (file.type === 'image/gif') return true;
  try {
    const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const find = (sig) => {
      outer: for (let i = 0; i < buf.length - sig.length; i++) {
        for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig.charCodeAt(j)) continue outer;
        return true;
      }
      return false;
    };
    if (file.type === 'image/png' || file.type === 'image/apng') return find('acTL');
    if (file.type === 'image/webp') return find('ANIM');
  } catch { /* ignore */ }
  return false;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось открыть картинку'));
    img.src = url;
  });
}

let session = null;

function geometry() {
  const c = session.canvas;
  const W = c.width; const H = c.height;
  const pad = session.aspect === 1 ? 60 : 24;
  let fw = W - pad * 2;
  let fh = fw / session.aspect;
  if (fh > H - pad * 2) { fh = H - pad * 2; fw = fh * session.aspect; }
  return { W, H, fx: (W - fw) / 2, fy: (H - fh) / 2, fw, fh };
}

function baseScale() {
  const { fw, fh } = geometry();
  const { img } = session;
  return Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
}

function clamp() {
  const { fx, fy, fw, fh } = geometry();
  const s = baseScale() * session.zoom;
  const iw = session.img.naturalWidth * s;
  const ih = session.img.naturalHeight * s;
  // картинка всегда покрывает рамку
  session.ox = Math.min(fx, Math.max(fx + fw - iw, session.ox));
  session.oy = Math.min(fy, Math.max(fy + fh - ih, session.oy));
}

function draw() {
  const { canvas, img } = session;
  const ctx = canvas.getContext('2d');
  const { W, H, fx, fy, fw, fh } = geometry();
  const s = baseScale() * session.zoom;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, session.ox, session.oy, img.naturalWidth * s, img.naturalHeight * s);
  // затемнение вне рамки
  ctx.save();
  ctx.fillStyle = 'rgba(5, 6, 9, 0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  if (session.round) ctx.arc(fx + fw / 2, fy + fh / 2, fw / 2, 0, Math.PI * 2, true);
  else roundRect(ctx, fx, fy, fw, fh, 10, true);
  ctx.fill('evenodd');
  ctx.restore();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (session.round) ctx.arc(fx + fw / 2, fy + fh / 2, fw / 2, 0, Math.PI * 2);
  else roundRect(ctx, fx, fy, fw, fh, 10);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, hh, r, ccw = false) {
  if (ccw) {
    ctx.moveTo(x + r, y); ctx.arcTo(x, y, x, y + r, r); ctx.lineTo(x, y + hh - r); ctx.arcTo(x, y + hh, x + r, y + hh, r);
    ctx.lineTo(x + w - r, y + hh); ctx.arcTo(x + w, y + hh, x + w, y + hh - r, r); ctx.lineTo(x + w, y + r); ctx.arcTo(x + w, y, x + w - r, y, r);
    ctx.closePath();
  } else {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + hh - r); ctx.arcTo(x + w, y + hh, x + w - r, y + hh, r);
    ctx.lineTo(x + r, y + hh); ctx.arcTo(x, y + hh, x, y + hh - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}

function reset() {
  const { fx, fy, fw, fh } = geometry();
  session.zoom = 1;
  const s = baseScale();
  session.ox = fx + (fw - session.img.naturalWidth * s) / 2;
  session.oy = fy + (fh - session.img.naturalHeight * s) / 2;
  $('#crop-zoom').value = '100';
  paintZoom();
  draw();
}

function setZoom(z, cx = null, cy = null) {
  const { fx, fy, fw, fh } = geometry();
  const old = baseScale() * session.zoom;
  session.zoom = Math.max(1, Math.min(4, z));
  const nw = baseScale() * session.zoom;
  // масштаб относительно точки (центр рамки или курсор)
  const px = cx ?? fx + fw / 2; const py = cy ?? fy + fh / 2;
  session.ox = px - (px - session.ox) * (nw / old);
  session.oy = py - (py - session.oy) * (nw / old);
  clamp();
  $('#crop-zoom').value = String(Math.round(session.zoom * 100));
  paintZoom();
  draw();
}

function paintZoom() {
  const z = $('#crop-zoom');
  z.style.setProperty('--val', `${((Number(z.value) - 100) / 300) * 100}%`);
}

/** Кадр в пикселях исходника */
function cropRect() {
  const { fx, fy, fw, fh } = geometry();
  const s = baseScale() * session.zoom;
  return { x: (fx - session.ox) / s, y: (fy - session.oy) / s, w: fw / s, h: fh / s };
}

function toPoint(e) {
  const r = session.canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (session.canvas.width / r.width), y: (e.clientY - r.top) * (session.canvas.height / r.height) };
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  const c = $('#crop-canvas');
  const pointers = new Map();
  let pinch = null;
  c.addEventListener('pointerdown', (e) => {
    if (!session) return;
    c.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, toPoint(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: session.zoom };
    }
    c.classList.add('is-dragging');
  });
  c.addEventListener('pointermove', (e) => {
    if (!session || !pointers.has(e.pointerId)) return;
    const p = toPoint(e);
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    session.ox += p.x - prev.x;
    session.oy += p.y - prev.y;
    clamp();
    draw();
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) c.classList.remove('is-dragging'); };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('wheel', (e) => {
    if (!session) return;
    e.preventDefault();
    const p = toPoint(e);
    setZoom(session.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  c.addEventListener('keydown', (e) => {
    if (!session) return;
    const step = e.shiftKey ? 20 : 6;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); session.ox += moves[e.key][0]; session.oy += moves[e.key][1]; clamp(); draw(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(session.zoom * 1.1); }
    else if (e.key === '-') { e.preventDefault(); setZoom(session.zoom / 1.1); }
  });
  $('#crop-zoom').addEventListener('input', (e) => { if (session) setZoom(Number(e.target.value) / 100); });
  $('#crop-reset').addEventListener('click', () => { if (session) reset(); });
  $('#crop-ok').addEventListener('click', finish);
  $('#modal-crop').addEventListener('close', () => {
    if (!session) return;
    const s = session;
    session = null;
    s.resolve(s.result || null);
  });
}

async function finish() {
  if (!session) return;
  const btn = $('#crop-ok');
  btn.disabled = true;
  try {
    const r = cropRect();
    const { file, aspect, animated } = session;
    let result;
    if (animated) {
      const crop = aspect === 1
        ? { x: r.x, y: r.y, size: r.w }
        : { x: r.x, y: r.y, width: r.w, height: r.h };
      result = { file, crop, previewUrl: session.url, animated: true };
    } else {
      const ow = aspect === 1 ? Math.min(OUT.avatar, Math.max(256, Math.round(r.w))) : OUT.bannerW;
      const oh = aspect === 1 ? ow : OUT.bannerH;
      const out = document.createElement('canvas');
      out.width = ow; out.height = oh;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(session.img, r.x, r.y, r.w, r.h, 0, 0, ow, oh);
      const type = 'image/png';
      const blob = await new Promise((res) => out.toBlob(res, type));
      if (!blob) throw new Error('Не удалось подготовить картинку');
      const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.png';
      const cropped = new File([blob], name, { type });
      result = { file: cropped, crop: null, previewUrl: URL.createObjectURL(blob), animated: false };
    }
    session.result = result;
    closeModal('modal-crop');
  } catch (e) {
    toast(e.message || String(e));
  } finally { btn.disabled = false; }
}

/**
 * Открыть кадрирование. aspect: 1 (аватар/иконка) или 960/340 (баннер); round — круглая рамка.
 * → Promise<{file, crop, previewUrl, animated} | null>
 */
export async function openCropper(file, { aspect = 1, round = false, title = 'Кадрирование' } = {}) {
  wire();
  if (!/^image\//.test(file.type)) { toast('Нужна картинка: PNG, JPG, WebP или GIF'); return null; }
  const url = URL.createObjectURL(file);
  let img;
  try { img = await loadImage(url); } catch (e) { toast(e.message); URL.revokeObjectURL(url); return null; }
  const animated = await isAnimatedImage(file);
  const canvas = $('#crop-canvas');
  canvas.width = 480;
  canvas.height = aspect === 1 ? 480 : 300;
  $('#modal-crop-title').textContent = title;
  const note = $('#crop-note');
  note.hidden = !animated;
  note.textContent = animated ? 'Анимация сохранится — сервер обрежет её по выбранной рамке.' : '';
  $('#crop-box').classList.toggle('crop--wide', aspect !== 1);
  return new Promise((resolve) => {
    session = { file, img, url, aspect, round, animated, canvas, zoom: 1, ox: 0, oy: 0, resolve, result: null };
    reset();
    openModal('modal-crop');
    canvas.focus({ preventScroll: true });
  });
}
