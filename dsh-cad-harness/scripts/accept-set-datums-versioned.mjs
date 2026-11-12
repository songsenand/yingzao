// Acceptance for "declaring anchors creates a version" (2026-10-23 audit, FIX-C4; user
// decision: new version, not an in-place edit).
//
// An anchor is what an assembly interface RESOLVES against. Rewriting `datums.json` in
// place therefore changes the meaning of every run that cited it — a run that measured
// "0.0 mm at 顶面" keeps its numbers while the anchor it named has moved. The fix is the
// same one the rest of the store already uses: history is immutable, changes are revisions.
//
// Hermetic, and needs NO Python/OpenSCAD: it stores bytes directly through saveVersion.
//
//   node scripts/accept-set-datums-versioned.mjs
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-seq-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-seq-work-'));
process.env.DSH_HOME = home;
await mkdir(join(workspace, 'cad-data'), { recursive: true });

const { registerCadTools } = await import('../src/host/tools.ts');
const { datumDriftForPart, datumNames, openVersionStore, saveVersion, readVersionDatums, listVersions } = await import('../src/host/version.ts');
const { openPartStore, ensurePart, attachVersion, listParts } = await import('../src/host/parts.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { id: 'set-datums-main', cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return { value: await def.execute(args, exec) };
};

// No default project: an explicit path is required before any CAD tool.
await call('bind_project', { dir: workspace });

// A saved version with a known byte pattern instead of a compiled mesh: set_datums copies
// bytes and never parses them, and this test is about the STORE, not geometry.
const store = openVersionStore(join(workspace, 'cad-data'));
const partStore = openPartStore(join(workspace, 'cad-data'));
const part = await ensurePart(partStore, '锚点测试件');
const STL = new Uint8Array([0x53, 0x54, 0x4c, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x21]);
const v1 = await saveVersion(store, {
  stl: STL, userIntent: 'cube 20', partId: part.id, datumSet: { points: [], axes: [], planes: [], cylinders: [] },
});
await attachVersion(partStore, part.id, v1);

// ── write mode: a new version ─────────────────────────────────────────────
const written = await call('set_datums', {
  versionId: v1,
  datums: [{ name: '顶面', kind: 'point', point: [20, 20, 20] }],
});
check(written.value.mode === 'versioned', 'write mode says "versioned"', written.value.mode);
check(written.value.versionId !== v1, 'the anchors live on a NEW version', `${v1} -> ${written.value.versionId}`);
check(written.value.previousVersionId === v1, 'and the reply names the version it read', written.value.previousVersionId);
const v2 = written.value.versionId;

const setNames = (set) => [...set.points, ...set.axes, ...set.planes, ...set.cylinders].map((d) => d.name);
check(setNames(await readVersionDatums(store, v1)).length === 0, 'the old version still declares nothing',
  setNames(await readVersionDatums(store, v1)).join(','));
check(setNames(await readVersionDatums(store, v2)).join(',') === '顶面', 'the new version carries the anchor',
  setNames(await readVersionDatums(store, v2)).join(','));

// A regeneration that forgets its datum() calls must not be silent: the helper
// names what would disappear, so generate_part can warn before the save.
const driftDrop = await datumDriftForPart(store, part.id, []);
check(driftDrop?.versionId === v2 && driftDrop.missing.includes('point:顶面'),
  'dropping every anchor names the last version that had them and what is missing',
  JSON.stringify(driftDrop));
const driftKeep = await datumDriftForPart(store, part.id, ['point:顶面']);
check(driftKeep === null, 'keeping the anchor reports no drift', JSON.stringify(driftKeep));
check(datumNames(await readVersionDatums(store, v2)).includes('point:顶面'), 'the comparison uses the same name form');

// The mesh is copied byte-for-byte: geometry is unchanged, so every measurement past the
// anchors still means the same thing.
const a = new Uint8Array(await readFile(join(workspace, 'cad-data', 'versions', v1, 'model.stl')));
const b = new Uint8Array(await readFile(join(workspace, 'cad-data', 'versions', v2, 'model.stl')));
check(a.length === STL.length && a.every((x, i) => x === STL[i]) && b.every((x, i) => x === STL[i]),
  'the mesh is identical in both versions (geometry untouched)');

const rows = (await listVersions(store)).filter((r) => r.id === v2);
check(rows.length === 1 && rows[0].parentVersion === v1, 'the index records the parent', JSON.stringify(rows[0] ?? {}));
check(rows.length === 1 && rows[0].partId === part.id, 'and the part identity follows', rows[0]?.partId);
const afterDatums = (await listParts(partStore)).find((p) => p.id === part.id);
check(afterDatums?.versionIds.includes(v2),
  'the anchor version is attached to the SAME part (parts manifest, not only the version index)',
  JSON.stringify(afterDatums?.versionIds));

// ── the old anchors stay addressable (history is intact) ──────────────────
const listedOld = await call('set_datums', { versionId: v1 });
check(listedOld.value.mode === 'list' && listedOld.value.datums.length === 0,
  'listing the OLD version does not show the new anchor');
const listedNew = await call('set_datums', { versionId: v2 });
check(listedNew.value.mode === 'list' && listedNew.value.datums.length === 1,
  'listing the NEW version does');

// ── a second declaration merges, and versions again ───────────────────────
const again = await call('set_datums', { versionId: v2, datums: [{ name: '底面', kind: 'point', point: [0, 0, 0] }] });
check(again.value.mode === 'versioned' && again.value.counts.points === 2,
  'a second declaration merges (union by name) onto a third version', JSON.stringify(again.value.counts));
check(again.value.previousVersionId === v2, 'and its parent is the second version');
const v3 = again.value.versionId;
const v3Datums = setNames(await readVersionDatums(store, v3)).sort().join(',');
check(v3Datums === '底面,顶面', 'the third version has both anchors', v3Datums);
check(setNames(await readVersionDatums(store, v2)).length === 1, 'and the second still has only its own');

// ── a metadata repair says what it just invalidated ───────────────────────
await writeFile(join(workspace, 'cad-data', 'versions', v3, 'visual-review.json'),
  JSON.stringify({ views: ['top', 'iso'], reviewedAt: new Date().toISOString() }));
const afterReview = await call('set_datums', {
  versionId: v3, datums: [{ name: '侧面', kind: 'point', point: [5, 0, 0] }],
});
const v4 = afterReview.value.versionId;
const reviewWarn = afterReview.value.warnings.find((w) => /visual review/.test(w)) ?? '';
check(/has none/.test(reviewWarn), 'an anchor edit warns that the old visual review does not carry over', reviewWarn);

// ── nothing was left in a scratch state ───────────────────────────────────
const verDirs = (await readdir(join(workspace, 'cad-data', 'versions'))).sort();
check(verDirs.join(',') === [v1, v2, v3, v4].sort().join(','), 'exactly four version directories exist', verDirs.join(','));
check((await stat(join(workspace, 'cad-data', 'versions', v3, 'model.stl'))).size === STL.length,
  'the third version has its mesh on disk');

await rm(home, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
