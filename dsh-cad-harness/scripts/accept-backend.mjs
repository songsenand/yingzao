#!/usr/bin/env node
// A3a acceptance: one product-level kernel choice; planned kernels are refused,
// never silently substituted; the choice is a file on disk, not a comment.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openVersionStore, readManifest, saveVersion } from '../src/host/version.ts';
import { backendAdapter } from '../src/host/backends/index.ts';

const CLI = fileURLToPath(new URL('./backend.mjs', import.meta.url));
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
  check('cadquery is available', listed?.kernels?.find((k) => k.id === 'cadquery')?.status === 'available');

  const planned = run(['--kernel', 'freecad']);
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

  const cqWrite = run(['--kernel', 'cadquery', '--json']);
  check('cadquery kernel can be selected', cqWrite.status === 0 && json(cqWrite)?.config?.kernel === 'cadquery', `status=${cqWrite.status}`);
  process.env.DSH_HOME = home;
  if (process.platform !== 'win32') {
    const { resolveOpenScadBinary } = await import('../src/host/compile.ts');
    const high = join(home, 'high-openscad');
    writeFileSync(high, '#!/bin/sh\necho "OpenSCAD version 2026.09.23"\n', 'utf8');
    chmodSync(high, 0o755);
    const configPath = join(home, 'cad', 'backend.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, binaryPath: high }, null, 2));
    let openscadUnderCq = null;
    try { openscadUnderCq = await resolveOpenScadBinary(); } catch (error) { openscadUnderCq = String(error?.message ?? error); }
    check('cadquery selection does not disable OpenSCAD rendering', typeof openscadUnderCq === 'object' && openscadUnderCq?.bin === high, JSON.stringify(openscadUnderCq));
    const old = join(home, 'old-openscad');
    writeFileSync(old, '#!/bin/sh\necho "OpenSCAD version 2021.01"\n', 'utf8');
    chmodSync(old, 0o755);
    process.env.CAD_OPENSCAD_BIN = old;
    const picked = await resolveOpenScadBinary();
    check('an old CAD_OPENSCAD_BIN is not allowed to shadow a newer configured binary', picked.bin === high, JSON.stringify({ picked, high }));
    delete process.env.CAD_OPENSCAD_BIN;
    const oldPathDir = join(home, 'old-path');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(oldPathDir, { recursive: true });
    writeFileSync(join(oldPathDir, 'openscad'), '#!/bin/sh\necho "OpenSCAD version 2021.01"\n', 'utf8');
    chmodSync(join(oldPathDir, 'openscad'), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${oldPathDir}:${savedPath ?? ''}`;
    const pathPicked = await resolveOpenScadBinary();
    check('an old system OpenSCAD on PATH is not allowed to shadow a newer configured binary', pathPicked.bin === high, JSON.stringify({ picked: pathPicked, high }));
    process.env.PATH = savedPath;
  }
  const reset = run(['--kernel', 'openscad', '--json']);
  check('kernel can be switched back', reset.status === 0 && json(reset)?.config?.kernel === 'openscad');

  const binar = run(['--binary', '/opt/openscad', '--json']);
  check('binary path is persisted', json(binar)?.config?.binaryPath === '/opt/openscad');

  const read = JSON.parse(readFileSync(join(home, 'cad', 'backend.json'), 'utf8'));
  check('file is valid JSON with three fields', read.kernel === 'openscad' && read.compileBackend === 'manifold' && read.binaryPath === '/opt/openscad');

  const adapter = backendAdapter('openscad');
  check('adapter is available', adapter.id === 'openscad');
  check('adapter has compile', typeof adapter.compile === 'function');
  check('adapter exposes ONLY compile (render/export left the engine seam)',
    !('render' in adapter) && !('export' in adapter));
  const cqAdapter = backendAdapter('cadquery');
  check('cadquery adapter is available', cqAdapter.id === 'cadquery' && typeof cqAdapter.compile === 'function');
  let refused = null;
  try { backendAdapter('freecad'); } catch (error) { refused = String(error?.message ?? error); }
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
