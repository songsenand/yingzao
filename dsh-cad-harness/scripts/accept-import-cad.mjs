// Acceptance for CAD-format import (STEP via cascadio/OpenCASCADE, DXF via ezdxf).
// Adopted 2026-10-15 — DECISION-LOG same day; numbers probed in
// experiments/20261015_cad_import_probe.md, fixture baselines in
// scripts/fixtures/cad-import/README.md.
//
// What this has to prove, in order:
//   1  a STEP file becomes the same kind of truth an STL does: a closed solid
//      with measured volume/genus, and the metres→mm normalization is stated
//   2  a multi-body STEP is stored with its body count said out loud (10 shells)
//   3  scale works on STEP, and a caller-declared unit is REFUSED (the file
//      self-declares — a unit argument would double-apply)
//   4  DXF 2D closed profiles + depthMm become a solid with the hole (genus 1),
//      and $INSUNITS is honoured (inch = exactly 25.4³)
//   5  a DXF without depthMm is refused with the way forward, nothing stored
//   6  binary DXF and ASCII DXF land the same geometry
//   7  DXF 3D mesh entities (POLYFACE) import like an STL would
//   8  IGES states its boundary instead of failing opaquely
//   9  an imported STEP passes through the EXISTING measure tool like a
//      generated part — no special case downstream
//
//   node scripts/accept-import-cad.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { importGeometry } from '../src/host/import.ts';
import { cadToolNames, registerCadTools } from '../src/host/tools.ts';
import { projectStores } from '../src/host/project.ts';
import { openVersionStore } from '../src/host/version.ts';
import { openPartStore } from '../src/host/parts.ts';
import { measureVersion } from '../src/host/inspect.ts';
import { pythonRuntimeStatus, repairPythonRuntime } from '../src/host/python-runtime.ts';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Isolate the corpus: the tool resolves its project store from $DSH_HOME, and an
// acceptance run must never write into the developer's real one.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'cad-import');
const HOME = await mkdtemp(join(tmpdir(), 'cad-import-cad-home-'));
process.env.DSH_HOME = HOME;
const WORK = await mkdtemp(join(tmpdir(), 'cad-import-cad-work-'));
const PROJ = join(WORK, 'handoff');
const corpus = projectStores(PROJ);
const store = openVersionStore(corpus.root);
const partStore = openPartStore(corpus.root); // touched so the part manifest exists for the tool path

function fakeHost() {
  const defs = new Map();
  const images = [];
  const ctx = {
    tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
    attachments: {
      saveImages: async (items) => items.map((it) => {
        const ref = { id: `att-${images.length}` };
        images.push({ ...it, ref });
        return ref;
      }),
    },
    reflect: { get: () => undefined },
    on: () => () => {},
  };
  registerCadTools(ctx, {});
  return { defs, images };
}
const host = fakeHost();
const importTool = host.defs.get('import_part');
const exec = { agent: { session: { header: { cwd: PROJ } } } };
const fx = (name) => join(FIXTURES, name);

// The worker refuses to provision inside a tool call (a 60–180 s timeout must not
// absorb a 6–11 min cold install), so the acceptance provisions up front — same
// pattern as accept-lbm-channel.mjs. Later runs are warm.
{
  const status = await pythonRuntimeStatus();
  if (status.state !== 'ready') {
    console.log(`runtime not ready (state: ${status.state}) — provisioning from the lock (takes minutes on first run)...`);
    // A fresh HOME is always a cold install; the default 20-min pip budget is
    // sized for repairs of warm runtimes, not for the whole lock from scratch.
    await repairPythonRuntime({
      pipTimeoutMs: 45 * 60 * 1000,
      onProgress: (message) => console.error(`  [provision] ${message}`),
    });
    console.log('runtime ready.');
  }
}

// ---------- 1. STEP single solid ----------
const screw = await importGeometry({ file: fx('colored.step'), cwd: PROJ });
check('1a colored.step imports as a closed solid (mm, OpenCASCADE normalized)',
  screw.solid && screw.format === 'step-cascadio', `format=${screw.format} solid=${screw.solid}`);
check('1b volume matches the probe baseline (default tessellation)',
  near(screw.volumeMm3, 242.2, 0.5), `volume=${screw.volumeMm3} mm³ (baseline 242.2)`);
check('1c the metres→mm step is stated, not silent',
  screw.warnings.some((w) => /×1000|metres/.test(w)), screw.warnings.join(' | ').slice(0, 90));
check('1d it is one body with no holes', screw.shells === 1 && screw.genus === 0, `shells=${screw.shells} genus=${screw.genus}`);

// ---------- 2. STEP multibody ----------
const multi = await importGeometry({ file: fx('multibody.step'), cwd: PROJ });
check('2a multibody.step is a solid whose body count is said out loud',
  multi.solid && multi.shells === 10, `shells=${multi.shells} volume=${multi.volumeMm3}`);
