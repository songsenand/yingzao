import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/cad|attach|draft|upload/i.test(t)) console.log('[console]', t.slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

// snapshot composer region fingerprint before click
const before = await page.evaluate(() => document.body.innerHTML.length);
const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话')));
await btn.asElement().click();
await new Promise(r => setTimeout(r, 2000));
const after = await page.evaluate(() => {
  // look for any element containing 'cad-' filename text or attachment rail
  const byFile = [...document.querySelectorAll('*')].some(el => el.childElementCount === 0 && /cad-v\d+.*\.png/.test(el.textContent ?? ''));
  const imgs = [...document.images].map(i => i.src.slice(0, 30));
  return { byFile, imgs: imgs.slice(0, 5), size: document.body.innerHTML.length };
});
console.log('dom delta:', after.size - before, 'filename chip:', after.byFile, 'images:', after.imgs);
// is there a draft rail at all? dump classes containing 'attach' or 'draft'
const rails = await page.evaluate(() => [...document.querySelectorAll('[class*="attach"],[class*="draft"],[class*="rail"]')].map(e => e.className.toString().slice(0, 60)).slice(0, 8));
console.log('draft-ish nodes:', rails);
await browser.close();
