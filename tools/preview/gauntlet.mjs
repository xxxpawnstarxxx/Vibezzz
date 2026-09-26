// Headless gauntlet check: start, watch wave 1, force-clear it, watch wave 2
// (director tokens + surround), print AI states and events, screenshot.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1100, height: 720 } });
p.on('pageerror', e => console.log('pageerror:', e.message, (e.stack || '').split('\n')[1]));
await p.goto(url + '?nolock');
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#credit-btn,#hs-hint').forEach(e => e.remove()); });
await p.waitForTimeout(3000);
await p.keyboard.press('h');
await p.waitForTimeout(3000);
await p.evaluate(() => window.__vibezzz.startGauntlet());
const state = (tag) => p.evaluate((tag) => {
  const a = window.__vibezzz; const me = a.combat.fighters.get(a.playerId); const mp = me.agent.getPosition();
  const es = [...a.dummies.values()].map(d => { const f = a.combat.fighters.get(d.id); const q = a.agents.get(d.id).agent.getPosition();
    return `${f.label}[hp ${f.health.toFixed(0)} ${d.ai.currentState}${d.ai.orders.canAttack ? ' TOKEN' : ''} d=${Math.hypot(q[0]-mp[0], q[2]-mp[2]).toFixed(1)} ang=${(Math.atan2(q[0]-mp[0], q[2]-mp[2])*57.3).toFixed(0)}${f.dead ? ' DEAD' : ''}]`; });
  return `${tag} ver=${document.getElementById('app-version').textContent} wave=${a.gauntlet.wave + 1} ${a.gauntlet.phase} me hp=${me.health.toFixed(0)} armed=${a.halfSword.armed} grabbedBy=${me.grabbedBy || 0} | ${es.join(' ')} | ${document.getElementById('wave-label').textContent}`;
}, tag);
const cam = async () => p.evaluate(() => { const a = window.__vibezzz; const pos = a.agents.get(a.playerId).agent.getPosition();
  a.controls.target.set(pos[0], 1.0, pos[2]); a.camera.position.set(pos[0] - a.hsHeading.x * 3.6 + 1.2, 2.6, pos[2] - a.hsHeading.z * 3.6 + 0.8); a.controls.update(); });
for (let i = 0; i < 4; i++) { await p.waitForTimeout(15000); console.log(await state('w1 t' + i)); }
await cam(); await p.waitForTimeout(1500); await p.screenshot({ path: `${out}_w1.png` });
// Force-clear wave 1.
await p.evaluate(() => { const a = window.__vibezzz; for (const d of a.dummies.values()) { const f = a.combat.fighters.get(d.id); f.health = 0; f.downTime = 3.5; f.dead = true; } });
await p.waitForTimeout(50000);
for (let i = 0; i < 4; i++) { await p.waitForTimeout(15000); console.log(await state('w2 t' + i)); }
await cam(); await p.waitForTimeout(1500); await p.screenshot({ path: `${out}_w2.png` });
console.log('events', await p.evaluate(() => JSON.stringify((window.__events || []).slice(-20))));
await b.close();
