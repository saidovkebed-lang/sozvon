// Сборка public/vendor/mediasoup-client.js — клиент SFU одним ES-модулем (у клиента нет сборщика).
// Запуск: npm run build:vendor (нужны devDependencies: mediasoup-client, esbuild). Результат коммитится.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// каталог пакета (package.json может быть закрыт полем exports — ищем вверх от точки входа)
function pkgDirOf(name, from = ROOT) {
  let dir = path.dirname(require.resolve(name, { paths: [from] }));
  while (!fs.existsSync(path.join(dir, 'package.json')) || !dir.includes(name.replace('-alias', ''))) dir = path.dirname(dir);
  return dir;
}
const pkgDir = pkgDirOf('mediasoup-client');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const out = path.join(ROOT, 'public', 'vendor', 'mediasoup-client.js');

// Лицензии: mediasoup-client (ISC) и вшитые зависимости
const deps = ['awaitqueue', 'debug', 'ms', 'events-alias', 'fake-mediastreamtrack', 'h264-profile-level-id', 'sdp-transform']
  .map((name) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(pkgDirOf(name, pkgDir), 'package.json'), 'utf8'));
      return ` *   ${name === 'events-alias' ? 'events' : p.name}@${p.version} — ${p.license}`;
    } catch { return null; }
  }).filter(Boolean);
const license = fs.readFileSync(path.join(pkgDir, 'LICENSE'), 'utf8').trim().split('\n').map((l) => ` * ${l}`.trimEnd()).join('\n');
const banner = `/**
 * mediasoup-client v${pkg.version} — https://mediasoup.org (сборка: tools/build-vendor.mjs, esbuild, ESM)
 *
${license}
 *
 * Вшитые зависимости (лицензии MIT/ISC, полные тексты — в их пакетах npm):
${deps.join('\n')}
 */`;

await build({
  // пакет — CommonJS: `export *` из него в ESM пуст, поэтому перечисляем имена явно
  stdin: {
    contents: `import * as msc from 'mediasoup-client';
export const { Device, version, detectDevice, detectDeviceAsync, parseScalabilityMode, debug, types } = msc;
export default msc;`,
    resolveDir: ROOT, loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome100', 'firefox100', 'safari15'],
  minify: true,
  legalComments: 'none',
  banner: { js: banner },
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: out,
});
console.log(`[vendor] ${path.relative(ROOT, out)}: ${(fs.statSync(out).size / 1024).toFixed(0)} КБ (mediasoup-client ${pkg.version})`);
