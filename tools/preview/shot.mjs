import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
// usage: node tools/preview/shot.mjs http://127.0.0.1:5173/tools/preview/preview.html out.png "solo=1&pose=1"
const [,, base, out, qs, w, h] = process.argv;
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: +(w||900), height: +(h||900) } });
p.on('console', m => console.log('console:', m.text()));
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.goto(`${base}?${qs||''}`);
await p.waitForFunction(() => document.title === 'ready', null, { timeout: 60000 });
await p.screenshot({ path: out });
await b.close();
