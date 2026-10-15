#!/usr/bin/env node
// bench-run · 把一题跑一轮（自动化通道：dsh --profile headless）
//
// 它只负责"跑"，不负责"判"——打分是 bench-score.mjs 的事。
//
// 用法：
//   node examples/bench/tools/bench-run.mjs --level 01-mortise-bench \
//        --model deepseek-official/deepseek-flash [--reasoning-effort low]
//        [--repeat 3] [--tag myrun]
//   node examples/bench/tools/bench-run.mjs --level 03-microscope --variant headless --model …
//   node examples/bench/tools/bench-run.mjs --level 01-mortise-bench --dry-run
//
// 它做的八件事：
//   1. 在**仓库外**建 run root：考生目录里因此没有任何评分方材料的痕迹
//      （注意：这不等于物理隔离，Agent 仍能读绝对路径；见根 README §12.4）
//   2. 把 subjects/<level>/ 复制进去 → 语料天然干净，无需手工删 cad-data/
//   3. 按**变体**把该档需要的额外素材物化进 run root
//      （03 的 headless 档：把参考图复制成工作目录下的 参考图.png）
//   4. 核对每段题面的 sha256 与 rubric 记录一致；不一致就**拒绝开跑**
//   5. 检查该题需要的素材（02 的 608.stl、01b 的 dossier）
//   6. 生成当轮的 model-overlay.yml（钉 provider/model）
//   7. 逐段跑 dsh，事件流落 <run-root>/<stage>.events.jsonl
//      **第一段不带 --session-id**（它只认领已存在的会话，未知 id 会报错），
//      从第一段的事件流取回真正的 id，后续段用它继承同一会话
//      → 每段一份事件流，天然就是分界
//   8. 各段跑完后，逐个**探针轮**：用同一个会话发 rubric 里的 `ask`
//      （长程记忆探针要问才知道；`when` 的适用性由打分器判，runner 只负责问）
//   9. 写 <run-root>/run-record.json：退出码、耗时、usage、sessionId、
//      指纹核对结果、变体名、探针答案、以及**每一步的原命令**（可原样重放）
//
// 纪律（写死在代码里）：
//   * run root 绝不开在仓库内 —— `--root-dir` 若落在仓库里直接报错退出
//   * 需要附件的档位拒绝在 headless 下跑 —— headless 没有附图通道

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, '..');
const repoRoot = resolve(benchDir, '..', '..');
const subjectsDir = join(benchDir, 'subjects');
const gradersDir = join(benchDir, 'graders');
const skillOverlay = join(here, 'headless-overlay.yml');

// 每题的自动化参数。变体的键与 rubric.json 里的 `variants` 一一对应。
const LEVELS = {
  '01-mortise-bench': { needs: [] },
  '01b-diagnosis': { needs: ['dossier/assembly.json'] },
  '02-steam-engine': { needs: ['assets/608.stl'] },
  // 06：两个 STL 就是全部素材，考生 cwd 里必须有它们（`needs` 会在开跑前核对，
  // 缺件直接退出，而不是让模型在空目录里找零件）。件由评分方脚本生成、入库。
  '06-measure': { needs: ['part.stl', 'part-b.stl'] },
  // 04：第三方几何**不入库**（2026-10-12 决策），所以开跑前先物化——钉 commit 取件、
  // 校验全树摘要、编译成 STL 放进 run root。prep 失败即中止：宁可不开跑，
  // 也不要让模型在一个空目录里"找不到零件"。
  '04-rack-connector': {
    prep: ['node', 'examples/bench/graders/04-rack-connector/materialize.mjs'],
    needs: ['mainRail.stl', 'rackJoiner.stl'],
  },
  // 05：同样不入库，同样开跑前物化（给两件已画好的零件，要求正确装配）。
  '05-rack-assembly': {
    prep: ['node', 'examples/bench/graders/05-rack-assembly/materialize.mjs'],
    needs: ['xBar.stl', 'yBar.stl'],
  },
  '03-microscope': {
    defaultVariant: 'headless',
    variants: {
      headless: {
        copy: [{ from: 'graders/03-microscope/参考图.png', to: '参考图.png' }],
        needs: ['参考图.png'],
      },
      gui: {
        // 附件档在 headless 下跑不了：headless 的消息就是一段纯文本
        // （dsh-headless 的 Config = { task, sessionId, json }），没有把图片
        // 塞进消息的通道。但这一档不能丢——它覆盖 recall_reference_image。
        blocked: '这一档靠"参考图作为对话附件"发出，而 headless 没有附图通道'
          + '（dsh-headless 的 Config = { task, sessionId, json }）。'
          + '\n  要跑这一档：按根 README §5–§7 走 GUI/造物模式手工跑。'
          + '\n  它的价值是覆盖 recall_reference_image 这条插件能力，别丢。',
      },
    },
  },
};

