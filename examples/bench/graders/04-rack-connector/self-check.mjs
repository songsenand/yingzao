#!/usr/bin/env node
// 04-rack-connector · 机检自检（**评分方脚本**）
//
//   node examples/bench/graders/04-rack-connector/self-check.mjs
//
// 题库纪律里最重的一条：**阴性对照不报 = 这道题的机检是空的**，比报错严重。
// 等到真跑一轮才发现判据不响，代价是一轮 40 分钟 + 一次模型调用，而且会把
// "判据没实现"误读成"模型没做到"。
//
// 做法：合成 4 个 run root（run-record + events + cad-data + connector.json），
// 直接跑 bench-score.mjs --json，逐条核对**哪些判据必须红**：
//
//   A 正确交付            → 硬门 6 + 数值 6 全过
//   B 复制导轨改名就交    → c-cross-section / c-length / c-not-a-copy 必须红
//     （两件 STL 都在考生手上，这是最省事的蒙混方式，也是本卷的阴性对照落点）
//   C 没跑装配验证        → g-assembly-run 必须红
//   D 只导入、没建新版本  → g-new-part-version 必须红
//
// 交付件的"尺寸"由 STL 的包围盒体现（打分器自解析 STL），所以这里只要写出
// 顶点落在目标包围盒上的最小 STL 即可。

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SCORER = join(REPO, 'examples', 'bench', 'tools', 'bench-score.mjs');
const truth = JSON.parse(await readFile(join(HERE, 'ground-truth.json'), 'utf8'));
const taskSha = JSON.parse(await readFile(join(HERE, 'rubric.json'), 'utf8')).taskFile.sha256;
const RAIL = [136, 27, 12];
const JOINER = [9.8, 9.8, 20.5];

/** 最小二进制 STL：一个三角形，顶点落在 (0,0,0)/(x,0,0)/(0,y,z) 上 ⇒ 包围盒 = x,y,z */
const boxStl = (x, y, z) => {
  const buffer = Buffer.alloc(84 + 50);
  buffer.writeUInt32LE(1, 80);
  const put = (corner, [vx, vy, vz]) => {
    buffer.writeFloatLE(vx, 84 + 12 + corner * 12);
    buffer.writeFloatLE(vy, 84 + 12 + corner * 12 + 4);
    buffer.writeFloatLE(vz, 84 + 12 + corner * 12 + 8);
  };
  put(0, [0, 0, 0]); put(1, [x, 0, 0]); put(2, [0, y, z]);
  return buffer;
};

const CONNECTOR = {
  partVersionId: 'v003',
  crossSectionMm: { x: 9.8, y: 9.8 },
  lengthMm: 12.0,
  throughHoles: [{ diameterMm: 3.25, centerMm: [3.8, 5, 6] }, { diameterMm: 3.25, centerMm: [6.2, 5, 6] }],
  assemblyStatus: 'pass',
  printability: 'ok',
  measuredWith: ['list_features', 'measure_extent', 'generate_part', 'validate_assembly'],
  notAchieved: [],
};

