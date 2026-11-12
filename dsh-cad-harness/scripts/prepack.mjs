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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['npm', 'run', 'build']);
run([process.execPath, 'scripts/sync-cad-preset.mjs', '--without-skills']);
