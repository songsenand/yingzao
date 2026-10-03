// Headless browser verification for the M0 probe.
// Usage: node verify-m0.mjs <url-with-token> [outDir]
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.argv[2];
const outDir = resolve(process.argv[3] ?? 'shots');
if (!url) { console.error('usage: node verify-m0.mjs <url> [outDir]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '.chrome-cache/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',   // software WebGL
    '--use-angle=swiftshader',
    '--window-size=1600,1000',
  ],
  defaultViewport: { width: 1600, height: 1000 },
});

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

console.log('navigating…');
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 8000)); // panel boot + select + STL load

const full = `${outDir}/full.png`;
await page.screenshot({ path: full });

// Probe panel state.
const probe = await page.evaluate(() => {
  const text = document.body.innerText;
  const canvas = [...document.querySelectorAll('canvas')];
  let canvasInfo = null;
  const c = canvas[canvas.length - 1];
  if (c) {
    // Sample pixels to check the STL is actually drawn (not a blank clear).
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const g = off.getContext('2d');
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, off.width, off.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (!(d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235)) nonBg++;
    }
    canvasInfo = {
      count: canvas.length,
      size: [c.width, c.height],
      nonBackgroundPixelRatio: +(nonBg / (d.length / 4)).toFixed(4),
    };
  }
  const echoLine = text.split('\n').find(l => l.includes('RPC cad/echo')) ?? null;
  return {
    hasPanelTitle: text.includes('CAD Harness'),
    echoLine,
    canvasInfo,
    selectedPanelText: text.slice(0, 300),
  };
});
writeFileSync(`${outDir}/probe.json`, JSON.stringify({ probe, consoleErrors }, null, 2));
console.log(JSON.stringify({ probe, consoleErrorCount: consoleErrors.length }, null, 2));

await browser.close();
console.log('screenshots written to', outDir);
