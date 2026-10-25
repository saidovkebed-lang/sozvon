// Внешний вид: тема, масштаб шрифта, компактный режим, анимации. Применяется по подписке на prefs.
// Первичное применение (до отрисовки) делает /js/theme-boot.js — логика должна совпадать.
import { prefs } from '../prefs.js';
import { initCosmos } from './cosmos.js';
import { initServerTheme } from './server-theme.js';
import { initMotion } from './motion.js';

const THEME_COLORS = { dark: '#0c0e21', light: '#f2f3f5', amoled: '#000000' };

export function applyAppearance() {
  const html = document.documentElement;
  let theme = prefs.get('appearance.theme');
  if (!(theme in THEME_COLORS)) theme = 'dark';
  html.dataset.theme = theme;
  let scale = Number(prefs.get('appearance.fontScale'));
  if (!Number.isFinite(scale)) scale = 100;
  scale = Math.max(80, Math.min(130, scale));
  html.style.setProperty('--font-scale', String(scale / 100));
  if (prefs.get('appearance.compact')) html.dataset.compact = 'true';
  else delete html.dataset.compact;
  const rm = prefs.get('appearance.reduceMotion');
  if (rm === 'on' || rm === 'off') html.dataset.reduceMotion = rm;
  else delete html.dataset.reduceMotion;
  if (prefs.get('appearance.animatedBg') === false) html.dataset.animBg = 'off';
  else delete html.dataset.animBg;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'light' ? 'light' : 'dark');
}

export function initAppearance() {
  applyAppearance();
  prefs.subscribe('appearance.', applyAppearance);
  initCosmos(); // Astra 2.0: живой фон (звёзды) — пауза в фоне/при трансляциях/по настройке
  initServerTheme(); // Astra 2.0: акцент и фон открытого сервера
  initMotion();      // Astra 2.0: переход при смене канала
}