const die = (msg) => { console.error(`bench-run: ${msg}`); process.exit(2); };

/** 读 rubric 的探针表（探针要主动问，否则永远测不到）。 */
async function loadProbes(level) {
  const rubric = JSON.parse(await readFile(join(gradersDir, level, 'rubric.json'), 'utf8'));
  return (rubric.probes ?? []).filter((p) => p.ask);
}

// ---------- argv ----------
function parseArgs(argv) {
  const out = { repeat: 1, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === '--level') out.level = next();
    else if (a === '--variant') out.variant = next();
    else if (a === '--model') out.model = next();
    else if (a === '--repeat') out.repeat = Number(next());
    else if (a === '--tag') out.tag = next();
    else if (a === '--root-dir') out.rootDir = next();
    else if (a === '--reasoning-effort') out.reasoningEffort = next();
    else if (a === '--no-probes') out.noProbes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else die(`unknown flag ${a}`);
  }
  if (!out.level) die('--level is required');
  if (!LEVELS[out.level]) die(`unknown level ${out.level} (have: ${Object.keys(LEVELS).join(', ')})`);
  if (!Number.isInteger(out.repeat) || out.repeat < 1) die('--repeat must be a positive integer');
  if (!out.dryRun && !out.model) die('--model <provider>/<model> is required unless --dry-run');
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end(opts.stdin);
    child.once('close', (code) => res({ code, stdout, stderr, ms: Date.now() - t0 }));
    child.once('error', (e) => res({ code: -1, stdout, stderr: String(e), ms: Date.now() - t0 }));
  });
}

/** 从 --json 的 NDJSON 里抽出打分要用的量。 */
function summarize(eventsText) {
  const out = { sessionId: null, cwd: null, turns: 0, usage: {}, toolCalls: [], finalText: '', turnEnd: null, unparsable: 0 };
  for (const line of eventsText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { out.unparsable++; continue; }
    if (e.type === 'session') { out.sessionId = e.sessionId ?? null; out.cwd = e.cwd ?? null; }
    else if (e.type === 'status') {
      if (e.phase === 'turn_start') out.turns++;
      if (e.phase === 'step_end' && e.usage) {
        for (const [k, v] of Object.entries(e.usage)) out.usage[k] = (out.usage[k] ?? 0) + (typeof v === 'number' ? v : 0);
      }
      if (e.phase === 'turn_end') out.turnEnd = e.reason ?? null;
    } else if (e.type === 'tool_call') out.toolCalls.push({ tool: e.tool, input: e.input });
    else if (e.type === 'final') out.finalText = e.text ?? '';
  }
  return out;
}

/** 读 rubric 的变体表；只有单一 taskFile 的题合成一个 default 变体。 */
async function loadVariants(level) {
  const rubric = JSON.parse(await readFile(join(gradersDir, level, 'rubric.json'), 'utf8'));
  const shape = (paths, sums) => {
    const p = Array.isArray(paths) ? paths : [paths];
    const s = Array.isArray(sums) ? sums : [sums];
    return p.map((path, i) => ({ path, sha256: s[i] ?? null })).filter((x) => x.path);
  };
  if (rubric.variants) {
    const out = {};
    for (const [name, v] of Object.entries(rubric.variants)) {
      if (!v || !v.taskFiles) continue;
      out[name] = shape(v.taskFiles, v.sha256);
    }
    return out;
  }
  if (rubric.taskFile) return { default: shape(rubric.taskFile.path, rubric.taskFile.sha256) };
  return {};
}

