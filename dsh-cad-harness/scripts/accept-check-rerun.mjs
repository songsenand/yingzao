// U14 acceptance — "re-run this check on the CURRENT version", and the honest
// refusals that go with it.
//
// The run store keeps the ANSWER, not the question: `run.json` carries kind,
// versions and a summary subject, never the request. So this suite checks three
// things a one-click re-run must get right:
//
//   1. `current` is the newest version of the PART (append order, not id order);
//   2. kinds whose inputs the corpus cannot rebuild are REFUSED, naming the
//      missing inputs — never executed with defaults;
//   3. a direct kind pins the run to the current version.
//
// Part 3 is exercised end to end: a fixture project with one version is screened
// through the same job the tool uses, and the resulting run must cite that version.
//
//   node scripts/accept-check-rerun.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canExecute, currentVersionOf, planCheckRerun } from '../src/host/check-rerun.ts';
import { openVersionStore, listVersions } from '../src/host/version.ts';
import { openRunStore, listRuns } from '../src/host/runs.ts';
import { apply } from '../src/host/index.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SAMPLE_STL = join(REPO, 'examples', 'microscope5', 'cad-data', 'versions', 'v005', 'model.stl');

console.log('check re-run acceptance\n');

// ── 1. "current" is the newest version of the part, in store order ─────────
{
  const versions = [
    { id: 'v001', partId: 'p001' }, { id: 'v002', partId: 'p001' },
    { id: 'v009', partId: 'p002' }, { id: 'v010', partId: 'p002' }, { id: 'v011', partId: 'p002' },
  ];
  check(currentVersionOf(versions) === 'v011', 'the newest overall is current', currentVersionOf(versions));
  check(currentVersionOf(versions, 'p001') === 'v002', 'per part, the newest of THAT part is current',
    String(currentVersionOf(versions, 'p001')));
  check(currentVersionOf(versions, 'nope') === null, 'an unknown part has no current version');
  // Order is append order, not lexical: v9 > v10 lexically but v010 came later.
  const lexicalTrap = [{ id: 'v9', partId: 'p' }, { id: 'v10', partId: 'p' }];
  check(currentVersionOf(lexicalTrap) === 'v10', 'ids are compared by store order, not by string',
    currentVersionOf(lexicalTrap));
}

// ── 2. the classification: derivable vs needs-args vs unavailable ──────────
{
  const source = {
    versions: [{ id: 'v001', partId: 'p001' }, { id: 'v002', partId: 'p001' }],
    runs: [
      { id: 'r001', kind: 'printability', sourceVersionIds: ['v001'] },
      { id: 'r002', kind: 'stress', sourceVersionIds: ['v001'] },
    ],
    hasManifest: true,
  };
  const plans = planCheckRerun(source);
  const by = (kind) => plans.find((plan) => plan.kind === kind);
  check(by('printability')?.mode === 'direct', 'printability is re-runnable from the version alone');
  check(by('printability')?.currentVersionId === 'v002', 'and it targets the CURRENT version',
    by('printability')?.currentVersionId);
  check(by('assembly-check')?.mode === 'direct', 'assembly-check is re-runnable from the manifest');
  for (const kind of ['stress', 'motion', 'physics']) {
    const plan = by(kind);
    check(plan?.mode === 'needs-args', `${kind} is refused, not defaulted`, plan?.mode);
    check(Array.isArray(plan?.needs) && plan.needs.length > 0, `${kind} names what is missing`,
      (plan?.needs ?? []).join(','));
  }
  check(by('stress')?.lastRunId === 'r002', 'the refusal points at the last run of that kind',
    String(by('stress')?.lastRunId));
  check(by('motion')?.lastRunId === null, 'and says so when there is none');

  const noManifest = planCheckRerun({ ...source, hasManifest: false });
  check(noManifest.find((plan) => plan.kind === 'assembly-check')?.mode === 'unavailable',
    'with no assembly manifest, assembly-check is unavailable (not silently skipped)');

  const noVersions = planCheckRerun({ versions: [], runs: [], hasManifest: true });
  check(noVersions.find((plan) => plan.kind === 'printability')?.mode === 'unavailable',
    'with no versions, printability is unavailable');

  // canExecute is the gate the route uses.
  const stress = by('stress');
  const verdict = canExecute(stress);
  check(verdict.ok === false && verdict.needs.includes('material'), 'canExecute refuses and returns machine-readable needs',
    JSON.stringify(verdict));
  check(stress.mode === 'needs-args' && /keeps the answer, not the question/.test(stress.note),
    'the refusal explains WHY the inputs are gone', stress.note);
}

