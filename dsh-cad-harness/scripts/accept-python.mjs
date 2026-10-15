// Acceptance for the bundled Python runtime (DECISION-LOG 2026-10-08).
//
//   1. Lock integrity: seven platform targets with real sha256s; every
//      dependency pinned with `==` and at least one hash (pip refuses anything
//      else under --require-hashes); the darwin-x64 rapier3d marker is present,
//      because that platform has no wheel.
//   2. Extractor: the pure-JS tar reader handles files, explicit directories,
//      symlinks and GNU long names — and REFUSES path traversal, absolute
//      members and escaping symlinks. A runtime extractor that can be talked
//      into writing outside its destination is worse than no extractor.
//   3. Provisioning (real, network): build the runtime from a pinned archive,
//      create the venv, install the hash-locked dependencies, then import all
//      six of them. This is the section that proves "someone else's machine gets
//      a working Python" rather than "it works on mine".
//   4. Execution: run_python returns stdout, converts a crash into a real
//      traceback, and kills a runaway at the deadline.
//   5. The tool path: both tools register through the normal helper, a call
//      resolves the session's project directory, and status renders.
//   6. Status and the off switch (an off switch that a cached provisioning
//      promise can bypass is not an off switch).
//
//   node scripts/accept-python.mjs                    # full run (downloads the runtime)
//   node scripts/accept-python.mjs --archive <tgz>    # seed the archive cache (offline extract)
//   node scripts/accept-python.mjs --runtime-root <d> # reuse a provisioned runtime between runs
//   node scripts/accept-python.mjs --quick            # sections 1, 2, 6 only
//
// Environment honoured by the runtime under test:
//   DSH_CAD_PYTHON_ROOT       where the runtime is provisioned (this script sets it)
//   DSH_CAD_PYTHON_INDEX_URL  pip index (this script defaults to a mirror)

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTarGz } from '../src/host/tar-extract.ts';
import { detectPythonTarget, lockForTarget, lockPlanForTarget } from '../src/host/python-runtime.ts';
import { PIP_INDEXES, PYTHON_BUILD, REQUIREMENTS_LOCK, REQUIREMENTS_LOCK_SHA256 } from '../src/host/python-lock.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const QUICK = args.includes('--quick');
const KEEP = args.includes('--keep');
const ARCHIVE = argOf('--archive', null);
const RUNTIME_ROOT = argOf('--runtime-root', null);
const INDEX_URL = argOf('--index', process.env.DSH_CAD_PYTHON_INDEX_URL ?? PIP_INDEXES[1]);

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const skip = (label, why) => console.log(`SKIP  ${label}  — ${why}`);

