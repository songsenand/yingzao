import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

// 1. select v008 → params appear IMMEDIATELY (within 500ms)
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('v008'))?.click(); });
await new Promise(r => setTimeout(r, 600));
const paramsFast = await page.evaluate(() => document.body.innerText.includes('参数 (3)'));
console.log('1. params visible within 600ms of selection:', paramsFast);

// 2. buttons BELOW viewport: check DOM order — toolbar buttons should come after the canvas
const order = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const shotBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话'));
  if (!canvas || !shotBtn) return { ok: false };
  return { ok: !!(canvas.compareDocumentPosition(shotBtn) & Node.DOCUMENT_POSITION_FOLLOWING) };
});
console.log('2. toolbar below viewport:', order.ok);

// 3+4. annotation: draw 2 non-overlapping boxes → different colors; draw overlapping → rejected
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('标注问题区域'))?.click(); });
await new Promise(r => setTimeout(r, 300));
const overlay = await page.$('[style*="crosshair"]');
const bb = await overlay.boundingBox();
const drag = async (fx, fy, tx, ty) => {
  await page.mouse.move(bb.x + bb.width * fx, bb.y + bb.height * fy);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * tx, bb.y + bb.height * ty, { steps: 5 });
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 300));
};
await drag(0.05, 0.05, 0.35, 0.35);   // box 1 top-left
await drag(0.55, 0.55, 0.9, 0.9);     // box 2 bottom-right (non-overlap)
const two = await page.evaluate(() => document.body.innerText.includes('↩ 撤销'));
await drag(0.3, 0.3, 0.5, 0.5);       // overlaps both → rejected
const state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('div')].filter(d => (d.style.borderColor || '').includes('rgb'));
  const colors = [...new Set(boxes.map(d => d.style.borderColor))];
  const hint = [...document.querySelectorAll('span')].some(s => /重叠/.test(s.textContent ?? ''));
  return { boxes: boxes.length, colors, overlapRejected: hint };
});
console.log('3. overlap rejected:', state.overlapRejected, '| boxes kept:', state.boxes);
console.log('4. distinct colors:', JSON.stringify(state.colors));
// tray note + time
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('截图到会话'))?.click(); });
await new Promise(r => setTimeout(r, 1500));
const tray = await page.evaluate(() => {
  const hasTime = /\d{2}:\d{2}:\d{2}/.test(document.body.innerText);
  const noteInput = !!document.querySelector('input[placeholder*="备注"], input[placeholder*="说明"]');
  return { hasTime, noteInput };
});
console.log('5. tray has time:', tray.hasTime, '| note input:', tray.noteInput);
await page.screenshot({ path: 'shots/ux5-final.png' });
await browser.close();
