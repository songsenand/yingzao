// Headless screenshot WITH WebGL, via a throwaway Xvfb display.
//
// Why this exists next to `shot.mjs`: plain `firefox --headless` on this machine
// cannot create a WebGL context at all — the probe page reports WEBGL
// UNAVAILABLE and the panel renders its "此环境无法创建 WebGL 上下文" card
// (there is no /dev/dri, and Firefox's headless GL path refuses even with
// software Mesa forced). Under an X display it works: Firefox takes the GLX
// path and Mesa's `swrast`/llvmpipe rasterises in software.
//
//   node sandbox/preview/shot-gl.mjs --name knob --query 'w=380&h=900&subject=p008'
//
// Everything else (profile handling, query parameters, the canvas freeze in
// `entry.tsx`) is identical to shot.mjs.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SHOTS = join(HERE, '..', 'shots');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:4173/');
const query = arg('query', '');
const url = arg('url', `${BASE}${query ? `?${query}` : ''}`);
const name = arg('name', 'shot-gl');
const size = arg('size', '1200,900');
const display = arg('display', `:${90 + (process.pid % 9)}`);

mkdirSync(SHOTS, { recursive: true });
const profile = join(tmpdir(), `cad-ui-gl-${process.pid}`);
mkdirSync(profile, { recursive: true });
// Firefox needs these before it will build a GL context on a bare X server.
spawnSync('sh', ['-c', `printf '%s\\n' 'user_pref("webgl.force-enabled",true);' > ${profile}/user.js`]);
const out = join(SHOTS, `${name}.png`);

const xvfb = spawn('Xvfb', [display, '-screen', '0', `${size.replace(',', 'x')}x24`], { stdio: 'ignore' });
const stop = () => { try { xvfb.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

try {
  await new Promise((r) => setTimeout(r, 2000));   // let the X server come up
  const r = spawnSync('firefox', ['--profile', profile, `--window-size=${size}`, `--screenshot=${out}`, url], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 180000,
    env: { ...process.env, DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  });
  const noise = /dconf|headless|Read-only file system|只读文件系统|Glean|WARNING/g;
  const err = (r.stderr?.toString() ?? '').split('\n').filter((l) => l && !noise.test(l));
  if (err.length) console.error(err.join('\n'));
  console.log(`[shot-gl] ${name}: ${url} -> ${out}  (DISPLAY=${display}, llvmpipe)`);
} finally {
  stop();
  rmSync(profile, { recursive: true, force: true });
}
