#!/usr/bin/env node
// Remove stale temporary directories left by compiles/checks/dialog tests.
//
// Dry-run by default. Only names created by this harness are touched:
//   cad-harness-*  cad-doctor-*  cad-setup-*  cad-export-*  cad-add-*
//   cad-bundle-*   cad-backend-* cad-pyfail-* cad-rehearse-* cad-http-*
//
//   npx dsh-cad-clean
//   npx dsh-cad-clean --apply
//   npx dsh-cad-clean --older-than-min 10 --json

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PREFIXES = ['cad-harness-', 'cad-doctor-', 'cad-setup-', 'cad-export-', 'cad-add-', 'cad-bundle-', 'cad-backend-', 'cad-pyfail-', 'cad-rehearse-', 'cad-http-'];
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`dsh-cad-clean: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const apply = args.includes('--apply');
const asJson = args.includes('--json');
const root = resolve(argValue('--tmpdir') ?? tmpdir());
const olderThanMin = Number(argValue('--older-than-min') ?? '60');
if (!Number.isFinite(olderThanMin) || olderThanMin < 0) {
  console.error('dsh-cad-clean: --older-than-min must be a non-negative number');
  process.exit(2);
}
const cutoff = Date.now() - olderThanMin * 60_000;

function sizeOf(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += sizeOf(path);
      else if (entry.isFile()) { try { total += statSync(path).size; } catch { /* racing delete */ } }
    }
  } catch { /* racing delete */ }
  return total;
}

const found = [];
if (existsSync(root)) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(root, entry.name);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (mtime > cutoff) continue;
    found.push({ path, mtime: new Date(mtime).toISOString(), bytes: sizeOf(path) });
  }
}

let removed = 0;
if (apply) {
  for (const item of found) {
    try { rmSync(item.path, { recursive: true, force: true }); removed++; }
    catch (error) { console.error(`dsh-cad-clean: cannot remove ${item.path}: ${String(error?.message ?? error)}`); }
  }
}

const payload = {
  tmpdir: root,
  olderThanMin,
  apply,
  candidates: found,
  bytes: found.reduce((sum, item) => sum + item.bytes, 0),
  removed,
};
if (asJson) console.log(JSON.stringify(payload, null, 2));
else {
  console.log(`dsh-cad-clean: ${found.length} candidate(s), ${(payload.bytes / 1024 / 1024).toFixed(1)} MiB, older than ${olderThanMin}m`);
  for (const item of found) console.log(`  ${apply && removed ? 'removed' : 'stale'} ${item.path} (${item.mtime})`);
  if (!apply && found.length) console.log('  dry-run only; pass --apply to remove');
}
process.exit(0);
