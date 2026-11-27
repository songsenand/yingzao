#!/usr/bin/env node
// Acceptance for designException (2026-11-27).
//
// The point is attention, not approval: an agent may sign its own exception, but a
// blank/boilerplate signature, "whyNotLarger: none", or reportedToUser:false must be
// rejected. This test is hermetic (no corpus, no FEM).

import { thinWallBlockMessage, validateDesignException } from '../src/host/design-exceptions.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const good = {
  featureId: 'handwheel.hub-wall',
  versionId: 'v073',
  measuredMm: 0.8,
  requiredMm: 1.6,
  loadCase: 'hand torque 0.5 N·m at the D-flat',
  whyThisDimension: 'hub OD 14 is set by the existing handwheel envelope',
  whyNotLarger: 'OD 16 would collide with the spoke roots at r=7',
  residualRisk: 'hub ring may crack during press-fit; torque margin is thin',
  inspection: 'visual + 5 N·m torque test on the first article',
  userSummary: '0.8 mm hub wall kept for the current envelope; cracking risk at press-fit',
  reportedToUser: true,
  signedBy: 'agent',
};
check(validateDesignException(good, 'v073').length === 0, 'a complete self-signed exception is valid');

const missing = { ...good, residualRisk: '' };
check(validateDesignException(missing, 'v073').some((s) => s.includes('residualRisk')), 'an empty required field is rejected');

const none = { ...good, whyNotLarger: 'none' };
check(validateDesignException(none, 'v073').some((s) => s.includes('whyNotLarger')), '"whyNotLarger: none" is rejected');

const noReport = { ...good, reportedToUser: false };
check(validateDesignException(noReport, 'v073').some((s) => s.includes('reportedToUser')), 'reportedToUser:false is rejected');

const notThin = { ...good, measuredMm: 2.0 };
check(validateDesignException(notThin, 'v073').some((s) => s.includes('no exception is needed')), 'measured >= required is rejected (no exception needed)');

const stale = { ...good, versionId: 'v072' };
check(validateDesignException(stale, 'v073').some((s) => s.includes('not the scanned version')), 'a version mismatch is rejected');

const msg = thinWallBlockMessage({
  featureId: 'handwheel.hub-wall',
  atMm: [2.75, 0, 0],
  measuredMm: 0.8,
  requiredMm: 1.6,
  policy: 'policy minimum 1.6 mm',
});
check(msg.includes('BLOCKED') && msg.includes('whyNotLarger') && msg.includes('userSummary'), 'the hard message names the five questions and the report');

console.log(failures === 0 ? '\ndesignException acceptance: PASS' : `\ndesignException acceptance: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
