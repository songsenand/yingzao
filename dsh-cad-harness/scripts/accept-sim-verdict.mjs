// Acceptance for the interference deliverability gate (DESGIGN §21).
//
// The user-visible rule: a mechanism that RUNS but INTERFERES is not
// deliverable. Verified against the REAL simulate_motion + check_assembly
// tools over a real temp project store:
//
//   1. a clean mechanism (no part-part overlap) → status pass, no blocking;
//   2. a mechanism whose parts sweep through each other → status FAIL,
//      `blocking` names the pairs, `deliverability` spells the two ways out;
//   3. the gate chains: check_assembly's motion-clearance citing the FAILING
//      run → hard-violation (the run summary names the interference).
//
//   node scripts/accept-sim-verdict.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cad-simverdict-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'cad-simverdict-work-'));
process.env.DSH_HOME = home;

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { compileStlOnly } = await import('../src/host/compile.ts');

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);

const exec = { agent: { session: { header: { cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  const value = await def.execute(args, exec);
  const blocks = def.finalizeContent ? def.finalizeContent(exec, { value }) : null;
  return { value, blocks };
};
const textOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const project = projectStores(workspace);
const store = project.store;

const runsIndex = async () => JSON.parse(await readFile(join(project.root, 'runs', 'manifest.json'), 'utf8')).runs;

// ── 1. clean mechanism → pass ────────────────────────────────────────────────
const clean = await call('simulate_motion', {
  cycles: 1,
  parts: [
    { name: 'frame', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
    { name: 'slider', bodyType: 'kinematic', position: [30, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
  ],
  joints: [],
  drive: { body: 'frame', axis: [0, 0, 1], omegaRadPerSec: 1 },
  oscillators: [{ body: 'slider', axis: [1, 0, 0], amplitudeMm: 6, periodSec: 2 }],
  cycles: 1,
});
check('clean mechanism (30mm standoff, ±6 slide) → pass, no blocking',
  clean.value.overallStatus === 'pass' && (clean.value.blocking ?? []).length === 0,
  JSON.stringify({ status: clean.value.overallStatus, interference: clean.value.interferenceCount }));

// ── 2. interfering mechanism → FAIL with named pairs ─────────────────────────
const interfering = await call('simulate_motion', {
  cycles: 1,
  parts: [
    { name: 'frame', bodyType: 'fixed', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
    { name: 'slider', bodyType: 'kinematic', position: [0, 0, 0], scadCode: 'cube([10,10,10], center=true);' },
  ],
  joints: [],
  drive: { body: 'frame', axis: [0, 0, 1], omegaRadPerSec: 1 },
  oscillators: [{ body: 'slider', axis: [1, 0, 0], amplitudeMm: 8, periodSec: 2 }],
  cycles: 1,
});
check('interfering mechanism (sweeps THROUGH the frame) → status FAIL',
  interfering.value.overallStatus === 'fail',
  JSON.stringify({ status: interfering.value.overallStatus, interference: interfering.value.interferenceCount }));
check('blocking names the pairs with volume and time',
  (interfering.value.blocking ?? []).length > 0 && /↔/.test(interfering.value.blocking[0]),
  JSON.stringify(interfering.value.blocking));
check('deliverability spells the two ways out (fix geometry / declare intent)',
  /declare|过盈/.test(interfering.value.deliverability ?? '') && /NOT DELIVERABLE/.test(interfering.value.deliverability ?? ''),
  (interfering.value.deliverability ?? '').slice(0, 60));
const committed = (await runsIndex()).at(-1);
check('the committed run carries status fail (the band shows RED)',
  committed?.status === 'fail', JSON.stringify({ status: committed?.status, summary: committed?.summary }));
check('the run summary names the deliverability, not just a number',
  /不可交付/.test(committed?.summary ?? ''), committed?.summary ?? '');
check('the model-facing text carries the ❌ prefix',
  textOf(interfering.blocks).includes('NOT DELIVERABLE') || textOf(interfering.blocks).includes('❌'),
  textOf(interfering.blocks).slice(0, 80));

// ── 3. the gate chains through check_assembly ────────────────────────────────
{
  const basePart = await compileStlOnly('cube([40,40,20]);\ndatum("顶面", [20,20,20]);');
  const topPart = await compileStlOnly('cube([20,20,20]);\ndatum("底面", [20,20,0]);');
  await saveVersion(store, { scadCode: 'cube([40,40,20]);', stl: basePart.stl, userIntent: 'gate base', datumSet: basePart.datumSet });
  await saveVersion(store, { scadCode: 'cube([20,20,20]);', stl: topPart.stl, userIntent: 'gate top', datumSet: topPart.datumSet });

  const failRunId = (await runsIndex()).at(-1).id;
  const manifest = {
    schemaVersion: 1,
    name: 'sim-verdict-gate',
    unit: 'mm',
    up: 'z',
    root: {
      id: 'gate',
      name: '门禁对照',
      kind: 'assembly',
      children: [
        { id: 'base', name: 'gate base', kind: 'part', version: 'v001' },
        { id: 'top', name: 'gate top', kind: 'part', version: 'v002' },
      ],
      interfaces: [{
        id: 'if-motion',
        a: 'base.顶面',
        b: 'top.底面',
        type: '滑动副',
        severity: 'hard',
        layer: 'L1',
        check: 'motion-clearance',
        params: { runId: failRunId },
      }],
    },
  };
  mkdirSync(join(project.root, 'assembly'), { recursive: true });
  const manifestPath = join(project.root, 'assembly', 'gate-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const r = await call('check_assembly', { manifestPath });
  const mc = r.value.skipped.length === 0
    ? [...r.value.hardViolations, ...r.value.intentFlags].find((x) => x.interfaceId === 'if-motion')
    : null;
  check('motion-clearance citing the FAILING run → hard-violation (the gate chains)',
    mc?.verdict === 'hard-violation',
    JSON.stringify({ verdict: mc?.verdict, detail: mc?.detail?.slice(0, 80) }));
  check('the violation detail names the interference, not just "did not pass"',
    /干涉|不可交付/.test(mc?.detail ?? ''), mc?.detail?.slice(0, 100) ?? '');
}

// ── 4. §22 hard gate: a GREEN run over geometry a part has replaced ──────────
{
  const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
  const slab = await compileStlOnly('cube([40,40,20]);\ndatum("顶面", [20,20,20]);');
  const pin = await compileStlOnly('cube([10,10,60], center=true);\ndatum("底面", [0,0,-30]);');

  // Two versions of the SAME part, plus a second part, all properly attached.
  const partA = await ensurePart(project.partStore, '§22 支架', 'agent');
  const a1 = await saveVersion(store, { scadCode: 'cube([40,40,20]);', stl: slab.stl, userIntent: '§22 A v1', datumSet: slab.datumSet, partId: partA.id });
  await attachVersion(project.partStore, partA.id, a1);
  const partB = await ensurePart(project.partStore, '§22 销', 'agent');
  const b1 = await saveVersion(store, { scadCode: 'cube([10,10,60], center=true);', stl: pin.stl, userIntent: '§22 B v1', datumSet: pin.datumSet, partId: partB.id });
  await attachVersion(project.partStore, partB.id, b1);

  // A CLEAN motion run over those versions → status pass, sourceVersionIds set.
  const cleanRun = await call('simulate_motion', {
    cycles: 1,
    parts: [
      { name: 'bracket', versionId: a1, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'pin', versionId: b1, bodyType: 'kinematic', position: [60, 0, 0] },
    ],
    joints: [],
    drive: { body: 'bracket', axis: [0, 0, 1], omegaRadPerSec: 1 },
    oscillators: [{ body: 'pin', axis: [1, 0, 0], amplitudeMm: 3, periodSec: 2 }],
  });
  check('the §22 fixture motion run is GREEN (so the gate is about staleness, not failure)',
    cleanRun.value.overallStatus === 'pass', JSON.stringify(cleanRun.value.overallStatus));
  const greenRunId = (await runsIndex()).at(-1).id;

  // Now the part gets a NEW version → the run above cites geometry that no
  // longer exists. It still says "pass".
  const a2 = await saveVersion(store, { scadCode: 'cube([40,40,22]);', stl: slab.stl, userIntent: '§22 A v2', datumSet: slab.datumSet, partId: partA.id });
  await attachVersion(project.partStore, partA.id, a2);

  const staleManifest = {
    schemaVersion: 1, name: 'sim-verdict-stale', unit: 'mm', up: 'z',
    root: {
      id: 'stale', name: '过期门禁', kind: 'assembly',
      children: [
        { id: 'bracket', name: '§22 支架', kind: 'part', version: a1 },
        { id: 'pin', name: '§22 销', kind: 'part', version: b1 },
      ],
      interfaces: [{
        id: 'if-stale', a: 'bracket.顶面', b: 'pin.底面',
        type: '滑动副', severity: 'hard', layer: 'L1',
        check: 'motion-clearance', params: { runId: greenRunId },
      }],
    },
  };
  const stalePath = join(project.root, 'assembly', 'stale-manifest.json');
  writeFileSync(stalePath, JSON.stringify(staleManifest, null, 2));

  const sr = await call('check_assembly', { manifestPath: stalePath });
  const smc = [...sr.value.hardViolations, ...sr.value.intentFlags].find((x) => x.interfaceId === 'if-stale');
  check('a GREEN run citing a version the part has replaced → hard-violation (the §22 gate)',
    smc?.verdict === 'hard-violation',
    JSON.stringify({ verdict: smc?.verdict, detail: smc?.detail?.slice(0, 90) }));
  check('the violation says STALE and names the superseded version',
    /STALE/.test(smc?.detail ?? '') && (smc?.detail ?? '').includes(a1),
    (smc?.detail ?? '').slice(0, 120));
}


console.log(`\n${fail === 0 ? 'OK' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);
