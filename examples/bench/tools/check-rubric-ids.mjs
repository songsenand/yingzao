#!/usr/bin/env node
// bench · 跨卷判据 id 检查
//
//   node examples/bench/tools/check-rubric-ids.mjs
//
// 为什么需要它：`bench-score.mjs` 的求值器是**全局按 id 注册**的（`EV['<id>'] = …`）。
// 两卷用同一个 id 时，后注册的实现会覆盖前面的——症状极其隐蔽：
// **某一卷的自检其实在跑另一卷的实现**，而所有输出看起来都正常。
//
// 实测踩到：06/04/05 三卷都叫过 `g-negative-control-fires`（三个实现语义各不相同），
// 04 与 05 又都叫 `g-tools-used`。发现方式是 04 的自检里 `g-tools-used` 突然"该红没红"。
//
// 本仓库对"跨卷同名"有两条**合法**路径，检查器只报第三条：
//   1. 语义完全相同、共用同一份实现 → 白名单（附理由）；
//   2. 语义相同但各卷实现不同 → 求值器**按 `level` 分派**
//      （既有约定：`EV['c-stroke'] = () => (level === '03-microscope' ? … : …)`）；
//   3. ⚠️ 共用、既不白名单也不分派、**还引用了某一卷专属的真值/地标常量** → 危险：
//      后注册的实现在别卷会读错表（这正是 06/04/05 踩到的那一类）。
//      反之，只读该轮自身数据的实现（如"最终装配检查是否零硬冲突"）跨卷共用是安全的。

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRADERS = resolve(HERE, '..', 'graders');

const SHARED_OK = {
  'g-grader-access': '所有卷共用同一份实现（扫 tool_call.input 触达评分方文件即作废），语义完全相同',
};

const scorer = await readFile(join(HERE, 'bench-score.mjs'), 'utf8');
/**
 * 该 id 的求值器是否按 level 分派？null = 找不到该求值器。
 *
 * 取**最后一次**注册：一个 id 可以先注册通用实现、随后再包一层分派
 * （既有写法：`const generic = EV['c-stroke'];` 之后
 *  `EV['c-stroke'] = () => (level === '03-microscope' ? … : generic());`），
 * 后者才是真正生效的那个。只看第一次注册会误报。
 */
const behaviourOf = (id) => {
  const start = scorer.lastIndexOf(`EV['${id}'] = `);
  if (start < 0) return null;
  const next = scorer.indexOf("\nEV['", start + 1);
  const body = scorer.slice(start, next < 0 ? undefined : next);
  return {
    body,
    dispatches: /\blevel\b/.test(body),
    // 危险信号：求值器引用了**某一卷专属的常量表**（真值 / 地标）。同名时这些常量
    // 属于另一卷，后注册的实现在本卷上会读错表 → 静默给出错误判定。
    // 这正是我踩的那一类（三卷各自引 gt06/gt04/gt05，却共用同一个 id）。
    questionConstants: /\bgt\d|landmarks|GT_/.test(body),
  };
};

const levels = (await readdir(GRADERS, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
const owner = new Map();
let total = 0;
for (const level of levels) {
  let rubric;
  try {
    rubric = JSON.parse(await readFile(join(GRADERS, level, 'rubric.json'), 'utf8'));
  } catch {
    console.log(`SKIP  ${level} — 没有 rubric.json`);
    continue;
  }
  // 脚本驱动的卷（00-smoke）由 bench-smoke.mjs 自己算判据，判据 id 不进 EV 表，
  // 因此不参与"互相覆盖"的风险——把它算进来会产生假警报。
  if (rubric.driver === 'script') {
    console.log(`SKIP  ${level} — 脚本驱动（其判据由 bench-smoke.mjs 计算，不占 EV 表）`);
    continue;
  }
  for (const item of [...(rubric.gates ?? []), ...(rubric.checks ?? []), ...(rubric.features ?? [])]) {
    if (!owner.has(item.id)) owner.set(item.id, []);
    owner.get(item.id).push(level);
    total++;
  }
}

const problems = [];
for (const [id, users] of owner) {
  if (users.length < 2) continue;
  if (SHARED_OK[id]) { console.log(`OK    ${id}  ← ${users.join(', ')}（白名单）`); continue; }
  // 人判项没有求值器，不上机检；同名只影响跨卷汇总时的人读。
  if (id.startsWith('f-')) { console.log(`OK    ${id}  ← ${users.join(', ')}（人判项，无求值器）`); continue; }
  const b = behaviourOf(id);
  if (b === null) { problems.push(`${id} 被 ${users.length} 卷共用，但 bench-score.mjs 里没有对应求值器：${users.join(', ')}`); continue; }
  if (b.dispatches) { console.log(`OK    ${id}  ← ${users.join(', ')}（按 level 分派）`); continue; }
  if (b.questionConstants) {
    problems.push(`${id} 被 ${users.length} 卷共用，且求值器引用了**某一卷专属的真值/地标常量**`
      + ` → 后注册的实现在别卷会读错表：${users.join(', ')}`);
    continue;
  }
  console.log(`OK    ${id}  ← ${users.join(', ')}（与卷无关：只读该轮自己的数据）`);
}

console.log(`\n扫描 ${levels.length} 卷 / ${total} 条判据`);
if (problems.length) {
  console.log('\n★ 危险（共用但未分派）：');
  for (const p of problems) console.log(`   · ${p}`);
  console.log('\n改法二选一：求值器改成按 `level` 分派，或把 id 改成卷内独有的名字'
    + '（改名要同时改该卷 self-check 的期望）。');
  process.exit(1);
}
console.log('OK —— 没有危险的跨卷重名');