// ---------------------------------------------------------------------------
// 1. lock integrity
// ---------------------------------------------------------------------------
console.log('--- lock ---');
const targets = Object.entries(PYTHON_BUILD.targets);
check(targets.length === 7, 'seven platform targets are locked', targets.map(([key]) => key).join(', '));
check(
  targets.every(([, value]) => /^[0-9a-f]{64}$/.test(value.sha256) && value.asset.includes(PYTHON_BUILD.pythonVersion)),
  'every target has a sha256 and the pinned python version',
);
check(
  REQUIREMENTS_LOCK_SHA256 === createHash('sha256').update(REQUIREMENTS_LOCK).digest('hex'),
  'requirements lock sha256 matches its recorded digest',
);
const requirementLines = REQUIREMENTS_LOCK.split('\n').filter((line) => line && !line.startsWith('#') && !line.startsWith(' '));
const pinned = requirementLines.filter((line) => /^[a-z0-9_.-]+==[0-9]/.test(line));
// The pinned set is asserted BY NAME, not by count. A count cannot tell a forgotten pin
// from a new dependency, and it goes stale the moment one is added — which it did:
// `shapely` arrived with the polygonisation work and this line still said "eight".
const EXPECTED_PINNED = [
  'numpy', 'scipy', 'trimesh', 'manifold3d', 'networkx', 'scikit-fem', 'rtree', 'rapier3d', 'shapely',
];
const pinnedNames = pinned.map((line) => line.split('==')[0]);
check(
  pinnedNames.length === EXPECTED_PINNED.length && EXPECTED_PINNED.every((name) => pinnedNames.includes(name)),
  `every expected dependency is pinned with == (${EXPECTED_PINNED.length})`,
  `pinned: ${pinnedNames.join(', ')}`,
);
check(
  REQUIREMENTS_LOCK.includes('# cad-exclude: darwin-x64 |') && REQUIREMENTS_LOCK.includes('rapier3d==0.36.1'),
  'rapier3d carries the darwin-x64 exclude directive',
);
check(!lockForTarget('darwin-x64').includes('rapier3d'), 'the darwin-x64 lock drops rapier3d (no wheel for that platform)');
check(lockForTarget('linux-x64-gnu').includes('rapier3d==0.36.1'), 'other targets keep rapier3d');
check(
  lockForTarget('darwin-x64').includes('numpy==2.5.3') && lockForTarget('darwin-x64').includes('--hash=sha256:'),
  'dropping one block keeps the rest of the lock intact',
);
// The skip must be CONFIRMED, not silent: the platform decision (physics stays
// on the TS engine there) has to reach the model, not just the pip log.
const darwinPlan = lockPlanForTarget('darwin-x64');
check(
  darwinPlan.skipped.length === 1 &&
    darwinPlan.skipped[0].name === 'rapier3d' &&
    /TS .*rapier3d-compat|TS rapier3d-compat/.test(darwinPlan.skipped[0].reason),
  'the darwin-x64 plan reports rapier3d as skipped, with the TS-canonical reason',
  darwinPlan.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join(' | '),
);
check(lockPlanForTarget('linux-x64-gnu').skipped.length === 0, 'a supported target skips nothing');
check(
  (REQUIREMENTS_LOCK.match(/--hash=sha256:/g) ?? []).length >= 30,
  'the lock carries per-wheel hashes',
  `${(REQUIREMENTS_LOCK.match(/--hash=sha256:/g) ?? []).length} hashes`,
);

// ---------------------------------------------------------------------------
// 2. extractor
// ---------------------------------------------------------------------------
console.log('--- extractor ---');

/** Minimal ustar writer so the extractor is tested against bytes we control. */
function tarEntry({ name, type = '0', content = '', link = '', mode = 0o644 }) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1');
  header.write('0000000\0', 108, 8, 'latin1');
  header.write('0000000\0', 116, 8, 'latin1');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  header.write('00000000000\0', 136, 12, 'latin1');
  header.write('        ', 148, 8, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function tarGz(entries) {
  const end = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([...entries, end]));
}

