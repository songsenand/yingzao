// V1 acceptance: three examples, synthetic positive, negative claim/exception
// cases, no-CAD dependency, no-write side effects, determinism, exit codes.
//
//   node scripts/accept-verify.mjs

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { verify } from '../src/host/verify/index.ts';
import { canonicalJson } from '../src/host/verify/report.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const examples = {
  windup: join(ROOT, '../examples/windup-frog'),
  roberval: join(ROOT, '../examples/roberval-balance'),
  table: join(ROOT, '../examples/eight-immortals-table'),
};

const json = (v) => JSON.stringify(v, null, 2);

async function makePositiveProject() {
  const root = await mkdtemp(join(tmpdir(), 'verify-positive-'));
  await mkdir(join(root, 'assembly'), { recursive: true });
  await mkdir(join(root, 'cad-data/versions/v001'), { recursive: true });
  await mkdir(join(root, 'cad-data/parts'), { recursive: true });
  for (const id of ['r001', 'r002', 'r003']) await mkdir(join(root, 'cad-data/runs', id), { recursive: true });

  await writeFile(join(root, 'assembly/assembly.json'), json({
    schemaVersion: 1, name: 'test', unit: 'mm', up: 'z',
    root: {
      id: 'root', name: 'root', kind: 'assembly',
      children: [{ id: 'p1', name: 'part', kind: 'part', version: 'v001' }],
      interfaces: [{
        id: 'I1', a: 'p1.axisA', b: 'p1.axisB', type: '贴合', severity: 'hard',
        check: 'distance', tolerance: { min: -1, max: 1 },
      }],
    },
  }));
  await writeFile(join(root, 'claims.json'), json({
    schemaVersion: 1,
    claims: [{ kind: 'assembly', statement: 'the interface holds', runId: 'r002' }],
  }));
  await writeFile(join(root, 'cad-data/manifest.json'), json({
    versions: [{
      id: 'v001', timestamp: '2026-01-01T00:00:00.000Z', userIntent: 'test',
      parentVersion: null, partId: 'p001', status: 'draft',
    }],
  }));
  await writeFile(join(root, 'cad-data/parts/manifest.json'), json({
    schemaVersion: 1,
    parts: [{
      id: 'p001', name: 'part', createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z', versionIds: ['v001'],
    }],
  }));
  await writeFile(join(root, 'cad-data/versions/v001/datums.json'), json({
    points: [], planes: [], cylinders: [],
    axes: [
      { name: 'axisA', point: [0, 0, 0], dir: [0, 0, 1] },
      { name: 'axisB', point: [0, 0, 1], dir: [0, 0, 1] },
    ],
  }));
  await writeFile(join(root, 'cad-data/versions/v001/visual-review.json'), json({
    schemaVersion: 1, versionId: 'v001', reviewedAt: '2026-01-01T00:04:00.000Z',
    views: ['top', 'iso'], sections: [], notes: ['looks right'], images: [], source: 'review_visual',
  }));

  const runs = [
    ['r001', 'assembly', '2026-01-01T00:01:00.000Z', {
      parts: [], pairs: [], overallStatus: 'pass', thresholdMm: 0.75, interferenceEpsilonMm3: 0,
    }],
    ['r002', 'assembly-check', '2026-01-01T00:02:00.000Z', {
      overallStatus: 'pass',
      summary: { interfaces: 1, pass: 1, hardViolations: 0, intentFlags: 0, skipped: 0, undeclared: 0 },
      results: [{ interfaceId: 'I1', a: 'p1.axisA', b: 'p1.axisB', type: '贴合', severity: 'hard', verdict: 'pass', measured: 0, detail: 'ok' }],
      undeclared: [],
    }],
    ['r003', 'printability', '2026-01-01T00:03:00.000Z', {
      versionId: 'v001', verdict: 'not-excluded', minWallMm: 2, minWallAtMm: [0, 0, 0], findings: [], watertight: true,
    }],
  ];
  const entries = [];
  for (const [id, kind, timestamp, report] of runs) {
    const entry = {
      id, kind, timestamp, title: kind, status: 'pass', judgement: 'not-excluded', summary: 'ok',
      sourceVersionIds: ['v001'], hasGeometry: false, parts: ['p1'], subject: `${kind}:v001`,
      pythonOverlay: { packages: [], overrides: [], digest: '' },
    };
    entries.push(entry);
    await writeFile(join(root, 'cad-data/runs', id, 'run.json'), json(entry));
    await writeFile(join(root, 'cad-data/runs', id, 'report.json'), json(report));
  }
  await writeFile(join(root, 'cad-data/runs/manifest.json'), json({ schemaVersion: 1, runs: entries }));
  await writeFile(join(root, 'PROMPT.md'), '# test\n');
  return root;
}

