// Acceptance for the nearest-marker project root resolver (B).
//
// B (docs/dev/PROJECT-SCOPE.md): the project root is the nearest ancestor with
// `cad-data/project.json`; a bare `cad-data/` is a legacy marker; with neither,
// the starting directory is a new project candidate. This is the locator only —
// wiring it into projectCwdOf / panel discovery is a later phase, so the test
// exercises resolveProjectRoot directly.
//
//   node scripts/accept-project-root.mjs
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectRoot, clearProjectRootCache } from '../src/host/project.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const base = mkdtempSync(join(tmpdir(), 'cad-project-root-'));
const marker = (dir) => {
  mkdirSync(join(dir, 'cad-data'), { recursive: true });
  writeFileSync(join(dir, 'cad-data', 'project.json'), '{}\n');
};
const legacy = (dir) => mkdirSync(join(dir, 'cad-data'), { recursive: true });

try {
  const root = join(base, 'root');
  marker(root);
  mkdirSync(join(root, 'spec'), { recursive: true });
  check(resolveProjectRoot(root).root === root && resolveProjectRoot(root).marker === 'project',
    'a marker at the start resolves to itself', JSON.stringify(resolveProjectRoot(root)));
  check(resolveProjectRoot(join(root, 'spec')).root === root,
    'a subdirectory resolves to the nearest marker', resolveProjectRoot(join(root, 'spec')).root);

  const nested = join(root, 'nested');
  marker(nested);
  mkdirSync(join(nested, 'spec'), { recursive: true });
  check(resolveProjectRoot(join(nested, 'spec')).root === nested,
    'a nested marker wins over its parent', resolveProjectRoot(join(nested, 'spec')).root);

  const sibling = join(base, 'sibling');
  marker(sibling);
  check(resolveProjectRoot(sibling).root === sibling,
    'a sibling project resolves to itself', resolveProjectRoot(sibling).root);

  const legacyRoot = join(base, 'legacy');
  legacy(legacyRoot);
  check(resolveProjectRoot(legacyRoot).root === legacyRoot && resolveProjectRoot(legacyRoot).marker === 'legacy',
    'a bare cad-data/ is a legacy marker', JSON.stringify(resolveProjectRoot(legacyRoot)));

  const fresh = join(base, 'fresh');
  mkdirSync(fresh);
  const freshResult = resolveProjectRoot(fresh);
  check(freshResult.root === fresh && freshResult.marker === 'new',
    'no marker -> the start is a new project candidate', JSON.stringify(freshResult));

  const link = join(base, 'link');
  symlinkSync(root, link, 'dir');
  check(resolveProjectRoot(join(link, 'spec')).root === root,
    'a symlinked path resolves through realpath', resolveProjectRoot(join(link, 'spec')).root);

  const missing = join(base, 'missing', 'sub');
  check(resolveProjectRoot(missing).root === missing,
    'a non-existent start is still a new candidate', resolveProjectRoot(missing).root);

  // Cache: a "new" answer must be invalidated when a marker is written later.
  clearProjectRootCache();
  const later = join(base, 'later');
  mkdirSync(later);
  check(resolveProjectRoot(later).marker === 'new', 'new candidate before the marker');
  marker(later);
  clearProjectRootCache();
  check(resolveProjectRoot(later).marker === 'project',
    'a written marker is visible after cache invalidation', JSON.stringify(resolveProjectRoot(later)));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
