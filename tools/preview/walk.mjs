// Drive the dev build: optionally walk, then frame the player from a given
// camera offset and screenshot.  node walk.mjs <url> <out> <holdKey|-> <ms> <dx,dy,dz> <lookY> [dist]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out, key, holdMs, off, lookY] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
let n = 0; p.on('console', m => { const t = m.text(); if (!/vite|GPU stall|experimental|404/.test(t) && n++ < 8) console.log('console:', t.slice(0, 300)); });
p.on('pageerror', e => { if (n++ < 8) console.log('pageerror:', e.message); });
await p.goto(url);
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#wasd-hint,#credit-btn').forEach(e => e.remove()); });
await p.waitForTimeout(8000);
if (key !== '-') { await p.keyboard.down(key); await p.waitForTimeout(+holdMs); }
const [dx, dy, dz] = off.split(',').map(Number);
for (let i = 0; i < 2; i++) {
  await p.evaluate(([dx, dy, dz, ly]) => {
    const a = window.__vibezzz; const pl = a.agents.get(a.playerId).agent;
    const pos = pl.getPosition(); const f = pl.actor ? null : null;
    a.controls.target.set(pos[0], pos[1] + ly, pos[2]);
    a.camera.position.set(pos[0] + dx, pos[1] + dy, pos[2] + dz);
    a.controls.update();
  }, [dx, dy, dz, +lookY]);
  await p.waitForTimeout(1500);
}
await p.screenshot({ path: out });
await b.close();
