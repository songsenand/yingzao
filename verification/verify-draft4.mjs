import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/cad-harness/i.test(t)) console.log('[console]', t.slice(0,150)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

// select the existing session in the sidebar
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(el => el.childElementCount === 0 && /讨论 DESIGN\.md/.test(el.textContent ?? ''));
  if (!el) return false;
  (el.closest('[role],button,li,div') ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
});
console.log('session clicked:', clicked);
await new Promise(r => setTimeout(r, 6000));

// screenshot → draft
const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话')));
await btn.asElement().click();
await new Promise(r => setTimeout(r, 2500));

const result = await page.evaluate(() => {
  const blobImgs = [...document.querySelectorAll('img')].filter(i => i.src.startsWith('blob:')).length;
  const chipText = [...document.querySelectorAll('*')].filter(el => el.childElementCount === 0 && /cad-v\d+.*\.png/.test(el.textContent ?? '')).map(e => e.textContent);
  const errs = [...document.querySelectorAll('div')].filter(d => d.childElementCount === 0 && d.style.color === 'rgb(192, 57, 43)').map(d => d.textContent);
  return { blobImgs, chipText, errs: errs.slice(0, 2) };
});
console.log('blob images in DOM:', result.blobImgs, '| chips:', result.chipText, '| errors:', result.errs);
await page.screenshot({ path: 'shots/draft-test.png' });
await browser.close();
