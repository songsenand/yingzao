// Acceptance for batch 0 — the resident Python worker and its JSON-lines
// protocol (DESIGN §31.3, DECISION-LOG 2026-10-08).
//
//   1. handshake: `protocolVersion`, python version, declared ops
//   2. latency: ping round trip over the pipe (measured 0.02 ms, budget 1 ms)
//   3. versions: the nine pinned packages actually import in this venv
//   4. BY-FILE PAYLOADS: 200 query points in, distances out — both by file, and
//      the distances must agree with the TS three-mesh-bvh result (Δ=0 measured;
//      this is the assertion that makes "the migration kept the numbers" real)
//   5. failures carry the full traceback
//   6. after a kill the worker is restarted, not reused half-dead
//   7. the worker is single-threaded: two in-flight requests serialise (measured
//      140 ms for 120+20 ms), which is a fact the host budgets for
//   8. packaging: `python/` ships in `files` (a worker that is not published is
//      a worker that does not exist for anyone else)
//
//   node scripts/accept-python-worker.mjs [--runtime <dir>] [--keep]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Vector3 } from 'three';
import { buildMeshBvh } from '../src/host/measure.ts';
import { parseBinaryStl } from '../src/host/mesh.ts';
import { ensurePythonWorker, resetPythonWorker, workerScratchDir } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const RUNTIME_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const KEEP = args.includes('--keep');
const STL = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '整机.stl');

