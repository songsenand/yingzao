// Acceptance for the risk-map contract (DESIGN §25.7, user-ratified 2026-10-20).
import { signedOf, riskOf, fuseAt, stressU, analyzeVersion } from '../src/host/analyze.ts';

let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// wall: two-sided band 1.2..4.0 mm, saturating over 1.2 below and 4 above
const wall = { id: 'wall', quantity: 'wall-thickness', units: 'mm', lo: 1.2, hi: 4.0, scaleLo: 1.2, scaleHi: 4.0, source: 'profile wallMinMm + declared thick-wall bound' };
check(signedOf(2.0, wall) === 0, 'inside the band -> 0 (comfortable is SILENT, not "average")');
check(near(signedOf(1.2, wall), 0) && near(signedOf(4.0, wall), -0), 'the band edges themselves are 0');
check(near(signedOf(0.6, wall), -0.5), 'too thin -> negative, half-way at half the scale', String(signedOf(0.6, wall)));
check(near(signedOf(6.0, wall), 0.5), 'too thick -> positive (the "both extremes" case)', String(signedOf(6.0, wall)));
check(near(riskOf(0.0, wall), 1) && near(riskOf(8.0, wall), 1), 'beyond the scale saturates at |u| = 1');

// stress: one-sided (low stress must NOT light up)
const stress = { id: 'stress', quantity: 'von-mises', units: 'MPa', lo: -Infinity, hi: 16.67, scaleLo: 1, scaleHi: 16.67, source: 'material strength / badFactor' };
check(signedOf(1, stress) === 0, 'low stress is NOT a risk (one-sided band, open below)');
check(near(signedOf(16.67, stress), 0), 'at the allowable -> 0');
check(near(signedOf(25, stress), (25 - 16.67) / 16.67), 'half-way over the allowable -> ~0.5 (the exact ratio, not a rounded guess)');

// corner: one-sided (blunt is fine)
const corner = { id: 'corner', quantity: 'reentrant-angle', units: 'deg', lo: -Infinity, hi: 135, scaleLo: 1, scaleHi: 45, source: 'scan_attention concaveMinDeg' };
check(signedOf(90, corner) === 0 && near(signedOf(180, corner), 1), 'a sharp corner saturates, a blunt one is silent');

// strength: 0.5 at the declared warnAt, 1 at badAt; below warn is silent even if it is
// the field's maximum (a low absolute stress is not a strength risk)
check(near(stressU(5, 5, 10), 0.5) && near(stressU(10, 5, 10), 1) && near(stressU(2.5, 5, 10), 0.25),
  'stress |u| is 0.5 at warnAt and 1 at badAt', `${stressU(2.5, 5, 10)} / ${stressU(5, 5, 10)} / ${stressU(10, 5, 10)}`);
check(stressU(0, 5, 10) === 0 && stressU(4.9, 5, 10) < 0.5, 'below warn stays out of the peak list');

const fusedStrength = analyzeVersion({
  wallBand: wall,
  suspects: [{ kind: 'reentrant-corner', where: { atMm: [0, 0, 0] }, severity: 'likely-defect' }],
  stress: {
    samples: [{ p: [0, 0, 0], v: 10 }, { p: [50, 0, 0], v: 2 }],
    peaks: [{ p: [50, 0, 0], v: 2 }],
    warnAt: 5, badAt: 10, source: 'test run', runId: 'r-test', loadCase: 'gravity',
  },
});
const rootPeak = fusedStrength.peaks.find((p) => p.atMm[0] === 0);
const lowPeak = fusedStrength.peaks.find((p) => p.atMm[0] === 50);
check(rootPeak && rootPeak.count === 2 &&
  rootPeak.layers.includes('strength') && rootPeak.layers.includes('reentrant-corner'),
'strength and corner agree at the notch root (count 2)', JSON.stringify(rootPeak));
check(lowPeak && lowPeak.risk === 0.5 && lowPeak.layers.includes('strength-concentration'),
  'a low absolute stress peak is still a concentration LOOK (0.5), not a fake risk', JSON.stringify(lowPeak));
check(fusedStrength.layers.strength === 2 && fusedStrength.stress?.loadCase === 'gravity' &&
  fusedStrength.stress?.concentrationPeaks === 1,
  'the strength layer is present and carries its stress-run provenance', JSON.stringify(fusedStrength.stress));