check('2b volume and genus match the probe baseline',
  near(multi.volumeMm3, 263544.1, 50) && multi.genus === 12, `volume=${multi.volumeMm3} genus=${multi.genus}`);

// ---------- 3. scale yes, unit no ----------
const half = await importGeometry({ file: fx('colored.step'), cwd: PROJ, scale: 0.5 });
check('3a scale works on STEP (0.5 → exactly 1/8 volume)', near(half.volumeMm3, screw.volumeMm3 / 8, 0.1),
  `volume=${half.volumeMm3} (expect ${screw.volumeMm3 / 8})`);
check('3b appliedScale states the total incl. the metres→mm step',
  half.appliedScale === 500, `appliedScale=${half.appliedScale}`);
let unitMsg = null;
try { await importGeometry({ file: fx('colored.step'), cwd: PROJ, unit: 'inch' }); } catch (e) { unitMsg = String(e?.message ?? e); }
check('3c a caller unit on STEP is refused (the file self-declares)',
  !!unitMsg && /STEP carries its own units/.test(unitMsg), (unitMsg ?? '(no error)').slice(0, 80));

// ---------- 4. DXF profiles + depthMm ----------
const plate = await importGeometry({ file: fx('profile-mm.dxf'), cwd: PROJ, depthMm: 10 });
check('4a DXF profile + depthMm=10 → closed plate with the hole',
  plate.solid && plate.format === 'dxf-ezdxf-extrude' && plate.genus === 1,
  `format=${plate.format} genus=${plate.genus}`);
check('4b volume matches theory (40×40 − π·6²) × 10',
  near(plate.volumeMm3, 14870.5, 2), `volume=${plate.volumeMm3} (theory 14869.3, flattened)`);

const inchPlate = await importGeometry({ file: fx('profile-inch.dxf'), cwd: PROJ, depthMm: 10 });
check('4c $INSUNITS=1 (inch) scales the profile ×25.4; depthMm stays mm → exactly 25.4²',
  near(inchPlate.volumeMm3 / plate.volumeMm3, 25.4 ** 2, 0.5),
  `ratio=${(inchPlate.volumeMm3 / plate.volumeMm3).toFixed(1)} (25.4² = 645.16)`);
check('4d the unit statement travels as a warning',
  inchPlate.warnings.some((w) => /\$INSUNITS=1/.test(w) && /25\.4/.test(w)), inchPlate.warnings.join(' | ').slice(0, 90));

// ---------- 5. DXF without depthMm is refused, actionable ----------
let depthMsg = null;
try { await importGeometry({ file: fx('profile-mm.dxf'), cwd: PROJ }); } catch (e) { depthMsg = String(e?.message ?? e); }
check('5a DXF without depthMm names the fix', !!depthMsg && /depthMm/.test(depthMsg), (depthMsg ?? '(no error)').slice(0, 90));

// ---------- 6. binary DXF = ASCII DXF ----------
const binPlate = await importGeometry({ file: fx('profile-bin.dxf'), cwd: PROJ, depthMm: 10 });
check('6a binary DXF lands the same geometry as ASCII',
  binPlate.solid && near(binPlate.volumeMm3, plate.volumeMm3, 0.1), `volume=${binPlate.volumeMm3}`);

// ---------- 7. DXF 3D mesh entities ----------
const box = await importGeometry({ file: fx('polyface-box.dxf'), cwd: PROJ });
check('7a POLYFACE box imports like an STL would',
  box.solid && box.format === 'dxf-ezdxf-mesh' && near(box.volumeMm3, 8000, 0.1),
  `format=${box.format} volume=${box.volumeMm3} genus=${box.genus}`);

// ---------- 8. IGES boundary ----------
let igsMsg = null;
try { await importGeometry({ file: fx('microstrip.igs'), cwd: PROJ }); } catch (e) { igsMsg = String(e?.message ?? e); }
check('8a IGES states its boundary and a way forward',
  !!igsMsg && /IGES/.test(igsMsg) && /STEP|STL/.test(igsMsg), (igsMsg ?? '(no error)').slice(0, 90));

// ---------- 9. the tool door + existing measure, no special case ----------
const toolResult = await importTool.execute({
  file: fx('colored.step'), part: '螺丝-STEP', render: false, userIntent: '同事的 STEP 交付',
}, exec);
check('9a the tool lands a STEP as a version', toolResult.versionId?.startsWith?.('v') === true && toolResult.format === 'step-cascadio',
  `${toolResult.versionId} ${toolResult.format}`);
const measured = await measureVersion(store, toolResult.versionId);
check('9b the existing measure tool reads it unchanged (volume parity)',
  near(measured.volumeMm3, screw.volumeMm3, 0.5), `measure_part=${measured.volumeMm3} vs import=${screw.volumeMm3}`);
check('9c import_part is still the one tool, now with three formats',
  cadToolNames().includes('import_part'), cadToolNames().join(','));

// ---------- torn down ----------
await rm(HOME, { recursive: true, force: true }).catch(() => {});
await rm(WORK, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