function assertRootOutsideRepo(root) {
  const r = resolve(root);
  if (r === repoRoot || r.startsWith(repoRoot + sep)) {
    die(
      `run root 落在仓库内：${r}\n` +
      `  run root 必须在仓库外——考生目录里不该有任何评分方材料的痕迹。\n` +
      `  （这不等于物理隔离：Agent 仍能读绝对路径；见 README §12.4）`,
    );
  }
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
const level = args.level;
const cfg = LEVELS[level];
const allVariants = await loadVariants(level);
const names = Object.keys(allVariants);
if (names.length === 0) die(`${level} 的 rubric.json 既没有 variants 也没有 taskFile —— 它可能没有考生（如 00-smoke）`);

// 选变体：多档时必须显式指定（或由 LEVELS 给默认）
const variantName = args.variant ?? cfg.defaultVariant ?? (names.length === 1 ? names[0] : null);
if (!variantName) die(`${level} 有多个变体（${names.join(' / ')}），请用 --variant 指定`);
if (!allVariants[variantName]) die(`未知变体 ${variantName}（${level} 有：${names.join(' / ')}）`);

const vcfg = cfg.variants?.[variantName] ?? {};
const taskFiles = allVariants[variantName];

if (vcfg.blocked && !args.dryRun) {
  console.error(`refusing to run ${level} --variant ${variantName}:\n  ${vcfg.blocked}`);
  process.exit(2);
}
if (!existsSync(skillOverlay)) die(`缺 ${skillOverlay}（headless 靠它把 CAD 手册接回来）`);

const baseRoot = args.rootDir ?? join('/tmp', `bench-${level}-${variantName}-${args.tag ?? stamp()}`);
assertRootOutsideRepo(baseRoot);

const needs = [...(cfg.needs ?? []), ...(vcfg.needs ?? [])];
console.log(`level   : ${level}${names.length > 1 ? `  (variant: ${variantName})` : ''}`);
console.log(`stages  : ${taskFiles.length} 段  ${taskFiles.map((t) => t.path.split('/').pop()).join(' → ')}`);
console.log(`model   : ${args.model ?? '(dry-run)'}`);
console.log(`repeat  : ${args.repeat}`);
console.log(`root    : ${baseRoot}`);
if (vcfg.copy?.length) console.log(`物化    : ${vcfg.copy.map((c) => `${c.from} → ${c.to}`).join(', ')}`);
if (vcfg.blocked) console.log('⚠ 该变体已标注：headless 下跑不了（--dry-run 仍可预览）');

const records = [];

for (let r = 1; r <= args.repeat; r++) {
  const runRoot = args.repeat === 1 ? baseRoot : join(baseRoot, `r${String(r).padStart(2, '0')}`);
  const sessionId = `bench-${level}-${variantName}-${args.tag ?? stamp()}-r${r}`;
  const rec = {
    level, variant: variantName, run: r, runRoot, sessionId,
    model: args.model ?? null,
    reasoningEffort: args.reasoningEffort ?? null,
    // tier 说的是"怎么跑的"（本 runner 一律走 headless），与变体是**两个维度**：
    // 变体决定参考图怎么送（附件 / 文件），tier 决定会话命名不命名预设。
    tier: 'headless（不命名预设）',
    stages: [], startedAt: new Date().toISOString(),
  };

  if (args.dryRun) {
    rec.stages = taskFiles.map((t, i) => ({
      task: t.path,
      cmd: `dsh --profile headless --patch ${join(runRoot, 'skill-overlay.yml')} --patch ${skillOverlay} --patch ${join(runRoot, 'model-overlay.yml')}`
        + ` --json`
        + (i === 0 ? '' : ' --session-id <第一段事件流报出的 sessionId>')
        + ` < ${join(runRoot, t.path.replace(/^subjects\/[^/]+\//, ''))}`,
      note: 'dry-run：未执行',
    }));
    // 探针轮也要列出来——否则操作者不知道跑完还会追问
    const pv = args.noProbes ? [] : await loadProbes(level);
    rec.probes = pv.map((pr) => ({ id: pr.id, ask: pr.ask, when: pr.when ?? null }));
    records.push(rec);
    console.log(`\n[r${r}] ${runRoot}`);
    for (const s of rec.stages) console.log(`  ${s.cmd}`);
    for (const pr of rec.probes) console.log(`  [探针 ${pr.id}] ${pr.when ? `when ${pr.when} → ` : ''}“${pr.ask}”`);
    continue;
  }

  // 1) run root + 考生侧副本
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await cp(join(subjectsDir, level), runRoot, { recursive: true });

  // 1b) 手册副本放到 run root 里，并生成一份指向它的 overlay。
  //
  // 为什么：skill 内容自带 `<skill_resources> Base directory for this skill: <abs path>`，
  // 而被检插件是 link 到仓库的 dev checkout —— 于是"仓库根"顺着手册路径进了考生上下文。
  // 实测（01 r01）：考生从手册里的仓库路径出发 `cd examples/bench && find .`，
  // 再 `cat graders/01-mortise-bench/{rubric.json,key.md,prompt.md}`，整轮作废。
  // 把手册复制到 run root 外置后，考生看到的基础目录在仓库之外，面包屑消失。
  const skillCopyDir = join(runRoot, '.skills');
  const repoSkillDir = join(repoRoot, 'dsh-cad-harness', 'skills');
  if (existsSync(repoSkillDir)) {
    await cp(repoSkillDir, skillCopyDir, { recursive: true });
  }
  const runSkillOverlay = join(runRoot, 'skill-overlay.yml');
  await writeFile(runSkillOverlay,
    `- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n`
    + `  config:\n    includeDefaultRoots: false\n    customSkillDirs:\n      - ${skillCopyDir}\n`, 'utf8');

  // 2) 按变体物化额外素材（03 headless：参考图进工作目录）
  for (const c of vcfg.copy ?? []) {
    const src = join(benchDir, c.from);
    if (!existsSync(src)) { console.error(`\n[r${r}] 变体素材缺失：${c.from}`); process.exit(1); }
    await cp(src, join(runRoot, c.to));
  }

  // 3) 素材检查
  // 3.5) 物化素材（如 04：第三方几何不入库，开跑前按钉死的 commit 取件）
  const prep = cfg.prep ?? vcfg.prep ?? null;
  if (prep) {
    const [cmd, ...args] = prep;
    console.log(`[r${r}] prep: ${prep.join(' ')} --out ${runRoot}`);
    const code = await run(cmd, [...args, '--out', runRoot], { cwd: join(benchDir, '..', '..'), stdio: 'inherit' })
      .then(() => 0, (err) => err?.code ?? 1);
    if (code !== 0) {
      console.error(`\n[r${r}] prep 失败（exit ${code}）——素材没到位，中止这一轮`);
      process.exit(1);
    }
  }

  for (const need of needs) {
    if (!existsSync(join(runRoot, need))) {
      console.error(`\n[r${r}] 缺素材 ${need} —— 02 的导入件见 README §3.1；04 的由 prep 物化`);
      process.exit(1);
    }
  }

  // 4) 指纹核对（不信当前文件，信 rubric 里记的）
  for (const t of taskFiles) {
    const local = t.path.replace(/^subjects\/[^/]+\//, '');
    const got = sha256(await readFile(join(runRoot, local)));
    if (t.sha256 && got !== t.sha256) {
      console.error(
        `\n[r${r}] 题面指纹不符：${t.path}\n  记录 ${t.sha256}\n  实测 ${got}\n` +
        `  考生目录里的题面 Agent 可写；改过就从未污染的副本恢复并在 rubric 里重录指纹。`,
      );
      process.exit(1);
    }
    rec.stages.push({ task: t.path, local, sha256: got, sha256Ok: true });
  }

  // 5) 当轮 model overlay
  const [provider, model] = (args.model ?? '').split('/');
  if (!provider || !model) die('--model 需为 <provider>/<model>');
  const modelOverlay = join(runRoot, 'model-overlay.yml');
  // README §5.3：同一模型、同一 reasoning 档位，并记进分数文件。不指定时沿用 profile
  // 默认——那样两臂虽可比，却与 GUI/造物模式档（web profile 里显式写着 reasoningEffort）
  // 不是一个档位，A/B 结论不能跨档引用。
  await writeFile(modelOverlay,
    `- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n`
    + `  config:\n    provider: ${provider}\n    model: ${model}\n`
    + (args.reasoningEffort ? `    reasoningEffort: ${args.reasoningEffort}\n` : ''), 'utf8');

  // 6) 逐段跑
  //    `--session-id` 是"**认领一个已存在**的会话"——未知 id 直接报错（实测）。
  //    所以第一段**不带**它，让 dsh 新建；从第一段的事件流取回真正的 id，
  //    后续段才用它继承同一个会话。
  console.log(`\n[r${r}] ${runRoot}  label=${sessionId}`);
  let aborted = false;
  let adoptedSessionId = null;
  for (const stage of rec.stages) {
    const eventsPath = join(runRoot, `${stage.local.replace(/\.md$/, '')}.events.jsonl`);
    const argv = ['--profile', 'headless', '--patch', runSkillOverlay, '--patch', skillOverlay, '--patch', modelOverlay, '--json'];
    if (adoptedSessionId) argv.push('--session-id', adoptedSessionId);
    const shown = `dsh ${argv.join(' ')} < ${stage.local}`;
    console.log(`  · ${shown}`);
    const res = await run('dsh', argv, { cwd: runRoot, stdin: await readFile(join(runRoot, stage.local)) });
    await writeFile(eventsPath, res.stdout, 'utf8');
    const s = summarize(res.stdout);
    Object.assign(stage, {
      cmd: shown, exitCode: res.code, ms: res.ms,
      events: eventsPath.replace(runRoot + sep, ''),
      stderrTail: res.stderr.trim().split('\n').slice(-3).join('\n'),
      sessionId: s.sessionId, turns: s.turns, usage: s.usage,
      toolCallCount: s.toolCalls.length, toolsUsed: [...new Set(s.toolCalls.map((t) => t.tool))],
      turnEnd: s.turnEnd, unparsableEvents: s.unparsable,
    });
    // 第一段报出的才是真 id；后续段继承它
    if (!adoptedSessionId && s.sessionId) adoptedSessionId = s.sessionId;
    if (stage.turns === 0) stage.note = '零轮次：可能是题面指纹/会话/凭据问题，先看 stderrTail';
    if (res.code !== 0) { aborted = true; console.error(`    退出码 ${res.code}，停止本轮后续段`); break; }
    if (!adoptedSessionId && rec.stages.length > 1) {
      aborted = true;
      console.error('    第一段的事件流没有报出 sessionId —— 后续段无法继承同一会话，停止');
      break;
    }
  }
  // 7) 探针轮：同一个会话，逐个问
  rec.probes = [];
  const probes = args.noProbes ? [] : await loadProbes(level);
  if (!aborted && adoptedSessionId && probes.length) {
    for (const pr of probes) {
      const evPath = join(runRoot, `probe-${pr.id}.events.jsonl`);
      const pargv = ['--profile', 'headless', '--patch', runSkillOverlay, '--patch', skillOverlay, '--patch', modelOverlay,
        '--json', '--session-id', adoptedSessionId];
      const shown = `dsh ${pargv.join(' ')} <<${pr.id} 的 ask>>`;
      console.log(`  · 探针 ${pr.id}: ${pr.ask.slice(0, 40)}…`);
      const pres = await run('dsh', pargv, { cwd: runRoot, stdin: pr.ask + '\n' });
      await writeFile(evPath, pres.stdout, 'utf8');
      const ps = summarize(pres.stdout);
      rec.probes.push({
        id: pr.id, ask: pr.ask, when: pr.when ?? null,
        cmd: shown, exitCode: pres.code, events: evPath.replace(runRoot + sep, ''),
        answer: ps.finalText, toolCallCount: ps.toolCalls.length,
        toolsUsed: [...new Set(ps.toolCalls.map((t) => t.tool))],
      });
    }
  }

  rec.aborted = aborted;
  rec.sessionIdAdopted = adoptedSessionId;
  rec.finishedAt = new Date().toISOString();
  records.push(rec);

  await writeFile(join(runRoot, 'run-record.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
  console.log(`  记录 → ${join(runRoot, 'run-record.json')}`);
}

if (!args.dryRun) {
  const index = join(baseRoot, 'runs-index.json');
  await writeFile(index, JSON.stringify({ level, variant: variantName, model: args.model, repeat: args.repeat, records }, null, 2) + '\n', 'utf8');
  console.log(`\n索引 → ${index}`);
  console.log('下一步：node examples/bench/tools/bench-score.mjs --run <run-root>（机检六列，能自动判的会判，其余列 UNKNOWN）。');
  console.log(`档位：${records[0]?.tier}${names.length > 1 ? ` · 变体 ${variantName}` : ''}——分数不要与 GUI/造物模式档混算。`);
}
