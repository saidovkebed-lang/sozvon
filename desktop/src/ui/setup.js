'use strict';
(async () => {
  const api = window.sozvonSetup;
  const $ = (id) => document.getElementById(id);
  const url = $('url'); const status = $('status'); const cert = $('cert'); const trust = $('trust');
  const st = await api.getState();
  url.value = st.serverUrl || st.defaultServer;
  $('useDefault').textContent = st.defaultServer;
  $('useDefault').onclick = () => { url.value = st.defaultServer; reset(); };
  if (!st.firstRun) { $('title').textContent = 'Сервер Созвона'; $('lead').textContent = 'Сменить сервер, к которому подключается приложение.'; }
  else $('cancel').textContent = 'Выход';

  let checked = null;
  function reset() { checked = null; cert.classList.remove('show'); trust.checked = false; setStatus(''); }
  function setStatus(text, kind) { status.textContent = text; status.className = `status ${kind || ''}`; }
  function busy(v) { for (const b of ['check', 'save']) $(b).disabled = v; }
  url.addEventListener('input', reset);

  async function check() {
    busy(true); setStatus('Проверяем…');
    try {
      const r = await api.check(url.value, trust.checked);
      if (r.ok) {
        cert.classList.remove('show');
        setStatus(r.insecure ? 'Сервер найден, но соединение без шифрования (http). Подходит только для домашней сети.' : 'Сервер найден ✓', r.insecure ? 'warn' : 'ok');
        checked = r.origin; return r;
      }
      if (r.cert) {
        cert.classList.add('show');
        $('certInfo').textContent = `${r.cert.host} · ${r.cert.error || ''}\nВыдан: ${r.cert.issuer || '?'}\nОтпечаток: ${r.cert.fingerprint || '?'}`;
        setStatus('Сертификат не подтверждён. Отметьте «Я доверяю…» и нажмите «Проверить» ещё раз.', 'warn');
      } else {
        setStatus(r.error || 'Не получилось', 'err');
      }
      checked = null; return r;
    } finally { busy(false); }
  }
  $('check').onclick = check;
  $('cancel').onclick = () => api.cancel();
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const r = checked ? { ok: true } : await check();
    if (!r.ok) return;
    busy(true); setStatus('Подключаемся…');
    const s = await api.save(url.value);
    if (!s.ok) { busy(false); setStatus(s.error || 'Не получилось', 'err'); }
  };
  url.focus(); url.select();
})();
