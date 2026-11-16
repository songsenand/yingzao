// Tool-coverage report: which REGISTERED tools the acceptance suite actually
// executes, and how much of src/host runs while it does.
//
// WHY THIS EXISTS. `accept-*.mjs` scripts call `def.execute(...)` directly, and
// many of them import an implementation module (measure.ts, turning.ts, ...)
// instead of the tool. A green suite therefore says little about the surface a
// model really calls: argument parsing, defaults, the argError text and the
// output contract live in the tool body, and a tool body that no test executes
// can disagree with its own schema without any accept script noticing (the
// 2026-10-23 audit found four such tools). This script measures the tool
// surface directly instead of inferring it from test names:
//
//   1. every test process loads a preload that redirects
//      `@deepseek-ai/dsh-tools` to a shim whose `defineTool` wraps `execute`
//      and appends {tool, ok, test} to a JSONL record;
//   2. every test process runs with NODE_V8_COVERAGE, so the files it loads
//      report line/function coverage (TypeScript is stripped in place — byte
//      offsets stay aligned with the source);
//   3. this process aggregates both into one report.
//
//   node scripts/coverage-tools.mjs                       # every accept-*.mjs
//   node scripts/coverage-tools.mjs --tests measure,physics
//   node scripts/coverage-tools.mjs --reuse .tmp-coverage-xxxx
//   node scripts/coverage-tools.mjs --json coverage.json --timeout 180000
//
// `--reuse` aggregates a previous run's directory (keep the path this script
// prints) without re-running anything.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const REUSE = flag('reuse');
const JSON_OUT = flag('json');
const TIMEOUT = Number(flag('timeout') ?? 120_000);
const FILTERS = (flag('tests') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const WORK = REUSE ?? mkdtempSync(join(tmpdir(), 'cad-coverage-'));
const V8DIR = join(WORK, 'v8');
const RECORD = join(WORK, 'record.jsonl');
const RESULTS = join(WORK, 'results.jsonl');

if (!has('reuse')) {
  mkdirSync(V8DIR, { recursive: true });
  writeFileSync(RECORD, '');
  writeFileSync(RESULTS, '');
}

// ---------------------------------------------------------------- tool catalog
// docs/TOOL-CONTRACTS.md is generated from the live registry and kept in sync by
// accept-tool-contracts.mjs, so it is the catalog a reviewer sees. A tool that
// is registered but missing here fails that acceptance, not this report.
const catalog = [...readFileSync(join(ROOT, 'docs/TOOL-CONTRACTS.md'), 'utf8')
  .matchAll(/^## `([a-z0-9_]+)`$/gm)].map((m) => m[1]);

// --------------------------------------------------------------- test execution
const tests = [];
if (!REUSE) {
  const scripts = readdirSync(join(ROOT, 'scripts'))
    .filter((f) => /^accept-.*\.mjs$/.test(f))
    .filter((f) => !FILTERS.length || FILTERS.some((x) => f.includes(x)))
    .sort();

  // The shim resolves the real package by absolute path so its own import is not
  // redirected by the resolve hook (which matches only the bare specifier).
  const real = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')).href;
  const shim = join(WORK, 'shim.mjs');
  const preload = join(WORK, 'preload.mjs');
  writeFileSync(shim, `import { appendFileSync } from 'node:fs';
import * as real from ${JSON.stringify(real)};
export * from ${JSON.stringify(real)};
const OUT = process.env.CAD_TOOL_COVERAGE_RECORD;
const record = (row) => { if (!OUT) return; try { appendFileSync(OUT, JSON.stringify(row) + '\\n'); } catch {} };
export function defineTool(def) {
  if (!def || typeof def.execute !== 'function' || !OUT) return real.defineTool(def);
  const wrapped = { ...def, execute: async (...args) => {
    const started = Date.now();
    try {
      const value = await def.execute(...args);
      record({ tool: def.name, ok: true, ms: Date.now() - started, test: process.env.CAD_TEST_NAME || null });
      return value;
    } catch (error) {
      record({ tool: def.name, ok: false, ms: Date.now() - started, test: process.env.CAD_TEST_NAME || null, error: String(error?.message ?? error).slice(0, 200) });
      throw error;
    }
  } };
  return real.defineTool(wrapped);
}
`);
  writeFileSync(preload, `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: ${JSON.stringify(pathToFileURL(shim).href)}, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`);

  const baseEnv = {
    ...process.env,
    CAD_TOOL_COVERAGE_RECORD: RECORD,
    NODE_V8_COVERAGE: V8DIR,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim(),
  };

  console.log(`running ${scripts.length} accept script(s) under coverage; logs kept in ${WORK}`);
  for (const [index, script] of scripts.entries()) {
    const name = script.replace(/\.mjs$/, '');
    const log = join(WORK, `${name}.log`);
    const fd = openSync(log, 'w');
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      env: { ...baseEnv, CAD_TEST_NAME: name },
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    const status = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        done('timeout');
      }, TIMEOUT);
      child.on('error', () => done('fail'));
      child.on('exit', (code, signal) => done(code === 0 ? 'ok' : signal ? 'timeout' : 'fail'));
    });
    const ms = Date.now() - started;
    closeSync(fd);
    const text = readFileSync(log, 'utf8');
    const lines = text.split('\n');
    const count = (p) => lines.filter((l) => l.startsWith(p)).length;
    const last = lines.map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';
    const row = { script, name, status, ms, pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), last };
    appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
    tests.push(row);
    console.log(`[${index + 1}/${scripts.length}] ${status.padEnd(7)} ${String(ms).padStart(6)}ms  ${name}  (P${row.pass} F${row.fail} S${row.skip})`);
  }
} else {
  for (const line of readFileSync(join(WORK, 'results.jsonl'), 'utf8').split('\n')) {
    if (line.trim()) tests.push(JSON.parse(line));
  }
}

