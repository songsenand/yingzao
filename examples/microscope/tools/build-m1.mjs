// M1 build & verify driver for the microscope body frame.
//
// Uses the REAL harness host modules (compile / version store / assembly check)
// against a LOCAL copy of the CAD data root (../cad-data), because the shared
// store at dsh-cad-harness/data is on a read-only mount. The resulting
// cad-data/ directory is drop-in compatible with that store.
//
//   node tools/build-m1.mjs            # incremental: adds new versions
//   node tools/build-m1.mjs --fresh    # wipe cad-data/ first
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..');
const HARNESS = process.env.CAD_HARNESS_ROOT ?? '/home/songsenand/Project/ToyMarker/dsh-cad-harness';
const DATA = process.env.CAD_DATA_ROOT ?? join(WORK, 'cad-data');

const { compileAndRender } = await import(join(HARNESS, 'src/host/compile.ts'));
const { openVersionStore, saveVersion } = await import(join(HARNESS, 'src/host/version.ts'));
const { openPartStore, ensurePart, attachVersion } = await import(join(HARNESS, 'src/host/parts.ts'));
const { saveAssemblyManifest } = await import(join(HARNESS, 'src/host/manifest.ts'));
const { runAssemblyCheck, saveAssemblyReport } = await import(join(HARNESS, 'src/host/assembly-check.ts'));
const { openRunStore, beginRun } = await import(join(HARNESS, 'src/host/runs.ts'));

const fresh = process.argv.includes('--fresh');
if (fresh) await rm(DATA, { recursive: true, force: true });
for (const d of ['versions', 'assembly', 'runs', 'parts']) await mkdir(join(DATA, d), { recursive: true });
await writeFile(join(DATA, 'manifest.json'), JSON.stringify({ versions: [] }, null, 2), { flag: 'wx' }).catch(() => {});
await writeFile(join(DATA, 'parts', 'manifest.json'), JSON.stringify({ schemaVersion: 1, parts: [] }, null, 2), { flag: 'wx' }).catch(() => {});
await writeFile(join(DATA, 'runs', 'manifest.json'), JSON.stringify({ schemaVersion: 1, runs: [] }, null, 2), { flag: 'wx' }).catch(() => {});

const store = openVersionStore(DATA);
const partStore = openPartStore(DATA);
const runStore = openRunStore(DATA);

// ---------------------------------------------------------------------------
// 1. 四件：编译 → 存版本 → 渲染四视图
// ---------------------------------------------------------------------------
const PARTS = [
  {
    id: 'base', name: '显微-底座', file: 'scad/000-base.scad',
    transform: undefined,
    intent: '显微镜底座 150×120×12：中央 Ø40.30 立柱止口沉孔 + 4×M3 铜螺母孔(Ø51 分布圆) + 四角橡胶垫位；底面 140×108×9 减料腔兼配重腔（Ø64 立柱台墩 + 4 个垫脚柱 + 3 条加强肋）',
  },
  {
    id: 'column', name: '显微-立柱', file: 'scad/010-column.scad',
    transform: { translate: [-40, 0, 12] },
    intent: '显微镜立柱 Ø22×200（局部原点=轴心∩法兰底面）：根部 Ø40×6 止口 + Ø60×8 法兰 4×M3 + 柱身防转平面(距轴 9) + 柱顶 2×M3 与侧面 1×M3 底孔',
  },
  {
    id: 'arm', name: '显微-弯臂', file: 'scad/020-arm.scad',
    transform: { translate: [-40, 0, 220] },
    intent: '显微镜弯臂：水平梁(自立柱轴起悬伸 60 到世界 x=20、再前伸到 68)×48×16（顶部减料腔）+ 防转裙板贴立柱防转面 + 前竖直导轨腿 12 厚(前表面=世界 x=20, 可用高 世界 z 156.13..236) + 顶端抱箍座 Ø34.6 内孔(中心世界 z=256，由高度链算出；开口缝+M3 夹紧)',
  },
  {
    id: 'stage', name: '显微-载物台', file: 'scad/030-stage.scad',
    transform: { translate: [40, 0, 155.13] },
    intent: '显微镜载物台：台面 110×90×8 + 玻片槽 25.3×75.4×1.5 + Ø12 通光孔 + 两条后支撑臂 + Ø50 立柱抱箍(Ø22.6 开缝夹紧)；台面世界 z=155.13，标本面 155.0',
  },
];

