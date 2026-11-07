// V1 acceptance: three examples, synthetic positive, negative claim/exception
// cases, no-CAD dependency, no-write side effects, determinism, exit codes.
//
//   node scripts/accept-verify.mjs

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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


const CHECK_CODE = `let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const expect = input.constraints?.checkConfig?.expect ?? 'pass';
  const base = { apiVersion: 'checker/v1', checker: { id: 'test-check', version: '1.0.0' }, artifacts: [] };
  if (expect === 'fail') {
    process.stdout.write(JSON.stringify({ ...base, status: 'fail', findings: [{ criterion: 'test criterion', verdict: 'fail', measured: 1, limit: 2, unit: 'mm', message: '1mm < 2mm', witness: { kind: 'test' }, attention: [{ kind: 'part', part: 'p1', where: [0, 0, 0], note: 'below target' }] }], coverage: { criteria: ['test criterion'], complete: true, skipped: [] } }));
    return;
  }
  if (expect === 'incomplete') { process.stdout.write(JSON.stringify({ ...base, status: 'blocked', findings: [{ criterion: 'test criterion', verdict: 'blocked', measured: 0, limit: 0, unit: 'mm', witness: { kind: 'test' }, attention: [{ kind: 'part', part: 'p1', where: [0, 0, 0], note: 'not measured in this fixture' }], message: 'not measured in this fixture' }], coverage: { criteria: ['test criterion'], complete: false, skipped: [{ criterion: 'test criterion', reason: 'not measured in this fixture' }] } })); return; }
  if (expect === 'error') { process.stdout.write('not json'); return; }
  if (expect === 'timeout') { setTimeout(() => process.exit(0), 5000); return; }
  process.stdout.write(JSON.stringify({ ...base, status: 'pass', findings: [{ criterion: 'test criterion', verdict: 'pass' }], coverage: { criteria: ['test criterion'], complete: true, skipped: [] } }));
});
`;

