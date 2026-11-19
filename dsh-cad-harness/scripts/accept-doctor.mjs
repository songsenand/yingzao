#!/usr/bin/env node
// B1 acceptance: doctor must separate fail / degraded / ok, not print a wall of
// green. The injected failures below are the point.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCTOR = new URL('./doctor.mjs', import.meta.url);
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function run(args) {
  return spawnSync(process.execPath, [fileURLToPath(DOCTOR), ...args], { encoding: 'utf8', timeout: 30000 });
}
function parse(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}

const base = run(['--json']);
const baseReport = parse(base);
check('doctor --json is parseable', baseReport !== null);
check('doctor reports a kind', ['ok', 'degraded', 'fail'].includes(baseReport?.kind), baseReport?.kind);
check('doctor reports plugin/node/dsh versions', Boolean(baseReport?.version?.plugin && baseReport?.version?.node && baseReport?.version?.dsh));
check('doctor includes the required checks', ['node', 'plugin-package', 'openscad', 'python-runtime', 'skills', 'preset-skill-path'].every((id) => baseReport?.checks?.some((c) => c.id === id)));
check('doctor exits 0/1/2 consistently', (base.status === 0 && baseReport.kind === 'ok') || (base.status === 1 && baseReport.kind === 'degraded') || (base.status === 2 && baseReport.kind === 'fail'), `status=${base.status} kind=${baseReport?.kind}`);

// The checkout ships a modern snapshot under bin/ (gitignored). doctor must
// prefer it over a stale system OpenSCAD on PATH, matching compile.ts; the CI
// tarball has no bin/, so there the provisioned path/PATH fallback is expected.
const snapshot = new URL('../../bin/squashfs-root/usr/bin/openscad', import.meta.url).pathname;
if (existsSync(snapshot)) {
  const openscadCheck = baseReport?.checks?.find((c) => c.id === 'openscad');
  check('doctor prefers the provisioned snapshot over PATH', openscadCheck?.detail?.includes(snapshot) && /202[5-9]\./.test(openscadCheck?.detail ?? ''), openscadCheck?.detail);
}

const missingOpenScad = run(['--json', '--openscad', '/nonexistent/openscad']);
const missingReport = parse(missingOpenScad);
check('missing OpenSCAD is a fail, not a pass', missingReport?.kind === 'fail' && missingOpenScad.status === 2, `status=${missingOpenScad.status}`);

const tmp = mkdtempSync(join(tmpdir(), 'cad-doctor-'));
try {
  mkdirSync(join(tmp, 'skills'), { recursive: true });
  const noSkills = run(['--json', '--skill-dir', join(tmp, 'skills')]);
  const noSkillsReport = parse(noSkills);
  check('empty skill dir is a fail', noSkillsReport?.kind === 'fail' && noSkills.status === 2, `status=${noSkills.status}`);
  check('empty skill dir names the fix', noSkillsReport?.checks?.find((c) => c.id === 'skills')?.fix?.length > 0);

  mkdirSync(join(tmp, 'cad-data'), { recursive: true });
  writeFileSync(join(tmp, 'cad-data', 'project.json'), JSON.stringify({ id: 'p1' }));
  const withProject = run(['--json', '--project', tmp]);
  const projectReport = parse(withProject);
  check('project marker is detected', projectReport?.checks?.find((c) => c.id === 'project-marker')?.status === 'pass');
  check('project write probe passes', projectReport?.checks?.find((c) => c.id === 'project-write')?.status === 'pass');
  check('legacy project schema is accepted', projectReport?.checks?.find((c) => c.id === 'project-schema')?.status === 'pass');

  const marker = join(tmp, 'cad-data', 'project.json');
  writeFileSync(marker, JSON.stringify({ schemaVersion: 99 }));
  const futureProject = JSON.parse(run(['--json', '--project', tmp]).stdout);
  check('newer project schema is a fail', futureProject?.checks?.find((c) => c.id === 'project-schema')?.status === 'fail');

  mkdirSync(join(tmp, 'assembly'), { recursive: true });
  writeFileSync(join(tmp, 'assembly', 'assembly.json'), JSON.stringify({ schemaVersion: 99 }));
  const futureAssembly = JSON.parse(run(['--json', '--project', tmp]).stdout);
  check('newer assembly schema is a fail', futureAssembly?.checks?.find((c) => c.id === 'assembly-schema')?.status === 'fail');
  const fakeBin = join(tmp, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const win32 = process.platform === 'win32';
  const stub = join(fakeBin, win32 ? 'dsh.cmd' : 'dsh');
  writeFileSync(stub, win32 ? '@echo 0.2.0\r\n' : '#!/bin/sh\necho 0.2.0\n');
  if (!win32) chmodSync(stub, 0o755);
  const old = spawnSync(process.execPath, [fileURLToPath(DOCTOR), '--json'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` },
  });
  const oldReport = parse(old);
  const oldCompat = oldReport?.checks?.find((c) => c.id === 'dsh-compat');
  check('older dsh fails compatibility', oldCompat?.status === 'fail', oldCompat?.detail);

  writeFileSync(stub, win32 ? '@echo 0.3.0\r\n' : '#!/bin/sh\necho 0.3.0\n');
  const future = spawnSync(process.execPath, [fileURLToPath(DOCTOR), '--json'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` },
  });
  const futureCompat = parse(future)?.checks?.find((c) => c.id === 'dsh-compat');
  check('future minor is a warning, not a pass', futureCompat?.status === 'warn', futureCompat?.detail);

  // L1.8 — the preset is a copy of dsh's standard patch, so it must be proved
  // against the dsh that will load it. A throwaway root keeps the checkout
  // untouched: generate a preset there, then reintroduce the row dsh 0.2.2
  // removed (`tool-subagent-control/list-agents`) and expect a fail + fix.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const fakeRoot = join(tmp, 'pretend-root');
  mkdirSync(join(fakeRoot, 'presets', 'cad'), { recursive: true });
  for (const name of ['preset.yml', 'workflow.md']) {
    copyFileSync(join(repoRoot, 'presets', 'cad', name), join(fakeRoot, 'presets', 'cad', name));
  }
  symlinkSync(join(repoRoot, 'skills'), join(fakeRoot, 'skills'), 'dir');
  writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: 'pretend', version: '0.0.0' }));
  const gen = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), '--root', fakeRoot, '--openscad=off'], { encoding: 'utf8', timeout: 30000 });
  check('setup can generate a preset for another root', gen.status === 0, (gen.stderr ?? '').trim().slice(0, 200));
  const freshReport = parse(run(['--json', '--root', fakeRoot]));
  const freshDrift = freshReport?.checks?.find((c) => c.id === 'preset-standard-drift');
  check('in-sync preset passes preset-standard-drift', freshDrift?.status === 'pass', freshDrift?.detail);
  const presetPath = join(fakeRoot, 'presets', 'cad', 'preset.patch.yml');
  const healthy = readFileSync(presetPath, 'utf8');
  writeFileSync(presetPath, healthy.replace(
    /(\n(\s+)- id: tool-subagent-control\n)/,
    `$1$2- id: tool-subagent-list-agents\n$2  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n`,
  ));
  const staleDrift = parse(run(['--json', '--root', fakeRoot]))?.checks?.find((c) => c.id === 'preset-standard-drift');
  check('stale preset fails preset-standard-drift', staleDrift?.status === 'fail', staleDrift?.detail);
  check('stale preset names the fix', (staleDrift?.fix ?? '').includes('dsh-cad-setup'), staleDrift?.fix);
  writeFileSync(presetPath, healthy);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\naccept-doctor: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
