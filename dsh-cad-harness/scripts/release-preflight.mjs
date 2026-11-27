// One command before a tag: everything a releaser must see, in order, with a verdict.
//
// The release notes list five commands a person must remember to run in the right
// order, with the right environment (`DSH_CAD_PYTHON_ROOT` when the runtime scratch
// is not writable). Remembering that is how a release ships with a stale root shim
// or a red acceptance run — both of which have happened in this project's history.
//
// So this script owns the ORDER and the SUMMARY, and does not own any check: each
// step shells out to the script that already exists, so a check can never drift
// between "the documented command" and what actually ran.
//
//   node scripts/release-preflight.mjs            # run everything, print the table
//   node scripts/release-preflight.mjs --skip-ui  # skip the browser matrix (slow)
//
// Exit 0 only when every step passed. A SKIP is not a pass: steps that cannot run
// here (a read-only runtime scratch, no display) report SKIP explicitly.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const skipUi = args.includes('--skip-ui');

const results = [];
function step(name, command, argv, options = {}) {
  process.stdout.write(`── ${name} ──\n`);
  const run = spawnSync(command, argv, { cwd: options.cwd ?? ROOT, encoding: 'utf8', timeout: options.timeoutMs ?? 3_600_000 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const tail = out.trim().split('\n').slice(-4).join(' | ');
  const ok = (run.status ?? 1) === 0;
  results.push({ name, ok, detail: tail.slice(0, 400) });
  if (!ok) process.stdout.write(`${out.trim().split('\n').slice(-12).join('\n')}\n`);
  return ok;
}

// ── 1. the version the tag will claim ───────────────────────────────────────
step('version sync (root shim)', process.execPath, ['scripts/sync-root-version.mjs', '--check']);
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// ── 2. the preset a user installs ───────────────────────────────────────────
step('release preset', process.execPath, ['scripts/check-release-preset.mjs']);

// ── 3. the artifact ─────────────────────────────────────────────────────────
step('build (typecheck + esbuild + types)', 'npm', ['run', 'build']);

// ── 4. behaviour: the release gate (includes accept:preview) ────────────────
step('accept:release', 'npm', ['run', 'accept:release'], { timeoutMs: 5_400_000 });

// ── 5. the browser matrix ───────────────────────────────────────────────────
if (skipUi) results.push({ name: 'accept:ui', ok: true, skipped: true, detail: 'skipped by --skip-ui' });
else step('accept:ui (browser matrix)', process.execPath, ['scripts/accept-ui.mjs'], { timeoutMs: 2_400_000 });

// ── 6. docs: links inside the shipped documents must resolve ────────────────
{
  const docs = [
    join(REPO, 'README.md'), join(REPO, 'README.en.md'),
    join(REPO, 'docs', 'user'), join(REPO, 'docs', 'en', 'user'),
  ];
  const broken = [];
  const seen = (file, target) => {
    const at = resolve(dirname(file), target);
    if (!existsSync(at)) broken.push(`${file.slice(REPO.length + 1)} → ${target}`);
  };
  const visit = (file) => {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)(#[^)]*)?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      seen(file, target.split('#')[0]);
    }
  };
  for (const target of docs) {
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      for (const entry of readdirSync(target)) if (entry.endsWith('.md')) visit(join(target, entry));
    } else visit(target);
  }
  results.push({ name: 'docs links', ok: broken.length === 0, detail: broken.length ? broken.slice(0, 5).join(' | ') : 'all relative links resolve' });
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log('\n══ release preflight ══');
for (const row of results) console.log(`${row.skipped ? 'SKIP' : row.ok ? 'PASS' : 'FAIL'}  ${row.name}`);
const failed = results.filter((row) => !row.ok);
const softSkips = results.filter((row) => row.skipped);
if (softSkips.length) console.log(`\nWARNING  ${softSkips.length} step(s) skipped — run them before tagging: ${softSkips.map((row) => row.name).join(', ')}`);
console.log(`\nversion ${version} · ${results.length - failed.length}/${results.length} steps passed`
  + (softSkips.length ? ` · ${softSkips.length} skipped (not counted as passed)` : ''));
if (failed.length === 0) {
  console.log('\nnext (needs the maintainer):');
  console.log(`  git tag -s v${version} -m "${version}"`);
  console.log(`  git push origin v${version}`);
  console.log('  npm stage publish     # then approve on the phone (npmjs.com → Staged Packages)');
}
process.exit(failed.length === 0 ? 0 : 1);
