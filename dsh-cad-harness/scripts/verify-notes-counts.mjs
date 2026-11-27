// Are the assertion counts in the release notes TRUE?
//
// `audit-release-evidence` checks that every named script exists and runs somewhere.
// It does NOT check the numbers: "accept-measure-families 26 项" is a claim about
// what happens when you run it. Those numbers were written by hand while moving
// through the work — exactly the kind of figure that drifts when a suite gains an
// assertion later and nobody re-reads the document.
//
// This script RUNS each named suite and compares the claim with what came out. It is
// deliberately not part of `accept:preview`: it executes the suites themselves, so it
// belongs to the release step, not to every run.
//
// How a count is read (in order):
//   1. a trailing "N passed" / "N/N checks passed" summary, when the suite prints one;
//   2. otherwise the number of lines starting with PASS/✓.
// Both are the suite's own words, not a re-implementation.
//
//   node scripts/verify-notes-counts.mjs                  # all items in the notes
//   node scripts/verify-notes-counts.mjs --only U14,N15   # a subset
//   node scripts/verify-notes-counts.mjs --dry            # print the plan, run nothing

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const flagValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const dry = args.includes('--dry');
const only = (flagValue('--only') ?? '').split(',').map((part) => part.trim()).filter(Boolean);

const NOTES = resolve(REPO, flagValue('--notes') ?? 'docs/dev/RELEASE-NOTES-0.2.0-preview.1.md');
const text = readFileSync(NOTES, 'utf8');

/**
 * The claims, from the status table: `| **U15** … | accept-measure-families（26 项）+ … 8 项 |`.
 * A row can name several (script, count) pairs; each becomes one claim.
 */
const claims = [];
for (const row of text.matchAll(/^\| \*\*([A-Z]{1,2}\d+)\*\*(.*)$/gm)) {
  const id = row[1];
  const rest = row[2];
  // The count trails the name in several shapes the notes actually use:
  //   `accept-x`（26 项）   `accept-x`（30）   **`accept-x` 37/37**
  // Look only at the short window right after the name, so a later number in the same
  // row (F1's "7,098→0") is not mistaken for an assertion count.
  for (const match of rest.matchAll(/`?(accept-[a-z0-9-]+)`?(.{0,40})/g)) {
    const name = match[1];
    const tail = match[2];
    // accept-ui rows count SCENARIO assertions, not the matrix total: skip them here
    // (the matrix itself proves the scenarios pass; their inner counts are verdict text).
    if (name === 'accept-ui') continue;
    const forms = [
      tail.match(/^\s*（\s*(\d+)\s*项[^）]*）/),
      tail.match(/^\s*（\s*(\d+)\s*）/),
      tail.match(/^\*\*\s+(\d+)\s*\/\s*\d+/),
      tail.match(/^\s+(\d+)\s*项/),
    ].filter(Boolean);
    if (!forms.length) continue;
    claims.push({ id, script: `scripts/${name}.mjs`, claimed: Number(forms[0][1]), raw: `${name}${tail.slice(0, 24)}` });
  }
}

if (claims.length === 0) {
  console.error('no (script, count) claims found in the notes');
  process.exit(2);
}
const selected = only.length ? claims.filter((claim) => only.includes(claim.id)) : claims;

function readCount(output) {
  const passed = [...output.matchAll(/(\d+)\s+passed/gi)].pop();
  if (passed) return Number(passed[1]);
  const slash = [...output.matchAll(/(\d+)\s*\/\s*(\d+)\s+checks passed/gi)].pop();
  if (slash) return Number(slash[1]);
  const lines = output.split('\n').filter((line) => /^\s*(PASS|✓)\b/.test(line));
  return lines.length;
}

console.log(`claims to verify: ${selected.length}${only.length ? ` (only ${only.join(', ')})` : ''}\n`);
let failures = 0;
const seen = new Set();
for (const claim of selected) {
  const key = `${claim.script}#${claim.claimed}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const file = join(ROOT, claim.script);
  if (!existsSync(file)) {
    console.log(`FAIL  ${claim.id}  ${claim.script} does not exist  (claimed ${claim.claimed})`);
    failures++;
    continue;
  }
  if (dry) {
    console.log(`PLAN  ${claim.id}  node ${claim.script}  (claimed ${claim.claimed})`);
    continue;
  }
  const run = spawnSync(process.execPath, [claim.script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 1_800_000,
    env: { ...process.env },
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (/^\s*SKIP/m.test(output) && (run.status ?? 1) === 0) {
    console.log(`SKIP  ${claim.id}  ${claim.script} skipped here (claimed ${claim.claimed}) — ${output.split('\n').find((line) => line.includes('SKIP'))?.trim()}`);
    continue;
  }
  const actual = readCount(output);
  const ok = actual === claim.claimed;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim.id}  ${claim.script}  claimed ${claim.claimed}, counted ${actual}`);
}

console.log(failures ? `\nverify-notes-counts: ${failures} MISMATCH(ES)` : '\nverify-notes-counts: PASS');
process.exit(failures ? 1 : 0);
