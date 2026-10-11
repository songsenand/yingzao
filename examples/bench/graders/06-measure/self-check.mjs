#!/usr/bin/env node
// 06-measure · 机检自检（**评分方脚本**）
//
//   node examples/bench/graders/06-measure/self-check.mjs
//
// 为什么必须有这个脚本：题库纪律里最重的一条是「**阴性对照不报 = 这道题的机检是
// 空的**，比报错严重得多」。等到真跑一轮才发现判据不响，代价是一轮 25 分钟 + 一次
// 模型调用，而且会把"判据没实现"误读成"模型没做到"。
//
// 做法：合成 4 个 run root（`run-record.json` + `TASK.events.jsonl` + `measure.json`），
// 直接调 `bench-score.mjs --json`，逐条核对**哪些判据必须红**：
//
//   A 正确回答                  → 硬门全过、数值判据全过
//   B 编一个数（壁厚 3.5mm）    → c-tube-wall 与 g-no-invented-numbers 必须红
//   C 绕开工具（只调 run_python）→ g-tools-not-bypassed 必须红
//   D 没做两件对比（delta=0）   → g-delta-correct 必须红
//
// 工具返回取自 `ground-truth.json` 的 `sources`（就是实测时的原始返回），
// 所以"合法数字池"与真值同源，不会出现"自检通过但真跑必红"的假象。

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SCORER = join(REPO, 'examples', 'bench', 'tools', 'bench-score.mjs');
const truth = JSON.parse(await readFile(join(HERE, 'ground-truth.json'), 'utf8'));
const taskSha = JSON.parse(await readFile(join(HERE, 'rubric.json'), 'utf8')).taskFile.sha256;

// ---- 从真值拼出"正确回答" ---------------------------------------------------
const answer = {
  part: {
    cylinders: truth.cylinders.list.map((c) => ({
      kind: c.kind, diameterMm: c.diameterMm, centerMm: c.centerMm, lengthMm: c.lengthMm,
    })),
    holeCentreDistanceMm: truth.holeCentreDistanceMm,
    tubeWallThicknessMm: truth.tubeWallThicknessMm,
    slopeAngleDeg: truth.slopeAngleAcuteDeg,
    angleConvention: 'acute',
    extentXMm: { min: truth.extentX.min, max: truth.extentX.max },
    extentYMm: { min: truth.extentY.min, max: truth.extentY.max },
    extentZMm: { min: truth.extentZ.min, max: truth.extentZ.max },
    extentDiagonalMm: { axis: [1, 1, 0], min: truth.diagonalExtent.min, max: truth.diagonalExtent.max },
    section: {
      atZMm: truth.section.atZMm,
      holeCentreDistanceMm: truth.section.holeCentreDistanceMm,
      materialAreaMm2: truth.section.materialAreaMm2,
    },
  },
  partB: {
    changed: truth.delta.what,
    beforeMm: truth.delta.beforeMm,
    afterMm: truth.delta.afterMm,
    deltaMm: Math.round((truth.delta.afterMm - truth.delta.beforeMm) * 1000) / 1000,
  },
  toolsUsed: ['list_features', 'measure_thickness', 'measure_section', 'measure_angle', 'measure_extent', 'measure_distance'],
  notMeasurable: [],
};

// ---- 事件流：工具返回用实测记录 ---------------------------------------------
const OP_TO_TOOL = {
  list_features: 'list_features',
  measure_thickness: 'measure_thickness',
  measure_section: 'measure_section',
  measure_extent: 'measure_extent',
  measure_angle: 'measure_angle',
};
const sourceEvents = () => {
  const rows = [];
  let n = 0;
  for (const [key, source] of Object.entries(truth.sources)) {
    const tool = OP_TO_TOOL[source.op];
    if (!tool) continue;
    const callId = `call_${String(++n).padStart(3, '0')}_${key}`;
    rows.push({ type: 'tool_call', callId, tool, input: source.params });
    rows.push({ type: 'tool_result', callId, status: 'completed', result: JSON.stringify(source.value) });
  }
  // 孔心距走的是 measure_distance（两件对比里的"另一条路"，也是真值里记的 50）
  const distId = 'call_900_centre';
  rows.push({ type: 'tool_call', callId: distId, tool: 'measure_distance', input: { versionId: 'v001' } });
  rows.push({ type: 'tool_result', callId: distId, status: 'completed', result: JSON.stringify({ distanceMm: truth.holeCentreDistanceMm }) });
  return rows;
};
/** C 场景：一次 run_python 把所有数字算出来（工具被绕开），数字池仍然有 */
const pythonOnlyEvents = () => {
  const id = 'call_py_001';
  return [
    { type: 'tool_call', callId: id, tool: 'run_python', input: { code: 'print(measurements)' } },
    { type: 'tool_result', callId: id, status: 'completed', result: JSON.stringify(answer) },
  ];
};

