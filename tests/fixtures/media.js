// Генерация тестовых медиа через ffmpeg (идемпотентно)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MEDIA_DIR } from './env.js';

const TRACKS = [
  { file: 'qa-sine-440.mp3', freq: 440, dur: 30, title: 'QA Sine 440', artist: 'QA Lab' },
  { file: 'qa-sine-660.mp3', freq: 660, dur: 30, title: 'QA Sine 660', artist: 'QA Lab' },
  { file: 'qa-sine-880.mp3', freq: 880, dur: 30, title: 'QA Sine 880', artist: 'QA Lab' },
];
export const TRACK_META = TRACKS;

function gen(out, args) {
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out]);
}

export function ensureMedia() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const library = [];
  for (const t of TRACKS) {
    const out = path.join(MEDIA_DIR, t.file);
    gen(out, ['-f', 'lavfi', '-i', `sine=frequency=${t.freq}:duration=${t.dur}`, '-q:a', '4',
      '-metadata', `title=${t.title}`, '-metadata', `artist=${t.artist}`]);
    library.push(out);
  }
  // Трек для загрузки через API (не в библиотеке заранее)
  const upload = path.join(MEDIA_DIR, 'qa-upload-550.mp3');
  gen(upload, ['-f', 'lavfi', '-i', 'sine=frequency=550:duration=12', '-q:a', '4',
    '-metadata', 'title=QA Upload Tone', '-metadata', 'artist=QA Uploader']);
  const uploadUi = path.join(MEDIA_DIR, 'qa-upload-ui-330.mp3');
  gen(uploadUi, ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-q:a', '4',
    '-metadata', 'title=QA UI Upload', '-metadata', 'artist=QA Uploader']);
  // Картинка-вложение
  const image = path.join(MEDIA_DIR, 'qa-image.png');
  gen(image, ['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=1', '-frames:v', '1']);
  return { library, upload, uploadUi, image };
}
