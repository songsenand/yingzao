// Lint the ARGUMENT-VALIDATION errors: a rejected call is where a caller learns the
// vocabulary, so the message must name the field AND say what is accepted (type, units,
// allowed values, or the ids that do exist) — not just "invalid".
//
// Scope: guards that NEGATIVELY test a direct argument field (`!a.x`, `a.x === undefined`,
// `!Array.isArray(a.x)`, `a.x < 0`) thrown with `new Error(...)`, plus every `argError(...)`
// call (whose first two arguments are the tool and the field BY CONSTRUCTION, so what
// this lint can still get wrong there is an empty `accepts` string).
// Excluded on purpose:
//   * deadline results (`rScan.ok`) — not arguments;
//   * positive dispatch tests (`a.kind === 'sphere'`) — a refusal, not "missing input";
//   * helpers that build the message themselves (`versionNotFound(...)`), which already
//     name the id and list what exists.
//
// WHY THE POSITIVE CONTROL: this lint used to match `throw new Error(` only. After the
// `argError()` refactor (0c31f3d) the guards became `throw argError(...)`, the scan found
// zero sites, and the acceptance that reads this script stayed GREEN on nothing. A check
// that can pass by measuring nothing is not a check, so the script now proves it still
// sees both shapes before trusting its own verdict.
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

/**
 * Split the top-level arguments of an `argError(...)` call.
 *
 * A regex was not enough: `accepts` routinely contains other quotes
 * (`'a display name, e.g. "吊盘架"'`), and the call may wrap over several lines. Parsing
 * with quote + depth state is ten lines and cannot be fooled by a comma inside a string.
 */
function parseArgErrorArgs(text) {
  const start = text.indexOf('argError(');
  if (start < 0) return null;
  const args = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (let i = start + 'argError('.length; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += text[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') { args.push(cur.trim()); return args; }
      depth--; cur += ch; continue;
    }
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return null;   // unbalanced: the call did not finish within the lines we joined
}

/** The literal's text, or null when the argument is not a plain string literal. */
function unquote(arg) {
  const s = (arg ?? '').trim();
  if (s.length < 2) return null;
  const q = s[0];
  if ((q !== "'" && q !== '"' || s.at(-1) !== q)) return null;
  return s.slice(1, -1).replace(/\\(['"\\])/g, '$1');
}

/**
 * Scan one source text. Split out from the file loop so the positive control below can run
 * the SAME code over a fixture instead of trusting a second implementation.
 *
 * @returns {{checked:number, offenders:{key:string, why:string, line:string}[]}}
 */
function scan(label, text) {
  const lines = text.split('\n');
  const offenders = [];
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // ── shape 1: argError(tool, field, problem, accepts) ──────────────────
    if (/throw argError\(/.test(ln)) {
      checked++;
      const args = parseArgErrorArgs(lines.slice(i, i + 6).join('\n'));
      const push = (why) => offenders.push({ key: `${label}:${i + 1}`, why, line: ln.trim().slice(0, 110) });
      if (!args || args.length < 4) { push('call is not a 4-argument literal argError(...)'); continue; }
      const [tool, field, problem, accepts] = args.map(unquote);
      if (tool === null || !tool.trim()) push('tool name is not a non-empty literal');
      if (field === null || !field.trim()) push('field name is not a non-empty literal');
      if (problem === null || !problem.trim()) push('no statement of what is wrong');
      if (accepts === null || !accepts.trim()) push('`accepts` is not a non-empty literal — the caller learns nothing');
      continue;
    }

    // ── shape 2: throw new Error(...) behind a negative guard ─────────────
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
    // Search the MESSAGE, not the whole line: the guard itself (`!a.foo`) contains the
    // field name, so including it made every same-line guard look like it named its field
    // — the assertion could not fail on the shape that matters most.
    const throwAt = ln.indexOf('throw new Error(');
    const msg = ln.slice(throwAt) + ' ' + lines.slice(i + 1, i + 3).join(' ');
    const missing = [...new Set(fields)].filter((fld) => !new RegExp(`\\b${fld}\\b`).test(msg));
    if (missing.length) {
      offenders.push({ key: `${label}:${i + 1}`, why: `field(s) ${missing.join(',')} not named`, line: ln.trim().slice(0, 110) });
    }
  }
  return { checked, offenders };
}

// ── positive control: the scanner must still see BOTH shapes ────────────────
const FIXTURE = [
  'if (!a.foo) throw new Error("is required");',                            // offender: no field name
  'if (!a.bar) throw new Error("bar: is required; accepts: a number");',    // clean
  'if (!a.baz) throw argError("t", "baz", "is required", "a string");',      // clean
  'if (!a.qux) throw argError("t", "qux", "is required", "");',             // offender: empty accepts
].join('\n');
const control = scan('fixture', FIXTURE);
const controlKeys = control.offenders.map((o) => o.key).join(',');
const controlOk = control.checked === 4 && controlKeys === 'fixture:1,fixture:4';
if (!controlOk) {
  console.log(`FIXTURE FAIL: expected 4 checked / offenders fixture:1,fixture:4 — got ${control.checked} / ${controlKeys || '(none)'}`);
  process.exit(1);
}

// ── the real files ─────────────────────────────────────────────────────────
const list = process.argv.includes('--list');
let offenders = 0;
let checked = 0;
for (const f of files) {
  const result = scan(f, await readFile(join(ROOT, f), 'utf8'));
  checked += result.checked;
  for (const o of result.offenders) {
    if (ALLOWLIST.some((x) => x.startsWith(o.key))) continue;
    offenders++;
    if (list) console.log(`${o.key}  ${o.why}\n    ${o.line}`);
  }
}
if (process.argv.includes('--all')) console.log(`(positive control passed: 4 sites, 2 offenders as expected)`);
console.log(`\nchecked ${checked} negative argument guard(s); ${offenders} do not name the offending field`);
process.exit(offenders ? 1 : 0);
