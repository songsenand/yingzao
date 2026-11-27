// Does every claim in the release notes have a script that exists AND runs?
//
// The release notes are the document a reviewer trusts. Each row names the evidence
// ("accept-audit-gaps 19 项 + accept-ui audit-view 8 项"), and that is exactly the
// kind of claim that rots: a script gets renamed, an entry falls out of the npm
// chain, or a row is written optimistically and never re-checked. A gate item whose
// evidence cannot be run is not closed — it is a sentence.
//
// So this audits the DOCUMENT against the REPOSITORY, three ways, and fails loudly:
//
//   1. every `accept-*.mjs` mentioned exists in `scripts/`;
//   2. every one of those is reachable from `npm run accept:preview` (directly or
//      through another accept script it spawns) — a script nobody runs is a script
//      that will break silently;
//   3. the per-item assertion COUNT in the notes (when given as "N 项"/"N/") is
//      claimed, not verified — the notes say so; this step only reports the numbers
//      so a drift is visible when someone re-reads.
//
//   node scripts/audit-release-evidence.mjs                 # audit the preview.1 notes
//   node scripts/audit-release-evidence.mjs --notes <file>

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const notesOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};

const NOTES = resolve(REPO, notesOf('--notes') ?? 'docs/dev/RELEASE-NOTES-0.2.0-preview.1.md');
if (!existsSync(NOTES)) {
  console.error(`no release notes at ${NOTES}`);
  process.exit(2);
}
const text = readFileSync(NOTES, 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. every named script exists ───────────────────────────────────────────
const named = [...new Set([...text.matchAll(/\b(accept-[a-z0-9-]+)\b/g)].map((match) => match[1]))].sort();
const scripts = new Set(readdirSync(join(ROOT, 'scripts')));
const missing = named.filter((name) => !scripts.has(`${name}.mjs`));
check(named.length > 0, 'the notes name at least one acceptance script', `${named.length} named`);
check(missing.length === 0, 'every named acceptance script exists', missing.length ? `missing: ${missing.join(', ')}` : `${named.length} scripts`);

// ── 2. every one is reachable from the release chain ───────────────────────
// Start from the three entry points and follow BOTH kinds of edge out of an npm
// script: the alias (`npm run accept:x`) and the file path (`node scripts/accept-x.mjs`).
// Following only aliases misses wrappers like release-preflight.mjs, which call the
// files directly — and a wrapper is exactly how the browser matrix gets run.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const npmScripts = pkg.scripts ?? {};
const visitedScripts = new Set();
const reachable = new Set();
const queue = ['accept:preview', 'accept:release', 'release:preflight'];
while (queue.length > 0) {
  const name = queue.shift();
  if (visitedScripts.has(name)) continue;
  visitedScripts.add(name);
  const body = String(npmScripts[name] ?? '');
  for (const match of body.matchAll(/accept:([a-z0-9-]+)/g)) queue.push(`accept:${match[1]}`);
  for (const match of body.matchAll(/(accept-[a-z0-9-]+)\.mjs/g)) reachable.add(`${match[1]}.mjs`);
  // A wrapper script's own body is an edge too: read the file it runs.
  for (const match of body.matchAll(/(scripts\/[a-z0-9-]+\.mjs)/g)) {
    const file = join(ROOT, match[1]);
    if (!existsSync(file)) continue;
    const inner = readFileSync(file, 'utf8');
    for (const alias of inner.matchAll(/accept:([a-z0-9-]+)/g)) queue.push(`accept:${alias[1]}`);
    for (const path of inner.matchAll(/(accept-[a-z0-9-]+)\.mjs/g)) reachable.add(`${path[1]}.mjs`);
  }
}
const unreached = named.filter((name) => !reachable.has(`${name}.mjs`));
check(unreached.length === 0,
  'every named script is reachable from the release chain',
  unreached.length ? `not in the chain: ${unreached.join(', ')}` : `${named.length} reachable`);

// ── 3. the status table exists and its counts add up ───────────────────────
const gateRows = [...text.matchAll(/^\| \*\*([A-Z]{1,2}\d+)\*\*(.*)$/gm)].map((match) => ({
  id: match[1],
  rest: match[2],
  // The status word sits in the SECOND column (`| **F1** … | ✅ 收口 | …`), so the
  // whole row is the correct test target — reading only the first cell reported
  // every gate as partial.
  closed: /收口/.test(match[2]),
}));
const expected = ['Q2', 'Q1', 'U20', 'U21', 'U12', 'U11', 'U19', 'U15', 'F1', 'F2', 'N15', 'U14', 'U22'];
const listed = gateRows.map((row) => row.id);
const missingRows = expected.filter((id) => !listed.includes(id));
const extraRows = listed.filter((id) => !expected.includes(id));
check(missingRows.length === 0, 'the status table lists all 13 gates', missingRows.length ? `missing: ${missingRows.join(', ')}` : '13 rows');
check(extraRows.length === 0, 'and nothing outside the 13', extraRows.length ? `extra: ${extraRows.join(', ')}` : 'none');
const closedCount = gateRows.filter((row) => row.closed).length;
const summary = text.match(/(\d+) 项收口/);
check(Boolean(summary), 'the notes state a closing count');
if (summary) {
  check(Number(summary[1]) === closedCount,
    'the stated count equals the number of closed rows',
    `stated ${summary[1]}, rows ${closedCount}`);
}

// ── 4. report the per-item counts, so a drift is visible on re-read ────────
console.log('\nper-item assertion counts as written (not re-executed here):');
for (const row of gateRows) {
  const counts = [...row.rest.matchAll(/(\d+)\s*项/g)].map((match) => match[1]);
  console.log(`  ${row.id.padEnd(4)} ${row.closed ? '收口' : 'partial'}  ${counts.length ? counts.join(' + ') : '—'}`);
}

console.log(failures ? `\naudit-release-evidence: ${failures} FAILURE(S)` : '\naudit-release-evidence: PASS');
process.exit(failures ? 1 : 0);
