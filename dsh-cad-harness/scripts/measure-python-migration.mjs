// Measurement harness for the "明确负收益" claims (DECISION-LOG 2026-10-08).
//
// The rule is "能迁就迁 Python，保留 TS 要拿数据说话". So the things I *guessed*
// were negative-return get measured here instead of asserted:
//
//   E1  cold start: bare interpreter / +numpy,scipy / +manifold3d,trimesh,skfem,
//       and the same work behind a resident worker (JSON-lines round trip)
//   E2  spatial index: three-mesh-bvh (TS) vs trimesh (Python), same mesh, same
//       query points, exact closest-point-on-surface — decides `measure_closest`
//   E3  route IPC: a real panel-sized payload read from disk in Node vs the same
//       bytes over a worker round trip — decides whether HTTP routes may go IPC
//
// Usage:
//   node scripts/measure-python-migration.mjs [--runtime <dir>] [--out data/bench/python-migration.json]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Vector3 } from 'three';
import { parseBinaryStl } from '../src/host/mesh.ts';
import { buildMeshBvh } from '../src/host/measure.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const RUNTIME_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const OUT = resolve(argOf('--out', join(ROOT, 'data', 'bench', 'python-migration.json')));
/** `--only e4` runs just one section (keeps the expensive ones opt-out). */
const ONLY = argOf('--only', null);
const wants = (section) => !ONLY || ONLY === section;
const VENV_PYTHON = process.platform === 'win32'
  ? join(RUNTIME_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(RUNTIME_ROOT, 'venv', 'bin', 'python');

const STL = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '整机.stl');
const VERSIONS_DIR = join(ROOT, 'data', 'versions');
const WORK = join(REPO, '.tmp-measure-work');

