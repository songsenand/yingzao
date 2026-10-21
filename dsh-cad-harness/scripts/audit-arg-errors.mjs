// Lint the ARGUMENT-VALIDATION errors: a rejected call is where a caller learns the
// vocabulary, so the message must name the field AND say what is accepted (type, units,
// allowed values, or the ids that do exist) — not just "invalid".
//
// Scope: guards that NEGATIVELY test a direct argument field (`!a.x`, `a.x === undefined`,
// `!Array.isArray(a.x)`, `a.x < 0`). Excluded on purpose:
//   * deadline results (`rScan.ok`) — not arguments;
//   * positive dispatch tests (`a.kind === 'sphere'`) — a refusal, not "missing input";
//   * helpers that build the message themselves (`versionNotFound(...)`), which already
//     name the id and list what exists.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src/host/tools.ts', 'src/host/inspect.ts', 'src/host/stress.ts', 'src/host/motion.ts', 'src/host/assembly-check.ts', 'src/host/fluid.ts'];

/** Known exceptions, each with a reason. Adding a line here is a decision, not a bypass. */
export const ALLOWLIST = [
  // (empty) — keep it that way if you can: an argument error should name its field.
];

const NEGATIVE = /(!\s*a\??\.|a\??\.\w+\s*===\s*undefined|!Array\.isArray\(a\??\.|a\??\.\w+\s*<\s*0|a\??\.\w+\s*<=\s*0)/;
const list = process.argv.includes('--list');
let offenders = 0;
let checked = 0;

for (const f of files) {
  const lines = (await readFile(join(ROOT, f), 'utf8')).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!/\bthrow new Error\(/.test(ln)) continue;
    if (/versionNotFound\(/.test(lines[i + 1] ?? '')) continue;      // helper names the id
    // Prefer the fields on the SAME line (the guard is usually condensed with the throw);
    // only look at the line above when this line names none — otherwise an unrelated
    // earlier guard (`!a.parts`) gets blamed for this message.
    const pick = (t) => [...t.matchAll(/\ba\??\.([A-Za-z_][\w]*)/g)].map((m) => m[1]);
    let cond = ln;
    let fields = pick(cond);
    if (fields.length === 0) { cond = lines[i - 1] ?? ''; fields = pick(cond); }
    if (!NEGATIVE.test(cond) || fields.length === 0) continue;
    checked++;
    const msg = lines.slice(i, i + 3).join(' ');
    const missing = [...new Set(fields)].filter((fld) => !new RegExp(`\\b${fld}\\b`).test(msg));
    const key = `${f}:${i + 1}`;
    if (missing.length && !ALLOWLIST.some((x) => x.startsWith(key))) {
      offenders++;
      if (list) console.log(`${key}  field(s) ${missing.join(',')} not named\n    ${ln.trim().slice(0, 110)}`);
    }
  }
}
console.log(`\nchecked ${checked} negative argument guard(s); ${offenders} do not name the offending field`);
process.exit(offenders ? 1 : 0);
