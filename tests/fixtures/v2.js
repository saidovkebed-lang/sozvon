// Хелперы для тестов v2 (настройки, громкость, шумоподавление). Селекторы — контракт с ui:
//   #modal-user-settings, button[data-section=..], [data-panel=..], button.settings__close[data-close],
//   контролы [data-pref="<ключ prefs>"], радио input[type=radio][data-pref][value],
//   .context-menu input[type=range][data-action="user-volume"], input[type=checkbox][data-action="mute-user"].
import { expect } from '@playwright/test';

export const SECTIONS = ['account', 'voice', 'appearance', 'notifications', 'keybinds', 'about'];

export async function readPrefs(page) {
  return page.evaluate(() => { try { return JSON.parse(localStorage.getItem('sozvon.prefs') || '{}'); } catch { return {}; } });
}

export async function openSettings(page) {
  const modal = page.locator('#modal-user-settings');
  if (await modal.isVisible()) return modal;
  // на мобиле user-panel внутри выезжающего меню
  const btn = page.locator('#btn-user-settings');
  if (await page.locator('#btn-menu').isVisible() && !(await page.locator('#app.is-nav-open').count())) {
    await page.locator('#btn-menu').click();
    await expect(page.locator('#app.is-nav-open')).toHaveCount(1);
    await page.waitForTimeout(350); // выезд меню
  }
  await btn.click();
  await expect(modal).toBeVisible();
  return modal;
}

export async function openSection(page, id) {
  const modal = await openSettings(page);
  const panel = modal.locator(`[data-panel="${id}"]`);
  const nav = modal.locator(`button[data-section="${id}"]`);
  const mobile = (page.viewportSize()?.width || 1440) < 640;
  if (mobile) {
    // на мобиле: либо список разделов, либо панель раздела (класс .is-section-open) + «назад»
    const sectionOpen = page.locator('#modal-user-settings.is-section-open, #modal-user-settings .is-section-open');
    if ((await sectionOpen.count()) && await panel.isVisible()) return panel;
    if (await sectionOpen.count()) {
      await modal.locator('.settings__back').click();
      await expect(sectionOpen).toHaveCount(0);
      await page.waitForTimeout(300);
    }
    await nav.click();
  } else if (!(await panel.isVisible())) {
    await nav.click();
  }
  await expect(panel).toBeVisible();
  if (mobile) await page.waitForTimeout(300);
  return panel;
}

export async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal-user-settings')).toBeHidden();
}

/** Выставить значение контрола настроек через UI (как пользователь). */
export async function setPrefUI(page, key, value) {
  const modal = page.locator('#modal-user-settings');
  const radio = modal.locator(`input[type="radio"][data-pref="${key}"][value="${value}"]`);
  if (await radio.count()) {
    // радио оформлено карточкой/label — кликаем как пользователь по label
    const r = radio.first();
    const label = r.locator('xpath=ancestor::label[1]');
    const id = await r.getAttribute('id');
    if (await label.count()) await label.click();
    else if (id && await modal.locator(`label[for="${id}"]`).count()) await modal.locator(`label[for="${id}"]`).first().click();
    else await r.check({ force: true });
    await expect(r, `радио ${key}=${value} выбрано`).toBeChecked();
    return;
  }
  const el = modal.locator(`[data-pref="${key}"]`).first();
  await expect(el, `контрол data-pref=${key}`).toHaveCount(1);
  const tag = await el.evaluate((n) => n.tagName.toLowerCase() + ':' + (n.type || ''));
  if (tag.startsWith('select')) await el.selectOption(String(value));
  else if (tag === 'input:checkbox') await el.setChecked(!!value, { force: !(await el.isVisible()) });
  else if (tag === 'input:range' || tag.startsWith('input')) await el.fill(String(value));
  else throw new Error(`не знаю, как выставить ${key} (${tag})`);
}

/** Захват клавиши кнопкой [data-pref=key]: клик → нажатие сочетания. */
export async function captureKeyUI(page, key, combo) {
  const btn = page.locator(`#modal-user-settings button[data-pref="${key}"]`);
  await btn.click();
  await page.keyboard.press(combo);
}

/** Перехват всех RTCPeerConnection на странице (не зависит от внутренностей rtc.js). */
export async function trackPeerConnections(page) {
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    window.__qaPcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__qaPcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Orig.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Orig);
  });
}

/** Сумма bytesReceived / max audioLevel входящего аудио по всем живым pc. */
export async function inboundAudio(page) {
  return page.evaluate(async () => {
    let bytes = 0; let level = 0; let states = [];
    for (const pc of window.__qaPcs || []) {
      if (pc.connectionState === 'closed') continue;
      states.push(pc.connectionState);
      const st = await pc.getStats();
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
          bytes += r.bytesReceived || 0;
          level = Math.max(level, r.audioLevel || 0);
        }
      });
    }
    return { bytes, level, states };
  });
}

export async function livePcStates(page) {
  return page.evaluate(() => (window.__qaPcs || []).filter((p) => p.connectionState !== 'closed').map((p) => p.connectionState));
}

/** Время, когда атрибут data-theme был на <html> в момент вставки <body> и на DOMContentLoaded. */
export async function recordEarlyTheme(page) {
  await page.addInitScript(() => {
    window.__qaTheme = {};
    const mo = new MutationObserver(() => {
      if (document.body && !('atBody' in window.__qaTheme)) {
        window.__qaTheme.atBody = document.documentElement.getAttribute('data-theme');
        mo.disconnect();
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { window.__qaTheme.atDCL = document.documentElement.getAttribute('data-theme'); });
  });
}
