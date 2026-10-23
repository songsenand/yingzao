// Acceptance for generate_part's `views` policy (src/host/render-attachments.ts).
//
// WHY: `views: []` used to fall back to ALL four images (the inline `a.views.length`
// test), so "register the version without spending image budget" did not exist —
// every registration cost four pictures. That made "preview first" expensive and
// gave an agent a reason to skip the version store. `[]` must mean NONE.
//
//   node scripts/accept-render-attachments.mjs

import { selectAttachedViews } from '../src/host/render-attachments.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const names = (r) => r.attached.map((x) => x.view).join(',') || '(none)';

const FOUR = ['top', 'front', 'side', 'iso'].map((view) => ({ view }));

check(names(selectAttachedViews(FOUR, undefined)) === 'top,front,side,iso',
  'views absent -> all four attached (the shape-review default)');
check(names(selectAttachedViews(FOUR, [])) === '(none)',
  'views [] -> NONE attached (register the version, spend no image budget)',
  names(selectAttachedViews(FOUR, [])));
check(selectAttachedViews(FOUR, []).warning === null,
  'views [] is a deliberate choice, not a warning');
check(names(selectAttachedViews(FOUR, ['iso'])) === 'iso',
  'a subset attaches only the named views');
check(names(selectAttachedViews(FOUR, ['iso', 'top'])) === 'top,iso',
  'order follows the renders, and multiple names work');

const unknown = selectAttachedViews(FOUR, ['bogus']);
check(unknown.attached.length === 4,
  'an unrecognised name never silently attaches nothing (falls back to all)',
  names(unknown));
check(/matched no rendered view/.test(unknown.warning ?? ''),
  'and it says why, instead of leaving the fallback invisible',
  unknown.warning ?? '(no warning)');

const none = selectAttachedViews(undefined, []);
check(none.attached.length === 0 && none.warning === null,
  'a failed compile (no renders) does not crash the selector');

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
