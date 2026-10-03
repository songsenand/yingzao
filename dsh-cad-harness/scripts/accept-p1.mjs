// Acceptance for the P1 items in verification/microscope2-audit.md, driven
// through the REAL tool objects (registerCadTools → execute → finalizeContent).
//
//   P1-4  part names were ASCII-only (`unsafe part name: 底座`), the error said
//         nothing about the rule, and the check happened after the run directory
//         was made — leaving orphan runs/r004 with no index entry. Fixed: names
//         may be any language, checked before anything is created, and run
//         directories are created lazily.
//   P1-5  no way to make one rigid body out of N placed parts (the microscope2
//         session hand-unioned 16 STLs in OpenSCAD for 2.5 minutes and filed an
//         83 MB fake part). Fixed: `merge_parts`.
//   P1-6  no way to ask a version what anchors it declares. Fixed: `set_datums`
//         in list mode — the input you need to write interfaces.
//   P1-7  an added datum cost a whole new version. Fixed: `set_datums` writes
//         anchors onto the existing version.
//   P1-8  runs had no lifecycle. Fixed: a run records a `subject`, and a newer
//         run about the same subject marks the older one `supersededBy`.
//
// Hermetic: DSH_HOME points at a temp dir; nothing real is read or written.

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-p1-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-p1-work-'));
process.env.DSH_HOME = home;

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { compileStlOnly } = await import('../src/host/compile.ts');

const tools = new Map();
const savedImages = [];
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: {
    saveImages: async (items) => items.map((it) => {
      savedImages.push({ name: it.name, bytes: it.data.length });
      return { kind: 'stub-attachment', name: it.name };
    }),
  },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);

