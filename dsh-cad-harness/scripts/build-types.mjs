#!/usr/bin/env node
// Emit .d.ts for the host entry after esbuild. The bundle has no types by
// itself, and package.json used to point at a file no build produced.
//
// tsc keeps source specifiers (`./tool-scope.ts`) in declarations. Rewrite only
// module specifiers to `.js` so a consumer's resolver finds the sibling .d.ts;
// comments and string literals are untouched.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'lib', 'types');
rmSync(OUT, { recursive: true, force: true });

const tsc = spawnSync(process.execPath, [
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--emitDeclarationOnly', '--declaration',
  '--outDir', OUT, '--rootDir', join(ROOT, 'src'),
  '--noEmit', 'false', '--allowImportingTsExtensions', 'true',
], { cwd: ROOT, encoding: 'utf8' });
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout + tsc.stderr);
  process.exit(tsc.status ?? 1);
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith('.d.ts') ? [path] : [];
  });
}

for (const file of walk(OUT)) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/((?:from|import)\s*\(?\s*['"])([^'"]+)(['"])/g, (all, before, spec, after) => {
    if (!spec.startsWith('.') || !spec.endsWith('.ts')) return all;
    return `${before}${spec.slice(0, -3)}.js${after}`;
  });
  if (next !== text) writeFileSync(file, next, 'utf8');
}

const entry = join(OUT, 'host', 'index.d.ts');
if (!existsSync(entry)) {
  console.error(`build-types: missing ${entry}`);
  process.exit(1);
}
console.log(`built ${entry}`);
