// Q1's A/B half: turn six numbers into a verdict, and write it where it lives.
//
// Q1 is closed on the fixed-prefix half (`accept-token-budget`: 5,930 chars vs
// 104,675). The other half — "same task, end-to-end tokens down ≥20%" — needs real
// sessions, which means a human runs three tasks twice and reads the host's usage
// panel. Doing that by hand is fine; leaving the result in a chat message is not:
// the number would evaporate, and the next release would re-argue it.
//
// So this script owns the ARITHMETIC and the RECORD:
//
//   1. you write the six numbers into a small JSON (pass flags included);
//   2. `node scripts/token-ab-report.mjs --input ab.json` prints the table, the
//      per-task reduction, and PASS/FAIL against the ≥20% line;
//   3. `--append <experiment.md>` inserts the same table under a dated heading, so
//      the experiment file carries the evidence, not a memory of it.
//
// The verdict rule is deliberately conservative and stated here rather than in a
// doc: at least two of the three tasks must drop ≥20%, and every task must still
// PASS in both arms. A task that fails in arm B is not "cheaper", it is worse.
//
//   node scripts/token-ab-report.mjs --input ab.json
//   node scripts/token-ab-report.mjs --input ab.json --append ../experiments/20261127_0.2.0_token.md

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const inputPath = valueOf('--input');
if (!inputPath) {
  console.error('usage: node scripts/token-ab-report.mjs --input <ab.json> [--append <experiment.md>]');
  console.error(`
ab.json:
{
  "date": "2026-11-27",
  "configA": "legacy 45 tools (hideLegacy removed)",
  "configB": "9 surfaces (production)",
  "tasks": [
    { "name": "bracket",  "passA": true, "passB": true, "tokensA": 123456, "tokensB": 98765 },
    { "name": "assembly", "passA": true, "passB": true, "tokensA": 234567, "tokensB": 187654 },
    { "name": "fluid",    "passA": true, "passB": true, "tokensA": 345678, "tokensB": 276543 }
  ]
}`);
  process.exit(2);
}

const data = JSON.parse(readFileSync(inputPath, 'utf8'));
const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
if (tasks.length === 0) {
  console.error('ab.json has no tasks');
  process.exit(2);
}
const INVALID = tasks.filter((task) => !Number.isFinite(task.tokensA) || !Number.isFinite(task.tokensB)
  || task.tokensA <= 0 || task.tokensB <= 0);
if (INVALID.length > 0) {
  console.error(`every task needs positive numeric tokensA/tokensB (bad: ${INVALID.map((task) => task.name).join(', ')})`);
  process.exit(2);
}

const TARGET = 0.2;
/**
 * Compare at the precision the table SHOWS (one decimal of a percent).
 * Without this, 123,456 → 98,765 prints "20.0%" and reports "否" (the raw value is
 * 0.19999…): a person reads that as a broken script, and a threshold nobody can
 * reproduce is worse than no threshold.
 */
const atDisplayPrecision = (value) => Math.round(value * 1000) / 1000;
const rows = tasks.map((task) => {
  const reduction = (task.tokensA - task.tokensB) / task.tokensA;
  return {
    name: String(task.name),
    passA: task.passA === true,
    passB: task.passB === true,
    tokensA: task.tokensA,
    tokensB: task.tokensB,
    reduction: atDisplayPrecision(reduction),
    meetsTarget: atDisplayPrecision(reduction) >= TARGET,
  };
});

const passedBoth = rows.every((row) => row.passA && row.passB);
const hitting = rows.filter((row) => row.meetsTarget).length;
const meanReduction = atDisplayPrecision(rows.reduce((sum, row) => sum + row.reduction, 0) / rows.length);
// At least two of three must clear the line, and nothing may regress to a failing task.
const verdict = passedBoth && hitting >= 2 ? 'PASS' : 'FAIL';

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const lines = [];
lines.push(`Q1 A 组：${data.configA ?? '(未注明)'}`);
lines.push(`Q1 B 组：${data.configB ?? '(未注明)'}`);
lines.push('');
lines.push('| 任务 | A 通过 | B 通过 | A token | B token | 降幅 | ≥20% |');
lines.push('|---|---|---|---|---|---|---|');
for (const row of rows) {
  lines.push(`| ${row.name} | ${row.passA ? '✅' : '❌'} | ${row.passB ? '✅' : '❌'} | ${row.tokensA.toLocaleString('en-US')}`
    + ` | ${row.tokensB.toLocaleString('en-US')} | ${pct(row.reduction)} | ${row.meetsTarget ? '是' : '否'} |`);
}
lines.push('');
lines.push(`- 平均降幅 **${pct(meanReduction)}**；达标（≥20%）任务 **${hitting}/${rows.length}**；`);
lines.push(`- 两臂任务全通过：${passedBoth ? '是' : '否'}`);
lines.push(`- 判定：**${verdict}**（规则：两臂都通过，且至少 2/3 任务降幅 ≥20%）`);

console.log(lines.join('\n'));

if (valueOf('--append')) {
  const target = valueOf('--append');
  const date = data.date ?? new Date().toISOString().slice(0, 10);
  const section = [
    '',
    `### A/B 结果（${date}，由 \`scripts/token-ab-report.mjs\` 生成）`,
    '',
    ...lines.map((line) => line),
    '',
  ].join('\n');
  const existing = readFileSync(target, 'utf8');
  // Append-only: the experiment file is a record, not a scratchpad.
  writeFileSync(target, `${existing.trimEnd()}\n${section}`);
  console.log(`\nappended to ${target}`);
}

process.exit(verdict === 'PASS' ? 0 : 1);
