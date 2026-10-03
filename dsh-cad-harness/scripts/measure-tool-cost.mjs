// What would the model-facing tool catalog cost with the CURRENT source?
//
// Booting dsh to re-measure is slow, and the catalog is the one part of a
// request that comes straight from this plugin's source. So: take the newest
// recorded catalog out of a real session log (the harness records the exact
// `tools` array it sent), substitute this source's current descriptions for the
// CAD tools, and re-price it with the harness's own rule
// (`ceil(JSON.stringify(tools).length / 4)`; dsh-token-meter:estimate.js).
//
// Everything except the descriptions — parameter schemas, names, types,
// `required` — is taken verbatim from the real request, so the delta is the
// description change and nothing else.
//
//   node scripts/measure-tool-cost.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHARS_PER_TOKEN = 4;
const price = (tools) => (tools.length === 0 ? 0 : Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + 4);

// --- the source's current CAD descriptions -----------------------------------
const src = readFileSync(join(ROOT, 'src/host/tools.ts'), 'utf8');
const current = new Map();
for (const m of src.matchAll(/registerTool\(defineTool\(\{\s*\n\s*name: '([a-z_]+)',\s*\n\s*description:\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)) {
  current.set(m[1], m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
}
if (current.size === 0) {
  console.error('measure-tool-cost: found no tool descriptions in src/host/tools.ts');
  process.exit(1);
}

// --- the newest real catalog --------------------------------------------------
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const sessionsRoot = join(home, 'sessions');
const files = [];
for (const ws of readdirSync(sessionsRoot)) {
  const wsDir = join(sessionsRoot, ws);
  if (!statSync(wsDir).isDirectory()) continue;
  for (const s of readdirSync(wsDir)) {
    const f = join(wsDir, s, 'session.v3.jsonl.zstd');
    if (existsSync(f)) files.push(f);
  }
}
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

let recorded = null;
for (const f of files) {
  let events;
  try { events = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8').split('\n').filter(Boolean); }
  catch { continue; }
  for (const line of events) {
    try {
      const e = JSON.parse(line);
      if (e?.type !== 'request/header') continue;
      const tools = e.data.header.tools ?? [];
      // the newest catalog that carries the whole CAD set
      if (tools.filter((t) => current.has(t.name)).length === current.size) recorded = { tools, file: f, seq: e.seq };
    } catch { /* skip */ }
  }
  if (recorded) break;
}
if (!recorded) {
  console.error('measure-tool-cost: no recorded request carried the full CAD catalog; run a CAD session first.');
  process.exit(1);
}

const { tools, file, seq } = recorded;
const isCad = (t) => current.has(t.name);
const patched = tools.map((t) => (isCad(t) ? { ...t, description: current.get(t.name) } : t));

const rows = [];
for (const before of tools.filter(isCad)) {
  const after = patched.find((t) => t.name === before.name);
  rows.push({
    name: before.name,
    before: JSON.stringify(before).length,
    after: JSON.stringify(after).length,
    desc: current.get(before.name).length,
  });
}
rows.sort((a, b) => b.before - a.before);

const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const cadBefore = price(tools.filter(isCad));
const cadAfter = price(patched.filter(isCad));

console.log(`source: ${join(ROOT, 'src/host/tools.ts')}`);
console.log(`recorded catalog: ${file.split('/sessions/')[1]} (request seq ${seq})\n`);
console.log(`${'tool'.padEnd(20)} ${'before'.padStart(8)} ${'after'.padStart(8)}  ${'desc now'.padStart(8)}`);
for (const r of rows) console.log(`${r.name.padEnd(20)} ${String(r.before).padStart(8)} ${String(r.after).padStart(8)}  ${String(r.desc).padStart(8)}`);
console.log('-'.repeat(50));
console.log(`${'CAD subtotal (tok)'.padEnd(20)} ${String(cadBefore).padStart(8)} ${String(cadAfter).padStart(8)}`);
console.log(`${'whole catalog (tok)'.padEnd(20)} ${String(price(tools)).padStart(8)} ${String(price(patched)).padStart(8)}`);
console.log(`\nCAD catalog: ${cadBefore} -> ${cadAfter} tok  (${cadBefore - cadAfter} saved per request, -${Math.round(100 * (1 - cadAfter / cadBefore))}%)`);
console.log(`whole request catalog: ${price(tools)} -> ${price(patched)} tok  (${price(tools) - price(patched)} saved)`);
console.log(`description prose: ${sum(rows, (r) => r.before)} -> ${sum(rows, (r) => r.after)} chars of schema`);
console.log(`\nnote: measured by substituting this source's descriptions into a REAL recorded request;`);
console.log('      parameter schemas and scaffolding are the recorded ones, unchanged.');
