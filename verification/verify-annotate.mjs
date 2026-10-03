// M3.5 verification: buttons exist, screenshot creates a draft attachment chip
// in the composer, annotation mode draws a rect and inserts an annotated image.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const url = process.argv[2];
mkdirSync('shots', { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话')));
console.log('screenshot button found:', !!btn && !(await btn.evaluate?.(b => b == null)));

// click screenshot → draft attachment (image chip) should appear in composer area
await btn.asElement().click();
await new Promise(r => setTimeout(r, 1500));

const afterShot = await page.evaluate(() => {
  const text = document.body.innerText;
  return { hasChip: !!document.querySelector('img[src^="blob:"]') || text.includes('.png'), text: text.slice(0, 200) };
});
console.log('after screenshot click, blob img in DOM:', afterShot.hasChip);
await page.screenshot({ path: 'shots/annotate-1-screenshot.png' });

// annotation mode: drag a rect over the viewport
const annBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('标注问题区域')));
await annBtn.asElement().click();
await new Promise(r => setTimeout(r, 300));
const overlay = await page.$('[style*="crosshair"]');
console.log('annotation overlay present:', !!overlay);
if (overlay) {
  const box = await overlay.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 1500));
  }
}
const afterAnn = await page.evaluate(() => !!document.querySelector('img[src^="blob:"]'));
console.log('after annotation drag, blob img in DOM:', afterAnn);
await page.screenshot({ path: 'shots/annotate-2-final.png' });
console.log('pageerrors:', errors.length, errors.slice(0, 3));
await browser.close();
