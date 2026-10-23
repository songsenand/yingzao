// Acceptance for the USER PYTHON OVERLAY (2026-10-22).
//
// The user's machine is theirs: installing a package must be a normal act with a
// door, not a favour. What this proves, in order:
//   1  without the overlay, the package is genuinely absent (the control)
//   2  action=install puts it in a directory that provisioning never deletes
//      (it is a SIBLING of venv/, which is what repair/upgrade remove)
//   3  the same code then imports it — through the shared launch args
//   4  the RESIDENT WORKER sees it too (the user chose "tools can use it"):
//      proven by a .pth side effect the worker's interpreter runs at startup,
//      not by reading our own source
//   5  a package the lock already provides is reported as shadowed and the
//      LOCKED version still wins (adding is not overriding)
//   6  a committed RUN records the overlay digest + packages (provenance)
//   7  python_runtime status reports the overlay
//
//   node scripts/accept-python-overlay.mjs

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = await mkdtemp(join(tmpdir(), 'cad-overlay-home-'));
process.env.DSH_HOME = HOME;
// A throwaway overlay, so the developer's real one is never touched.
const OVERLAY = await mkdtemp(join(tmpdir(), 'cad-overlay-site-'));
process.env.DSH_CAD_USER_SITE = OVERLAY;

{
  process.env.DSH_CAD_PIP_CACHE_DIR ??= join(HERE, '..', '..', '.tmp-pip-cache');
  const { pythonRuntimeStatus, repairPythonRuntime } = await import('../src/host/python-runtime.ts');
  const status = await pythonRuntimeStatus();
  if (status.state !== 'ready') {
    if (process.env.DSH_CAD_PYTHON_ROOT) {
      console.error(
        `runtime at ${process.env.DSH_CAD_PYTHON_ROOT} is not ready (state: ${status.state}) — ` +
        'refusing to repair a runtime this run does not own. Unset DSH_CAD_PYTHON_ROOT to provision a throwaway one.',
      );
      process.exit(2);
    }
    console.log(`runtime not ready (state: ${status.state}) — provisioning from the lock...`);
    await repairPythonRuntime({
      pipTimeoutMs: 45 * 60 * 1000,
      onProgress: (message) => console.error(`  [provision] ${message}`),
    });
  }
}

const {
  installIntoPythonOverlay, pythonLaunchArgs, pythonOverlayDir, readPythonOverlay, pythonRuntimeStatus,
} = await import('../src/host/python-runtime.ts');
const { runPython, ensurePythonWorker } = await import('../src/host/python-worker.ts');

// ── 1. control: no overlay, no package ──────────────────────────────────────
const probe = 'import six; print("six", six.__version__)';
const before = await runPython({ code: probe, cwd: process.cwd(), timeoutMs: 60_000 });
check(!before.ok && /No module named 'six'/.test(before.stderr),
  'control: with an empty overlay, six is genuinely absent (so step 3 proves the overlay did it)',
  before.ok ? 'unexpectedly importable' : before.stderr.split('\n').filter(Boolean).slice(-1)[0]);

// ── 2. the door: install into the overlay ───────────────────────────────────
const installed = await installIntoPythonOverlay(['six==1.17.0'], { onProgress: () => {} });
check(installed.packages.some((p) => p.name === 'six' && p.version === '1.17.0'),
  'action=install lands six==1.17.0 in the user overlay',
  installed.packages.map((p) => `${p.name}==${p.version}`).join(', '));
check(installed.shadowed.length === 0, 'six is not in the lock, so nothing is shadowed');

const overlayDir = pythonOverlayDir();
check(overlayDir === OVERLAY, 'the overlay honours DSH_CAD_USER_SITE (this run owns it)', overlayDir);
const runtimeRoot = (await pythonRuntimeStatus()).root;
check(!overlayDir.startsWith(join(runtimeRoot, 'venv')),
  'the overlay is a SIBLING of venv/ — which is why `repair` (rm -rf venv) cannot erase it',
  `${overlayDir} vs ${join(runtimeRoot, 'venv')}`);
check(existsSync(join(OVERLAY, 'installed.json')),
  'the install is recorded (installed.json: what, when, what asked for it)',
  await readFile(join(OVERLAY, 'installed.json'), 'utf8').then((t) => t.replace(/\s+/g, ' ').slice(0, 90)).catch(() => '(missing)'));

// ── 3. visible to one-off scripts (the shared launch args) ──────────────────
const after = await runPython({ code: probe, cwd: process.cwd(), timeoutMs: 60_000 });
check(after.ok && /six 1\.17\.0/.test(after.stdout),
  'the same code now imports six from the overlay',
  after.ok ? after.stdout.trim() : after.stderr.split('\n').filter(Boolean).slice(-1)[0]);

// ── 4. visible to the RESIDENT WORKER ──────────────────────────────────────
//
// A Node test cannot look inside the worker's interpreter, so the proof is a
// side effect: a `.pth` in the overlay is executed by `site.addsitedir` when the
// worker boots. The file is written by the WORKER PROCESS, not by us.
const hitFile = join(OVERLAY, 'worker-hit.txt');
process.env.CAD_OVERLAY_PROBE = hitFile;
await writeFile(
  join(OVERLAY, '_overlay_probe.pth'),
  'import os,pathlib;pathlib.Path(os.environ["CAD_OVERLAY_PROBE"]).open("a").write("hit\\n")\n',
);
const worker = await ensurePythonWorker();
const versions = await worker.request('versions', {});
check(typeof versions?.python === 'string' && versions.python.startsWith('3.13'),
  'the resident worker starts and answers under the overlay bootstrap (runpy + JSON-lines intact)',
  `python ${versions?.python}`);
