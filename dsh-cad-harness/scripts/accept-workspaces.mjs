// Acceptance for marker-based workspace discovery (B, panel read side).
//
// The old scanner treated "two levels below the session cwd" as the project
// boundary, so a real project at depth 3 (examples/ball-and-stick/<molecule>)
// was invisible. B finds `<dir>/cad-data/` at any traversal depth (capped for
// safety), root-first, and never descends into skipped build/dependency trees.
//
//   node scripts/accept-workspaces.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspaces } from '../src/host/workspaces.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const base = mkdtempSync(join(tmpdir(), 'cad-workspaces-'));
const corpus = (dir, { legacy = false, versions = 1, parts = 0 } = {}) => {
  const cadData = join(dir, 'cad-data');
  mkdirSync(join(cadData, 'versions'), { recursive: true });
  for (let i = 1; i <= versions; i += 1) mkdirSync(join(cadData, 'versions', `v${String(i).padStart(3, '0')}`));
  if (!legacy) {
    writeFileSync(join(cadData, 'project.json'), JSON.stringify({ schemaVersion: 1, cwd: dir, key: 'x', title: basename(dir) }));
  }
  if (parts > 0) {
    mkdirSync(join(cadData, 'parts'), { recursive: true });
    writeFileSync(join(cadData, 'parts', 'manifest.json'), JSON.stringify({ parts: Array.from({ length: parts }, (_, i) => ({ id: `p${i}` })) }));
  }
};

try {
  corpus(base, { versions: 1 });
  corpus(join(base, 'projectA'), { versions: 2, parts: 3 });
  corpus(join(base, 'nested', 'deep', 'projectB'), { legacy: true, versions: 1 });
  corpus(join(base, 'nested', 'deep', 'projectC'), { legacy: true, versions: 0 });
  corpus(join(base, 'node_modules', 'ignored'), { versions: 9 });
  corpus(join(base, 'renders', 'ignored'), { versions: 9 });

  const entries = await discoverWorkspaces(base);
  const rels = entries.map((e) => e.rel);
  check(rels[0] === '.', 'the root corpus comes first', rels.join(', '));
  check(rels.includes('projectA'), 'a direct child corpus is found');
  check(rels.includes('nested/deep/projectB'), 'a depth-3 corpus is found (not a depth-2 boundary)', rels.join(', '));
  check(rels.includes('nested/deep/projectC'), 'a legacy corpus with no versions still appears');
  check(!rels.some((r) => r.includes('node_modules')), 'node_modules is not descended');
  check(!rels.some((r) => r.includes('renders')), 'renders is not descended');

  const a = entries.find((e) => e.rel === 'projectA');
  check(a?.versions === 2 && a?.parts === 3, 'the entry carries versions and parts', JSON.stringify(a));
  const b = entries.find((e) => e.rel === 'nested/deep/projectB');
  check(b?.versions === 1, 'a legacy manifest is counted', JSON.stringify(b));
  const c = entries.find((e) => e.rel === 'nested/deep/projectC');
  check(c?.versions === 0, 'an empty legacy corpus is not hidden', JSON.stringify(c));

  const again = await discoverWorkspaces(base);
  check(JSON.stringify(again.map((e) => e.rel)) === JSON.stringify(rels), 'the order is stable across calls');

  // The real examples tree is the regression that started this: the fructose
  // project sits at examples/ball-and-stick/<molecule> (depth 2 from examples).
  const real = await discoverWorkspaces(join(REPO, 'examples'));
  const realRels = real.map((e) => e.rel);
  check(realRels.includes('ball-and-stick/glucose-molecule'), 'the real glucose project is discovered', realRels.join(', '));
  check(realRels.includes('ball-and-stick/fructose-molecule'), 'the real fructose project is discovered', realRels.join(', '));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
