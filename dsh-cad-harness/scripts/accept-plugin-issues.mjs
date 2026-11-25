#!/usr/bin/env node
// Acceptance for the 2026-11-21 plugin issue list (Bicycle sessions).
// Pure/unit half: no pinned Python runtime required. Runtime-dependent checks
// (printability edge, motion warm-up, CNC cavities) live in the issue doc and
// are exercised on the real corpora by their repro commands.
//
//   node scripts/accept-plugin-issues.mjs [--only <id>]
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectStores } from '../src/host/project.ts';
import { openVersionStore, saveVersion } from '../src/host/version.ts';
import { ensurePart, attachVersion } from '../src/host/parts.ts';
import { beginRun, retireRun, listRuns } from '../src/host/runs.ts';
import { auditDelivery } from '../src/host/delivery-audit.ts';
import { writeAssembly } from '../src/host/write-assembly.ts';
import { maxRadiusAboutCentre } from '../src/host/turning.ts';
import { buildSolidFromStl } from '../src/host/solidify.ts';
import { writeBinaryStl, parseBinaryStl } from '../src/host/mesh.ts';
import { STANDARD_SPRINGS } from '../src/host/standard-parts.ts';
import { createProjectMarker, setProjectKernel } from '../src/host/project.ts';
import { resolveProcessProfiles } from '../src/host/tools.ts';

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const run = async (id, fn) => {
  if (only && only !== id) return;
  console.log(`\n── ${id} ──`);
  await fn();
};

const boxStl = (dx = 1, dy = 1, dz = 1) => {
  const v = [0, 0, 0, dx, 0, 0, dx, dy, 0, 0, dy, 0, 0, 0, dz, dx, 0, dz, dx, dy, dz, 0, dy, dz];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return writeBinaryStl({ vertProperties: new Float32Array(v), triVerts: new Uint32Array(t) });
};

const tmpProject = async (name) => {
  const root = await mkdtemp(join(tmpdir(), `cad-issue-${name}-`));
  await mkdir(join(root, 'cad-data'), { recursive: true });
  const project = projectStores(root);
  return { root, project };
};