const work = mkdtempSync(join(ROOT, '..', '.tmp-accept-python-'));
try {
  const goodTar = join(work, 'good.tar.gz');
  const longName = `python/${'x'.repeat(140)}.txt`;
  writeFileSync(goodTar, tarGz([
    tarEntry({ name: 'python/hello.txt', content: 'hello\n' }),
    tarEntry({ name: 'python/dir/', type: '5' }),
    tarEntry({ name: 'python/dir/inner.txt', content: 'inner\n' }),
    tarEntry({ name: 'python/link.txt', type: '2', link: 'hello.txt' }),
    // GNU long name: an 'L' member carries the real path for the NEXT header.
    tarEntry({ name: '././@LongLink', type: 'L', content: `${longName}\0` }),
    tarEntry({ name: 'python/placeholder.txt', content: 'long name payload\n' }),
  ]));
  const dest = join(work, 'out');
  await extractTarGz(goodTar, dest, { stripPrefix: 'python' });
  check(readFileSync(join(dest, 'hello.txt'), 'utf8') === 'hello\n', 'extracts a regular file and strips the archive root');
  check(existsSync(join(dest, 'dir', 'inner.txt')), 'extracts nested files (implicit directories)');
  check(existsSync(join(dest, 'dir')) && existsSync(join(dest, 'link.txt')), 'creates explicit directories and symlinks');
  check(
    readFileSync(join(dest, `${'x'.repeat(140)}.txt`), 'utf8') === 'long name payload\n',
    'honours GNU long names',
  );

  const traversal = join(work, 'traversal.tar.gz');
  writeFileSync(traversal, tarGz([tarEntry({ name: 'python/../../escape.txt', content: 'nope' })]));
  let refused = false;
  try {
    await extractTarGz(traversal, join(work, 'out2'), { stripPrefix: 'python' });
  } catch {
    refused = true;
  }
  check(refused, 'refuses a member that escapes the destination');
  check(!existsSync(join(ROOT, '..', 'escape.txt')) && !existsSync(join(work, 'escape.txt')), 'nothing was written outside the destination');

  const absolute = join(work, 'absolute.tar.gz');
  writeFileSync(absolute, tarGz([tarEntry({ name: '/tmp/absolute-escape.txt', content: 'nope' })]));
  let absoluteRefused = false;
  try {
    await extractTarGz(absolute, join(work, 'out3'));
  } catch {
    absoluteRefused = true;
  }
  check(absoluteRefused, 'refuses an absolute member path');

  const evilLink = join(work, 'evil-link.tar.gz');
  writeFileSync(evilLink, tarGz([tarEntry({ name: 'python/evil', type: '2', link: '../../etc/passwd' })]));
  let linkRefused = false;
  try {
    await extractTarGz(evilLink, join(work, 'out4'), { stripPrefix: 'python' });
  } catch {
    linkRefused = true;
  }
  check(linkRefused, 'refuses a symlink that escapes the destination');

  // -------------------------------------------------------------------------
  // 3 + 4. provisioning and execution (real)
  // -------------------------------------------------------------------------
  if (QUICK) {
    skip('provisioning + execution', '--quick');
  } else {
    console.log('--- provisioning (real; first run downloads the runtime) ---');
    // --runtime-root keeps the provisioned runtime between runs (the expensive
    // part is the one-time dependency install); without it each run starts cold.
    const runtimeRoot = RUNTIME_ROOT ? resolve(RUNTIME_ROOT) : join(work, 'runtime');
    process.env.DSH_CAD_PYTHON_ROOT = runtimeRoot;
    process.env.DSH_CAD_PYTHON_INDEX_URL = INDEX_URL;
    delete process.env.DSH_CAD_PYTHON;

    if (ARCHIVE) {
      const cache = join(runtimeRoot, 'cache');
      mkdirSync(cache, { recursive: true });
      const key = detectPythonTarget();
      const target = key ? PYTHON_BUILD.targets[key] : undefined;
      if (!target) throw new Error(`no locked target for ${process.platform}/${process.arch}`);
      cpSync(ARCHIVE, join(cache, target.asset));
      console.log(`      … seeded the archive cache with ${ARCHIVE}`);
    }

    const { ensurePythonRuntime, pythonRuntimeStatus } = await import('../src/host/python-runtime.ts');
    const { runPython } = await import('../src/host/python-worker.ts');

    const started = Date.now();
    let lastPhase = '';
    const runtime = await ensurePythonRuntime({
      onProgress: (message) => {
        if (message !== lastPhase) {
          lastPhase = message;
          console.log(`      … ${message}`);
        }
      },
    });
    check(existsSync(runtime.venvPython), 'venv interpreter exists', runtime.venvPython);
    check(runtime.source === 'standalone' || runtime.source === 'dsh-primary-runtime', 'runtime reports its provenance', runtime.source);
    console.log(`      provisioned in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    const imports = await runPython(
      {
        code: [
          'import numpy, scipy, trimesh, manifold3d, networkx, skfem, rtree, rapier3d, sys',
          'print("python", sys.version.split()[0])',
          'print("numpy", numpy.__version__, "scipy", scipy.__version__)',
          'print("trimesh", trimesh.__version__, "networkx", networkx.__version__)',
          'print("scikit-fem", skfem.__version__, "rtree", rtree.__version__)',
          'print("rapier3d", rapier3d.__name__)',
          'print("manifold3d", manifold3d.__name__)',
        ].join('\n'),
        cwd: ROOT,
        timeoutMs: 120_000,
      },
      (message) => console.log(`      … ${message}`),
    );
    check(imports.ok, `all ${EXPECTED_PINNED.length} dependencies import in the venv`, imports.stderr.trim().split('\n').slice(-2).join(' | '));
    check(/^python 3\.13/.test(imports.stdout.trim()), 'the interpreter is the pinned 3.13', imports.stdout.trim().split('\n')[0]);

    const crash = await runPython({
      code: 'def f(x):\n    return x + 1\n\nf("not a number")\n',
      cwd: ROOT,
      timeoutMs: 60_000,
    });
    check(!crash.ok, 'a crashing program reports failure');
    check(
      Boolean(crash.traceback && /TypeError/.test(crash.traceback) && /line 4/.test(crash.traceback)),
      'the traceback names the error and the line',
      (crash.traceback ?? '').split('\n').slice(-1)[0],
    );

    const runaway = await runPython({ code: 'while True:\n    pass\n', cwd: ROOT, timeoutMs: 3_000 });
    check(runaway.timedOut && !runaway.ok, 'a runaway is killed at the deadline', `after ${(runaway.durationMs / 1000).toFixed(1)}s`);

    const status = await pythonRuntimeStatus();
    check(status.state === 'ready', 'status reports ready', status.state);
    check(status.skipped.length === 0, 'a supported platform reports no skipped packages', `${status.skipped.length} skipped`);
    check(status.occupiedBytes > 100 * 1024 * 1024, 'status reports the real disk footprint', `${(status.occupiedBytes / 1048576).toFixed(0)} MiB`);

    // The work this runtime exists to serve: the repository's own independent
    // FEM cross-validation (scikit-fem against the hand-written matrix-free
    // solver). If the bundled venv cannot run it, the runtime is a demo.
    const xval = join(ROOT, 'scripts', 'xval-cantilever-scikitfem.py');
    if (existsSync(xval)) {
      const viaScript = await runPython({ script: xval, cwd: ROOT, timeoutMs: 300_000 });
      check(
        viaScript.ok && /0\.1930/.test(viaScript.stdout),
        'the repo scikit-fem cross-validation script runs in the venv',
        viaScript.ok ? viaScript.stdout.split('\n').filter(Boolean).slice(-1)[0] : viaScript.traceback?.split('\n').slice(-1)[0],
      );
    } else {
      skip('the repo scikit-fem cross-validation script', 'scripts/xval-cantilever-scikitfem.py not present');
    }

    // The tool path: registration through the normal helper, the project-cwd
    // resolution, and the rendered status. The worker is already covered above;
    // this is the glue the model actually reaches.
    console.log('--- tool path ---');
    const captured = new Map();
    const toolCtx = {
      tools: {
        register: (definition) => { captured.set(definition.name, definition); return () => {}; },
        restrict: () => () => {},
      },
      on: () => {},
      effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
      reflect: { get: () => undefined },
      logger: { info: () => {}, warn: () => {} },
    };
    const { registerCadTools } = await import('../src/host/tools.ts');
    registerCadTools(toolCtx, {});
    const runTool = captured.get('run_python');
    const statusTool = captured.get('python_runtime');
    check(Boolean(runTool && statusTool), 'run_python and python_runtime register through the normal tool helper');
    const projectDir = join(work, 'project');
    mkdirSync(projectDir, { recursive: true });
    const fakeExec = { agent: { session: { header: { cwd: projectDir } } } };
    const viaTool = await runTool.execute(
      { code: 'import numpy\nprint("tool path ok", numpy.__version__)' },
      fakeExec,
    );
    check(viaTool.ok && /tool path ok/.test(viaTool.stdout), 'the tool runs Python in the project directory', viaTool.stdout.trim());
    check(existsSync(join(projectDir, 'cad-data')), 'the tool call resolves (and creates) the project store');
    const statusViaTool = await statusTool.execute({ action: 'status' });
    check(
      statusViaTool.state === 'ready' && /Python runtime: ready/.test(statusViaTool.summary),
      'python_runtime renders its status through the tool',
    );
  }

  // -------------------------------------------------------------------------
  // 5. the off switch
  // -------------------------------------------------------------------------
  console.log('--- off switch ---');
  const { pythonRuntimeStatus, ensurePythonRuntime, pythonRuntimeMode } = await import('../src/host/python-runtime.ts');
  process.env.DSH_CAD_PYTHON = 'off';
  check(pythonRuntimeMode() === 'off', 'DSH_CAD_PYTHON=off is honoured');
  const disabled = await pythonRuntimeStatus();
  check(disabled.state === 'disabled', 'status reports disabled instead of absent', disabled.state);
  let disabledThrew = false;
  try {
    await ensurePythonRuntime();
  } catch (error) {
    disabledThrew = /disabled/.test(String(error?.message ?? error));
  }
  check(disabledThrew, 'provisioning refuses to run while disabled');
  delete process.env.DSH_CAD_PYTHON;
  process.env.DSH_CAD_PYTHON = 'system';
  check(pythonRuntimeMode() === 'system', 'DSH_CAD_PYTHON=system is honoured');
  delete process.env.DSH_CAD_PYTHON;
} finally {
  if (KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
