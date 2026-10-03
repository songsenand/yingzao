// M1 negative controls (PROJECT.md §4 固定收尾 第 1 步):
// 破坏一条接口 → check_assembly 必须报 hard-violation → 复原。
//
// 这里不覆盖正品版本，而是把"坏件"存成单独的对照零件版本，正品清单始终保持通过：
//   NEG-A  立柱根部止口 Ø40 → Ø39.5（配合间隙 0.30 → 0.80，超 [0.05,0.30]）
//   NEG-B  弯臂声明的镜头座安装面基准抬高 3mm（高度链 13.0 → 16.0、156.0 → 153.0）
// 两次都必须 overallStatus=fail 且 summary.hardViolations>0；没报就是校验是空的。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..');
const HARNESS = process.env.CAD_HARNESS_ROOT ?? '/home/songsenand/Project/ToyMarker/dsh-cad-harness';
const DATA = process.env.CAD_DATA_ROOT ?? join(WORK, 'cad-data');

const { compileStlOnly } = await import(join(HARNESS, 'src/host/compile.ts'));
const { openVersionStore, saveVersion } = await import(join(HARNESS, 'src/host/version.ts'));
const { openPartStore, ensurePart, attachVersion } = await import(join(HARNESS, 'src/host/parts.ts'));
const { saveAssemblyManifest } = await import(join(HARNESS, 'src/host/manifest.ts'));
const { runAssemblyCheck } = await import(join(HARNESS, 'src/host/assembly-check.ts'));
const { openRunStore, beginRun } = await import(join(HARNESS, 'src/host/runs.ts'));

const store = openVersionStore(DATA);
const partStore = openPartStore(DATA);
const runStore = openRunStore(DATA);

const good = JSON.parse(await readFile(join(DATA, 'assembly', 'microscope-frame.json'), 'utf8'));

async function breakPart({ childId, partName, scadFile, patch, intent }) {
  const src = await readFile(join(WORK, scadFile), 'utf8');
  const broken = patch(src);
  if (broken === src) throw new Error(`patch did not apply: ${childId}`);
  const r = await compileStlOnly(broken);
  if (!r.success) throw new Error(`broken variant failed to compile: ${r.errors.join('; ')}`);
  const part = await ensurePart(partStore, partName);
  const versionId = await saveVersion(store, {
    scadCode: broken, stl: r.stl, userIntent: intent, parentVersion: null, partId: part.id,
    datums: r.datums, datumSet: r.datumSet,
  });
  await attachVersion(partStore, part.id, versionId);
  return versionId;
}

async function runNegative(label, mutate, outName) {
  const manifest = JSON.parse(JSON.stringify(good));
  manifest.name = `${good.name} · 阴性对照 ${label}`;
  const versions = await mutate(manifest);
  const path = join(DATA, 'assembly', outName);
  await saveAssemblyManifest(path, manifest);
  await writeFile(join(WORK, 'assembly', outName), JSON.stringify(manifest, null, 2));
  const report = await runAssemblyCheck(store, path, { adjacencyThresholdMm: 1.2 });
  await mkdir(join(WORK, 'out', 'reports'), { recursive: true });
  await writeFile(join(WORK, 'out', 'reports', outName.replace('.json', '-report.json')), JSON.stringify(report, null, 2));
  const run = await beginRun(runStore, { kind: 'assembly-check', title: `阴性对照 · ${label}` });
  await run.json('report.json', report);
  const entry = await run.commit({
    sourceVersionIds: versions,
    status: report.overallStatus,
    summary: `${label}: 硬冲突 ${report.summary.hardViolations} / 通过 ${report.summary.pass}`,
  });
  const bad = report.results.filter((r) => r.verdict === 'hard-violation');
  console.log(`\n── ${label} ───────────────────────────`);
  for (const r of bad) console.log(`  ❌ ${r.interfaceId.padEnd(14)} ${r.check.padEnd(15)} measured=${r.measured}  期望[${r.expected?.min}, ${r.expected?.max}]`);
  console.log(`  → overall=${report.overallStatus}  hard=${report.summary.hardViolations}  (run ${entry.id})`);
  const ok = report.overallStatus === 'fail' && report.summary.hardViolations > 0;
  console.log(`  ${ok ? '✅ 阴性对照成立：破坏被抓住' : '❌ 阴性对照失败：破坏了却没报（校验是空的）'}`);
  return ok;
}

const a = await runNegative(
  'A 立柱止口 Ø40→Ø39.5',
  async (m) => {
    const v = await breakPart({
      childId: 'column', partName: '显微-立柱-阴性对照A', scadFile: 'scad/010-column.scad',
      patch: (s) => s.replace('SPIGOT_D   = 40;', 'SPIGOT_D   = 39.5;'),
      intent: '阴性对照：把根部止口从 Ø40 改小 0.5，其余不动 —— 接口 if-3 必须报 hard-violation',
    });
    m.root.children.find((c) => c.id === 'column').version = v;
    m.root.children.find((c) => c.id === 'column').id = 'column';   // 保持 id，清单结构不变
    return [v];
  },
  'neg-A-column-spigot.json',
);

const b = await runNegative(
  'B 高度链错位 3mm（镜头座安装面基准 168→171）',
  async (m) => {
    const v = await breakPart({
      childId: 'arm', partName: '显微-弯臂-阴性对照B', scadFile: 'scad/020-arm.scad',
      patch: (s) => s.replace('Z_MOUNT     = 168.0;', 'Z_MOUNT     = 171.0;'),
      intent: '阴性对照：把弯臂声明的镜头座安装面基准抬高 3mm —— 链自检 chain-u/chain-v 必须报 hard-violation',
    });
    m.root.children.find((c) => c.id === 'arm').version = v;
    return [v];
  },
  'neg-B-chain-offset.json',
);

console.log(`\n两组合计: ${a && b ? '✅ 阴性对照全部成立' : '❌ 有阴性对照未成立'}`);