const writeRun = async (root, rows, measure) => {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'run-record.json'), JSON.stringify({
    level: '06-measure',
    variant: 'default',
    run: 'self-check',
    runRoot: root,
    model: 'self-check',
    startedAt: new Date(0).toISOString(),
    stages: [{
      task: 'subjects/06-measure/TASK.md', local: 'TASK.md', sha256: taskSha,
      cmd: '(self-check，无真实会话)', exitCode: 0, turns: 3, events: 'TASK.events.jsonl',
    }],
  }, null, 2));
  await writeFile(join(root, 'TASK.events.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  if (measure) await writeFile(join(root, 'measure.json'), JSON.stringify(measure, null, 2));
};

const score = (root) => JSON.parse(execFileSync('node', [SCORER, '--run', root, '--json'], { encoding: 'utf8' }));
const verdictOf = (out, id) => [...out.gates, ...out.checks].find((x) => x.id === id)?.ok;

const deep = (overrides) => {
  const copy = JSON.parse(JSON.stringify(answer));
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split('.');
    let node = copy;
    for (const p of parts.slice(0, -1)) node = node[p];
    node[parts[parts.length - 1]] = value;
  }
  return copy;
};

const SCENARIOS = [
  { name: 'A 正确回答', rows: sourceEvents, measure: deep({}), expectAllPass: true },
  { name: 'B 编一个数（壁厚报 3.5）', rows: sourceEvents,
    measure: deep({ 'part.tubeWallThicknessMm': 3.5 }), mustFail: ['c-tube-wall', 'g-no-invented-numbers'] },
  { name: 'C 绕开工具（只调 run_python）', rows: pythonOnlyEvents, measure: deep({}),
    mustFail: ['g-tools-not-bypassed'] },
  { name: 'D 没做两件对比（delta 报 0）', rows: sourceEvents,
    measure: deep({ 'partB.deltaMm': 0 }), mustFail: ['g-delta-correct'] },
];

const tmp = join(REPO, '.tmp-06-selfcheck');
await rm(tmp, { recursive: true, force: true });
let failures = 0;
console.log('06-measure 机检自检（合成 run root；不调模型）\n');
for (const [index, scenario] of SCENARIOS.entries()) {
  const root = join(tmp, `run-${index}`);
  await writeRun(root, scenario.rows(), scenario.measure);
  const out = score(root);
  const auto = out.checks.filter((c) => c.ok !== 'unknown').length;
  if (scenario.expectAllPass) {
    const bad = [...out.gates, ...out.checks].filter((x) => x.ok !== true);
    const ok = bad.length === 0;
    failures += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.name}  — 硬门 ${out.gates.length} + 数值 ${auto}/${out.checks.length} 自动判定`
      + (ok ? '' : `；意外未过：${bad.map((b) => `${b.id}=${b.ok}`).join(', ')}`));
  } else {
    const wrong = scenario.mustFail.filter((id) => verdictOf(out, id) !== false);
    const unexpected = [...out.gates, ...out.checks]
      .filter((x) => x.ok === false && !scenario.mustFail.includes(x.id)).map((x) => x.id);
    const ok = wrong.length === 0 && unexpected.length === 0;
    failures += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.name}  — 该红的：${scenario.mustFail.map((id) => `${id}=${verdictOf(out, id)}`).join(', ')}`
      + (unexpected.length ? `；**不该红却红了**：${unexpected.join(', ')}` : ''));
  }
}
console.log(`\n${failures === 0 ? 'OK —— 机检会响，阴性对照有效' : `${failures} 个场景不符`}`);
process.exit(failures === 0 ? 0 : 1);
