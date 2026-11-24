#!/usr/bin/env node
// Keep the repository-root package.json in step with the shipped package.
//
// The root manifest is a scanner-facing shim: no code, no build, only the
// `dsh.bundle` declaration plus the dependency that lets
// `dsh plugin add github:<owner>/<repo>` pull the real package. It therefore
// has no reason to hold a version of its own — a release bumps
// dsh-cad-harness/package.json, and this script copies that version and the
// dependency range into the shim.
//
//   node scripts/sync-root-version.mjs          # write the two fields
//   node scripts/sync-root-version.mjs --check  # exit 1 if they drifted
//
// Run by CI on every push; run it by hand before a release so the tag does not
// point at a shim that claims an older version.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');
const PACKAGE_JSON = join(PACKAGE_DIR, 'package.json');
const ROOT_JSON = resolve(PACKAGE_DIR, '..', 'package.json');

const check = process.argv.slice(2).includes('--check');

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
const root = JSON.parse(readFileSync(ROOT_JSON, 'utf8'));

const version = pkg.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-root-version: dsh-cad-harness version is not a version: ${version}`);
  process.exit(2);
}
const range = `^${version}`;

const before = {
  version: root.version,
  dependency: root?.dependencies?.['dsh-cad-harness'],
};

const drifted = before.version !== version || before.dependency !== range;
if (!drifted) {
  console.log(`root package.json is in sync (${version})`);
  process.exit(0);
}

if (check) {
  console.error(
    `sync-root-version: root package.json drifted — ` +
      `version ${before.version} → ${version}, dependency ${before.dependency} → ${range}\n` +
      `run: node scripts/sync-root-version.mjs`,
  );
  process.exit(1);
}

root.version = version;
root.dependencies = root.dependencies ?? {};
root.dependencies['dsh-cad-harness'] = range;
writeFileSync(ROOT_JSON, JSON.stringify(root, null, 2) + '\n', 'utf8');
console.log(`root package.json updated: ${before.version} → ${version}, dependency → ${range}`);
