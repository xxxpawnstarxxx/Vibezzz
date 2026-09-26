// Enemy grapple check: one Knight with grapple chance 1 next to the player.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
p.on('pageerror', e => console.log('pageerror:', e.message, (e.stack || '').split('\n')[1]));
await p.goto(url + '?nolock');
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#credit-btn,#hs-hint').forEach(e => e.remove()); });
await p.waitForTimeout(3000);
await p.keyboard.press('h');
await p.waitForTimeout(12000);
await p.evaluate(() => {
  const a = window.__vibezzz; const d = [...a.dummies.values()][0];
  d.ai.settings = { ...d.ai.settings, aggression: 1, grapple: 1, blockSkill: 0 };
  const me = a.agents.get(a.playerId).agent; const mp = me.getPosition();
  const ag = a.agents.get(d.id).agent;
  ag.resetTo([mp[0] + a.hsHeading.x * 1.0, 0, mp[2] + a.hsHeading.z * 1.0], [-a.hsHeading.x, 0, -a.hsHeading.z]);
});
const st = (t) => p.evaluate((t) => { const a = window.__vibezzz; const d = [...a.dummies.values()][0]; const me = a.combat.fighters.get(a.playerId);
  return `${t} ${d.ai.currentState} grab=${d.ai.grabber?.status("Left") || '-'}/${d.ai.grabber?.status('Right') || '-'} myArmed=${a.halfSword.armed} grabbedBy=${me.grabbedBy || 0} hint=${document.getElementById('grabbed-hint').className} ev=${JSON.stringify((window.__events || []).slice(-4))}`; }, t);
for (let i = 0; i < 10; i++) {
  await p.evaluate(() => { const d = [...window.__vibezzz.dummies.values()][0];
    if (d.ai.stage !== "grapple" && !d.ai.grabber.holds.Left) { d.ai.grappleSide = "Left"; d.ai.grappleYank = 0; d.ai.enter("grapple", 2.4); } });
  await p.waitForTimeout(8000);
  console.log(await st('t' + i));
  if (i === 4) await p.screenshot({ path: `${out}_grapple.png` });
}
await b.close();