function stripGeneratedAt(text) {
  return text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "NORMALISED"');
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts/verify.mjs'), ...args], { cwd, encoding: 'utf8' });
}

const tmp = await mkdtemp(join(tmpdir(), 'verify-accept-'));
let positiveRoot = null;
try {
  // 1) three examples: verdicts fixed by the contract ---------------------
  const expected = { windup: 'warn', roberval: 'blocked', table: 'blocked' };
  for (const [name, dir] of Object.entries(examples)) {
    const r = await verify({ projectRoot: dir });
    check(r.report.verdict === expected[name], `${name}: verdict ${expected[name]}`, r.report.verdict);
    check(r.report.rows.length === 6, `${name}: six rows`, String(r.report.rows.length));
    check(r.report.rows.map((x) => x.id).join(',') === 'requirements,model,fit,make,review,delivery', `${name}: row order`);
    check(r.report.findings.every((f) => f.id && f.code && f.severity && f.what && Array.isArray(f.why) && f.where && Array.isArray(f.next)), `${name}: finding shape`);
    check(r.report.policy.mode === 'advisory', `${name}: default is advisory`, r.report.policy.mode);
  }

  // 2) synthetic positive: pass, and no writes ----------------------------
  const positive = await makePositiveProject();
  positiveRoot = positive;
  const writeTargets = [
    join(positive, 'assembly/assembly.json'),
    join(positive, 'cad-data/runs/manifest.json'),
  ];
  const before = new Map();
  for (const p of writeTargets) before.set(p, createHash('sha256').update(await readFile(p)).digest('hex'));
  const pass = await verify({ projectRoot: positive, block: true });
  check(pass.report.verdict === 'pass', 'positive: pass', pass.report.verdict);
  check(pass.exitCode === 0, 'positive: exit 0', String(pass.exitCode));
  const after = new Map();
  for (const p of writeTargets) after.set(p, createHash('sha256').update(await readFile(p)).digest('hex'));
  check([...before].every(([p, h]) => after.get(p) === h), 'positive: no writes to assembly/runs');

  // 3) explicit claim negatives ------------------------------------------
  const missingClaim = join(tmp, 'claims-missing.json');
  await writeFile(missingClaim, json({ schemaVersion: 1, claims: [{ kind: 'motion', statement: 'x', runId: 'r9999' }] }));
  const missing = await verify({ projectRoot: positive, claimsPath: missingClaim, block: true });
  check(missing.report.verdict === 'blocked', 'claim-run-missing: blocked', missing.report.verdict);
  check(missing.report.findings.some((f) => f.code === 'claim-run-missing'), 'claim-run-missing: code');

  const staleClaim = join(tmp, 'claims-stale.json');
  await writeFile(staleClaim, json({ schemaVersion: 1, claims: [{ kind: 'assembly', statement: 'x', runId: 'r002', versionIds: ['v002'] }] }));
  const stale = await verify({ projectRoot: positive, claimsPath: staleClaim, block: true });
  check(stale.report.verdict === 'blocked', 'claim-run-stale: blocked', stale.report.verdict);
  check(stale.report.findings.some((f) => f.code === 'claim-run-stale'), 'claim-run-stale: code');

  const required = await verify({ projectRoot: examples.windup, requireClaims: true, block: true });
  check(required.report.verdict === 'blocked', 'require-claims: blocked', required.report.verdict);
  check(required.report.findings.some((f) => f.code === 'claims-required'), 'require-claims: code');

  // 4) exception expiry ---------------------------------------------------
  const expiredPolicy = join(tmp, 'policy-expired.json');
  const expiredExceptions = join(tmp, 'exceptions-expired.json');
  await writeFile(expiredPolicy, json({ schemaVersion: 1, mode: 'blocking', exceptions: 'exceptions-expired.json' }));
  await writeFile(expiredExceptions, json({ schemaVersion: 1, exceptions: [{ id: 'X1', finding: 'visual-review-missing', reason: 'test', expiresAt: '2020-01-01' }] }));
  const expired = await verify({ projectRoot: examples.roberval, policyPath: expiredPolicy });
  check(expired.report.verdict === 'blocked', 'expired exception: stays blocked', expired.report.verdict);
  check(expired.report.findings.some((f) => f.code === 'exception-expired'), 'expired exception: code');

  const validPolicy = join(tmp, 'policy-valid.json');
  const validExceptions = join(tmp, 'exceptions-valid.json');
  await writeFile(validPolicy, json({ schemaVersion: 1, mode: 'blocking', exceptions: 'exceptions-valid.json' }));
  await writeFile(validExceptions, json({ schemaVersion: 1, exceptions: [{ id: 'X2', finding: 'visual-review-missing', reason: 'research body', expiresAt: '2030-01-01' }] }));
  const valid = await verify({ projectRoot: examples.roberval, policyPath: validPolicy });
  check(valid.report.verdict === 'warn', 'valid exception: warn', valid.report.verdict);
  check(valid.report.exceptions.some((e) => e.id === 'X2'), 'valid exception: recorded');

  // 5) no CAD dependency --------------------------------------------------
  const saved = { openscad: process.env.CAD_OPENSCAD_BIN, python: process.env.DSH_CAD_PYTHON };
  process.env.CAD_OPENSCAD_BIN = '/nonexistent/openscad';
  process.env.DSH_CAD_PYTHON = '/nonexistent/python';
  const noCad = await verify({ projectRoot: positive, block: true });
  check(noCad.report.verdict === 'pass', 'no CAD: still pass', noCad.report.verdict);
  if (saved.openscad === undefined) delete process.env.CAD_OPENSCAD_BIN; else process.env.CAD_OPENSCAD_BIN = saved.openscad;
  if (saved.python === undefined) delete process.env.DSH_CAD_PYTHON; else process.env.DSH_CAD_PYTHON = saved.python;

  // 6) determinism --------------------------------------------------------
  const d1 = await verify({ projectRoot: positive });
  const d2 = await verify({ projectRoot: positive });
  check(stripGeneratedAt(canonicalJson(d1.report)) === stripGeneratedAt(canonicalJson(d2.report)), 'deterministic canonical JSON');

  // 7) CLI exit codes -----------------------------------------------------
  check(runCli([examples.windup, '--advisory']).status === 0, 'cli advisory exits 0');
  check(runCli([examples.windup, '--block']).status === 1, 'cli blocking warn exits 1');
  check(runCli([examples.windup, '--block', '--strict']).status === 2, 'cli strict warn exits 2');
  check(runCli([examples.roberval, '--block']).status === 2, 'cli blocked exits 2');
  check(runCli([positive, '--block']).status === 0, 'cli pass exits 0');
  check(runCli([]).status === 3, 'cli usage error exits 3');

  // 8) text report is compact --------------------------------------------
  const text = runCli([examples.windup, '--advisory']);
  check(text.status === 0 && text.stdout.includes('verify:') && text.stdout.split('\n').length < 40, 'text report is compact', String(text.stdout.split('\n').length));
} finally {
  await rm(tmp, { recursive: true, force: true });
  if (positiveRoot) await rm(positiveRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
