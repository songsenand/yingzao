#!/usr/bin/env node
// A3a acceptance: one product-level kernel choice; planned kernels are refused,
// never silently substituted; the choice is a file on disk, not a comment.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openVersionStore, readManifest, saveVersion } from '../src/host/version.ts';
import { backendAdapter } from '../src/host/backends/index.ts';

const CLI = new URL('./backend.mjs', import.meta.url).pathname;
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const home = mkdtempSync(join(tmpdir(), 'cad-backend-'));
const env = { ...process.env, DSH_HOME: home };
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30000 });
}
function json(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}

try {
  const list = run(['--list', '--json']);
  const listed = json(list);
  check('list exits 0', list.status === 0);
  check('openscad is available', listed?.kernels?.find((k) => k.id === 'openscad')?.status === 'available');
  check('cadquery is planned, not available', listed?.kernels?.find((k) => k.id === 'cadquery')?.status === 'planned');

  const planned = run(['--kernel', 'cadquery']);
  check('planned kernel is refused', planned.status === 2, `status=${planned.status}`);
  check('refusal names backend_not_available', `${planned.stderr}${planned.stdout}`.includes('backend_not_available'));

  const write = run(['--compile-backend', 'manifold', '--json']);
  const written = json(write);
  check('write exits 0', write.status === 0, write.stderr);
  check('config file exists', existsSync(join(home, 'cad', 'backend.json')));
  check('write records manifold', written?.config?.compileBackend === 'manifold');
  check('kernel stays openscad', written?.config?.kernel === 'openscad');

  const shown = json(run(['--show', '--json']));
  check('show reads the file back', shown?.config?.compileBackend === 'manifold');

  const binar = run(['--binary', '/opt/openscad', '--json']);
  check('binary path is persisted', json(binar)?.config?.binaryPath === '/opt/openscad');

  const read = JSON.parse(readFileSync(join(home, 'cad', 'backend.json'), 'utf8'));
  check('file is valid JSON with three fields', read.kernel === 'openscad' && read.compileBackend === 'manifold' && read.binaryPath === '/opt/openscad');

  const adapter = backendAdapter('openscad');
  check('adapter is available', adapter.id === 'openscad');
  check('adapter has compile', typeof adapter.compile === 'function');
  check('adapter has render', typeof adapter.render === 'function');
  check('adapter has export', typeof adapter.export === 'function');
  let refused = null;
  try { backendAdapter('cadquery'); } catch (error) { refused = String(error?.message ?? error); }
  check('planned adapter is refused', refused?.includes('backend_not_available'), refused ?? 'no throw');

  process.env.DSH_HOME = home;
  const store = openVersionStore(join(home, 'cad-data'));
  const versionId = await saveVersion(store, { userIntent: 'backend pin test', scadCode: 'cube(1);' });
  const manifest = await readManifest(store);
  const entry = manifest.versions.find((v) => v.id === versionId);
  check('version records the kernel', entry?.backend?.kernel === 'openscad');
  check('version records the compile backend', entry?.backend?.options?.compileBackend === 'manifold');
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\naccept-backend: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