const writeRun = async (root, opts) => {
  const versions = join(root, 'cad-data', 'versions');
  const runs = join(root, 'cad-data', 'runs', 'r001');
  await mkdir(versions, { recursive: true });
  await mkdir(runs, { recursive: true });
  const entries = [
    { id: 'v001', partId: 'p1', source: { kind: 'imported' }, bbox: RAIL },
    { id: 'v002', partId: 'p2', source: { kind: 'imported' }, bbox: JOINER },
  ];
  if (opts.withNewPart !== false) {
    entries.push({ id: 'v003', partId: 'p3', source: { kind: 'generated' }, bbox: opts.newPartBbox ?? [9.8, 9.8, 12.0] });
  }
  for (const entry of entries) {
    await mkdir(join(versions, entry.id), { recursive: true });
    await writeFile(join(versions, entry.id, 'model.stl'), boxStl(...entry.bbox));
  }
  await writeFile(join(root, 'cad-data', 'manifest.json'), JSON.stringify({
    versions: entries.map(({ id, partId, source }) => ({ id, partId, source, userIntent: id })),
  }, null, 2));

  if (opts.withAssemblyRun !== false) {
    await writeFile(join(runs, 'run.json'), JSON.stringify({
      id: 'r001', kind: 'assembly', status: opts.assemblyStatus ?? 'pass', summary: 'rail + connector',
      sourceVersionIds: ['v001', 'v003'],
    }, null, 2));
    await writeFile(join(runs, 'report.json'), JSON.stringify({
      overallStatus: opts.assemblyStatus ?? 'pass',
      pairs: [{ partA: 'mainRail', partB: 'connector', intersectionVolume: 0, minDistance: 0, status: 'ok' }],
    }, null, 2));
  }

  const events = [];
  const call = (id, tool, input, result) => {
    events.push({ type: 'tool_call', callId: id, tool, input });
    events.push({ type: 'tool_result', callId: id, status: 'completed', result: JSON.stringify(result) });
  };
  call('c1', 'import_part', { path: 'mainRail.stl' }, { versionId: 'v001' });
  call('c2', 'list_features', { versionId: 'v001' }, {
    faceCount: 40, holeCount: 40, cylinderCount: 6, cylinders: [],
    faces: [{ id: 'f1', holes: [{ id: 'h1', diameterMm: 3.25, through: true, centerMm: [3.8, 5, 6] }] }],
  });
  call('c3', 'measure_extent', { versionId: 'v001', axis: 'y' }, { sizeMm: 9.8, minMm: -9.8, maxMm: 0 });
  if (opts.withNewPart !== false) {
    call('c4', 'generate_part', { userIntent: 'stack connector' }, { versionId: 'v003' });
  }
  call('c5', 'check_connectivity', { versionId: 'v003' }, { count: 1, watertight: true, triangles: 120 });
  await writeFile(join(root, 'TASK.events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await writeFile(join(root, 'run-record.json'), JSON.stringify({
    level: '04-rack-connector', variant: 'default', run: 'self-check', runRoot: root,
    model: 'self-check', startedAt: new Date(0).toISOString(),
    stages: [{ task: 'subjects/04-rack-connector/TASK.md', local: 'TASK.md', sha256: taskSha,
      cmd: '(self-check，无真实会话)', exitCode: 0, turns: 5, events: 'TASK.events.jsonl' }],
  }, null, 2));
  if (opts.connector !== null) {
    await writeFile(join(root, 'connector.json'), JSON.stringify(opts.connector ?? CONNECTOR, null, 2));
  }
};

const score = (root) => JSON.parse(execFileSync('node', [SCORER, '--run', root, '--json'], { encoding: 'utf8' }));
const verdict = (out, id) => [...out.gates, ...out.checks].find((x) => x.id === id)?.ok;

const SCENARIOS = [
  { name: 'A 正确交付', opts: {}, expectAllPass: true },
  { name: 'B 复制导轨改名就交', opts: { newPartBbox: RAIL },
    mustFail: ['c-cross-section', 'c-length', 'c-not-a-copy'] },
  { name: 'C 没跑装配验证', opts: { withAssemblyRun: false }, mustFail: ['g-assembly-run'] },
  // 没有新零件时，除了 g-new-part-version，"尺寸类"判据记 unknown（没法判≠判错），
  // 而 g-tools-used 也应当红：没有 generate_part，说明形状不是建模出来的。
  { name: 'D 只导入、没建新版本', opts: { withNewPart: false, connector: { ...CONNECTOR, partVersionId: 'v001' } },
    mustFail: ['g-new-part-version', 'g-tools-used'] },
];

const tmp = join(REPO, '.tmp-04-selfcheck');
await rm(tmp, { recursive: true, force: true });
let failures = 0;
console.log('04-rack-connector 机检自检（合成 run root；不调模型）\n');
for (const [index, scenario] of SCENARIOS.entries()) {
  const root = join(tmp, `run-${index}`);
  await writeRun(root, scenario.opts);
  const out = score(root);
  if (scenario.expectAllPass) {
    const bad = [...out.gates, ...out.checks].filter((x) => x.ok !== true);
    const ok = bad.length === 0;
    failures += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.name}  — 硬门 ${out.gates.length} + 数值 `
      + `${out.checks.filter((c) => c.ok !== 'unknown').length}/${out.checks.length} 自动判定`
      + (ok ? '' : `；意外未过：${bad.map((b) => `${b.id}=${b.ok}`).join(', ')}`));
  } else {
    const wrong = scenario.mustFail.filter((id) => verdict(out, id) !== false);
    const unexpected = [...out.gates, ...out.checks]
      .filter((x) => x.ok === false && !scenario.mustFail.includes(x.id)).map((x) => x.id);
    const ok = wrong.length === 0 && unexpected.length === 0;
    failures += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.name}  — 该红的：`
      + scenario.mustFail.map((id) => `${id}=${verdict(out, id)}`).join(', ')
      + (unexpected.length ? `；**不该红却红了**：${unexpected.join(', ')}` : '')
      + (wrong.length ? `；**该红没红**：${wrong.join(', ')}` : ''));
  }
}
console.log(`\n${failures === 0 ? 'OK —— 机检会响，阴性对照有效' : `${failures} 个场景不符`}`);
process.exit(failures === 0 ? 0 : 1);
