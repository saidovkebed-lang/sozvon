'use strict';
// Проверка sozvon-capture.exe на настоящей Windows (CI): кадры в stdout и по HTTP (--listen).
// Запуск: node scripts/capture-smoke.cjs [путь к exe]
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const EXE = process.argv[2] || path.join(__dirname, '..', 'native', 'capture', 'build', 'sozvon-capture.exe');
const MAGIC = 0x31435a53;

function parse(buf) {
  const frames = [];
  let i = 0;
  while (i + 24 <= buf.length) {
    if (buf.readUInt32LE(i) !== MAGIC) throw new Error(`плохой заголовок на ${i}`);
    const len = buf.readUInt32LE(i + 12);
    if (i + 24 + len > buf.length) break;
    frames.push({ w: buf.readUInt32LE(i + 4), h: buf.readUInt32LE(i + 8), len, ts: Number(buf.readBigUInt64LE(i + 16)) });
    i += 24 + len;
  }
  return frames;
}

function runStdout() {
  return new Promise((resolve) => {
    const p = spawn(EXE, ['--monitor', '0,0,100,100', '--max-width', '1280', '--max-height', '720', '--fps', '30']);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c; });
    setTimeout(() => p.stdin.end(), 3000);
    p.on('exit', (code) => resolve({ code, frames: parse(Buffer.concat(chunks)), err }));
  });
}

function runListen() {
  return new Promise((resolve) => {
    const token = 'smoketoken0123456789';
    const p = spawn(EXE, ['--monitor', '0,0,100,100', '--fps', '30', '--listen', '--token', token, '--origin', 'https://example.org']);
    let out = '';
    let err = '';
    const chunks = [];
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/PORT (\d+)/);
      if (!m || out.includes('#got')) return;
      out += '#got';
      const req = http.get({ host: '127.0.0.1', port: Number(m[1]), path: `/${token}`, headers: { Origin: 'https://example.org' } }, (res) => {
        res.on('data', (c) => chunks.push(c));
        setTimeout(() => { req.destroy(); }, 3000);
      });
      req.on('error', () => {});
    });
    p.on('exit', (code) => resolve({ code, frames: parse(Buffer.concat(chunks)), err }));
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 15000);
  });
}

// Звук без своего процесса (WASAPI process loopback): пакеты 'SZA1'. На серверах CI часто нет устройства вывода —
// тогда помощник честно выходит с кодом 4 («process loopback недоступен»): это не ошибка сборки.
function runAudio() {
  return new Promise((resolve) => {
    const token = 'smoketoken0123456789';
    const p = spawn(EXE, ['--audio-exclude-pid', String(process.pid), '--listen', '--token', token, '--origin', 'https://example.org']);
    let out = '';
    let err = '';
    const chunks = [];
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/PORT (\d+)/);
      if (!m || out.includes('#got')) return;
      out += '#got';
      const req = http.get({ host: '127.0.0.1', port: Number(m[1]), path: `/${token}`, headers: { Origin: 'https://example.org' } }, (res) => {
        res.on('data', (c) => chunks.push(c));
        setTimeout(() => { req.destroy(); }, 2500);
      });
      req.on('error', () => {});
    });
    p.on('exit', (code) => {
      const buf = Buffer.concat(chunks);
      let i = 0;
      let packets = 0;
      let frames = 0;
      let rate = 0;
      while (i + 24 <= buf.length) {
        if (buf.readUInt32LE(i) !== 0x31415a53) break;
        const len = buf.readUInt32LE(i + 12);
        if (i + 24 + len > buf.length) break;
        rate = buf.readUInt32LE(i + 4);
        frames += len / (buf.readUInt32LE(i + 8) * 2);
        packets++;
        i += 24 + len;
      }
      resolve({ code, packets, frames, rate, err });
    });
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 15000);
  });
}

(async () => {
  let ok = true;
  const a = await runAudio();
  console.log(`== audio: код ${a.code}, пакетов ${a.packets}, ${a.rate} Гц, ~${(a.frames / (a.rate || 48000)).toFixed(2)} с звука`);
  console.log(a.err.trim().split('\n').map((l) => `   ${l}`).join('\n'));
  if (a.packets < 20 && !(a.code === 4 && /loopback|Initialize|захват звука/.test(a.err))) ok = false;
  if (a.code === 4) console.log('   (на этой машине process loopback недоступен — в приложении будет запасной путь)');
  for (const [name, fn] of [['stdout', runStdout], ['listen', runListen]]) {
    const r = await fn();
    const f = r.frames;
    const fps = f.length > 1 ? ((f.length - 1) * 1e6) / (f[f.length - 1].ts - f[0].ts) : 0;
    console.log(`== ${name}: код ${r.code}, кадров ${f.length}${f.length ? `, ${f[0].w}x${f[0].h}, ~${fps.toFixed(1)} кадр/с` : ''}`);
    console.log(r.err.trim().split('\n').map((l) => `   ${l}`).join('\n'));
    if (f.length < 5) ok = false;
  }
  console.log(ok ? 'CAPTURE SMOKE: OK' : 'CAPTURE SMOKE: FAIL');
  process.exit(ok ? 0 : 1);
})();