const built = {};
console.log('── 1/3 生成四件 ─────────────────────────────────────────────');
for (const p of PARTS) {
  const code = await readFile(join(WORK, p.file), 'utf8');
  const r = await compileAndRender(code);
  if (!r.success) {
    console.error(`✗ ${p.name} 编译失败:`, r.errors.join(' | '));
    process.exit(1);
  }
  const entry = await ensurePart(partStore, p.name);
  const versionId = await saveVersion(store, {
    scadCode: code, stl: r.stl, renders: r.renders,
    userIntent: p.intent, parentVersion: null, partId: entry.id,
    datums: r.datums, datumSet: r.datumSet,
  });
  await attachVersion(partStore, entry.id, versionId);
  await mkdir(join(WORK, 'out', 'renders'), { recursive: true });
  for (const rv of r.renders ?? []) {
    await writeFile(join(WORK, 'out', 'renders', `${versionId}-${p.id}-${rv.view}.png`), rv.png);
  }
  built[p.id] = { ...p, versionId, partId: entry.id, warnings: r.warnings, datums: r.datumSet };
  console.log(`  ${p.name.padEnd(8)} ${versionId}  (${entry.id})  视图 ${(r.renders ?? []).map((x) => x.view).join('/')}  ${(r.warnings.length ? '⚠ ' + r.warnings.join(';') : '')}`);
}

