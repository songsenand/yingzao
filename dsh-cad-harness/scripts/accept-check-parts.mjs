// Acceptance for `check_parts`: one call screens a family, and the printability
// half is the SAME job as `check_printability` (runs included).
//
// The glucose build made 11 measure_part + 22 check_printability calls for 7
// parts. This test proves the batch tool returns the same per-part facts in one
// compact table and writes one printability run per version, so the rows can
// back a delivery claim.
//
//   node scripts/accept-check-parts.mjs [--runtime <dir>]
//
// Needs the pinned Python runtime (the measure/printability engines), like the
// assembly parity test; it is not part of `npm run accept` for that reason.
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cad-check-parts-'));
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, 'dsh-cad-harness', '.tmp-cad-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — pass --runtime <dir> with a provisioned runtime`);
  process.exit(2);
}

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores, ensureProjectDir } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
const { listRuns } = await import('../src/host/runs.ts');
const { writeBinaryStl } = await import('../src/host/mesh.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A closed box as a binary STL (12 triangles), the shape both screens can read. */
function boxStl(dx, dy, dz) {
  const v = [
    0, 0, 0, dx, 0, 0, dx, dy, 0, 0, dy, 0,
    0, 0, dz, dx, 0, dz, dx, dy, dz, 0, dy, dz,
  ];
  const t = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return writeBinaryStl({ vertProperties: new Float32Array(v), triVerts: new Uint32Array(t) });
}

/**
 * A single closed L-prism with a deliberately LARGE print-overhang: the arm's
 * underside is a 14 x 6 mm down-facing face at z=14. It is one solid (not two
 * overlapping boxes), so the wall/overhang engines see a real part.
 *
 * This is the orientation fixture. `printOrientationDeg: [90,0,0]` turns the arm
 * vertical, so the print-overhang area must collapse; `[0,0,90]` is a spin about
 * the bed normal and must NOT change it. That distinction is what the old
 * `views: []` / `[0,0,90]` check missed.
 */
function lPrismStl() {
  const pts = [
    [0, 0], [6, 0], [6, 14], [20, 14], [20, 20], [0, 20],
  ];
  const verts = [];
  for (const y of [0, 6]) for (const [x, z] of pts) verts.push(x, y, z);
  const tris = [];
  // L faces at y=0 and y=6. An ear-clipping of the CONCAVE 6-gon: a fan from
  // vertex 0 would cover area outside the L and make the mesh non-manifold.
  const cap = [[0, 1, 2], [0, 2, 5], [2, 3, 4], [2, 4, 5]];
  for (const [a, b, c] of cap) tris.push(a, b, c);
  for (const [a, b, c] of cap) tris.push(6 + a, 6 + c, 6 + b);
  // Side quads around the perimeter.
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    // Outward winding: the caps above are -y at y=0 and +y at y=6; the sides
    // must be wound to match, or Manifold rejects the solid as non-manifold.
    tris.push(i, j + 6, j, i, i + 6, j + 6);
  }
  return writeBinaryStl({
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
  });
}

const tools = new Map();
const fakeCtx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  on: () => {},
  effect: (fn) => fn(),
  attachments: {
    saveImages: async (images) => images.map((img, i) => ({
      attachmentId: `test-image-${i}`, mediaType: 'image/png', bytes: img.data.byteLength, name: img.name,
    })),
  },
  reflect: {
    get: (k) => (k === 'agentPresets'
      ? { list: async () => [{ id: 'cad', name: '造物模式' }] }
      : k === 'connection'
        ? { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } }
        : undefined),
  },
};
registerCadTools(fakeCtx, { toolScope: 'preset', presets: ['cad'] });
check(tools.has('check_parts'), 'check_parts is registered');

const cwd = join(process.env.DSH_HOME, 'proj');
mkdirSync(cwd, { recursive: true });
const project = projectStores(cwd);
await ensureProjectDir(project);
const part = await ensurePart(project.partStore, '测试件', 'agent');
const thin = await saveVersion(project.store, {
  scadCode: '// test', stl: boxStl(10, 10, 0.5), userIntent: 'thin plate', partId: part.id,
});
await attachVersion(project.partStore, part.id, thin);
const cube = await saveVersion(project.store, {
  scadCode: '// test', stl: boxStl(10, 10, 10), userIntent: 'cube', partId: part.id,
});
await attachVersion(project.partStore, part.id, cube);
const overhang = await saveVersion(project.store, {
  scadCode: '// L-prism orientation fixture', stl: lPrismStl(), userIntent: 'L-prism with a 14x6 mm down-facing arm',
  partId: part.id,
});
await attachVersion(project.partStore, part.id, overhang);

const exec = { agent: { session: { header: { cwd } } } };
const batch = await tools.get('check_parts').execute({
  versionIds: [thin, cube],
  profileIds: ['fdm-pla-0.4'],
}, exec);

check(batch.parts.length === 2 && batch.failures.length === 0,
  'two versions screen in one call', JSON.stringify(batch.summary));
