// Замер нагрузки на процессор (не входит в обычный прогон): PERF=1 npx playwright test tests/perf.spec.js
// Две вкладки в голосовом канале: (1) просто разговор, (2) A показывает экран 1080p60, B смотрит.
// Метрика — процессорное время главного потока страницы (CDP Performance.TaskDuration) за 10 с.
import fs from 'node:fs';
import os from 'node:os';
import { test, twoUsersOneServer, joinVoiceUI, startScreenShare } from './fixtures/ui.js';

/** Суммарное процессорное время всех процессов Chromium (тики), Linux /proc */
function chromeTicks() {
  let sum = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const comm = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
      if (!/chrom|headless_shell/i.test(comm)) continue;
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      sum += Number(f[11]) + Number(f[12]); // utime + stime
    } catch { /* процесс завершился */ }
  }
  return sum;
}
const HZ = 100;

test.skip(!process.env.PERF, 'замер нагрузки — только с PERF=1');

async function cpu(page) {
  const s = await page.context().newCDPSession(page);
  await s.send('Performance.enable');
  return async () => {
    const m = Object.fromEntries((await s.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    return m.TaskDuration;
  };
}

async function measure(pages, ms = 10000) {
  const probes = await Promise.all(pages.map(cpu));
  const t0 = await Promise.all(probes.map((p) => p()));
  const c0 = chromeTicks();
  await new Promise((r) => setTimeout(r, ms));
  const c1 = chromeTicks();
  const t1 = await Promise.all(probes.map((p) => p()));
  const main = t1.map((v, i) => Math.round(((v - t0[i]) / (ms / 1000)) * 1000) / 10); // % ядра, главный поток
  const total = Math.round(((c1 - c0) / HZ / (ms / 1000)) * 1000) / 10; // % ядра, все процессы Chromium
  return { main, total };
}

test('нагрузка: голос и трансляция', async ({ makePage }) => {
  test.setTimeout(180000);
  const { pa, pb } = await twoUsersOneServer(makePage, 'Замер');
  for (const p of [pa, pb]) {
    if (process.env.PERF_RM) await p.emulateMedia({ reducedMotion: 'reduce' });
    if (process.env.PERF_NS) await p.evaluate(async (ns) => (await import('/js/prefs.js')).prefs.set('audio.noiseSuppression', ns), process.env.PERF_NS);
  }
  await joinVoiceUI(pa);
  await joinVoiceUI(pb);
  await pa.locator('.tile[data-connected="true"]').first().waitFor({ timeout: 20000 });
  await pa.waitForTimeout(3000);
  const voice = await measure([pa, pb]);
  await startScreenShare(pa, '1080p60');
  await pb.locator('.tile--screen').waitFor({ timeout: 20000 });
  // если зритель должен нажать «Смотреть» — нажимаем (новая логика)
  const watch = pb.locator('.tile--screen .tile__watch');
  if (!process.env.PERF_NOWATCH && await watch.count()) await watch.click();
  await pb.waitForTimeout(3000);
  const stream = await measure([pa, pb]);
  const line = `ГОЛОС: всего ${voice.total}% (гл.поток A ${voice.main[0]}% B ${voice.main[1]}%) | ТРАНСЛЯЦИЯ 1080p60: всего ${stream.total}% (гл.поток A ${stream.main[0]}% B ${stream.main[1]}%) — % одного ядра, ядер: ${os.cpus().length}`;
  console.log(line);
  test.info().annotations.push({ type: 'perf', description: line });
});
