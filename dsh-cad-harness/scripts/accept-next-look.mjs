// Acceptance for "a judge-mode verdict says where to look next" (2026-10-23 audit, FIX-B3;
// HARNESS §11.14).
//
// The tools trim the per-sample field out of their default (`judge`) reply on purpose — it
// is a picture for a human and noise in the model's context. But trimming it silently left
// the model with a verdict and nowhere to go, which is exactly the failure §11.14 forbids.
// The reply now carries `nextLook`: a list of RUNNABLE observations (real tool + real args +
// why), not a suggestion.
//
//   node scripts/accept-next-look.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { nextLookFor } = await import('../src/host/next-look.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// Tools a pointer may name — a pointer to a non-existent tool is not runnable.
const KNOWN = new Set(['check_printability', 'analyze', 'scan_attention', 'simulate_stress', 'measure_part', 'measure_gap']);

for (const source of ['printability', 'stress']) {
  for (const judgement of ['excluded', 'difficult', 'not-excluded']) {
    const list = nextLookFor({ source, versionId: 'v042', judgement });
    const tag = `${source}/${judgement}`;
    check(list.length > 0, `${tag}: there is at least one next observation`);
    check(list.every((n) => KNOWN.has(n.tool)), `${tag}: every pointer names a real tool`, list.map((n) => n.tool).join(','));
    check(list.every((n) => n.args && n.args.versionId === 'v042'),
      `${tag}: every pointer is for THIS version (pasteable, not generic)`);
    check(list.every((n) => typeof n.why === 'string' && n.why.length > 10),
      `${tag}: every pointer says why it is the place to look`);
  }
}

// The two sources must not return the same advice: stress is where thin sections lie.
const p = nextLookFor({ source: 'printability', versionId: 'v1', judgement: 'not-excluded' }).map((n) => n.tool).join(',');
const s = nextLookFor({ source: 'stress', versionId: 'v1', judgement: 'not-excluded' }).map((n) => n.tool).join(',');
check(p !== s, 'printability and stress point at different places', `${p} vs ${s}`);

// ── wiring: both tools call it in judge mode, right after trimming the field ──
const tools = await readFile(join(ROOT, 'src', 'host', 'tools.ts'), 'utf8');
const judgeBlocks = tools.split("if (mode === 'judge') {").slice(1);
check(judgeBlocks.length >= 2, 'both judge-mode blocks exist', `${judgeBlocks.length}`);
check(judgeBlocks.every((b) => b.slice(0, 900).includes('nextLook = nextLookFor(')),
  'each judge-mode block attaches nextLook before returning');
check(/delete reply\.attention;[\s\S]{0,400}nextLook = nextLookFor\(\{ source: 'printability'/.test(tools),
  'printability: the trim and the pointer are in the same block');
check(/delete out\.attention;[\s\S]{0,600}nextLook = nextLookFor\(\{\s*source: 'stress'/.test(tools),
  'stress: the trim and the pointer are in the same block');

// ── schemas declare it (otherwise the runtime rejects the reply) ──
const schemaHits = (tools.match(/nextLook: \{/g) ?? []).length;
check(schemaHits >= 2, 'nextLook is declared in both output schemas', `${schemaHits}`);
check(/nextLook: \{[\s\S]{0,600}tool: \{ type: 'string', required: true \}/.test(tools),
  'the schema pins tool/args/why (so a malformed pointer fails loudly)');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
