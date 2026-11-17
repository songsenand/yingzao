#!/usr/bin/env node
// The mirror is only trustworthy if what it publishes is what the installer
// enforces. This checks the generated manifest against the pinned table, the
// presence of the license and source-offer files, and that the manifest is not
// stale (a hash change in provision-lib.mjs without regeneration fails here).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assetFor, OPENSCAD_VERSION } from './provision-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(ROOT, 'mirror');
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const generated = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-mirror-manifest.mjs'), '--check'], {
  encoding: 'utf8', timeout: 20000,
});
check('manifest matches the pinned table', generated.status === 0, (generated.stderr || generated.stdout).trim());

const manifest = JSON.parse(readFileSync(join(MIRROR, 'manifest.json'), 'utf8'));
check('manifest version is the pinned one', manifest.version === OPENSCAD_VERSION, manifest.version);
check('manifest lists every pinned platform',
  ['win32', 'linux', 'darwin'].every((p) => manifest.assets.some((a) => a.platform === p)));
check('manifest hashes equal the install path hashes',
  manifest.assets.every((a) => a.sha256 === assetFor(a.platform).sha256));
check('manifest mirrors point at the pinned version',
  manifest.assets.every((a) => a.mirror.includes(`/${OPENSCAD_VERSION}/`)));
check('license text is present', existsSync(join(MIRROR, manifest.licenseFile)));

const offer = readFileSync(join(MIRROR, manifest.sourceOffer), 'utf8');
check('source offer cites GPL-2.0 section 3(b)', /3\(b\)/.test(offer));
check('source offer names a contact', /@/.test(offer));
check('source offer points at upstream source', /github\.com\/openscad\/openscad/.test(offer));

console.log(`\naccept-mirror-manifest: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