const hits = await readFile(hitFile, 'utf8').catch(() => '');
check(hits.includes('hit'),
  "the WORKER's interpreter processed the overlay site dir (its own .pth wrote this file)",
  `${hits.split('\n').filter(Boolean).length} startup hit(s)`);
check(pythonLaunchArgs('/tmp/worker.py').join(' ').includes(OVERLAY),
  'both spawn sites use pythonLaunchArgs (the overlay is attached there, not via PYTHONPATH which -I ignores)');
await rm(join(OVERLAY, '_overlay_probe.pth'), { force: true });

// ── 5. adding is not overriding ────────────────────────────────────────────
const shadow = await installIntoPythonOverlay(['networkx==3.7'], { onProgress: () => {} });
check(shadow.shadowed.some((p) => p.name.toLowerCase() === 'networkx'),
  'a package the lock already provides is reported as shadowed (the LOCKED version wins)',
  shadow.shadowed.map((p) => `${p.name}==${p.version}`).join(', ') || '(none reported)');
const still = await runPython({ code: 'import networkx; print(networkx.__version__)', cwd: process.cwd(), timeoutMs: 60_000 });
check(still.ok, 'networkx still imports (from the locked venv) after the overlay copy', still.stdout.trim());

// ── 5b. DEFAULT: a locked package stays locked (adding is not overriding) ───
const shadowParsing = await installIntoPythonOverlay(['pyparsing==3.1.2'], { onProgress: () => {} });
const lockedParsing = await runPython({ code: 'import pyparsing; print(pyparsing.__version__)', cwd: process.cwd(), timeoutMs: 60_000 });
check(shadowParsing.shadowed.some((p) => p.name.toLowerCase() === 'pyparsing')
  && lockedParsing.stdout.trim() === '3.3.3',
  'DEFAULT: an additive copy of a LOCKED package does not take effect (pyparsing still 3.3.3)',
  `shadowed=${shadowParsing.shadowed.map((p) => p.name).join(',')} · import=${lockedParsing.stdout.trim()}`);

// ── 5c. EXPLICIT: override needs a reason, then it really replaces ─────────
let refused = '';
try { await installIntoPythonOverlay(['pyparsing==3.1.2'], { override: true, onProgress: () => {} }); }
catch (e) { refused = String(e?.message ?? e); }
check(/declared reason/.test(refused),
  'override:true without a reason is refused with the rule stated (default stays "not allowed")',
  refused.split('\n')[0].slice(0, 100));

const overridden = await installIntoPythonOverlay(['pyparsing==3.1.2'], {
  override: true, reason: 'probe: the locked 3.3.3 cannot parse the grammar under test', onProgress: () => {},
});
check(overridden.overrides.some((p) => p.name.toLowerCase() === 'pyparsing'),
  'override:true moves the copy into the override dir (front of sys.path)',
  overridden.overrides.map((p) => `${p.name}==${p.version}`).join(', '));
const forcedParsing = await runPython({ code: 'import pyparsing; print(pyparsing.__version__)', cwd: process.cwd(), timeoutMs: 60_000 });
check(forcedParsing.ok && forcedParsing.stdout.trim() === '3.1.2',
  'the override REALLY replaces the locked version (pyparsing now 3.1.2)',
  forcedParsing.stdout.trim());
const statusAfter = await pythonRuntimeStatus();
check(statusAfter.overlay.overrides.some((p) => p.name === 'pyparsing')
  && statusAfter.overlay.overrideDir !== statusAfter.overlay.dir,
  'status tells the two policies apart (additive dir vs override dir)',
  `${statusAfter.overlay.dir} | ${statusAfter.overlay.overrideDir}`);
check(pythonLaunchArgs('/tmp/x.py').join(' ').includes(statusAfter.overlay.overrideDir),
  'the launch bootstrap knows the override dir (it is front-inserted, not appended)');

// ── 6. run provenance carries the overlay ──────────────────────────────────
const { openRunStore, beginRun } = await import('../src/host/runs.ts');
const runStore = openRunStore(await mkdtemp(join(tmpdir(), 'cad-overlay-runs-')));
const writer = await beginRun(runStore, { kind: 'physics', title: 'overlay provenance' });
const entry = await writer.commit({ status: 'pass', summary: 'no geometry', hasGeometry: false, sourceVersionIds: [] });
const recorded = entry.pythonOverlay;
const overlayNow = await readPythonOverlay();
check(recorded?.digest === overlayNow.digest && recorded.digest.length > 0,
  'a committed run records the overlay digest (the same version + same tool stays answerable)',
  `${recorded?.packages?.join(', ')} · ${recorded?.digest?.slice(0, 12)}`);
check((recorded?.packages ?? []).some((p) => p.startsWith('six==')),
  'the run names the packages, not just a hash', recorded?.packages?.join(', '));
check((recorded?.overrides ?? []).some((p) => p.startsWith('pyparsing==')),
  'the run names EXPLICIT OVERRIDES separately (a replaced dependency is part of the number)',
  recorded?.overrides?.join(', ') || '(none)');

// ── 7. status reports it ───────────────────────────────────────────────────
const status = await pythonRuntimeStatus();
check(status.overlay.packages.length >= 2 && status.overlay.dir === OVERLAY,
  'python_runtime status sees the overlay',
  status.overlay.packages.map((p) => `${p.name}==${p.version}`).join(', '));

await rm(HOME, { recursive: true, force: true }).catch(() => {});
await rm(OVERLAY, { recursive: true, force: true }).catch(() => {});
await rm(`${OVERLAY}-override`, { recursive: true, force: true }).catch(() => {});
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
