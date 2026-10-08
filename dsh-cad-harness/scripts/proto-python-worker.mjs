// Prototype + measurements for batch 0 — the resident Python worker and the
// JSON-lines protocol HARNESS §12.3 specifies. Nothing here is wired into the
// plugin: this is the evidence that decides the protocol's own design choices,
// most importantly "大载荷走文件路径" (big payloads by file path) and the
// `{id, op, params}` → `{id, ok, result|error+traceback}` frame shape.
//
// Why measure before building: the v2 matrix asserted "big payloads must go by
// file, not through stdio" and the E3/E4 run already showed 237 KiB over IPC
// costs 0.82 ms — so the assertion needs a payload size where it actually
// matters. This finds it (or refutes it).
//
//   node scripts/proto-python-worker.mjs [--runtime <dir>] [--out <json>]
//
// Measured here:
//   P1  startup: spawn → hello (protocolVersion handshake)
//   P2  ping round trip (200×), and ping with a heavy import already done
//   P3  ARG side: 1M floats inline-JSON vs raw file the worker reads
//   P4  RESULT side: 1.2 MB vertices inline-JSON vs inline-base64 vs raw file
//   P5  failure: error + traceback passthrough (a raise inside the worker)
//   P6  two ops in flight: id correlation on concurrent requests

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const RUNTIME_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const OUT = resolve(argOf('--out', join(ROOT, 'data', 'bench', 'python-worker-protocol.json')));
const WORK = join(REPO, '.tmp-proto-worker');
const VENV_PYTHON = process.platform === 'win32'
  ? join(RUNTIME_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(RUNTIME_ROOT, 'venv', 'bin', 'python');

if (!existsSync(VENV_PYTHON)) {
  console.error(`no venv python at ${VENV_PYTHON}`);
  process.exit(2);
}

const PROTOCOL_VERSION = 1;

/** The worker side of the seam: hello, then one reply per request frame. */
const WORKER_SOURCE = `
import base64, json, os, sys, time, traceback

PROTOCOL_VERSION = ${PROTOCOL_VERSION}

def send(frame):
    sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

send({"type": "hello", "protocolVersion": PROTOCOL_VERSION, "python": sys.version.split()[0]})

def handle(op, params):
    if op == "ping":
        return {"pong": True}
    if op == "import_heavy":
        import numpy, scipy, manifold3d, trimesh, skfem  # noqa: F401
        return {"imported": True}
    if op == "sum_inline":
        import numpy as np
        a = np.asarray(params["values"], dtype=np.float64)
        return {"sum": float(a.sum()), "count": int(a.size)}
    if op == "sum_file":
        import numpy as np
        a = np.fromfile(params["path"], dtype=np.float64)
        return {"sum": float(a.sum()), "count": int(a.size)}
    if op == "verts_inline_json":
        import numpy as np
        v = np.arange(300000, dtype=np.float32).reshape(100000, 3)
        return {"vertices": v.tolist()}
    if op == "verts_inline_b64":
        import numpy as np
        v = np.arange(300000, dtype=np.float32).reshape(100000, 3)
        return {"vertices_b64": base64.b64encode(v.astype("<f4").tobytes()).decode("ascii")}
    if op == "verts_file":
        import numpy as np
        v = np.arange(300000, dtype=np.float32).reshape(100000, 3)
        path = params["path"]
        v.astype("<f4").tofile(path)
        return {"path": path, "bytes": os.path.getsize(path)}
    if op == "boom":
        raise ValueError("intentional failure for traceback passthrough")
    if op == "sleep":
        time.sleep(params.get("ms", 10) / 1000.0)
        return {"slept": params.get("ms", 10)}
    raise KeyError("unknown op " + op)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    rid, op, params = request.get("id"), request.get("op"), request.get("params") or {}
    started = time.perf_counter()
    try:
        result = handle(op, params)
        send({"id": rid, "ok": True, "result": result, "ms": (time.perf_counter() - started) * 1000})
    except BaseException as exc:
        send({
            "id": rid,
            "ok": False,
            "error": type(exc).__name__ + ": " + str(exc),
            "traceback": traceback.format_exc(),
            "ms": (time.perf_counter() - started) * 1000,
        })
`;

class Worker {
  constructor(python) {
    this.child = spawn(python, ['-I', '-c', WORKER_SOURCE], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.pending = new Map();
    this.nextId = 1;
    this.hello = new Promise((resolveHello) => { this.helloResolve = resolveHello; });
    this.buffer = '';
    this.bytesIn = 0;
    this.child.stdout.on('data', (chunk) => {
      this.bytesIn += chunk.length;
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf('\n');
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'hello') { this.helloResolve(frame); continue; }
        const entry = this.pending.get(frame.id);
        if (entry) { this.pending.delete(frame.id); entry(frame); }
      }
    });
  }
  call(op, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise) => {
      this.pending.set(id, resolvePromise);
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }
  stop() { this.child.kill('SIGKILL'); }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summarize = (xs) => ({ n: xs.length, medianMs: +median(xs).toFixed(3), minMs: +Math.min(...xs).toFixed(3), maxMs: +Math.max(...xs).toFixed(3) });

async function timedCall(worker, op, params, reps = 10) {
  const samples = [];
  let last;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    last = await worker.call(op, params);
    samples.push(performance.now() - t0);
  }
  return { stats: summarize(samples), last };
}

mkdirSync(WORK, { recursive: true });
const result = { generatedAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, venvPython: VENV_PYTHON };

// --- P1: startup handshake -------------------------------------------------
{
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const worker = new Worker(VENV_PYTHON);
    await worker.hello;
    samples.push(performance.now() - t0);
    worker.stop();
  }
  result.p1StartupHello = summarize(samples);
  console.log(`P1 startup → hello          ${result.p1StartupHello.medianMs} ms (n=${samples.length})`);
}

