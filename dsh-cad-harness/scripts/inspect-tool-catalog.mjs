// What tool catalog did each session actually send?
//
// The harness records the exact request envelope durably: every `request/header`
// session event carries the `tools` array the model received. This script reads
// those events and prints, per session, the tool count, the heuristic
// tool-schema token price (the harness's own `estimateToolsTokens` rule:
// ceil(chars / 4) + overhead), and how much of it is this plugin's CAD catalog.
//
// Read-only. It changes nothing and needs no restart — it is the measuring
// instrument for the "the CAD plugin costs every session ~4.5k tokens" problem,
// and it is the evidence any future fix has to move.
//
//   node scripts/inspect-tool-catalog.mjs            # newest sessions, largest first
//   node scripts/inspect-tool-catalog.mjs --all      # every session with a header
//   node scripts/inspect-tool-catalog.mjs --detail   # per-tool breakdown of the newest

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

/** Tools this plugin registers. Kept as a plain list: this script is a probe, not a consumer. */
const CAD_TOOLS = new Set(['generate_part', 'create_part', 'validate_assembly', 'check_assembly',
  'simulate_physics', 'simulate_motion', 'simulate_fluid', 'render_part',
  'measure_part', 'measure_gap']);

const CHARS_PER_TOKEN = 4;      // dsh-token-meter:estimate.js
const BLOCK_OVERHEAD = 4;       // ditto
const priceTools = (tools) => (tools.length === 0 ? 0 : Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD);

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const sessionsRoot = join(home, 'sessions');
if (!existsSync(sessionsRoot)) {
  console.error(`inspect-tool-catalog: ${sessionsRoot} not found (set DSH_HOME)`);
  process.exit(1);
}

const files = [];
for (const workspace of readdirSync(sessionsRoot)) {
  const wsDir = join(sessionsRoot, workspace);
  if (!statSync(wsDir).isDirectory()) continue;
  for (const session of readdirSync(wsDir)) {
    const f = join(wsDir, session, 'session.v3.jsonl.zstd');
    if (existsSync(f)) files.push({ file: f, session, workspace, mtime: statSync(f).mtimeMs, size: statSync(f).size });
  }
}
files.sort((a, b) => b.mtime - a.mtime);

const showAll = process.argv.includes('--all');
const detail = process.argv.includes('--detail');
const rows = [];

for (const { file, session, workspace } of files) {
  let lines;
  try { lines = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean); }
  catch { continue; }
  let last = null;
  let created;
  let switched;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e?.type === 'session' && created === undefined) created = e.agentPreset ?? null;
      // `agentPreset` in the creation event is a CREATION FACT and is never
      // rewritten — a session switched to another preset still reads its birth
      // value there. The switch is recorded as an `agent-preset/selected` event,
      // and that is what the session actually runs. Reporting the header alone
      // would call a live 造物模式 session "standard" (it did, once).
      if (e?.type === 'agent-preset/selected' && typeof e.data?.agentPreset === 'string') switched = e.data.agentPreset;
      if (e?.type === 'request/header') last = e;
    } catch { /* skip a torn line */ }
  }
  if (!last) continue;
  // The catalog we print is the one the model actually received, so the preset
  // we print must be the one that was in force: the switch wins over the birth.
  const preset = switched ?? created;
  const provenance = switched !== undefined && switched !== created ? `${created}→${switched}` : preset;
  const tools = last.data.header.tools ?? [];
  const cad = tools.filter((t) => CAD_TOOLS.has(t.name));
  rows.push({
    session: session.slice(0, 22), workspace: workspace.replace(/^--|--$/g, '').split('-').slice(-2).join('/'),
    model: last.data.header.config.model, preset: provenance,
    total: tools.length, tokens: priceTools(tools),
    cadCount: cad.length, cadTokens: priceTools(cad),
    tools,
  });
  if (!showAll && rows.length >= 12) break;
}

if (rows.length === 0) {
  console.log('no request/header events found yet');
  process.exit(0);
}

const width = Math.max(...rows.map((r) => r.session.length), 7);
console.log(`${'session'.padEnd(width)}  ${'workspace'.padEnd(22)}  ${'preset'.padEnd(10)}  ${'model'.padEnd(16)}  tools  catalog  CAD`);
for (const r of rows) {
  console.log(`${r.session.padEnd(width)}  ${(r.workspace || '-').padEnd(22)}  ${String(r.preset ?? '(none)').padEnd(10)}  ${(r.model ?? '-').padEnd(16)}  ${String(r.total).padStart(5)}  ${String(r.tokens + ' tok').padStart(9)}  ${r.cadCount === 0 ? '—' : `${r.cadCount} (${r.cadTokens} tok)`}`);
}

const withCad = rows.filter((r) => r.cadCount > 0);
const withoutCad = rows.filter((r) => r.cadCount === 0);
const avg = (list, f) => (list.length === 0 ? 0 : Math.round(list.reduce((a, r) => a + f(r), 0) / list.length));
console.log();
console.log(`baseline (sessions with no CAD tool) : ${withoutCad.length}  avg ${avg(withoutCad, (r) => r.total)} tools, ${avg(withoutCad, (r) => r.tokens)} tok`);
console.log(`sessions carrying CAD tools          : ${withCad.length}  avg ${avg(withCad, (r) => r.total)} tools, ${avg(withCad, (r) => r.tokens)} tok`);
if (withCad.length) {
  const cadTok = withCad.map((r) => r.cadTokens);
  console.log(`  the CAD catalog's own share        : avg ${Math.round(cadTok.reduce((a, b) => a + b, 0) / cadTok.length)} tok, max ${Math.max(...cadTok)} tok per request`);
  console.log('  (sessions appear more than once per task; the baseline is what a coding session pays)');
}

if (detail) {
  const newest = rows.find((r) => r.cadCount > 0) ?? rows[0];
  console.log(`\nper-tool breakdown — ${newest.session} (${newest.tokens} tok total)`);
  const sized = newest.tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length, cad: CAD_TOOLS.has(t.name) }))
    .sort((a, b) => b.chars - a.chars);
  for (const t of sized) console.log(`  ${t.cad ? 'CAD ' : '    '} ${t.name.padEnd(22)} ${String(t.chars).padStart(6)} chars  ≈${Math.ceil(t.chars / CHARS_PER_TOKEN)} tok`);
  const cadChars = sized.filter((t) => t.cad).reduce((a, t) => a + t.chars, 0);
  console.log(`  CAD subtotal: ${cadChars} chars ≈ ${Math.ceil(cadChars / CHARS_PER_TOKEN)} tok of ${newest.tokens}`);
}
