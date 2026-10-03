import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const ctxB = browser.defaultBrowserContext();
await ctxB.overridePermissions(process.argv[2].split('/?')[0], ['clipboard-write', 'clipboard-read', 'clipboard-sanitized-write']);
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));
const annBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('标注问题区域')));
await annBtn.asElement().click();
await new Promise(r => setTimeout(r, 300));
const overlay = await page.$('[style*="crosshair"]');
const box = await overlay.boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.55, { steps: 10 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 2000));
const state = await page.evaluate(() => {
  const hints = [...document.querySelectorAll('div')].filter(d => d.childElementCount === 0 && d.style.color === 'rgb(39, 174, 96)').map(d => d.textContent);
  return { hints: hints.slice(0, 2) };
});
console.log('hint:', state.hints);
await page.screenshot({ path: 'shots/annotate-final.png' });
const clip = await page.evaluate(async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) if (item.types.includes('image/png')) return 'image/png in clipboard';
    return 'no image: ' + items.map(i => i.types.join(',')).join(';');
  } catch (e) { return 'clipboard read denied: ' + e.message.slice(0, 60); }
});
console.log('clipboard:', clip);
await browser.close();
