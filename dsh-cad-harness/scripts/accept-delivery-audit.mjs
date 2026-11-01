// Acceptance for delivery_audit (DESIGN §23).
//
// The primary case is the REAL microscope5 corpus: every finding below was
// measured independently (runs/versions analysis) before the tool existed, so
// the tool has to reproduce those numbers — this is ground truth, not a fixture
// that was written to match the implementation.
//
//   node scripts/accept-delivery-audit.mjs [path-to-project-dir]

import { existsSync, mkdtempSync, rmSync as rmVisualSidecar } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditDelivery } from '../src/host/delivery-audit.ts';
import { projectStores } from '../src/host/project.ts';
import { recordVisualReview } from '../src/host/visual-review.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. the real microscope5 corpus ───────────────────────────────────────────
const m5 = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', 'examples', 'microscope5'));
if (!existsSync(join(m5, 'cad-data', 'runs', 'manifest.json'))) {
  console.log(`SKIP  microscope5 corpus not found at ${m5}`);
} else {
  const report = await auditDelivery(projectStores(m5));
  const codes = new Set(report.findings.map((f) => f.code));
  console.log(`      verdict=${report.verdict} findings=${report.findings.length} summary: ` +
    `${report.versions.total}v/${report.parts.total}p/${report.runs.total}r stale=${report.runs.stale.length}`);

  check(report.verdict === 'excluded', 'microscope5 audits as EXCLUDED (a witness contradicts it)', report.verdict);
  check(report.parts.newestNeverValidated.length === 0,
    'every part\'s newest version WAS cited by some run (so the audit stays silent here)',
    `${report.parts.newestNeverValidated.length} flagged`);
  check(report.runs.latestByKind.assembly?.status === 'fail',
    'it also sees the newest ASSEMBLY run is red (19/19 assembly runs failed)',
    JSON.stringify(report.runs.latestByKind.assembly));
  check(report.runs.failing.some((r) => r.kind === 'motion') && codes.has('latest-motion-failing'),
    'it finds the FAILING latest motion run (the mechanism that shipped red)',
    JSON.stringify(report.runs.latestByKind.motion));
  check(report.runs.stale.length >= 60,
    'it reports the stale-evidence flood (≥60 of 69 runs)',
    `${report.runs.stale.length}/${report.runs.total}`);
  check(report.versions.neverCited.length >= 20,
    'it counts the versions no run ever cited (≥20 of 83)',
    `${report.versions.neverCited.length}/${report.versions.total}`);
  check(codes.has('contract-without-motion'),
    'it says the contract has NO motion-clearance interface (mechanism not contracted)',
    JSON.stringify(report.contract.byCheck));
  check(report.contract.geometryNewerThanCheck === true,
    'it notices geometry newer than the newest contract check (v083 after r068)');
  check(report.runs.duplicateGroups.length >= 5,
    'it reports repeated runs that added no information',
    `${report.runs.duplicateGroups.length} groups`);

  // The delivery document's own table is stale — the audit's numbers agree with
  // the independent analysis of it (6/15 delivered parts were not newest).
  const summary = await readFile(join(m5, 'execution_summaries', '20261004_feat_m1_m4_final_delivery.md'), 'utf8')
    .catch(() => '');
  const claimedRange = /版本区间：v(\d+)\s*…\s*v(\d+)/.exec(summary);
  check(Boolean(claimedRange) && Number(claimedRange[2]) < Number(String(report.versions.newest).replace(/\D/g, '')),
    'the delivery document claims a version range that ENDS BEFORE the corpus does',
    claimedRange ? `doc ends at v${claimedRange[2]}, corpus newest ${report.versions.newest}` : '(range not found)');
}

