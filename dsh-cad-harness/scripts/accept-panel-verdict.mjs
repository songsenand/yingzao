// Acceptance for the panel's revision verdict (2026-10-23 audit, FIX-B5).
//
// The bug: the status band derived its word from `run.status`, so a risk map that found
// nothing (`status: 'pass'`) rendered as 通过 for the revision it merely looked at — the
// exact "ok / safe" claim DESIGN §25.7 forbids. The rule now lives in src/client/verdict.ts
// and this file pins it:
//
//   * only a JUDGEMENT can say 不排除可行 / 困难 / 否决;
//   * a run that judged nothing contributes nothing (a revision whose only run is a risk
//     map reads 未验证);
//   * a LEGACY `status: 'fail'` still vetoes (old evidence must not be discarded);
//   * a LEGACY `status: 'pass'` never becomes 不排除可行 (it only says the tool ran).
//
//   node scripts/accept-panel-verdict.mjs
const { judgementOf, versionVerdict } = await import('../src/client/verdict.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const run = (id, status, judgement, kind = 'printability') => ({ type: 'run', id, kind, status, ...(judgement ? { judgement } : {}), timestamp: '2026-10-23T00:00:00Z', title: id, summary: '', sourceVersionIds: [], hasGeometry: false, parts: [] });

// ── the module's own rules ─────────────────────────────────────────────────
check(versionVerdict([]) === null, 'no runs at all → 未验证 (not a pass)');
check(versionVerdict([run('r1', 'pass')]) === null, 'a bare pass with no judgement contributes NOTHING', String(versionVerdict([run('r1', 'pass')])));
check(versionVerdict([run('r1', 'pass', 'not-excluded')]) === 'not-excluded', 'a real not-excluded judgement is reported as such');
check(versionVerdict([run('r1', 'pass', 'not-excluded'), run('r2', 'check', 'difficult')]) === 'difficult', 'difficult outranks not-excluded');
check(versionVerdict([run('r1', 'pass', 'not-excluded'), run('r2', 'fail', 'excluded')]) === 'excluded', 'excluded outranks everything');
check(versionVerdict([run('r1', 'fail')]) === 'excluded', 'a LEGACY fail (no judgement) still vetoes');
check(versionVerdict([run('r1', 'check')]) === 'difficult', 'a LEGACY check (no judgement) is difficult');
check(judgementOf(run('r1', 'pass')) === null, 'judgementOf: pass alone is not a judgement');
check(judgementOf(run('r1', 'pass', 'not-excluded')) === 'not-excluded', 'judgementOf: the explicit judgement wins over status');

// ── the specific case from the audit ──────────────────────────────────────
// An analyze run that found no peaks is committed with status 'pass' and NO judgement.
const analyze = run('r9', 'pass', undefined, 'analyze');
check(versionVerdict([analyze]) === null, 'a risk map with no peaks does NOT make the revision 不排除可行');

// ── the words themselves: 通过 must be unreachable from these inputs ──────
const words = new Set();
for (const j of [versionVerdict([analyze]), versionVerdict([run('r1', 'pass', 'not-excluded')]), versionVerdict([run('r1', 'pass', 'difficult')]), versionVerdict([run('r1', 'pass', 'excluded')])]) {
  words.add(j);
}
check(!words.has('pass'), 'no input produces the legacy word "pass" (i.e. 通过)', [...words].map(String).join(', '));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
