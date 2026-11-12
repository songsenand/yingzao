// Acceptance for "one authority for the assembly-check report" (2026-10-23 audit, FIX-C1).
//
// The conclusion used to be written twice: a fixed name beside the manifest AND the run
// store. Two copies of one conclusion drift (microscope2 still has two that disagree by
// 25 minutes, one naming a manifest path that has moved), and the fixed file could not
// say which run it was. Now the run is the authority and the file is a POINTER.
//
// End-to-end (running check_assembly) needs the Python worker, so this file pins the two
// things that are checkable without it, plus the wiring that would silently rot:
//   * the pointer's shape and atomic write;
//   * nobody re-introduces a full-report writer;
//   * the route and the acceptance script both FOLLOW the pointer.
//
//   node scripts/accept-assembly-report-pointer.mjs
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { saveAssemblyCheckPointer } = await import('../src/host/assembly-check.ts');

// ── the pointer ────────────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'cad-pointer-'));
const manifestPath = join(dir, 'assembly', 'assembly.json');
await mkdir(join(dir, 'assembly'), { recursive: true });
const written = await saveAssemblyCheckPointer(manifestPath, {
  runId: 'r007', checkedAt: '2026-10-23T00:00:00.000Z', manifestPath, schema: 'assembly-check-pointer/v1',
});
check(written === join(dir, 'assembly', 'assembly-check-report.json'), 'the pointer lands under the historical filename');
const parsed = JSON.parse(await readFile(written, 'utf8'));
check(parsed.schema === 'assembly-check-pointer/v1', 'it declares what it is', parsed.schema);
check(parsed.runId === 'r007', 'it names the immutable run', parsed.runId);
check(!('results' in parsed), 'it is NOT a second copy of the report');
const leftovers = (await readdir(join(dir, 'assembly'))).filter((n) => n.endsWith('.tmp'));
check(leftovers.length === 0, 'the write is atomic (no .tmp left behind)');

// ── no second authority in the source ──────────────────────────────────────
const ac = await readFile(join(ROOT, 'src', 'host', 'assembly-check.ts'), 'utf8');
check(!/export async function saveAssemblyReport\b/.test(ac), 'the full-report writer is gone');
check(/saveAssemblyCheckPointer/.test(ac), 'and the pointer writer is what remains');

const tools = await readFile(join(ROOT, 'src', 'host', 'tools.ts'), 'utf8');
check(!/saveAssemblyReport\(/.test(tools), 'tools.ts no longer calls the full-report writer');
// The pointer must be written AFTER the run commits, or it cannot know the run id.
const commitAt = tools.indexOf('subject: `manifest:${relativeSubject(project, path)}`');
const pointerAt = tools.indexOf('await saveAssemblyCheckPointer(path, {');
check(commitAt > 0 && pointerAt > commitAt, 'the pointer is written after the commit (it names the run id)');

// ── consumers follow it ────────────────────────────────────────────────────
check(/assembly-check-pointer\/v1/.test(tools), 'the GET route recognises the pointer');
check(/report\.json/.test(tools.slice(pointerAt)), 'and reads the run report through the run id');
const p3 = await readFile(join(ROOT, 'scripts', 'accept-p3.mjs'), 'utf8');
check(/pointer\.runId/.test(p3), 'accept-p3 follows the pointer instead of parsing the file as a report');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
