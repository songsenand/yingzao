#!/usr/bin/env node
// 05-rack-assembly · 机检自检（**评分方脚本**）
//
//   node examples/bench/graders/05-rack-assembly/self-check.mjs
//
// 「阴性对照不报 = 这道题的机检是空的」。这一卷最常见的偷懒是**两件都留在原点**
// （等于没装），所以它既是硬门 g-pose-not-trivial 的对象，也是 g-negative-control-fires
// 要自证的事实：由真值算出的"原点包络"必须在容差外。
//
// 合成 4 个 run root，直接跑 bench-score.mjs --json：
//   A 正确装配            → 硬门 7 + 数值 4 全过
//   B 两件都留原点        → g-pose-not-trivial 与 c-envelope 必须红
//   C 没跑装配验证        → g-verify-run 必须红
//   D 声明合并后 2 体     → c-merged-single-body 必须红

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SCORER = join(REPO, 'examples', 'bench', 'tools', 'bench-score.mjs');
const truth = JSON.parse(await readFile(join(HERE, 'ground-truth.json'), 'utf8'));
const taskSha = JSON.parse(await readFile(join(HERE, 'rubric.json'), 'utf8')).taskFile.sha256;
const TARGET = truth.acceptance.envelopeMm.target;         // { x, y, z, originMm }
const XBAR = truth.given.xBar.extentMm;
const YBAR = truth.given.yBar.extentMm;

const boxStl = (x, y, z) => {
  const buffer = Buffer.alloc(84 + 50);
  buffer.writeUInt32LE(1, 80);
  const put = (i, [vx, vy, vz]) => {
    buffer.writeFloatLE(vx, 84 + 12 + i * 12);
    buffer.writeFloatLE(vy, 84 + 12 + i * 12 + 4);
    buffer.writeFloatLE(vz, 84 + 12 + i * 12 + 8);
  };
  put(0, [0, 0, 0]); put(1, [x, 0, 0]); put(2, [0, y, z]);
  return buffer;
};
const answer = (over) => ({
  parts: [
    { name: 'xBar', stl: 'xBar.stl', translationMm: [0, 0, 0], rotationDeg: [0, 0, 0] },
    { name: 'yBar', stl: 'yBar.stl', translationMm: TARGET.originMm, rotationDeg: [0, 0, 0] },
  ],
  envelopeMm: {
    x: { min: 0, max: TARGET.x }, y: { min: 0, max: TARGET.y }, z: { min: 0, max: TARGET.z },
  },
  interference: { pairCount: 0, minDistanceMm: 0, status: 'ok' },
  mergedBodyCount: 1,
  keyFits: [{ what: 'yBar 端面 ↔ xBar 导槽面', distanceMm: 0.0 }],
  measuredWith: ['list_features', 'measure_extent', 'validate_assembly', 'merge_parts', 'check_connectivity'],
  notAchieved: [],
  ...over,
});

