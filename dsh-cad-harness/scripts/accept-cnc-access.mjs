// Acceptance for the pure CNC access analysis (`analyzeCncAccess`).

import { analyzeCncAccess } from '../src/host/cnc-access.ts';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const metrics = (over = {}) => ({
  sampled: 100, areaMm2: 100, accessiblePct: 100, topAccessiblePct: 100,
  inaccessiblePct: 0, setupsNeeded: 1, setupDirs: ['+z'],
  directionAreaMm2: [{ direction: '+z', areaMm2: 100 }], ...over,
});
const params = (over = {}) => ({ maxSetups: 2, requireAllAccessible: false, ...over });

console.log('cnc-access acceptance\n');

{
  const r = analyzeCncAccess(metrics(), params());
  check('one-setup part is not-excluded', r.verdict === 'not-excluded', r.verdict);
  check('and has no witnesses', r.witnesses.length === 0);
}

{
  const r = analyzeCncAccess(metrics({ setupsNeeded: 4, setupDirs: ['+x', '-x', '+y', '-y'] }), params());
  check('4 setups > max 2 → excluded', r.verdict === 'excluded', r.verdict);
  check('witness is setup-count', r.witnesses.some((w) => w.rule === 'setup-count' && w.measured === 4 && w.required === 2));
}

{
  const r = analyzeCncAccess(metrics({ inaccessiblePct: 10 }), params());
  check('inaccessible area is a warning by default', r.verdict === 'not-excluded' && r.findings.some((f) => f.includes('10%')));
}

{
  const r = analyzeCncAccess(metrics({ inaccessiblePct: 10 }), params({ requireAllAccessible: true }));
  check('requireAllAccessible:true makes it a witness', r.verdict === 'excluded' && r.witnesses.some((w) => w.rule === 'tool-access'));
}

{
  const r = analyzeCncAccess(metrics(), params());
  check('the report names the six-direction boundary', r.findings.some((f) => f.includes('六方向')));
  check('oblique setups are disclosed as unevaluable', r.unevaluable.includes('oblique/diagonal setups'));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
