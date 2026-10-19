// Acceptance for `simulate_stress` (DECISION-LOG 2026-10-19).
//
// WHAT IS BEING ACCEPTED:
//   1. the solver reproduces beam theory on the cantilever (the 2026-10-08 probe's
//      numbers, re-measured here rather than quoted) — deflection, and the integral
//      half (section moment);
//   2. the self-checks that do not need the answer to be right: equilibrium residual
//      and strain-energy balance are machine-precision;
//   3. the surface stress recovered by the depth-profile extrapolation lands within
//      the band the hole-Kt probe established, and the fit says so (R^2);
//   4. "the largest element stress" IS NOT A RESULT: the field payload carries no such
//      quantity, and the tool face never forwards the debug value. The assertion reads
//      the tool's own source, because the point is the interface, not the number;
//   5. the honesty half, on a REAL part: the toy-balance beam's members are thinner
//      than the voxel, so the tool must REFUSE to certify a hot spot (drifting, zero
//      trustworthy regions) while its integrals still match hand analysis. A verifier
//      that cannot fail this way would happily draw an authoritative wrong heatmap.
//
//   node scripts/accept-stress.mjs [--python <venv python>]

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PYTHON = argOf('--python', join(ROOT, '.tmp-cad-runtime/venv/bin/python'));

let passed = 0;
let failed = 0;
function check(ok, label, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

if (!existsSync(PYTHON)) {
  console.error(`no interpreter at ${PYTHON} (pass --python <venv python>)`);
  process.exit(2);
}

console.log(`simulate_stress acceptance (${PYTHON})`);
const raw = execFileSync(PYTHON, [join(HERE, 'stress-selftest.py')], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const out = JSON.parse(raw);

// --- 1. cantilever vs beam theory ------------------------------------------
const c = out.cantilever;
console.log(`\ncantilever dx=${c.dxMm}mm, ${c.solidCells} solid cells`);
check(c.deltaErrPct <= 0 && c.deltaErrPct > -6,
  'tip deflection within the probe band (0 .. -6%)', `${c.deltaErrPct.toFixed(2)}% (ref ${c.deltaRefMm.toFixed(4)}mm)`);
const momentErr = 100 * (c.momentNmm - c.momentRefNmm) / c.momentRefNmm;
check(Math.abs(momentErr) < 3,
  'section moment at mid-span matches F*L/2', `${c.momentNmm} vs ${c.momentRefNmm} (${momentErr.toFixed(2)}%)`);

// --- 2. self-checks -------------------------------------------------------
check(c.equilibriumErrorPct < 1e-4, 'equilibrium residual is machine-precision', `${c.equilibriumErrorPct.toExponential(1)}%`);
check(c.energyBalancePct < 1e-4, 'strain energy balances the external work', `${c.energyBalancePct.toExponential(1)}%`);

// --- 3. surface extrapolation --------------------------------------------
check(c.surfaceExtrapolatedMPa !== null,
  'a region carries an extrapolated surface stress', `${c.surfaceExtrapolatedMPa} MPa`);
if (c.surfaceExtrapolatedMPa !== null) {
  const err = 100 * (c.surfaceExtrapolatedMPa - c.sigmaRefMPa) / c.sigmaRefMPa;
  check(Math.abs(err) < 10, 'extrapolated surface within 10% of beam theory',
    `${c.surfaceExtrapolatedMPa} vs ${c.sigmaRefMPa} (${err.toFixed(2)}%)`);
  check((c.surfaceFitR2 ?? 0) >= 0.8, 'the depth fit is linear enough to extrapolate', `R^2 ${c.surfaceFitR2}`);
}

// --- 4. the forbidden quantity -------------------------------------------
console.log('\ninterface: "the largest element stress" must not be a result');
check(c.boundaryMaxMPa > c.peakDeclaredDepthMPa,
  'the boundary maximum differs from the declared-distance reading',
  `boundary ${c.boundaryMaxMPa} vs declared ${c.peakDeclaredDepthMPa}`);
check(c.fieldLayer.length === 1 && c.fieldLayer[0] === 'von-mises',
  'the field payload carries one honest quantity', c.fieldLayer.join(','));
const fieldHasMax = JSON.stringify(c.fieldNormalization).includes('max');
check(!fieldHasMax, 'the field normalization declares no "max" quantity');
const toolSrc = readFileSync(join(ROOT, 'src/host/tools.ts'), 'utf8');
const start = toolSrc.indexOf("name: 'simulate_stress'");
const end = toolSrc.indexOf('registerTool(defineTool({', start);
const block = toolSrc.slice(start, end > 0 ? end : undefined);
check(!/maxVonMises/.test(block), 'the tool face never forwards the debug boundary maximum');
check(/DO NOT ASK IT FOR "the largest element stress"/.test(block),
  'the tool description states the boundary at call time');
check(/cannotReport/.test(block) && /a safety factor/.test(block),
  'the capability block spells out what may not be claimed');

// --- 5. the honesty half on the real part --------------------------------
const b = out.toyBalanceBeam;
if (!b) {
  // `examples/*/cad-data/` is gitignored, so on a fresh clone the corpus is absent and
  // this case CANNOT run. Skipping is the honest outcome; failing would make the nail
  // red for a reason that has nothing to do with the solver.
  console.log('\n  SKIP  toy-balance beam case — examples/*/cad-data/ is gitignored, corpus not in the repo');
} else {
  console.log(`\ntoy-balance beam v050 dx=${b.dxMm}mm (members ~1.2mm thick)`);
  const mErr = 100 * (b.momentPlus40 - b.momentRefNmm) / b.momentRefNmm;
  check(Math.abs(mErr) < 5, 'beam section moment matches hand analysis away from the support',
    `${b.momentPlus40} vs ${b.momentRefNmm} N*mm (${mErr.toFixed(2)}%), A=${b.sectionAreaMm2}mm^2 I_z=${b.sectionIzMm4}mm^4`);
  check(Math.abs(b.momentPlus40 - b.momentMinus40) < 1e-6, 'the two symmetric cuts agree');
  check(Math.abs(b.shearPlus40 - b.shearRefN) < 1e-3 && Math.abs(b.axialForce) < 1e-6,
    'section shear equals the applied load and the axial force is zero',
    `shear ${b.shearPlus40} vs ${b.shearRefN}, axial ${b.axialForce}`);
  check(b.equilibriumErrorPct < 1e-4 && b.energyBalancePct < 1e-4,
    'the real part keeps both self-checks', `${b.equilibriumErrorPct.toExponential(1)}% / ${b.energyBalancePct.toExponential(1)}%`);
  check(b.trustworthyRegions === 0 && b.meshVerdict === 'drifting',
    'the tool REFUSES to certify a hot spot thinner than the voxel',
    `${b.trustworthyRegions} trustworthy regions, verdict ${b.meshVerdict}`);
  check(b.excludedCells > 0, 'the idealised support patches are excluded and counted', `${b.excludedCells} cells`);
  check(b.maxStressMPa < 1.0, 'and the honest magnitudes are tiny against a 25 MPa material',
    `max ${b.maxStressMPa} MPa`);
}

// --- 6. the coarser grid refuses a peak it cannot resolve -----------------
const cc = out.cantileverCoarse;
check(cc.trustworthyRegions === 0 || cc.surfaceExtrapolatedMPa === null,
  'a 4-cell-thick wall yields no trustworthy peak', `${cc.trustworthyRegions} trustworthy, peak ${cc.surfaceExtrapolatedMPa}`);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
