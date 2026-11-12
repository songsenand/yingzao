#!/usr/bin/env node
// B1 acceptance: doctor must separate fail / degraded / ok, not print a wall of
// green. The injected failures below are the point.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DOCTOR = new URL('./doctor.mjs', import.meta.url);
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function run(args) {
  return spawnSync(process.execPath, [DOCTOR.pathname, ...args], { encoding: 'utf8', timeout: 30000 });
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
  const stub = join(fakeBin, 'dsh');
  writeFileSync(stub, '#!/bin/sh\necho 0.2.0\n');
  chmodSync(stub, 0o755);
  const old = spawnSync(process.execPath, [DOCTOR.pathname, '--json'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  const oldReport = parse(old);
  const oldCompat = oldReport?.checks?.find((c) => c.id === 'dsh-compat');
  check('older dsh fails compatibility', oldCompat?.status === 'fail', oldCompat?.detail);

  writeFileSync(stub, '#!/bin/sh\necho 0.3.0\n');
  const future = spawnSync(process.execPath, [DOCTOR.pathname, '--json'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  const futureCompat = parse(future)?.checks?.find((c) => c.id === 'dsh-compat');
  check('future minor is a warning, not a pass', futureCompat?.status === 'warn', futureCompat?.detail);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\naccept-doctor: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
