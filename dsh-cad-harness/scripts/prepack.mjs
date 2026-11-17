#!/usr/bin/env node
// prepack: make the tarball installable without a build step.
//
//  1. build lib/ (the published entry points)
//  2. generate the preset WITHOUT the machine-specific skill path
//
// (2) matters: npm runs `prepack` on the machine that packs, and a path from
// that machine is wrong on every user's disk. `dsh-cad-setup` writes the real
// path after install. `postpack` restores the checkout's development preset.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function cleanPythonCaches(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') rmSync(path, { recursive: true, force: true });
      else cleanPythonCaches(path);
    }
  }
}

// Tests run Python before `npm pack`; Numba/pycache files are machine-specific
// and must not enter the tarball. `files: ["python/"]` makes .npmignore
// ineffective here, so clean at the one point every pack goes through.
cleanPythonCaches(join(ROOT, 'python'));

run(['npm', 'run', 'build']);
run([process.execPath, 'scripts/sync-cad-preset.mjs', '--without-skills']);
