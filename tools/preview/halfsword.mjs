// Headless Half Sword check: toggles the mode, drives the mouse, screenshots.
// usage: node tools/preview/halfsword.mjs <url> <outPrefix>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const [,, url, out] = process.argv;
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-watchdog'] });
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
let n = 0; p.on('console', m => { const t = m.text(); if (!/vite|GPU stall|experimental|404/.test(t) && n++ < 10) console.log('console:', t.slice(0, 300)); });
p.on('pageerror', e => { if (n++ < 10) console.log('pageerror:', e.message); });
await p.goto(url + (url.includes('?') ? '&' : '?') + 'nolock');
await p.waitForFunction(() => window.__vibezzz && document.getElementById('boot').style.display === 'none', null, { timeout: 90000 });
await p.evaluate(() => { document.querySelector('.tp-dfwv')?.remove(); document.querySelector('.stats-gl')?.remove(); document.querySelectorAll('.joystick-base,#credit-btn').forEach(e => e.remove()); });
await p.waitForTimeout(4000);
await p.keyboard.press('h');
await p.waitForTimeout(500);
// Heading = camera forward at the moment the mode was enabled.
const heading = await p.evaluate(() => { const c = window.__vibezzz.camera, e = c.matrixWorld.elements; const x = -e[8], z = -e[10], l = Math.hypot(x, z); return [x / l, z / l]; });
// off = [forward, up, right] in the fighter's frame.
const frame = async (name, off) => {
  await p.evaluate(([f, u, r, hx, hz]) => {
    const a = window.__vibezzz; const pos = a.agents.get(a.playerId).agent.getPosition();
    const rx = -hz, rz = hx; // right = fwd × up
    a.controls.target.set(pos[0], pos[1] + 1.1, pos[2]);
    a.camera.position.set(pos[0] + hx * f + rx * r, pos[1] + u, pos[2] + hz * f + rz * r); a.controls.update();
  }, [...off, ...heading]);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}_${name}.png` });
};
await p.waitForTimeout(3000);
await frame('relaxed', [2.2, 1.5, 1.2]);
await p.mouse.move(500, 400);
await p.mouse.down({ button: 'right' });
for (let i = 0; i < 10; i++) { await p.mouse.move(500 + i * 8, 400 - i * 12); await p.waitForTimeout(80); }
await p.waitForTimeout(1500);
await frame('onehand', [2.2, 1.5, -1.2]);
await p.mouse.down({ button: 'left' });
for (let i = 0; i < 10; i++) { await p.mouse.move(580 - i * 20, 280 + i * 4); await p.waitForTimeout(80); }
await p.waitForTimeout(1500);
await frame('twohand', [2.2, 1.5, -1.2]);
await p.keyboard.press('g');
await p.waitForTimeout(1500);
await frame('halfgrip', [0.3, 1.3, -2.6]);
await b.close();
