// Headless stuck-blade check: thrust into a passive dummy at close range,
// then pull back. usage: node tools/preview/stuck.mjs <url> <outPrefix>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.goto(url + '?nolock');
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#credit-btn,#hs-hint').forEach(e => e.remove()); });
await p.waitForTimeout(3000);
await p.keyboard.press('h');
await p.waitForTimeout(6000);
await p.evaluate(() => {
  const a = window.__vibezzz; const d = [...a.dummies.values()][0];
  a.dropSword(a.combat.fighters.get(d.id));
  d.ai.update = () => {};              // frozen target
  a.agents.get(d.id).agent.setGoal([0, 0, 0], [0, 0, 1]);
  for (const it of a.items) it.cooldown = 1e9;
  const dp = a.agents.get(d.id).agent.getPosition(); const me = a.agents.get(a.playerId).agent;
  const mp = me.getPosition(); const dx = dp[0] - mp[0], dz = dp[2] - mp[2], l = Math.hypot(dx, dz);
  me.resetTo([dp[0] - dx / l * 1.3, 0, dp[2] - dz / l * 1.3], [dx / l, 0, dz / l]);
  a.hsHeading.set(dx / l, 0, dz / l);
});
await p.waitForTimeout(5000);
const st = (t) => p.evaluate((t) => { const a = window.__vibezzz; const ps = [...a.combat.fighters.values()].map(f => f.agent.getPosition()); return t + ' dist=' + Math.hypot(ps[0][0]-ps[1][0], ps[0][2]-ps[1][2]).toFixed(2) + ' ' + JSON.stringify(a.combatStats) + ' stuckNow=' + a.combat.stuck.length + ' dHP=' + [...a.combat.fighters.values()].map(f => f.id + ':' + f.health.toFixed(0)).join(','); }, t);
await p.mouse.move(500, 350);
await p.mouse.down({ button: 'right' }); await p.mouse.down({ button: 'left' });
await p.waitForTimeout(3000);
for (let i = 0; i < 4; i++) { await p.mouse.move(500, 350 + i * 12); await p.waitForTimeout(300); }
await p.waitForTimeout(2500);
console.log(await st('on line'));
for (let k = 0; k < 3; k++) {
  await p.keyboard.down('Space'); await p.waitForTimeout(2500);
  console.log(await st('thrust' + k));
  if (k === 0) await p.screenshot({ path: `${out}_thrust.png` });
  await p.keyboard.up('Space'); await p.waitForTimeout(600);
  // Pull back hard + wiggle.
  for (let i = 0; i < 8; i++) { await p.mouse.move(500 + (i % 2 ? 60 : -60), 350 + i * 25); await p.waitForTimeout(300); }
  await p.mouse.move(500, 386);
  await p.waitForTimeout(2500);
  console.log(await st('after pull' + k));
}
await p.screenshot({ path: `${out}_end.png` });
console.log(await p.evaluate(() => JSON.stringify(window.__events)));
await b.close();
