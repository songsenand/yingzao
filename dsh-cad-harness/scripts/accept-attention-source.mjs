// Acceptance for "the field belongs to the artifact you selected" (2026-10-23 audit, FIX-E5).
//
// `GET /api/cad/attention?v=` answered with the NEWEST field for that version. A version can
// own several (printability / stress / analyze), so "which one am I looking at" was not a
// question the UI could answer, let alone ask. The legend now names the source run, and a
// selected run PINS the field to itself (`?id=`): selecting the stress run and being shown
// the printability map is the "latest wins" lie DESIGN §6.9b exists to rule out.
//
//   node scripts/accept-attention-source.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { attentionQuery } = await import('../src/client/heat.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── which field does the panel ask for ─────────────────────────────────────
const versionOnly = attentionQuery({ versionId: 'v005' });
check(versionOnly.query === 'v=v005' && versionOnly.pinnedToRun === false,
  'no run selected -> the version\'s newest field', versionOnly.query);

const stress = attentionQuery({ run: { id: 'r012', kind: 'stress' }, versionId: 'v005' });
check(stress.query === 'id=r012' && stress.pinnedToRun === true,
  'a selected stress run pins the field to itself', stress.query);

const analyze = attentionQuery({ run: { id: 'r013', kind: 'analyze' }, versionId: 'v005' });
check(analyze.query === 'id=r013', 'analyze owns a field too', analyze.query);

const motion = attentionQuery({ run: { id: 'r014', kind: 'motion' }, versionId: 'v005' });
check(motion.query === 'v=v005' && motion.pinnedToRun === false,
  'a run without a field falls back to the version (and the panel says so)', motion.query);

// ── the route understands both ─────────────────────────────────────────────
const tools = await readFile(join(ROOT, 'src', 'host', 'tools.ts'), 'utf8');
check(/params\.get\('id'\)/.test(tools), 'the route reads ?id');
check(/runFilePath\(runStore, pinnedId, 'attention\.json'\)/.test(tools),
  'and resolves it through the run store (path traversal is not reachable)');
check(/\^r\\d\{3,\}\$/.test(tools), 'the id shape is validated before it is used');
check(/has no attention field/.test(tools), 'a pinned run without a field answers 404 with a reason');
check(/source: \{ runId: pinnedId/.test(tools), 'the pinned answer names its run');

// ── the panel follows it, and admits the fallback ──────────────────────────
const panel = await readFile(join(ROOT, 'src', 'client', 'panel.ts'), 'utf8');
check(/attentionQuery\(\{ run: run \?/.test(panel), 'the panel asks through the shared rule');
check(/fellBack/.test(panel) && /已显示该版本最新的一份/.test(panel),
  'and tells the human when it substituted another field');

// ── the legend names the source (the earlier half of E5) ───────────────────
check(/来源 \$\{payload\.source\.runId\}/.test(panel), 'the legend names the run that produced the field');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