const thinRow = batch.parts.find((p) => p.versionId === thin);
const cubeRow = batch.parts.find((p) => p.versionId === cube);
check(thinRow?.partName === '测试件', 'the row names the part', String(thinRow?.partName));
check(thinRow?.watertight === true && thinRow?.bodies === 1,
  'the measure half reports watertight and body count', JSON.stringify({ w: thinRow?.watertight, b: thinRow?.bodies }));
check(typeof thinRow?.printability?.minWallMm === 'number'
    && thinRow.printability.minWallMm > 0.3 && thinRow.printability.minWallMm < 0.7,
  'the printability half finds the 0.5mm wall', String(thinRow?.printability?.minWallMm));
check(thinRow?.printability?.profiles?.some((p) => p.verdict === 'excluded'),
  'the thin plate is excluded by fdm-pla-0.4 (profile verdict)', JSON.stringify(thinRow?.printability?.profiles));
check(typeof thinRow?.printability?.runId === 'string' && thinRow.printability.runId.startsWith('r'),
  'the printability row cites the run it wrote', String(thinRow?.printability?.runId));
check(!cubeRow?.printability?.profiles?.some((p) => p.verdict === 'excluded'),
  'the 10mm cube is not excluded by the wall rule', JSON.stringify(cubeRow?.printability?.profiles));
check(batch.summary.thinnestMm === thinRow.printability.minWallMm,
  'the summary names the thinnest wall', String(batch.summary.thinnestMm));

const runs = await listRuns(project.runStore);
const printRuns = runs.filter((r) => r.kind === 'printability');
check(printRuns.length === 2, 'one printability run per version (evidence, not a shortcut)', String(printRuns.length));

// ── print orientation must actually reach the printability job ──────────────
// The L-prism's arm underside is a large print-overhang in the modelling pose.
// [90,0,0] stands it up; [0,0,90] only spins it on the bed.
const flat = await tools.get('check_parts').execute({
  versionIds: [overhang], profileIds: ['fdm-pla-0.4'],
}, exec);
const stood = await tools.get('check_parts').execute({
  versionIds: [overhang], profileIds: ['fdm-pla-0.4'], printOrientationDeg: [90, 0, 0],
}, exec);
const spun = await tools.get('check_parts').execute({
  versionIds: [overhang], profileIds: ['fdm-pla-0.4'], printOrientationDeg: [0, 0, 90],
}, exec);
const flatRow = flat.parts[0].printability;
const stoodRow = stood.parts[0].printability;
const spunRow = spun.parts[0].printability;
check(flatRow?.overhangAreaMm2 > 50,
  'the L-prism has a large print-overhang in the modelling pose', String(flatRow?.overhangAreaMm2));
check(stoodRow?.overhangAreaMm2 < flatRow.overhangAreaMm2 * 0.25,
  'check_parts passes printOrientationDeg through: [90,0,0] collapses the overhang',
  `${flatRow.overhangAreaMm2} -> ${stoodRow.overhangAreaMm2}`);
check(spunRow?.overhangAreaMm2 === flatRow.overhangAreaMm2,
  'a z-spin does NOT change print-overhang (it is not a flip)',
  `${flatRow.overhangAreaMm2} vs ${spunRow.overhangAreaMm2}`);
check(JSON.stringify(stoodRow?.printOrientationDeg) === JSON.stringify([90, 0, 0]),
  'the row records the print frame it was measured in', JSON.stringify(stoodRow?.printOrientationDeg));

const stoodRun = await listRuns(project.runStore).then((rs) => rs.find((r) => r.id === stoodRow.runId));
const stoodReport = stoodRun ? JSON.parse(await readFile(join(project.runStore.root, stoodRun.id, 'report.json'), 'utf8')) : null;
check(JSON.stringify(stoodReport?.printOrientationDeg) === JSON.stringify([90, 0, 0]),
  'the persisted printability report records printOrientationDeg (evidence, not just the reply)',
  JSON.stringify(stoodReport?.printOrientationDeg));

// `check_printability` (the single-part tool) must agree with the batch row: the
// batch is the SAME job, not a second implementation.
const single = await tools.get('check_printability').execute({
  versionId: overhang, profileIds: ['fdm-pla-0.4'], printOrientationDeg: [90, 0, 0],
}, exec);
check(Math.abs(single.overhangAreaMm2 - stoodRow.overhangAreaMm2) < 1e-6,
  'check_parts and check_printability report the same overhang under the same orientation',
  `${stoodRow.overhangAreaMm2} vs ${single.overhangAreaMm2}`);

// `review_visual` must render the required views, attach them, and write the
// per-version sidecar the delivery audit reads.
const review = await tools.get('review_visual').execute({
  items: [{ versionId: cube, note: 'checked the cube top and iso: six faces, no notch or slot' }],
}, exec);
check(review.reviewed.length === 1 && review.reviewed[0].versionId === cube,
  'review_visual records the version', JSON.stringify(review));