const writeRun = async (root, opts) => {
  const versions = join(root, 'cad-data', 'versions');
  const runs = join(root, 'cad-data', 'runs', 'r001');
  await mkdir(versions, { recursive: true });
  await mkdir(runs, { recursive: true });
  const entries = [
    { id: 'v001', partId: 'p1', bbox: [XBAR.x.sizeMm, XBAR.y.sizeMm, XBAR.z.sizeMm] },
    { id: 'v002', partId: 'p2', bbox: [YBAR.x.sizeMm, YBAR.y.sizeMm, YBAR.z.sizeMm] },
  ];
  for (const e of entries) {
    await mkdir(join(versions, e.id), { recursive: true });
    await writeFile(join(versions, e.id, 'model.stl'), boxStl(...e.bbox));
  }
  await writeFile(join(root, 'cad-data', 'manifest.json'), JSON.stringify({
    versions: entries.map(({ id, partId }) => ({ id, partId, source: { kind: 'imported' }, userIntent: id })),
  }, null, 2));
  if (opts.withVerify !== false) {
    await writeFile(join(runs, 'run.json'), JSON.stringify({
      id: 'r001', kind: 'assembly', status: 'pass', summary: 'xBar + yBar', sourceVersionIds: ['v001', 'v002'],
    }, null, 2));
    await writeFile(join(runs, 'report.json'), JSON.stringify({
      overallStatus: 'pass',
      pairs: [{ partA: 'xBar', partB: 'yBar', intersectionVolume: 0, minDistance: 0, status: 'ok' }],
    }, null, 2));
  }
  const events = [];
  const call = (id, tool, input, result) => {
    events.push({ type: 'tool_call', callId: id, tool, input });
    events.push({ type: 'tool_result', callId: id, status: 'completed', result: JSON.stringify(result) });
  };
  call('c0', 'import_part', { path: 'xBar.stl' }, { versionId: 'v001' });
  call('c1', 'import_part', { path: 'yBar.stl' }, { versionId: 'v002' });
  call('c2', 'list_features', { versionId: 'v001' }, { faceCount: 20, holeCount: 8, cylinderCount: 0, faces: [] });
  call('c3', 'measure_extent', { versionId: 'v001', axis: 'y' }, { sizeMm: XBAR.y.sizeMm, minMm: XBAR.y.min, maxMm: XBAR.y.max });
  call('c4', 'validate_assembly', { manifestPath: 'assembly/assembly.json' }, { overallStatus: 'pass', pairs: [{ status: 'ok' }] });
  call('c5', 'merge_parts', { versions: ['v001', 'v002'] }, { versionId: 'v003' });
  call('c6', 'check_connectivity', { versionId: 'v003' }, { count: opts.bodies ?? 1, watertight: true, triangles: 40000 });
  await writeFile(join(root, 'TASK.events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await writeFile(join(root, 'run-record.json'), JSON.stringify({
    level: '05-rack-assembly', variant: 'default', run: 'self-check', runRoot: root,
    model: 'self-check', startedAt: new Date(0).toISOString(),
    stages: [{ task: 'subjects/05-rack-assembly/TASK.md', local: 'TASK.md', sha256: taskSha,
      cmd: '(self-check，无真实会话)', exitCode: 0, turns: 6, events: 'TASK.events.jsonl' }],
  }, null, 2));
  await writeFile(join(root, 'assembly-answer.json'), JSON.stringify(opts.answer ?? answer(), null, 2));
};

const score = (root) => JSON.parse(execFileSync('node', [SCORER, '--run', root, '--json'], { encoding: 'utf8' }));
const verdict = (out, id) => [...out.gates, ...out.checks].find((x) => x.id === id)?.ok;

const SCENARIOS = [
  { name: 'A 正确装配', opts: {}, expectAllPass: true },
  { name: 'B 两件都留在原点（没装）', opts: {
    answer: answer({
      parts: [
        { name: 'xBar', stl: 'xBar.stl', translationMm: [0, 0, 0], rotationDeg: [0, 0, 0] },
        { name: 'yBar', stl: 'yBar.stl', translationMm: [0, 0, 0], rotationDeg: [0, 0, 0] },
      ],
      envelopeMm: {
        x: { min: 0, max: Math.max(XBAR.x.sizeMm, YBAR.x.sizeMm) },
        y: { min: 0, max: Math.max(XBAR.y.sizeMm, YBAR.y.sizeMm) },
        z: { min: 0, max: Math.max(XBAR.z.sizeMm, YBAR.z.sizeMm) },
      },
    }),
  }, mustFail: ['g-pose-not-trivial', 'c-envelope'] },
  { name: 'C 没跑装配验证', opts: { withVerify: false }, mustFail: ['g-verify-run'] },
  { name: 'D 声明合并后 2 体', opts: { bodies: 2, answer: answer({ mergedBodyCount: 2 }) },
    mustFail: ['c-merged-single-body'] },
];

const tmp = join(REPO, '.tmp-05-selfcheck');
await rm(tmp, { recursive: true, force: true });
let failures = 0;
console.log('05-rack-assembly 机检自检（合成 run root；不调模型）\n');
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
    if (ok) {
      const ncf = out.gates.find((g) => g.id === 'g-negative-origin-fires');
      console.log(`        阴性对照自证：${ncf?.detail?.slice(0, 96)}`);
    }
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
