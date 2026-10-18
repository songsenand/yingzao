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
  // Spatial index for trimesh's exact closest-point queries. Without it
  // `closest_point_naive` is 224–350× slower than three-mesh-bvh; with it the gap
  // is 30× at 0.61 ms/query (200 points = 122 ms), which the user accepted as the
  // price of moving measure_closest to Python (2026-10-08).
  // No dependencies; py3 wheels for all seven targets; no compiler.
  { name: 'rtree', version: '1.4.1' },
  // Polygonisation for `measure_section` (2026-10-12): a cross-section has to be
  // turned into polygons before its inner loops — the holes the section cuts
  // through — can be trusted. Hand-chaining the section's line segments and then
  // testing which loop contains which works until a section degenerates (tangent
  // plane, coincident loops, a hole that touches an edge), which is exactly when a
  // measurement is being relied on. shapely's `polygons_full` answers
  // exterior/interiors directly and is already a trimesh dependency in spirit
  // (`Path2D.polygons_full` is unusable without it).
  // Measured 2026-10-12: cp313 wheels for all seven targets (manylinux x86_64 /
  // aarch64, musllinux x86_64 / aarch64, macosx x86_64 / arm64, win_amd64), one
  // dependency (`numpy>=1.26`, already pinned at 2.5.3), no compiler.
  { name: 'shapely', version: '2.2.0' },
  // --- CAD import formats (adopted 2026-10-15, DECISION-LOG same day; probe
  // experiments/20261015_cad_import_probe.md) ---
  // cascadio: OpenCASCADE compiled as a STEP→GLB converter; the GLB then loads
  // through trimesh like any other mesh. Probe: colored.step → 242.2 mm³ solid
  // (Manifold NoError), multibody.step → 10 bodies / 263544 mm³ / genus 12; the
  // GLB declares METERS, so the worker scales ×1000 to mm. MIT, zero deps.
  // Pinned on purpose: upstream deletes old releases from PyPI when it hits the
  // size cap (README warning) — a floating pin would break provisioning someday.
  // No musl wheels exist.
  {
    name: 'cascadio',
    version: '0.1.1',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl'],
      reason: 'no musl wheel — STEP import unavailable there (host reports the skip)',
    },
  },
  // ezdxf: DXF reader (entities, path flattening, $INSUNITS units). MIT,
  // pure-python wheel. Its transitive deps (pyparsing, fonttools,
  // typing_extensions, numpy) are all already pinned above, so it adds no new
  // platform surface.
  { name: 'ezdxf', version: '1.4.4' },
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
      reason: 'no darwin-x64 wheel — physics canonical stays the TS rapier3d-compat (DESIGN §31.4)',
    },
  },
  // MPM kernel JIT engine (adopted 2026-10-14, DECISION-LOG same day; measurement
  // experiments/20261014_numba_mpm_probe.md): the same kernel algorithm, compiled —
  // 5.1–8.7× over the numpy kernel, 1.3–2.0× over the TS kernel on the pipe
  // benchmark, with parity at float32 rounding scale. Engine selection lives in
  // the worker (`worker._mpm_engine`, env `CAD_MPM_ENGINE`): numba when
  // importable, numpy otherwise — so a target without wheels degrades to the
  // slower kernel it already had, never to a broken tool.
  // Requires numpy<2.6 (pin 2.5.3 satisfies) and llvmlite (pinned alongside).
  // cp313 wheels exist for manylinux x86_64/aarch64, macOS arm64 and Windows
  // x64/arm64 only — no musl, no darwin-x64.
  {
    name: 'numba',
    version: '0.68.0',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl', 'darwin-x64'],
      reason: 'no cp313 wheel — MPM engine falls back to the numpy kernel (worker _mpm_engine)',
    },
  },
  {
    name: 'llvmlite',
    version: '0.50.0',
    // numba's hard dependency (llvmlite<0.51,>=0.50); pip --require-hashes
    // needs every transitive dep pinned and hashed, so it travels in the lock
    // with the same exclusion set as numba.
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl', 'darwin-x64'],
      reason: 'numba dependency, same cp313 wheel gaps as numba',
    },
  },
  // --- XLB LBM engine stack (adopted 2026-10-15, DECISION-LOG same day + addendum) ---
  // Probe: experiments/20261015_xlb_lbm_probe.md. Three known 0.3.1 defects are
  // absorbed by the worker wrapper (lbm_xlb.py): ZouHe prescribed_values shim
  // (mirrors upstream main verbatim, drop on next release), overlap-checker
  // replacement (numpy 2.5 list+=ndarray semantic change), warp pin below.
  {
    name: 'xlb',
    version: '0.3.1',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl', 'darwin-x64'],
      reason: 'LBM engine entry; useless without warp/jaxlib (same platform gaps)',
    },
  },
  {
    name: 'warp-lang',
    version: '1.12.1',
    // Pinned BELOW latest 1.18 on purpose: 1.18 removed warp.utils.ScopedTimer,
    // which breaks `import xlb` at 0.3.1 (probe 2026-10-15). Revisit when xlb
    // ships a release carrying its Warp upgrade (upstream PR #168).
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl', 'darwin-x64'],
      reason: 'no cp313 wheel on musl/darwin-x64 — xlb import requires warp (probe 2026-10-15)',
    },
  },
  {
    name: 'jax',
    version: '0.11.2',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl', 'darwin-x64'],
      reason: 'needs jaxlib; LBM engine unavailable where jaxlib is excluded',
    },
  },
  {
    name: 'jaxlib',
    version: '0.11.2',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl', 'darwin-x64'],
      reason: 'no cp313 wheel on musl/darwin-x64 — jax compute stack unavailable',
    },
  },
  {
    name: 'ml_dtypes',
    version: '0.6.0',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl'],
      reason: 'no cp313 musl wheel — jax dependency',
    },
  },
  // --- XLB transitive closure (pip resolve 2026-10-15 under lock constraints;
  // --require-hashes needs every transitive dep pinned and hashed) ---
  {
    name: 'matplotlib',
    version: '3.11.2',
    exclude: {
      targets: ['linux-arm64-musl'],
      reason: 'no cp313 musllinux aarch64 wheel — pyvista dependency',
    },
  },
  { name: 'contourpy', version: '1.4.0' },
  { name: 'cycler', version: '0.12.1' },
  { name: 'fonttools', version: '4.66.1' },
  { name: 'kiwisolver', version: '1.5.1' },
  { name: 'pillow', version: '12.3.0' },
  { name: 'pyparsing', version: '3.3.3' },
  { name: 'python-dateutil', version: '2.9.0.post0' },
  { name: 'six', version: '1.17.0' },
  {
    name: 'vtk',
    version: '9.7.1',
    exclude: {
      targets: ['linux-x64-musl', 'linux-arm64-musl'],
      reason: 'no cp313 musl wheel — pyvista dependency',
    },
  },
  { name: 'pyvista', version: '0.49.1' },
  { name: 'pooch', version: '1.9.0' },
  { name: 'scooby', version: '0.12.0' },
  { name: 'pyvista-validation', version: '0.2.2' },
  { name: 'requests', version: '2.34.2' },
  { name: 'urllib3', version: '2.8.0' },
  { name: 'idna', version: '3.20' },
  { name: 'charset-normalizer', version: '3.5.2' },
  { name: 'certifi', version: '2026.7.22' },
  { name: 'platformdirs', version: '4.13.0' },
  { name: 'numpy-stl', version: '4.0.1' },
  { name: 'python-utils', version: '4.1.2' },
  { name: 'pydantic', version: '2.14.1' },
  { name: 'pydantic_core', version: '2.50.1' },
  { name: 'annotated-types', version: '0.8.0' },
  { name: 'attrs', version: '26.1.0' },
  { name: 'opt_einsum', version: '3.4.0' },
  { name: 'typing_extensions', version: '4.16.0' },
  { name: 'typing-inspection', version: '0.4.4' },
  { name: 'ruff', version: '0.17.0' },
  { name: 'cyclopts', version: '5.2.0' },
  { name: 'docstring_parser', version: '0.18.0' },
  { name: 'rich', version: '15.0.0' },
  { name: 'rich-rst', version: '2.2.0' },
  { name: 'markdown-it-py', version: '4.2.0' },
  { name: 'mdurl', version: '0.1.2' },
  { name: 'Pygments', version: '2.21.0' },
  { name: 'packaging', version: '26.3' },
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
 * pip indexes, tried in order. 用户拍板（2026-10-15）：国内部署**阿里云优先**。
 * 依据（同日，xlb 栈 ~340MB 实装）：pypi.org 的 files.pythonhosted.org 通道会把
 * 大闭包安装拖到 16 分钟以上，甚至无限停滞（0 字节/40s，socket 不报错所以轮内
 * 失败转移不触发）；mirrors.aliyun.com 同一闭包数分钟完成。pypi.org 保留为
 * 第二源（上游权威），仅在前者失败时兜底。部署若另有镜像，用
 * DSH_CAD_PYTHON_INDEX_URL 直接指定单源。
 */
export const PIP_INDEXES: readonly string[] = [
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple',
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
