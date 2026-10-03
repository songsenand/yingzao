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
// select v008 chip
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('v008'));
  chip?.click();
});
await new Promise(r => setTimeout(r, 1500));
const sliders = await page.evaluate(() => {
  const ranges = [...document.querySelectorAll('input[type="range"]')];
  const numbers = [...document.querySelectorAll('input[type="number"]')];
  return { ranges: ranges.length, numbers: numbers.length, values: numbers.map(n => n.value) };
});
console.log('param sliders:', sliders.ranges, '| number inputs:', sliders.numbers, '| values:', sliders.values.join(','));
// drag first slider
if (sliders.ranges > 0) {
  const handle = await page.$('input[type="range"]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 1500));
  const img = await page.evaluate(() => !!document.querySelector('img[src^="blob:"]'));
  console.log('preview image after slider drag:', img);
}
await page.screenshot({ path: 'shots/params-panel.png' });
await browser.close();
