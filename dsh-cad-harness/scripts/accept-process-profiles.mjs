// Acceptance for process profiles (S1, first increment): the contract is executable.
//
// schemas/process-profile.schema.json is only a document. This module is what makes it
// a contract: a profile that violates it is REFUSED, and the disclosure lists that the
// decision requires ("what does not apply here" / "what can a tool not decide") are
// DERIVED from the profile instead of hand-written, because a hand-written list drifts
// silently.
//
//   node scripts/accept-process-profiles.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  builtinDefaultProfile, disclosureLists, evaluableRules, profileHash,
  RULE_NAMES, validateProfile,
} from '../src/host/process-profile.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log('process-profile acceptance\n');

// ── 1. the shipped example is valid, and declares every rule ──────────────────
const shippedPath = join(REPO, 'schemas', 'examples', 'fdm-pla-0.4.json');
const shippedRaw = JSON.parse(readFileSync(shippedPath, 'utf8'));
const shipped = validateProfile(shippedRaw);
check('the shipped FDM example validates', shipped.ok, shipped.ok ? '' : shipped.errors.join(' | '));
if (!shipped.ok) { console.log('\ncannot continue without a valid shipped profile'); process.exit(1); }
const missing = RULE_NAMES.filter((r) => shipped.profile.rules[r] === undefined);
check('the shipped example declares every named rule', missing.length === 0, missing.join(', ') || `${RULE_NAMES.length} rules`);

// ── 1b. the shipped CNC-3axis example is valid and declares its cutting rules ──
const cncPath = join(REPO, 'schemas', 'examples', 'cnc-3axis.json');
const cnc = validateProfile(JSON.parse(readFileSync(cncPath, 'utf8')));
check('the shipped CNC-3axis example validates', cnc.ok, cnc.ok ? '' : cnc.errors.join(' | '));
if (cnc.ok) {
  const cncMissing = RULE_NAMES.filter((r) => cnc.profile.rules[r] === undefined);
  check('the CNC example declares every named rule', cncMissing.length === 0, cncMissing.join(', ') || `${RULE_NAMES.length} rules`);
  check('CNC declares toolRadiusMm as a geometric min rule',
    cnc.profile.rules.toolRadiusMm?.applies === true && cnc.profile.rules.toolRadiusMm.decidable === 'geometry');
  check('CNC declares holeAspectMax as a geometric max rule',
    cnc.profile.rules.holeAspectMax?.applies === true && cnc.profile.rules.holeAspectMax.decidable === 'geometry');
  check('CNC turns off additive-only rules (overhang)',
    cnc.profile.rules.overhangDeg?.applies === false);
}

// ── 1c. every shipped profile validates and declares every named rule ────────
for (const file of readdirSync(join(REPO, 'schemas', 'examples')).filter((f) => f.endsWith('.json')).sort()) {
  const parsed = validateProfile(JSON.parse(readFileSync(join(REPO, 'schemas', 'examples', file), 'utf8')));
  check(`shipped profile ${file} validates`, parsed.ok, parsed.ok ? '' : parsed.errors.join(' | '));
  if (!parsed.ok) continue;
  const absent = RULE_NAMES.filter((r) => parsed.profile.rules[r] === undefined);
  check(`${file} declares every named rule`, absent.length === 0, absent.join(', ') || `${RULE_NAMES.length} rules`);
}

// ── 2. negative controls: each of these MUST be refused ───────────────────────
const base = () => JSON.parse(JSON.stringify(shippedRaw));
const refused = (label, mutate) => {
  const p = base();
  mutate(p);
  const r = validateProfile(p);
  check(`refused: ${label}`, !r.ok, r.ok ? 'ACCEPTED (should have been refused)' : (r.errors[0] ?? '').slice(0, 96));
};
refused('applies=true without a source (an unprovenanced number)', (p) => { delete p.rules.wallMinMm.source; });
refused('applies=true without a value', (p) => { delete p.rules.wallMinMm.value; });
refused('applies=true without a direction', (p) => { delete p.rules.overhangDeg.direction; });
refused('applies=false without a reason', (p) => { delete p.rules.draftMinDeg.reason; });
refused('an unknown rule name (a typo, not a new rule)', (p) => { p.rules.wallMinimum = { applies: true, decidable: 'geometry', value: 1, direction: 'min', source: { kind: 'assumed' } }; });
refused('an unknown top-level key', (p) => { p.recommendedProcess = 'SLS'; });
refused('a bad id', (p) => { p.id = 'FDM PLA'; });
refused('an unknown process', (p) => { p.process = 'CNC-9axis'; });
refused('schemaVersion 2', (p) => { p.schemaVersion = 2; });
refused('an invalid decidable value', (p) => { p.rules.wallMinMm.decidable = 'maybe'; });
refused('an invalid source.kind', (p) => { p.rules.wallMinMm.source.kind = 'vibes'; });

