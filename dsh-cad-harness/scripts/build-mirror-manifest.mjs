#!/usr/bin/env node
// Generate (and optionally verify) mirror/manifest.json.
//
// The pinned table in provision-lib.mjs is the authority: this script only
// renders it, so the published mirror can never claim hashes the installer does
// not enforce. `--dir` additionally checks that the archives you are about to
// upload are the official bytes.
//
//   node scripts/build-mirror-manifest.mjs                 # write manifest.json
//   node scripts/build-mirror-manifest.mjs --check         # fail if it drifted
//   node scripts/build-mirror-manifest.mjs --dir ./assets  # verify archives, then write

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFor, OPENSCAD_VERSION, sha256File } from './provision-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MIRROR_DIR = join(ROOT, 'mirror');
const MANIFEST = join(MIRROR_DIR, 'manifest.json');

const args = process.argv.slice(2);
const check = args.includes('--check');
const dirIndex = args.indexOf('--dir');
const archiveDir = dirIndex >= 0 ? resolve(args[dirIndex + 1] ?? '') : null;

const PLATFORMS = ['win32', 'linux', 'darwin'];

function render() {
  const assets = PLATFORMS.map((platform) => {
    const asset = assetFor(platform);
    if (!asset) throw new Error(`no pinned asset for ${platform}`);
    return {
      filename: asset.filename,
      platform,
      archive: asset.archive,
      size: asset.size,
      sha256: asset.sha256,
      official: asset.official,
      mirror: asset.mirror,
    };
  });
  return {
    schema: 1,
    version: OPENSCAD_VERSION,
    license: 'GPL-2.0',
    licenseFile: 'LICENSE.GPL-2.0',
    sourceOffer: 'SOURCE-OFFER.md',
    officialBase: 'https://files.openscad.org/snapshots',
    assets,
  };
}

async function verify(dir) {
  const problems = [];
  for (const asset of render().assets) {
    const file = join(dir, asset.filename);
    if (!existsSync(file)) { problems.push(`${asset.filename}: missing`); continue; }
    const size = statSync(file).size;
    if (size !== asset.size) { problems.push(`${asset.filename}: size ${size} != ${asset.size}`); continue; }
    const sha = await sha256File(file);
    if (sha !== asset.sha256) problems.push(`${asset.filename}: sha256 ${sha.slice(0, 12)}… != ${asset.sha256.slice(0, 12)}…`);
  }
  return problems;
}

const manifest = render();
const text = `${JSON.stringify(manifest, null, 2)}\n`;

if (archiveDir) {
  const problems = await verify(archiveDir);
  if (problems.length) {
    console.error(`build-mirror-manifest: archives in ${archiveDir} are not the pinned bytes`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`verified ${manifest.assets.length} archive(s) in ${archiveDir}`);
}

const current = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : null;
if (check) {
  if (current === text) {
    console.log(`mirror/manifest.json matches the pinned ${OPENSCAD_VERSION} table`);
    process.exit(0);
  }
  console.error('mirror/manifest.json is stale — run `node scripts/build-mirror-manifest.mjs`');
  process.exit(1);
}

writeFileSync(MANIFEST, text, 'utf8');
console.log(`wrote mirror/manifest.json (${manifest.assets.length} assets, ${OPENSCAD_VERSION})`);
