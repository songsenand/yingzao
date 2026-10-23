#!/usr/bin/env node
// write-score-file.mjs · 按 README §8 字段写正式分数文件
//
// 用法：node write-score-file.mjs <runRoot> <scoreJson> <level>
// 输出：graders/<level>/scores/zai-coding-cn-glm-5.3-flash-high-20261018-r1.json
// E/H/R/C 留待人工打分后回填（--set '{"E":0.6,...}'）。
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const [runRoot, scorePath, level, setArg] = process.argv.slice(2);
const score = JSON.parse(await readFile(scorePath, 'utf8'));
const record = JSON.parse(await readFile(join(runRoot, 'run-record.json'), 'utf8'));

const REPO = '/home/songsenand/Project/ToyMarker';
const gitCommit = execSync('git log --diff-filter=A --format=%H -- examples/bench', { cwd: REPO }).toString().trim();
const skillSha = execSync('sha256sum dsh-cad-harness/skills/cad-toolbox/SKILL.md', { cwd: REPO }).toString().split(/\s+/)[0];

const taskSha = (record.stages ?? []).filter((s) => s.sha256).map((s) => s.sha256);
const c = score.measured?.cost ?? {};
const cost = c.toolCallsTotal ?? c.toolCalls ?? record.stages?.reduce((a, s) => a + (s.toolCallCount ?? 0), 0) ?? 0;
const wallClockMin = Number(c.wallClockMin ?? ((record.finishedAt && record.startedAt) ? (new Date(record.finishedAt) - new Date(record.startedAt)) / 60000 : 0));

const gatesFailed = [...(score.gates ?? []), ...(score.checks ?? []), ...(score.probes ?? [])]
  .filter((x) => x.ok === false).map((x) => x.id);

const out = {
  example: level,
  variant: record.variant ?? 'default',
  tier: record.tier ?? 'headless（不命名预设）',
  model: score.model,
  reasoningEffort: record.reasoningEffort ?? 'high',
  startedAt: record.startedAt,
  wallClockMin,
  sut: { gitCommit, skillSha256: skillSha },
  taskSha256: taskSha,
  s0: !!score.skillLoaded,
  toolCalls: cost,
  images: null,
  imagesPruned: null,
  usage: record.stages?.map((s) => s.usage).filter(Boolean) ?? [],
  machineScore: {
    P: score.computed?.P ?? null,
    S: score.computed?.S ?? null,
    coverage: score.coverage,
    gates: score.gates, checks: score.checks, probes: score.probes,
    coverageGaps: score.coverageGaps ?? [],
  },
  columns: { P: score.computed?.P ?? null, E: null, H: null, C: null, R: null, S: score.computed?.S ?? null },
  gatesFailed,
  falseClaims: [],
  notes: 'E/H/R/C 待人工打分回填；机检明细在 machineScore。',
};

if (setArg) {
  const set = JSON.parse(setArg.split('=')[1] ?? setArg);
  Object.assign(out.columns, set);
}

const dest = join(REPO, 'examples', 'bench', 'graders', level, 'scores',
  `${score.model.replace('/', '-')}-${record.reasoningEffort ?? 'high'}-20261018-r1.json`);
await writeFile(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('written', dest);
