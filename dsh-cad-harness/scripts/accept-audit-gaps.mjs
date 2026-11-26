// U19 acceptance — "what has not been run yet", and where a row leads.
//
// The audit's verdict says whether the delivery is EXCLUDED; it does not say which
// step nobody ran. That list is arithmetic over the audit fields, and its rows are
// only useful if they carry a target. Both are checked here against a synthetic
// audit that contains one of each gap — including targets that no longer exist in
// the corpus, which must NOT navigate anywhere.
//
//   node scripts/accept-audit-gaps.mjs

import { auditGaps, resolveAuditJump } from '../src/client/audit-gaps.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A translator that keeps the interpolation visible: `key{a,b}`. */
const t = (key, vars = {}) => `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})`;

const audit = (overrides = {}) => ({
  verdict: 'excluded',
  judgement: 'excluded',
  summary: 'EXCLUDED · 1 blocked',
  findings: [],
  versions: { total: 10, currentUncited: [] },
  parts: { total: 3 },
  runs: { total: 5, stale: [], failing: [] },
  contract: { staleNodes: [], geometryNewerThanCheck: false, changedSinceCheck: false },
  visual: { missing: [], stale: [] },
  unregistered: { files: [] },
  ...overrides,
});

console.log('audit gaps acceptance\n');

// ── empty audit: nothing pending ────────────────────────────────────────────
check(auditGaps(null, t).length === 0, 'no audit → no rows (not a fake "all clear")');
check(auditGaps(audit(), t).length === 0, 'a quiet audit makes no rows');

// ── one of each kind of gap ────────────────────────────────────────────────
const full = audit({
  versions: { total: 10, currentUncited: ['v009'] },
  runs: {
    total: 5,
    failing: [
      { id: 'r012', kind: 'printability', summary: 'wall 0.6 < 0.8', current: true },
      { id: 'r003', kind: 'stress', summary: 'old failure', current: false },
    ],
    stale: [{ id: 'r004', kind: 'motion', status: 'pass', superseded: ['v007', 'v008'] }],
  },
  contract: {
    staleNodes: [{ name: 'arm', version: 'v005', newest: 'v006' }],
    geometryNewerThanCheck: true,
    changedSinceCheck: true,
  },
  visual: {
    missing: [{ name: 'gear', version: 'v002' }],
    stale: [{ name: 'base', version: 'v001' }],
  },
  unregistered: { files: ['out/a.stl', 'out/b.stl'] },
});

const rows = auditGaps(full, t);
const tones = rows.map((row) => row.tone);
check(rows.length === 9, 'every gap becomes one row', `${rows.length}: ${tones.join(',')}`);
check(tones[0] === 'blocked' && tones[1] === 'blocked',
  'a current failure and an uncited newest version lead (blocked first)', tones.join(','));
check(!rows.some((row) => row.text.includes('r003')),
  'a SUPERSEDED failure is not reported as current work');
check(rows.some((row) => row.jump === 'run:r012'), 'the failing run row carries run:r012');
check(rows.some((row) => row.jump === 'version:v009'), 'the uncited version row carries version:v009');
check(rows.some((row) => row.jump === 'run:r004'), 'a superseded run row carries its run id');
check(rows.some((row) => row.jump === 'version:v006'), 'a stale manifest node points at the NEWEST version');
check(rows.filter((row) => !row.jump).length === 3,
  'the three facts with nowhere to go have no target (contract ×2, unregistered files)',
  String(rows.filter((row) => !row.jump).length));
check(rows[rows.length - 1].tone === 'info', 'unregistered files are info, not a blocker', rows[rows.length - 1].tone);

// ── jump resolution ────────────────────────────────────────────────────────
const runs = [{ id: 'r012' }, { id: 'r004' }];
const parts = [{ id: 'p001', versions: [{ id: 'v001' }, { id: 'v002' }] }, { id: 'p002', versions: [{ id: 'v009' }] }];
check(JSON.stringify(resolveAuditJump('run:r012', runs, parts)) === JSON.stringify({ kind: 'run', runId: 'r012' }),
  'a run target resolves');
check(JSON.stringify(resolveAuditJump('version:v009', runs, parts)) === JSON.stringify({ kind: 'version', partId: 'p002', versionId: 'v009' }),
  'a version target resolves to its owning part');
check(resolveAuditJump('run:r999', runs, parts) === null,
  'a run the corpus no longer has resolves to NOTHING (no wrong product opened)');
check(resolveAuditJump('version:v999', runs, parts) === null,
  'a pruned version resolves to nothing');
check(resolveAuditJump('nonsense', runs, parts) === null, 'an unknown scheme resolves to nothing');
check(resolveAuditJump('run:', runs, parts) === null, 'an empty id resolves to nothing');

// ── the texts are the translated ones, with the numbers in place ───────────
const failing = rows.find((row) => row.jump === 'run:r012');
check(failing?.text.startsWith('ui.audit.failing(') && failing.text.includes('id=r012'),
  'the row text comes from the dictionary, not a concatenation', failing?.text);
const unregistered = rows[rows.length - 1];
check(unregistered.text.includes('count=2'), 'the unregistered row carries its count', unregistered.text);

console.log(failures ? `\naccept-audit-gaps: ${failures} FAILURE(S)` : '\naccept-audit-gaps: PASS');
process.exit(failures ? 1 : 0);
