import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
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
// scroll composer into view and capture the bottom of the middle column
await page.evaluate(() => { const t = document.querySelector('textarea,[contenteditable="true"]'); t?.scrollIntoView({ block: 'center' }); });
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: 'shots/draft-visible.png' });
console.log('captured');
await browser.close();
