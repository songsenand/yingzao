// Acceptance for the pure EDM sinker access analysis (`analyzeEdmAccess`).

import { analyzeEdmAccess } from '../src/host/edm-access.ts';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const metrics = (over = {}) => ({
  sampled: 100, areaMm2: 100, reachablePct: 100, inaccessiblePct: 0, burnAxis: 'z', ...over,
});

console.log('edm-access acceptance\n');

{
  const r = analyzeEdmAccess(metrics(), { requireAllReachable: false });
  check('fully reachable is not-excluded', r.verdict === 'not-excluded', r.verdict);
  check('and has no witnesses', r.witnesses.length === 0);
}

{
  const r = analyzeEdmAccess(metrics({ inaccessiblePct: 10 }), { requireAllReachable: false });
  check('occluded area is a warning by default', r.verdict === 'not-excluded' && r.findings.some((f) => f.includes('10%')));
}

{
  const r = analyzeEdmAccess(metrics({ inaccessiblePct: 10 }), { requireAllReachable: true });
  check('requireAllReachable:true makes it a witness', r.verdict === 'excluded' && r.witnesses.some((w) => w.rule === 'electrode-access'));
}

{
  const r = analyzeEdmAccess(metrics({ burnAxis: '-z' }), { requireAllReachable: false });
  check('the report names the burn axis', r.findings.some((f) => f.includes('-z')));
  check('electrode shape/undercut is disclosed as unevaluable', r.unevaluable.some((s) => s.includes('electrode shape')));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
