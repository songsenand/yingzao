// Acceptance for the risk-map contract (DESIGN §25.7, user-ratified 2026-10-20).
import { signedOf, riskOf, fuseAt } from '../src/host/analyze.ts';

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
  check(elbows077.length === 0, 'v077: the repaired pan no longer flags the elbow',
    elbows077.map((p) => `[${p.atMm.map((x) => x.toFixed(1))}]`).join(' ') || 'clean');
} else {
  console.log('SKIP  the toy-balance control — corpus absent (examples/toy-balance/cad-data is gitignored)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