const reviewPath = join(project.store.root, 'versions', cube, 'visual-review.json');
const reviewRecord = JSON.parse(await readFile(reviewPath, 'utf8'));
check(reviewRecord.views.includes('top') && reviewRecord.views.includes('iso'),
  'the record covers top+iso', JSON.stringify(reviewRecord.views));
check(reviewRecord.source === 'review_visual' && reviewRecord.notes[0].length > 8,
  'the record carries the model note and source', JSON.stringify(reviewRecord.notes));
const reviewBlocks = tools.get('review_visual').finalizeContent(exec, { value: review });
check(Array.isArray(reviewBlocks) && reviewBlocks.filter((b) => b.type === 'image').length === 2,
  'review_visual attaches the top+iso images to the model reply',
  JSON.stringify(reviewBlocks?.map((b) => b.type)));
const shortNote = await tools.get('review_visual').execute({
  items: [{ versionId: cube, note: 'ok' }],
}, exec).then(() => null).catch((e) => String(e));
check(typeof shortNote === 'string' && /substantive note/.test(shortNote),
  'a bare "ok" note is refused (the tool demands an articulation)', shortNote ?? 'accepted');

// `views: []` must no longer be a way to register a shape the model never saw.
const generated = await tools.get('generate_part').execute({
  part: '视图覆盖测试',
  scadCode: 'cube([6,6,6], center=true);',
  userIntent: 'prove views: [] is overridden for a new shape',
  views: [],
}, exec);
check(generated.success === true && generated.views.includes('top') && generated.views.includes('iso'),
  'generate_part overrides views:[] and attaches top+iso', JSON.stringify(generated.views));
check(generated.warnings.some((w) => /views: \[\] was overridden/.test(w)),
  'the override is said out loud in warnings', JSON.stringify(generated.warnings));

// The C-lite lifecycle tools: read the binding, create a nested marker without
// rebinding. (The function-level cases live in accept-project-cwd.mjs.)
const info = await tools.get('project_info').execute({}, exec);
check(info.wouldBindTo === cwd && info.mismatch === false,
  'project_info reports where an unbound session would bind', JSON.stringify(info));
const init = await tools.get('init_project').execute({ dir: 'nested-example', title: 'nested' }, exec);
check(init.created === true && init.inheritedFrom === cwd,
  'init_project creates a nested marker and names the ancestor it shadows', JSON.stringify(init));
const infoAfter = await tools.get('project_info').execute({}, exec);
check(infoAfter.wouldBindTo === cwd && infoAfter.boundRoot === undefined,
  'init_project does NOT rebind the calling session', JSON.stringify(infoAfter));

// Fail closed: a CAD write from a subdirectory of a project, without its own
// marker, must be refused instead of silently binding the ancestor.
const subDir = join(cwd, 'sub');
mkdirSync(subDir, { recursive: true });
const subExec = { agent: { session: { header: { id: 'sub-session', cwd: subDir } } } };
let ambiguous = '';
try {
  await tools.get('check_parts').execute({ versionIds: [cube], checks: ['measure'] }, subExec);
} catch (e) { ambiguous = String(e); }
check(/write target is ambiguous/.test(ambiguous),
  'a CAD write from an unmarked subdirectory is REFUSED (no root write, no later move)',
  ambiguous.slice(0, 120));
const subInit = await tools.get('init_project').execute({ dir: '.', title: 'sub' }, subExec);
check(subInit.created === true && subInit.root === subDir,
  'init_project resolves "." against the live cwd, not the ancestor', JSON.stringify(subInit));
const subInfo = await tools.get('project_info').execute({}, subExec);
check(subInfo.ambiguous === false && subInfo.wouldBindTo === subDir,
  'after init_project the subdirectory is the write target', JSON.stringify(subInfo));
const bindExec = { agent: { session: { header: { id: 'bind-session', cwd: subDir } } } };
const bound = await tools.get('bind_project').execute({ dir: cwd }, bindExec);
check(bound.root === cwd && bound.marker === 'project',
  'bind_project explicitly chooses the ancestor and returns the target', JSON.stringify(bound));
const boundInfo = await tools.get('project_info').execute({}, bindExec);
check(boundInfo.boundRoot === cwd && boundInfo.ambiguous === false,
  'after bind_project the session writes to the chosen ancestor', JSON.stringify(boundInfo));

// A missing version is one row's failure, not the whole call.
const partial = await tools.get('check_parts').execute({
  versionIds: [thin, 'v999'], checks: ['measure'],
}, exec);
check(partial.parts.length === 1 && partial.failures.length === 1
    && partial.failures[0].versionId === 'v999',
  'an unknown version fails its row, the rest still returns', JSON.stringify(partial.summary));

// Duplicates are screened once.
const dedup = await tools.get('check_parts').execute({
  versionIds: [thin, thin], checks: ['measure'],
}, exec);
check(dedup.summary.requested === 1, 'duplicate ids are screened once', String(dedup.summary.requested));

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
