#!/usr/bin/env node
// build-manual-manifest.mjs · 汇总各题的"需人判"材料 → render-manual-scoring.py 的 manifest
//
// 用法：node build-manual-manifest.mjs <runRoot> <scoreJson> <level> [--stage A|B]
// 输出：stdout 一份 sections JSON（由外层脚本拼进总 manifest）
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const [runRoot, scorePath, level, stageFlag] = process.argv.slice(2);
const stage = stageFlag ? stageFlag.split('=')[1] : null;
const score = JSON.parse(await readFile(scorePath, 'utf8'));
const record = JSON.parse(await readFile(join(runRoot, 'run-record.json'), 'utf8'));

// --- 事件流：取 final 全文与工具调用统计 ---
async function readStageEvents(local) {
  const p = join(runRoot, local.replace(/\.md$/, '') + '.events.jsonl');
  if (!existsSync(p)) return null;
  const finals = []; const texts = []; let toolCalls = 0;
  for (const line of (await readFile(p, 'utf8')).split('\n')) {
    const s = line.trim(); if (!s) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (e.type === 'final') finals.push(e.text ?? '');
    if (e.type === 'text') texts.push(e.text ?? '');
    if (e.type === 'tool_call') toolCalls++;
  }
  return { final: finals.join('\n'), texts: texts.join('\n'), toolCalls };
}

const sections = [];
const blocks = [];
const title = `${level}${stage ? ` · ${stage} 段` : ''} — ${score.model}（${score.tier ?? 'headless'}）`;

// --- 1. 成本与机检摘要 ---
const c = score.measured?.cost ?? {};
const st = record.stages ?? [];
blocks.push({ kind: 'kv', items: [
  ['S0 手册加载', score.skillLoaded ? '已加载' : '未观测到加载'],
  ['机检 P', String(score.computed?.P ?? '—')],
  ['机检 S', String(score.computed?.S ?? '—')],
  ['工具调用', `${c.toolCallsTotal ?? c.toolCalls ?? '?'} / 预算 ${c.toolCallBudget ?? '?'}`],
  ['墙钟', `${c.wallClockMin ?? '?'} min / 预算 ${c.wallClockBudgetMin ?? '?'} min`],
  ['token', JSON.stringify(c.tokens ?? {})],
  ['自动判定覆盖', `${score.coverage?.auto ?? '?'}/${score.coverage?.total ?? '?'}`],
]});
if ((score.coverageGaps ?? []).length) {
  for (const g of score.coverageGaps) blocks.push({ kind: 'text', body: `⚠ ${g}`, dim: true });
}
blocks.push({ kind: 'gap' });

// --- 2. 需人判条目（UNKNOWN / FAIL 附证据） ---
const needHuman = [];
for (const g of score.gates ?? []) if (g.ok !== true) needHuman.push({ head: g.id, tag: g.ok === false ? 'FAIL' : 'UNKNOWN', body: `判据：${g.detail}` });
for (const ck of score.checks ?? []) if (ck.ok !== true) needHuman.push({ head: ck.id, tag: ck.ok === false ? 'FAIL' : 'UNKNOWN', body: `判据：${ck.detail}` });
for (const pr of score.probes ?? []) if (pr.ok !== true) needHuman.push({ head: pr.id, tag: pr.ok === false ? 'FAIL' : 'UNKNOWN', body: `判据：${pr.detail}` });
if (needHuman.length) {
  blocks.push({ kind: 'text', body: '以下条目机检不能定论（FAIL=机检判不过但语义可能可辩；UNKNOWN=机检无判据），请人工给分：' });
  blocks.push({ kind: 'items', items: needHuman });
} else {
  blocks.push({ kind: 'text', body: '（本题全部条目机检可判，无 UNKNOWN。）', dim: true });
}
blocks.push({ kind: 'gap' });

// --- 3. 各段回答全文（E/H 的核心证据） ---
const stageFiles = st.map((s) => s.local ?? s.task).filter(Boolean);
for (const local of stageFiles) {
  if (stage && !local.includes(stage)) continue;
  const ev = await readStageEvents(local);
  if (!ev) continue;
  blocks.push({ kind: 'text', body: `【${basename(local)} 的交卷回答全文（final 事件）· 工具调用 ${ev.toolCalls} 次】` });
  blocks.push({ kind: 'text', body: ev.final || '（无 final 事件——见事件流）', mono: false });
  if (ev.texts) {
    blocks.push({ kind: 'text', body: `【同段中间陈述（text 事件，E/H 证据的一部分）】` });
    blocks.push({ kind: 'text', body: ev.texts, mono: false });
  }
  blocks.push({ kind: 'gap' });
}

// --- 4. 探针问答（R 列证据，全文） ---
for (const p of record.probes ?? []) {
  blocks.push({ kind: 'items', items: [{ head: `探针 ${p.id}（R 列证据）`, tag: 'INFO', body: `问：${p.ask}\n答：${p.answer || '（无回答）'}` }] });
}
if ((record.probes ?? []).length) blocks.push({ kind: 'gap' });

// --- 5. 交付的机读文件（若有） ---
for (const f of ['joinery.json', 'motion.json', 'stability.json', 'optics.json', 'printability.json', 'measure.json']) {
  const p = join(runRoot, f);
  if (existsSync(p)) {
    let body = await readFile(p, 'utf8');
    if (body.length > 2600) body = body.slice(0, 2600) + `\n…（截断，全文见 ${p}）`;
    blocks.push({ kind: 'text', body: `交付文件 ${f}：` });
    blocks.push({ kind: 'text', body, mono: true });
  }
}

sections.push({ title, blocks });
console.log(JSON.stringify({ level, stage, sections }));