// ── 3. the route: a direct kind runs, an arg kind is refused with needs ───
{
  const root = mkdtempSync(join(tmpdir(), 'cad-rerun-'));
  const data = join(root, 'cad-data');
  mkdirSync(join(data, 'versions', 'v001'), { recursive: true });
  copyFileSync(SAMPLE_STL, join(data, 'versions', 'v001', 'model.stl'));
  writeFileSync(join(data, 'versions', 'v001', 'meta.json'), JSON.stringify({
    schemaVersion: 1, id: 'v001', partId: 'p001', timestamp: new Date().toISOString(),
    backend: 'openscad', status: 'ok', userIntent: 'fixture for U14', artifacts: { stl: 'model.stl' },
  }, null, 2));

  const routes = new Map();
  const connection = { fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } };
  const ctx = {
    connection,
    reflect: { get: (key) => (key === 'connection' ? connection : undefined), set: () => {} },
    tools: { register() { return () => {}; }, restrict() {} },
    attachments: {},
    on() { return () => {}; },
    effect(fn) { try { fn(); } catch { /* startup effects are not under test */ } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  apply(ctx, { toolScope: 'all' });
  const rerun = routes.get('/api/cad/check/rerun');
  check(Boolean(rerun), 'the re-run route is registered');
  if (rerun) {
    const post = (body) => rerun.fetch(new Request(
      `http://x/api/cad/check/rerun?project=${encodeURIComponent(root)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    ));

    // The plan list (no kind) is what the panel renders before a click.
    const listed = await post({});
    const plans = await listed.json();
    check(Array.isArray(plans.plans) && plans.plans.length === 5, 'the route lists all five kinds', String(plans.plans?.length));
    check(plans.plans.find((plan) => plan.kind === 'printability')?.mode === 'direct',
      'printability is offered as direct');

    // A refused kind answers 409 with machine-readable needs — not a run.
    const refused = await post({ kind: 'stress' });
    const refusedBody = await refused.json();
    check(refused.status === 409, 'a needs-args kind is refused with 409', String(refused.status));
    check(refusedBody.refused === true && Array.isArray(refusedBody.needs) && refusedBody.needs.includes('loads'),
      'and names the missing inputs', JSON.stringify(refusedBody.needs));
    const runsAfterRefusal = await listRuns(openRunStore(data));
    check(runsAfterRefusal.length === 0, 'REFUSING CREATES NO RUN (no default-argument ghost)',
      String(runsAfterRefusal.length));

    // A direct kind really runs, on the current version.
    const ran = await post({ kind: 'printability' });
    const ranBody = await ran.json();
    check(ran.status === 200 && Boolean(ranBody.runId), 'printability re-runs and returns its run id',
      `${ran.status} ${JSON.stringify(ranBody)}`);
    check(ranBody.versionId === 'v001', 'pinned to the current version', String(ranBody.versionId));
    const runs = await listRuns(openRunStore(data));
    const latest = runs.at(-1);
    check(latest?.kind === 'printability', 'the run is recorded as printability', latest?.kind);
    check(JSON.stringify(latest?.sourceVersionIds) === JSON.stringify(['v001']),
      'and cites the version it screened', JSON.stringify(latest?.sourceVersionIds));
    check(runs.length === 1, 'exactly one run was created by one click', String(runs.length));
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\naccept-check-rerun: ${failures} FAILURE(S)` : '\naccept-check-rerun: PASS');
process.exit(failures ? 1 : 0);
