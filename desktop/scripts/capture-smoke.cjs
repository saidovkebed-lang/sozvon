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

// Клавиши рации через Raw Input: READY, затем нажатие V (SendInput через PowerShell) → "d 86" / "u 86"
function runKeys() {
  return new Promise((resolve) => {
    const p = spawn(EXE, ['--keys', '--watch', '86']);
    let out = '';
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.on('data', (c) => {
      out += c;
      if (out.includes('READY') && !out.includes('#sent')) {
        out += '#sent';
        spawn('powershell', ['-NoProfile', '-Command', "(New-Object -ComObject WScript.Shell).SendKeys('v')"], { stdio: 'ignore' });
      }
    });
    setTimeout(() => { p.stdin.end(); }, 6000);
    p.on('exit', (code) => resolve({ code, ready: out.includes('READY'), down: /d 86/.test(out), up: /u 86/.test(out), err }));
  });
}

// Что играет (--media, системные медиасессии): READY, затем строки JSON {"t":"media","sessions":[…]} (на раннере CI
// медиасессий нет — пустой список или ничего за 3 с — это нормально); конец stdin — выход с кодом 0.
function runMedia(ms = 3000) {
  return new Promise((resolve) => {
    const p = spawn(EXE, ['--media']);
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    setTimeout(() => { p.stdin.end(); }, ms);
    const kill = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 15000);
    p.on('exit', (code) => {
      clearTimeout(kill);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let bad = 0;
      const sessions = [];
      const msgs = [];
      for (const l of lines.slice(1)) {
        try {
          const m = JSON.parse(l);
          if (m.t !== 'media' || !Array.isArray(m.sessions)) bad++;
          else { sessions.push(...m.sessions); msgs.push(m.sessions); }
        } catch { bad++; }
      }
      resolve({ code, ready: lines[0] === 'READY', json: lines.length - 1, bad, sessions, msgs, err });
    });
  });
}

// Своя медиасессия (PowerShell: MediaPlayer + SystemMediaTransportControls) — проверка UTF-8/экранирования JSON
// на настоящих данных. На серверной Windows без Media Foundation сессия может не появиться — тогда только сообщение.
const SMTC_TITLE = 'Тест «Astra» "кавычки" \\ слэш';
function fakeSession() {
  const ps1 = path.join(require('node:os').tmpdir(), `astra-smtc-${process.pid}.ps1`);
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  require('node:fs').writeFileSync(ps1, '\ufeff' + [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$null = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]',
    '$p = New-Object Windows.Media.Playback.MediaPlayer',
    '$p.CommandManager.IsEnabled = $false',
    '$c = $p.SystemMediaTransportControls',
    '$c.IsEnabled = $true; $c.IsPlayEnabled = $true; $c.IsPauseEnabled = $true',
    '$c.PlaybackStatus = [Windows.Media.MediaPlaybackStatus]::Playing',
    '$u = $c.DisplayUpdater',
    '$u.Type = [Windows.Media.MediaPlaybackType]::Music',
    `$u.MusicProperties.Title = ${q(SMTC_TITLE)}`,
    "$u.MusicProperties.Artist = 'Astra Smoke'",
    "$u.MusicProperties.AlbumTitle = 'Smoke Album'",
    '$u.Update()',
    // длина 200 с, позиция 42 с — проверка durationMs/positionMs
    '$t = New-Object Windows.Media.SystemMediaTransportControlsTimelineProperties',
    '$t.StartTime = [TimeSpan]::Zero; $t.MinSeekTime = [TimeSpan]::Zero',
    '$t.EndTime = [TimeSpan]::FromSeconds(200); $t.MaxSeekTime = [TimeSpan]::FromSeconds(200)',
    '$t.Position = [TimeSpan]::FromSeconds(42)',
    '$c.UpdateTimelineProperties($t)',
    'Write-Output "SMTC-OK"',
    // через 3 с — пауза: помощник должен прислать строку с playing:false
    'Start-Sleep -Seconds 3',
    '$c.PlaybackStatus = [Windows.Media.MediaPlaybackStatus]::Paused',
    'Write-Output "SMTC-PAUSED"',
    'Start-Sleep -Seconds 12',
  ].join('\r\n'), 'utf8');
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (c) => { log += c; });
  p.stderr.on('data', (c) => { log += c; });
  return { stop: () => { try { p.kill(); } catch { /* ignore */ } }, log: () => log };
}

(async () => {
  let ok = true;
  {
    const sess = fakeSession();
    // ждём, пока PowerShell поднимет сессию (на раннере — до десятка секунд)
    for (let i = 0; i < 100 && !/SMTC-OK|Exception|error/i.test(sess.log()); i++) await new Promise((r) => setTimeout(r, 200));
    const r = await runMedia(6000); // играет ~3 с, затем пауза
    sess.stop();
    const isMine = (s) => s.artist === 'Astra Smoke';
    const mine = r.sessions.find(isMine);
    console.log(`== media (своя сессия): код ${r.code}, строк JSON ${r.json}, ошибок разбора ${r.bad}, сессий ${r.sessions.length}`);
    for (const m of r.msgs.slice(0, 6)) console.log(`   ${JSON.stringify(m)}`);
    if (r.bad || r.code !== 0) ok = false;
    if (mine) {
      const states = r.msgs.map((m) => m.find(isMine)).filter(Boolean);
      const playing = states.filter((s) => s.playing);
      const paused = states.filter((s) => !s.playing);
      console.log(`   своя медиасессия: строк «играет» ${playing.length}, «пауза» ${paused.length}; длина ${mine.durationMs} мс, позиция ${mine.positionMs} мс, альбом «${mine.album}»`);
      if (mine.title !== SMTC_TITLE) { console.log(`   название искажено: ${JSON.stringify(mine.title)}`); ok = false; }
      // без изменений строка не повторяется (повтор — не чаще раза в 5 с)
      if (playing.length > 2) { console.log('   лишние строки без изменений'); ok = false; }
      if (!paused.length) { console.log('   пауза не пришла'); ok = false; }
      if (mine.album !== 'Smoke Album') { console.log('   альбом не прочитан'); ok = false; }
      if (mine.durationMs && Math.abs(mine.durationMs - 200000) > 1000) { console.log('   длина неверна'); ok = false; }
      if (!mine.durationMs) console.log('   (длину Windows не отдала — у этой сессии нет временной шкалы)');
    } else {
      console.log(`   (своя медиасессия не появилась — нет Media Foundation на сервере CI?)\n   ${sess.log().trim().split('\n').slice(0, 6).join('\n   ')}`);
    }
  }
  const md = await runMedia();
  console.log(`== media: код ${md.code}, READY ${md.ready}, строк JSON ${md.json}, ошибок разбора ${md.bad}, сессий ${md.sessions.length}`);
  console.log(md.err.trim().split('\n').map((l) => `   ${l}`).join('\n'));
  for (const s of md.sessions.slice(0, 5)) console.log(`   ${s.app}: ${s.artist} — ${s.title} (${s.playing ? 'играет' : 'пауза'})`);
  if (!md.ready || md.code !== 0 || md.bad) ok = false;
  const k = await runKeys();
  console.log(`== keys: код ${k.code}, READY ${k.ready}, нажатие ${k.down}, отпускание ${k.up}`);
  console.log(k.err.trim().split('\n').map((l) => `   ${l}`).join('\n'));
  if (!k.ready || k.code !== 0) ok = false;
  if (k.ready && !(k.down && k.up)) console.log('   (нажатие не дошло — на сервере CI нет активного рабочего стола? Raw Input всё равно запущен)');
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
