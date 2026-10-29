// Фейковые источники обложек для tests/v21-music-extras (COVERS_DEEZER_BASE / COVERS_ITUNES_BASE / картинки).
// Ответ зависит от метки в запросе (без учёта регистра):
//   «qadeezerhit»   → Deezer: альбом с cover_medium = /img/deezer-<запрос>.jpg
//   «qadeezerwrong» → Deezer: найден ДРУГОЙ исполнитель (должен быть отвергнут) → iTunes находит
//   «qadeezerfail»  → Deezer: HTTP 500 → iTunes находит
//   «qaituneshit»   → Deezer пусто → iTunes: artworkUrl100 = /img/itunes-<запрос>/100x100bb.jpg (сервер просит 600x600bb)
//   «qabadimage»    → Deezer: cover_medium указывает на «картинку», которая не картинка → iTunes находит
//   иначе           → пусто везде
// /img/<что угодно> — JPEG 600×600 (ffmpeg, цвет по имени), /img/notimg-* — HTML, /img/missing-* — 404,
// /img/redirect-* — 302 на localhost (не разрешённый хост).
// Каждый запрос пишется JSON-строкой в logFile: {path, q}.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const COLORS = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'orange', 'purple'];
const imgCache = new Map();
function jpeg(name) {
  const color = COLORS[parseInt(crypto.createHash('md5').update(name).digest('hex').slice(0, 2), 16) % COLORS.length];
  if (!imgCache.has(color)) {
    imgCache.set(color, execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=600x600`,
      '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { maxBuffer: 10e6 }));
  }
  return imgCache.get(color);
}

export function startFakeCovers(port, logFile) {
  const base = `http://127.0.0.1:${port}`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    const q = (u.searchParams.get('q') || u.searchParams.get('term') || '').toLowerCase();
    if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ ts: Date.now(), path: u.pathname, q }) + '\n'); } catch { /* ignore */ }
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const slug = q.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
    if (u.pathname === '/deezer/search') {
      if (q.includes('qadeezerfail')) return json(500, { error: 'boom' });
      if (q.includes('qadeezerhit')) return json(200, { data: [{ title: 'x', artist: { name: '' }, album: { cover_medium: `${base}/img/deezer-${slug}.jpg` } }] });
      if (q.includes('qadeezerwrong')) return json(200, { data: [{ title: 'x', artist: { name: 'Совсем Другой Исполнитель' }, album: { cover_medium: `${base}/img/deezer-wrong.jpg` } }] });
      if (q.includes('qabadimage')) return json(200, { data: [{ title: 'x', artist: { name: '' }, album: { cover_medium: `${base}/img/notimg-${slug}.jpg` } }] });
      return json(200, { data: [], total: 0 });
    }
    if (u.pathname === '/itunes/search') {
      if (['qaituneshit', 'qadeezerwrong', 'qadeezerfail', 'qabadimage'].some((k) => q.includes(k))) {
        return json(200, { resultCount: 1, results: [{ artistName: '', trackName: 'x', artworkUrl100: `${base}/img/itunes-${slug}/100x100bb.jpg` }] });
      }
      return json(200, { resultCount: 0, results: [] });
    }
    if (u.pathname.startsWith('/img/')) {
      const name = u.pathname.slice(5);
      if (name.startsWith('missing')) { res.writeHead(404); return res.end('nope'); }
      // редирект на хост не из COVERS_IMAGE_HOSTS (localhost вместо 127.0.0.1) — сервер не должен идти
      if (name.startsWith('redirect')) { res.writeHead(302, { location: `http://localhost:${port}/img/after-redirect.jpg` }); return res.end(); }
      if (name.startsWith('notimg')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not an image</html>'); }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(jpeg(name));
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