// A profile with a rule the tool cannot decide is still VALID — the point is that it is
// disclosed, not that it is rejected.
{
  const p = base();
  p.rules.tolMm = { applies: true, decidable: 'declared-requirement', value: 0.1, direction: 'max', source: { kind: 'vendor-spec', ref: 'x' } };
  check('a declared-requirement rule is valid (disclosed, not refused)', validateProfile(p).ok);
}

// ── 3. the disclosure lists are DERIVED, and they partition the rules ─────────
{
  const { notApplicable, unevaluable } = disclosureLists(shipped.profile);
  const evaluable = evaluableRules(shipped.profile);
  const na = notApplicable.map((r) => r.rule).sort().join(',');
  const un = unevaluable.map((r) => r.rule).sort().join(',');
  const ev = evaluable.map((r) => r.rule).sort().join(',');
  check('notApplicable = the rules this process does not govern',
    na === 'draftMinDeg,escapePassageMinMm,toolRadiusMm', na);
  check('unevaluable = capability rules a tool cannot decide from the mesh',
    un === 'surfaceRaUm,tolMm', un);
  check('evaluable = the geometry rules with a threshold',
    ev === 'bridgeMaxMm,featureMinMm,gapMinMm,holeAspectMax,overhangDeg,wallMinMm', ev);
  const total = notApplicable.length + unevaluable.length + evaluable.length;
  check('the three lists partition every named rule (nothing silently dropped)',
    total === RULE_NAMES.length, `${total} of ${RULE_NAMES.length}`);
  check('every "not applicable" carries a reason',
    notApplicable.every((r) => typeof r.reason === 'string' && r.reason.length > 0));
}

// ── 4. an absent rule is UNEVALUABLE, never "no constraint" ───────────────────
{
  const minimal = validateProfile({
    schemaVersion: 1, id: 'minimal', process: 'SLS', rules: {},
  });
  check('a profile may declare no rules at all', minimal.ok, minimal.ok ? '' : minimal.errors.join(' | '));
  if (minimal.ok) {
    const { unevaluable } = disclosureLists(minimal.profile);
    check('every absent rule is disclosed as unevaluable',
      unevaluable.length === RULE_NAMES.length, `${unevaluable.length} of ${RULE_NAMES.length}`);
    check('…and the reason says a missing number is not "no constraint"',
      unevaluable.every((r) => /not "no constraint"/.test(r.reason)));
  }
}

// ── 5. the hash pins a verdict to its premise ─────────────────────────────────
{
  const a = profileHash(shipped.profile);
  const b = profileHash(validateProfile(base()).profile);
  check('the same profile hashes the same', a === b, a);
  const edited = base();
  edited.rules.wallMinMm.value = 1.4;
  const c = profileHash(validateProfile(edited).profile);
  check('editing one number changes the hash', c !== a, `${a} → ${c}`);
}

// ── 6. the built-in fallback is honest about itself ───────────────────────────
{
  const def = builtinDefaultProfile();
  const v = validateProfile(def);
  check('the built-in default profile is valid', v.ok, v.ok ? '' : v.errors.join(' | '));
  const declared = RULE_NAMES.map((r) => def.rules[r]).filter((r) => r && r.applies);
  check('every number the built-in default declares is source.kind = "assumed"',
    declared.length > 0 && declared.every((r) => r.source?.kind === 'assumed'),
    declared.map((r) => `${r.source?.kind}`).join(','));
  check('…and it names itself as the fallback, not as a recommendation',
    /builtin-default/.test(def.id) && /fallback/i.test(def.description ?? ''));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
