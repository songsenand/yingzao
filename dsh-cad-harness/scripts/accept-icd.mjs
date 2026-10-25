// Acceptance for the ICD half of the assembly manifest (2026-10-25).
//
// Two things a contract needs that a measurement table does not have:
//   1. the REQUIREMENT must travel with the verdict (tolerance + nominal), or the
//      panel renders a 要求 column full of "—";
//   2. the CONTRACT needs an identity (a content hash), or "which revision did
//      this check audit?" is unanswerable and a re-check silently replaces the
//      old verdict.
//
// Pure TypeScript path (no python worker): runAssemblyCheckInTs + the pointer
// writer. The worker path attaches the same `expected` from the same helper; that
// one line is covered by accept-assembly (which needs the runtime).
//
//   node scripts/accept-icd.mjs
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { openVersionStore, saveVersion } = await import('../src/host/version.ts');
const { saveAssemblyManifest, loadAssemblyManifest } = await import('../src/host/manifest.ts');
const { runAssemblyCheckInTs, saveAssemblyCheckPointer } = await import('../src/host/assembly-check.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A closed 1×1×1 cube as ASCII STL — a mesh is required even for a point check. */
function cubeStl(origin = [0, 0, 0]) {
  const [x, y, z] = origin;
  const v = (dx, dy, dz) => [x + dx, y + dy, z + dz];
  const p = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const lines = ['solid cube'];
  for (const [a, b, c] of faces) {
    lines.push('facet normal 0 0 0', 'outer loop');
    for (const i of [a, b, c]) lines.push(`vertex ${p[i].join(' ')}`);
    lines.push('endloop', 'endfacet');
  }
  lines.push('endsolid cube');
  return new TextEncoder().encode(lines.join('\n'));
}

const tmp = join(ROOT, `.tmp-icd-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
const store = openVersionStore(tmp);

const v1 = await saveVersion(store, {
  scadCode: 'cube(1);', stl: cubeStl(), userIntent: '方块',
  datumSet: { points: [{ name: 'A', point: [0, 0, 0] }, { name: 'B', point: [0, 0, 2] }], axes: [], planes: [], cylinders: [] },
});

const manifest = (extra = {}) => ({
  schemaVersion: 1, name: 'icd-test', unit: 'mm', up: 'z',
  root: {
    id: 'm', kind: 'assembly',
    interfaces: [
      {
        id: 'I1', a: 'p.A', b: 'p.B', type: '间距', severity: 'hard', check: 'distance',
        nominal: { quantity: '距离', value: 2 }, tolerance: { min: 1.9, max: 2.1 }, note: '两点相距 2mm',
      },
      {
        // No tolerance = no criterion. It must NOT become a pass, and it must not
        // invent a requirement either.
        id: 'I2', a: 'p.A', b: 'p.B', type: '间距', severity: 'hard', check: 'distance',
      },
    ],
    children: [{ id: 'p', name: '方块', kind: 'part', version: v1 }],
    ...extra,
  },
});

try {
  const path = join(tmp, 'assembly', 'assembly.json');
  await mkdir(dirname(path), { recursive: true });
  await saveAssemblyManifest(path, manifest());

  const report = await runAssemblyCheckInTs(store, path);

  check(/^[0-9a-f]{8}$/.test(report.manifestHash ?? ''), 'the report carries the manifest hash', String(report.manifestHash));
  const i1 = report.results.find((r) => r.interfaceId === 'I1');
  check(i1?.verdict === 'pass' && i1?.measured === 2, 'the declared interface passes at 2mm', `${i1?.verdict} @ ${i1?.measured}`);
  check(
    i1?.expected?.min === 1.9 && i1.expected.max === 2.1
    && i1.expected.nominal === 2 && i1.expected.quantity === '距离',
    'the requirement travels with the verdict (tolerance + nominal + unit)',
    JSON.stringify(i1?.expected),
  );
  const i2 = report.results.find((r) => r.interfaceId === 'I2');
  check(i2?.verdict === 'skipped', 'no tolerance is skipped, never a pass', String(i2?.verdict));
  check(i2?.expected === undefined, 'and no requirement is invented for it', JSON.stringify(i2?.expected));

  // Revision identity: the same bytes keep the id, any edit changes it.
  const same = await loadAssemblyManifest(path);
  check(same.manifestHash === report.manifestHash, 'the same file re-reads with the same id');
  const edited = manifest({ interfaces: undefined });
  const editedPath = join(tmp, 'assembly', 'assembly.edited.json');
  await saveAssemblyManifest(editedPath, {
    ...manifest(),
    root: { ...manifest().root, note: '改了一个字' },
  });
  const other = await loadAssemblyManifest(editedPath);
  check(other.manifestHash !== report.manifestHash, 'a one-field edit yields a different id', `${report.manifestHash} vs ${other.manifestHash}`);

  // The pointer next to the manifest must be able to answer "which contract?".
  await saveAssemblyCheckPointer(path, {
    runId: 'r001', checkedAt: report.checkedAt, manifestPath: path,
    manifestHash: report.manifestHash, schema: 'assembly-check-pointer/v1',
  });
  const pointer = JSON.parse(await readFile(join(tmp, 'assembly', 'assembly-check-report.json'), 'utf8'));
  check(pointer.manifestHash === report.manifestHash && pointer.runId === 'r001', 'the pointer names the run AND the contract id', JSON.stringify({ runId: pointer.runId, hash: pointer.manifestHash }));
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
