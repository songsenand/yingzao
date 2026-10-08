// Generate src/host/python-lock.ts — the pinned interpreter + dependency lock
// the host runtime provisions from.
//
// WHY A GENERATED TS MODULE AND NOT JSON: the lock must travel inside the
// published bundle (`files: ["lib/", ...]`), so a JSON file would have to be
// added to package "files", read at runtime relative to the bundle, and kept in
// sync by hand. A generated module is bundled by esbuild, needs no loader
// configuration, and follows the same convention as presets/cad/preset.patch.yml
// ("GENERATED — do not edit by hand").
//
// WHAT IT PINS:
//   1. the python-build-standalone build (tag + per-target archive sha256),
//      taken from the release SHA256SUMS asset — the same bytes uv installs;
//   2. the wheel set for the v1 dependencies, with sha256 for every wheel that
//      can match CPython 3.13 on a supported platform, so pip can run with
//      `--require-hashes --only-binary=:all:` and never compile anything.
//
// Usage:
//   node scripts/gen-python-lock.mjs [--tag 20261003] [--python 3.13.16] [--check]
//
// --check regenerates in memory and fails when the file on disk differs (CI).

import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'host', 'python-lock.ts');

const PBS_BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download';
// Order matters: the first entry is the canonical source, the rest are mirrors
// tried in turn when a download fails. Measured 2026-10-08: the official GitHub
// release is reachable but slow from CN; the npmmirror copy answered in 3.2s.
const PBS_MIRRORS = ['https://registry.npmmirror.com/-/binary/python-build-standalone'];

const TARGETS = [
  { key: 'linux-x64-gnu', asset: 'x86_64-unknown-linux-gnu', interpreter: 'bin/python3' },
  { key: 'linux-arm64-gnu', asset: 'aarch64-unknown-linux-gnu', interpreter: 'bin/python3' },
  { key: 'linux-x64-musl', asset: 'x86_64-unknown-linux-musl', interpreter: 'bin/python3' },
  { key: 'linux-arm64-musl', asset: 'aarch64-unknown-linux-musl', interpreter: 'bin/python3' },
  { key: 'darwin-arm64', asset: 'aarch64-apple-darwin', interpreter: 'bin/python3' },
  { key: 'darwin-x64', asset: 'x86_64-apple-darwin', interpreter: 'bin/python3' },
  { key: 'win32-x64', asset: 'x86_64-pc-windows-msvc', interpreter: 'python.exe' },
];

// Pinned versions, not "latest": a lock that moves under the user is not a lock.
// rapier3d is abi3 (cp39-abi3) and publishes no darwin-x64 wheel; that platform
// would have to compile Rust, so the lock carries a generated exclude directive
// instead of a PEP 508 marker (pip's requirements parser rejected the marker
// form when combined with --hash continuations — measured 2026-10-08).
const PACKAGES = [
  { name: 'numpy', version: '2.5.3' },
  { name: 'scipy', version: '1.18.1' },
  { name: 'trimesh', version: '5.1.1' },
  { name: 'manifold3d', version: '3.5.4' },
  { name: 'networkx', version: '3.7' },
  // Added 2026-10-08 because the repository's own FEM cross-validation script
  // (scripts/xval-cantilever-scikitfem.py) needs it: a runtime that cannot run
  // the work already in the repo is not the runtime this project asked for.
  // Pure-python wheel, numpy+scipy only — no platform matrix, no compiler.
  { name: 'scikit-fem', version: '12.0.2' },
  {
    name: 'rapier3d',
    version: '0.36.1',
    // No darwin-x64 wheel exists. The 2026-10-08 decision is to keep the TS
    // canonical there instead of building Rust on a user's machine — so the
    // package is dropped for that target AND the reason travels with it: a
    // silently missing physics library is how a model concludes "rapier3d is
    // broken" instead of "this platform uses the TS engine".
    exclude: {
      targets: ['darwin-x64'],
      reason: 'no darwin-x64 wheel — physics canonical stays the TS rapier3d-compat (HARNESS 12.5)',
    },
  },
];

function argOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const TAG = argOf('--tag', '20261003');
const PYTHON = argOf('--python', '3.13.16');

/** Both install_only flavours are published; the stripped one saves ~15%. */
function archiveName(python, tag, target) {
  return `cpython-${python}+${tag}-${target}-install_only_stripped.tar.gz`;
}

/**
 * Fetch with retries: this script talks to PyPI and GitHub from wherever it is
 * run, and a single dropped TLS socket should not fail a lock regeneration
 * (observed 2026-10-08 on this network).
 */
async function fetchWithRetry(url, as, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
      return as === 'json' ? await response.json() : await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

const fetchText = (url) => fetchWithRetry(url, 'text');
const fetchJson = (url) => fetchWithRetry(url, 'json');

async function pbsSums() {
  const sums = await fetchText(`${PBS_BASE}/${TAG}/SHA256SUMS`);
  const table = new Map();
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match) table.set(match[2], match[1]);
  }
  const targets = {};
  for (const target of TARGETS) {
    const asset = archiveName(PYTHON, TAG, target.asset);
    const sha256 = table.get(asset);
    if (!sha256) throw new Error(`SHA256SUMS has no entry for ${asset}`);
    targets[target.key] = { asset, sha256, interpreter: target.interpreter };
  }
  return targets;
}

/** A wheel is usable when its python tag is 3.13, abi3, or pure-python. */
function wheelMatches(wheel) {
  const parts = wheel.filename.replace(/\.whl$/, '').split('-');
  if (parts.length < 5) return false;
  const pytag = parts[parts.length - 3];
  const abitag = parts[parts.length - 2];
  if (abitag === 'abi3') return true;
  if (pytag === 'py3' || pytag === 'py2.py3') return true;
  return pytag.split('.').includes('cp313');
}

async function packageHashes(pkg) {
  const data = await fetchJson(`https://pypi.org/pypi/${pkg.name}/${pkg.version}/json`);
  const wheels = (data.urls ?? []).filter((entry) => entry.packagetype === 'bdist_wheel' && wheelMatches(entry));
  if (wheels.length === 0) throw new Error(`${pkg.name}==${pkg.version}: no CPython 3.13 wheels found`);
  const hashes = [...new Set(wheels.map((wheel) => wheel.digests.sha256))].sort();
  const platforms = [...new Set(wheels.map((wheel) => wheel.filename.split('-').slice(-1)[0].replace(/\.whl$/, '')))].sort();
  return {
    name: pkg.name,
    version: pkg.version,
    hashes,
    wheelCount: wheels.length,
    platforms,
    exclude: pkg.exclude ?? null,
  };
}