const exec = { agent: { session: { header: { cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  const value = await def.execute(args, exec);
  const blocks = def.finalizeContent ? def.finalizeContent(exec, { value }) : null;
  return { value, blocks };
};
const textOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const imagesOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'image');
const exists = async (p) => { try { await readFile(p); return true; } catch { return false; } };

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const project = projectStores(workspace);
const runsDir = join(project.root, 'runs');
const runDirs = async () => {
  try { return (await readdir(runsDir)).filter((n) => /^r\d+$/.test(n)).sort(); } catch { return []; }
};
const runManifest = async () => JSON.parse(await readFile(join(runsDir, 'manifest.json'), 'utf8'));

// ---------- corpus: two touching boxes, one WITHOUT any datum ----------

const store = project.store;
const lower = await compileStlOnly('cube([40,40,20]);\ndatum("顶面", [20,20,20]);');
const upper = await compileStlOnly('cube([20,20,20]);');
if (!lower.success || !upper.success) { console.error('FAIL: fixtures did not compile'); process.exit(1); }

const vLower = await saveVersion(store, {
  scadCode: 'cube([40,40,20]);', stl: lower.stl, userIntent: 'P1 fixture: 底座', datumSet: lower.datumSet,
});
const vUpper = await saveVersion(store, {
  scadCode: 'cube([20,20,20]);', stl: upper.stl, userIntent: 'P1 fixture: 立柱 (无锚点)',
});

// ================= P1-4: names, the error message, and no orphan ============

console.log('\n--- P1-4  part names + no orphan run dir ---');
const before = (await runDirs()).length;

let badName = null;
try {
  await call('validate_assembly', {
    parts: [{ name: 'a/b', versionId: vLower }, { name: 'ok', versionId: vUpper }],
  });
} catch (e) { badName = String(e?.message ?? e); }
check('a path separator in a part name is refused', !!badName, (badName ?? '').split('\n')[0]);
check('  …and the message states the rule, not just "unsafe"',
  !!badName && /path separator/.test(badName) && /non-empty/.test(badName));
check('  …and nothing was created on disk (no orphan run dir)',
  (await runDirs()).length === before, `${before} → ${(await runDirs()).length} dirs`);

let dupName = null;
try {
  await call('validate_assembly', {
    parts: [{ name: 'same', versionId: vLower }, { name: 'same', versionId: vUpper }],
  });
} catch (e) { dupName = String(e?.message ?? e); }
check('duplicate part names are refused before anything is created',
  !!dupName && (await runDirs()).length === before, dupName ?? '(no error)');

const cn = await call('validate_assembly', {
  clearanceThreshold: 0.75,
  parts: [{ name: '底座', versionId: vLower }, { name: '立柱', versionId: vUpper, translate: [0, 0, 20] }],
});
check('Chinese part names now work end to end',
  cn.value.pairs.length === 1 && imagesOf(cn.blocks).length === 3,
  `status=${cn.value.overallStatus}`);
const cnRun = (await runManifest()).runs.at(-1);
check('  …and the run stores the part under its own name',
  JSON.stringify(cnRun.parts) === JSON.stringify(['底座', '立柱']), JSON.stringify(cnRun.parts));
check('  …and the Chinese-named STL is really on disk',
  await exists(join(runsDir, cnRun.id, 'parts', '底座.stl')));

// ================= P1-8: run lifecycle =====================================

console.log('\n--- P1-8  run lifecycle (subject → supersede) ---');
const again = await call('validate_assembly', {
  clearanceThreshold: 0.75,
  parts: [{ name: '底座', versionId: vLower }, { name: '立柱', versionId: vUpper, translate: [0, 0, 20] }],
});
const againRun = (await runManifest()).runs.at(-1);
const firstRun = (await runManifest()).runs.find((r) => r.id === cnRun.id);
check('a repeat of the same part set supersedes the previous run',
  firstRun?.supersededBy === againRun.id, `${cnRun.id}.supersededBy=${firstRun?.supersededBy}`);
check('  …the new run lists what it replaced',
  JSON.stringify(againRun.supersedes) === JSON.stringify([cnRun.id]), JSON.stringify(againRun.supersedes));
check('  …the old run is still on disk and still readable',
  await exists(join(runsDir, cnRun.id, 'run.json')));

const other = await call('validate_assembly', {
  parts: [{ name: '底座', versionId: vLower }, { name: '仅此一件', versionId: vUpper }],
});
const otherRun = (await runManifest()).runs.at(-1);
check('a DIFFERENT part set does not supersede the last one',
  !otherRun.supersedes && againRun.supersededBy === undefined,
  `other.supersedes=${JSON.stringify(otherRun.supersedes ?? null)}`);
void other;

// ================= P1-7 + P1-6: datums on an existing version ===============

console.log('\n--- P1-6/7  set_datums on an existing version ---');
const versionsBefore = JSON.parse(await readFile(join(project.root, 'manifest.json'), 'utf8')).versions.length;
const listed = await call('set_datums', { versionId: vUpper });
check('set_datums lists what a version declares', listed.value.mode === 'list',
  `${listed.value.datums.length} anchors, counts=${JSON.stringify(listed.value.counts)}`);
check('  …and says so when a version has none',
  listed.value.warnings.length > 0 && /cannot be an endpoint/.test(listed.value.warnings[0]));

const written = await call('set_datums', {
  versionId: vUpper,
  // [20,20,0] + the manifest's translate [0,0,20] lands exactly on the lower
  // box's 顶面 at [20,20,20] — the interface below must then measure 0.
  datums: [{ name: '底面', kind: 'point', point: [20, 20, 0] }],
});
check('set_datums writes an anchor onto the SAME version',
  written.value.mode === 'merged' && written.value.counts.points === 1,
  JSON.stringify(written.value.datums));
const versionsAfter = JSON.parse(await readFile(join(project.root, 'manifest.json'), 'utf8')).versions.length;
check('  …without creating a version (no "geometry unchanged" round)',
  versionsAfter === versionsBefore, `${versionsBefore} → ${versionsAfter}`);

// The real payoff: an interface that addresses the anchor just added.
const manifest = {
  schemaVersion: 1, name: 'P1 fixture', unit: 'mm', up: 'z',
  root: {
    id: 'fixture', name: 'P1 fixture', kind: 'assembly',
    children: [
      { id: 'lower', name: '底座', kind: 'part', version: vLower },
      { id: 'upper', name: '立柱', kind: 'part', version: vUpper, transform: { translate: [0, 0, 20] } },
    ],
    interfaces: [{
      id: 'if-seat', a: 'lower.顶面', b: 'upper.底面', type: '贴合',
      nominal: { quantity: '距离', value: 0 }, tolerance: { min: -0.2, max: 0.2 },
      severity: 'hard', layer: 'L0', check: 'distance',
    }],
  },
};
await mkdir(join(workspace, 'assembly'), { recursive: true });
await writeFile(join(workspace, 'assembly', 'assembly.json'), JSON.stringify(manifest));
const checked = await call('check_assembly', {});
check('check_assembly resolves the anchor added by set_datums',
  checked.value.overallStatus === 'pass', JSON.stringify(checked.value.summary));

// check_assembly lifecycle: same manifest ⇒ supersede
const checkRun1 = (await runManifest()).runs.filter((r) => r.kind === 'assembly-check').at(-1);
const checked2 = await call('check_assembly', {});
void checked2;
const checkRun2 = (await runManifest()).runs.filter((r) => r.kind === 'assembly-check').at(-1);
const firstCheck = (await runManifest()).runs.find((r) => r.id === checkRun1.id);
check('re-checking the same manifest supersedes the earlier verdict',
  checkRun2.id !== checkRun1.id && firstCheck?.supersededBy === checkRun2.id,
  `${checkRun1.id} → ${firstCheck?.supersededBy}`);

// ================= P1-5: merge_parts ========================================

console.log('\n--- P1-5  merge_parts ---');
const merged = await call('merge_parts', {
  userIntent: '整机刚体（两个方块按装配位姿合并）',
  part: '整机刚体',
  parts: [
    { name: '底座', versionId: vLower },
    { name: '立柱', versionId: vUpper, translate: [0, 0, 20] },
  ],
});
check('merge_parts returns one new version of the named part',
  /^v\d+$/.test(merged.value.versionId) && merged.value.part === '整机刚体',
  `${merged.value.versionId} · ${merged.value.part}`);
check('  …volume is the union of both (40·40·20 + 20·20·20 = 40000)',
  Math.abs(merged.value.volumeMm3 - 40000) < 1, `${merged.value.volumeMm3.toFixed(0)}mm³`);
check('  …a touching pair merges into ONE shell', merged.value.shells === 1, `${merged.value.shells} shell(s)`);
check('  …provenance records what went into it',
  await exists(join(project.root, 'versions', merged.value.versionId, 'source.json')),
  (await readFile(join(project.root, 'versions', merged.value.versionId, 'source.json'), 'utf8')).replace(/\s+/g, ' ').slice(0, 110));
check('  …and the model sees renders of the merged body',
  imagesOf(merged.blocks).length === 4, `${imagesOf(merged.blocks).length} image block(s)`);

const apart = await call('merge_parts', {
  userIntent: '两个不相接的方块（壳数应当 >1）',
  parts: [
    { name: '底座', versionId: vLower },
    { name: '立柱', versionId: vUpper, translate: [0, 0, 60] },
  ],
});
check('a non-touching merge reports its shell count as a warning',
  apart.value.shells === 2 && apart.value.warnings.some((w) => /disjoint shells/.test(w)),
  `${apart.value.shells} shells`);

const badMerge = await (async () => {
  try {
    await call('merge_parts', { userIntent: 'x', parts: [{ name: 'only one', versionId: vLower }] });
    return null;
  } catch (e) { return String(e?.message ?? e); }
})();
check('merge_parts refuses fewer than 2 parts', !!badMerge && /at least 2/.test(badMerge), badMerge ?? '');

// ---------- catalog sanity ----------
check('both new tools are registered', tools.has('merge_parts') && tools.has('set_datums'),
  `${tools.size} tools`);
check('every attached image was a PNG payload',
  savedImages.every((s) => s.bytes > 100), `${savedImages.length} attached`);

await rm(home, { recursive: true, force: true }).catch(() => {});
await rm(workspace, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? '\nP1 ACCEPTANCE PASSED' : `\nP1 ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
