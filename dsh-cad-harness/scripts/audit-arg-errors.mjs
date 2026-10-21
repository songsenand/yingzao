// Lint the ARGUMENT-VALIDATION errors: a rejected call is where a caller learns the
// vocabulary, so the message must name the field AND say what is accepted (type, units,
// allowed values, or the ids that do exist) — not just "invalid".
//
// Heuristic (static, no runtime): for each `if (<cond>) throw ...` whose condition tests an
// argument field, the message must mention that field. Extend with --list to see offenders.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src/host/tools.ts', 'src/host/inspect.ts', 'src/host/stress.ts', 'src/host/motion.ts', 'src/host/assembly-check.ts', 'src/host/fluid.ts'];
const list = process.argv.includes('--list');
let offenders = 0;
let checked = 0;

for (const f of files) {
  const src = await readFile(join(ROOT, f), 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!/\bthrow new Error\(/.test(ln)) continue;
    // Look back for the guarding condition on this line or the previous two.
    const window = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
    const fields = [...window.matchAll(/\ba\.([A-Za-z_][\w]*)/g)].map((m) => m[1]);
    if (fields.length === 0) continue;
    checked++;
    const msg = lines.slice(i, i + 3).join(' ');
    const missing = [...new Set(fields)].filter((fld) => !new RegExp(`\\b${fld}\\b`).test(msg));
    if (missing.length) {
      offenders++;
      if (list) console.log(`${f}:${i + 1}  field(s) ${missing.join(',')} not named in the message\n    ${ln.trim().slice(0, 110)}`);
    }
  }
}
console.log(`\nchecked ${checked} argument guard(s); ${offenders} do not name the offending field`);
process.exit(0);
