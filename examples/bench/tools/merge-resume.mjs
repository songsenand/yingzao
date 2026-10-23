#!/usr/bin/env node
// merge-resume.mjs · 把续跑段并回 stage 事件流与 run-record，使 bench-score 看到"完整会话"
// 用法：node merge-resume.mjs <runRoot> <stageLocal e.g. TASK.md> <resumeEventsFile> <resumeExit>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [runRoot, stageLocal, resumeFile, resumeExitArg] = process.argv.slice(2);
const resumeExit = Number(resumeExitArg ?? 0);

function summarize(text) {
  const out = { turns: 0, usage: {}, toolCalls: 0, finalText: '', turnEnd: null };
  for (const line of text.split('\n')) {
    const s = line.trim(); if (!s) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (e.type === 'status') {
      if (e.phase === 'turn_start') out.turns++;
      if (e.phase === 'step_end' && e.usage) for (const [k, v] of Object.entries(e.usage)) {
        if (typeof v === 'number') out.usage[k] = (out.usage[k] ?? 0) + v;
      }
      if (e.phase === 'turn_end') out.turnEnd = e.reason ?? null;
      if (e.phase === 'turn_end' && e.error) out.turnEnd = { kind: 'error', error: e.error };
    } else if (e.type === 'tool_call') out.toolCalls++;
    else if (e.type === 'final') out.finalText = e.text ?? '';
  }
  return out;
}

const resumeText = await readFile(join(runRoot, resumeFile), 'utf8');
const rs = summarize(resumeText);

// 续跑墙钟：note 文件（续跑起点写入）与事件流文件（结束时落盘）的 mtime 差
const { stat } = await import('node:fs/promises');
let resumeMs = 0;
try {
  const t0 = (await stat(join(runRoot, 'resume-note.txt'))).mtimeMs;
  const t1 = (await stat(join(runRoot, resumeFile))).mtimeMs;
  resumeMs = Math.max(0, t1 - t0);
} catch { /* 取不到就记 0 */ }

const recPath = join(runRoot, 'run-record.json');
const rec = JSON.parse(await readFile(recPath, 'utf8'));
const stage = rec.stages.find((s) => s.local === stageLocal || (s.task ?? '').endsWith(stageLocal));
if (!stage) { console.error('stage not found'); process.exit(2); }

// 1) 事件流拼接（原文不动，续段追加在后——同会话的时间顺序）
const stageEvents = join(runRoot, stageLocal.replace(/\.md$/, '') + '.events.jsonl');
const orig = await readFile(stageEvents, 'utf8');
await writeFile(stageEvents, orig.replace(/\n?$/, '\n') + resumeText.replace(/\n?$/, '\n'), 'utf8');

// 2) run-record stage 字段合并
stage.exitCode = resumeExit;
stage.turns = (stage.turns ?? 0) + rs.turns;
stage.toolCallCount = (stage.toolCallCount ?? 0) + rs.toolCalls;
stage.ms = (stage.ms ?? 0) + resumeMs;
stage.usage = mergeUsage(stage.usage, rs.usage);
stage.note = `含配额中断后续跑段（${resumeFile}，exit=${resumeExit}）`;

rec.finishedAt = new Date().toISOString();
rec.aborted = false;
if (rs.turnEnd && typeof rs.turnEnd !== 'string') stage.turnEnd = rs.turnEnd;
else if (rs.turnEnd) stage.turnEnd = rs.turnEnd;

await writeFile(recPath, JSON.stringify(rec, null, 2) + '\n', 'utf8');
console.log(`merged: tools+=${rs.toolCalls} turns+=${rs.turns} finalChars=${rs.finalText.length} exit=${resumeExit}`);

function mergeUsage(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