// ── 2. a healthy corpus must NOT be blocked (no crying wolf) ─────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'cad-audit-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'cad-audit-work-'));
  process.env.DSH_HOME = home;
  const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
  const { saveVersion } = await import('../src/host/version.ts');
  const { beginRun } = await import('../src/host/runs.ts');

  // A binary STL cube, written here so this acceptance does not need the Python
  // runtime (compileStlOnly does; section 2 must stay runnable on a bare checkout).
  const cubeStl = (size) => {
    const h = size / 2;
    const v = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
    const faces = [
      [0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
      [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7],
    ];
    const buf = Buffer.alloc(84 + 12 * 50);
    buf.write('dsh audit cube fixture', 0);
    buf.writeUInt32LE(12, 80);
    let o = 84;
    for (const [i, j, k] of faces) {
      const a = v[i], b = v[j], c = v[k];
      const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
      const w = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
      let n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
      const len = Math.hypot(...n) || 1;
      n = n.map((x) => x / len);
      for (const p of [n, a, b, c]) for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
      o += 2;
    }
    return buf;
  };

  const project = projectStores(workspace);
  const partA = await ensurePart(project.partStore, '支架', 'agent');
  const v1 = await saveVersion(project.store, {
    scadCode: 'cube([10,10,10], center=true);', stl: cubeStl(10), userIntent: 'clean v1',
    datums: [{ name: '角点', point: [5, 5, 5] }], partId: partA.id,
  });
  await attachVersion(project.partStore, partA.id, v1);
  // The delivery gate is per-version: a clean corpus needs a fresh top+iso
  // review, not just a green run.
  await recordVisualReview({
    store: project.store, versionId: v1, views: ['top', 'iso'],
    note: 'reviewed the clean cube: six faces, no notch, no thin wall', source: 'review_visual',
  });

  // One GREEN run over that newest version.
  const run = await beginRun(project.runStore, {
    kind: 'physics', title: 'clean physics', sourceVersionIds: [v1],
  });
  await run.commit({ status: 'pass', summary: 'stable', hasGeometry: false, sourceVersionIds: [v1] });

  // A contract with a motion interface, so no "contract without motion" flag.
  const { mkdirSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  mkdirSync(join(workspace, 'assembly'), { recursive: true });
  writeFileSync(join(workspace, 'assembly', 'assembly.json'), JSON.stringify({
    schemaVersion: 1, name: 'clean', unit: 'mm', up: 'z',
    root: {
      id: 'root', name: 'clean', kind: 'assembly',
      children: [{ id: 'a', name: '支架', kind: 'part', version: v1 }],
      interfaces: [{
        // Endpoints are "<DIRECT childId>.<datum>" — the child id is 'a', not the part
        // name. This fixture was invalid all along and the audit's silent `catch` hid it
        // (2026-10-23 audit, FIX-B4): the "clean corpus" was only clean because its
        // contract had been thrown away. Now that an unreadable manifest is a finding,
        // the fixture has to be a manifest that actually parses.
        id: 'if-motion', a: 'a.角点', b: 'a.角点', type: '滑动副',
        severity: 'intent', layer: 'L1', check: 'motion-clearance', params: {},
      }],
    },
  }, null, 2));

  const clean = await auditDelivery(projectStores(workspace), { manifestPath: join(workspace, 'assembly', 'assembly.json') });
  check(clean.verdict === 'not-excluded',
    'a clean corpus (newest version validated, green run) is NOT blocked',
    `${clean.verdict}: ${clean.findings.map((f) => f.code).join(', ') || '(no findings)'}`);
  check(!clean.parts.newestNeverValidated.includes('支架'),
    'the clean part is not flagged as unvalidated');

  // The visual gate must be able to say NO: remove the record and the same clean
  // corpus becomes undeliverable. This is the wind-up-frog failure in one fixture.
  rmVisualSidecar(join(project.store.root, 'versions', v1, 'visual-review.json'));
  const unreviewed = await auditDelivery(projectStores(workspace), { manifestPath: join(workspace, 'assembly', 'assembly.json') });
  check(unreviewed.findings.some((f) => f.code === 'visual-review-missing' && f.severity === 'blocked'),
    'a delivered version with NO visual review blocks delivery',
    unreviewed.findings.map((f) => `${f.severity}/${f.code}`).join(', '));
  await recordVisualReview({
    store: project.store, versionId: v1, views: ['top', 'iso'],
    note: 'reviewed the clean cube: six faces, no notch, no thin wall', source: 'review_visual',
  });

  // ── 3. a finished part written straight to disk is BLOCKED ─────────────────
  //
  // This is the 2026-10-21 case: the deliverable exists as an STL, the panel
  // and every tool need a versionId, and nobody registered it. The audit has
  // to name it — silence here is exactly how a human ends up unable to see
  // what the model produced.
  const manifestPath = join(workspace, 'assembly', 'assembly.json');
  mkdirSync(join(workspace, 'out'), { recursive: true });
  const stray = join(workspace, 'out', 'disk-45.stl');
  writeFileSync(stray, cubeStl(7));
  const future = new Date(Date.now() + 60_000);
  utimesSync(stray, future, future);

  const withStray = await auditDelivery(projectStores(workspace), { manifestPath });
  check(withStray.verdict === 'excluded',
    'a mesh NEWER than the newest version, with no version, blocks delivery',
    `${withStray.verdict}: ${withStray.findings.map((f) => `${f.severity}/${f.code}`).join(', ')}`);
  check(withStray.findings.some((f) => f.code === 'unregistered-geometry' && f.severity === 'blocked'),
    'and the finding names the unregistered geometry');
  check(withStray.unregistered.files.some((f) => f.path === 'out/disk-45.stl' && f.severity === 'blocked'),
    'the file appears with its workspace-relative path',
    JSON.stringify(withStray.unregistered.files));

  // The scan is a declared scope, not an unbounded sweep: [] turns it off for a
  // caller that has already accounted for its outputs another way.
  const disabled = await auditDelivery(projectStores(workspace), { manifestPath, scanPaths: [] });
  check(disabled.unregistered.files.length === 0 && disabled.verdict === 'not-excluded',
    'scanPaths: [] disables the scan (an explicit opt-out, not a silent one)',
    `${disabled.verdict}: ${disabled.findings.map((f) => f.code).join(', ')}`);

  // A declared exception is the sanctioned way to keep a file outside the
  // corpus (bought/reference geometry): it must clear the block and echo why.
  const exempted = await auditDelivery(projectStores(workspace), {
    manifestPath,
    exempt: [{ path: 'out/disk-45.stl', reason: 'vendor reference geometry' }],
  });
  check(!exempted.findings.some((f) => f.code === 'unregistered-geometry'),
    'a declared exemption clears the block (it is a decision, not a silent pass)',
    exempted.findings.map((f) => f.code).join(', '));
  check(exempted.unregistered.exempt.length === 1 &&
    exempted.unregistered.exempt[0].path === 'out/disk-45.stl' &&
    exempted.unregistered.exempt[0].reason === 'vendor reference geometry',
  'the exemption and its reason are echoed', JSON.stringify(exempted.unregistered.exempt));

  // A file OLDER than the newest version predates this design: warn, do not block.
  const old = new Date('2000-01-01T00:00:00Z');
  utimesSync(stray, old, old);
  const withOld = await auditDelivery(projectStores(workspace), { manifestPath });
  check(withOld.verdict === 'difficult' && withOld.unregistered.files[0]?.severity === 'warn',
    'an unregistered file that predates the newest version warns, and does not block',
    `${withOld.verdict}: ${JSON.stringify(withOld.unregistered.files)}`);

  rmSync(stray);
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
