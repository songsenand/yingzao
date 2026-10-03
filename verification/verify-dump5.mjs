import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/cad-harness/i.test(t)) console.log('[console]', t.slice(0, 160)); });
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(el => el.childElementCount === 0 && /讨论 DESIGN\.md/.test(el.textContent ?? ''));
  if (!el) return false;
  (el.closest('[role],button,li,div') ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
});
await new Promise(r => setTimeout(r, 5000));
await (await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话')))).asElement().click();
await new Promise(r => setTimeout(r, 2500));
const dump = await page.evaluate(() => {
  const textarea = document.querySelector('textarea');
  const composer = textarea ? textarea.closest('div[class]')?.parentElement?.parentElement : null;
  const region = composer ?? document.body;
  return {
    hasTextarea: !!textarea,
    regionClasses: composer?.className?.slice?.(0, 80) ?? null,
    regionText: region.innerText?.slice(0, 300),
    regionImgs: [...region.querySelectorAll('img')].map(i => i.src.slice(0, 40)),
    bodyHasCad: /cad-v\d+/.test(document.body.innerText),
  };
});
console.log(JSON.stringify(dump, null, 1));
await browser.close();
