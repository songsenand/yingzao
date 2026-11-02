// Acceptance for the tool-OUTPUT contract (2026-10-23 audit, FIX-A1/A3).
//
// The bug this exists to prevent: four tools declared an `output.schema` that disagreed
// with their own body (validate_assembly required `judgement`/`judgedBy` it never
// returned; check_assembly returned both without declaring them; preflight returned
// `timings` undeclared; check_printability required `profiles[].timings` its profile
// entries do not carry). The harness rejects such a value at the runtime boundary, so
// each of those tools was broken in a live session — while every `accept-*.mjs` stayed
// green, because they all call `def.execute()` directly, below that boundary.
//
// Two halves:
//   1. the guard itself (tool-contract.ts) rejects a bad value and accepts a good one;
//   2. the guard is INSTALLED on every registered tool (a wrapper that silently failed to
//      apply would reproduce the original bug), plus one hermetic real call so a real
//      body value is seen by it.
//
//   node scripts/accept-tool-output.mjs
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { OUTPUT_CHECKED, withOutputContract } = await import('../src/host/tool-contract.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const rejects = async (fn) => {
  try { await fn(); return null; } catch (e) { return String(e?.message ?? e); }
};

// ── 1. the guard itself ─────────────────────────────────────────────────────
const schema = {
  type: 'object', additionalProperties: false,
  properties: { value: { type: 'number' } }, required: ['value'],
};
const good = withOutputContract({ name: 'demo', output: { schema }, execute: async () => ({ value: 1 }) });
check(Object.hasOwn(good.execute, OUTPUT_CHECKED), 'a wrapped execute is marked as checked');

const missing = await rejects(() => withOutputContract({
  name: 'demo', output: { schema }, execute: async () => ({}),
}).execute({}, {}));
check(/missing required property "value\.value"/.test(missing ?? ''), 'a missing required key is rejected, with its JSON path', missing ?? '(no throw)');

const extra = await rejects(() => withOutputContract({
  name: 'demo', output: { schema }, execute: async () => ({ value: 1, surprise: true }),
}).execute({}, {}));
check(/surprise.*not a declared property/.test(extra ?? ''), 'an undeclared key is rejected (additionalProperties:false)', extra ?? '(no throw)');

const okValue = await rejects(() => good.execute({}, {}));
check(okValue === null, 'a conforming value passes through');

const noContract = withOutputContract({ name: 'bare', execute: async () => ({ anything: 1 }) });
check(!Object.hasOwn(noContract.execute, OUTPUT_CHECKED), 'no declared schema = no invented contract');

// ── 2. every registered tool is guarded ────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), 'cad-out-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-out-work-'));
process.env.DSH_HOME = home; // before the first dshHome() call

const { registerCadTools } = await import('../src/host/tools.ts');
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async () => [] },
  reflect: { get: () => undefined },
  on: () => {},
};
const names = registerCadTools(ctx);
check(names.length >= 25, 'the catalog is registered', `${names.length} tool(s)`);
check([...tools.keys()].length === names.length, 'every name reports a definition');

const unguarded = [...tools.entries()].filter(([, t]) => !Object.hasOwn(t.execute ?? {}, OUTPUT_CHECKED)).map(([n]) => n);
check(unguarded.length === 0, 'the output guard is installed on every tool', unguarded.join(', '));

const unshaped = [...tools.entries()].filter(([, t]) => t.output?.schema?.type !== 'object').map(([n]) => n);
check(unshaped.length === 0, 'every tool declares an object output schema', unshaped.join(', '));

// ── 3. a real body value goes through the guard ────────────────────────────
// create_part is hermetic: no OpenSCAD, no Python worker, just the part store.
await mkdir(workspace, { recursive: true });
const exec = { agent: { session: { header: { id: 'output-contract', cwd: workspace } } } };
await tools.get('init_project').execute({ dir: workspace }, exec);
const created = await rejects(() => tools.get('create_part').execute({ name: 'output-contract-probe' }, exec));
check(created === null, 'a real tool call returns a value the guard accepts', created ?? '');
check(tools.has('create_part'), 'create_part is part of the catalog');

