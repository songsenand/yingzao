#!/usr/bin/env node
// bench-score · 读一个 run root，按 rubric 打六列
//
// 用法：
//   node examples/bench/tools/bench-score.mjs --run /home/…/bench-runs/01-base01
//   node examples/bench/tools/bench-score.mjs --run <dir> --json
//
// 设计立场（重要）：
//   **判据只有 rubric.json 那一份。** 本脚本不发明判据、不改判据；
//   它只做"能不能机检"这一件事，且**绝不把没实现的条目算成通过**——
//   没有求值器的条目一律记 `UNKNOWN`，并打印它需要看哪份证据。
//   所以输出里 `自动判定 N/M` 是必须一起读的数字。
//
// 六列里能机检的与不能机检的（诚实分界）：
//   P 通过   ← gates 全过 + checks 加权率（gatePolicy: any-fail => P = 0）
//   S 生效度 ← 只对 inSkill:true 的条目计权（S0=false 时记 N/A）
//   C 成本   ← 实测：轮次 / 工具调用 / 墙钟 / token，对照 rubric.budget
//   E 证据   ← 需人判（本脚本给出证据指针）
//   H 诚实   ← 需人判（本脚本标出与语料矛盾的候选，不代替判断）
//   R 记忆   ← 需人判（探针要读懂回答；本脚本把提问与回答原文摘出来）

import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, '..');
const gradersDir = join(benchDir, 'graders');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const runRoot = opt('--run');
if (!runRoot) { console.error('bench-score: --run <run-root> is required'); process.exit(2); }
const AS_JSON = flag('--json');

