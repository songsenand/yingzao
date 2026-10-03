import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await ctxB_override(page, process.argv[2]);
await new Promise(r => setTimeout(r, 5000));

// select v008 (has params)
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('v008'))?.click(); });
await new Promise(r => setTimeout(r, 1200));
const paramsOpen = await page.evaluate(() => !!document.querySelector('input[type="range"]'));
console.log('params sliders visible (should be false, collapsed):', paramsOpen);

// open params, check sliders + apply button
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => /参数 \(3\)/.test(b.textContent))?.click(); });
await new Promise(r => setTimeout(r, 300));
const after = await page.evaluate(() => ({ ranges: document.querySelectorAll('input[type="range"]').length, apply: !!([...document.querySelectorAll('button')].find(b => b.textContent?.includes('应用为新版本'))) }));
console.log('params expanded:', after.ranges === 3, '| apply button:', after.apply);

// annotation two-phase: enter mode, draw box, verify box persists, verify tray empty until screenshot
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('标注问题区域'))?.click(); });
await new Promise(r => setTimeout(r, 300));
const overlay = await page.$('[style*="crosshair"]');
const box = await overlay.boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 6 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 500));
const persist = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('div')].filter(d => d.style.border?.includes('231, 76, 60') || d.style.borderColor === 'rgb(231, 76, 60)');
  return boxes.length;
});
console.log('committed red boxes visible after release:', persist);

// screenshot bakes boxes → tray appears
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话'))?.click(); });
await new Promise(r => setTimeout(r, 1200));
const trayState = await page.evaluate(() => {
  const label = [...document.querySelectorAll('div')].find(d => d.childElementCount === 2 && /上下文插入列表/.test(d.textContent));
  const thumbs = [...document.querySelectorAll('img')].filter(i => i.src.startsWith('data:image')).length;
  const copyBtn = !!([...document.querySelectorAll('button')].find(b => b.textContent?.includes('📋 复制')));
  return { hasTray: !!label, thumbs, copyBtn };
});
console.log('tray:', JSON.stringify(trayState));
await page.screenshot({ path: 'shots/ux-redesign.png' });
await browser.close();

async function ctxB_override(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
}