function requirementsText(entries) {
  const lines = [
    '# GENERATED by scripts/gen-python-lock.mjs — do not edit by hand.',
    '# Install with: pip install --require-hashes --only-binary=:all: -r requirements.lock',
    '# Every wheel that can match CPython 3.13 on a supported platform is listed;',
    '# pip checks only the hash of the file it actually selects.',
    '#',
    '# `# cad-exclude: <target,...> | <reason>` drops the block that follows on those',
    '# lock targets; the host runtime applies it while writing the lock it feeds pip',
    '# AND reports the skip, with the reason, in python_runtime status — so a package',
    '# that is absent by design is never mistaken for one that is broken.',
    '',
  ];
  for (const entry of entries) {
    if (entry.exclude) lines.push(`# cad-exclude: ${entry.exclude.targets.join(', ')} | ${entry.exclude.reason}`);
    lines.push(`# ${entry.name}==${entry.version}: ${entry.wheelCount} wheels (${entry.platforms.length} platform tags)`);
    lines.push(`${entry.name}==${entry.version} \\`);
    entry.hashes.forEach((hash, index) => {
      const last = index === entry.hashes.length - 1;
      lines.push(`    --hash=sha256:${hash}${last ? '' : ' \\'}`);
    });
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderModule({ targets, requirements, requirementsSha }) {
  const targetLines = Object.entries(targets)
    .map(
      ([key, value]) =>
        `  ${JSON.stringify(key)}: {\n` +
        `    asset: ${JSON.stringify(value.asset)},\n` +
        `    sha256: ${JSON.stringify(value.sha256)},\n` +
        `    interpreter: ${JSON.stringify(value.interpreter)},\n` +
        `  },`,
    )
    .join('\n');
  return `// GENERATED — do not edit by hand.
// Regenerate with: node scripts/gen-python-lock.mjs [--tag <pbs-tag>] [--python <version>]
//
// The interpreter is an artifact, not a host capability: python-build-standalone
// publishes relocatable CPython builds for every platform we support, so one
// code path provisions all of them. See docs/DECISION-LOG.md 2026-10-08.

/** Lock schema version; bumped when the shape of this module changes. */
export const PYTHON_LOCK_PROTOCOL = 1;

export interface PythonBuildTarget {
  asset: string;
  sha256: string;
  /** Interpreter path relative to the extracted archive root. */
  interpreter: string;
}

export interface PythonBuildLock {
  pythonVersion: string;
  buildTag: string;
  /** Canonical download root; mirrors are tried after it. */
  baseUrl: string;
  mirrors: readonly string[];
  /** Directory the archive is rooted at, stripped during extraction. */
  archiveRoot: string;
  targets: Readonly<Record<string, PythonBuildTarget>>;
}

export const PYTHON_BUILD: PythonBuildLock = {
  pythonVersion: ${JSON.stringify(PYTHON)},
  buildTag: ${JSON.stringify(TAG)},
  baseUrl: ${JSON.stringify(PBS_BASE)},
  mirrors: ${JSON.stringify(PBS_MIRRORS)},
  archiveRoot: 'python',
  targets: {
${targetLines}
  },
};

/**
 * pip indexes, tried in order. The first is canonical; the second exists because
 * a direct PyPI install of this dependency set measured 11m44s from CN
 * (2026-10-08) while the mirror answers instantly.
 *
 * Measured the same day, same network: registry.npmmirror.com/pypi/... returns
 * 404 for the simple index and pypi.tuna.tsinghua.edu.cn/simple returns 403,
 * so neither is listed; mirrors.aliyun.com/pypi/simple serves the full index
 * (verified to contain the pinned versions). Deployments with their own mirror
 * set DSH_CAD_PYTHON_INDEX_URL.
 */
export const PIP_INDEXES: readonly string[] = [
  'https://pypi.org/simple',
  'https://mirrors.aliyun.com/pypi/simple',
];

/** Written next to the venv and fed to pip verbatim. */
export const REQUIREMENTS_LOCK = ${JSON.stringify(requirements)};

/** Recorded in the venv marker so a lock change triggers a reinstall. */
export const REQUIREMENTS_LOCK_SHA256 = ${JSON.stringify(requirementsSha)};
`;
}

async function build() {
  const targets = await pbsSums();
  const entries = [];
  for (const pkg of PACKAGES) entries.push(await packageHashes(pkg));
  const requirements = requirementsText(entries);
  const requirementsSha = createHash('sha256').update(requirements).digest('hex');
  return { module: renderModule({ targets, requirements, requirementsSha }), entries, targets };
}

const check = process.argv.includes('--check');
const { module, entries, targets } = await build();

if (check) {
  const current = await readFile(OUT, 'utf8').catch(() => '');
  if (current !== module) {
    console.error('python-lock.ts is out of date — run: node scripts/gen-python-lock.mjs');
    process.exit(1);
  }
  console.log('python-lock.ts is up to date');
} else {
  await writeFile(OUT, module);
  console.log(`wrote ${OUT}`);
  console.log(`python ${PYTHON}+${TAG}: ${Object.keys(targets).length} targets`);
  for (const entry of entries) console.log(`  ${entry.name}==${entry.version}: ${entry.hashes.length} hashes / ${entry.wheelCount} wheels`);
}
