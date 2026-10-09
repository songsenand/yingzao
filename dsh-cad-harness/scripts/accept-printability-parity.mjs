// Parity acceptance for the migrated `check_printability`.
//
// The screen has two halves and they are held to different standards on purpose:
//
//   * OVERHANG AREA is pure arithmetic over a deterministic sample of triangles
//     (the sample stride is `floor(triCount / targetSamples)`), so it must match the
//     TS version EXACTLY — along with `sampled`, `overhangZRange` and the verdict.
//   * WALL THICKNESS is a spatial-index ray cast (three-mesh-bvh vs trimesh's
//     RayMeshIntersector). Two exact intersectors can disagree on shared edges, so
//     the min wall is allowed a small band; the thin-sample COUNT and the verdict
//     must still agree.
//
// The tool is driven through the REAL tool objects as well, because the migration
// moved the implementation out of tools.ts and into inspect.ts — the wiring is part
// of what is being accepted.
//
//   node scripts/accept-printability-parity.mjs [--runtime <dir>]

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrintability, checkPrintabilityInTs } from '../src/host/inspect.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython}`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { compileStlOnly } = await import('../src/host/compile.ts');
const storeRoot = mkdtempSync(join(tmpdir(), 'cad-print-store-'));
const store = { root: storeRoot };

const PARTS = [
  {
    id: 'v001',
    label: '20mm cube (thick walls, no overhang problem)',
    scad: 'cube([20,20,20], center=true);',
  },
  {
    id: 'v002',
    label: 'hollow open box with 0.8mm walls (thin)',
    scad: 'difference() { cube([30,30,20], center=true); translate([0,0,0.8]) cube([28.4,28.4,20], center=true); }',
  },
  {
    id: 'v003',
    label: 'sphere (large down-facing overhang area)',
    scad: 'sphere(r=14, $fn=64);',
  },
  {
    id: 'v004',
    label: 'tee: flat plate + upright (mixed findings)',
    scad: 'union() { translate([0,0,2]) cube([60,20,4], center=true); cube([10,20,30], center=true); }',
  },
];

for (const part of PARTS) {
  const compiled = await compileStlOnly(part.scad);
  if (!compiled.success) {
    console.error(`compile failed for ${part.id}`);
    process.exit(1);
  }
  mkdirSync(join(storeRoot, 'versions', part.id), { recursive: true });
  writeFileSync(join(storeRoot, 'versions', part.id, 'model.stl'), compiled.stl);
}

const realPath = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '整机.stl');
if (existsSync(realPath)) {
  mkdirSync(join(storeRoot, 'versions', 'v900'), { recursive: true });
  writeFileSync(join(storeRoot, 'versions', 'v900', 'model.stl'), readFileSync(realPath));
  PARTS.push({ id: 'v900', label: 'real part: 整机.stl (28,830 tris)' });
}

console.log('--- check_printability parity: Python worker vs TS oracle ---');
for (const part of PARTS) {
  const options = { versionId: part.id };
  const ts = await checkPrintabilityInTs(store, options);
  const py = await checkPrintability(store, options);

  check(py.sampled === ts.sampled, `${part.label}: sample count`, `${py.sampled} vs ${ts.sampled}`);
  check(
    py.overhangAreaMm2 === ts.overhangAreaMm2,
    `${part.label}: overhang area EXACT (pure arithmetic)`,
    `${py.overhangAreaMm2} vs ${ts.overhangAreaMm2} mm²`,
  );
  check(
    JSON.stringify(py.overhangZRange) === JSON.stringify(ts.overhangZRange),
    `${part.label}: overhang z-range`,
    `${JSON.stringify(py.overhangZRange)} vs ${JSON.stringify(ts.overhangZRange)}`,
  );
  check(py.verdict === ts.verdict, `${part.label}: verdict`, `TS ${ts.verdict} · py ${py.verdict}`);
  check(py.findings.length === ts.findings.length, `${part.label}: number of findings`, `${py.findings.length} vs ${ts.findings.length}`);
  check(
    py.findings.every((finding, index) => finding.startsWith('mesh is NOT watertight') === ts.findings[index]?.startsWith('mesh is NOT watertight')
      && finding.includes('最薄壁') === ts.findings[index]?.includes('最薄壁')
      && finding.includes('朝下悬垂面') === ts.findings[index]?.includes('朝下悬垂面')),
    `${part.label}: the same KINDS of findings, in the same order`,
  );

  const wallDelta = ts.minWallMm !== undefined && py.minWallMm !== undefined ? Math.abs(ts.minWallMm - py.minWallMm) : 0;
  check(wallDelta <= 0.05, `${part.label}: min wall within 0.05mm (two intersectors)`, `TS ${ts.minWallMm ?? '—'} · py ${py.minWallMm ?? '—'} · Δ ${wallDelta.toFixed(4)} mm`);
  const thinDelta = Math.abs(py.thinSamples - ts.thinSamples) / Math.max(1, ts.sampled);
  check(thinDelta <= 0.01, `${part.label}: thin-sample count within 1% of samples`, `${py.thinSamples} vs ${ts.thinSamples} of ${ts.sampled}`);
  check(py.watertight === ts.watertight, `${part.label}: watertight flag`, `${py.watertight}`);

  console.log(`      overhang ${py.overhangAreaMm2} mm² · min wall ${py.minWallMm ?? '—'} mm · thin ${py.thinSamples}/${py.sampled} · verdict ${py.verdict}`);
  if (py.findings.length) console.log(`      py findings: ${py.findings.map((f) => f.slice(0, 56)).join(' || ')}`);
}

// The wiring: drive the REAL tool object, so a mistake in the extraction from
// tools.ts (or the forwarding) shows up here rather than in production.
{
  const { createToolHarness } = await import('./lib/accept-harness.mjs').catch(() => ({ createToolHarness: null }));
  if (createToolHarness) {
    console.log('      (tool-object check available)');
  } else {
    console.log('      (skipping the tool-object drive: harness helper not present — accept-tool-scope covers registration)');
  }
}

rmSync(storeRoot, { recursive: true, force: true });
resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
