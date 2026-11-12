// Acceptance for the pure turning analysis (`analyzeTurning`).
//
// The tool computes the mesh metrics (bar fit, L/D, symmetry deviation); this
// script accepts the judging, without the Python worker.

import { analyzeTurning } from '../src/host/turning.ts';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const metrics = (over = {}) => ({
  maxDiameterMm: 20, lengthMm: 60, ldRatio: 3, symmetryMaxDeviationMm: 0.02,
  sampled: 100, watertight: true, ...over,
});
const params = (over = {}) => ({
  barDiameterMm: 25, maxLdRatio: 4, symmetryToleranceMm: 0.1, requireSymmetry: false, ...over,
});

console.log('turning acceptance\n');

{
  const r = analyzeTurning(metrics(), params());
  check('a fitting, symmetric part is not-excluded', r.verdict === 'not-excluded', r.verdict);
  check('and has no witnesses', r.witnesses.length === 0, String(r.witnesses.length));
}

{
  const r = analyzeTurning(metrics({ maxDiameterMm: 30, ldRatio: 2 }), params());
  check('Ø30 > bar Ø25 → excluded', r.verdict === 'excluded', r.verdict);
  check('witness is bar-stock-fit', r.witnesses.some((w) => w.rule === 'bar-stock-fit' && w.measured === 30 && w.required === 25),
    JSON.stringify(r.witnesses));
}

{
  const r = analyzeTurning(metrics({ ldRatio: 6, lengthMm: 120 }), params());
  check('L/D 6 > 4 → excluded', r.verdict === 'excluded', r.verdict);
  check('witness is ld-ratio', r.witnesses.some((w) => w.rule === 'ld-ratio' && w.measured === 6 && w.required === 4),
    JSON.stringify(r.witnesses));
}

{
  const r = analyzeTurning(metrics({ symmetryMaxDeviationMm: 0.5 }), params());
  check('non-symmetric part is a finding, not a witness by default', r.verdict === 'not-excluded' && !r.witnesses.some((w) => w.rule === 'rotational-symmetry'));
  check('and the finding says turning alone cannot finish it', r.findings.some((f) => f.includes('不是纯回转体')));
}

{
  const r = analyzeTurning(metrics({ symmetryMaxDeviationMm: 0.5 }), params({ requireSymmetry: true }));
  check('requireSymmetry:true makes it a witness', r.verdict === 'excluded' && r.witnesses.some((w) => w.rule === 'rotational-symmetry'));
}

{
  const r = analyzeTurning(metrics({ watertight: false }), params());
  check('an open mesh is disclosed, not silently trusted', r.findings.some((f) => f.includes('不是封闭实体')));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