// mesh health and boolean seams enter as their own layers (item 2/3, 2026-10-29):
// multi-body/non-manifold are likely-defect (1.0); a non-planar seam is a look (0.5)
const health = analyzeVersion({
  wallBand: wall,
  suspects: [
    { kind: 'multi-body', where: { atMm: [0, 0, 0] }, severity: 'likely-defect' },
    { kind: 'non-manifold', where: { atMm: [20, 0, 0] }, severity: 'likely-defect' },
    { kind: 'boolean-seam', where: { atMm: [40, 0, 0] }, severity: 'look' },
  ],
});
const at = (x) => health.peaks.find((p) => p.atMm[0] === x);
check(at(0)?.risk === 1 && at(0)?.layers.includes('multi-body'),
  'multi-body is a 1.0 look (a union that did not merge)', JSON.stringify(at(0)));
check(at(20)?.risk === 1 && at(20)?.layers.includes('non-manifold'),
  'non-manifold is a 1.0 look', JSON.stringify(at(20)));
check(at(40)?.risk === 0.5 && at(40)?.layers.includes('boolean-seam'),
  'a non-planar boolean seam is a 0.5 look, not a verdict', JSON.stringify(at(40)));

// fusion: worst sets the colour, count says how many agree — no weighted total
const f = fuseAt([
  { layer: 'wall', atMm: [0, 0, 0], value: 0.8, u: -0.83 },
  { layer: 'corner', atMm: [0, 0, 0], value: 170, u: 0.78 },
  { layer: 'stress', atMm: [0, 0, 0], value: 2, u: 0.1 },
]);
check(near(f.risk, 0.83) && f.worst === 'wall' && f.count === 2, 'max |u| + agreement count, no weighted sum', JSON.stringify(f));
check(fuseAt([]).risk === 0 && fuseAt([]).worst === null, 'nothing to say -> risk 0 and no worst layer');
// A broken declaration must not quietly score 0 as "safe" without being noticed elsewhere:
check(signedOf(5, { ...wall, scaleHi: 0 }) === 0, 'a zero scale is inert (declared-broken, never a silent pass)');

// ── The human's channel: the panel must DRAW the fused layer ──────────────────
// The map is only useful if a person can look at it; this is the "two readers, one
// object" half of the contract (the JSON is the LLM's view, the ramp is the human's).
import { pickHeatLayer } from '../src/client/heat.ts';
const payload = {
  id: 'analyze', versionId: 'v-test',
  normalization: { fused: { mode: 'absolute', warnAt: 0.5, badAt: 1.0, source: 'test' } },
  samples: { fused: Array.from({ length: 10 }, (_, i) => ({ p: [i, 0, 0], v: i / 9 })) },
};
const hl = pickHeatLayer(payload);
check(hl?.id === 'fused', 'the panel prefers the fused risk layer', hl?.id ?? 'null');
check(hl && near(hl.score(0), 0) && near(hl.score(1), 1) && near(hl.score(0.25), 0.25),
  'and |u| maps straight onto the ramp (no re-normalisation, no invented weight)');
check(hl && /风险/.test(hl.legend) && /0\.5/.test(hl.legend), 'the legend states the 0.5 half-way line');

// ── The toy-balance control (SKIP without the corpus) ─────────────────────────
// Directional and falsifiable: the pan elbow must light up in v069 and NOT in v077.
import { controlAvailable, runControl, atElbow } from './analyze-control.mjs';
if (await controlAvailable()) {
  const out = await runControl();
  const elbows069 = out.v069.peaks.filter((p) => atElbow(p));
  const elbows077 = out.v077.peaks.filter((p) => atElbow(p));
  check(elbows069.length >= 1, 'v069: the map points at the pan elbow',
    elbows069.slice(0, 2).map((p) => `[${p.atMm.map((x) => x.toFixed(1))}] u=${p.risk.toFixed(2)}`).join(' ') || 'no elbow peak');
  check(elbows069.every((p) => p.risk >= 0.5), 'v069: and the elbow peak was not averaged away');
  // THE ATTENTION TEST (measured 2026-10-20): a map that lights up the whole rim is
  // describing the part's shape, not guiding attention. After overhang and thick-wall
  // were moved to per-PART facts, v069 has 8 peaks (the 8 corner suspects) instead of 73.
  check(out.v069.peaks.length <= 12, 'v069: the map no longer describes the shape (peaks ≤ 12)', String(out.v069.peaks.length));
  check((out.v069.partNotes?.overhangAreaMm2 ?? 0) > 0, 'the global process fact is still reported (overhang area per part)');
  check((out.v069.partNotes?.maxWallMm ?? 0) > (out.v069.partNotes?.thickLimitMm ?? 0),
    'and the thick-wall fact too, without scoring it as places');
  check(elbows077.length === 0, 'v077: the repaired pan no longer flags the elbow',
    elbows077.map((p) => `[${p.atMm.map((x) => x.toFixed(1))}]`).join(' ') || 'clean');
} else {
  console.log('SKIP  the toy-balance control — corpus absent (examples/toy-balance/cad-data is gitignored)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