async function writeCheck(root, options = {}) {
  const {
    expect = 'pass', timeoutMs = 1000,
    permissions = ['read:constraints'], negativeExpect = 'fail',
  } = options;
  const dir = join(root, 'checks/test-check');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), json({
    apiVersion: 'checker/v1', id: 'test-check', version: '1.0.0', row: 'delivery',
    criteria: ['test criterion'], entry: ['node', 'check.mjs'],
    permissions, timeoutMs, negativeSamples: ['negative.json'],
    config: { expect },
  }));
  await writeFile(join(dir, 'negative.json'), json({
    apiVersion: 'checker/v1', constraints: { checkConfig: { expect: negativeExpect } },
  }));
  await writeFile(join(dir, 'check.mjs'), CHECK_CODE);
  return dir;
}

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


  // 2b) custom checks: opt-in, negative-sample gate, mapping --------------
  const baseClaims = join(tmp, 'claims-base.json');
  await writeFile(baseClaims, json({ schemaVersion: 1, claims: [{ kind: 'assembly', statement: 'the interface holds', runId: 'r002' }] }));
  const checkClaims = join(tmp, 'claims-check.json');
  await writeFile(checkClaims, json({ schemaVersion: 1, claims: [
    { kind: 'assembly', statement: 'the interface holds', runId: 'r002' },
    { kind: 'assembly', statement: 'the test criterion holds', checkId: 'test-check' },
  ] }));

  await writeCheck(positive, { expect: 'pass' });
  const defaultOff = await verify({ projectRoot: positive, claimsPath: baseClaims });
  check(defaultOff.report.checks.length === 0, 'checks: default off', String(defaultOff.report.checks.length));
  check(defaultOff.report.verdict === 'pass', 'checks: default off keeps pass', defaultOff.report.verdict);

  const checkPass = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true });
  check(checkPass.report.verdict === 'pass', 'check pass: verdict pass', checkPass.report.verdict);
  check(checkPass.report.checks.length === 1 && checkPass.report.checks[0].status === 'pass', 'check pass: status', json(checkPass.report.checks));
  check(checkPass.report.coverage.checked.includes('check:test-check@1.0.0'), 'check pass: coverage', json(checkPass.report.coverage.checked));
  check(checkPass.report.findings.some((f) => f.code === 'check-passed' && f.severity === 'info'), 'check pass: info witness');

  const mount = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true, mountChecks: true });
  check(mount.report.verdict === 'pass', 'check mount: does not change verdict', mount.report.verdict);
  check(mount.report.checks[0].status === 'pending', 'check mount: pending', json(mount.report.checks));
  check(mount.report.coverage.missing.some((m) => m.startsWith('check:test-check')), 'check mount: missing evidence');

  const checkClaimPass = await verify({ projectRoot: positive, claimsPath: checkClaims, checks: true });
  check(checkClaimPass.report.verdict === 'pass', 'check claim: pass', checkClaimPass.report.verdict);
  check(checkClaimPass.report.rows.find((r) => r.id === 'delivery').checked.some((c) => c.kind === 'check:test-check'), 'check claim: checked entry');

  const checkClaimOff = await verify({ projectRoot: positive, claimsPath: checkClaims });
  check(checkClaimOff.report.verdict === 'blocked', 'check claim without checks: blocked', checkClaimOff.report.verdict);
  check(checkClaimOff.report.findings.some((f) => f.code === 'claim-check-missing'), 'check claim without checks: code');

  const checkClaimMount = await verify({ projectRoot: positive, claimsPath: checkClaims, checks: true, mountChecks: true });
  check(checkClaimMount.report.verdict === 'blocked', 'check claim mount: blocked', checkClaimMount.report.verdict);
  check(checkClaimMount.report.findings.some((f) => f.code === 'claim-check-pending'), 'check claim mount: code');

  await writeCheck(positive, { expect: 'fail' });
  const checkFail = await verify({ projectRoot: positive, claimsPath: checkClaims, checks: true });
  check(checkFail.report.verdict === 'blocked', 'check fail: claim blocks', checkFail.report.verdict);
  check(checkFail.report.checks[0].status === 'fail', 'check fail: status', json(checkFail.report.checks));
  check(checkFail.report.findings.some((f) => f.code === 'check-failed' && f.severity === 'warn'), 'check fail: default warn');
  check(checkFail.report.findings.some((f) => f.code === 'claim-check-failed'), 'check fail: claim code');

  await writeCheck(positive, { expect: 'error' });
  const checkError = await verify({ projectRoot: positive, claimsPath: checkClaims, checks: true });
  check(checkError.report.checks[0].status === 'error', 'check error: status', json(checkError.report.checks));
  check(checkError.report.findings.some((f) => f.code === 'check-error'), 'check error: code');
  check(checkError.report.findings.some((f) => f.code === 'claim-check-error'), 'check error: claim code');

  await writeCheck(positive, { expect: 'timeout', timeoutMs: 1000 });
  const checkTimeout = await verify({ projectRoot: positive, claimsPath: checkClaims, checks: true });
  check(checkTimeout.report.findings.some((f) => f.code === 'check-error' && f.what.includes('exceeded')), 'check timeout: not a pass');

  await writeCheck(positive, { expect: 'incomplete' });
  const checkIncomplete = await verify({ projectRoot: positive, claimsPath: checkClaims, checks: true });
  check(checkIncomplete.report.checks[0].status === 'blocked', 'check incomplete: status blocked', json(checkIncomplete.report.checks));
  check(checkIncomplete.report.findings.some((f) => f.code === 'check-incomplete' && f.severity === 'warn'), 'check incomplete: warn');
  check(checkIncomplete.report.findings.some((f) => f.code === 'claim-check-blocked'), 'check incomplete: claim blocked');
  check(checkIncomplete.report.verdict === 'blocked', 'check incomplete: verdict blocked', checkIncomplete.report.verdict);

  const staleCheckClaims = join(tmp, 'claims-check-stale.json');
  await writeFile(staleCheckClaims, json({ schemaVersion: 1, claims: [
    { kind: 'assembly', statement: 'x', checkId: 'test-check', versionIds: ['v999'] },
  ] }));
  await writeCheck(positive, { expect: 'pass' });
  const checkStale = await verify({ projectRoot: positive, claimsPath: staleCheckClaims, checks: true });
  check(checkStale.report.verdict === 'blocked', 'check stale claim: blocked', checkStale.report.verdict);
  check(checkStale.report.findings.some((f) => f.code === 'claim-check-stale'), 'check stale claim: code');

  await writeCheck(positive, { expect: 'pass', negativeExpect: 'pass' });
  const checkInvalid = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true });
  check(checkInvalid.report.checks[0].status === 'invalid', 'check invalid: status', json(checkInvalid.report.checks));
  check(checkInvalid.report.findings.some((f) => f.code === 'check-invalid'), 'check invalid: code');

  await writeCheck(positive, { expect: 'pass', permissions: ['read:constraints', 'write:artifacts'] });
  const checkWrite = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true });
  check(checkWrite.report.checks[0].status === 'invalid', 'check write:artifacts: invalid', json(checkWrite.report.checks));
  check(checkWrite.report.findings.some((f) => f.code === 'check-invalid' && f.what.includes('write:artifacts')), 'check write:artifacts: reason');

  const blockPolicy = join(tmp, 'policy-custom.json');
  await writeFile(blockPolicy, json({ schemaVersion: 1, mode: 'blocking', blockOn: ['custom-check'] }));
  await writeCheck(positive, { expect: 'fail' });
  const checkBlocked = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true, policyPath: blockPolicy });
  check(checkBlocked.report.verdict === 'blocked', 'check policy: fail blocks', checkBlocked.report.verdict);
  check(checkBlocked.report.findings.some((f) => f.code === 'check-failed' && f.severity === 'blocked'), 'check policy: severity blocked');

  await writeCheck(positive, { expect: 'pass' });
  const checkPassPolicy = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true, policyPath: blockPolicy });
  check(checkPassPolicy.report.verdict === 'pass', 'check policy: pass stays pass', checkPassPolicy.report.verdict);
  check(checkPassPolicy.report.findings.some((f) => f.code === 'check-passed' && f.severity === 'info'), 'check policy: pass stays info');

  const checkHashBefore = checkPassPolicy.report.checks[0].hash;
  const checkAgain = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true });
  check(checkAgain.report.checks[0].hash === checkHashBefore, 'check: hash is stable');

  await cp(join(ROOT, 'examples/checks/fit-clearance'), join(positive, 'checks/fit-clearance'), { recursive: true });
  const sample = await verify({ projectRoot: positive, claimsPath: baseClaims, checks: true });
  check(sample.report.checks.some((c) => c.id === 'fit-clearance' && c.status === 'pass'), 'sample check: pass', json(sample.report.checks));

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
