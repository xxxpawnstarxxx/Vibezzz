// Headless grab check: drop + pick up a sword, walk in, grab the dummy (Q),
// yank. Prints state after each step and screenshots.
// usage: node tools/preview/grab.mjs <url> <outPrefix>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
let n = 0; p.on('console', m => { const t = m.text(); if (!/vite|GPU stall|experimental|404|deprecated/.test(t) && n++ < 12) console.log('console:', t.slice(0, 300)); });
p.on('pageerror', e => { if (n++ < 12) console.log('pageerror:', e.message, e.stack?.split('\n')[1]); });
await p.goto(url + (url.includes('?') ? '&' : '?') + 'nolock');
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#credit-btn').forEach(e => e.remove()); });
await p.waitForTimeout(10000);
await p.keyboard.press('h');
await p.waitForTimeout(12000);
const state = (tag) => p.evaluate((tag) => {
  const a = window.__vibezzz; const hs = a.halfSword; const g = a.grabber;
  const d = [...a.dummies.values()][0]; const df = a.combat.fighters.get(d.id);
  return tag + ' armed=' + hs.armed + ' L=' + (g?.status('Left') || '-') + ' R=' + (g?.status('Right') || '-') + ' items=' + a.items.length + ' dummy=' + d.ai.currentState + ' dArmed=' + d.sword.armed + ' dHP=' + df.health.toFixed(0) + ' grabbedBy=' + (df.grabbedBy||0) + ' hint=' + document.querySelector('#hs-hint .grip').textContent + ' ver=' + document.getElementById('app-version').textContent;
}, tag);
const frame = async (name, off = [2.2, 1.5, 1.4]) => {
  await p.evaluate(([f, u, r]) => {
    const a = window.__vibezzz; const pos = a.agents.get(a.playerId).agent.getPosition();
    const hs = a.halfSword; const fw = hs.bodyForward; const rt = hs.bodyRight;
    a.controls.target.set(pos[0], pos[1] + 0.9, pos[2]);
    a.camera.position.set(pos[0] + fw.x * f + rt.x * r, pos[1] + u, pos[2] + fw.z * f + rt.z * r); a.controls.update();
  }, off);
  await p.waitForTimeout(3600);
  await p.screenshot({ path: `${out}_${name}.png` });
};
// Make the dummy passive so the test is deterministic.
await p.evaluate(() => { for (const d of window.__vibezzz.dummies.values()) d.ai.settings.fightsBack = false; });
console.log(await state('start'));
await p.keyboard.press('f');
await p.waitForTimeout(6000);
console.log(await state('dropped'));
await p.keyboard.down('e');
await p.waitForTimeout(10000);
console.log(await state('E held (pickup)'));
await frame('pickup', [1.8, 1.2, 1.6]);
await p.keyboard.up('e');
await p.waitForTimeout(2000);
// Walk up to the dummy.
await p.evaluate(() => {
  const a = window.__vibezzz; const d = [...a.dummies.values()][0];
  const dp = a.agents.get(d.id).agent.getPosition(); const me = a.agents.get(a.playerId).agent;
  const mp = me.getPosition(); const dx = dp[0] - mp[0], dz = dp[2] - mp[2], l = Math.hypot(dx, dz);
  me.resetTo([dp[0] - dx / l * 0.8, 0, dp[2] - dz / l * 0.8], [dx / l, 0, dz / l]);
});
await p.waitForTimeout(4000);
await p.keyboard.down('q');
await p.waitForTimeout(8000);
console.log(await state('Q held (grab)'));
await frame('grab');
// Yank with the mouse (LMB aims the left hand) + walk back to drag.
await p.mouse.move(500, 350);
await p.mouse.down({ button: 'left' });
for (let i = 0; i < 6; i++) { await p.mouse.move(500 - i * 40, 350 + i * 10); await p.waitForTimeout(400); }
await p.keyboard.down('s'); await p.waitForTimeout(6000); await p.keyboard.up('s');
console.log(await state('dragged/yanked'));
await frame('drag');
await p.mouse.up({ button: 'left' });
await p.keyboard.up('q');
await b.close();
