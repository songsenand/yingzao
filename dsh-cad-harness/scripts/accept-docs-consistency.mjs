#!/usr/bin/env node
// Documentation consistency gate.
//
// The ledger (`docs/TOOL-SURFACE-V1.json`) and `package.json` are the machine
// truth. This script checks that the documents still agree with them and with
// each other: tool tables, op counts, version strings, install paths, the
// HARNESS bilingual pair, and local Markdown links.
//
// It is read-only. Failures must name the file and the missing/extra fact.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');          // dsh-cad-harness/
const REPO = resolve(ROOT, '..');          // repository root

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
function has(file, text) { return read(file).includes(text); }

const ledger = JSON.parse(read(join(ROOT, 'docs/TOOL-SURFACE-V1.json')));
const pkg = JSON.parse(read(join(ROOT, 'package.json')));
const expected = new Set(Object.entries(ledger.tools ?? {}).map(([, entry]) => `${entry.surface}.${entry.action}`));
const expectedSurfaces = new Set(Object.values(ledger.tools ?? {}).map((entry) => entry.surface));

function tablePairs(file) {
  const pairs = [];
  for (const raw of read(file).split(/\r?\n/)) {
    // DESIGN keeps its table inside a blockquote.
    const line = raw.replace(/^\s*>\s?/, '');
    const match = line.match(/^\|\s*`(cad_[a-z]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (!match) continue;
    const actions = match[2].replace(/（已弃用）/g, '').replace(/\(deprecated\)/g, '');
    for (const part of actions.split('·')) {
      const action = part.trim().replace(/^`|`$/g, '').trim();
      if (/^[a-z0-9_]+$/.test(action)) pairs.push(`${match[1]}.${action}`);
    }
  }
  return pairs;
}

// ── 1. Surface tables must equal the frozen ledger exactly ──────────────────
check('ledger declares 9 surfaces', expectedSurfaces.size === 9, String(expectedSurfaces.size));
check('ledger declares 45 tool pairs', expected.size === 45, String(expected.size));

for (const [file, label] of [
  [join(REPO, 'DESIGN.md'), 'DESIGN.md §26.4'],
  [join(REPO, 'docs/llm/README.md'), 'docs/llm/README.md'],
  [join(REPO, 'docs/en/llm/README.md'), 'docs/en/llm/README.md'],
]) {
  const pairs = tablePairs(file);
  const unique = new Set(pairs);
  const missing = [...expected].filter((pair) => !unique.has(pair));
  const extra = [...unique].filter((pair) => !expected.has(pair));
  check(`${label}: no duplicate action`, pairs.length === unique.size, `${pairs.length} rows, ${unique.size} unique`);
  check(`${label}: all 45 ledger actions present`, missing.length === 0, missing.join(', '));
  check(`${label}: no action outside the ledger`, extra.length === 0, extra.join(', '));
  check(`${label}: 9 surfaces`, new Set(pairs.map((pair) => pair.split('.')[0])).size === 9, String(new Set(pairs.map((pair) => pair.split('.')[0])).size));
}

// ── 2. Counts that are easy to leave stale ──────────────────────────────────
check('docs/llm/README.md says 9 surfaces / 45 ops', has(join(REPO, 'docs/llm/README.md'), '9 个 surface / 45 个 op'));
check('docs/en/llm/README.md says 9 surfaces / 45 ops', has(join(REPO, 'docs/en/llm/README.md'), '9 surfaces / 45 ops'));
check('docs/README.md says 45 internal ops', has(join(REPO, 'docs/README.md'), '45 个内部 op'));
check('docs/llm/library.md says 45 ops', has(join(REPO, 'docs/llm/library.md'), '45 个 op'));
check('docs/en/llm/library.md says 45 ops', has(join(REPO, 'docs/en/llm/library.md'), '45 ops'));
check('docs/user/preview.md says 45 legacy tools', has(join(REPO, 'docs/user/preview.md'), '45 个旧工具'));
check('docs/en/user/preview.md says 45 legacy tools', has(join(REPO, 'docs/en/user/preview.md'), '45 legacy tools'));
for (const [file, pattern] of [
  [join(REPO, 'DESIGN.md'), '9 个 surface / 39 个 op'],
  [join(REPO, 'docs/llm/README.md'), '9 个 surface / 39'],
  [join(REPO, 'docs/en/llm/README.md'), '9 surfaces / 39'],
  [join(REPO, 'docs/README.md'), '39 个内部 op'],
]) {
  check(`${file.replace(REPO + '/', '')} has no stale 39-op claim`, !has(file, pattern), pattern);
}

// ── 3. Version strings follow package.json ─────────────────────────────────
const version = pkg.version;
check('package version is present', typeof version === 'string' && version.length > 0);
check('package is publishable (no private: true)', pkg.private !== true);
for (const [file, label] of [
  [join(REPO, 'README.md'), 'README.md'],
  [join(REPO, 'docs/user/preview.md'), 'docs/user/preview.md'],
  [join(REPO, 'docs/en/user/preview.md'), 'docs/en/user/preview.md'],
  [join(ROOT, 'README.md'), 'dsh-cad-harness/README.md'],
  [join(ROOT, 'README.en.md'), 'dsh-cad-harness/README.en.md'],
  [join(REPO, 'DESIGN.md'), 'DESIGN.md §7'],
]) {
  check(`${label} names ${version}`, has(file, version));
}
check('README.md marks the repository version unreleased', has(join(REPO, 'README.md'), '未发布'));
check('README.en.md marks the repository version unreleased', has(join(REPO, 'README.en.md'), 'unreleased'));

// ── 4. HARNESS.md and HARNESS.en.md are the same version and cover the same
//       positioning statements that were added in v2.5 ─────────────────────
const harnessZh = read(join(REPO, 'HARNESS.md'));
const harnessEn = read(join(REPO, 'HARNESS.en.md'));
check('HARNESS.md is v2.5', harnessZh.includes('v2.5'));
check('HARNESS.en.md is v2.5', harnessEn.includes('v2.5'));
check('HARNESS bilingual: §6.2 present', harnessZh.includes('6.2') && harnessEn.includes('6.2'));
check('HARNESS bilingual: §11.18 present', harnessZh.includes('11.18') && harnessEn.includes('11.18'));
check('HARNESS bilingual: §11.19 present', harnessZh.includes('11.19') && harnessEn.includes('11.19'));
check('HARNESS bilingual: import-run entry documented', harnessZh.includes('dsh-cad-import-run') && harnessEn.includes('dsh-cad-import-run'));
check('HARNESS bilingual: no-zero-product-gaps rule', harnessZh.includes('不承诺没有产品缺口') && harnessEn.includes('No promise of zero product gaps'));

// ── 5. Install path: npm first, tarball fallback ───────────────────────────
check('README.md: npm install path', has(join(REPO, 'README.md'), '推荐：npm'));
check('README.md: tarball fallback', has(join(REPO, 'README.md'), 'tarball'));
check('README.en.md: npm install path', has(join(REPO, 'README.en.md'), 'recommended: npm'));
check('README.en.md: tarball fallback', has(join(REPO, 'README.en.md'), 'tarball'));
check('docs/user/install.md: npm first', has(join(REPO, 'docs/user/install.md'), '方式 A：npm'));
check('docs/user/install.md: tarball fallback', has(join(REPO, 'docs/user/install.md'), '方式 B：tarball'));
check('docs/en/user/install.md: npm first', has(join(REPO, 'docs/en/user/install.md'), 'A. npm'));
check('docs/en/user/install.md: tarball fallback', has(join(REPO, 'docs/en/user/install.md'), 'B. Tarball'));

// ── 6. Stale capability claims that used to be in live user docs ───────────
const liveUser = [
  join(REPO, 'README.md'), join(REPO, 'README.en.md'),
  ...['docs/user', 'docs/en/user'].flatMap((dir) => ['README.md', 'install.md', 'preview.md', 'limits.md', 'what-is-yingzao.md', 'configuration.md', 'workflow.md', 'verification.md', 'troubleshooting.md', 'advanced.md'].map((name) => join(REPO, dir, name))),
];
for (const phrase of ['六向轴吸附', '六标准视图', '没有 B-rep', 'No B-rep', 'No second geometry kernel']) {
  const hits = liveUser.filter((file) => existsSync(file) && has(file, phrase));
  check(`live user docs: no "${phrase}"`, hits.length === 0, hits.map((file) => file.replace(REPO + '/', '')).join(', '));
}

// ── 7. Env appendix and user configuration agree ──────────────────────────
for (const [file, label] of [
  [join(REPO, 'DESIGN.md'), 'DESIGN.md'],
  [join(REPO, 'README.md'), 'README.md'],
  [join(REPO, 'docs/user/configuration.md'), 'docs/user/configuration.md'],
  [join(REPO, 'docs/en/user/configuration.md'), 'docs/en/user/configuration.md'],
]) {
  check(`${label}: CAD_OPENSCAD_MIRROR documented`, has(file, 'CAD_OPENSCAD_MIRROR'));
  check(`${label}: CAD_OPENSCAD_ARCHIVE documented`, has(file, 'CAD_OPENSCAD_ARCHIVE'));
}
check('DESIGN.md drops the dead CAD_SKIP_CONTACTS knob', !has(join(REPO, 'DESIGN.md'), 'CAD_SKIP_CONTACTS'));

// ── 8. Gate status: one number across README, TODO, release notes ─────────
check('README.md says 11 of 13 gates closed', has(join(REPO, 'README.md'), '11 项收口'));
check('RELEASE-0.2.0.md says 11 of 13 gates closed', has(join(REPO, 'docs/dev/RELEASE-0.2.0.md'), '11 项已收口'));
check('RELEASE-NOTES-0.2.0-preview.1.md says 11 closed', has(join(REPO, 'docs/dev/RELEASE-NOTES-0.2.0-preview.1.md'), '11 项收口'));
check('TODO.md accounts for 11 closed gates', has(join(REPO, 'docs/dev/TODO.md'), '共 11'));

// ── 9. The packaged custom-check CLI is discoverable ──────────────────────
check('package.json exposes dsh-cad-check-register', pkg.bin?.['dsh-cad-check-register'] === './scripts/check-register.mjs');
check('package.json ships scripts/check-register.mjs', (pkg.files ?? []).includes('scripts/check-register.mjs'));
check('README.md names dsh-cad-check-register', has(join(REPO, 'README.md'), 'dsh-cad-check-register'));
check('docs/llm/verify.md names dsh-cad-check-register', has(join(REPO, 'docs/llm/verify.md'), 'npx dsh-cad-check-register'));
check('docs/en/llm/verify.md names dsh-cad-check-register', has(join(REPO, 'docs/en/llm/verify.md'), 'npx dsh-cad-check-register'));

// ── 10. Every 2026-11-25 action has a long-form home ──────────────────────
for (const [file, label, needle] of [
  [join(REPO, 'docs/llm/cadquery.md'), 'docs/llm/cadquery.md', 'action: "kernel"'],
  [join(REPO, 'docs/en/llm/cadquery.md'), 'docs/en/llm/cadquery.md', 'action: "kernel"'],
  [join(REPO, 'docs/llm/assembly.md'), 'docs/llm/assembly.md', 'suggest'],
  [join(REPO, 'docs/en/llm/assembly.md'), 'docs/en/llm/assembly.md', 'suggest'],
  [join(REPO, 'docs/llm/assembly.md'), 'docs/llm/assembly.md', 'sweep'],
  [join(REPO, 'docs/en/llm/assembly.md'), 'docs/en/llm/assembly.md', 'sweep'],
  [join(REPO, 'docs/llm/engines.md'), 'docs/llm/engines.md', 'hotspots'],
  [join(REPO, 'docs/en/llm/engines.md'), 'docs/en/llm/engines.md', 'hotspots'],
  [join(REPO, 'docs/llm/delivery.md'), 'docs/llm/delivery.md', 'affected'],
  [join(REPO, 'docs/en/llm/delivery.md'), 'docs/en/llm/delivery.md', 'affected'],
]) {
  check(`${label} documents ${needle}`, has(file, needle));
}
check('docs/llm/delivery.md documents retire', has(join(REPO, 'docs/llm/delivery.md'), 'retire'));
check('docs/en/llm/delivery.md documents retire', has(join(REPO, 'docs/en/llm/delivery.md'), 'retire'));

// ── 11. Local Markdown links resolve ──────────────────────────────────────
const linkFiles = [
  'README.md', 'README.en.md', 'HARNESS.md', 'HARNESS.en.md', 'DESIGN.md', 'docs/README.md',
  'docs/user/README.md', 'docs/user/install.md', 'docs/user/preview.md', 'docs/user/configuration.md',
  'docs/user/limits.md', 'docs/user/what-is-yingzao.md', 'docs/user/workflow.md',
  'docs/user/verification.md', 'docs/user/troubleshooting.md', 'docs/user/advanced.md',
  'docs/en/user/README.md', 'docs/en/user/install.md', 'docs/en/user/preview.md',
  'docs/en/user/configuration.md', 'docs/en/user/limits.md', 'docs/en/user/what-is-yingzao.md',
  'docs/en/user/workflow.md', 'docs/en/user/verification.md', 'docs/en/user/troubleshooting.md',
  'docs/en/user/advanced.md',
  'docs/llm/README.md', 'docs/llm/cadquery.md', 'docs/llm/assembly.md', 'docs/llm/engines.md',
  'docs/llm/delivery.md', 'docs/llm/library.md', 'docs/llm/verify.md',
  'docs/en/llm/README.md', 'docs/en/llm/cadquery.md', 'docs/en/llm/assembly.md',
  'docs/en/llm/engines.md', 'docs/en/llm/delivery.md', 'docs/en/llm/library.md', 'docs/en/llm/verify.md',
  'docs/dev/README.md', 'dsh-cad-harness/docs/PEARL-PLAN.md',
];
const broken = [];
for (const rel of linkFiles) {
  const file = join(REPO, rel);
  if (!existsSync(file)) { broken.push(`${rel} (missing)`); continue; }
  const text = read(file);
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    let target = match[1].replace(/^<|>$/g, '');
    if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) continue;
    target = target.split('#')[0];
    if (!target) continue;
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) broken.push(`${rel} -> ${match[1]}`);
  }
}
check('local Markdown links resolve', broken.length === 0, broken.slice(0, 8).join('; '));

console.log(`\naccept-docs-consistency: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
