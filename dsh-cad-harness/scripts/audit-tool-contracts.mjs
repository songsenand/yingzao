// Enumerate EVERY registered tool with its live schema, then report what a caller can and
// cannot learn from it. Written because "the tool's own text is the only thing the model
// reads" — an undocumented parameter is a guess, and a vague error is a round trip.
//
//   node scripts/audit-tool-contracts.mjs            # table
//   node scripts/audit-tool-contracts.mjs --write    # also emit docs/TOOL-CONTRACTS.md
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const captured = [];
const noop = () => {};
const stub = new Proxy(function () {}, {
  get(_t, k) {
    if (k === 'then') return undefined;
    if (k === 'tools') return { register: (d) => { captured.push(d); return { dispose: noop }; } };
    if (k === 'logger' || k === 'log') return { info: noop, warn: noop, error: noop, debug: noop };
    return stub;
  },
  apply() { return stub; },
});

const { registerCadTools } = await import('../src/host/tools.ts');
try { registerCadTools(stub); } catch (e) {
  console.log('registration threw (partial capture):', String(e?.message ?? e).slice(0, 120));
}
const tools = captured.filter((d) => d && typeof d.name === 'string');
console.log(`captured ${tools.length} tool(s)\n`);

const rows = [];
for (const t of tools) {
  // `parameters` is a JSON Schema ({type:'object', properties, required}), not a flat map.
  const ps = t.parameters?.properties ? t.parameters : { properties: t.parameters ?? {}, required: [] };
  const params = ps.properties;
  const required = new Set(ps.required ?? []);
  const names = Object.keys(params);
  const undocumented = names.filter((n) => !String(params[n]?.description ?? '').trim());
  const noType = names.filter((n) => !params[n]?.type && !params[n]?.anyOf);
  const noReq = names.filter((n) => !required.has(n) && params[n]?.required === undefined);
  const schema = t.output?.schema;
  const outProps = schema?.properties ? Object.keys(schema.properties) : [];
  rows.push({
    name: t.name,
    desc: String(t.description ?? '').length,
    params: names.length,
    undocumented,
    noType,
    noReq,
    outProps: outProps.length,
    hasOutput: Boolean(schema),
  });
}
rows.sort((a, b) => b.undocumented.length - a.undocumented.length || a.name.localeCompare(b.name));

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('tool', 24), pad('desc', 6), pad('params', 7), pad('no-desc', 8), pad('no-type', 8), 'output');
for (const r of rows) {
  console.log(pad(r.name, 24), pad(r.desc, 6), pad(r.params, 7), pad(r.undocumented.length || '-', 8), pad(r.noType.length || '-', 8), r.hasOutput ? r.outProps : 'NONE');
}
const bad = rows.filter((r) => r.undocumented.length || !r.hasOutput);
console.log(`\n${bad.length} tool(s) need work; ${rows.reduce((a, r) => a + r.undocumented.length, 0)} undocumented parameter(s)`);
for (const r of rows) if (r.undocumented.length) console.log(`  ${r.name}: ${r.undocumented.join(', ')}`);

function placeholder(p) {
  const ty = p?.type;
  if (p?.enum) return JSON.stringify(p.enum[0]);
  if (ty === 'number' || ty === 'integer') return String(p?.default ?? 0);
  if (ty === 'boolean') return String(p?.default ?? true);
  if (ty === 'array') return p?.default ? JSON.stringify(p.default) : '[]';
  if (ty === 'object') return p?.default ? JSON.stringify(p.default) : '{}';
  return p?.default !== undefined ? JSON.stringify(p.default) : '"…"';
}
function exampleCall(t) {
  const ps = t.parameters?.properties ? t.parameters : { properties: t.parameters ?? {}, required: [] };
  // This codebase marks requiredness per property (`required: true`) as often as it uses a
  // `required` array — honour both, and fall back to the first parameter if neither says.
  const reqArr = ps.required ?? [];
  const req = reqArr.length
    ? reqArr
    : Object.keys(ps.properties).filter((n) => ps.properties[n]?.required === true);
  const used = req.length ? req : Object.keys(ps.properties).slice(0, 1);
  const args = used.map((n) => `${n}: ${placeholder(ps.properties[n])}`).join(', ');
  return `${t.name}({ ${args} })`;
}

if (process.argv.includes('--write')) {
  const lines = ['# Tool contracts (generated — do not edit by hand)', '', '> `node scripts/audit-tool-contracts.mjs --write`', ''];
  for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`## \`${t.name}\``, '', String(t.description ?? '').trim(), '', '| parameter | type | default | meaning |', '|---|---|---|---|');
    const ps2 = t.parameters?.properties ? t.parameters : { properties: t.parameters ?? {}, required: [] };
    const req2 = new Set(ps2.required ?? []);
    for (const [n, p] of Object.entries(ps2.properties)) {
      const ty = Array.isArray(p?.type) ? p.type.join(' \\| ') : (p?.type ?? '—');
      const en = Array.isArray(p?.enum) ? ` (${p.enum.join(' \\| ')})` : '';
      const dflt = p?.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : (req2.has(n) || p?.required ? '**required**' : '—');
      lines.push(`| \`${n}\` | ${ty}${en} | ${dflt} | ${String(p?.description ?? '**UNDOCUMENTED**').replace(/\|/g, '\\|')} |`);
    }
    if (t.output?.schema?.properties) {
      lines.push('', '```js', exampleCall(t), '```', '');
    if (t.output?.schema?.properties) {
      lines.push('returns: ' + Object.keys(t.output.schema.properties).map((k) => `\`${k}\``).join(', '), '');
    }
    }
    lines.push('');
  }
  await mkdir(join(ROOT, 'docs'), { recursive: true });
  await writeFile(join(ROOT, 'docs', 'TOOL-CONTRACTS.md'), lines.join('\n'));
  console.log('\nwrote docs/TOOL-CONTRACTS.md');
}

if (process.argv.includes('--check')) {
  const path = join(ROOT, 'docs', 'TOOL-CONTRACTS.md');
  let current = '';
  try { current = await readFile(path, 'utf8'); } catch { current = ''; }
  if (!current) { console.log('\nFAIL  docs/TOOL-CONTRACTS.md is missing — run with --write'); process.exit(1); }
  const missing = tools.filter((t) => !current.includes('## `' + t.name + '`'));
  console.log(missing.length === 0
    ? `\nOK  the contract sheet documents all ${tools.length} tools`
    : `\nFAIL  contract sheet misses: ${missing.map((t) => t.name).join(', ')}`);
  process.exit(missing.length === 0 ? 0 : 1);
}
