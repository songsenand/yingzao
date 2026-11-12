#!/usr/bin/env node
// postpack: restore the checkout's development preset (with its real skill path)
// after `prepack` stripped it for the tarball.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const result = spawnSync(process.execPath, ['scripts/sync-cad-preset.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
