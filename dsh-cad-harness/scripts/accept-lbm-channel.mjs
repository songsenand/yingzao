// Acceptance for the XLB LBM engine (stage A of the CFD lane, 2026-10-15).
//
// WHAT IS BEING ACCEPTED (DECISION-LOG 2026-10-15 + addendum):
//   1. the lock stack is importable in the provisioned runtime (xlb reported),
//   2. the channel template runs stably and DETERMINISTICALLY on JAX CPU
//      (two identical runs -> identical centerlines, bit for bit),
//   3. analytical truth: the developed centerline approaches the Poiseuille
//      parabola 1.5U — asserted as a development band (peak ratio) plus a
//      mirror-symmetry bound, thresholds from the probe baseline with margin,
//   4. the compat shims: the pinned xlb 0.3.1 does NOT set ZouHe
//      `prescribed_values` itself (upstreamZouheFixed === false). When upstream
//      ships the fix this assertion turns red on purpose — that is the tripwire
//      to drop the wrapper shim (DECISION-LOG addendum),
//   5. CAD_LBM_ENGINE=off refuses loudly (raw subprocess, JSON-lines protocol).
//
//   node scripts/accept-lbm-channel.mjs [--runtime <dir>]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePythonWorker } from '../src/host/python-worker.ts';
import { pythonRuntimeStatus, repairPythonRuntime } from '../src/host/python-runtime.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython}`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log('--- XLB LBM engine acceptance (stage A) ---');

// The new lock (xlb stack) makes the existing venv incomplete by definition;
// the designed repair is action=repair (wipe venv, reinstall from the lock).
// Same situation as the numba adoption: first run after a lock change pays the
// reinstall, later runs are warm.
{
  const status = await pythonRuntimeStatus();
  if (status.state !== 'ready') {
    console.log(`runtime not ready (state: ${status.state}${status.error ? ` — ${status.error}` : ''})`);
    console.log('repairing: wipe venv + reinstall from the new lock (aliyun mirror; ~340 MB, takes minutes)...');
    await repairPythonRuntime({ onProgress: (message) => console.error(`  [provision] ${message}`) });
    console.log('runtime repaired.');
  }
}

const worker = await ensurePythonWorker();

// 1. the lock stack is visible to the runtime
{
  const versions = await worker.request('versions', {});
  const xlb = versions.packages?.xlb ?? 'missing';
  check(String(xlb).startsWith('available'), 'versions reports xlb', String(xlb));
}

// 2+3. channel template: small smoke, then the analytical run
let analytical = null;
{
  const smoke = await worker.request('lbm_channel', { gridShape: [32, 16, 16], latticeVelocity: 0.05, reynolds: 100, steps: 2000 });
  check(smoke.stable === true, 'smoke run stable/finite', `maxUx=${smoke.maxUx}`);
  check(smoke.engine === 'xlb', 'engine reports xlb');

  const repeat = await worker.request('lbm_channel', { gridShape: [32, 16, 16], latticeVelocity: 0.05, reynolds: 100, steps: 2000 });
  const same = JSON.stringify(smoke.centerline) === JSON.stringify(repeat.centerline)
    && smoke.peakUx === repeat.peakUx && smoke.inletUx === repeat.inletUx;
  check(same, 'determinism: two runs agree bit for bit');

  analytical = await worker.request('lbm_channel', { gridShape: [48, 24, 24], latticeVelocity: 0.05, reynolds: 100, steps: 20000 });
  const ratio = analytical.peakUx / (1.5 * analytical.latticeVelocity);
  check(analytical.stable === true, 'analytical run stable/finite', `peak=${analytical.peakUx}`);
  check(ratio >= 0.6 && ratio <= 0.95, 'Poiseuille development band', `peak ratio=${ratio.toFixed(3)} (band 0.60–0.95)`);
  check(analytical.mirrorError <= 0.05, 'centerline mirror symmetry ≤ 5% of peak', `${(analytical.mirrorError * 100).toFixed(2)}%`);
  check(analytical.inletUx > 0.9 * analytical.latticeVelocity, 'ZouHe inlet effective (shim works)', `inletUx=${analytical.inletUx.toFixed(4)}`);
  check(analytical.upstreamZouheFixed === false, 'upstream ZouHe still unfixed (shim tripwire; turns red when upstream fixes — drop the shim)', `upstreamZouheFixed=${analytical.upstreamZouheFixed}`);
  console.log(`    perf: ${analytical.msPerStep} ms/step @ ${analytical.grid.join('x')} (${analytical.wallSeconds}s wall for ${analytical.steps} steps)`);
}

// 5. CAD_LBM_ENGINE=off must refuse loudly (raw JSON-lines subprocess)
{
  const child = spawn(venvPython, ['-I', join(ROOT, 'python', 'cad_worker', 'worker.py')], {
    env: { ...process.env, CAD_LBM_ENGINE: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timer = setTimeout(() => rejectPromise(new Error('off-guard subprocess timeout')), 60_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === 'hello') {
          child.stdin.write(`${JSON.stringify({ id: 1, op: 'lbm_channel', params: { gridShape: [16, 8, 8], steps: 10 } })}\n`);
        } else if (message.id === 1) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(message);
        }
      }
    });
    child.on('exit', () => rejectPromise(new Error('off-guard subprocess exited before reply')));
  });
  check(result.ok === false && /CAD_LBM_ENGINE=off/.test(result.error ?? ''), 'CAD_LBM_ENGINE=off refuses loudly', result.error?.slice(0, 80));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
