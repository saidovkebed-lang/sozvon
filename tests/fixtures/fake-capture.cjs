'use strict';
// Подделка sozvon-capture.exe для тестов на Linux (тот же протокол, см. desktop/native/capture/capture.cpp):
// кадры I420 — заливка цветом, меняющимся со временем, + белый квадрат, бегущий по кадру.
// Журнал действий — в файл SOZVON_CAPTURE_FAKE_LOG (start/pause/resume/exit). С --listen — как настоящий:
// "PORT n" в stdout, кадры по HTTP на GET /token.
// SOZVON_CAPTURE_FAKE_MODE: silent — не слать кадры; exit3 — через 2 с выйти с кодом 3 («окно закрыто»).
const fs = require('node:fs');
const http = require('node:http');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const maxW = Number(arg('--max-width', 1280));
const maxH = Number(arg('--max-height', 720));
const fps = Number(arg('--fps', 30));
const mode = process.env.SOZVON_CAPTURE_FAKE_MODE || '';
const logFile = process.env.SOZVON_CAPTURE_FAKE_LOG;
const log = (s) => { if (logFile) fs.appendFileSync(logFile, `${Date.now()} ${s}\n`); };

let w = Math.min(maxW, 1920) & ~1;
let h = Math.min(maxH, Math.round((w * 9) / 16)) & ~1;
w = Math.min(w, Math.round((h * 16) / 9)) & ~1;
log(`start ${argv.join(' ')} -> ${w}x${h}@${fps}`);
process.stderr.write(`[capture] fake ${w}x${h}@${fps}\n`);

let paused = false;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'pause' || line === 'resume') { paused = line === 'pause'; log(line); }
  }
});
process.stdin.on('end', () => { log('exit stdin-end'); process.exit(0); });

if (mode === 'exit3') setTimeout(() => { log('exit 3'); process.exit(3); }, 2000);

const ySize = w * h;
const cSize = (w / 2) * (h / 2);
const frame = Buffer.alloc(ySize + 2 * cSize);
const header = Buffer.alloc(24);
let n = 0;
let out = argv.includes('--listen') ? null : process.stdout;

function makeFrame() {
  n++;
  // фон: Y медленно меняется, U/V — оттенок
  frame.fill(60 + (n % 120), 0, ySize);
  frame.fill(90, ySize, ySize + cSize);
  frame.fill(170, ySize + cSize);
  const s = Math.max(8, (h / 6) | 0);
  const x0 = (n * 7) % Math.max(1, w - s);
  const y0 = (h - s) >> 1;
  for (let y = y0; y < y0 + s; y++) frame.fill(235, y * w + x0, y * w + x0 + s);
  header.writeUInt32LE(0x31435a53, 0);
  header.writeUInt32LE(w, 4);
  header.writeUInt32LE(h, 8);
  header.writeUInt32LE(frame.length, 12);
  header.writeBigUInt64LE(BigInt(Math.round(performance.now() * 1000)), 16);
  return Buffer.concat([header, frame]);
}

setInterval(() => {
  if (paused || mode === 'silent' || !out) return;
  if (out.writableLength > 8 * frame.length) return; // клиент не успевает — пропуск (как блокирующая запись)
  out.write(makeFrame());
}, Math.round(1000 / fps));
process.stdout.on('error', () => process.exit(0));

if (!out) {
  const token = arg('--token', '');
  const origin = arg('--origin', '');
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' };
  const srv = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Content-Length': 0 }); res.end(); return; }
    if (req.method !== 'GET' || req.url !== `/${token}` || out) { res.writeHead(404); res.end(); return; }
    // как настоящий помощник: сырой ответ без chunked, конец потока — закрытие соединения
    const sock = req.socket;
    sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\n'
      + Object.entries(cors).map(([k, v]) => `${k}: ${v}\r\n`).join('') + 'Connection: close\r\n\r\n');
    out = sock;
    log('client');
    srv.close();
    sock.on('close', () => { log('exit client-closed'); process.exit(0); });
    sock.on('error', () => {});
  });
  srv.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${srv.address().port}\n`));
}