// 触达即作废的评分方文件（各题第一条硬门）
const FORBIDDEN = [
  /examples\/bench\/graders/,
  /(?:^|[\s"'(=])graders\//,
  /(?:^|[\s"'(=])key\.md\b/,
  /(?:^|[\s"'(=])rubric\.json\b/,
  /(?:^|[\s"'(=])landmarks\.json\b/,
];

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

/** 自解析二进制 STL 的包围盒尺寸（打分器保持自包含，不引插件内部模块）。 */
function stlBounds(buf) {
  if (buf.length < 84) return null;
  const n = buf.readUInt32LE(80);
  if (buf.length < 84 + n * 50) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
      const x = buf.readFloatLE(o + v * 12 + a * 4);
      if (x < lo[a]) lo[a] = x;
      if (x > hi[a]) hi[a] = x;
    }
  }
  return { min: lo, max: hi };
}

function stlSize(buf) {
  if (buf.length < 84) return null;
  const n = buf.readUInt32LE(80);
  if (buf.length < 84 + n * 50) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;                       // 跳过法向
    for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
      const x = buf.readFloatLE(o + v * 12 + a * 4);
      if (x < lo[a]) lo[a] = x;
      if (x > hi[a]) hi[a] = x;
    }
  }
  return [0, 1, 2].map((a) => +(hi[a] - lo[a]).toFixed(2));
}

// ---------- 载入 ----------
const record = await readJson(join(runRoot, 'run-record.json'));
if (!record) { console.error(`bench-score: ${runRoot}/run-record.json 不存在——这是 bench-run.mjs 的产物`); process.exit(2); }
const level = record.level;
const variant = record.variant;
const rubric = await readJson(join(gradersDir, level, 'rubric.json'));
if (!rubric) { console.error(`bench-score: 找不到 ${level} 的 rubric.json`); process.exit(2); }

// 事件流：每段一份
const events = [];
for (const stage of record.stages ?? []) {
  if (!stage.events) continue;
  const p = join(runRoot, stage.events);
  if (!existsSync(p)) continue;
  const rows = [];
  for (const line of (await readFile(p, 'utf8')).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 投影里可能有非 JSON 行 */ }
  }
  events.push({ stage, rows });
}
const allEvents = events.flatMap((e) => e.rows);

// ---------- 子会话（subagent）----------
// **父会话的事件流里没有子代理的工具调用。** 不读它们会造成两个错：
//   * C 列的工具数偏低（一次委派能跑掉几十次调用）；
//   * g-grader-access 只扫父会话 —— 子代理若读了评分方文件，抓不到。
// 子会话与父会话同级存放在 ~/.dsh/sessions/<cwd 转义>/<sessionId>/。
function projectSessionDir(root) {
  const slug = resolve(root).replace(/^\//, '').replace(/\//g, '-');
  return join(homedir(), '.dsh', 'sessions', `--${slug}--`);
}
const childCalls = [];
const childNotes = [];
{
  const dir = projectSessionDir(runRoot);
  const parentDir = record.sessionIdAdopted ?? null;      // 形如 session-<uuid>
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { /* 没有会话目录 */ }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    // 父会话目录名以 session- 开头；其余按子会话处理
    if (parentDir && d.name === parentDir) continue;
    if (!parentDir && d.name.startsWith('session-')) continue;
    const f = join(dir, d.name, 'session.v4.jsonl.zstd');
    if (!existsSync(f)) continue;
    try {
      const raw = zstdDecompressSync(await readFile(f)).toString('utf8');
      let n = 0;
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let e; try { e = JSON.parse(t); } catch { continue; }
        if (e.type !== 'tool/call') continue;
        const dd = e.data ?? {};
        let input = {};
        try { input = JSON.parse(dd.arguments ?? '{}'); } catch { input = { _raw: dd.arguments }; }
        childCalls.push({ tool: dd.name, input, callId: dd.callId, from: d.name });
        n++;
      }
      childNotes.push(`${d.name}: ${n} 次调用`);
    } catch (err) {
      childNotes.push(`${d.name}: 读取失败(${String(err?.message ?? err).slice(0, 40)})`);
    }
  }
}
const toolCalls = allEvents.filter((e) => e.type === 'tool_call');
const toolResults = allEvents.filter((e) => e.type === 'tool_result');
const finalText = allEvents.filter((e) => e.type === 'final').map((e) => e.text ?? '').join('\n\n');

// 父 + 子会话的全部工具调用：泄漏扫描与 C 列都用这一份
const everyCall = [...toolCalls, ...childCalls];

// 语料：两种布局都要认
//   * 实时语料（01/02/03）：<run>/cad-data/{manifest.json,runs/,versions/} + <run>/assembly/assembly.json
//   * 证据目录（01b）：<run>/dossier/{cad-data-manifest.json,assembly.json,runs/}
//     —— 01b 的考生读的是 dossier，不是实时语料；只认前一种会让它的语料类条目全判错。
const pick = (...ps) => ps.find((x) => x && existsSync(x)) ?? null;
const manifestPath = pick(join(runRoot, 'cad-data', 'manifest.json'), join(runRoot, 'dossier', 'cad-data-manifest.json'));
const assemblyPath = pick(join(runRoot, 'assembly', 'assembly.json'), join(runRoot, 'dossier', 'assembly.json'));
const runsDir = pick(join(runRoot, 'cad-data', 'runs'), join(runRoot, 'dossier', 'runs'));
const versionsDir = pick(join(runRoot, 'cad-data', 'versions'));

const corpus = {
  manifest: manifestPath ? await readJson(manifestPath) : null,
  assembly: assemblyPath ? await readJson(assemblyPath) : null,
  runs: [],
  datums: {},
  files: {},
};
corpus.root = corpus.assembly?.root ?? null;
corpus.children = corpus.root?.children ?? [];
corpus.interfaces = corpus.root?.interfaces ?? [];
try {
  for (const d of await readdir(runsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const r = await readJson(join(runsDir, d.name, 'run.json'));
    if (!r) continue;
    // 结构化报告优先：**别去正则中文 summary**（实测踩过——把故意的阴性对照
    // 当成失败，于是给一个本来通过的运行记了 P=0）
    r.report = await readJson(join(runsDir, d.name, 'report.json'));
    corpus.runs.push(r);
  }
} catch { /* 还没有 run */ }
try {
  for (const d of await readdir(versionsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dj = await readJson(join(versionsDir, d.name, 'datums.json'));
    if (dj) corpus.datums[d.name] = dj;
  }
} catch { /* 还没建版本 */ }
// 进口件的实际尺寸（进口件没有 SCAD 参数可读，只能量 STL）
corpus.importedBbox = {};
for (const v of corpus.manifest?.versions ?? []) {
  if (v.source?.kind !== 'imported') continue;
  const f = pick(
    versionsDir ? join(versionsDir, v.id, 'model.stl') : null,
    join(runRoot, 'cad-data', 'versions', v.id, 'model.stl'),
    join(runRoot, 'dossier', 'versions', v.id, 'model.stl'),
  );
  if (f) { const b = await readFile(f); corpus.importedBbox[v.id] = stlSize(Buffer.from(b)); }
}

// 考生产出的机读文件（rubric 的 via 直接点名，如 joinery.json）
for (const f of ['joinery.json', 'motion.json', 'stability.json', 'optics.json', 'printability.json']) {
  const v = await readJson(join(runRoot, f));
  if (v) corpus.files[f] = v;
}

const runsByKind = (k) => corpus.runs.filter((r) => r.kind === k);
const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// ---------- 求值器 ----------
// 每个返回 { ok: boolean|'unknown', detail: string }
const EV = {};

// —— transcript ——
EV['g-grader-access'] = () => {
  const hits = [];
  for (const c of everyCall) {
    const blob = JSON.stringify(c.input ?? {});
    for (const re of FORBIDDEN) if (re.test(blob)) hits.push(`${c.tool} ${blob.slice(0, 90)}`);
  }
  // 工具结果里出现评分方文件内容也算（例如 glob 列目录把它列出来）
  for (const r of toolResults) {
    const blob = String(r.result ?? '');
    if (/examples\/bench\/graders|landmarks\.json/.test(blob)) hits.push(`tool_result ${blob.slice(0, 90)}`);
  }
  const kids = toolCalls.filter((c) => /subagent|fork/i.test(String(c.tool)));
  const scope = kids.length
    ? `父会话 ${toolCalls.length} 次 + 子会话 ${childCalls.length} 次（${childNotes.join('；') || '无子会话记录'}）`
    : `父会话 ${toolCalls.length} 次`;
  return {
    ok: hits.length === 0,
    detail: (hits.length ? `触达 ${hits.length} 次：${hits[0]}` : `扫过 ${scope}，零触达`),
  };
};

const skillLoaded = () =>
  toolCalls.some((c) => c.tool === 'skill' && /cad-toolbox/.test(JSON.stringify(c.input ?? {}))) ||
  toolResults.some((r) => /<skill_content name="cad-toolbox"/.test(String(r.result ?? '')));

// —— 语料：装配检查报告（结构化）——
const asmChecks = () => corpus.runs.filter((r) => r.kind === 'assembly-check' && r.report);
const lastAsm = () => asmChecks().at(-1);
const hardOf = (r) => r?.report?.summary?.hardViolations ?? null;

// 阴性对照三连：命中 → 还原 → 最终态为零。所以 g-hard-zero 看的是**最终态**，
// 不是"任何一次运行都没报过硬冲突"（那样会把对照本身判成失败）。
EV['g-hard-zero'] = () => {
  const last = lastAsm();
  if (!last) return { ok: 'unknown', detail: '没有装配检查报告' };
  const n = hardOf(last);
  return { ok: n === 0, detail: `最终态 ${last.id}: hardViolations=${n}, overallStatus=${last.report.overallStatus}` };
};
EV['g-negative-control-fires'] = () => {
  const hit = asmChecks().find((r) => hardOf(r) >= 1 && r.report.overallStatus === 'fail');
  return { ok: !!hit, detail: hit ? `${hit.id}: hardViolations=${hardOf(hit)} · fail` : `扫过 ${asmChecks().length} 次装配检查，无一次触发` };
};
EV['g-negative-reverted'] = () => {
  const list = asmChecks();
  const fired = list.findIndex((r) => hardOf(r) >= 1);
  const after = fired < 0 ? [] : list.slice(fired + 1).filter((r) => hardOf(r) === 0 && r.report.overallStatus === 'pass');
  return { ok: after.length > 0, detail: after.length ? `${after[0].id} 已回到 hardViolations=0 · pass` : '对照之后没有回到"零硬冲突且通过"的状态' };
};
EV['g-undeclared-found'] = () => {
  const all = asmChecks().flatMap((r) => r.report.undeclared ?? []);
  const want = all.some((u) => /端枨|stretcher/.test(JSON.stringify(u)) && /座面|seat/.test(JSON.stringify(u)));
  return {
    ok: want,
    detail: all.length ? `undeclared ${all.length} 条，含目标那一对=${want}` : `全部 ${asmChecks().length} 次检查的 undeclared 都是空的`,
  };
};
EV['g-coaxial-not-two-points'] = () => {
  const last = lastAsm();
  if (!last) return { ok: 'unknown', detail: '没有装配检查报告' };
  const n = (last.report.results ?? []).filter((r) => r.check === 'coaxial').length;
  return { ok: n >= 1, detail: `coaxial 检查 ${n} 条（用两点代替同轴会表现为 0 条）` };
};
EV['c-shoulder-seats'] = () => {
  const last = lastAsm();
  if (!last) return { ok: 'unknown', detail: '没有装配检查报告' };
  const sh = (last.report.results ?? []).filter((r) => /shoulder|肩/.test(r.interfaceId ?? ''));
  const bad = sh.filter((r) => r.verdict !== 'pass');
  return { ok: sh.length > 0 && bad.length === 0, detail: `肩面接口 ${sh.length} 条，非 pass ${bad.length} 条` };
};

// —— 语料：装配契约 ——
const needAssembly = () => (corpus.root ? null : { ok: 'unknown', detail: '没有 assembly/assembly.json（考生没交付契约）' });
EV['c-interface-count'] = () => needAssembly() ?? {
  ok: corpus.interfaces.length >= (level === '03-microscope' ? 12 : level === '02-steam-engine' ? 8 : 6),
  detail: `interfaces=${corpus.interfaces.length}（注：x/y 双向覆盖未单独校验）`,
};
EV['c-coaxial-used'] = () => needAssembly() ?? (() => {
  const n = corpus.interfaces.filter((i) => i.check === 'coaxial').length;
  return { ok: n >= 2, detail: `契约里 check=coaxial 的接口 ${n} 条` };
})();
EV['c-motion-typed-count'] = () => needAssembly() ?? (() => {
  const motion = corpus.interfaces.filter((i) => /转动副|滑动副|螺旋副|齿轮副/.test(String(i.type ?? '')));
  return { ok: motion.length === 6, detail: `运动类接口 ${motion.length} 条（期望 6）` };
})();
EV['g-no-metal-fasteners'] = () => needAssembly() ?? (() => {
  const bad = corpus.children.filter((c) => /^M\d|螺钉|螺栓|螺母|螺丝/.test(`${c.name ?? ''}${c.material ?? ''}`))
    .concat(corpus.interfaces.filter((i) => /M\d+[×x]/.test(String(i.note ?? '')) && /紧固|螺钉|螺栓/.test(String(i.note ?? ''))));
  return { ok: bad.length === 0, detail: bad.length ? `命中 ${bad.length} 条：${bad[0].name ?? bad[0].id}` : '无金属紧固件条目' };
})();
EV['g-one-version-per-repeated-part'] = () => needAssembly() ?? (() => {
  const byName = {};
  for (const c of corpus.children) (byName[c.name ?? c.id] ??= new Set()).add(c.version);
  const dup = Object.entries(byName).filter(([, v]) => v.size > 1);
  return { ok: dup.length === 0, detail: dup.length ? `重复件有多个版本：${dup.map(([n, v]) => `${n}×${v.size}`).join(', ')}` : `${Object.keys(byName).length} 个件各一个版本` };
})();

// —— 考生产出的 joinery.json ——
// 阈值以 rubric.json 的 `expect` 为准（01 的三条于 2026-10-08 补写）；脚本只实现，不发明。
const J = () => corpus.files['joinery.json'];
const gapsOf = () => {
  const f = J()?.fits;
  const a = f?.seatTenonAlongGrain?.gapMm, b = f?.seatTenonAcrossGrain?.gapMm;
  return typeof a === 'number' && typeof b === 'number' ? { a, b } : null;
};
EV['c-grain-axis-correct'] = () => {
  const j = J(); if (!j) return { ok: 'unknown', detail: '没有 joinery.json' };
  return { ok: j.seatGrainAxis === 'x', detail: `seatGrainAxis=${JSON.stringify(j.seatGrainAxis)}（expect: === 'x'）` };
};
EV['c-across-grain-looser'] = () => {
  const g = gapsOf(); if (!g) return { ok: 'unknown', detail: 'joinery.json.fits 缺 gapMm' };
  return { ok: g.b >= 2 * g.a && g.b >= 0.3, detail: `横纹 ${g.b}mm vs 顺纹 ${g.a}mm（expect: 横纹 ≥ 2×顺纹 且 ≥0.3）` };
};
EV['c-gaps-in-range'] = () => {
  const g = gapsOf(); if (!g) return { ok: 'unknown', detail: 'joinery.json.fits 缺 gapMm' };
  const aOk = g.a >= 0.05 && g.a <= 0.20, bOk = g.b >= 0.30 && g.b <= 1.00;
  return { ok: aOk && bOk, detail: `顺纹 ${g.a}mm ∈[0.05,0.20] = ${aOk}；横纹 ${g.b}mm ∈[0.30,1.00] = ${bOk}` };
};
EV['c-blind-tenon-shorter'] = () => {
  const b = J()?.blindTenon; if (!b) return { ok: 'unknown', detail: 'joinery.json.blindTenon 缺项' };
  const relief = +(b.mortiseDepthMm - b.tenonLengthMm).toFixed(2);
  return {
    ok: b.tenonLengthMm < b.mortiseDepthMm && relief >= 1.5 && relief <= 3.0,
    detail: `榫头 ${b.tenonLengthMm} < 孔深 ${b.mortiseDepthMm}，余量 ${relief}mm ∈ [1.5, 3.0]`,
  };
};

// —— run 级别（各题通用）——
// 注意两个 kind 是**两个不同的工具**：
//   `assembly`       = validate_assembly（几何干涉/过紧，parts 是覆盖的件数）
//   `assembly-check` = check_assembly（契约逐条判，parts 恒为 0）
// 03 的 rubric 里明写 `kind === 'assembly'`；用错 kind 会让"整机验证"类条目全判错（踩过）。
const wholeRuns = () => corpus.runs.filter((r) => r.kind === 'assembly');
EV['c-whole-machine-runs'] = () => {
  const n = wholeRuns().filter((r) => (r.parts ?? []).length >= 16).length;
  return { ok: n === 2, detail: `覆盖 ≥16 件的 validate_assembly ${n} 次（期望 2）；validate_assembly 总计 ${wholeRuns().length} 次` };
};
EV['c-post-subset-sizes'] = () => {
  const all = wholeRuns();
  // 从**最后一次**整机运行算起：r046 与 r048 都是 16 件，用 findIndex 会把 r048
  // 自己算进"之后"，于是报出 16 —— 那是我的 bug，不是考生的（踩过）。
  let i = -1;
  for (let k = 0; k < all.length; k++) if ((all[k].parts ?? []).length >= 16) i = k;
  const after = i < 0 ? [] : all.slice(i + 1).map((r) => (r.parts ?? []).length);
  return {
    ok: after.length > 0 && after.every((n) => [4, 6].includes(n)),
    detail: `整机之后的覆盖数：${after.length ? [...new Set(after)].sort().join(', ') : '（无）'}（要求 ⊆ {4,6}）`,
  };
};
EV['g-whole-machine-failed'] = () => {
  const whole = wholeRuns().filter((r) => (r.parts ?? []).length >= 16);
  const failed = whole.filter((r) => r.status === 'fail');
  const cited = ['r046', 'r048'].filter((id) => new RegExp(id).test(finalText));
  return {
    ok: whole.length === 2 && failed.length === 2 && cited.length === 2,
    detail: `≥16 件的 validate_assembly ${whole.length} 次、fail ${failed.length} 次；回答点名 ${cited.join('/') || '（无）'}`,
  };
};
EV['g-whole-machine-verified'] = () => {
  const want = corpus.children.length || null;   // 交付件数（契约里的 children）
  const pass = wholeRuns().filter((r) => r.status === 'pass' && (want ? (r.parts ?? []).length === want : (r.parts ?? []).length >= 2));
  return {
    ok: pass.length > 0,
    detail: pass.length ? `${pass[0].id}: ${(pass[0].parts ?? []).length} 件 · pass` : `没有"覆盖全部交付件且 pass"的 validate_assembly（交付件 ${want ?? '?'}）`,
  };
};

// —— 版本库 datums ——
EV['g-datums-declared'] = () => {
  const versions = (corpus.manifest?.versions ?? []).map((v) => v.id);
  if (!versions.length) return { ok: 'unknown', detail: '没有 manifest.versions' };
  const latestByPart = {};
  for (const v of corpus.manifest.versions) latestByPart[v.partId ?? v.id] = v.id;   // 按出现在 manifest 里的顺序取最后一个
  const parts = Object.entries(latestByPart);
  const bad = parts.filter(([, vid]) => {
    const dj = corpus.datums[vid];
    if (!dj) return true;
    return !['points', 'axes', 'planes'].some((k) => (dj[k] ?? []).length > 0);
  });
  return {
    ok: bad.length === 0,
    detail: bad.length ? `${bad.length} 个件的终版没有 datum：${bad.map(([p, v]) => `${p}(${v})`).join(', ')}`
      : `${parts.length} 个件各 ≥1 个 datum（扫过 ${versions.length} 个版本的 datums.json）`,
  };
};

// —— 出榫尺寸（via: measure_distance）——
EV['c-protrusion'] = () => {
  const dist = toolCalls.filter((c) => /measure_distance|measure_closest/.test(String(c.tool)));
  if (!dist.length) return { ok: false, detail: '零 measure_distance 调用——出榫 5mm 从未被验证（契约里也没有对应条目）' };
  const nums = toolResults.flatMap((r) => (String(r.result ?? '').match(/-?\d+\.\d+/g) ?? []).map(Number));
  const hit = nums.filter((n) => n >= 4.5 && n <= 5.5);
  return {
    ok: hit.length > 0,
    detail: hit.length ? `${dist.length} 次测量，出现落在 [4.5,5.5] 的值 ${hit[0]}mm` : `${dist.length} 次测量，但没有落在 [4.5,5.5] 的结果`,
  };
};

// —— 02：运动 / 物理 / 流体 / 进口件 ——
const lastRunOf = (k) => corpus.runs.filter((r) => r.kind === k).at(-1);
const mOf = (r) => r?.report?.metrics ?? {};

EV['g-motion-clean'] = () => {
  const r = lastRunOf('motion');
  if (!r) return { ok: 'unknown', detail: '没有 motion 运行' };
  const m = mOf(r);
  return {
    ok: r.status === 'pass' && m.interferenceCount === 0 && (m.jointViolations ?? []).length === 0,
    detail: `${r.id}: status=${r.status} · 干涉=${m.interferenceCount} · 关节违反=${(m.jointViolations ?? []).length}`,
  };
};
EV['g-negative-rod-fires'] = () => {
  const hit = corpus.runs.filter((r) => r.kind === 'motion' && (mOf(r).interferenceCount ?? 0) >= 1);
  return { ok: hit.length >= 1, detail: hit.length ? `${hit.map((r) => r.id).join('/')} 报出干涉` : '无一次运动仿真报干涉（阴性对照没响）' };
};
EV['c-stroke'] = () => {
  const r = lastRunOf('motion');
  const travels = Object.values(mOf(r).followers ?? {}).map((f) => f.travelMm).filter((x) => typeof x === 'number');
  const max = travels.length ? Math.max(...travels) : null;
  return {
    ok: max !== null && Math.abs(max - 40) <= 0.5,
    detail: `运动仿真实测最大行程 ${max ?? '?'}mm（expect: 40）；motion.json 声明 ${corpus.files['motion.json']?.strokeMm ?? '?'}`,
  };
};
EV['c-fluid-arrival'] = () => {
  const r = lastRunOf('fluid');
  if (!r) return { ok: 'unknown', detail: '没有 fluid 运行' };
  const m = mOf(r);
  return {
    ok: (m.outletArrivalRatio ?? 0) > 0.6 && (m.penetrationCount ?? 1) === 0,
    detail: `${r.id}: outletArrivalRatio=${m.outletArrivalRatio}（>0.6）· penetrationCount=${m.penetrationCount}（==0）`,
  };
};
EV['g-motion-clearance-contract'] = () => needAssembly() ?? (() => {
  const mc = corpus.interfaces.filter((i) => i.check === 'motion-clearance');
  const passMotion = new Set(corpus.runs.filter((r) => r.kind === 'motion' && r.status === 'pass').map((r) => r.id));
  const cited = mc.map((i) => i.params?.runId).filter(Boolean);
  const good = cited.filter((id) => passMotion.has(id));
  return {
    ok: mc.length >= 2 && cited.length === mc.length && good.length === cited.length,
    detail: `check=motion-clearance ${mc.length} 条；引用 runId ${cited.length} 个，其中指向 pass 的运动仿真 ${good.length} 个`,
  };
})();
EV['g-import-not-generate'] = () => {
  // 注意 source 是**对象** {kind:'imported', file}，不是字符串
  const imported = (corpus.manifest?.versions ?? []).filter((v) => v.source?.kind === 'imported');
  return {
    ok: imported.length >= 1,
    detail: imported.length ? `${imported.map((v) => v.id).join('/')} 为 imported（${imported[0].source?.file ?? ''}）` : '没有任何 source.kind === imported 的版本',
  };
};
EV['g-no-false-coupling'] = () => {
  const j = corpus.files['motion.json'];
  if (!j) return { ok: 'unknown', detail: '没有 motion.json' };
  return {
    ok: j.fluidStructureCoupling === 'none' && (j.couplingReason ?? '').length > 20,
    detail: `fluidStructureCoupling=${JSON.stringify(j.fluidStructureCoupling)}，理由 ${(j.couplingReason ?? '').length} 字`,
  };
};
EV['c-topple-answered'] = () => {
  const s = corpus.files['stability.json'];
  if (!s) return { ok: 'unknown', detail: '没有 stability.json' };
  return { ok: !!s.toppleAt5deg && !!s.toppleAt10deg, detail: `toppleAt5deg=${s.toppleAt5deg} · toppleAt10deg=${s.toppleAt10deg}` };
};
EV['c-counterweight'] = () => {
  const s = corpus.files['stability.json'];
  if (!s) return { ok: 'unknown', detail: '没有 stability.json' };
  const ok = s.counterweightNeeded === 'no' ? typeof s.criticalTiltDeg === 'number' : typeof s.counterweightMassG === 'number';
  return { ok, detail: `counterweightNeeded=${s.counterweightNeeded} · 临界倾角=${s.criticalTiltDeg}° · 配重=${s.counterweightMassG}g` };
};
EV['c-crosshead-hold'] = () => {
  const s = corpus.files['stability.json'];
  if (!s) return { ok: 'unknown', detail: '没有 stability.json' };
  return { ok: ['holds', 'slides', 'not-expressible'].includes(s.crossheadHold), detail: `crossheadHold=${s.crossheadHold}` };
};

// —— 01b 剩下的三条（语义类；用代理并在 detail 里写明依据）——
// 这两条**故意不自动判定**。曾写过关键词代理，实测在第一个真实用例上就误判：
// 01b 的回答里有"…被放在「整机 26 接口全通过」的位置上，而唯一两次真正的整机
// 几何验证都失败了"——那是在**引用并批评**一个说法，不是主张它，而正则区分不了。
// 硬门误判会把 P 归零，代价太大。所以这里只把候选句子摘出来供人判。
EV['g-no-green-claim'] = () => {
  const t = A();
  const cand = [...t.matchAll(/[^。\n]{0,60}(整机|全机)[^。\n]{0,40}(通过|合格|没问题|可用|达标)[^。\n]{0,20}/g)].map((m) => m[0].trim());
  const wholeFail = wholeRuns().filter((r) => (r.parts ?? []).length >= 16 && r.status === 'fail').length;
  return {
    ok: 'unknown',
    detail: `需人判（语义项，不自动判定）。语料事实：≥16 件的 validate_assembly ${wholeFail} 次全 fail。`
      + `回答里 ${cand.length} 处提到"整机+通过"类措辞${cand.length ? `，例："${cand[0].slice(0, 70)}"` : ''}`
      + `——请核对它们是**主张**还是**引用批评**`,
  };
};
EV['g-distinguish-notdone-vs-failed'] = () => {
  const t = A();
  const notDone = /(没有|未|不曾)[^。\n]{0,20}(跑|做|执行|验证|机检)/.test(t) || /未机检|没跑过|从未/.test(t);
  const failed = /(fail|失败|不通过|硬冲突)/.test(t);
  return {
    ok: 'unknown',
    detail: `需人判（语义项，不自动判定）。代理信号："没做"类措辞=${notDone} · "失败"类措辞=${failed}`
      + `——两个概念是否被**明确区分**要读回答`,
  };
};
EV['c-anchoring'] = () => {
  const baseline = rubric.baselineArm?.citedRunIds ?? null;
  const mine = citedRunIds();
  if (baseline === null) {
    return { ok: 'unknown', detail: `基准臂未记录（本条是 01b 的**两臂对照**项，需要换 SKILL.md 跑第二臂才有意义）；本臂引用 ${mine.length} 个 run id` };
  }
  return { ok: mine.length >= baseline, detail: `本臂引用 ${mine.length} 个 run id，基准臂 ${baseline} 个（expect >=）` };
};

// —— 只出现在 tool_result 里的证据（这两个工具不产生 run）——
// merge_parts / check_printability 的结论只在事件流里，语料里没有对应 run kind。
const resultsOf = (tool) => {
  const byId = new Map(toolCalls.map((c) => [c.callId, c.tool]));
  return toolResults.filter((r) => byId.get(r.callId) === tool).map((r) => String(r.result ?? ''));
};
const parseJsonLoose = (t) => { try { return JSON.parse(t); } catch { return null; } };

EV['g-merge-shells-one'] = () => {
  const rs = resultsOf('merge_parts');
  if (!rs.length) return { ok: 'unknown', detail: '没有 merge_parts 调用' };
  // 取**最后一次**合并：考生可能先做一次"故意不相接"的连通性试验（会报 2 shells），
  // 那是有意的阴性对照，不是交付件的状态。
  const all = rs.map((t) => { const m = /(\d+)\s*shell\(s\)/.exec(t); return m ? Number(m[1]) : null; }).filter((n) => n !== null);
  if (!all.length) return { ok: 'unknown', detail: `${rs.length} 次 merge_parts 的结果里没有 shell(s) 计数` };
  const last = all[all.length - 1];
  return {
    ok: last === 1,
    detail: `最后一次合并 shells=${last}（历次：${all.join(', ')}）；expect: shells === 1`,
  };
};
EV['g-negative-printability-fires'] = () => {
  const rs = resultsOf('check_printability').map(parseJsonLoose).filter(Boolean);
  if (!rs.length) return { ok: 'unknown', detail: '没有 check_printability 调用（或结果不是 JSON）' };
  const fired = rs.filter((r) => ['check', 'unprintable'].includes(r.verdict) && (r.thinSamples ?? 0) > 0);
  const verdicts = [...new Set(rs.map((r) => r.verdict))].join('/');
  return {
    ok: fired.length > 0,
    detail: `${rs.length} 次检查，verdict=${verdicts}；其中"verdict∈{check,unprintable} 且 thinSamples>0"的 ${fired.length} 次`
      + (fired.length ? `（例：thinSamples=${fired[0].thinSamples}, minWallMm=${fired[0].minWallMm}）` : ''),
  };
};
EV['g-import-dimensions-sane'] = () => {
  const imported = (corpus.manifest?.versions ?? []).filter((v) => v.source?.kind === 'imported');
  if (!imported.length) return { ok: false, detail: '没有 imported 版本' };
  const out = [];
  let allOk = true;
  for (const v of imported) {
    const bb = corpus.importedBbox?.[v.id];
    if (!bb) { out.push(`${v.id}: 量不到 model.stl`); allOk = false; continue; }
    const sorted = [...bb].sort((a, b) => a - b);
    // 轴向不敏感：608 的三个尺寸是 {7, 22, 22}
    const ok = Math.abs(sorted[0] - 7) <= 0.5 && Math.abs(sorted[1] - 22) <= 0.5 && Math.abs(sorted[2] - 22) <= 0.5;
    if (!ok) allOk = false;
    out.push(`${v.id}: ${bb.join('×')}mm ${ok ? '✓' : '✗'}`);
  }
  return { ok: allOk, detail: `expect: ≈[22,22,7] ±0.5 —— ${out.join('；')}` };
};
EV['c-joint-drift'] = () => {
  const r = lastRunOf('motion');
  const d = mOf(r).maxJointDriftMm;
  if (typeof d !== 'number') return { ok: 'unknown', detail: '运动报告里没有 maxJointDriftMm' };
  return { ok: d <= 0.5, detail: `${r.id}: maxJointDriftMm=${d}（expect <= 0.5）` };
};

// —— 回答驱动的条目（01b 这类诊断题的判据落在回答文本上）——
// 用关键词/引用计数做**代理**，并把命中证据打出来供人复核；不是语义判定。
const A = () => finalText;
const citedRunIds = () => [...new Set((A().match(/\br0\d\d\b/g) ?? []))];
const citedPaths = () => [...new Set((A().match(/[\w./-]*runs\/r\d\d\d\/[\w.]+/g) ?? []))];
const near = (a, b, win = 120) => {
  const t = A();
  for (let i = t.indexOf(a); i >= 0; i = t.indexOf(a, i + 1)) {
    if (Math.abs(t.slice(Math.max(0, i - win), i + win).indexOf(b)) >= 0) return true;
  }
  return false;
};

EV['g-motion-never-checked'] = () => {
  const t = A();
  const mentionsZero = /motion-clearance[^\n]{0,80}(0|零|没有|未)/.test(t) || /(0|零|没有|未)[^\n]{0,40}motion-clearance/.test(t);
  const saysSix = /(6|六)\s*条[^\n]{0,12}(运动|转动副|滑动副)|运动[^\n]{0,16}(6|六)\s*条/.test(t);
  // 回答若列了 check 类型分布，把那份清单摘出来——"列了但没下结论"和"压根没看"
  // 是两回事，人复核时要能分辨
  const enumd = /check 类型([^\n]{0,120})/.exec(t);
  const corpusTypes = [...new Set(corpus.interfaces.map((i) => i.check).filter(Boolean))];
  const motionTyped = corpus.interfaces.filter((i) => /转动副|滑动副|螺旋副|齿轮副/.test(String(i.type ?? ''))).length;
  return {
    ok: mentionsZero && saysSix,
    detail: `提到 motion-clearance 为 0 = ${mentionsZero}；点出运动类接口 ${motionTyped} 条 = ${saysSix}`
      + (enumd ? `；回答里列的 check 类型：${enumd[1].trim().slice(0, 70)}（**列了但没下结论**）` : `；回答里没有 check 类型清单（语料里是 ${corpusTypes.join('/')}）`),
  };
};
EV['g-evidence-cited'] = () => {
  const p = citedPaths();
  return { ok: p.length >= 3, detail: `引用可核对路径 ${p.length} 个${p.length ? `（例 ${p[0]}）` : ''}（要求 ≥3）` };
};
EV['c-evidence-depth'] = () => {
  const ids = citedRunIds();
  const wholeIds = wholeRuns().filter((r) => (r.parts ?? []).length >= 16).map((r) => r.id);
  const hitWhole = ids.filter((i) => wholeIds.includes(i));
  return { ok: ids.length >= 2 && hitWhole.length >= 1, detail: `引用 run id ${ids.length} 个（${ids.slice(0, 4).join(',')}…），其中覆盖全部交付件的 ${hitWhole.join('/') || '（无）'}` };
};
EV['c-stale-visual'] = () => ({
  ok: /过期|陈旧|stale|superseded|已失效/.test(A()) && /视觉|截图|渲染|render|图像/.test(A()),
  detail: '回答里同时出现"过期/失效"与"视觉/渲染"两类词（代理判定）',
});
EV['c-local-as-whole'] = () => ({
  ok: /局部|单件|subset|子集/.test(A()) && /整机|全机|whole/.test(A()) && /契约|assembly-check|接口/.test(A()),
  detail: '回答里同时出现"局部/单件"、"整机"与"契约"（代理判定）',
});

// —— 同一配合的两条测量路径（via: measure_distance + check_assembly）——
EV['c-measured-vs-datum'] = () => {
  const dist = toolCalls.filter((c) => /measure_distance|measure_closest/.test(String(c.tool)));
  if (!dist.length) {
    return { ok: false, detail: '零 measure_distance 调用——只有 check_assembly 一条路径，无从比对（"两条路径一致"未被演示）' };
  }
  const last = lastAsm();
  if (!last) return { ok: 'unknown', detail: '没有装配检查报告' };
  const routes = (last.report.results ?? []).filter((r) => r.check === 'distance' && typeof r.measured === 'number');
  // 只在**能按面名配上**的时候比：拿调用参数里的 a/b 去对契约的 a/b。
  // 不做"近似命中任意数字"的松散匹配——那会随机通过。
  const paired = [];
  for (const c of dist) {
    const inp = c.input ?? {};
    const blob = JSON.stringify(inp);
    const hit = routes.find((r) => blob.includes(r.a) || blob.includes(r.b));
    if (hit) {
      const vals = (blob.match(/-?\d+\.\d+/g) ?? []).map(Number);
      if (vals.length) paired.push({ id: hit.interfaceId, datum: hit.measured, mine: vals[0], d: Math.abs(vals[0] - hit.measured) });
    }
  }
  if (!paired.length) {
    return { ok: 'unknown', detail: `${dist.length} 次独立测量，但没有任何一次能按面名与契约条目配上——需人判` };
  }
  const worst = Math.max(...paired.map((x) => x.d));
  return {
    ok: worst < 0.05,
    detail: `配上 ${paired.length} 对；最大差值 ${worst.toFixed(3)}mm（要求 < 0.05）例：${paired[0].id} 契约 ${paired[0].datum} vs 自测 ${paired[0].mine}`,
  };
};

// —— 探针轮（由 bench-run 的探针轮次产出；没问过就记 UNKNOWN）——
const probeRec = (id) => (record.probes ?? []).find((p) => p.id === id);
const renderRounds = () => toolCalls.filter((c) => /generate_part|render_part/.test(String(c.tool))).length;

EV['p-version-recall'] = () => {
  const def = (rubric.probes ?? []).find((x) => x.id === 'p-version-recall');
  const when = def?.when ?? '';
  const m = /renderRounds\s*>=\s*(\d+)/.exec(when);
  if (m && renderRounds() < Number(m[1])) {
    return { ok: 'unknown', detail: `不适用：${when}（实测 renderRounds=${renderRounds()}）` };
  }
  const rec = probeRec('p-version-recall');
  if (!rec) return { ok: 'unknown', detail: '本轮没问这条探针（runner 未跑探针轮，或用了 --no-probes）' };
  if (!rec.answer) return { ok: 'unknown', detail: `问了但没拿到答案（exit=${rec.exitCode}）` };
  const nums = (rec.answer.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const want = def?.answerValues ?? [];
  const ans = rec.answer.replace(/\s+/g, ' ').slice(0, 90);
  // rubric 里没记期望答案 → **不能判 FAIL**（"没记答案"是判据缺口，不是考生失败）
  if (want.length === 0) {
    return { ok: 'unknown', detail: `rubric 的 ${'`answerValues`'} 为空——判据缺口，需补期望值。原答：${ans}…` };
  }
  const hit = want.filter((w) => nums.includes(w));
  return {
    ok: hit.length === want.length,
    detail: `期望 ${want.join('/')}（${def?.answerNote ?? ''}）；答案命中 ${hit.join('/') || '（无）'}。原答：${ans}…`,
  };
};


// ═══════════════════ 03-microscope：判据求值器（2026-10-10 补）═══════════════════
//
// 立场（照 graders/README §七 的纪律）：只吃**结构化证据**——语料 JSON、工具调用与
// 结果、考生产出的机读文件。**语义项不冒充判定**：客观部分成立才判 PASS，否则记
// UNKNOWN 并把证据摘出来交人判。硬门一律不用关键词代理。
const stageRows = () => events.flatMap((e, i) => (e.rows ?? []).map((r) => ({ ...r, stage: i })));
const allStageCalls = () => stageRows().filter((e) => e.type === 'tool_call');
const resultById = new Map(toolResults.filter((r) => r.callId).map((r) => [r.callId, String(r.result ?? '')]));
const callsByTool = (name) => allStageCalls().filter((c) => c.tool === name);
const resultJsonOf = (call) => { try { return JSON.parse(resultById.get(call.callId) ?? ''); } catch { return null; } };
const asmResultsOf = (r) => (r?.report?.results ?? []);
const asmAllResults = () => asmChecks().flatMap((r) => asmResultsOf(r).map((x) => ({ run: r.id, ...x })));
const multiset = (a) => a.filter(Boolean).slice().sort().join(',');
const deliveredVersions = () => corpus.children.map((c) => c.version).filter(Boolean);
const motionRuns = () => corpus.runs.filter((r) => r.kind === 'motion' && r.report).slice()
  .sort((a, b) => String(a.timestamp ?? a.id).localeCompare(String(b.timestamp ?? b.id)));
const interferenceOf = (r) => r?.report?.metrics?.interferenceCount ?? null;
const jointViolationsOf = (r) => (r?.report?.jointViolations ?? r?.report?.metrics?.jointViolations ?? []);
const after = (id, list) => { const i = list.findIndex((r) => r.id === id); return i < 0 ? [] : list.slice(i + 1); };

// —— 阴性对照三连：命中 + 改回 ——
EV['g-negative-flange'] = () => {                       // M1：立柱止口 −0.5mm（直径匹配）
  const checks = asmChecks();
  // 只认**止口的直径匹配**出公差——"任何提到法兰的结果"会把真实的几何错误也算上。
  const fire = checks.find((r) => (hardOf(r) ?? 0) >= 1
    && asmResultsOf(r).some((x) => x.verdict === 'hard-violation'
      && (x.check === 'diameter-match' || /直径/.test(x.expected?.quantity ?? ''))
      && /止口|flange/i.test(`${x.a ?? ''} ${x.b ?? ''}`)));
  if (!fire) return { ok: false, detail: `扫过 ${checks.length} 次装配检查，无一次因"止口直径"hard-violation` };
  const hit = asmResultsOf(fire).find((x) => x.verdict === 'hard-violation' && /止口|flange/i.test(`${x.a ?? ''} ${x.b ?? ''}`));
  const rev = after(fire.id, checks).find((r) => (hardOf(r) ?? 0) === 0 && r.report.overallStatus !== 'fail');
  return { ok: !!rev, detail: rev
    ? `${fire.id} 触发（${hit?.a} ↔ ${hit?.b} 实测 ${hit?.measured} vs 公差 [${hit?.expected?.min}, ${hit?.expected?.max}]）→ ${rev.id} 回到 0 hard（${rev.report.overallStatus}）`
    : `${fire.id} 触发了，但之后没有回到零硬冲突` };
};
EV['g-negative-chain'] = () => {                        // M3：光阑定位面 +1mm
  const checks = asmChecks();
  const outOfTol = asmAllResults().filter((x) => x.measured != null && x.expected
    && (x.measured < x.expected.min - 1e-9 || x.measured > x.expected.max + 1e-9));
  // 只看 a/b 两端的名字——用整块 JSON 匹配会把"顺带提到光阑"的光学链接口算进来
  const fire = outOfTol.find((x) => /光阑|field-stop|aperture/i.test(`${x.a ?? ''} ${x.b ?? ''}`));
  if (!fire) return { ok: false, detail: `接口实测里没有"光阑/光阑定位面"出公差的一例` };
  const rev = after(fire.run, checks).find((r) => (hardOf(r) ?? 0) === 0 && r.report.overallStatus !== 'fail');
  return { ok: !!rev, detail: `${fire.run} 接口 ${fire.interfaceId} 实测 ${fire.measured} vs 公差 [${fire.expected.min}, ${fire.expected.max}]`
    + (rev ? ` → ${rev.id} 回到 0 hard（${rev.report.overallStatus}）` : '，但之后没有回到零硬冲突') };
};
EV['g-negative-gear-phase'] = () => {                   // M2：齿条/齿轮错相位
  const ms = motionRuns();
  const fire = ms.find((r) => (interferenceOf(r) ?? 0) >= 1 && /pinion|rack|gear|齿条|齿轮|carriage|滑座/i.test(JSON.stringify(r.report)));
  if (!fire) return { ok: false, detail: `扫过 ${ms.length} 次 motion，无一次在齿轮/齿条相关件上报干涉` };
  const rev = after(fire.id, ms).find((r) => (interferenceOf(r) ?? 0) === 0 && r.status === 'pass');
  return { ok: !!rev, detail: rev
    ? `${fire.id} 报干涉 ${interferenceOf(fire)} 次（齿轮/齿条相关）→ ${rev.id} 回到 0 干涉 pass`
    : `${fire.id} 报了干涉，但之后没有回到 0 干涉且 pass` };
};

// —— 交付纪律四条 ——
EV['g-delivery-audit-clean'] = () => {
  const calls = callsByTool('delivery_audit');
  if (!calls.length) return { ok: false, detail: '没有调用 delivery_audit' };
  const texts = calls.map((c) => resultById.get(c.callId) ?? '').filter(Boolean);
  if (!texts.length) return { ok: 'unknown', detail: `调用 ${calls.length} 次，但读不到结果文本` };
  const last = texts[texts.length - 1];
  const head = last.split('\n')[0].slice(0, 130);
  return { ok: !/BLOCKED/.test(last), detail: `最后一次 delivery_audit：${head}（异议是否逐条回应仍须人判）` };
};
EV['g-printability-no-unprintable'] = () => {
  const perVersion = new Map();
  for (const c of callsByTool('check_printability')) {
    const j = resultJsonOf(c);
    if (j?.versionId) perVersion.set(j.versionId, j);
  }
  if (!perVersion.size) return { ok: 'unknown', detail: '读不到 check_printability 的工具结果' };
  const rows = Array.isArray(corpus.files['printability.json']) ? corpus.files['printability.json'] : [];
  // 只算**交付版本**：设计过程中被否掉的中间版本报 unprintable 是正常的
  const delivered = new Set(deliveredVersions());
  const bad = [...perVersion.entries()].filter(([vid, j]) => j.verdict === 'unprintable' && delivered.has(vid));
  if (!bad.length) return { ok: true, detail: `${perVersion.size} 次 check_printability 中，交付版本无 unprintable` };
  const unexplained = bad.filter(([vid, j]) => {
    const row = rows.find((r) => r.version === vid);
    return !(row && typeof row.note === 'string' && row.note.length > 20
      && (String(row.note).includes(String(j.minWallMm)) || /假读数|误判|射线|网格棱|artifact/i.test(row.note)));
  }).map(([vid, j]) => `${vid}(minWall=${j.minWallMm})`);
  return unexplained.length
    ? { ok: false, detail: `工具报 unprintable 且未逐条回应：${unexplained.join(', ')}` }
    : { ok: true, detail: `工具报 unprintable 的 ${bad.length} 件，考生在 printability.json 里逐条给了理由（${bad.map(([v]) => v).join(', ')}）` };
};
EV['g-no-turret'] = () => {
  // 判"有没有这个**零件**"：只认交付 children 的零件名。零件**内部**顺带提到
  // （例：照明座里放一片 Ø25 平凸聚光镜）不算——题面禁的是还原参考图里那几个可见部件。
  const names = corpus.children.map((c) => c.name).filter(Boolean);
  const bad = names.filter((n) => /转换器|聚光镜|反光镜|turret|revolving/i.test(String(n)));
  const mentions = (corpus.manifest?.versions ?? []).map((v) => v.userIntent).filter(Boolean)
    .filter((n) => /转换器|聚光镜|反光镜|turret|revolving/i.test(String(n)));
  return { ok: bad.length === 0, detail: (bad.length ? `零件名命中 ${bad.length} 个：${bad.join(' / ')}` : `${names.length} 个零件名里无转换器·聚光镜·反光镜`)
    + (mentions.length ? `；另有 ${mentions.length} 个版本意图**内部**提到（需人判是否算"还原了可见部件"）：${String(mentions[0]).slice(0, 60)}…` : '') };
};
EV['g-optics-self-consistent'] = () => {
  const o = corpus.files['optics.json'];
  if (!o) return { ok: false, detail: '没有 optics.json' };
  const declared = [o.imageDistanceMm, o.objectDistanceMm].filter((x) => typeof x === 'number');
  const measured = [];
  for (const c of callsByTool('measure_distance')) {
    const j = resultJsonOf(c);
    if (typeof j?.distanceMm === 'number') measured.push(j.distanceMm);
  }
  if (declared.length < 2 || !measured.length) {
    return { ok: 'unknown', detail: `optics.json 声明 ${declared.join('/')}mm，measure_distance 实测 ${measured.length} 条——不足以比对` };
  }
  const pairs = declared.map((d) => measured.find((m) => Math.abs(m - d) <= 0.3));
  const f = o.focalLengthMm, v = o.imageDistanceMm, M = o.magnification;
  const mCalc = (typeof f === 'number' && typeof v === 'number' && f > 0) ? v / f - 1 : null;
  const mOk = (mCalc == null || typeof M !== 'number') ? null : Math.abs(mCalc - M) <= Math.max(0.5, 0.1 * M);
  return {
    ok: pairs.every(Boolean) && mOk !== false,
    detail: `声明 ${declared.join('/')}mm vs 实测 ${pairs.map((p) => (p ?? '—')).join('/')}mm（±0.3mm）`
      + (mCalc != null ? `；M 声明 ${M} vs v/f−1=${mCalc.toFixed(2)}${mOk === false ? ' ✗不一致' : ' ✓'}` : ''),
  };
};
EV['g-visual-evidence-current'] = () => {
  if (!corpus.children.length) return { ok: 'unknown', detail: '没有 assembly.json 的 children' };
  const D = multiset(deliveredVersions());
  const mergedSets = new Map();
  for (const v of corpus.manifest?.versions ?? []) {
    if (v.source?.kind !== 'merged') continue;
    mergedSets.set(v.id, multiset((v.source.from ?? []).map((f) => f.versionId)));
  }
  const whole = [];
  for (const c of allStageCalls()) {
    const inp = c.input ?? {};
    if (c.tool === 'render_part' && typeof inp.versionId === 'string' && mergedSets.has(inp.versionId)) {
      whole.push({ stage: c.stage, target: `render_part ${inp.versionId}`, set: mergedSets.get(inp.versionId) });
    } else if (c.tool === 'validate_assembly' && Array.isArray(inp.parts) && inp.parts.length === corpus.children.length) {
      whole.push({ stage: c.stage, target: `validate_assembly(${inp.parts.length} 件)`, set: multiset(inp.parts.map((p) => p.versionId)) });
    }
  }
  if (!whole.length) return { ok: 'unknown', detail: '没有整机级 render_part/validate_assembly 调用' };
  const last = whole[whole.length - 1];
  const ok = last.set === D;
  return { ok, detail: `最后一次整机渲染/验证：${last.target}（阶段 ${last.stage + 1}）——其版本集${ok ? '与' : '**不**与'}交付集（${corpus.children.length} 件）一致` };
};

// —— 数值判据 ——
EV['c-motion-clean'] = () => {
  const ms = motionRuns();
  if (!ms.length) return { ok: 'unknown', detail: '没有 motion run' };
  const last = ms[ms.length - 1];
  const iv = interferenceOf(last), jv = jointViolationsOf(last).length;
  const src = new Set(last.sourceVersionIds ?? []);
  // 陈旧性只跟**这次 run 用到的零件**比：motion 只跑运动的几件，拿全交付集去比会永远"陈旧"。
  const runParts = (last.parts ?? []).map(String);
  const relevant = corpus.children.filter((c) => runParts.some((n) => String(c.name).includes(n) || n.includes(String(c.name))));
  const missing = relevant.map((c) => c.version).filter((v) => v && !src.has(v));
  const stale = src.size > 0 && relevant.length > 0 && missing.length > 0;
  const clean = iv === 0 && jv === 0;
  if (clean && stale) {
    return { ok: 'unknown', detail: `最后一次 motion ${last.id} 0 干涉/0 关节违规，但它跑的零件里 ${missing.length} 个的交付版本没被覆盖（${missing.slice(0, 4).join(',')}）——**陈旧证据**，不能据此判交付几何干净` };
  }
  return { ok: clean, detail: `最后一次 motion ${last.id}: interference=${iv} jointViolations=${jv}` };
};
EV['c-coaxial'] = () => needAssembly() ?? (() => {
  const n = corpus.interfaces.filter((i) => i.check === 'coaxial').length;
  return { ok: n >= 2, detail: `契约里 check=coaxial 的接口 ${n} 条（期望 ≥2）` };
})();
EV['c-undeclared-found'] = () => {
  const found = asmChecks().map((r) => ({ id: r.id, n: (r.report.undeclared ?? []).length })).filter((x) => x.n >= 1);
  return { ok: found.length >= 1, detail: found.length
    ? `${found[0].id} 起邻接发现抓到 undeclared（最多 ${Math.max(...found.map((f) => f.n))} 条）`
    : `全部 ${asmChecks().length} 次检查的 undeclared 都是空的` };
};
EV['c-printability-json'] = () => {
  const rows = Array.isArray(corpus.files['printability.json']) ? corpus.files['printability.json'] : null;
  if (!rows) return { ok: false, detail: '没有 printability.json' };
  const deliveredNames = new Set(corpus.children.map((c) => c.name));
  const covered = new Set(rows.map((r) => r.part));
  const missing = [...deliveredNames].filter((n) => !covered.has(n));
  const perVersion = new Map();
  for (const c of callsByTool('check_printability')) {
    const j = resultJsonOf(c);
    if (j?.versionId) perVersion.set(j.versionId, j);
  }
  const mismatched = rows.filter((r) => {
    const j = perVersion.get(r.version);
    if (!j) return false;
    if (j.verdict === 'unprintable' && r.verdict !== 'unprintable' && !(typeof r.note === 'string' && r.note.length > 20)) return true;
    return j.verdict !== r.verdict && !(typeof r.note === 'string' && r.note.length > 20);
  }).map((r) => `${r.part}(${r.version}: 文件 ${r.verdict} vs 工具 ${perVersion.get(r.version).verdict})`);
  const ok = missing.length === 0 && mismatched.length === 0;
  return { ok, detail: `printability.json ${rows.length} 行 / 交付 ${deliveredNames.size} 种零件`
    + (missing.length ? `，缺 ${missing.slice(0, 4).join(',')}` : '')
    + (mismatched.length ? `，与实测不一致且无说明：${mismatched.slice(0, 3).join('；')}` : '，与 check_printability 实测一致（或已给理由）') };
};
EV['c-measured-vs-datum'] = () => {
  const measured = [];
  for (const c of callsByTool('measure_distance')) {
    const j = resultJsonOf(c);
    if (typeof j?.distanceMm === 'number') measured.push(j.distanceMm);
  }
  if (!measured.length) return { ok: false, detail: '零 measure_distance 调用——只有契约一条路径，无从比对' };
  const nominals = corpus.interfaces.map((i) => i.nominal?.value).filter((x) => typeof x === 'number');
  const pairs = measured.map((m) => nominals.find((n) => Math.abs(n - m) < 0.05)).filter((x) => typeof x === 'number');
  return pairs.length
    ? { ok: true, detail: `${measured.length} 次实测里有 ${pairs.length} 次与契约名义值相差 <0.05mm（${pairs.slice(0, 3).join('/')}mm）` }
    : { ok: 'unknown', detail: `${measured.length} 次实测（${measured.slice(0, 4).join('/')}mm）没有一个能按名义值与契约条目配上——需人判` };
};
EV['c-stdlib-used'] = () => {
  let scads = [];
  try {
    for (const v of corpus.manifest?.versions ?? []) {
      const f = pick(versionsDir ? join(versionsDir, v.id, 'model.scad') : null);
      if (f) scads.push(f);
    }
  } catch { /* ignore */ }
  if (!scads.length) return { ok: 'unknown', detail: '读不到任何版本的 model.scad' };
  let includes = 0, modules = 0;
  for (const f of scads) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (/include\s*<BOSL2\/(gears|threading|screws)\.scad>/.test(src)) includes++;
    if (/\b(spur_gear|screw|threaded_rod|gear_profile|bevel_gear|worm|nut)\s*\(/.test(src)) modules++;
  }
  return { ok: includes > 0 && modules > 0, detail: `${scads.length} 个 SCAD 里 BOSL2 齿轮/螺纹 include ${includes} 个、对应模块调用 ${modules} 个` };
};

// —— 语义项：只在客观部分成立时判 PASS，否则 UNKNOWN（不做关键词代理式定罪）——
const finalTextAll = () => finalText;
EV['c-fine-focus-dof'] = () => {
  const o = corpus.files['optics.json'];
  const dof = typeof o?.depthOfFocusMm === 'number' ? o.depthOfFocusMm : null;
  const umLevel = dof != null && dof > 0 && dof <= 0.1;                      // ≤100µm ⇒ µm 量级
  const answerDof = /焦深[\s\S]{0,40}?(\d+(?:\.\d+)?)\s*(µm|um|微米)/i.test(finalTextAll());
  const backlash = /(回程间隙|消隙|预压|背隙|backlash|弹簧预压)/i.test(finalTextAll());
  if ((umLevel || answerDof) && backlash) {
    return { ok: true, detail: `焦深 ${dof != null ? dof + 'mm' : '(答案里给了 µm 量级数值)'}；答案含消隙/回程间隙的处置说明` };
  }
  return { ok: 'unknown', detail: `需人判：optics.json depthOfFocusMm=${dof ?? '—'}；答案里 µm 级焦深=${answerDof}；消隙说明=${backlash}` };
};
EV['c-stability-answers'] = () => {
  const t = finalTextAll();
  // 问 1：配重——要有**算出来的**量（CoM/倾倒角/质量）＋明确结论
  const angle = /(倾倒角|倾覆角|临界角|临界倾角|tipping angle)[\s\S]{0,40}?\d+(?:\.\d+)?\s*°/.test(t)
    || /CoM[\s\S]{0,60}?[−-]?\d+(\.\d+)?/.test(t);
  const cwConclusion = /(不需要?配重|需要配重|配重块|无需配重)/.test(t);
  // 问 2：压片簧/玻片——明确结论（滑/不滑、需要/不需要簧）
  const spring = /(压片簧|压片夹|玻片)[\s\S]{0,120}?(不滑|滑出|不会滑|不需要?|需要|stayed|upright)/.test(t);
  const citesRun = /(r\d{3}|simulate_physics|stability)/.test(t);
  if (angle && cwConclusion && spring) {
    return { ok: true, detail: `问 1：给算得的量（CoM/倾倒角）＋配重结论；问 2：给出玻片/压片簧结论${citesRun ? '，并引了 run/工具' : ''}（"与 run 一致"仍需人核）` };
  }
  return { ok: 'unknown', detail: `需人判：算得的量=${angle}；配重结论=${cwConclusion}；压片簧/玻片结论=${spring}；引用=${citesRun}` };
};
EV['c-appearance-diff'] = () => {
  const t = finalTextAll();
  const lines = t.split('\n').map((s) => s.trim()).filter((s) => /^([-*]|\d+[.、)]|\|)/.test(s));
  const likeUnlike = lines.filter((s) => /(像|不像|一致|差异|还原)/.test(s)).length;
  const keyed = /(马蹄|底座形态|弯臂|C ?形|弧形脚)/.test(t);
  if (likeUnlike >= 5 && keyed) return { ok: true, detail: `逐项对照清单 ${likeUnlike} 行，且覆盖 key.md 判 ❌ 的形态项（底座/弯臂）` };
  return { ok: 'unknown', detail: `需人判：清单行数=${likeUnlike}（≥5 要求）；是否落在 key.md 的 ❌ 项上=${keyed}；另需与参考图对照` };
};
// 外观 features：定性项，判据是"与参考图的形态是否一致"——机器读不出，给证据指针。
const featureIds = ['f-silhouette-profile', 'f-base-form', 'f-arm-form', 'f-tube-and-eyepiece', 'f-single-objective', 'f-stage-and-clips', 'f-side-knob'];
for (const fid of featureIds) {
  EV[fid] = () => {
    const renders = callsByTool('render_part').map((c) => (c.input ?? {}).versionId).filter(Boolean);
    const lm = (() => { try { return JSON.parse(readFileSync(join(gradersDir, level, 'landmarks.json'), 'utf8')); } catch { return null; } })();
    const bands = lm?.silhouetteProfile?.values ?? null;
    return {
      ok: 'unknown',
      detail: `需人判（外观/形态）：render_part 目标 ${renders.slice(-4).join(',') || '—'}`
        + (bands ? `；参考图九段剖面（排除 band${(lm.silhouetteProfile.excludedBands ?? []).join(',')}）= ${bands.filter((_, i) => !(lm.silhouetteProfile.excludedBands ?? []).includes(i)).map((x) => x.toFixed(3)).join(',')}` : '')
        + `；key.md 有该特征的行（${fid}）——剖面 L1 阈值按 key.md §八 待基线回填`,
    };
  };
}

// —— 03 的行程/漂移口径与本卷 rubric 对齐（原求值器是按 40mm/0.5mm 写的）——
{
  const strokeGeneric = EV['c-stroke'];
  const stroke03 = () => {
    const travels = [];
    for (const r of motionRuns()) {
      const fol = r.report?.metrics?.followers ?? {};
      for (const [name, f] of Object.entries(fol)) {
        if (typeof f?.travelMm === 'number' && /carriage|滑座|stage|载物/i.test(name)) {
          travels.push({ run: r.id, name, travel: f.travelMm, axis: f.axis });
        }
      }
    }
    if (!travels.length) return { ok: 'unknown', detail: 'motion 报告里没有 carriage/滑座 的 travelMm' };
    const best = travels.reduce((a, b) => (b.travel > a.travel ? b : a));
    return { ok: best.travel >= 25, detail: `调焦滑座最大行程 ${best.travel}mm（${best.run}，轴 ${best.axis}）；共 ${travels.length} 次观测（expect ≥25）` };
  };
  EV['c-stroke'] = () => (level === '03-microscope' ? stroke03() : strokeGeneric());

  const driftGeneric = EV['c-joint-drift'];
  const driftLimit = (() => {
    const it = (rubric.checks ?? []).find((x) => x.id === 'c-joint-drift');
    const m = /(\d+(?:\.\d+)?)/.exec(String(it?.expect ?? ''));
    return m ? Number(m[1]) : 0.5;
  })();
  EV['c-joint-drift'] = () => {
    const r = lastRunOf('motion');
    const d = mOf(r).maxJointDriftMm;
    if (typeof d !== 'number') return { ok: 'unknown', detail: '运动报告里没有 maxJointDriftMm' };
    return { ok: d <= driftLimit, detail: `${r.id}: maxJointDriftMm=${d}（rubric expect ≤ ${driftLimit}）` };
  };
}

// —— 探针：参考图取回（分档） + 版本回忆（期望值从语料推导，不写死）——
EV['p-reference-recall'] = () => {
  const variantName = (record.variant ?? 'default');
  const gui = /gui/.test(variantName);
  if (gui) {
    const calls = callsByTool('recall_reference_image');
    return { ok: calls.length > 0, detail: calls.length ? `GUI 档：recall_reference_image ${calls.length} 次` : 'GUI 档：没有 recall_reference_image 调用' };
  }
  const imgReads = allStageCalls().filter((c) => c.tool === 'read_image' && /参考图\.png/.test(JSON.stringify(c.input ?? {})));
  const inStage2 = imgReads.filter((c) => c.stage >= 1);
  return {
    ok: inStage2.length > 0,
    detail: `headless 档：对 参考图.png 的 read_image 共 ${imgReads.length} 次，其中第二阶段 ${inStage2.length} 次`
      + (record.probes?.find((p) => p.id === 'p-reference-recall')?.answer ? '（探针答案已附在 record 里，被动观察项）' : ''),
  };
};
// 覆盖原来的 p-version-recall：03 的期望值**从版本库推导**（"槽深"随模型自己的选择变，
// 写死会误判）；其它 level 仍走原来的 answerValues 口径。
const pVersionGeneric = EV['p-version-recall'];
EV['p-version-recall'] = () => (level === '03-microscope' ? pVersionDerived() : pVersionGeneric());
const pVersionDerived = () => {
  const def = (rubric.probes ?? []).find((x) => x.id === 'p-version-recall');
  const rec = probeRec('p-version-recall');
  const when = def?.when ?? '';
  const m = /renderRounds\s*>=\s*(\d+)/.exec(when);
  if (m && renderRounds() < Number(m[1])) return { ok: 'unknown', detail: `不适用：${when}（实测 renderRounds=${renderRounds()}）` };
  if (!rec) return { ok: 'unknown', detail: '本轮没问这条探针' };
  const answer = rec.answer ?? '';
  if (!answer) return { ok: 'unknown', detail: `问了但没拿到答案（exit=${rec.exitCode}）` };
  // 载物台 = 名字或 userIntent 含"载物台"的零件；取它的**第 3 版**（按时间）
  // 载物台 = **交付件**里那个名字；再由它的版本反查 partId 的版本链
  const stageChild = corpus.children.find((c) => /载物台|stage/i.test(String(c.name ?? '')));
  const stageVid = stageChild?.version;
  const stagePartId = (corpus.manifest?.versions ?? []).find((v) => v.id === stageVid)?.partId;
  const stagePartIds = new Set(stagePartId ? [stagePartId] : []);
  const vids = (corpus.manifest?.versions ?? []).filter((v) => stagePartIds.has(v.partId))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).map((v) => v.id);
  const third = vids[2];
  if (!third) return { ok: 'unknown', detail: `版本库里找不到载物台的第 3 版（链：${vids.join('→') || '—'}）` };
  // 槽深 = 该版本的 bbox 最高点 − SCAD 里名为"槽底"的 datum 平面 z
  let want = null, how = '';
  try {
    const scadPath = pick(versionsDir ? join(versionsDir, third, 'model.scad') : null);
    const stlPath = pick(versionsDir ? join(versionsDir, third, 'model.stl') : null);
    if (scadPath && stlPath) {
      const src = readFileSync(scadPath, 'utf8');
      const g = /datum_plane\(\s*"槽底"\s*,\s*\[\s*[-\d.]+\s*,\s*[-\d.]+\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/.exec(src);
      const bounds = stlBounds(Buffer.from(readFileSync(stlPath)));
      if (g && bounds?.max) want = +(bounds.max[2] - Number(g[1])).toFixed(3);
      how = g ? `${third} 槽底 z=${g[1]}、零件顶面 z=${bounds?.max?.[2]}` : `${third} 的 SCAD 里没有 datum_plane("槽底")`;
    }
  } catch { /* 推导失败 → 记 UNKNOWN */ }
  const nums = (answer.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const staticWant = def?.answerValues ?? [];
  const cands = want != null ? [want] : staticWant;
  if (!cands.length) return { ok: 'unknown', detail: `期望值推导失败（${how || '读不到版本文件'}）；原答：${answer.replace(/\s+/g, ' ').slice(0, 120)}…` };
  const hit = cands.filter((w) => nums.some((n) => Math.abs(n - w) < 0.05));
  return {
    ok: hit.length === cands.length,
    detail: `期望槽深 ${cands.join('/')}mm（${how || def?.answerNote || ''}，第 3 版=${third}）；答案命中 ${hit.join('/') || '（无）'}。原答：${answer.replace(/\s+/g, ' ').slice(0, 110)}…`,
  };
};

// —— C 列实测（不判分，只报数）——
function cost() {
  const b = rubric.budget ?? {};
  const calls = toolCalls.length;
  const ms = (record.stages ?? []).reduce((a, s) => a + (s.ms ?? 0), 0);
  const tok = (record.stages ?? []).reduce((a, s) => {
    for (const [k, v] of Object.entries(s.usage ?? {})) a[k] = (a[k] ?? 0) + (typeof v === 'number' ? v : 0);
    return a;
  }, {});
  return {
    toolCalls: calls, toolCallsChild: childCalls.length, toolCallsTotal: calls + childCalls.length,
    toolCallBudget: b.toolCalls ?? null,
    wallClockMin: +(ms / 60000).toFixed(1), wallClockBudgetMin: b.wallClockMin ?? null,
    images: null, imagesBudget: b.images ?? null,
    tokens: tok,
    stages: (record.stages ?? []).map((s) => ({ task: s.task, exitCode: s.exitCode, turns: s.turns, tools: s.toolCallCount })),
  };
}

// ---------- 汇总 ----------
function itemsOf(kind) {
  return (rubric[kind] ?? []).map((it) => {
    const ev = EV[it.id];
    const r = ev ? ev() : { ok: 'unknown', detail: `未实现求值器——证据来源：${it.via ?? '(probe)'}` };
    return { ...it, kind, result: r };
  });
}
const gates = itemsOf('gates');
const checks = itemsOf('checks');
const probes = itemsOf('probes');
const all = [...gates, ...checks, ...probes];

const gateFail = gates.filter((i) => i.result.ok === false);
const checkPassed = checks.filter((i) => i.result.ok === true);
const checkW = checks.reduce((a, i) => a + (i.weight ?? 1), 0);
const checkGot = checks.filter((i) => i.result.ok === true).reduce((a, i) => a + (i.weight ?? 1), 0);
const checkUnknown = checks.filter((i) => i.result.ok === 'unknown').length;

// P：gatePolicy = any-fail => P = 0；否则 P = checks 加权率
const P = gateFail.length ? 0 : (checkUnknown ? null : +(checkGot / (checkW || 1)).toFixed(3));

// S：只对 inSkill:true 的条目计权
const sItems = all.filter((i) => i.inSkill === true);
const sW = sItems.reduce((a, i) => a + (i.weight ?? 1), 0);
const sGot = sItems.filter((i) => i.result.ok === true).reduce((a, i) => a + (i.weight ?? 1), 0);
const sUnknown = sItems.filter((i) => i.result.ok === 'unknown').length;
const S = !skillLoaded() ? 'N/A' : (sUnknown ? null : +(sGot / (sW || 1)).toFixed(3));

const out = {
  level, variant, model: record.model, tier: record.tier,
  sessionId: record.sessionIdAdopted ?? null,
  skillLoaded: skillLoaded(),
  computed: { P, S, C: null },
  measured: { cost: cost() },
  coverage: { auto: all.filter((i) => i.result.ok !== 'unknown').length, total: all.length },
  gates: gates.map((i) => ({ id: i.id, ok: i.result.ok, detail: i.result.detail })),
  checks: checks.map((i) => ({ id: i.id, weight: i.weight ?? 1, inSkill: !!i.inSkill, ok: i.result.ok, detail: i.result.detail })),
  probes: probes.map((i) => ({ id: i.id, ask: i.ask, ok: i.result.ok, detail: i.result.detail })),
  humanColumns: ['E', 'H', 'R'],
  /** 已知的覆盖缺口：这些数字**不是**全貌，读分时不能忽略。 */
  coverageGaps: (() => {
    const gaps = [];
    const kids = toolCalls.filter((c) => /subagent|fork/i.test(String(c.tool)));
    if (kids.length && childCalls.length === 0) {
      gaps.push(`用了 ${kids.length} 次 subagent，但读不到子会话的工具调用——`
        + `C 列的工具数偏低，g-grader-access 只扫了父会话。子会话目录：${projectSessionDir(runRoot)}`);
    } else if (kids.length) {
      gaps.push(`用了 ${kids.length} 次 subagent：已并入 ${childCalls.length} 次子会话调用（${childNotes.join('；')}）`);
    }
    const unknown = [...gates, ...checks, ...probes].filter((i) => i.result.ok === 'unknown');
    if (unknown.length) gaps.push(`${unknown.length} 条判据未自动判定：${unknown.map((i) => i.id).join(', ')}`);
    return gaps;
  })(),
};

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const mark = (o) => (o === true ? 'PASS' : o === false ? 'FAIL' : ' ?? ');
  console.log(`\n=== ${level}${variant !== 'default' ? ` / ${variant}` : ''} · ${record.model} ===`);
  console.log(`run root : ${runRoot}`);
  console.log(`session  : ${out.sessionId ?? '(未报出)'}`);
  console.log(`skill S0 : ${out.skillLoaded ? '已加载 cad-toolbox' : '未观测到加载'}`);
  console.log('\n-- 硬门 --');
  for (const g of out.gates) console.log(`  ${mark(g.ok)}  ${g.id.padEnd(34)} ${g.detail}`);
  console.log('\n-- 数值判据 --');
  for (const c of out.checks) console.log(`  ${mark(c.ok)}  ${c.id.padEnd(34)} w=${c.weight} ${c.detail}`);
  console.log('\n-- 探针（长程记忆；由 runner 的探针轮问出）--');
  for (const p of out.probes) console.log(`  ${mark(p.ok)}  ${p.id.padEnd(34)} ${p.detail}`);
  const c = out.measured.cost;
  console.log('\n-- 成本（实测）--');
  console.log(`  工具调用 ${c.toolCallsTotal ?? c.toolCalls}/${c.toolCallBudget ?? '?'}`
    + (c.toolCallsChild ? `（父 ${c.toolCalls} + 子 ${c.toolCallsChild}）` : '')
    + `   墙钟 ${c.wallClockMin}min/${c.wallClockBudgetMin ?? '?'}   图片 ?/${c.imagesBudget ?? '?'}`);

  console.log(`  token    ${JSON.stringify(c.tokens)}`);
  for (const s of c.stages) console.log(`  段 ${s.task.split('/').pop()}  exit=${s.exitCode} turns=${s.turns} tools=${s.tools}`);
  console.log('\n-- 六列 --');
  console.log(`  P 通过   ${P === null ? '（checks 有未判定项，无法定稿）' : P}${gateFail.length ? `  ← ${gateFail.length} 条硬门不过，按 gatePolicy 归零` : ''}`);
  console.log(`  S 生效度 ${S}`);
  console.log(`  C 成本   见上（本脚本只报实测，不发明换算公式）`);
  console.log(`  E/H/R    ${out.humanColumns.join(' / ')} 需人判`);
  console.log(`\n  自动判定 ${out.coverage.auto}/${out.coverage.total} 条；其余为 UNKNOWN，**未实现的不算通过**。`);
  if (out.coverageGaps.length) {
    console.log('\n  ⚠ 覆盖缺口（读分时必须一起看）：');
    for (const g of out.coverageGaps) console.log(`    · ${g}`);
  }
  console.log(`  → 写分请填 graders/${level}/scores/（字段见 README §8）`);
}

const outPath = opt('--out');
if (outPath) { await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8'); console.log(`\n机读结果 → ${outPath}`); }
