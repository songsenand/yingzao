// Acceptance for external geometry import (import_part + src/host/import.ts).
//
// Guinea pig: a flange compiled ONCE by OpenSCAD, then handed over as a plain
// file — the "a colleague sent me their part" scenario — and assembled with a
// shaft this project generated itself.
//
// What this has to prove, in order:
//   1  a binary STL becomes a version that the EXISTING tools measure exactly
//      like a generated one (no special case anywhere downstream)
//   2  an ASCII STL of the same geometry normalizes to the same stored mesh
//   3  a broken mesh is REFUSED by default, and when forced in it is branded so
//      the geometric tools refuse it instead of reporting a fake number
//   4  imported + generated parts assemble: exact interference and clearance
//   5  declared datums make the imported part an INTERFACE ENDPOINT of the
//      assembly contract (the documented "stock parts cannot be endpoints"
//      limitation stops applying to anything that was imported)
//   6  units are a declaration: mm vs inch is exactly 25.4x, and both are recorded
//   7  re-importing a revised export is a REVISION of the same part, and
//      crossing parts is refused rather than silently stitched
//   8  the browse tree says where the version came from
//   9  STEP gets an actionable kernel-boundary answer, not a parse error
//
//   node scripts/accept-import.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { compileStlOnly } from '../src/host/compile.ts';
import { importGeometry, normalizeDatums } from '../src/host/import.ts';
import { parseBinaryStl, writeBinaryStl, detectStlFormat } from '../src/host/mesh.ts';
import { openVersionStore, readVersionEntry, saveVersion, listVersions } from '../src/host/version.ts';
import { openPartStore, ensurePart, readPartManifest } from '../src/host/parts.ts';
import { projectStores } from '../src/host/project.ts';
import { measureVersion } from '../src/host/inspect.ts';
import { validateAssembly } from '../src/host/assembly.ts';
import { runAssemblyCheck } from '../src/host/assembly-check.ts';
import { saveAssemblyManifest } from '../src/host/manifest.ts';
import { buildProducts } from '../src/host/products.ts';
import { cadToolNames, registerCadTools } from '../src/host/tools.ts';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

// Isolate the corpus: the tool resolves its project store from $DSH_HOME, and an
// acceptance run must never write into the developer's real one.
const HOME = await mkdtemp(join(tmpdir(), 'cad-import-home-'));
process.env.DSH_HOME = HOME;
const WORK = await mkdtemp(join(tmpdir(), 'cad-import-work-'));
// The "project directory" — where a colleague's file lands.
const PROJ = join(WORK, 'partner-handoff');
await mkdir(PROJ, { recursive: true });

// ---------- the host a tool call sees ----------
// Enough of the cordis surface for registerCadTools: a tool registry and the
// attachment channel. No `connection`, so the browser routes stay unregistered
// (and the panel half is not under test here).
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
    // The telemetry observer hooks `llm/stream` at registration time; it is
    // irrelevant here, but the surface has to exist for the tools to register.
    on: () => () => {},
  };
  registerCadTools(ctx, {});
  return { defs, images };
}

const host = fakeHost();
const importTool = host.defs.get('import_part');
const exec = { agent: { session: { header: { cwd: PROJ } } } };
const corpus = projectStores(PROJ);
const store = openVersionStore(corpus.root);
const partStore = openPartStore(corpus.root);

// ---------- fixtures: geometry as files, the way a hand-off arrives ----------

const flangeScad = `difference() {
  cylinder(h=8, d=60, $fn=64);
  translate([0,0,-1]) cylinder(h=10, d=12, $fn=64);
}`;
const flange = await compileStlOnly(flangeScad);
if (!flange.success || !flange.stl) throw new Error(`fixture compile failed: ${flange.errors.join('; ')}`);
await writeFile(join(PROJ, 'flange.stl'), flange.stl);