await run('I01-retire', async () => {
  const { root, project } = await tmpProject('retire');
  try {
    const r = await beginRun(project.runStore, { kind: 'motion', title: 'old failure' });
    await r.commit({ status: 'fail', judgement: 'excluded', summary: 'old geometry collided', sourceVersionIds: [] });
    const before = await auditDelivery(project, { scanPaths: [], visualReview: 'off' });
    check(before.findings.some((f) => f.code.startsWith('latest-motion-failing')), 'a live failing run blocks the audit');
    await retireRun(project.runStore, r.id, { reason: 'geometry replaced; kept as history' });
    const after = await auditDelivery(project, { scanPaths: [], visualReview: 'off' });
    check(!after.findings.some((f) => f.severity === 'blocked' && f.code.includes('failing')), 'retired run no longer blocks', JSON.stringify(after.findings.filter((f) => f.severity === 'blocked')));
    check(after.runs.retired.length === 1 && after.runs.retired[0].reason.includes('replaced'), 'retirement reason is recorded and visible');
    const runs = await listRuns(project.runStore);
    check(runs.length === 1 && runs[0].retiredAt !== undefined, 'the run and its artifacts are still readable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await run('I11-stale-failure-not-current', async () => {
  const { root, project } = await tmpProject('stale');
  try {
    const part = await ensurePart(project.partStore, 'bracket');
    const v1 = await saveVersion(project.store, { scadCode: 'cube(1);', stl: boxStl(1, 1, 1), userIntent: 'v1', partId: part.id, backend: { kernel: 'openscad' } });
    const v2 = await saveVersion(project.store, { scadCode: 'cube(2);', stl: boxStl(2, 2, 2), userIntent: 'v2', partId: part.id, backend: { kernel: 'openscad' }, parentVersion: v1 });
    await attachVersion(project.partStore, part.id, v1);
    await attachVersion(project.partStore, part.id, v2);
    const r = await beginRun(project.runStore, { kind: 'printability', title: 'old screen' });
    await r.commit({ status: 'fail', judgement: 'excluded', summary: 'old geometry', sourceVersionIds: [v1] });
    const audit = await auditDelivery(project, { scanPaths: [], visualReview: 'off' });
    const row = audit.runs.failing.find((f) => f.id === r.id);
    check(row && row.current === false, 'a failure whose only cited version is superseded is not current', JSON.stringify(row));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await run('I02-contract-top-level', async () => {
  const { root, project } = await tmpProject('contract');
  try {
    const res = await writeAssembly(project, {
      mode: 'create',
      root: { id: 'root', kind: 'assembly', name: 'demo', children: [] },
      manufacturing: { allowed: [{ id: 'cnc-3axis' }], approvedBy: 'user', approvedAt: '2026-11-21' },
      claims: [{ kind: 'motion', statement: 'the linkage indexes three positions' }],
    });
    const saved = JSON.parse(await readFile(res.manifestPath, 'utf8'));
    check(saved.manufacturing?.approvedBy === 'user', 'manufacturing policy survives the writer', JSON.stringify(saved.manufacturing));
    check(saved.claims?.[0]?.kind === 'motion', 'claims survive the writer', JSON.stringify(saved.claims));
    await writeAssembly(project, {
      mode: 'merge', expectedHash: res.manifestHash,
      root: { id: 'root', children: [] },
    });
    const afterMerge = JSON.parse(await readFile(res.manifestPath, 'utf8'));
    check(afterMerge.manufacturing?.approvedBy === 'user' && afterMerge.claims?.length === 1,
      'a root-only merge preserves top-level manufacturing/claims');
    const audit = await auditDelivery(project, { manifestPath: res.manifestPath, scanPaths: [], visualReview: 'off' });
    check(audit.findings.some((f) => f.code === 'claim-without-evidence'),
      'audit reads the claims PERSISTED in the contract (no per-call claims argument)', JSON.stringify(audit.findings.filter((f) => f.code.includes('claim'))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await run('I03-turning-axis', async () => {
  // A 10×10 box modelled at (50,50): its own spindle radius is 7.07, the world
  // distance is 70.7. The screen must report the former.
  const verts = new Float32Array([
    50, 50, 0, 60, 50, 0, 60, 60, 0, 50, 60, 0,
    50, 50, 10, 60, 50, 10, 60, 60, 10, 50, 60, 10,
  ]);
  const d = 2 * maxRadiusAboutCentre(verts, [55, 55, 5], 'z');
  check(Math.abs(d - 14.142) < 0.01, 'turning radius is about the bbox centre, not the world origin', `Ø${d.toFixed(3)}`);
  const world = 2 * maxRadiusAboutCentre(verts, [0, 0, 5], 'z');
  check(world > 100, 'the old world-axis reading really was ~141 (regression witness)', `Ø${world.toFixed(1)}`);
});

await run('I04-validate-pose', async () => {
  const stl = boxStl(1, 1, 1);
  const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
  const R = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  const built = await buildSolidFromStl(stl, { matrix: R, matrixTranslate: [10, -10, 0] }, parseBinaryStl);
  const bb = built.solid.boundingBox();
  const near = (a, b) => Math.abs(a - b) < 0.01;
  check(near(bb.min[0], 9) && near(bb.max[0], 10) && near(bb.min[1], -10) && near(bb.max[1], -9),
    'pose rotates about the datum point, not the origin', JSON.stringify(bb));
});

await run('I05-spring-metadata', async () => {
  const s = STANDARD_SPRINGS['din2098.1.2x12x30'];
  check(!!s && s.stiffnessNPerMm > 1 && s.solidHeightMm > 0, 'DIN 2098 spring has a rate + solid height', JSON.stringify(s));
  check(s?.source === 'estimated', 'the rate is marked estimated, not measured');
});

await run('I06-kernel-switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cad-issue-kernel-'));
  try {
    await createProjectMarker(root, 'switch', 'openscad');
    const res = await setProjectKernel(root, 'cadquery');
    const marker = JSON.parse(await readFile(join(root, 'cad-data', 'project.json'), 'utf8'));
    check(res.previous === 'openscad' && marker.defaultKernel === 'cadquery', 'an existing project can switch kernel in place', JSON.stringify(res));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await run('I07-project-profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cad-issue-profile-'));
  try {
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'shop-cnc.json'), JSON.stringify({
      schemaVersion: 1, id: 'shop-cnc', process: 'CNC-3axis',
      rules: {
        wallMinMm: { applies: true, decidable: 'geometry', value: 0.8, direction: 'min', source: { kind: 'assumed' } },
        overhangDeg: { applies: false, decidable: 'not-decidable', reason: 'CNC has no print overhang' },
      },
    }));
    const resolved = await resolveProcessProfiles({ profileIds: ['shop-cnc'] }, [join(root, 'profiles')]);
    check(resolved.errors.length === 0 && resolved.profiles[0]?.id === 'shop-cnc', 'a project-local profile resolves by id', JSON.stringify(resolved.errors));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await run('I08-affected', async () => {
  const { root, project } = await tmpProject('affected');
  try {
    const part = await ensurePart(project.partStore, 'bracket');
    const v = await saveVersion(project.store, { scadCode: 'cube(1);', stl: boxStl(1, 1, 1), userIntent: 'bracket', partId: part.id, backend: { kernel: 'openscad' } });
    await attachVersion(project.partStore, part.id, v);
    const { affectedChecks } = await import('../src/host/delivery-audit.ts');
    const before = await affectedChecks(project);
    check(before.parts[0]?.next.some((n) => n.tool === 'check_printability'), 'a new version with no printability run is scheduled for one', JSON.stringify(before.parts[0]?.next));
    const r = await beginRun(project.runStore, { kind: 'printability', title: 'screen' });
    await r.commit({ status: 'pass', judgement: 'not-excluded', summary: 'ok', sourceVersionIds: [v] });
    const after = await affectedChecks(project);
    check(after.parts[0]?.freshKinds.includes('printability') && after.parts[0]?.next.length === 0, 'the fresh run clears the scheduled check', JSON.stringify(after.parts[0]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await run('I10-cq-snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cad-issue-snapshot-'));
  try {
    await mkdir(join(root, 'cq'), { recursive: true });
    await writeFile(join(root, 'cq', 'part.py'), 'result = "the original source"\n');
    const store = openVersionStore(join(root, 'cad-data'));
    const loader = `exec(open('${join(root, 'cq', 'part.py')}').read(), globals())\n`;
    const v = await saveVersion(store, {
      sourceCode: loader, sourceFile: 'model.py', backend: { kernel: 'cadquery' },
      stl: boxStl(1, 1, 1), userIntent: 'loader version', partId: 'p1',
    });
    const stored = await readFile(join(store.root, 'versions', v, 'model.py'), 'utf8');
    const dep = await readFile(join(store.root, 'versions', v, 'source-deps', 'part.py'), 'utf8');
    check(dep.includes('the original source'), 'the loader dependency is copied into the version');
    check(stored.includes("source-deps") && !stored.includes(join(root, 'cq', 'part.py')),
      'the stored loader points at the snapshot, not the mutable workspace file', stored.replace(/\n/g, ' '));
  } finally { await rm(root, { recursive: true, force: true }); }
});



if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nOK');
