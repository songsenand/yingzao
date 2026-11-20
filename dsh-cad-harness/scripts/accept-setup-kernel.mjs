#!/usr/bin/env node
// L1.9: installation-time kernel selection. The setup must accept an explicit
// --kernel for automation, default to OpenSCAD when non-interactive, preserve
// the OpenSCAD compile backend, and refuse an unknown id. A TTY prompt is the
// interactive path; this test drives the deterministic flags.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SETUP = fileURLToPath(new URL('./setup.mjs', import.meta.url));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const work = await mkdtemp(join(tmpdir(), 'setup-kernel-'));
const run = (home, args) => spawnSync(process.execPath, [SETUP, '--openscad=off', '--json', '--out', join(work, 'preset.yml'), ...args], {
  encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: home },
});
const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const config = async (home) => JSON.parse(await readFile(join(home, 'cad', 'backend.json'), 'utf8'));

try {
  const home = join(work, 'home');
  const cq = run(home, ['--kernel', 'cadquery']);
  check(cq.status === 0 && parse(cq)?.kernel === 'cadquery', '--kernel cadquery is accepted and reported', `${cq.status}: ${cq.stderr}`);
  const cqConfig = await config(home);
  check(cqConfig.kernel === 'cadquery', 'backend.json records cadquery', JSON.stringify(cqConfig));

  // Existing OpenSCAD adapter options survive a kernel-only change.
  await writeFile(join(home, 'cad', 'backend.json'), JSON.stringify({ kernel: 'openscad', compileBackend: 'manifold', binaryPath: '/opt/openscad' }));
  const changed = run(home, ['--kernel', 'cadquery']);
  check(changed.status === 0 && parse(changed)?.kernelChanged === true, 'kernel change is reported', JSON.stringify(parse(changed)));
  const preserved = await config(home);
  check(preserved.kernel === 'cadquery' && preserved.compileBackend === 'manifold' && preserved.binaryPath === '/opt/openscad', 'compileBackend/binaryPath survive', JSON.stringify(preserved));

  const home2 = join(work, 'home2');
  const dflt = run(home2, []);
  check(dflt.status === 0 && parse(dflt)?.kernel === 'openscad', 'non-interactive default reports openscad', `${dflt.status}: ${dflt.stderr}`);
  let defaultWritten = true;
  try { await config(home2); } catch { defaultWritten = false; }
  check(defaultWritten === false, 'non-interactive no-flag does not invent backend.json');
  await mkdir(join(home2, 'cad'), { recursive: true });
  await writeFile(join(home2, 'cad', 'backend.json'), JSON.stringify({ kernel: 'cadquery', compileBackend: 'auto', binaryPath: null }));
  const preservedRun = run(home2, []);
  check(preservedRun.status === 0 && parse(preservedRun)?.kernel === 'cadquery', 'non-interactive no-flag reports the existing kernel', JSON.stringify(parse(preservedRun)));
  check((await config(home2)).kernel === 'cadquery', 'non-interactive no-flag preserves the existing kernel');

  const home3 = join(work, 'home3');
  const bad = run(home3, ['--kernel', 'freecad']);
  check(bad.status === 2 && String(bad.stderr).includes('unknown --kernel'), 'unknown kernel is refused', bad.stderr.trim());

  // --check is read-only: an existing cadquery config must not be rewritten.
  const home4 = join(work, 'home4');
  await mkdir(join(home4, 'cad'), { recursive: true });
  await writeFile(join(home4, 'cad', 'backend.json'), JSON.stringify({ kernel: 'cadquery', compileBackend: 'auto', binaryPath: null }));
  const before = await readFile(join(home4, 'cad', 'backend.json'), 'utf8');
  spawnSync(process.execPath, [SETUP, '--check', '--json', '--out', join(work, 'preset.yml')], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home4 } });
  check(await readFile(join(home4, 'cad', 'backend.json'), 'utf8') === before, '--check does not rewrite backend.json');
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
