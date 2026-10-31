// Headless AR smoke test with a mocked WebXR device (floor + wall, hit tests).
// Usage: npm run build && npx vite preview --port 4173 & node tests/ar-smoke.cjs
// Needs Playwright with Chromium available.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'xr-mock.js'), 'utf8') });
  await page.goto(process.env.URL ?? 'http://localhost:4173/?debug');
  await page.click('#btn-ar');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    await page.evaluate((i) => window.__xrPose(Math.sin(i * 0.4) * 0.5, -0.75), i);
  }
  const roaches = await page.evaluate(() => window.__roaches());
  console.log((await page.textContent('#debug')).replace(/\n/g, ' | '));
  await browser.close();
  if (errors.length || roaches < 4) {
    console.error('FAIL', { roaches, errors });
    process.exit(1);
  }
  console.log('OK', { roaches });
})();
