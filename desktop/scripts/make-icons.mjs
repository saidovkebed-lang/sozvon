// Генерация иконок приложения из public/assets/logo.svg (sharp, без внешних утилит).
//   build/icon.png (1024), build/icon.ico (16..256, PNG-внутри), build/icon.icns, build/icons/NxN.png (Linux)
//   src/assets/: icon.png (окно), tray*.png (трей, обычный/mute/deafen/непрочитанное), badge-*.png (оверлей панели задач)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const logoPath = path.resolve(root, '../public/assets/logo.svg');
const logo = fs.readFileSync(logoPath, 'utf8');
const buildDir = path.join(root, 'build');
const iconsDir = path.join(buildDir, 'icons');
const assetsDir = path.join(root, 'src/assets');
for (const d of [buildDir, iconsDir, assetsDir]) fs.mkdirSync(d, { recursive: true });

async function svgPng(svg, size) {
  return sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size) / 64) * 2) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Логотип без внешней <svg>-обёртки — для композиции с оверлеями
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const wrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${body}</svg>`;

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const png = {};
for (const s of sizes) png[s] = await svgPng(logo, s);

fs.writeFileSync(path.join(buildDir, 'icon.png'), png[1024]);
for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) fs.writeFileSync(path.join(iconsDir, `${s}x${s}.png`), png[s]);

// ICO: каталог + PNG-изображения (поддерживается Windows Vista+)
function makeIco(list) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(list.length, 4);
  const dir = Buffer.alloc(16 * list.length);
  let offset = 6 + dir.length;
  list.forEach(([size, data], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...list.map(([, d]) => d)]);
}
fs.writeFileSync(path.join(buildDir, 'icon.ico'), makeIco([16, 24, 32, 48, 64, 128, 256].map((s) => [s, png[s]])));

// ICNS: PNG-элементы (macOS 10.7+)
function makeIcns(list) {
  const chunks = list.map(([type, data]) => {
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}
fs.writeFileSync(path.join(buildDir, 'icon.icns'), makeIcns([
  ['icp4', png[16]], ['icp5', png[32]], ['icp6', png[64]], ['ic07', png[128]],
  ['ic08', png[256]], ['ic09', png[512]], ['ic10', png[1024]],
]));

// Иконка окна (Linux/Windows в рантайме)
fs.writeFileSync(path.join(assetsDir, 'icon.png'), png[256]);
fs.writeFileSync(path.join(assetsDir, 'logo-128.png'), png[128]);

// Трей: обычная, mute (красная перечёркнутая точка), deafen, непрочитанное (красная точка)
const dot = (color) => `<circle cx="50" cy="50" r="13" fill="${color}" stroke="#1e1f22" stroke-width="3"/>`;
const slash = '<path d="M43 43 57 57" stroke="#fff" stroke-width="4" stroke-linecap="round"/>';
const tray = {
  tray: wrap(inner),
  'tray-unread': wrap(inner + dot('#f23f43')),
  'tray-muted': wrap(inner + dot('#f23f43') + slash),
  'tray-deafened': wrap(inner + dot('#f0b232') + slash),
};
for (const [name, svg] of Object.entries(tray)) {
  fs.writeFileSync(path.join(assetsDir, `${name}.png`), await svgPng(svg, 32));
  fs.writeFileSync(path.join(assetsDir, `${name}@2x.png`), await svgPng(svg, 64));
}

// Бейджи для оверлея панели задач Windows (16×16 логических, рисуем 32 → @2x)
const badge = (text) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <circle cx="16" cy="16" r="15" fill="#f23f43"/>
  ${text ? `<text x="16" y="${text.length > 1 ? 21.5 : 23}" text-anchor="middle" font-family="Segoe UI, DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${text.length > 1 ? 15 : 20}" fill="#fff">${text}</text>` : ''}
</svg>`;
for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(assetsDir, `badge-${i}.png`), await svgPng(badge(String(i)), 32));
fs.writeFileSync(path.join(assetsDir, 'badge-9p.png'), await svgPng(badge('9+'), 32));
fs.writeFileSync(path.join(assetsDir, 'badge-dot.png'), await svgPng(badge(''), 32));

console.log('icons written to', path.relative(process.cwd(), buildDir), 'and', path.relative(process.cwd(), assetsDir));