if (!existsSync(VENV_PYTHON)) {
  console.error(`no venv python at ${VENV_PYTHON} — provision first (see docs/DECISION-LOG.md 2026-10-08)`);
  process.exit(2);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stats = (xs) => ({ n: xs.length, medianMs: +median(xs).toFixed(2), minMs: +Math.min(...xs).toFixed(2), maxMs: +Math.max(...xs).toFixed(2) });

// ---------------------------------------------------------------------------
// E1: cold start
// ---------------------------------------------------------------------------
function timeProcess(python, code, runs) {
  const samples = [];
  return new Promise((resolvePromise) => {
    let i = 0;
    const next = () => {
      if (i++ >= runs) return resolvePromise(stats(samples));
      const t0 = performance.now();
      const child = spawn(python, ['-I', '-c', code], { stdio: 'ignore' });
      child.once('close', () => {
        samples.push(performance.now() - t0);
        next();
      });
    };
    next();
  });
}

/** A resident worker: one process, JSON-lines on stdin/stdout, imports done once. */
function startWorker(python, preload) {
  const source = [
    'import sys, json',
    `preload = ${JSON.stringify(preload)}`,
    'for name in preload:',
    '    __import__(name)',
    'print(json.dumps({"ready": True}), flush=True)',
    'for line in sys.stdin:',
    '    line = line.strip()',
    '    if not line: continue',
    '    req = json.loads(line)',
    '    if req.get("op") == "ping":',
    '        out = {"pong": True}',
    '    elif req.get("op") == "echo":',
    '        out = {"bytes": len(req.get("payload", ""))}',
    '    else:',
    '        out = {"error": "unknown op"}',
    '    print(json.dumps(out), flush=True)',
  ].join('\n');
  const child = spawn(python, ['-I', '-c', source], { stdio: ['pipe', 'pipe', 'inherit'] });
  const queue = [];
  let buffer = '';
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const value = JSON.parse(line);
        if (value.ready) readyResolve();
        else queue.shift()?.(value);
      } catch {
        /* ignore */
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    ready,
    call(request) {
      return new Promise((resolvePromise) => {
        queue.push(resolvePromise);
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    stop() { child.kill('SIGKILL'); },
  };
}

async function roundTrip(python, preload, request, runs) {
  const worker = startWorker(python, preload);
  await worker.ready;
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await worker.call(request);
    samples.push(performance.now() - t0);
  }
  worker.stop();
  return stats(samples);
}

// ---------------------------------------------------------------------------
// E2: spatial index — exact closest point on the surface
// ---------------------------------------------------------------------------
function nodeClosestPoints(stlPath, points) {
  const mesh = parseBinaryStl(new Uint8Array(readFileSync(stlPath)));
  const t0 = performance.now();
  const bvh = buildMeshBvh(mesh);
  const buildMs = performance.now() - t0;
  const distances = [];
  const t1 = performance.now();
  for (const p of points) {
    // The modern API returns a hit object; the legacy (point, target, …) form
    // silently left `target` untouched and produced distances to the origin —
    // caught by the agreement check below, which is exactly why it is here.
    const hit = bvh.closestPointToPoint(new Vector3(p[0], p[1], p[2]));
    distances.push(hit ? hit.distance : Number.NaN);
  }
  const queryMs = performance.now() - t1;
  return { triangles: mesh.triVerts.length / 3, buildMs: +buildMs.toFixed(1), queryMs: +queryMs.toFixed(1), perQueryMs: +(queryMs / points.length).toFixed(4), distances };
}

const PY_CLOSEST = `
import json, sys, time
import numpy as np, trimesh
stl, points_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
points = np.array(json.load(open(points_path)), dtype=float)
mesh = trimesh.load(stl, process=False)

engine = "none"
try:
    import rtree  # noqa: F401
    engine = "rtree"
except Exception:
    try:
        import embree  # noqa: F401
        engine = "embree"
    except Exception:
        engine = "none"

def timed(fn):
    t0 = time.perf_counter()
    out = fn()
    return (time.perf_counter() - t0) * 1000, out

result = {"triangles": int(len(mesh.faces)), "engine": engine, "points": int(len(points))}
try:
    ms, (_c, d, _t) = timed(lambda: trimesh.proximity.ProximityQuery(mesh).on_surface(points))
    result["indexed"] = {"queryMs": round(ms, 1), "perQueryMs": round(ms / len(points), 4), "distances": [float(x) for x in d]}
except BaseException as exc:
    result["indexed"] = {"error": type(exc).__name__ + ": " + str(exc)[:120]}
# Always measure the no-index path too: it is the honest fallback on a machine
# where rtree/embree is unavailable, and it is the number that decides whether
# measure_closest may move to Python at all.
try:
    ms, (_c, d, _t) = timed(lambda: trimesh.proximity.closest_point_naive(mesh, points))
    result["naive"] = {"queryMs": round(ms, 1), "perQueryMs": round(ms / len(points), 4), "distances": [float(x) for x in d]}
except BaseException as exc:
    result["naive"] = {"error": type(exc).__name__ + ": " + str(exc)[:120]}
json.dump(result, open(out_path, "w"))
`;

function runPython(script, argv, timeoutMs = 300_000) {
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
      else reject(new Error(`python exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

// ---------------------------------------------------------------------------
// E3: panel-sized payload over IPC
// ---------------------------------------------------------------------------
function panelPayload() {
  const entries = [];
  for (const id of readdirSync(VERSIONS_DIR).sort()) {
    const dir = join(VERSIONS_DIR, id);
    const read = (name) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return null; } };
    entries.push({ id, scad: read('model.scad'), datums: read('datums.json') });
  }
  return { versions: entries };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
mkdirSync(WORK, { recursive: true });
const result = { generatedAt: new Date().toISOString(), venvPython: VENV_PYTHON, stl: STL };

if (wants('e1')) {
  console.log('--- E1 cold start (10 runs each) ---');
  result.e1 = {
    bareInterpreter: await timeProcess(VENV_PYTHON, 'pass', 10),
    numpyScipy: await timeProcess(VENV_PYTHON, 'import numpy, scipy', 10),
    fullToolSet: await timeProcess(VENV_PYTHON, 'import numpy, scipy, manifold3d, trimesh, skfem', 10),
    workerPing: await roundTrip(VENV_PYTHON, [], { op: 'ping' }, 200),
    workerPingAfterHeavyImport: await roundTrip(VENV_PYTHON, ['numpy', 'scipy', 'manifold3d', 'trimesh', 'skfem'], { op: 'ping' }, 200),
  };
  for (const [key, value] of Object.entries(result.e1)) {
    console.log(`  ${key.padEnd(26)} median ${String(value.medianMs).padStart(8)} ms  (min ${value.minMs} / max ${value.maxMs})`);
  }
}

if (wants('e2')) {
  console.log('--- E2 closest point on surface (same mesh, same 200 points) ---');
  const meshProbe = parseBinaryStl(new Uint8Array(readFileSync(STL)));
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < meshProbe.vertProperties.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      bb.min[a] = Math.min(bb.min[a], meshProbe.vertProperties[i + a]);
      bb.max[a] = Math.max(bb.max[a], meshProbe.vertProperties[i + a]);
    }
  }
  // Deterministic pseudo-random query points inside the bounding box (LCG).
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const points = Array.from({ length: 200 }, () => [
    +(bb.min[0] + (bb.max[0] - bb.min[0]) * rand()).toFixed(4),
    +(bb.min[1] + (bb.max[1] - bb.min[1]) * rand()).toFixed(4),
    +(bb.min[2] + (bb.max[2] - bb.min[2]) * rand()).toFixed(4),
  ]);
  writeFileSync(join(WORK, 'points.json'), JSON.stringify(points));
  const pyOut = join(WORK, 'closest.json');
  const nodeSide = nodeClosestPoints(STL, points);
  await runPython(PY_CLOSEST, [STL, join(WORK, 'points.json'), pyOut]);
  const pySide = JSON.parse(readFileSync(pyOut, 'utf8'));
  const delta = (other) => (other?.distances ? +Math.max(...nodeSide.distances.map((d, i) => Math.abs(d - other.distances[i]))).toFixed(6) : null);
  result.e2 = {
    triangles: nodeSide.triangles,
    points: points.length,
    tsBvh: { buildMs: nodeSide.buildMs, queryMs: nodeSide.queryMs, perQueryMs: nodeSide.perQueryMs },
    pyTrimesh: {
      engine: pySide.engine,
      indexed: pySide.indexed && !pySide.indexed.error ? { queryMs: pySide.indexed.queryMs, perQueryMs: pySide.indexed.perQueryMs, maxDistanceDeltaMm: delta(pySide.indexed) } : pySide.indexed,
      naive: pySide.naive && !pySide.naive.error ? { queryMs: pySide.naive.queryMs, perQueryMs: pySide.naive.perQueryMs, maxDistanceDeltaMm: delta(pySide.naive) } : pySide.naive,
    },
  };
  console.log(`  mesh: ${nodeSide.triangles} triangles · ${points.length} query points`);
  console.log(`  three-mesh-bvh (TS)      ${nodeSide.perQueryMs} ms/query  (total ${nodeSide.queryMs} ms, build ${nodeSide.buildMs} ms)`);
  for (const key of ['indexed', 'naive']) {
    const entry = result.e2.pyTrimesh[key];
    if (!entry) continue;
    if (entry.error) console.log(`  trimesh ${key.padEnd(8)} FAILED: ${entry.error}`);
    else console.log(`  trimesh ${key.padEnd(8)} (${result.e2.pyTrimesh.engine}) ${entry.perQueryMs} ms/query  (total ${entry.queryMs} ms) · max |Δ| vs TS ${entry.maxDistanceDeltaMm} mm`);
  }
}

if (wants('e3')) {
  console.log('--- E3 panel payload: disk read vs worker round trip ---');
  const payload = JSON.stringify(panelPayload());
  const bytes = Buffer.byteLength(payload);
  const direct = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    JSON.parse(JSON.stringify(panelPayload()));
    direct.push(performance.now() - t0);
  }
  const worker = startWorker(VENV_PYTHON, []);
  await worker.ready;
  const ipc = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await worker.call({ op: 'echo', payload });
    ipc.push(performance.now() - t0);
  }
  worker.stop();
  result.e3 = { payloadBytes: bytes, directDiskRead: stats(direct), workerRoundTrip: stats(ipc) };
  console.log(`  payload ${(bytes / 1024).toFixed(0)} KiB`);
  console.log(`  Node disk read + parse   median ${result.e3.directDiskRead.medianMs} ms`);
  console.log(`  worker round trip        median ${result.e3.workerRoundTrip.medianMs} ms`);
}

if (wants('e4')) {
  console.log('--- E4 render image over the worker channel ---');
  const explicit = argOf('--image', null);
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        join(ROOT, 'sandbox', 'shots', 'browse3-stale-shot.png'),
        join(ROOT, 'scripts', 'inspect_a.png'),
        join(REPO, 'renders', 'v007-angle60-30_zoom1.5x.png'),
      ];
  const shot = candidates.find((p) => existsSync(p));
  if (!shot) {
    console.log('  SKIP: no PNG found');
  } else {
    const raw = readFileSync(shot);
    const encode = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      readFileSync(shot).toString('base64');
      encode.push(performance.now() - t0);
    }
    const b64 = raw.toString('base64');
    const worker = startWorker(VENV_PYTHON, []);
    await worker.ready;
    const ipc = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await worker.call({ op: 'echo', payload: b64 });
      ipc.push(performance.now() - t0);
    }
    worker.stop();
    result.e4 = {
      file: shot,
      bytes: raw.length,
      base64Bytes: b64.length,
      hostReadAndEncode: stats(encode),
      workerRoundTrip: stats(ipc),
    };
    console.log(`  ${shot}`);
    console.log(`  ${(raw.length / 1024).toFixed(0)} KiB PNG → ${(b64.length / 1024).toFixed(0)} KiB base64`);
    console.log(`  host read + base64       median ${result.e4.hostReadAndEncode.medianMs} ms`);
    console.log(`  worker round trip        median ${result.e4.workerRoundTrip.medianMs} ms`);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
const merged = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
for (const key of ['e1', 'e2', 'e3', 'e4']) if (result[key]) merged[key] = result[key];
merged.generatedAt = result.generatedAt;
merged.venvPython = result.venvPython;
merged.stl = result.stl;
writeFileSync(OUT, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
rmSync(WORK, { recursive: true, force: true });
