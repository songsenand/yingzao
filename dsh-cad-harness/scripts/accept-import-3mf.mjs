// Acceptance for 3MF import (trimesh + lxml; adopted 2026-10-22).
//
// What this has to prove, in order:
//   1  a 3MF becomes a solid version like any other import (volume/bbox in mm)
//   2  the file's own `unit` is folded to mm — trimesh stores it as metadata and
//      does NOT scale, so the ×25.4 has to be OURS (fixture: unit="inch")
//   3  a build-item 4×3 transform is applied
//   4  <components> nesting is applied
//   5  a plate of objects is REFUSED, not stored as one multi-body part
//   6  a caller-declared unit is refused (the file carries its own)
//   7  a zip that is not a 3MF fails with a message, not a stack trace
//
//   node scripts/accept-import-3mf.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { importGeometry } from '../src/host/import.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// Isolate the corpus: project stores resolve from the session cwd, but the
// RUNTIME (and its scratch dir) resolve from $DSH_HOME — a fresh HOME is a cold
// runtime, so provision up front exactly like accept-import.mjs does.
const HOME = await mkdtemp(join(tmpdir(), 'cad-3mf-home-'));
process.env.DSH_HOME = HOME;
{
  process.env.DSH_CAD_PIP_CACHE_DIR ??= join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-pip-cache');
  const { pythonRuntimeStatus, repairPythonRuntime } = await import('../src/host/python-runtime.ts');
  const status = await pythonRuntimeStatus();
  if (status.state !== 'ready') {
    // DSH_CAD_PYTHON_ROOT means "use a runtime I already own". Repairing it here
    // would rebuild someone else's venv from this test — that is how a run of
    // this script once gutted the developer's real runtime when the provisioning
    // was interrupted. Refuse instead; a throwaway root is what the default path
    // (a fresh $DSH_HOME) provisions into.
    if (process.env.DSH_CAD_PYTHON_ROOT) {
      console.error(
        `runtime at ${process.env.DSH_CAD_PYTHON_ROOT} is not ready (state: ${status.state}) — ` +
        'refusing to repair a runtime this run does not own. Unset DSH_CAD_PYTHON_ROOT to provision a throwaway one.',
      );
      process.exit(2);
    }
    console.log(`runtime not ready (state: ${status.state}) — provisioning from the lock (minutes on first run)...`);
    await repairPythonRuntime({
      pipTimeoutMs: 45 * 60 * 1000,
      onProgress: (message) => console.error(`  [provision] ${message}`),
    });
    console.log('runtime ready.');
  }
}

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cad-import');
const load = (file, opts = {}) => importGeometry({ file: join(FIX, file), cwd: FIX, unit: 'mm', ...opts });
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const size = (r) => r.boundingBoxMm.size.map((v) => Number(v.toFixed(3))).join('×');

// 1 — a plain 10 mm cube
const cube = await load('cube-10mm.3mf');
check(
  cube.solid && cube.shells === 1 && near(cube.volumeMm3, 1000, 0.5) && near(cube.boundingBoxMm.size[0], 10, 0.01),
  'a 10 mm 3MF imports as one solid 10 mm cube',
  `solid=${cube.solid} shells=${cube.shells} vol=${cube.volumeMm3.toFixed(2)} size=${size(cube)}`,
);
check(cube.format === '3mf', 'the result reports format 3mf (not stl)', cube.format);

// 2 — the file's own unit, not the caller's
const inch = await load('cube-1inch.3mf');
check(
  near(inch.boundingBoxMm.size[0], 254, 0.05) && near(inch.volumeMm3, 1000 * 25.4 ** 3, 5000),
  'unit="inch" is folded to mm exactly once (×25.4)',
  `size=${size(inch)} vol=${inch.volumeMm3.toFixed(0)} (want ${(1000 * 25.4 ** 3).toFixed(0)})`,
);

// 3 — build-item transform
const moved = await load('cube-moved-20mm.3mf');
check(
  near(moved.boundingBoxMm.min[0], 15, 0.01) && near(moved.boundingBoxMm.max[0], 25, 0.01),
  'a build-item transform (+20 mm) is applied',
  `x ${moved.boundingBoxMm.min[0].toFixed(2)}..${moved.boundingBoxMm.max[0].toFixed(2)}`,
);

// 4 — components nesting
const comp = await load('cube-components.3mf');
check(
  near(comp.boundingBoxMm.min[0], 15, 0.01) && near(comp.boundingBoxMm.max[0], 25, 0.01),
  '<components> nesting applies the referenced object transform',
  `x ${comp.boundingBoxMm.min[0].toFixed(2)}..${comp.boundingBoxMm.max[0].toFixed(2)}`,
);

// 5 — a plate of objects is not a part
let refused = '';
try { await load('plate-two.3mf'); } catch (e) { refused = String(e?.message ?? e); }
check(
  /2 separate bodies/.test(refused) && /3MF/.test(refused),
  'a two-object 3MF is refused, not stored as a multi-body part',
  refused || '(no error)',
);

// 6 — the file carries its own unit
let unitRefused = '';
try { await load('cube-10mm.3mf', { unit: 'inch' }); } catch (e) { unitRefused = String(e?.message ?? e); }
check(
  /carries its own units/.test(unitRefused),
  'a caller-declared unit on a 3MF is refused',
  unitRefused || '(no error)',
);

// 7 — a zip that is not a 3MF. The worker protocol appends the Python traceback
// to every handler error, so the check is on the ACTIONABLE line, not on the
// absence of a stack (which the protocol owns).
let badZip = '';
try { await load('not-a-3mf.3mf'); } catch (e) { badZip = String(e?.message ?? e); }
check(
  /not a 3MF/i.test(badZip) && /3dmodel\.model/.test(badZip),
  'a zip without a model part fails with an actionable 3MF message',
  badZip.split('\n')[0] || '(no error)',
);

await rm(HOME, { recursive: true, force: true }).catch(() => {});
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
