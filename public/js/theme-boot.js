// Применяет внешний вид из prefs ДО первой отрисовки (подключается блокирующим <script> в <head>),
// чтобы не было «мигания» тёмной темы. Ключи — те же, что в js/prefs.js (appearance.*).
// Дальнейшие изменения на лету применяет js/ui/appearance.js по подписке на prefs.
(function () {
  var p = {};
  try { p = JSON.parse(localStorage.getItem('sozvon.prefs') || '{}') || {}; } catch (e) { p = {}; }
  var html = document.documentElement;
  try { if (window.sozvonDesktop && window.sozvonDesktop.isDesktop) html.classList.add('is-desktop'); } catch (e) { /* нет моста */ }
  var theme = p['appearance.theme'];
  if (theme !== 'light' && theme !== 'amoled') theme = 'dark';
  html.setAttribute('data-theme', theme);
  var scale = Number(p['appearance.fontScale']);
  if (!isFinite(scale) || scale < 80 || scale > 130) scale = 100;
  html.style.setProperty('--font-scale', String(scale / 100));
  if (p['appearance.compact'] === true) html.setAttribute('data-compact', 'true');
  var rm = p['appearance.reduceMotion'];
  if (rm === 'on' || rm === 'off') html.setAttribute('data-reduce-motion', rm);
  var colors = { dark: '#12151b', light: '#f2f3f5', amoled: '#000000' };
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colors[theme]);
  var cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', theme === 'light' ? 'light' : 'dark');
})();
