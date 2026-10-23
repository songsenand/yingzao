// Acceptance for the ONE vocabulary of delivery judgements (DESIGN §25.7,
// 2026-10-23 audit FIX-B1).
//
// The corpus has historically spelled the same three states five ways. `asJudgement` is
// the single mapping, and it must know every word that is still in the corpus — otherwise
// a caller either hand-writes the mapping (a second copy) or silently falls through to
// the `default` branch. The default is `difficult` (silence is never a pass), which is
// safe but useless: it turns a hard violation into "difficult" if the word is missing.
//
//   node scripts/accept-judgement-vocabulary.mjs
const { asJudgement, judgementLine } = await import('../src/shared/judgement.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// Every legacy word that is still written by a tool, a run record or the python engine.
const EXPECTED = {
  // canonical
  excluded: 'excluded', difficult: 'difficult', 'not-excluded': 'not-excluded',
  // delivery_audit (before the rename) / assembly / printability / stress / physics
  blocked: 'excluded', fail: 'excluded', unprintable: 'excluded', overstressed: 'excluded',
  'hard-violation': 'excluded',
  attention: 'difficult', check: 'difficult',
  skipped: 'difficult', 'intent-flag': 'difficult',
  pass: 'not-excluded', ok: 'not-excluded',
};
for (const [word, want] of Object.entries(EXPECTED)) {
  check(asJudgement(word) === want, `"${word}" → ${want}`, asJudgement(word));
}

// Silence and garbage are NOT passes.
for (const word of [undefined, null, '', 'unknown-word', 'OKAY', 'seems fine']) {
  check(asJudgement(word) === 'difficult', `${JSON.stringify(word)} is difficult, never a pass`, asJudgement(word));
}

// The three words must stay non-interchangeable: the human sentence says what each means.
check(/NOT "ok"/.test(judgementLine('not-excluded')), 'not-excluded says out loud that it is not "ok"');
check(/NOT a pass/.test(judgementLine('difficult')), 'difficult says out loud that it is not a pass');
check(/witness contradicts/.test(judgementLine('excluded')), 'excluded names its witness');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
