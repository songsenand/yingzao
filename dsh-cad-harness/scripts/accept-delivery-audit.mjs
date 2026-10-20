// Acceptance for delivery_audit (DESIGN §23).
//
// The primary case is the REAL microscope5 corpus: every finding below was
// measured independently (runs/versions analysis) before the tool existed, so
// the tool has to reproduce those numbers — this is ground truth, not a fixture
// that was written to match the implementation.
//
//   node scripts/accept-delivery-audit.mjs [path-to-project-dir]

import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditDelivery } from '../src/host/delivery-audit.ts';
import { projectStores } from '../src/host/project.ts';

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
  const { compileStlOnly } = await import('../src/host/compile.ts');
  const { beginRun } = await import('../src/host/runs.ts');

  const project = projectStores(workspace);
  const partA = await ensurePart(project.partStore, '支架', 'agent');
  const cube = await compileStlOnly('cube([10,10,10], center=true);\\ndatum("角点", [5,5,5]);');
  const v1 = await saveVersion(project.store, {
    scadCode: 'cube([10,10,10], center=true);', stl: cube.stl, userIntent: 'clean v1',
    datumSet: cube.datumSet, partId: partA.id,
  });
  await attachVersion(project.partStore, partA.id, v1);

  // One GREEN run over that newest version.
  const run = await beginRun(project.runStore, {
    kind: 'physics', title: 'clean physics', sourceVersionIds: [v1],
  });
  await run.commit({ status: 'pass', summary: 'stable', hasGeometry: false, sourceVersionIds: [v1] });

  // A contract with a motion interface, so no "contract without motion" flag.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(workspace, 'assembly'), { recursive: true });
  writeFileSync(join(workspace, 'assembly', 'assembly.json'), JSON.stringify({
    schemaVersion: 1, name: 'clean', unit: 'mm', up: 'z',
    root: {
      id: 'root', name: 'clean', kind: 'assembly',
      children: [{ id: 'a', name: '支架', kind: 'part', version: v1 }],
      interfaces: [{
        id: 'if-motion', a: '支架.角点', b: '支架.角点', type: '滑动副',
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
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