// ---------------------------------------------------------------------------
// 2. 装配清单（BOM + 可执行 ICD）
// ---------------------------------------------------------------------------
const dt = (name, kind) => ({ name, kind });
const manifest = {
  schemaVersion: 1,
  name: '显微镜骨架 M1（底座 / 立柱 / 弯臂 / 载物台）',
  unit: 'mm',
  up: 'z',
  root: {
    id: 'microscope-frame',
    name: '显微镜骨架',
    kind: 'assembly',
    interfaces: [
      {
        id: 'if-1', a: 'column.法兰底面', b: 'base.法兰座面', type: '贴合',
        nominal: { quantity: '距离', value: 0 }, tolerance: { min: -0.20, max: 0.20 },
        severity: 'hard', layer: 'L0', check: 'distance',
        note: '立柱法兰底面落在底座上表面（世界 z=12）。承力贴合面，同时也是立柱高度的零位。',
      },
      {
        id: 'if-2', a: 'arm.弯臂底面', b: 'column.立柱顶面', type: '贴合',
        nominal: { quantity: '距离', value: 0 }, tolerance: { min: -0.20, max: 0.20 },
        severity: 'hard', layer: 'L0', check: 'distance',
        note: '弯臂梁底面落在立柱顶面（世界 z=220），2×M3 从梁顶拧入柱顶。',
      },
      {
        id: 'if-3', a: 'base.法兰孔', b: 'column.根部止口', type: '紧固',
        nominal: { quantity: '直径', value: 0.15 }, tolerance: { min: 0.05, max: 0.30 },
        severity: 'hard', layer: 'L0', check: 'diameter-match',
        note: '底座 Ø40.30 止口孔 ↔ 立柱 Ø40 根部止口，直径间隙 0.30（单边 0.15）。',
      },
      {
        id: 'if-4', a: 'arm.竖直定位面', b: 'column.防转平面', type: '贴合',
        nominal: { quantity: '距离', value: 0 }, tolerance: { min: -0.20, max: 0.20 },
        severity: 'hard', layer: 'L0', check: 'distance',
        note: '弯臂裙板竖直面贴立柱防转平面（世界 x=-31），1×M3 侧向拧入；防转 + 定心。',
      },
      {
        id: 'if-5', a: 'stage.槽壁A', b: 'stage.槽壁B', type: '间隙',
        nominal: { quantity: '距离', value: 25.30 }, tolerance: { min: 25.20, max: 25.45 },
        severity: 'hard', layer: 'L0', check: 'distance',
        note: '玻片槽宽：载玻片 25.0 → 单边 0.15。同一零件的自接口（槽宽尺寸链）。',
      },
      {
        id: 'if-stage-clamp', a: 'stage.立柱抱孔', b: 'column.柱身外圆', type: '紧固',
        nominal: { quantity: '直径', value: 0.60 }, tolerance: { min: 0.30, max: 0.90 },
        severity: 'intent', layer: 'L0', check: 'diameter-match',
        note: '载物台 Ø50 抱箍孔 Ø22.6 抱立柱 Ø22（直径间隙 0.60，开缝 + M3 夹紧）。载物台高度由这条接口定位。',
      },
      {
        id: 'chain-u', a: 'arm.标本面基准点', b: 'arm.镜头座安装面基准点', type: '贴合',
        nominal: { quantity: '距离', value: 13.0 }, tolerance: { min: 12.0, max: 14.0 },
        severity: 'hard', layer: 'L0', check: 'distance',
        note: '高度链自检 C1（弯臂内部）：标本面基准 155.0 + 物距 u 13.0 = 镜头座安装面基准 168.0。M3 由镜头座承载，此处先把基准立在弯臂上。',
      },
      {
        id: 'chain-v', a: 'arm.像面基准点', b: 'arm.镜头座安装面基准点', type: '贴合',
        nominal: { quantity: '距离', value: 156.0 }, tolerance: { min: 155.7, max: 156.3 },
        severity: 'hard', layer: 'L0', check: 'distance',
        note: '高度链自检 C2（弯臂内部）：镜头座安装面 168.0 + 像距 v 156.0 = 像面 324.0（目视/摄像共用同一像面）。',
      },
      {
        id: 'chain-clamp', a: 'arm.抱箍座中心', b: 'arm.镜头座安装面基准点', type: '贴合',
        nominal: { quantity: '距离', value: 88.0 }, tolerance: { min: 87.7, max: 88.3 },
        severity: 'intent', layer: 'L0', check: 'distance',
        note: '抱箍座中心 = 镜头座安装面 + 88.0 → 世界 z=256.0。M3 镜筒必须把「抱箍座面」做在安装面上方 88.0 处。',
      },
      {
        id: 'chain-specimen', a: 'stage.标本面', b: 'stage.台面点', type: '贴合',
        nominal: { quantity: '距离', value: 0.13 }, tolerance: { min: 0.03, max: 0.23 },
        severity: 'intent', layer: 'L0', check: 'distance',
        note: '标本面高度自检（载物台内部）：槽底 153.63 + 载玻片 1.2 + 盖玻片 0.17 = 155.0，比台面 155.13 低 0.13。这是外购件假设清单里唯一能机检的一条；1.2/0.17 的±0.1 变化由调焦吸收。',
      },
    ],
    children: [
      {
        id: 'base', name: '显微-底座', kind: 'part', version: built.base.versionId,
        source: 'generated', material: 'PLA',
        datums: [dt('法兰座面', 'point'), dt('法兰孔', 'cylinder'), dt('上表面', 'plane'), dt('配重腔中心', 'point')],
      },
      {
        id: 'column', name: '显微-立柱', kind: 'part', version: built.column.versionId,
        source: 'generated', material: 'PLA', transform: { translate: [-40, 0, 12] },
        datums: [dt('法兰底面', 'point'), dt('立柱顶面', 'point'), dt('根部止口', 'cylinder'), dt('防转平面', 'point'), dt('防转面', 'plane')],
      },
      {
        id: 'arm', name: '显微-弯臂', kind: 'part', version: built.arm.versionId,
        source: 'generated', material: 'PLA', transform: { translate: [-40, 0, 220] },
        datums: [
          dt('弯臂底面', 'point'), dt('竖直定位面', 'point'), dt('抱箍座中心', 'point'),
          dt('镜头座安装面基准点', 'point'), dt('标本面基准点', 'point'), dt('像面基准点', 'point'),
          dt('镜筒轴', 'axis'), dt('抱箍座安装面', 'plane'), dt('导轨面', 'plane'), dt('抱箍座内孔', 'cylinder'),
        ],
      },
      {
        id: 'stage', name: '显微-载物台', kind: 'part', version: built.stage.versionId,
        source: 'generated', material: 'PLA', transform: { translate: [40, 0, 155.13] },
        datums: [
          dt('标本面', 'point'), dt('台面点', 'point'), dt('槽壁A', 'point'), dt('槽壁B', 'point'), dt('槽底', 'point'),
          dt('通光孔轴心', 'point'), dt('通光孔', 'cylinder'), dt('立柱抱孔', 'cylinder'),
        ],
      },
    ],
  },
};

const manifestPath = join(DATA, 'assembly', 'microscope-frame.json');
await saveAssemblyManifest(manifestPath, manifest);
await mkdir(join(WORK, 'assembly'), { recursive: true });
await writeFile(join(WORK, 'assembly', 'microscope-frame.json'), JSON.stringify(manifest, null, 2));
console.log(`\n── 2/3 装配清单 ─────────────────────────────────────────────\n  写入 ${manifestPath}\n  副本 ${join(WORK, 'assembly', 'microscope-frame.json')}`);

// ---------------------------------------------------------------------------
// 3. check_assembly（两档邻接阈值）+ 运行记录
// ---------------------------------------------------------------------------
const sourceVersionIds = Object.values(built).map((b) => b.versionId);

