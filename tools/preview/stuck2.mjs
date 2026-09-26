// Stuck-blade constraint check (deterministic): pin the player's blade into
// a frozen dummy's chest, then (1) hold still, (2) wiggle, (3) pull straight
// back — print depth / strength / health, expect an "unstuck" event.
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
await p.waitForTimeout(8000);
await p.mouse.move(500, 380);
await p.mouse.down({ button: 'right' }); await p.mouse.down({ button: 'left' });
await p.waitForTimeout(6000);
await p.evaluate(() => {
  const a = window.__vibezzz; const d = [...a.dummies.values()][0];
  const T = a.combat.fighters.get(d.id); const me = a.combat.fighters.get(a.playerId);
  a.dropSword(T); d.ai.update = () => {}; a.agents.get(d.id).agent.setGoal([0, 0, 0], [0, 0, 1]);
  for (const it of a.items) it.cooldown = 1e9;
  { const dp = T.agent.getPosition(), m = me.agent; const mp = m.getPosition(); const dx = dp[0]-mp[0], dz = dp[2]-mp[2], l = Math.hypot(dx, dz);
    m.resetTo([dp[0]-dx/l*0.95, 0, dp[2]-dz/l*0.95], [dx/l, 0, dz/l]); a.hsHeading.set(dx/l, 0, dz/l); }
});
await p.waitForTimeout(15000);
const setup = await p.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const a = window.__vibezzz; const d = [...a.dummies.values()][0];
  const T = a.combat.fighters.get(d.id); const me = a.combat.fighters.get(a.playerId);
  a.dropSword(T); d.ai.update = () => {};
 a.agents.get(d.id).agent.setGoal([0, 0, 0], [0, 0, 1]);
  // Entry point: where the player's blade crosses 60% of its length.
  const g = new THREE.Vector3(), t = new THREE.Vector3();
  a.halfSword.bladeSegment(g, t);
  const bone0 = 0;
  const cap = T.capsules.find(c => c.region === 'body' && c.a.y > 1.0) ?? T.capsules[1];
  const mid = cap.a.clone().lerp(cap.b, 0.5);
  const toMe = new THREE.Vector3(...me.agent.getPosition()).setY(mid.y).sub(mid).normalize();
  const point = mid.clone().addScaledVector(toMe, cap.r);
  const w = T.agent.actor.worldMatrices;
  const bone = cap.bone; const local = point.clone().applyMatrix4(w[bone].clone().invert());
  const st = { attacker: me, target: T, bone, local, region: 'body', depth: 0.15, strength: 1, point: point.clone() };
  a.combat.stuck.push(st);
  a.halfSword.setStuck(point, 0.15);
  window.__st = st;
  return 'pinned at ' + point.toArray().map(v => v.toFixed(2));
});
console.log(setup);
const st = (tag) => p.evaluate((tag) => { const s = window.__st; const a = window.__vibezzz; const T = s.target;
  return tag + ' depth=' + s.depth.toFixed(3) + ' strength=' + s.strength.toFixed(2) + ' stuckNow=' + a.combat.stuck.length + ' HP=' + T.health.toFixed(1) + ' body=' + T.limbs.body.toFixed(1) + ' isStuck=' + a.halfSword.isStuck + ' ' + JSON.stringify((window.__events || []).slice(-3)); }, tag);
await p.waitForTimeout(6000);
console.log(await st('hold still'));
await p.screenshot({ path: `${out}_pinned.png` });
for (let i = 0; i < 16; i++) { await p.mouse.move(500 + (i % 2 ? 90 : -90), 380); await p.waitForTimeout(700); }
console.log(await st('wiggled'));
for (let i = 0; i < 10; i++) { await p.mouse.move(500, 380 + i * 30); await p.keyboard.down('s'); await p.waitForTimeout(1200); }
await p.keyboard.up('s');
console.log(await st('pulled back'));
await p.screenshot({ path: `${out}_freed.png` });
await b.close();