/** The same triangles, written the other way round — plenty of exports are ASCII. */
function toAsciiStl(mesh) {
  const v = mesh.vertProperties;
  const lines = ['solid flange'];
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (const i of [mesh.triVerts[t] * 3, mesh.triVerts[t + 1] * 3, mesh.triVerts[t + 2] * 3]) {
      lines.push(`      vertex ${v[i]} ${v[i + 1]} ${v[i + 2]}`);
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid flange');
  return Buffer.from(lines.join('\n'), 'utf8');
}
await writeFile(join(PROJ, 'flange-ascii.stl'), toAsciiStl(parseBinaryStl(flange.stl)));

// A mesh with one facet missing: the classic "someone deleted a face" export.
{
  const m = parseBinaryStl(flange.stl);
  const cut = { vertProperties: m.vertProperties, triVerts: m.triVerts.slice(0, m.triVerts.length - 3) };
  await writeFile(join(PROJ, 'broken.stl'), writeBinaryStl(cut, 'broken fixture'));
}

// A B-rep file: only the extension matters, we never parse it.
await writeFile(join(PROJ, 'bearing.step'), Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\n', 'utf8'));
await writeFile(join(PROJ, 'widget.3mf'), Buffer.from('PK\u0003\u0004not really', 'binary'));

const shaOf = async (p) => createHash('sha256').update(new Uint8Array(await readFile(p))).digest('hex');

// ---------- 1. binary STL → a version the existing tools measure ----------
const vRef = await saveVersion(store, { scadCode: flangeScad, stl: flange.stl, userIntent: '参照件: 同一几何走生成路径' });
const r1 = await importTool.execute({
  file: 'flange.stl',
  part: '法兰',
  userIntent: '导入自同事的 flange.stl',
  datums: [{ name: '内孔', kind: 'cylinder', point: [0, 0, 4], dir: [0, 0, 1], radius: 6 }],
}, exec);

check('1a version created under the declared part', typeof r1.versionId === 'string' && r1.part === '法兰', `${r1.versionId} / ${r1.part}`);
check('1b read as a closed solid', r1.solid === true && r1.watertight === true, `solid=${r1.solid} watertight=${r1.watertight}`);
check('1c format detected as binary', r1.format === 'stl-binary', r1.format);
check('1d genus 1 (one through bore)', r1.genus === 1, `genus=${r1.genus}`);
check('1e size in mm (not inches)', Math.abs(r1.sizeMm[0] - 60) < 0.01 && Math.abs(r1.sizeMm[2] - 8) < 0.01, JSON.stringify(r1.sizeMm));
check('1f four views rendered into the conversation', r1.views.length === 4 && host.images.length >= 4,
  `views=${r1.views.join(',')} images=${host.images.length}`);

// The point of the whole exercise: the SAME numbers as a generated part.
{
  const imported = await measureVersion(store, r1.versionId);
  const reference = await measureVersion(store, vRef);
  const same = imported.volumeMm3 === reference.volumeMm3
    && imported.triangles === reference.triangles
    && imported.genus === reference.genus
    && imported.boundingBoxMm.size.every((v, i) => v === reference.boundingBoxMm.size[i]);
  check('1g measured identically to the generated reference', same,
    `imported vol=${imported.volumeMm3} ref vol=${reference.volumeMm3}`);
}

// Provenance: no source code, but a checkable fingerprint.
{
  const dir = join(corpus.root, 'versions', r1.versionId);
  const hasScad = await readFile(join(dir, 'model.scad')).then(() => true, () => false);
  const hasStl = await readFile(join(dir, 'model.stl')).then(() => true, () => false);
  const prov = JSON.parse(await readFile(join(dir, 'import.json'), 'utf8'));
  check('1h imported version has no model.scad, has model.stl', !hasScad && hasStl, `scad=${hasScad} stl=${hasStl}`);
  check('1i provenance records the file fingerprint', prov.sha256 === await shaOf(join(PROJ, 'flange.stl')) && prov.unit === 'mm' && prov.scale === 1,
    `sha256=${String(prov.sha256).slice(0, 12)}… unit=${prov.unit} scale=${prov.scale}`);
  const datums = JSON.parse(await readFile(join(dir, 'datums.json'), 'utf8'));
  check('1j declared datum stored in the canonical shape',
    datums.cylinders?.length === 1 && datums.cylinders[0].name === '内孔' && datums.cylinders[0].radius === 6,
    JSON.stringify(datums.cylinders));
}

// ---------- 2. ASCII STL of the same geometry ----------
{
  const r2 = await importTool.execute({ file: 'flange-ascii.stl', part: '法兰副本', render: false }, exec);
  check('2a ASCII detected', r2.format === 'stl-ascii', r2.format);
  const a = new Uint8Array(await readFile(join(corpus.root, 'versions', r1.versionId, 'model.stl')));
  const b = new Uint8Array(await readFile(join(corpus.root, 'versions', r2.versionId, 'model.stl')));
  // Compare from byte 80 on: the 80-byte header names the source file, everything
  // that is geometry (triangle count + facets) must be byte-identical.
  check('2b normalizes to the identical stored mesh', Buffer.compare(Buffer.from(a.subarray(80)), Buffer.from(b.subarray(80))) === 0,
    `triangles ${r1.triangles} / ${r2.triangles}, volume ${r1.volumeMm3} / ${r2.volumeMm3}`);
  check('2c detectStlFormat is not fooled by a header', detectStlFormat(flange.stl) === 'binary', detectStlFormat(flange.stl));
}

// ---------- 3. a broken mesh is refused, and branded when forced in ----------
{
  let msg = null;
  try {
    await importTool.execute({ file: 'broken.stl', part: '坏件', render: false }, exec);
  } catch (e) { msg = String(e?.message ?? e); }
  check('3a refused by default with an actionable diagnostic',
    !!msg && /not a closed solid/.test(msg) && /\d+ edge/.test(msg), (msg ?? '(no error)').slice(0, 90));

  const r3 = await importTool.execute({ file: 'broken.stl', part: '坏件', render: false, allowNonSolid: true }, exec);
  check('3b allowNonSolid stores it, branded', r3.solid === false && r3.warnings.some((w) => /NOT A SOLID/.test(w)),
    `solid=${r3.solid}`);

  const brokenStl = new Uint8Array(await readFile(join(corpus.root, 'versions', r3.versionId, 'model.stl')));
  let threw = false;
  try { await validateAssembly([{ name: 'broken', stl: brokenStl }]); } catch { threw = true; }
  check('3c geometric tools refuse it instead of reporting a number', threw, threw ? 'validate_assembly threw' : 'gave an answer');

  // Inside-out winding closes the surface, so Manifold accepts it — but every
  // boolean against it returns the complement of what was meant. It must be
  // refused as loudly as a hole, not silently stored as a "solid".
  {
    const m = parseBinaryStl(flange.stl);
    const flipped = new Uint32Array(m.triVerts);
    for (let t = 0; t < flipped.length; t += 3) { const tmp = flipped[t + 1]; flipped[t + 1] = flipped[t + 2]; flipped[t + 2] = tmp; }
    await writeFile(join(PROJ, 'inside-out.stl'), writeBinaryStl({ vertProperties: m.vertProperties, triVerts: flipped }, 'inverted fixture'));
    let msg = null;
    try { await importTool.execute({ file: 'inside-out.stl', part: '翻面件', render: false }, exec); } catch (e) { msg = String(e?.message ?? e); }
    check('3d inside-out winding is refused, not stored as a solid',
      !!msg && /inside-out/.test(msg), (msg ?? '(no error)').slice(0, 80));
  }
}

// ---------- 4. imported + generated, checked as an assembly ----------
const flangeStl = new Uint8Array(await readFile(join(corpus.root, 'versions', r1.versionId, 'model.stl')));
async function generatedShaft(r) {
  const scad = `cylinder(r=${r}, h=30, $fn=64);\ndatum_cyl("轴径", [0,0,15], [0,0,1], ${r});`;
  const c = await compileStlOnly(scad);
  if (!c.success || !c.stl) throw new Error(`shaft compile failed: ${c.errors.join('; ')}`);
  return saveVersion(store, { scadCode: scad, stl: c.stl, userIntent: `轴 r=${r}`, datumSet: c.datumSet });
}
const vShaft4 = await generatedShaft(4.0);
const vShaft7 = await generatedShaft(7.0);
const stlOf = async (id) => new Uint8Array(await readFile(join(corpus.root, 'versions', id, 'model.stl')));

{
  const report = await validateAssembly([
    { name: 'flange', stl: flangeStl },
    { name: 'shaft', stl: await stlOf(vShaft4) },
  ]);
  const pair = report.pairs[0];
  check('4a clearance between imported flange and generated shaft ≈ 2.0mm',
    pair?.status === 'ok' && Math.abs(pair.minDistance - 2.0) < 0.05, `dist=${pair?.minDistance?.toFixed(3)} status=${pair?.status}`);
  check('4b assembly passes', report.overallStatus === 'pass', report.overallStatus);
}
{
  const report = await validateAssembly([
    { name: 'flange', stl: flangeStl },
    { name: 'shaft', stl: await stlOf(vShaft7) },
  ]);
  const pair = report.pairs[0];
  // r=7 shaft: the 1mm wall thickness over 8mm of flange — π(49−36)·8 ≈ 326.7mm³.
  check('4c oversize shaft interferes with the imported part (exact volume)',
    pair?.status === 'interference' && pair.intersectionVolume > 300 && pair.intersectionVolume < 350,
    `vol=${pair?.intersectionVolume?.toFixed(2)} status=${pair?.status}`);
}

// ---------- 5. the imported part as an interface endpoint ----------
{
  const asmDir = join(WORK, 'assembly');
  await mkdir(asmDir, { recursive: true });
  const manifestFor = (shaftVersion) => ({
    schemaVersion: 1,
    name: 'import-acceptance',
    unit: 'mm', up: 'z',
    root: {
      id: 'asm', name: '导入件装配', kind: 'assembly',
      interfaces: [{
        id: 'if-fit', a: 'flange.内孔', b: 'shaft.轴径',
        type: '紧固',
        nominal: { quantity: '直径', value: 4.0 },
        tolerance: { min: 3.9, max: 4.1 },
        severity: 'hard', layer: 'L0', check: 'diameter-match',
        note: 'Ø12 孔与 Ø8 轴的直径间隙',
      }],
      children: [
        { id: 'flange', name: '法兰', kind: 'part', version: r1.versionId, source: 'imported',
          datums: [{ name: '内孔', kind: 'cylinder' }] },
        { id: 'shaft', name: '轴', kind: 'part', version: shaftVersion, source: 'generated',
          datums: [{ name: '轴径', kind: 'cylinder' }] },
      ],
    },
  });

  const goodPath = join(asmDir, 'good.json');
  const badPath = join(asmDir, 'bad.json');
  await saveAssemblyManifest(goodPath, manifestFor(vShaft4));
  await saveAssemblyManifest(badPath, manifestFor(vShaft7));

  const good = await runAssemblyCheck(store, goodPath);
  const good1 = good.results.find((r) => r.interfaceId === 'if-fit');
  check('5a imported part resolves as a diameter-match endpoint',
    good1?.verdict === 'pass' && Math.abs(good1.measured - 4.0) < 1e-6,
    `verdict=${good1?.verdict} measured=${good1?.measured}`);

  const bad = await runAssemblyCheck(store, badPath);
  const bad1 = bad.results.find((r) => r.interfaceId === 'if-fit');
  check('5b wrong fit is a hard violation, not a warning',
    bad1?.verdict === 'hard-violation' && Math.abs(bad1.measured - (-2.0)) < 1e-6 && bad.overallStatus === 'fail',
    `verdict=${bad1?.verdict} measured=${bad1?.measured} status=${bad.overallStatus}`);
  check('5c imported part is NOT skipped as a stock part',
    !bad.results.some((r) => /stock part/.test(r.detail ?? '')), JSON.stringify(bad.results.map((r) => r.detail)));
}

// ---------- 6. units are a declaration ----------
{
  const mm = await importGeometry({ file: 'flange.stl', cwd: PROJ, unit: 'mm' });
  const inch = await importGeometry({ file: 'flange.stl', cwd: PROJ, unit: 'inch' });
  check('6a inch import is exactly 25.4³ the volume',
    Math.abs(inch.volumeMm3 / mm.volumeMm3 - 25.4 ** 3) < 1, `ratio=${(inch.volumeMm3 / mm.volumeMm3).toFixed(1)}`);
  check('6b the declaration is recorded, not inferred', inch.unit === 'inch' && inch.appliedScale === 25.4,
    `unit=${inch.unit} scale=${inch.appliedScale}`);
  check('6c size scales with it', Math.abs(inch.boundingBoxMm.size[0] - mm.boundingBoxMm.size[0] * 25.4) < 0.05,
    `${mm.boundingBoxMm.size[0]} → ${inch.boundingBoxMm.size[0]}`);
  let bad = null;
  try { await importGeometry({ file: 'flange.stl', cwd: PROJ, unit: 'furlong' }); } catch (e) { bad = String(e.message); }
  check('6d an unknown unit is refused', !!bad && /unknown unit/.test(bad), (bad ?? '').slice(0, 60));
}

// ---------- 7. a revised export is a revision, not a new part ----------
{
  const r7 = await importTool.execute({
    file: 'flange.stl', part: '法兰', parentVersion: r1.versionId, render: false,
    userIntent: '同事发来修订版导出',
  }, exec);
  const entry = await readVersionEntry(store, r7.versionId);
  const base = await readVersionEntry(store, r1.versionId);
  check('7a same part, parent points at the previous import',
    entry?.partId === base?.partId && entry?.parentVersion === r1.versionId && r7.versionId !== r1.versionId,
    `${r7.versionId} ← ${entry?.parentVersion}`);
  check('7b the fingerprint identifies the file', r7.sha256 === r1.sha256 && r7.sha256 === await shaOf(join(PROJ, 'flange.stl')),
    `${r7.sha256.slice(0, 12)}…`);

  let msg = null;
  try {
    await importTool.execute({ file: 'flange.stl', part: '另一个零件', parentVersion: r1.versionId, render: false }, exec);
  } catch (e) { msg = String(e?.message ?? e); }
  check('7c crossing parts is refused, never stitched', !!msg && /belongs to part/.test(msg), (msg ?? '(no error)').slice(0, 80));
}

// ---------- 8. the browse tree says where it came from ----------
{
  const versions = await listVersions(store);
  const tree = buildProducts(versions, (await readPartManifest(partStore)).parts, []);
  const mine = tree.parts.flatMap((p) => p.versions).find((v) => v.id === r1.versionId);
  const ref = tree.parts.flatMap((p) => p.versions).find((v) => v.id === vRef);
  check('8a imported version is labelled with its origin',
    mine?.source === 'imported' && mine?.origin === 'flange.stl', `${mine?.source} / ${mine?.origin}`);
  check('8b generated version stays generated', ref?.source === 'generated' && ref?.origin === undefined, `${ref?.source}`);
}

// ---------- 9. the kernel boundary is stated, not stumbled into ----------
{
  let msg = null;
  try { await importTool.execute({ file: 'bearing.step', part: '轴承' }, exec); } catch (e) { msg = String(e?.message ?? e); }
  check('9a STEP gets the B-rep boundary and a way forward',
    !!msg && /B-rep/.test(msg) && /STL/.test(msg) && /FreeCAD|export STL/.test(msg), (msg ?? '(no error)').slice(0, 90));

  let msg3mf = null;
  try { await importTool.execute({ file: 'widget.3mf', part: '零件' }, exec); } catch (e) { msg3mf = String(e?.message ?? e); }
  check('9b an unreadable format names what IS supported', !!msg3mf && /\.stl/.test(msg3mf), (msg3mf ?? '(no error)').slice(0, 70));
}

// ---------- 10. catalog ----------
check('10 import_part is part of the CAD catalog', cadToolNames().includes('import_part'), cadToolNames().join(','));
{
  const schema = importTool?.parameters ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  check('10b its parameters are published',
    !!schema.properties?.file && (required.includes('file') || schema.properties.file.required === true),
    Object.keys(schema.properties ?? {}).join(','));
}

// ---------- torn down ----------
await rm(HOME, { recursive: true, force: true }).catch(() => {});
await rm(WORK, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