async function checkRun(label, opts, outName) {
  const report = await runAssemblyCheck(store, manifestPath, opts);
  const saved = await saveAssemblyReport(manifestPath, report);
  await mkdir(join(WORK, 'out', 'reports'), { recursive: true });
  await writeFile(join(WORK, 'out', 'reports', outName), JSON.stringify(report, null, 2));
  const run = await beginRun(runStore, { kind: 'assembly-check', title: `装配清单检查 · ${report.manifestName}` });
  await run.json('report.json', report);
  const entry = await run.commit({
    sourceVersionIds,
    status: report.overallStatus,
    summary: `${report.summary.interfaces} 接口 · 通过 ${report.summary.pass} · 硬冲突 ${report.summary.hardViolations} · 未声明 ${report.summary.undeclared}`,
  });
  console.log(`\n── ${label} ─────────────────────────────`);
  for (const r of report.results) {
    console.log(`  ${r.verdict === 'pass' ? '✅' : r.verdict === 'intent-flag' ? '🟡' : r.verdict === 'skipped' ? '⏭' : '❌'} ${r.interfaceId.padEnd(16)} ${r.check.padEnd(15)} measured=${r.measured}  期望[${r.expected?.min ?? '-'}, ${r.expected?.max ?? '-'}]`);
  }
  for (const u of report.undeclared) console.log(`  ⚠ 未声明邻近: ${u.partA} ↔ ${u.partB}  min=${u.minDistance}  vol=${u.intersectionVolume}`);
  console.log(`  → overall=${report.overallStatus}  pass=${report.summary.pass} hard=${report.summary.hardViolations} intent=${report.summary.intentFlags} skipped=${report.summary.skipped} undeclared=${report.summary.undeclared}   (run ${entry.id})`);
  console.log(`  report: ${saved}`);
  return report;
}

await checkRun('3/3 check_assembly · 默认邻接阈值 0.75mm', {}, 'check-default.json');
await checkRun('3b check_assembly · 邻接阈值 1.2mm（为抓 1.0mm 让位间隙）', { adjacencyThresholdMm: 1.2 }, 'check-adjacency-1.2.json');

// --- 3c 取证：同轴度这条 PROJECT 接口 14/15 在 v1 里没有算子消费 -----------------
// 追加一条 if-coax-lightpath（stage.通光孔轴心 ↔ arm.镜筒轴，check: coaxial）：
// 期望 verdict=skipped（"L0 check coaxial is unknown"），而且因为它声明了 arm↔stage
// 这一对零件，邻接发现里的 1.0mm 让位间隙会同时消失 —— 一次跑出两个结论。
{
  const variant = JSON.parse(JSON.stringify(manifest));
  variant.name = `${manifest.name} · 同轴度取证`;
  variant.root.interfaces.push({
    id: 'if-coax-lightpath', a: 'stage.通光孔轴心', b: 'arm.镜筒轴', type: '贴合',
    nominal: { quantity: '同轴度', value: 0 }, tolerance: { min: 0, max: 0.30 },
    severity: 'hard', layer: 'L0', check: 'coaxial',
    note: 'PROJECT 接口 14：镜头座轴心 ↔ 载物台通光孔轴心。v3 没有 coaxial 算子 —— 这条只会被 skipped。',
  });
  const path = join(DATA, 'assembly', 'microscope-frame-coax-demo.json');
  await saveAssemblyManifest(path, variant);
  const report = await runAssemblyCheck(store, path, { adjacencyThresholdMm: 1.2 });
  await mkdir(join(WORK, 'out', 'reports'), { recursive: true });
  await writeFile(join(WORK, 'out', 'reports', 'check-coax-demo.json'), JSON.stringify(report, null, 2));
  const run = await beginRun(runStore, { kind: 'assembly-check', title: '同轴度取证 · 未实现算子' });
  await run.json('report.json', report);
  const entry = await run.commit({
    sourceVersionIds,
    status: report.overallStatus,
    summary: `skipped ${report.summary.skipped} · 未声明 ${report.summary.undeclared}`,
  });
  console.log('\n── 3c 同轴度取证（接口 14 风格）────────────────────────────');
  for (const r of report.results.filter((x) => x.verdict === 'skipped')) console.log(`  ⏭ ${r.interfaceId}: ${r.detail}`);
  console.log(`  → overall=${report.overallStatus}  skipped=${report.summary.skipped}  undeclared=${report.summary.undeclared}  (run ${entry.id})`);
  console.log('    注意：这条接口把 arm↔stage 声明成了"有接口"，邻接发现里的 1.0mm 让位间隙因此消失。');
}

console.log(`\n数据根: ${DATA}`);
