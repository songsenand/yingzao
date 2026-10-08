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
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const toolCalls = allEvents.filter((e) => e.type === 'tool_call');
const toolResults = allEvents.filter((e) => e.type === 'tool_result');
const finalText = allEvents.filter((e) => e.type === 'final').map((e) => e.text ?? '').join('\n\n');

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
  for (const c of toolCalls) {
    const blob = JSON.stringify(c.input ?? {});
    for (const re of FORBIDDEN) if (re.test(blob)) hits.push(`${c.tool} ${blob.slice(0, 90)}`);
  }
  // 工具结果里出现评分方文件内容也算（例如 glob 列目录把它列出来）
  for (const r of toolResults) {
    const blob = String(r.result ?? '');
    if (/examples\/bench\/graders|landmarks\.json/.test(blob)) hits.push(`tool_result ${blob.slice(0, 90)}`);
  }
  // ⚠ 覆盖边界：子代理的调用**不在父会话的事件流里**，本扫描看不到它们。
  // 用了 subagent 的轮次必须显式标注，不能当成"扫过全部调用"。
  const kids = toolCalls.filter((c) => /subagent|fork/i.test(String(c.tool)));
  const caveat = kids.length
    ? `；**但本会话用了 ${kids.length} 次 subagent**——子代理的调用不在父事件流里，未扫`
    : '';
  return {
    ok: hits.length === 0,
    detail: (hits.length ? `触达 ${hits.length} 次：${hits[0]}` : `扫过 ${toolCalls.length} 次父会话调用，零触达`) + caveat,
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
    toolCalls: calls, toolCallBudget: b.toolCalls ?? null,
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
    if (kids.length) {
      gaps.push(`用了 ${kids.length} 次 subagent：子代理的工具调用不在父事件流里——C 列的工具数偏低，`
        + `g-grader-access 只扫了父会话（子代理若读了评分方文件抓不到）`);
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
  console.log(`  工具调用 ${c.toolCalls}/${c.toolCallBudget ?? '?'}   墙钟 ${c.wallClockMin}min/${c.wallClockBudgetMin ?? '?'}   图片 ?/${c.imagesBudget ?? '?'}`);
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
