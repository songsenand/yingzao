// Acceptance for the 未登记 category's host half: the shared scan, the
// workspace path guard, and the preview tessellation.
//
// The property under test is not "a list appears" but the two things that make
// the category trustworthy:
//   1  the panel's list is the AUDIT's list (one implementation, two readers),
//      and "accounted for" is exact bytes — a copy of a registered mesh is not
//      flagged, an edited one is;
//   2  preview is NOT import: a plate of objects (2 bodies) previews, while
//      `importGeometry` refuses it; a path outside the workspace never previews.
//
//   node scripts/accept-unregistered.mjs

import { mkdtemp, mkdir, copyFile, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectStores } from '../src/host/project.ts';
import { scanUnregistered, resolveWorkspaceFile } from '../src/host/unregistered.ts';
import { previewGeometry } from '../src/host/import.ts';
import { auditDelivery } from '../src/host/delivery-audit.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// A fresh $DSH_HOME is a cold runtime; provision up front like the other import
// acceptances, but NEVER repair a runtime this run does not own (see the guard).
const HOME = await mkdtemp(join(tmpdir(), 'cad-unreg-home-'));
process.env.DSH_HOME = HOME;
{
  process.env.DSH_CAD_PIP_CACHE_DIR ??= join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-pip-cache');
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

const WORK = await mkdtemp(join(tmpdir(), 'cad-unreg-work-'));
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cad-import');

/** Binary STL cube, written here so the corpus setup needs no Python. */
function cubeStl(size) {
  const h = size / 2;
  const v = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('dsh unregistered fixture', 0);
  buf.writeUInt32LE(12, 80);
  let o = 84;
  for (const [i, j, k] of faces) {
    const a = v[i], b = v[j], c = v[k];
    const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const w = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    let n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    for (const p of [n, a, b, c]) for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
    o += 2;
  }
  return buf;
}

const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
const { listVersions, saveVersion } = await import('../src/host/version.ts');

const project = projectStores(WORK);
const part = await ensurePart(project.partStore, '支架', 'agent');
const registeredStl = cubeStl(10);
const version = await saveVersion(project.store, {
  scadCode: 'cube([10,10,10], center=true);', stl: registeredStl, userIntent: 'registered cube', partId: part.id,
});
await attachVersion(project.partStore, part.id, version);

// ── the workspace: strays, a byte-identical copy, non-geometry, a nested corpus
await mkdir(join(WORK, 'out'), { recursive: true });
await mkdir(join(WORK, 'incoming'), { recursive: true });
await mkdir(join(WORK, 'nested', 'cad-data', 'versions', 'v001'), { recursive: true });
await writeFile(join(WORK, 'out', 'disk-7mm.stl'), cubeStl(7));                 // unregistered
await writeFile(join(WORK, 'out', 'copy-of-version.stl'), registeredStl);       // registered bytes → silent
await writeFile(join(WORK, 'out', 'old-reference.stl'), cubeStl(6));           // older than every version
await copyFile(join(FIX, 'colored.step'), join(WORK, 'incoming', 'part.step'));
await copyFile(join(FIX, 'plate-two.3mf'), join(WORK, 'incoming', 'plate.3mf'));
await copyFile(join(FIX, 'profile-mm.dxf'), join(WORK, 'incoming', 'profile.dxf'));
await writeFile(join(WORK, 'incoming', 'notes.txt'), 'not geometry');
await writeFile(join(WORK, 'nested', 'cad-data', 'versions', 'v001', 'model.stl'), cubeStl(3));
await writeFile(join(WORK, 'nested', 'other.stl'), cubeStl(4));                 // another project's file → skipped
// Explicit mtimes: "newer than the newest version" is a millisecond comparison,
// and a file written in the SAME millisecond as the version is not newer. The
// test pins the boundary instead of hoping the clock cooperates.
const future = new Date(Date.now() + 60_000);
for (const rel of ['out/disk-7mm.stl', 'incoming/part.step', 'incoming/plate.3mf', 'incoming/profile.dxf']) {
  utimesSync(join(WORK, rel), future, future);
}
const past = new Date('2000-01-01T00:00:00Z');
utimesSync(join(WORK, 'out', 'old-reference.stl'), past, past);

// The scan judges against manifest ENTRIES (id + timestamp), not bare ids.
const versions = await listVersions(project.store);
const scan = await scanUnregistered({ project, workspace: WORK, scanPaths: ['.'], versions });
const paths = scan.files.map((f) => f.path).sort();
console.log(`      scanned=${scan.scanned} files=${paths.join(', ')}`);

check(paths.join(',') === ['incoming/part.step', 'incoming/plate.3mf', 'incoming/profile.dxf', 'out/disk-7mm.stl', 'out/old-reference.stl'].sort().join(','),
  'the scan lists the five strays and nothing else', paths.join(', '));
check(!paths.includes('out/copy-of-version.stl'),
  'a byte-identical copy of a registered mesh is NOT flagged (accounting is by hash, not name)');
check(!paths.some((p) => p.startsWith('nested/')),
  "another project's corpus (a nested cad-data/) is not judged by this one");
check(!paths.some((p) => p.endsWith('.txt')), 'non-geometry files are ignored');
const byPath = Object.fromEntries(scan.files.map((f) => [f.path, f]));
check(byPath['out/disk-7mm.stl']?.severity === 'blocked' && byPath['out/old-reference.stl']?.severity === 'warn',
  'a file NEWER than the newest version is blocked; an older one only warns',
  `${byPath['out/disk-7mm.stl']?.severity} / ${byPath['out/old-reference.stl']?.severity}`);
check(byPath['incoming/part.step']?.format === 'step' && byPath['incoming/part.step']?.importable === true
  && byPath['incoming/part.step']?.previewable === true, 'STEP is importable and previewable', JSON.stringify(byPath['incoming/part.step']));
check(byPath['incoming/plate.3mf']?.format === '3mf' && byPath['incoming/plate.3mf']?.previewable === true,
  '3MF is previewable', JSON.stringify(byPath['incoming/plate.3mf']));
check(byPath['incoming/profile.dxf']?.importable === true && byPath['incoming/profile.dxf']?.previewable === false,
  'DXF is importable but NOT previewable (a profile needs depthMm before it is a body)',
  JSON.stringify(byPath['incoming/profile.dxf']));

// ── exemptions are declared, echoed, and never silently swallowed
const exempted = await scanUnregistered({
  project, workspace: WORK, scanPaths: ['.'], versions,
  exempt: [{ path: 'out/disk-7mm.stl', reason: 'reference geometry, never delivered' },
    { path: 'gone/missing.stl', reason: 'stale declaration' }],
});
check(exempted.files.length === 4 && !exempted.files.some((f) => f.path === 'out/disk-7mm.stl'),
  'a declared exemption removes the file from the blocked list', `${exempted.files.length} left`);
check(exempted.exempt.some((e) => e.path === 'out/disk-7mm.stl' && /reference geometry/.test(e.reason)),
  'the exemption and its reason are echoed back', JSON.stringify(exempted.exempt));
check(exempted.missingExempt.some((e) => e.path === 'gone/missing.stl'),
  'an exemption naming a nonexistent path is reported as stale', JSON.stringify(exempted.missingExempt));

// ── the panel list IS the audit list (one implementation, two readers)
const audit = await auditDelivery(project, { scanPaths: ['.'], workspace: WORK });
const auditPaths = audit.unregistered.files.map((f) => f.path).sort();
check(auditPaths.join(',') === paths.join(','),
  'delivery_audit reports the SAME file list the panel route would', `${auditPaths.join(', ')} vs ${paths.join(', ')}`);

// ── the workspace guard: preview never reads outside the session
const OUTSIDE = await mkdtemp(join(tmpdir(), 'cad-unreg-outside-'));
await writeFile(join(OUTSIDE, 'secret.stl'), cubeStl(5));
// A real file just outside the workspace, so the refusal is the CONTAINMENT
// check and not a "file not found" (both are refusals; only one is the guard).
const SIBLING = join(dirname(WORK), `cad-unreg-sibling-${Date.now()}.stl`);
await writeFile(SIBLING, cubeStl(5));

const inside = await resolveWorkspaceFile('out/disk-7mm.stl', WORK);
check(inside.startsWith(WORK), 'a workspace-relative path resolves inside', inside);
let outsideMsg = '';
try { await resolveWorkspaceFile(join('..', SIBLING.slice(dirname(WORK).length + 1)), WORK); } catch (e) { outsideMsg = String(e?.message ?? e); }
check(/outside this session's workspace/.test(outsideMsg), 'a ../ escape is refused', outsideMsg || '(no error)');

await symlink(join(OUTSIDE, 'secret.stl'), join(WORK, 'link-out.stl'));
let linkMsg = '';
try { await resolveWorkspaceFile('link-out.stl', WORK); } catch (e) { linkMsg = String(e?.message ?? e); }
check(/outside this session's workspace/.test(linkMsg),
  'a symlink pointing outside the workspace is refused (realpath, not a string prefix)', linkMsg || '(no error)');

// ── preview tessellates; import policy does NOT apply
const stl = await previewGeometry({ file: 'out/disk-7mm.stl', cwd: WORK });
check(stl.solid && stl.triangles === 12 && Math.abs(stl.boundingBoxMm.size[0] - 7) < 0.01 && stl.unitsMm === false,
  'an STL previews with its own numbers and says the unit is the file\'s, not mm',
  `solid=${stl.solid} tris=${stl.triangles} size=${stl.boundingBoxMm.size[0]} unitsMm=${stl.unitsMm}`);

const plate = await previewGeometry({ file: 'incoming/plate.3mf', cwd: WORK });
check(plate.shells === 2 && plate.boundingBoxMm.size[0] > 29,
  'a two-object 3MF PREVIEWS (2 bodies) although import refuses it — preview is not import',
  `shells=${plate.shells} size=${plate.boundingBoxMm.size.map((v) => v.toFixed(1)).join('×')}`);

const step = await previewGeometry({ file: 'incoming/part.step', cwd: WORK });
// colored.step is the half-round screw fixture: 7.60 × 7.59 × 16.20 mm (the
// README's 242.2 mm³). Asserting the real fixture's size keeps this honest.
check(step.solid && step.unitsMm === true && Math.abs(step.boundingBoxMm.size[2] - 16.2) < 0.05,
  'a STEP previews in mm (the file declares its units; the worker folds them)',
  `solid=${step.solid} size=${step.boundingBoxMm.size.map((v) => v.toFixed(2)).join('×')}`);

let dxfMsg = '';
try { await previewGeometry({ file: 'incoming/profile.dxf', cwd: WORK }); } catch (e) { dxfMsg = String(e?.message ?? e); }
check(/DXF/.test(dxfMsg) && /depthMm/.test(dxfMsg), 'DXF preview names the depthMm route instead of failing vaguely', dxfMsg || '(no error)');

let outsidePreview = '';
try { await previewGeometry({ file: join(OUTSIDE, 'secret.stl'), cwd: WORK }); } catch (e) { outsidePreview = String(e?.message ?? e); }
check(/outside this session's workspace/.test(outsidePreview),
  'preview refuses an outside path before it reads anything', outsidePreview || '(no error)');

// ── preview never wrote to the corpus
const served = await readFile(join(project.root, 'versions', version, 'model.stl'));
check(served.equals(registeredStl), 'the registered version still holds exactly its own bytes (preview stores nothing)');

await rm(HOME, { recursive: true, force: true }).catch(() => {});
await rm(WORK, { recursive: true, force: true }).catch(() => {});
await rm(OUTSIDE, { recursive: true, force: true }).catch(() => {});
await rm(SIBLING, { force: true }).catch(() => {});
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
