// Acceptance: whole-project export.
//
// The feature answers "give me the project", not "give me this revision":
//   * ZIP  = every part STL (newest, or the version the assembly pins) + the
//            assembly manifest + README (+ a placed assembly.stl);
//   * STL  = the assembly at its declared placements, as one multi-shell mesh.
//
// This pins the two things that are easy to get silently wrong: which revisions
// are chosen, and whether the placement transform actually reached the mesh.
//
//   node scripts/accept-project-export.mjs
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectStores } from '../src/host/project.ts';
import { parseStl, writeBinaryStl, boundingBox } from '../src/host/mesh.ts';
import {
  buildAssemblyStl, buildProjectZip, planProjectExport, projectExportReadme,
} from '../src/host/project-export.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const tmp = join(ROOT, `.tmp-project-export-${process.pid}`);

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A closed box as an indexed mesh. */
function boxMesh(size = 10, sy = size, sz = size) {
  const v = [];
  for (const x of [0, size]) for (const y of [0, sy]) for (const z of [0, sz]) v.push(x, y, z);
  const vertProperties = new Float32Array(v);
  // Six faces, two triangles each; winding is not load-bearing for a bbox test.
  const f = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return { vertProperties, triVerts: new Uint32Array(f) };
}

const json = (file, value) => writeFile(join(tmp, file), JSON.stringify(value, null, 2));

