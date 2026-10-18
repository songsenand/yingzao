// Gain measurements for the "迁 Python" column of docs/archive/TOOL-RUNTIME-MATRIX.md.
//
// The criterion is "默认迁 Python"; the matrix still has a 收益 column with
// numbers I had not measured (MPM 5–20×, FEM faster, STL parse faster). This
// script replaces those guesses with data, so the batch order rests on
// measurements rather than on my expectations.
//
//   M1  MPM kernel proxy: TS ladder baseline vs a numpy P2G+grid+G2P kernel
//   M2  voxel FEM: TS matrix-free CG baseline vs scikit-fem (same cantilever)
//   M3  binary STL parse: TS parseBinaryStl (parse+weld) vs numpy / trimesh
//
//   node scripts/measure-python-gains.mjs [--runtime <dir>] [--out <json>]
//
// Honesty about scope: M1 is a KERNEL PROXY — same P2G/update/G2P arithmetic and
// neighbour counts, without the constitutive model and boundary details of
// mpm.ts. It measures the part that dominates a step, and is labelled as a
// proxy wherever it is reported.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseBinaryStl, isWatertight, connectedBodies } from '../src/host/mesh.ts';
import { buildSolid } from '../src/host/assembly.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const RUNTIME_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const OUT = resolve(argOf('--out', join(ROOT, 'data', 'bench', 'python-gains.json')));
const VENV_PYTHON = process.platform === 'win32'
  ? join(RUNTIME_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(RUNTIME_ROOT, 'venv', 'bin', 'python');
const STL = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '整机.stl');
const STL_A = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r020', 'parts', '底座.stl');
const STL_B = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r020', 'parts', '上半机.stl');

