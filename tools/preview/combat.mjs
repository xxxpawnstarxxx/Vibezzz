// Headless combat check: enable Half Sword (spawns a dummy), swing at it,
// screenshot a few moments and print combat stats.
// usage: node tools/preview/combat.mjs <url> <outPrefix>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
let n = 0; p.on('console', m => { const t = m.text(); if (!/vite|GPU stall|experimental|404/.test(t) && n++ < 12) console.log('console:', t.slice(0, 300)); });
p.on('pageerror', e => { if (n++ < 12) console.log('pageerror:', e.message); });
await p.goto(url + (url.includes('?') ? '&' : '?') + 'nolock');
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#credit-btn,#hs-hint').forEach(e => e.remove()); });
await p.waitForTimeout(3000*2);
await p.keyboard.press('h');
const side = async () => p.evaluate(() => {
  const a = window.__vibezzz; const me = a.agents.get(a.playerId).agent.getPosition();
  const d = [...a.dummies.values()][0]; const dp = a.agents.get(d.id).agent.getPosition();
  const mx = (me[0] + dp[0]) / 2, mz = (me[2] + dp[2]) / 2;
  const dx = dp[0] - me[0], dz = dp[2] - me[2], l = Math.hypot(dx, dz) || 1;
  a.controls.target.set(mx, 1.1, mz);
  a.camera.position.set(mx - dz / l * 3.2, 1.6, mz + dx / l * 3.2); a.controls.update();
});
const shot = async (name) => { await side(); await p.waitForTimeout(250*2); await p.screenshot({ path: `${out}_${name}.png` }); };
const state = () => p.evaluate(() => { const a = window.__vibezzz; const d = [...a.dummies.values()][0]; return d.ai.currentState + ' style=' + a.agents.get(d.id).agent.style; });
await p.waitForTimeout(800*2);
console.log('t=0.8s', await state());
await shot('spawn');
await shot('start');
console.log('start', await state());
await p.mouse.move(500, 350);
await p.mouse.down({ button: 'right' });
await p.mouse.down({ button: 'left' });
const cuts = [
  // [windup dx, dy] then [strike dx, dy] in pixels: diagonal, rising, overhead, horizontal
  [[120, -260], [-260, 420]],
  [[140, 200], [-240, -380]],
  [[0, -300], [0, 460]],
  [[200, -40], [-420, 20]],
];
for (let k = 0; k < 6; k++) {
  const [[wx, wy], [sx, sy]] = cuts[k % cuts.length];
  let x = 500, y = 350;
  for (let i = 1; i <= 4; i++) { await p.mouse.move(x + wx * i / 4, y + wy * i / 4); await p.waitForTimeout(60*2); }
  x += wx; y += wy;
  await p.waitForTimeout(350*2);
  for (let i = 1; i <= 3; i++) { await p.mouse.move(x + sx * i / 3, y + sy * i / 3); await p.waitForTimeout(40*2); }
  x += sx; y += sy;
  if (k === 1 || k === 4) await shot(`swing${k}`);
  if (k === 5) { await p.keyboard.down('Space'); await p.waitForTimeout(500*2); await shot('thrust'); await p.keyboard.up('Space'); }
  await p.waitForTimeout(600*2);
  // Return the hands to the middle.
  for (let i = 1; i <= 3; i++) { await p.mouse.move(x - (wx + sx) * i / 3, y - (wy + sy) * i / 3); await p.waitForTimeout(60*2); }
  await p.mouse.move(500, 350);
}
await p.waitForTimeout(1500*2);
await shot('end');
console.log('stats', JSON.stringify(await p.evaluate(() => {
  const a = window.__vibezzz; const d = [...a.dummies.values()][0];
  return { ...a.combatStats, dummyState: d.ai.currentState, dummyHealth: a.combat.fighters.get(d.id).health, playerHealth: a.combat.fighters.get(a.playerId).health };
})));
await b.close();
