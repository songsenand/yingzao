// Headless screenshot of one sandbox page, with a throwaway Firefox profile.
//
//   node sandbox/preview/shot.mjs --name new-380x900 --query 'w=380&h=900'
//   node sandbox/preview/shot.mjs --url 'http://127.0.0.1:4173/?w=380&h=900' --name x
//
// Notes on the environment (Firefox 156 headless):
//   * `--profile <dir>` requires the directory to already exist.
//   * The profile is created under the OS temp dir (a Firefox profile is
//     ~100MB — it must never land in the repo).
//   * WebGL canvases are NOT composited into `--screenshot` captures; the
//     sandbox entry freezes each canvas into an <img> so the model still shows.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
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
const name = arg('name', 'shot');
const size = arg('size', '1200,900');
const keepProfile = process.argv.includes('--keep-profile');

const profile = join(tmpdir(), `cad-ui-ff-${process.pid}`);
mkdirSync(profile, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const out = join(SHOTS, `${name}.png`);

// A dead server (or a Firefox crash) used to leave the PREVIOUS capture on disk
// and still print a path — a silently stale image is worse than no image. Probe
// the URL first, and delete the old file so "the file exists" proves this run
// wrote it.
const probe = await fetch(url, { signal: AbortSignal.timeout(4000) }).catch(() => null);
if (!probe || !probe.ok) {
  console.error(`[shot] FAIL ${name}: ${url} did not answer${probe ? ` (HTTP ${probe.status})` : ''} — is the sandbox server running?`);
  process.exit(2);
}
rmSync(out, { force: true });

try {
  const r = spawnSync('firefox', [
    '--headless', '--profile', profile, `--window-size=${size}`,
    '--screenshot', out, url,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
  const noise = /dconf|headless mode|Read-only file system|只读文件系统|Glean store|WARNING/g;
  const err = (r.stderr?.toString() ?? '').split('\n').filter((l) => l && !noise.test(l));
  if (err.length) console.error(err.join('\n'));
  if (!existsSync(out) || statSync(out).size === 0) {
    console.error(`[shot] FAIL ${name}: Firefox wrote no image (exit ${r.status}) for ${url}`);
    process.exit(3);
  }
  console.log(`[shot] ${name}: ${url} -> ${out}`);
} finally {
  if (!keepProfile) rmSync(profile, { recursive: true, force: true });
}