if (!existsSync(VENV_PYTHON)) {
  console.error(`no venv python at ${VENV_PYTHON} — provision first`);
  process.exit(2);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summarize = (xs) => ({ n: xs.length, medianMs: +median(xs).toFixed(3), minMs: +Math.min(...xs).toFixed(3), maxMs: +Math.max(...xs).toFixed(3) });

function runPython(script, argv = [], timeoutMs = 900_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(VENV_PYTHON, ['-I', '-c', script, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('python timed out')); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out.trim());
      else reject(new Error(`python exit ${code}: ${err.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

// ---------------------------------------------------------------------------
// M1 — 2D-ish MPM kernel proxy in numpy (P2G scatter → grid update → G2P gather)
// ---------------------------------------------------------------------------
const PY_MPM = `
import json, sys, time
import numpy as np
from scipy.sparse import csr_matrix

nx, ny, nz = 24, 24, 100
N = nx * ny * nz
dx = 2.0
counts = [int(x) for x in sys.argv[1].split(",")]
steps = 20

def terms(u):
    i = np.floor(u).astype(np.int64)
    f = u - i
    return i, np.stack([0.5 * (1.0 - f) ** 2, 0.75 - (f - 0.5) ** 2, 0.5 * f ** 2], axis=1)

def neighbour_pairs(pos):
    ix, wx = terms(pos[:, 0] / dx - 0.5)
    iy, wy = terms(pos[:, 1] / dx - 0.5)
    iz, wz = terms(pos[:, 2] / dx - 0.5)
    pairs = []
    for a in range(3):
        for b in range(3):
            for c in range(3):
                w = wx[:, a] * wy[:, b] * wz[:, c]
                idx = ((ix + a - 1) * ny + (iy + b - 1)) * nz + (iz + c - 1)
                np.clip(idx, 0, N - 1, out=idx)
                pairs.append((idx, w))
    return pairs

def updated_grid(pairs, mass, vel):
    grid_m = np.zeros(N)
    grid_mv = np.zeros((N, 3))
    for idx, w in pairs:
        grid_m += np.bincount(idx, weights=w, minlength=N)
        for k in range(3):
            grid_mv[:, k] += np.bincount(idx, weights=w * vel[:, k], minlength=N)
    gv = np.divide(grid_mv, grid_m[:, None], out=np.zeros_like(grid_mv), where=grid_m[:, None] > 1e-12)
    gv[:, 2] -= 9.8 / 60.0
    return gv

def step_bincount(pos, vel, mass):
    pairs = neighbour_pairs(pos)
    gv = updated_grid(pairs, mass, vel)
    new_vel = np.zeros_like(vel)
    for idx, w in pairs:
        new_vel += gv[idx] * w[:, None]
    return new_vel

def step_sparse(pos, vel, mass):
    pairs = neighbour_pairs(pos)
    count = pos.shape[0]
    rows = np.repeat(np.arange(count), 27)
    cols = np.stack([idx for idx, _ in pairs], axis=1).ravel()
    vals = np.stack([w for _, w in pairs], axis=1).ravel()
    W = csr_matrix((vals, (rows, cols)), shape=(count, N))
    grid_m = np.asarray(W.T @ mass).ravel()
    grid_mv = np.asarray(W.T @ (mass[:, None] * vel))
    gv = np.divide(grid_mv, grid_m[:, None], out=np.zeros_like(grid_mv), where=grid_m[:, None] > 1e-12)
    gv[:, 2] -= 9.8 / 60.0
    return np.asarray(W @ gv)

out = []
for count in counts:
    rng = np.random.default_rng(42)
    base_pos = rng.random((count, 3)) * np.array([(nx - 4) * dx, (ny - 4) * dx, (nz - 4) * dx]) + 2 * dx
    mass = np.full(count, 1.0)
    for name, fn in (("bincount", step_bincount), ("sparse", step_sparse)):
        pos = base_pos.copy()
        vel = np.zeros((count, 3))
        fn(pos, vel, mass)  # warm up allocator paths
        t0 = time.perf_counter()
        for _ in range(steps):
            vel = fn(pos, vel, mass)
        ms = (time.perf_counter() - t0) / steps * 1000
        out.append({"particles": count, "impl": name, "msPerStep": round(ms, 2)})
print(json.dumps(out))
`;

// ---------------------------------------------------------------------------
// M2 — the same cantilever the TS matrix-free solver and scikit-fem both solve
// ---------------------------------------------------------------------------
const PY_FEM = `
import json, sys, time
import numpy as np
from skfem import MeshHex, ElementHex1, ElementVectorH1, Basis, asm, condense
from skfem.utils import solve, solver_iter_cg
from skfem.models.elasticity import linear_elasticity

L, B, H, E, nu, F = 100., 10., 10., 200000., 0.3, 100.
I = B * H ** 3 / 12
dref = F * L ** 3 / (3 * E * I)
# mode "cg" skips the direct solve: at n=16 the sparse factorization alone took
# ~9 min in the first run, and the apples-to-apples number against the TS
# matrix-free CG is the iterative one.
mode = sys.argv[2] if len(sys.argv) > 2 else "full"
out = []
for n in [int(x) for x in sys.argv[1].split(",")]:
    t0 = time.perf_counter()
    m = MeshHex.init_tensor(np.linspace(0, L, 10 * n + 1), np.linspace(-5, 5, n + 1), np.linspace(-5, 5, n + 1))
    basis = Basis(m, ElementVectorH1(ElementHex1()))
    lam = E * nu / ((1 + nu) * (1 - 2 * nu))
    mu = E / (2 * (1 + nu))
    K = asm(linear_elasticity(lam, mu), basis)
    assemble_ms = (time.perf_counter() - t0) * 1000
    nd = basis.nodal_dofs
    xn = basis.doflocs[0, nd[0]]
    fixed = nd[:, np.isclose(xn, 0.)].ravel()
    tip = np.where(np.isclose(xn, L))[0]
    f = np.zeros(basis.N)
    f[nd[1, tip]] = -F / len(tip)

    row = {"n": n, "elements": int(m.t.shape[1]), "dof": int(basis.N), "assembleMs": round(assemble_ms, 1)}

    # (a) the default scikit-fem path: sparse assembly + DIRECT solve.
    # solve(*condense(...)) returns the FULL-size vector (skfem un-condenses),
    # which is what the nodal indexing below needs.
    if mode == "full":
        t0 = time.perf_counter()
        u = solve(*condense(K, f, D=fixed))
        row["directMs"] = round((time.perf_counter() - t0) * 1000, 1)
        row["directDelta"] = round(-float(np.mean(u[nd[1, tip]])), 4)

    # (b) apples-to-apples with the TS matrix-free solver: CG on the same matrix
    t0 = time.perf_counter()
    u = solve(*condense(K, f, D=fixed), solver=solver_iter_cg(atol=1e-10, maxiter=20000))
    row["cgMs"] = round((time.perf_counter() - t0) * 1000, 1)
    row["cgDelta"] = round(-float(np.mean(u[nd[1, tip]])), 4)
    row["deltaErrorPct"] = round(100 * (row["cgDelta"] - dref) / dref, 2)
    out.append(row)
print(json.dumps(out))
`;

// ---------------------------------------------------------------------------
// M4 — manifold boolean + volume: the SAME C++ kernel through two bindings
// ---------------------------------------------------------------------------
const PY_MANIFOLD = `
import json, sys, time
import numpy as np, trimesh
from manifold3d import Manifold, Mesh

paths = sys.argv[1].split(",")
reps = int(sys.argv[2]) if len(sys.argv) > 2 else 5
times = []
triangles = 0
volume = 0.0
for _ in range(reps):
    t0 = time.perf_counter()
    solids = []
    for p in paths:
        m = trimesh.load(p, process=True)
        triangles = int(len(m.faces))
        v = np.ascontiguousarray(m.vertices, dtype=np.float32)
        f = np.ascontiguousarray(m.faces, dtype=np.uint32)
        solids.append(Manifold(Mesh(v, f)))
    union = solids[0]
    for s in solids[1:]:
        union = union + s
    volume = float(union.volume())
    times.append((time.perf_counter() - t0) * 1000)
print(json.dumps({"items": len(paths), "unionLoadMs": times, "volumeMm3": volume, "lastTriangles": triangles}))
`;

// ---------------------------------------------------------------------------
// M5 — connectivity + watertight, which is what check_connectivity reports
// ---------------------------------------------------------------------------
const PY_MESH = `
import json, sys, time
import trimesh

path, reps = sys.argv[1], int(sys.argv[2])
load_watertight = []
split = []
watertight = None
bodies = None
for _ in range(reps):
    t0 = time.perf_counter()
    m = trimesh.load(path, process=True)
    watertight = bool(m.is_watertight)
    load_watertight.append((time.perf_counter() - t0) * 1000)
    t1 = time.perf_counter()
    parts = m.split(only_watertight=False)
    bodies = len(parts)
    split.append((time.perf_counter() - t1) * 1000)
print(json.dumps({"loadPlusWatertightMs": load_watertight, "splitMs": split, "watertight": watertight, "bodies": bodies}))
`;

// ---------------------------------------------------------------------------
// M3 — binary STL parse (+ weld, which is what the TS parser returns)
// ---------------------------------------------------------------------------
const PY_STL = `
import json, sys, time
import numpy as np, trimesh

path, reps = sys.argv[1], int(sys.argv[2])
data = open(path, "rb").read()
n = int.from_bytes(data[80:84], "little")
dt = np.dtype([("n", "<3f4"), ("v", "<9f4"), ("attr", "<u2")])

raw = []
for _ in range(reps):
    t0 = time.perf_counter()
    tris = np.frombuffer(data, dtype=dt, count=n, offset=84)
    verts = tris["v"].reshape(n, 3, 3)
    raw.append((time.perf_counter() - t0) * 1000)

weld = []
for _ in range(reps):
    t0 = time.perf_counter()
    mesh = trimesh.load(path, process=True)
    _ = mesh.vertices
    weld.append((time.perf_counter() - t0) * 1000)

print(json.dumps({"triangles": int(n), "rawParseMs": raw, "trimeshWeldMs": weld, "vertices": int(len(verts.reshape(-1, 3)))}))
`;

const ONLY = argOf('--only', null);
const wants = (section) => !ONLY || ONLY === section;

mkdirSync(dirname(OUT), { recursive: true });
// Merge into any previous run so `--only` invocations accumulate.
const result = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
result.generatedAt = new Date().toISOString();
result.venvPython = VENV_PYTHON;

// TS baselines that already exist in the repo (data/bench/mpm-scaling.json and
// experiments/20261008_cantilever_voxel_fem_probe.md) are quoted, not re-run:
// re-running them would measure the same code twice.
const mpmTs = [8820, 70560, 261950].map((particles) => {
  const row = JSON.parse(readFileSync(join(ROOT, 'data', 'bench', 'mpm-scaling.json'), 'utf8'))
    .find((entry) => entry.particles === particles);
  return { particles, msPerStep: row?.msPerStepP50 ?? null };
});
const femTs = [{ n: 4, elements: 640, ms: 100 }, { n: 8, elements: 5120, ms: 1700 }, { n: 16, elements: 40960, ms: 27800 }];

if (wants('m1')) {
  console.log('--- M1 MPM kernel (TS baseline from data/bench/mpm-scaling.json) ---');
  const mpmPy = JSON.parse(await runPython(PY_MPM, [mpmTs.map((r) => r.particles).join(',')]));
  result.m1MpmKernel = mpmTs.map((ts) => {
    const bincount = mpmPy.find((r) => r.particles === ts.particles && r.impl === 'bincount');
    const sparse = mpmPy.find((r) => r.particles === ts.particles && r.impl === 'sparse');
    return {
      particles: ts.particles,
      tsMsPerStepP50: ts.msPerStep,
      numpyBincountMsPerStep: bincount?.msPerStep ?? null,
      numpySparseMsPerStep: sparse?.msPerStep ?? null,
      bincountSpeedup: ts.msPerStep && bincount ? +(ts.msPerStep / bincount.msPerStep).toFixed(2) : null,
      sparseSpeedup: ts.msPerStep && sparse ? +(ts.msPerStep / sparse.msPerStep).toFixed(2) : null,
    };
  });
  for (const row of result.m1MpmKernel) {
    console.log(`  ${String(row.particles).padStart(7)} particles: TS ${row.tsMsPerStepP50} ms · numpy bincount ${row.numpyBincountMsPerStep} ms (${row.bincountSpeedup}×) · numpy sparse ${row.numpySparseMsPerStep} ms (${row.sparseSpeedup}×)`);
  }
}

if (wants('m1c')) {
  console.log('--- M1c native ceiling (gcc -O3, scripts/native/mpm-kernel-bench.c) ---');
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync: mkdirNative } = await import('node:fs');
  // Build into a gitignored scratch DIRECTORY (/.tmp-*/ matches directories, so a
  // bare file in the repo root would show up as untracked).
  const binDir = join(REPO, '.tmp-native');
  mkdirNative(binDir, { recursive: true });
  const binary = join(binDir, 'mpm-kernel-bench');
  execFileSync('gcc', ['-O3', '-march=native', '-o', binary, join(ROOT, 'scripts', 'native', 'mpm-kernel-bench.c'), '-lm']);
  const output = execFileSync(binary, [], { encoding: 'utf8' });
  const nativeRows = output.trim().split('\n').map((line) => {
    const match = /particles=(\d+)\s+ms\/step=([\d.]+)/.exec(line);
    return { particles: Number(match[1]), msPerStep: Number(match[2]) };
  });
  result.m1cNative = nativeRows.map((native) => {
    const ts = mpmTs.find((t) => t.particles === native.particles);
    return { particles: native.particles, tsMsPerStepP50: ts?.msPerStep ?? null, nativeMsPerStep: native.msPerStep, nativeSpeedupVsTs: ts ? +(ts.msPerStep / native.msPerStep).toFixed(2) : null };
  });
  for (const row of result.m1cNative) {
    console.log(`  ${String(row.particles).padStart(7)} particles: TS ${row.tsMsPerStepP50} ms · native C ${row.nativeMsPerStep} ms · ${row.nativeSpeedupVsTs}×`);
  }
}

if (wants('m2')) {
  console.log('--- M2 voxel FEM (TS baseline from the cantilever experiment) ---');
  const femPy = JSON.parse(await runPython(PY_FEM, ['4,8,16', 'cg']));
  result.m2VoxelFem = femPy.map((py) => {
    const ts = femTs.find((t) => t.n === py.n);
    return {
      n: py.n, elements: py.elements, dof: py.dof,
      tsMatrixFreeCgMs: ts?.ms ?? null,
      pyAssembleMs: py.assembleMs,
      pyDirectMs: py.directMs, pyCgMs: py.cgMs,
      directSpeedup: ts ? +(ts.ms / py.directMs).toFixed(2) : null,
      cgSpeedup: ts ? +(ts.ms / py.cgMs).toFixed(2) : null,
      delta: py.cgDelta, deltaErrorPct: py.deltaErrorPct,
    };
  });
  for (const row of result.m2VoxelFem) {
    console.log(`  n=${String(row.n).padStart(2)} ${String(row.elements).padStart(5)} elem / ${String(row.dof).padStart(6)} dof: TS ${row.tsMatrixFreeCgMs} ms · scikit-fem assemble ${row.pyAssembleMs} ms + direct ${row.pyDirectMs} ms (${row.directSpeedup}×) / CG ${row.pyCgMs} ms (${row.cgSpeedup}×) · δ=${row.delta} (${row.deltaErrorPct}%)`);
  }
}

if (wants('m3')) {
  console.log('--- M3 binary STL parse (+weld) ---');
  const reps = 10;
  const tsParse = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const mesh = parseBinaryStl(new Uint8Array(readFileSync(STL)));
    tsParse.push(performance.now() - t0);
    if (i === reps - 1) result.m3Stl = { triangles: mesh.triVerts.length / 3, weldBverts: mesh.vertProperties.length / 3 };
  }
  const pyStl = JSON.parse(await runPython(PY_STL, [STL, String(reps)]));
  result.m3Stl = {
    ...result.m3Stl,
    bytes: readFileSync(STL).length,
    tsParseAndWeld: summarize(tsParse),
    pyRawParse: summarize(pyStl.rawParseMs),
    pyTrimeshWeld: summarize(pyStl.trimeshWeldMs),
  };
  console.log(`  triangles ${result.m3Stl.triangles} · TS parse+weld ${result.m3Stl.tsParseAndWeld.medianMs} ms`);
  console.log(`  numpy raw parse (zero-copy view) ${result.m3Stl.pyRawParse.medianMs} ms · trimesh load+weld ${result.m3Stl.pyTrimeshWeld.medianMs} ms`);
}

if (wants('m4')) {
  console.log('--- M4 manifold boolean + volume (same C++ kernel, two bindings) ---');
  const reps = 5;
  const tsTimes = [];
  let tsVolume = 0;
  let tsTriangles = 0;
  if (!existsSync(STL_A) || !existsSync(STL_B)) {
    console.log(`  SKIP: need ${STL_A} and ${STL_B}`);
  } else {
    const aBytes = new Uint8Array(readFileSync(STL_A));
    const bBytes = new Uint8Array(readFileSync(STL_B));
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const a = await buildSolid(aBytes, undefined);
      const b = await buildSolid(bBytes, undefined);
      const union = a.solid.add(b.solid);
      tsVolume = union.volume();
      tsTriangles = union.numTri();
      tsTimes.push(performance.now() - t0);
    }
    const pyTimes = JSON.parse(await runPython(PY_MANIFOLD, [`${STL_A},${STL_B}`, String(reps)]));
    result.m4Manifold = {
      parts: ['底座.stl', '上半机.stl'],
      tsBuildUnion: summarize(tsTimes),
      pyBuildUnion: summarize(pyTimes.unionLoadMs),
      tsVolumeMm3: +tsVolume.toFixed(3),
      pyVolumeMm3: +Number(pyTimes.volumeMm3).toFixed(3),
      volumeDeltaMm3: +Math.abs(tsVolume - Number(pyTimes.volumeMm3)).toFixed(6),
      tsUnionTriangles: tsTriangles,
    };
    console.log(`  TS   build 2 solids + union + volume: ${result.m4Manifold.tsBuildUnion.medianMs} ms (volume ${result.m4Manifold.tsVolumeMm3} mm³)`);
    console.log(`  py   build 2 solids + union + volume: ${result.m4Manifold.pyBuildUnion.medianMs} ms (volume ${result.m4Manifold.pyVolumeMm3} mm³) · Δ=${result.m4Manifold.volumeDeltaMm3} mm³`);
  }
}

if (wants('m5')) {
  console.log('--- M5 connectivity + watertight (check_connectivity) ---');
  const reps = 10;
  const tsLoadWt = [];
  const tsBodies = [];
  let tsBodyCount = 0;
  let tsWatertight = false;
  for (let i = 0; i < reps; i++) {
    const bytes = new Uint8Array(readFileSync(STL));
    const t0 = performance.now();
    const mesh = parseBinaryStl(bytes);
    tsWatertight = isWatertight(mesh).watertight;
    tsLoadWt.push(performance.now() - t0);
    const t1 = performance.now();
    const bodies = connectedBodies(mesh);
    tsBodyCount = bodies.bodies.length;
    tsBodies.push(performance.now() - t1);
  }
  const pyMesh = JSON.parse(await runPython(PY_MESH, [STL, String(reps)]));
  result.m5Connectivity = {
    tsParseAndWatertight: summarize(tsLoadWt),
    tsConnectedBodies: summarize(tsBodies),
    tsBodies: tsBodyCount,
    tsWatertight,
    pyLoadAndWatertight: summarize(pyMesh.loadPlusWatertightMs),
    pySplitMs: summarize(pyMesh.splitMs),
    pyBodies: pyMesh.bodies,
    pyWatertight: pyMesh.watertight,
  };
  console.log(`  TS   parse+watertight ${result.m5Connectivity.tsParseAndWatertight.medianMs} ms · bodies ${result.m5Connectivity.tsConnectedBodies.medianMs} ms → ${tsBodyCount} bodies (watertight=${tsWatertight})`);
  console.log(`  py   load+watertight ${result.m5Connectivity.pyLoadAndWatertight.medianMs} ms · split ${result.m5Connectivity.pySplitMs.medianMs} ms → ${pyMesh.bodies} bodies (watertight=${pyMesh.watertight})`);
}

writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
