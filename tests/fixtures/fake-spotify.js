// Фейковый open.spotify.com/embed для тестов музыки v2 (SPOTIFY_EMBED_BASE=http://127.0.0.1:<port>/embed).
// Отдаёт реальные embed-страницы из tests/fixtures/music/ и производные от них короткие плейлисты.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'music');
const RE = /(<script id="__NEXT_DATA__" type="application\/json">)([\s\S]*?)(<\/script>)/;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

/** Производная страница: та же разметка, но trackList изменён функцией fn. */
function derive(file, fn) {
  const html = read(file);
  return html.replace(RE, (_, a, json, c) => {
    const d = JSON.parse(json);
    const e = d.props.pageProps.state.data.entity;
    fn(e);
    return a + JSON.stringify(d).replace(/</g, '\\u003c') + c;
  });
}

export const SPOTIFY_PAGES = {
  'playlist/37i9dQZF1DXcBWIGoYBM5M': () => read('spotify-embed-playlist.html'),
  'album/4aawyAB9vmqN3uQ7FjRGTy': () => read('spotify-embed-album.html'),
  'track/4cOdK2wGLETKBW3PvgPWqT': () => read('spotify-embed-track.html'),
  // 3 первых трека реального плейлиста
  'playlist/qaThree000000000000000': () => derive('spotify-embed-playlist.html', (e) => { e.name = 'QA Spotify Three'; e.title = e.name; e.trackList = e.trackList.slice(0, 3); }),
  // 1-й и 3-й — реальные, 2-й не находится ни в одном источнике
  'playlist/qaWithFail000000000000': () => derive('spotify-embed-playlist.html', (e) => {
    e.name = 'QA Spotify Fail'; e.title = e.name;
    const t = e.trackList.slice(0, 3);
    t[1] = { ...t[1], title: 'QA FAIL Song Nobody Has', subtitle: 'QA Nobody', uri: 'spotify:track:0000000000000000000qaF', uid: 'qafail' };
    e.trackList = t;
  }),
};

export function startFakeSpotify(port, logFile) {
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/embed\/((?:playlist|album|track)\/[A-Za-z0-9]+)/);
    const page = m && SPOTIFY_PAGES[m[1]];
    if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ ts: Date.now(), url: req.url, status: page ? 200 : 404 }) + '\n'); } catch { /* ignore */ }
    if (!page) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><body>Page not found</body></html>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