// ── 4. the two tools whose contract was broken, called for real ────────────
// Gated by --tools: both need the Python worker (contract evaluation, mesh health,
// support). Without a WRITABLE runtime they are skipped BY NAME — never counted as a
// pass, because a green that means "did not run" is the exact failure this file exists
// to prevent.
if (process.argv.includes('--tools')) {
  const { writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const runtimeRoot = process.env.DSH_CAD_PYTHON_ROOT ?? join(process.env.HOME ?? '', '.dsh', 'cad', 'runtime');
  const venvPython = join(runtimeRoot, 'venv', 'bin', 'python');
  const runnable = process.env.DSH_CAD_PYTHON !== 'off' && existsSync(venvPython);
  if (!runnable) {
    console.log(`SKIP  check_assembly / preflight real calls — no writable Python runtime at ${runtimeRoot} ` +
      `(set DSH_CAD_PYTHON_ROOT to one, or run without --tools for the contract-only half)`);
  } else {
    const { projectStores } = await import('../src/host/project.ts');
    const { saveVersion } = await import('../src/host/version.ts');
    const { ensurePart, attachVersion } = await import('../src/host/parts.ts');

    // A binary STL cube, written here so this half needs no OpenSCAD.
    const cubeStl = (size) => {
      const h = size / 2;
      const v = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
      const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
      const buf = Buffer.alloc(84 + 12 * 50);
      buf.write('dsh output-contract cube', 0);
      buf.writeUInt32LE(12, 80);
      let o = 84;
      for (const [i, j, k] of faces) {
        const a = v[i], b = v[j], c = v[k];
        const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
        const w = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
        let n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
        const len = Math.hypot(...n) || 1;
        n = n.map((x) => x / len);
        for (const p of [n, a, b, c]) for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
        o += 2;
      }
      return buf;
    };

    const workspace2 = await mkdtemp(join(tmpdir(), 'cad-out-corpus-'));
    const project = projectStores(workspace2);
    const base = await ensurePart(project.partStore, '底座', 'agent');
    const v1 = await saveVersion(project.store, {
      stl: cubeStl(20), userIntent: 'base', partId: base.id,
      datums: [{ name: '原点', point: [0, 0, 0] }],
    });
    await attachVersion(project.partStore, base.id, v1);
    const beam = await ensurePart(project.partStore, '梁', 'agent');
    const v2 = await saveVersion(project.store, {
      stl: cubeStl(10), userIntent: 'beam', partId: beam.id,
      datums: [{ name: '原点', point: [0, 0, 0] }],
    });
    await attachVersion(project.partStore, beam.id, v2);

    await mkdir(join(workspace2, 'assembly'), { recursive: true });
    await writeFile(join(workspace2, 'assembly', 'assembly.json'), JSON.stringify({
      schemaVersion: 1, name: 'output-contract', unit: 'mm', up: 'z',
      root: {
        id: 'machine', kind: 'assembly',
        children: [
          { id: 'base', name: '底座', kind: 'part', version: v1 },
          { id: 'beam', name: '梁', kind: 'part', version: v2, transform: { translate: [0, 0, 30] } },
        ],
        interfaces: [{
          id: 'I1', a: 'base.原点', b: 'beam.原点', type: '间隙',
          severity: 'hard', check: '距离', tolerance: { min: 25, max: 35 },
        }],
      },
    }, null, 2));

    const exec2 = { agent: { session: { header: { cwd: workspace2 } } } };
    const attempt = async (name, args) => {
      try { return { ok: true, value: await tools.get(name).execute(args, exec2) }; }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    };

    const asm = await attempt('check_assembly', { manifestPath: 'assembly/assembly.json' });
    check(asm.ok, 'check_assembly returns a value its schema accepts (judgement/judgedBy declared)', asm.error ?? '');
    if (asm.ok) {
      check(typeof asm.value.judgement === 'string' && typeof asm.value.judgedBy === 'object',
        'check_assembly actually carries judgement + judgedBy', asm.value.judgement);
      check(asm.value.summary.interfaces === 1, 'the one declared interface was seen', `${asm.value.summary.interfaces}`);
    }

    const pre = await attempt('preflight', { claims: [] });
    check(pre.ok, 'preflight returns a value its schema accepts (coverage + timings declared)', pre.error ?? '');
    if (pre.ok) {
      const got = pre.value;
      check(['excluded', 'difficult', 'not-excluded'].includes(got.judgement), 'preflight judgement is one of the three words', got.judgement);
      check(Array.isArray(got.coverage?.notCovered) && got.coverage.notCovered.length > 0,
        'preflight names the steps it does not cover instead of silently passing them');
      check(got.steps.every((s) => s.step && typeof s.ran === 'boolean'),
        'every preflight step is an attempted step (not a placeholder)');
    }
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