process.env.DSH_CAD_PYTHON_ROOT = RUNTIME_ROOT;

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const venvPython = process.platform === 'win32'
  ? join(RUNTIME_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(RUNTIME_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — provision the runtime first (or pass --runtime <dir>)`);
  process.exit(2);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// --- 1. handshake ----------------------------------------------------------
console.log('--- handshake ---');
// Separate provisioning from the handshake: a cold runtime legitimately spends
// minutes installing dependencies (and a lock change forces exactly that), but
// the handshake itself is what this acceptance is about.
const { ensurePythonRuntime } = await import('../src/host/python-runtime.ts');
const provisionStarted = performance.now();
await ensurePythonRuntime({ onProgress: (message) => console.log(`      [runtime] ${message}`) });
const provisionMs = performance.now() - provisionStarted;
if (provisionMs > 2000) console.log(`      (runtime was (re)provisioned in ${(provisionMs / 1000).toFixed(1)} s before the timed handshake)`);
const started = performance.now();
const worker = await ensurePythonWorker({ onLog: (line) => console.log(`      [worker] ${line}`) });
const startupMs = performance.now() - started;
check(worker.hello?.protocolVersion === 1, 'protocolVersion is 1', String(worker.hello?.protocolVersion));
check(/^3\.13\./.test(worker.hello?.python ?? ''), 'the worker runs the pinned interpreter', worker.hello?.python);
const declared = worker.hello?.ops ?? [];
const requiredOps = ['ping', 'versions', 'stl_stats', 'closest_points', 'crash'];
check(requiredOps.every((op) => declared.includes(op)), 'the handshake declares the v1 ops', declared.join(', '));
check(startupMs < 2000, 'handshake completes quickly', `${startupMs.toFixed(1)} ms`);

// --- 2. latency ------------------------------------------------------------
console.log('--- latency ---');
const pingSamples = [];
for (let i = 0; i < 200; i++) {
  const t0 = performance.now();
  await worker.request('ping');
  pingSamples.push(performance.now() - t0);
}
const pingMedian = median(pingSamples);
check(pingMedian < 1, 'ping round trip stays under 1 ms', `${pingMedian.toFixed(3)} ms median (200 calls)`);

// --- 3. versions -----------------------------------------------------------
console.log('--- versions ---');
const versions = await worker.request('versions');
const packages = versions.packages ?? {};
const expected = ['numpy', 'scipy', 'trimesh', 'manifold3d', 'networkx', 'skfem', 'rtree', 'rapier3d', 'shapely'];
const missing = expected.filter((name) => !(name in packages));
check(missing.length === 0, 'all nine pinned packages are reported', Object.entries(packages).map(([k, v]) => `${k}=${v}`).join(' '));
const unavailable = Object.entries(packages).filter(([, value]) => String(value).startsWith('unavailable'));
check(
  unavailable.length === 0 || unavailable.every(([name]) => name === 'rapier3d'),
  'no package is unexpectedly unavailable',
  unavailable.map(([k, v]) => `${k}: ${v}`).join('; ') || 'none',
);

// --- 4. by-file payloads + numeric agreement -------------------------------
console.log('--- by-file payloads + agreement with the TS implementation ---');
const scratch = KEEP ? join(REPO, '.tmp-worker-accept') : await workerScratchDir();
mkdirSync(scratch, { recursive: true });

const mesh = parseBinaryStl(new Uint8Array(readFileSync(STL)));
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (let i = 0; i < mesh.vertProperties.length; i += 3) {
  for (let a = 0; a < 3; a++) {
    bounds.min[a] = Math.min(bounds.min[a], mesh.vertProperties[i + a]);
    bounds.max[a] = Math.max(bounds.max[a], mesh.vertProperties[i + a]);
  }
}
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const count = 200;
const points = new Float64Array(count * 3);
for (let i = 0; i < count; i++) {
  points[i * 3] = bounds.min[0] + (bounds.max[0] - bounds.min[0]) * rand();
  points[i * 3 + 1] = bounds.min[1] + (bounds.max[1] - bounds.min[1]) * rand();
  points[i * 3 + 2] = bounds.min[2] + (bounds.max[2] - bounds.min[2]) * rand();
}
const pointsPath = join(scratch, 'points.f64');
const distancesPath = join(scratch, 'distances.f64');
const closestPath = join(scratch, 'closest.f64');
writeFileSync(pointsPath, Buffer.from(points.buffer));

const stats = await worker.request('stl_stats', { path: STL });
check(stats.triangles === mesh.triVerts.length / 3, 'stl_stats agrees with the TS parser on the triangle count', `${stats.triangles}`);

const byFile = await worker.request('closest_points', { mesh: STL, points: pointsPath, distances: distancesPath, closest: closestPath });
check(byFile.count === count, 'closest_points answered for every query point', `${byFile.count}`);
check(
  byFile.distanceBytes === count * 8 && byFile.closestBytes === count * 24,
  'results came back by file (raw float64, no base64 through the pipe)',
  `${byFile.distanceBytes} + ${byFile.closestBytes} bytes`,
);

const bvh = buildMeshBvh(mesh);
const tsDistances = [];
for (let i = 0; i < count; i++) {
  const hit = bvh.closestPointToPoint(new Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]));
  tsDistances.push(hit ? hit.distance : Number.NaN);
}
const pyBuffer = readFileSync(distancesPath);
const pyDistances = new Float64Array(pyBuffer.buffer, pyBuffer.byteOffset, count);
const maxDelta = Math.max(...tsDistances.map((value, index) => Math.abs(value - pyDistances[index])));
check(maxDelta < 1e-6, 'closest-point distances match the TS three-mesh-bvh result', `max |Δ| = ${maxDelta.toExponential(2)} mm · engine ${byFile.engine}`);

// --- 5. traceback ----------------------------------------------------------
console.log('--- failures ---');
let crashMessage = '';
try {
  await worker.request('crash');
} catch (error) {
  crashMessage = String(error?.message ?? error);
}
check(/ValueError: intentional failure/.test(crashMessage), 'a failing op reports the exception');
check(/Traceback \(most recent call last\)/.test(crashMessage), 'and carries the full traceback');
check(/in op_crash/.test(crashMessage), 'the traceback names the worker frame');

// --- 6. restart after death ------------------------------------------------
console.log('--- restart ---');
const firstPid = worker.processId;
process.kill(firstPid, 'SIGKILL');
await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
check(!worker.alive, 'a killed worker is marked dead instead of silently reused');
const restarted = await ensurePythonWorker();
check(restarted.alive && restarted.processId !== firstPid, 'ensurePythonWorker starts a fresh process', `${firstPid} → ${restarted.processId}`);
const afterRestart = await restarted.request('ping');
check(afterRestart?.pong === true, 'the restarted worker answers');

// --- 7. single-threaded queueing (documented behaviour) --------------------
console.log('--- queueing ---');
// Warm up first: the FIRST closest_points after a restart pays the mesh load,
// and comparing a cold single call against warm concurrent ones would measure
// noise instead of serialisation.
await restarted.request('closest_points', { mesh: STL, points: pointsPath, distances: distancesPath, closest: closestPath });
const single = performance.now();
await restarted.request('closest_points', { mesh: STL, points: pointsPath, distances: distancesPath, closest: closestPath });
const singleMs = performance.now() - single;
const both = performance.now();
const [a, b] = await Promise.all([
  restarted.request('closest_points', { mesh: STL, points: pointsPath, distances: distancesPath, closest: closestPath }),
  restarted.request('closest_points', { mesh: STL, points: pointsPath, distances: distancesPath, closest: closestPath }),
]);
const bothMs = performance.now() - both;
check(a?.count === count && b?.count === count, 'concurrent requests are correlated by id');
check(bothMs >= singleMs * 1.4, 'two in-flight requests serialise (the host must budget for queueing)', `${singleMs.toFixed(0)} ms → ${bothMs.toFixed(0)} ms (serial sum expected)`);

// --- 8. packaging ----------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check(Array.isArray(pkg.files) && pkg.files.includes('python/'), 'the worker ships: package.json files includes "python/"', (pkg.files ?? []).join(', '));
check(existsSync(join(ROOT, 'python', 'cad_worker', 'worker.py')), 'the worker script exists at python/cad_worker/worker.py');

resetPythonWorker();
if (!KEEP) rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