// ------------------------------------------------------------- execution records
const records = [];
if (existsSync(RECORD)) {
  for (const line of readFileSync(RECORD, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
}
const byTool = new Map();
for (const r of records) {
  if (!catalog.includes(r.tool)) continue; // ignores fake tools a test defines itself
  const t = byTool.get(r.tool) ?? { calls: 0, ok: 0, fail: 0, tests: new Set(), errors: [] };
  t.calls++;
  if (r.ok) t.ok++;
  else {
    t.fail++;
    const msg = String(r.error ?? '').split('\n')[0].slice(0, 160);
    if (msg && !t.errors.includes(msg)) t.errors.push(msg);
  }
  if (r.test) t.tests.add(r.test);
  byTool.set(r.tool, t);
}

// ------------------------------------------------------------------ V8 coverage
const lineStarts = new Map();
const lineCounts = new Map();   // file -> Map(lineIndex -> covered)
const fnCounts = new Map();     // file -> Map(startOffset -> covered)
const startsOf = (file) => {
  let starts = lineStarts.get(file);
  if (starts) return starts;
  const text = readFileSync(file, 'utf8');
  starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  lineStarts.set(file, starts);
  return starts;
};
const lineOf = (starts, offset) => {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
};

if (existsSync(V8DIR)) {
  for (const file of readdirSync(V8DIR).filter((f) => f.endsWith('.json'))) {
    let json;
    try { json = JSON.parse(readFileSync(join(V8DIR, file), 'utf8')); } catch { continue; }
    for (const entry of json.result ?? []) {
      if (!entry.url.startsWith('file://')) continue;
      const path = fileURLToPath(entry.url);
      if (!path.startsWith(join(ROOT, 'src') + '/')) continue;
      const starts = startsOf(path);
      const ranges = [];
      for (const fn of entry.functions ?? []) {
        for (const r of fn.ranges ?? []) ranges.push(r);
        const body = fn.ranges?.[0];
        if (body) {
          const fns = fnCounts.get(path) ?? new Map();
          fns.set(body.startOffset, (fns.get(body.startOffset) ?? false) || body.count > 0);
          fnCounts.set(path, fns);
        }
      }
      ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const counts = lineCounts.get(path) ?? new Map();
      for (let i = 0; i < starts.length; i++) {
        const offset = starts[i];
        let lo = 0, hi = ranges.length - 1, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (ranges[mid].startOffset <= offset) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        let count = -1;
        for (let k = idx; k >= 0; k--) {
          if (ranges[k].endOffset > offset) { count = ranges[k].count; break; }
        }
        if (count < 0) continue; // outside every range: not executable
        if (count > 0) counts.set(i, true);
        else if (!counts.has(i)) counts.set(i, false);
      }
      lineCounts.set(path, counts);
    }
  }
}

// ------------------------------------------------------------------- report rows
const pct = (a, b) => (b ? Number(((100 * a) / b).toFixed(1)) : null);
const tools = catalog.map((name) => {
  const t = byTool.get(name);
  return {
    name,
    invoked: Boolean(t?.calls),
    calls: t?.calls ?? 0,
    ok: t?.ok ?? 0,
    fail: t?.fail ?? 0,
    tests: t ? [...t.tests].sort() : [],
    errors: t?.errors ?? [],
  };
});

const modules = [];
for (const [file, counts] of lineCounts) {
  let total = 0, covered = 0;
  for (const v of counts.values()) { total++; if (v) covered++; }
  const fns = fnCounts.get(file) ?? new Map();
  const fnCovered = [...fns.values()].filter(Boolean).length;
  modules.push({
    file: relative(ROOT, file),
    lines: total,
    covered,
    linePct: pct(covered, total),
    functions: fns.size,
    fnCovered,
    fnPct: pct(fnCovered, fns.size),
  });
}
modules.sort((a, b) => (a.linePct ?? 101) - (b.linePct ?? 101));

const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
const src = {
  lines: sum(modules, 'lines'),
  covered: sum(modules, 'covered'),
  functions: sum(modules, 'functions'),
  fnCovered: sum(modules, 'fnCovered'),
};
src.linePct = pct(src.covered, src.lines);
src.fnPct = pct(src.fnCovered, src.functions);

const report = {
  generatedAt: new Date().toISOString(),
  workDir: WORK,
  tests: {
    total: tests.length,
    ok: tests.filter((t) => t.status === 'ok').length,
    fail: tests.filter((t) => t.status === 'fail').length,
    timeout: tests.filter((t) => t.status === 'timeout').length,
    pass: sum(tests, 'pass'),
    assertionsFailed: sum(tests, 'fail'),
    rows: tests,
  },
  tools: {
    catalog: tools.length,
    invoked: tools.filter((t) => t.invoked).length,
    happyPath: tools.filter((t) => t.ok > 0).length,
    negativePath: tools.filter((t) => t.fail > 0).length,
    calls: records.filter((r) => catalog.includes(r.tool)).length,
    rows: tools,
  },
  src: { ...src, modules },
};

if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

// ---------------------------------------------------------------------- console
console.log(`\ntests: ${report.tests.total} (${report.tests.ok} ok, ${report.tests.fail} fail, ${report.tests.timeout} timeout) · ${report.tests.pass} PASS assertions`);
const notGreen = tests.filter((t) => t.status !== 'ok');
if (notGreen.length) console.log(`not green: ${notGreen.map((t) => t.name).join(', ')}`);
console.log(`tools invoked at the boundary: ${report.tools.invoked}/${report.tools.catalog} · happy ${report.tools.happyPath} · error path ${report.tools.negativePath} · ${report.tools.calls} call(s)`);
console.log(`src line coverage ${src.covered}/${src.lines} (${src.linePct}%) · functions ${src.fnCovered}/${src.functions} (${src.fnPct}%)`);

const never = tools.filter((t) => !t.invoked).map((t) => t.name);
console.log(`\nnever invoked (${never.length}):`);
console.log(`  ${never.join(', ')}`);

console.log('\nweakest modules (>=50 executable lines):');
for (const m of modules.filter((m) => m.lines >= 50).slice(0, 12)) {
  console.log(`  ${String(m.linePct).padStart(5)}%  ${String(m.covered).padStart(4)}/${String(m.lines).padEnd(5)} fn ${String(m.fnPct).padStart(5)}%  ${m.file}`);
}
if (!JSON_OUT) console.log(`\nwork dir kept at ${WORK} (use --reuse to aggregate it again)`);
