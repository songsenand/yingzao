// Token hygiene and theme completeness.
//
// Rule: OUTSIDE `src/client/tokens.ts`, a colour literal (`#rrggbb`) or a
// translucent colour (`rgba(...)`) is a bug. The migration is complete, so the
// budget is ZERO: a new literal has to be added to the token table instead of
// slipping into a component, which is also the only way the dark palette can
// cover it.
//
// The second half is the dark palette's completeness: every token must have a
// dark value distinct from its light one (except the two "on a solid fill"
// inks), and the stylesheet must declare both palettes under the host's
// `data-ds-dark-theme` attribute. A missing dark value is how one label stays
// unreadable in exactly one theme.
//
//   node scripts/accept-tokens.mjs
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'src', 'client');

/** Count colour literals. Kept tiny so the positive control can exercise it. */
const countColors = (text) =>
  (text.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).length + (text.match(/rgba\(/g) ?? []).length;

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── positive control: the counter must see a literal when there is one ──────
check(countColors('#fff #2f6fdb 0xff rgba(0,0,0,.2)') === 3, 'the counter counts hex and rgba() literals');
check(countColors('no colours here') === 0, 'and reports zero when there are none');

// ── the token table itself ──────────────────────────────────────────────────
const tokens = await readFile(join(DIR, 'tokens.ts'), 'utf8');
const block = (from, to) => {
  const a = tokens.indexOf(from);
  const b = to ? tokens.indexOf(to, a + 1) : tokens.length;
  if (a < 0 || b < 0) throw new Error(`token block ${from} … ${to} not found`);
  return tokens.slice(a, b);
};
const entries = (text) =>
  [...text.matchAll(/^\s{2}([A-Za-z][\w]*):\s*'([^']+)',/gm)].map((m) => [m[1], m[2]]);
const light = entries(block('export const LIGHT', 'export const DARK'));
const dark = entries(block('export const DARK', 'export type CadTokenName'));
check(light.length >= 45, 'the light palette defines the full role set', `${light.length} tokens`);
check(new Set(light.map(([n]) => n)).size === light.length, 'no duplicate token names in the light palette');
check(dark.length === light.length, 'the dark palette covers every light token', `${dark.length}/${light.length}`);

const darkMap = new Map(dark);
const lightMap = new Map(light);
check(dark.every(([n]) => lightMap.has(n)), 'the dark palette invents no token');
/** Identical on purpose: both are ink on a solid fill, and `accentSolid` is the
 *  fill itself — it must stay dark enough for white text in either theme. */
const SAME_IN_BOTH = new Set(['white', 'accentSolid']);
const unchanged = light
  .filter(([n, v]) => !SAME_IN_BOTH.has(n) && darkMap.get(n) === v)
  .map(([n]) => n);
check(unchanged.length === 0, 'every themeable token has its own dark value', unchanged.join(', ') || 'none');

// The generated table must wrap each role in `var(--cad-*, light fallback)`.
check(/export const T = Object.fromEntries/.test(tokens), '`T` is generated from the palette');
check(/var\(\$\{cssVar\(name\)\}, \$\{LIGHT\[name\]\}\)/.test(tokens), 'each token is a CSS variable with a light fallback');

// ── the stylesheet actually declares both palettes ─────────────────────────
const theme = await readFile(join(DIR, 'theme.ts'), 'utf8');
check(/body\[.*data-ds-dark-theme/.test(theme) || /body\[\$\{DARK_ATTRIBUTE\}\]/.test(theme),
  'the dark palette is scoped to the host attribute');
check(/DARK_ATTRIBUTE = 'data-ds-dark-theme'/.test(theme), "the attribute name is the host's `data-ds-dark-theme`");
check(/declarations\(LIGHT\)/.test(theme) && /declarations\(DARK\)/.test(theme),
  'both palettes are emitted into the stylesheet');

// ── the budget: zero literals outside the token table ──────────────────────
const BUDGET = 0;

let total = 0;
const perFile = [];
for (const file of (await readdir(DIR)).filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'tokens.ts')) {
  const n = countColors(await readFile(join(DIR, file), 'utf8'));
  if (n) perFile.push([file, n]);
  total += n;
}
perFile.sort((a, b) => b[1] - a[1]);
console.log(`      ${perFile.map(([f, n]) => `${f}:${n}`).join('  ') || '(none)'}`);
check(total <= BUDGET, `colour literals outside the token table stay within budget (${BUDGET})`, `${total}`);

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