/** Read the subset of ZIP this writer produces, to prove the bytes open. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error('no end-of-central-directory');
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  let off = centralOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) throw new Error('bad central header');
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLength = view.getUint16(off + 28, true);
    const extraLength = view.getUint16(off + 30, true);
    const commentLength = view.getUint16(off + 32, true);
    const localOffset = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLength));
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compSize);
    entries.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    off += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

try {
  await mkdir(join(tmp, 'cad-data/versions/v001'), { recursive: true });
  await mkdir(join(tmp, 'cad-data/versions/v002'), { recursive: true });
  await mkdir(join(tmp, 'cad-data/versions/v003'), { recursive: true });
  await mkdir(join(tmp, 'cad-data/parts'), { recursive: true });
  await mkdir(join(tmp, 'assembly'), { recursive: true });

  await json('cad-data/project.json', { schemaVersion: 1, cwd: tmp });
  await json('cad-data/manifest.json', {
    versions: [
      { id: 'v001', timestamp: '2026-01-01T00:00:00.000Z', userIntent: 'A', parentVersion: null, partId: 'p001', status: 'draft' },
      { id: 'v002', timestamp: '2026-01-02T00:00:00.000Z', userIntent: 'B', parentVersion: null, partId: 'p002', status: 'draft' },
      { id: 'v003', timestamp: '2026-01-03T00:00:00.000Z', userIntent: 'A newer draft', parentVersion: 'v001', partId: 'p001', status: 'draft' },
    ],
  });
  await json('cad-data/parts/manifest.json', {
    schemaVersion: 1,
    parts: [
      { id: 'p001', name: 'A', nameSource: 'agent', createdAt: '', lastActiveAt: '2026-01-03T00:00:00.000Z', versionIds: ['v001', 'v003'] },
      { id: 'p002', name: 'B', nameSource: 'agent', createdAt: '', lastActiveAt: '2026-01-02T00:00:00.000Z', versionIds: ['v002'] },
    ],
  });
  await writeFile(join(tmp, 'cad-data/versions/v001/model.stl'), writeBinaryStl(boxMesh()));
  await writeFile(join(tmp, 'cad-data/versions/v003/model.stl'), writeBinaryStl(boxMesh()));
  // v002 is a 20x10x10 box with a feature-axis pose: 90 deg about z, then +50 in y.
  await writeFile(join(tmp, 'cad-data/versions/v002/model.stl'), writeBinaryStl(boxMesh(20, 10, 10)));
  await json('cad-data/versions/v002/datums.json', {
    points: [], planes: [], cylinders: [],
    axes: [{ name: 'z-axis', point: [0, 0, 0], dir: [0, 0, 1] }],
  });
  await json('assembly/assembly.json', {
    schemaVersion: 1,
    name: '测试装配',
    unit: 'mm',
    up: 'z',
    root: {
      id: 'root', name: '测试装配', kind: 'assembly',
      children: [
        { id: 'a1', name: 'A', kind: 'part', version: 'v001', transform: { translate: [100, 0, 0] } },
        // Same version twice: one file, two placed instances.
        { id: 'a2', name: 'A', kind: 'part', version: 'v001', transform: { translate: [0, 0, 100] } },
        {
          id: 'b', name: 'B', kind: 'part', version: 'v002',
          transform: { translate: [0, 50, 0], pose: { datum: 'z-axis', angleDeg: 90 } },
        },
      ],
    },
  });

  const project = projectStores(tmp);
  const plan = await planProjectExport(project);

  // ---- revision selection ---------------------------------------------------
  check(plan.files.length === 2, 'two distinct versions are shipped', `${plan.files.length}`);
  check(plan.instances.length === 3, 'all three placed instances are in the assembly', `${plan.instances.length}`);
  check(!plan.files.some((f) => f.versionId === 'v003'),
    'the assembly pins v001, so a newer unassembled draft is NOT silently shipped');
  check(plan.files.some((f) => f.versionId === 'v001') && plan.files.some((f) => f.versionId === 'v002'),
    'the pinned versions are shipped');
  check(plan.manifestText !== null && plan.manifestHash !== null, 'the manifest travels with the export');

  // ---- placement reached the mesh ------------------------------------------
  const assembly = buildAssemblyStl(plan);
  const box = boundingBox(parseStl(assembly).mesh);
  check(Math.abs(box.min[0] + 10) < 1e-4 && Math.abs(box.min[1]) < 1e-4 && Math.abs(box.min[2]) < 1e-4
    && Math.abs(box.max[0] - 110) < 1e-4 && Math.abs(box.max[1] - 70) < 1e-4
    && Math.abs(box.max[2] - 110) < 1e-4,
    'translate and feature-axis pose reached the mesh: bbox is [-10,0,0]..[110,70,110]', JSON.stringify(box));

  // ---- ZIP opens, names and contents are complete ---------------------------
  const zipBytes = await buildProjectZip(plan);
  check(zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, 'ZIP magic PK is present');
  const entries = readZip(zipBytes);
  const names = [...entries.keys()];
  check(names.includes('parts/A_v001.stl') && names.includes('parts/B_v002.stl'),
    'part files are named by part + version', names.filter((n) => n.startsWith('parts/')).join(', '));
  check(names.includes('assembly/assembly.json'), 'the manifest is at assembly/assembly.json');
  check(names.includes('assembly.stl'), 'the placed assembly travels inside the ZIP');
  check(names.includes('README.txt'), 'the README travels inside the ZIP');
  const readme = new TextDecoder().decode(entries.get('README.txt'));
  check(readme.includes('毫米（mm）') && readme.includes('A（v001）'),
    'README states units and lists the shipped revisions');
  const firstPart = new TextDecoder('latin1').decode(entries.get('parts/A_v001.stl').subarray(0, 5));
  check(!firstPart.toLowerCase().startsWith('solid'), 'part STLs stay binary (no accidental ASCII conversion)');

  // ---- a project without a manifest still exports parts --------------------
  const bare = join(tmp, 'bare');
  await mkdir(join(bare, 'cad-data/versions/v001'), { recursive: true });
  await mkdir(join(bare, 'cad-data/parts'), { recursive: true });
  await writeFile(join(bare, 'cad-data/versions/v001/model.stl'), writeBinaryStl(boxMesh()));
  await writeFile(join(bare, 'cad-data/versions/v001/model.scad'), 'cube(10);\n');
  await writeFile(join(bare, 'cad-data/manifest.json'), JSON.stringify({
    versions: [{ id: 'v001', timestamp: '2026-01-01T00:00:00.000Z', userIntent: 'A', parentVersion: null, partId: 'p001', status: 'draft' }],
  }));
  await writeFile(join(bare, 'cad-data/parts/manifest.json'), JSON.stringify({
    schemaVersion: 1,
    parts: [{ id: 'p001', name: 'A', nameSource: 'agent', createdAt: '', lastActiveAt: '', versionIds: ['v001'] }],
  }));
  const barePlan = await planProjectExport(projectStores(bare));
  check(barePlan.files.length === 1 && barePlan.instances.length === 0,
    'without a manifest the newest revision of each part is exported, unplaced');
  let refused = '';
  try { buildAssemblyStl(barePlan); } catch (e) { refused = String(e.message); }
  check(refused.includes('assembly.json'), 'assembly STL refuses rather than stacking every part at the origin', refused);

  // ---- README is honest about omissions ------------------------------------
  check(!projectExportReadme(plan).includes('未导出：'), 'a complete project has no omission section');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