const worker = new Worker(VENV_PYTHON);
const hello = await worker.hello;
console.log(`   hello: protocolVersion=${hello.protocolVersion} python=${hello.python}`);
result.hello = hello;

// --- P2: ping, before and after heavy imports ------------------------------
{
  const cold = await timedCall(worker, 'ping', {}, 200);
  const heavy = await worker.call('import_heavy', {});
  if (!heavy.ok) throw new Error(`import_heavy failed: ${heavy.error}`);
  const warm = await timedCall(worker, 'ping', {}, 200);
  result.p2Ping = { beforeHeavyImport: cold.stats, afterHeavyImport: warm.stats };
  console.log(`P2 ping (cold)              ${result.p2Ping.beforeHeavyImport.medianMs} ms · (after heavy import) ${result.p2Ping.afterHeavyImport.medianMs} ms`);
}

// --- P3: the ARG side, 1M float64 ------------------------------------------
{
  const values = Array.from({ length: 1_000_000 }, (_, i) => (i % 1000) / 1000);
  const inline = await timedCall(worker, 'sum_inline', { values }, 5);
  const argBytes = Buffer.byteLength(JSON.stringify({ values }));
  const valuesPath = join(WORK, 'values.f64');
  const raw = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => raw.writeDoubleLE(v, i * 8));
  writeFileSync(valuesPath, raw); // host-side write is part of the file path
  const byFile = await timedCall(worker, 'sum_file', { path: valuesPath }, 5);
  result.p3Args = {
    payloadBytes: argBytes,
    inlineJson: { ...inline.stats, sum: inline.last.result?.sum, count: inline.last.result?.count },
    byFile: { ...byFile.stats, sum: byFile.last.result?.sum, count: byFile.last.result?.count, bytes: raw.length },
  };
  console.log(`P3 ARG 1M float64 inline    ${inline.stats.medianMs} ms (${(argBytes / 1048576).toFixed(1)} MiB JSON) · by file ${byFile.stats.medianMs} ms (${(raw.length / 1048576).toFixed(1)} MiB raw)`);
}

// --- P4: the RESULT side, 100k×3 float32 -----------------------------------
{
  const json = await timedCall(worker, 'verts_inline_json', {}, 5);
  const b64 = await timedCall(worker, 'verts_inline_b64', {}, 5);
  // Decode cost is part of the inline-base64 path; the file path writes then reads.
  const b64Bytes = Buffer.byteLength(b64.last.result?.vertices_b64 ?? '');
  const jsonBytes = Buffer.byteLength(JSON.stringify(json.last.result ?? {}));
  const vertsPath = join(WORK, 'verts.f32');
  const byFile = await timedCall(worker, 'verts_file', { path: vertsPath }, 5);
  const fileReadT0 = performance.now();
  const fileBytes = readFileSync(vertsPath).length;
  const fileReadMs = performance.now() - fileReadT0;
  result.p4Results = {
    vertices: 100000,
    inlineJson: { ...json.stats, payloadBytes: jsonBytes },
    inlineBase64: { ...b64.stats, payloadBytes: b64Bytes },
    byFile: { ...byFile.stats, payloadBytes: fileBytes, hostReadMs: +fileReadMs.toFixed(3) },
  };
  console.log(`P4 RESULT 100k×3 float32`);
  console.log(`   inline JSON   ${json.stats.medianMs} ms (${(jsonBytes / 1048576).toFixed(1)} MiB)`);
  console.log(`   inline base64 ${b64.stats.medianMs} ms (${(b64Bytes / 1048576).toFixed(1)} MiB)`);
  console.log(`   file path     ${byFile.stats.medianMs} ms (${(fileBytes / 1048576).toFixed(1)} MiB + host read ${fileReadMs.toFixed(2)} ms)`);
}

// --- P5: failure carries the traceback -------------------------------------
{
  const frame = await worker.call('boom', {});
  result.p5Failure = {
    ok: frame.ok,
    error: frame.error,
    tracebackHasValueError: /ValueError: intentional failure/.test(frame.traceback ?? ''),
    tracebackHasWorkerLine: /in handle/.test(frame.traceback ?? ''),
    tracebackLines: (frame.traceback ?? '').split('\n').length,
  };
  console.log(`P5 failure                  ok=${frame.ok} error=${JSON.stringify(frame.error)} traceback lines=${result.p5Failure.tracebackLines}`);
}

// --- P6: two ops in flight → id correlation --------------------------------
{
  const t0 = performance.now();
  const [a, b] = await Promise.all([worker.call('sleep', { ms: 120 }), worker.call('sleep', { ms: 20 })]);
  const elapsed = performance.now() - t0;
  result.p6Concurrency = {
    elapsedMs: +elapsed.toFixed(1),
    serialWouldBeMs: 140,
    // The worker loop reads one frame at a time, so "in flight" here means
    // queued, not parallel: this is the measurement that says whether the
    // protocol needs async dispatch or a worker pool.
    serialized: Math.abs(elapsed - 140) < 30,
    aIsLong: a.result?.slept === 120,
    bIsShort: b.result?.slept === 20,
    correlatedById: a.result?.slept === 120 && b.result?.slept === 20,
  };
  console.log(`P6 concurrency              2 requests finished in ${elapsed.toFixed(1)} ms (serial would be 140) · serialized=${result.p6Concurrency.serialized} · id correlation=${result.p6Concurrency.correlatedById}`);
}

worker.stop();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
rmSync(WORK, { recursive: true, force: true });
