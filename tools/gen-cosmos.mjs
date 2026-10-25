// Astra 2.0: генератор плиток звёздного неба (public/assets/cosmos/*.svg). Детерминированный (seed),
// запуск: node tools/gen-cosmos.mjs. Плитки бесшовные — звезду у края дублируем с другой стороны.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'cosmos');
fs.mkdirSync(OUT, { recursive: true });

function rng(seed) { // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const COLORS = ['#ffffff', '#ffffff', '#ffffff', '#dfe6ff', '#bcd2ff', '#ffe9bf'];
const f = (n) => Math.round(n * 10) / 10;

// «игла» — четырёхлучевая звезда, как в знаке Astra (нижний луч длиннее)
function sparkle(x, y, r, color, op) {
  const k = r * 0.2;
  return `<path d="M${f(x)} ${f(y - r)}L${f(x + k)} ${f(y - k)}L${f(x + r * 0.7)} ${f(y)}L${f(x + k)} ${f(y + k)}L${f(x)} ${f(y + r * 1.3)}L${f(x - k)} ${f(y + k)}L${f(x - r * 0.7)} ${f(y)}L${f(x - k)} ${f(y - k)}Z" fill="${color}" opacity="${op}"/>`;
}

function tile({ size, count, rMin, rMax, sparkles = 0, seed, file }) {
  const rand = rng(seed);
  const parts = [];
  const put = (x, y, fn) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const px = x + dx; const py = y + dy;
        if (px > -12 && px < size + 12 && py > -12 && py < size + 12) parts.push(fn(px, py));
      }
    }
  };
  for (let i = 0; i < count; i++) {
    const x = rand() * size; const y = rand() * size;
    const r = rMin + Math.pow(rand(), 2.2) * (rMax - rMin);
    const c = COLORS[Math.floor(rand() * COLORS.length)];
    const op = f(0.35 + rand() * 0.6);
    put(x, y, (px, py) => `<circle cx="${f(px)}" cy="${f(py)}" r="${f(r)}" fill="${c}" opacity="${op}"/>`);
  }
  for (let i = 0; i < sparkles; i++) {
    const x = 24 + rand() * (size - 48); const y = 24 + rand() * (size - 48);
    const r = 4 + rand() * 4;
    const c = i % 2 ? '#ffe9bf' : '#e6ecff';
    parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.9)}" fill="${c}" opacity="0.10"/>`);
    parts.push(sparkle(x, y, r, c, 0.85));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts.join('')}</svg>\n`;
  fs.writeFileSync(path.join(OUT, file), svg);
  console.log(file, (svg.length / 1024).toFixed(1) + ' КБ');
}

tile({ size: 512, count: 120, rMin: 0.35, rMax: 1.05, seed: 7, file: 'stars-far.svg' });
tile({ size: 768, count: 34, rMin: 0.8, rMax: 1.7, sparkles: 4, seed: 42, file: 'stars-near.svg' });
