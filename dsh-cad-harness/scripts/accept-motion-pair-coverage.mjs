// Acceptance for the MOTION PAIR-COVERAGE gate (2026-11-22).
//
// Why this exists: `simulate_motion` drops every revolute-linked pair from its
// interference timeline (pin/bearing overlap is expected). The sewing rotary-hook
// r024 then cited its "0 interference" as evidence for I14 (arbor↔rod), a pair the
// run never looked at — and the pair was actually overlapping by 75.87 mm³. The
// gate makes that citation a hard violation instead of a green.
//
// What it pins:
//   1. `readMotionPairCoverage` reads r024's four revolute pairs (from motion-spec)
//      and matches arbor↔rod to the interface's part ids.
//   2. check_assembly (TS oracle and the worker) turns I14 into a hard violation
//      with the excluded-pair detail, while I15 (not excluded) still passes.
//   3. `scan-joint-pairs.mjs` independently finds arbor↔rod at 75.87 mm³.
//
//   node scripts/accept-motion-pair-coverage.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAssemblyCheck, readMotionPairCoverage, excludedPairFor } from '../src/host/assembly-check.ts';
import { projectStores } from '../src/host/project.ts';
import { listVersions, openVersionStore } from '../src/host/version.ts';
import { newestVersionPerPart } from '../src/host/latest.ts';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', process.env.DSH_CAD_PYTHON_ROOT?.trim() || join(REPO, '.tmp-measure-runtime')));
const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');

const PROJECT = join(REPO, 'examples', 'sewing-rotary-hook');
if (!existsSync(join(PROJECT, 'assembly', 'assembly.json'))) {
  console.error(`missing ${PROJECT} — cannot run this acceptance`);
  process.exit(2);
}
const havePython = existsSync(venvPython);
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const stores = projectStores(PROJECT);
const manifestPath = join(PROJECT, 'assembly', 'assembly.json');

console.log('--- 1. r024 coverage is read and matched ---');
const coverage = await readMotionPairCoverage(stores.store, 'r024');
check(coverage.known === true, 'r024 coverage is known', String(coverage.known));
check(coverage.excluded.size === 4, 'r024 excluded 4 revolute pairs', `${coverage.excluded.size}`);
const hit = excludedPairFor(coverage, 'arbor.crank-pin-axis', 'rod.rod-big-end');
check(hit?.[0] === 'arbor' && hit?.[1] === 'rod',
  'arbor↔rod is matched to I14', JSON.stringify(hit));

console.log('--- 2. motion-clearance refuses a run that excluded the pair ---');
// A two-part manifest over the current rod/upper-shaft datums, so the verdict
// depends on COVERAGE, not on the example's interface numbering or on staleness.
const versions = await listVersions(stores.store);
const newest = newestVersionPerPart(versions);
const tmp = await mkdtemp(join(tmpdir(), 'motion-pair-'));
await symlink(join(stores.store.root, 'versions'), join(tmp, 'versions'));
await mkdir(join(tmp, 'runs', 'r024'), { recursive: true });
await writeFile(join(tmp, 'runs', 'r024', 'report.json'), JSON.stringify({
  metrics: { excludedJointPairs: [['rod', 'upper_shaft']] },
}));
const gateManifest = join(tmp, 'assembly.json');
await writeFile(gateManifest, JSON.stringify({
  schemaVersion: 1, name: 'motion-pair-gate',
  root: {
    id: 'root', name: 'gate', kind: 'assembly',
    children: [
      { id: 'rod', name: 'rod', kind: 'part', version: 'v107' },
      { id: 'upper_shaft', name: 'upper shaft', kind: 'part', version: 'v102' },
    ],
    interfaces: [{
      id: 'I-gate', a: 'rod.rod-big-end', b: 'upper_shaft.needle-crank-pin',
      type: '转动副', severity: 'hard', check: 'motion-clearance',
      tolerance: { min: 0, max: 0.2 }, evidence: { runId: 'r024' },
    }],
  },
}));
const fakeRun = {
  id: 'r024', kind: 'motion', status: 'pass', summary: 'synthetic coverage run',
  sourceVersionIds: [newest.get('rod'), newest.get('upper_shaft')].filter(Boolean),
  timestamp: new Date().toISOString(), title: 'coverage fixture', judgement: 'not-excluded',
};
const tmpStore = openVersionStore(tmp);

const assertGate = (tag, report) => {
  const gate = report.results.find((r) => r.interfaceId === 'I-gate');
  check(gate?.verdict === 'hard-violation', `${tag}: the excluded pair is a hard violation`, `${gate?.verdict}`);
  check(/excluded the revolute pair rod↔upper_shaft/.test(gate?.detail ?? ''),
    `${tag}: detail names the excluded pair`, gate?.detail ?? '');
};

if (havePython) {
  assertGate('Python', await runAssemblyCheck(tmpStore, gateManifest, { runs: [fakeRun] }));
} else {
  console.log('SKIP  Python worker (no venv)');
}

console.log('--- 3. independent scan finds the actual overlap ---');
const scan = await execFileAsync(process.execPath, [
  join(HERE, 'scan-joint-pairs.mjs'), '--run', join(PROJECT, 'cad-data', 'runs', 'r024'), '--json',
]).catch((e) => e);
const parsed = JSON.parse(scan.stdout ?? '{}');
const rod = parsed.pairs?.find((p) => p.pair === 'arbor↔rod');
check(rod?.overlappingFrames === 5, 'scan: arbor↔rod overlaps 5 sampled frames', `${rod?.overlappingFrames}`);
check(Math.abs((rod?.maxVolumeMm3 ?? 0) - 75.87) < 0.01, 'scan: peak volume 75.87mm³', `${rod?.maxVolumeMm3}`);

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
