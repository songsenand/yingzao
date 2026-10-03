import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/cad|error|fail/i.test(t)) console.log('[console]', t.slice(0, 250)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));
const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话')));
await btn.asElement().click();
await new Promise(r => setTimeout(r, 2000));
const state = await page.evaluate(() => {
  // panel error div (red text)
  const errs = [...document.querySelectorAll('div')].filter(d => d.childElementCount === 0 && d.style.color === 'rgb(192, 57, 43)').map(d => d.textContent);
  return { errs, domDelta: document.body.innerHTML.length };
});
console.log('panel errors:', state.errs);
// dump any element mentioning cad-*.png
const chips = await page.evaluate(() => [...document.querySelectorAll('*')].filter(el => /cad-v\d+/.test(el.textContent ?? '') && el.childElementCount === 0).map(e => e.textContent?.slice(0, 60)));
console.log('chips:', chips);
await browser.close();
