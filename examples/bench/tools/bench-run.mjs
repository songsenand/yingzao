#!/usr/bin/env node
// bench-run · 把一题跑一轮（自动化通道：dsh --profile headless）
//
// 它只负责"跑"，不负责"判"——打分是 bench-score.mjs 的事。
//
// 用法：
//   node examples/bench/tools/bench-run.mjs --level 01-mortise-bench \
//        --model deepseek-official/deepseek-flash [--repeat 3] [--tag myrun]
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
//      多段共用同一个 --session-id → 各自的事件流天然就是分界
//   8. 写 <run-root>/run-record.json：退出码、耗时、usage、sessionId、
//      指纹核对结果、变体名、以及**每一步的原命令**（可原样重放）
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
    tier: variantName === 'headless' ? 'headless（不命名预设）' : 'GUI / 造物模式',
    stages: [], startedAt: new Date().toISOString(),
  };

  if (args.dryRun) {
    rec.stages = taskFiles.map((t) => ({
      task: t.path,
      cmd: `dsh --profile headless --patch ${skillOverlay} --patch ${join(runRoot, 'model-overlay.yml')}`
        + ` --json --session-id ${sessionId} < ${join(runRoot, t.path.replace(/^subjects\/[^/]+\//, ''))}`,
      note: 'dry-run：未执行',
    }));
    records.push(rec);
    console.log(`\n[r${r}] ${runRoot}`);
    for (const s of rec.stages) console.log(`  ${s.cmd}`);
    continue;
  }

  // 1) run root + 考生侧副本
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await cp(join(subjectsDir, level), runRoot, { recursive: true });

  // 2) 按变体物化额外素材（03 headless：参考图进工作目录）
  for (const c of vcfg.copy ?? []) {
    const src = join(benchDir, c.from);
    if (!existsSync(src)) { console.error(`\n[r${r}] 变体素材缺失：${c.from}`); process.exit(1); }
    await cp(src, join(runRoot, c.to));
  }

  // 3) 素材检查
  for (const need of needs) {
    if (!existsSync(join(runRoot, need))) {
      console.error(`\n[r${r}] 缺素材 ${need} —— 02 的导入件见 README §3.1`);
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
  await writeFile(modelOverlay,
    `- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n`
    + `  config:\n    provider: ${provider}\n    model: ${model}\n`, 'utf8');

  // 6) 逐段跑
  console.log(`\n[r${r}] ${runRoot}  session=${sessionId}`);
  let aborted = false;
  for (const stage of rec.stages) {
    const eventsPath = join(runRoot, `${stage.local.replace(/\.md$/, '')}.events.jsonl`);
    const argv = ['--profile', 'headless', '--patch', skillOverlay, '--patch', modelOverlay, '--json', '--session-id', sessionId];
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
    if (stage.turns === 0) stage.note = '零轮次：可能是题面指纹/会话/凭据问题，先看 stderrTail';
    if (res.code !== 0) { aborted = true; console.error(`    退出码 ${res.code}，停止本轮后续段`); break; }
    if (!rec.sessionIdFromStream) rec.sessionIdFromStream = s.sessionId;
  }
  rec.aborted = aborted;
  rec.finishedAt = new Date().toISOString();
  records.push(rec);

  await writeFile(join(runRoot, 'run-record.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
  console.log(`  记录 → ${join(runRoot, 'run-record.json')}`);
}

if (!args.dryRun) {
  const index = join(baseRoot, 'runs-index.json');
  await writeFile(index, JSON.stringify({ level, variant: variantName, model: args.model, repeat: args.repeat, records }, null, 2) + '\n', 'utf8');
  console.log(`\n索引 → ${index}`);
  console.log('下一步：按 graders/<level>/rubric.json 打六列（bench-score.mjs 待实现）。');
  if (variantName !== 'headless') console.log(`⚠ 这一档属于「${records[0]?.tier}」，分数不要与 headless 档混算。`);
}
