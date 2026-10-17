'use strict';
const q = new URLSearchParams(location.search);
document.getElementById('url').textContent = q.get('url') || 'сервер';
document.getElementById('err').textContent = q.get('error') || '';
document.getElementById('retry').onclick = () => window.sozvonSetup.retry();
document.getElementById('server').onclick = () => window.sozvonSetup.openServerSettings();
let left = 15;
setInterval(() => {
  left -= 1;
  if (left <= 0) { left = 15; window.sozvonSetup.retry(); }
  document.getElementById('sec').textContent = String(left);
}, 1000);
