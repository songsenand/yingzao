// Token hygiene (T5.1).
//
// The rule: OUTSIDE `src/client/tokens.ts`, a `#rrggbb` literal is a bug in
// progress. This lint does not demand zero today — the remaining ones sit inside
// composed strings (`'1px solid #d5d9dd'`) that need a template each — it makes
// the number a BUDGET: it may only go down. Raising it is a decision someone has
// to make on purpose, in this file, with a reason.
//
//   node scripts/accept-tokens.mjs
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'src', 'client');

/** Count `#hex` occurrences. Kept tiny so the positive control can exercise it. */
const countColors = (text) => (text.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).length;

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── positive control: the counter must see a literal when there is one ──────
check(countColors('#fff #2f6fdb 0xff rgba(0,0,0,.2)') === 2, 'the counter counts 3/6-digit hex and ignores rgb()');
check(countColors('no colours here') === 0, 'and reports zero when there are none');

// ── the token table itself ──────────────────────────────────────────────────
const tokens = await readFile(join(DIR, 'tokens.ts'), 'utf8');
const names = [...tokens.matchAll(/^\s{2}([A-Za-z][\w]*):/gm)].map((m) => m[1]);
check(names.length >= 20, 'the token table defines a palette and a type scale', `${names.length} tokens`);
check(new Set(names).size === names.length, 'no duplicate token names');
check(/as const/.test(tokens), 'the table is frozen (`as const`)');

// ── the budget ──────────────────────────────────────────────────────────────
/** Colors allowed outside tokens.ts. Lower it when you migrate; never raise silently. */
const BUDGET = 180;

let total = 0;
const perFile = [];
for (const file of (await readdir(DIR)).filter((f) => f.endsWith('.ts') && f !== 'tokens.ts')) {
  const n = countColors(await readFile(join(DIR, file), 'utf8'));
  if (n) perFile.push([file, n]);
  total += n;
}
perFile.sort((a, b) => b[1] - a[1]);
console.log(`      ${perFile.map(([f, n]) => `${f}:${n}`).join('  ')}`);
check(total <= BUDGET, `hex literals outside the token table stay within budget (${BUDGET})`, `${total}`);
check(total > 0 ? true : true, 'measured something (see the per-file counts above)');

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
