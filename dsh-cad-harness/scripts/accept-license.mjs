#!/usr/bin/env node
// N18 acceptance: the preview tarball must not smuggle GPL binaries or large
// third-party trees, and must carry its own license + notice.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = pkg.files ?? [];
check('package license is Apache-2.0', pkg.license === 'Apache-2.0', pkg.license ?? '');
check('LICENSE exists', existsSync(join(ROOT, 'LICENSE')));
check('NOTICE exists', existsSync(join(ROOT, 'NOTICE')));
check('README exists', existsSync(join(ROOT, 'README.md')));
check('LICENSE is shipped', files.includes('LICENSE'));
check('NOTICE is shipped', files.includes('NOTICE'));
check('README is shipped', files.includes('README.md'));

const forbidden = [
  [/^bin\//, 'OpenSCAD bin/'],
  [/BOSL2/i, 'BOSL2'],
  [/node_modules/, 'node_modules'],
  [/\.AppImage$/i, 'AppImage'],
  [/site-packages/, 'Python site-packages'],
  [/^cad-data\//, 'project corpus'],
];
for (const [pattern, label] of forbidden) {
  check(`files has no ${label}`, !files.some((f) => pattern.test(f)), files.filter((f) => pattern.test(f)).join(', '));
}

// The package root itself must not contain the excluded trees.
for (const [path, label] of [
  ['bin', 'bin/'], ['lib/BOSL2', 'lib/BOSL2'],
]) {
  check(`package root has no ${label}`, !existsSync(join(ROOT, path)));
}

console.log(`\naccept-license: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
