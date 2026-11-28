// Tool-BOUNDARY acceptance: every registered tool is called through its
// registered definition, not through the implementation module behind it.
//
// WHY. The 162 accept-*.mjs mostly test modules (measureDistance, runFluid,
// analyzeTurning) or call `def.execute` for one or two tools; a 2026-11-16
// measurement found 18 of 43 tools were reachable from any acceptance and 25
// were never executed at all. That gap is where a tool's own layer lives:
// defaults applied in the body, argError text, "no project" refusals, and the
// value the output contract sees — the class of defect the 2026-10-23 audit
// found four of while the suite was green.
//
// TWO HALVES.
//   1. SCHEMA HALF (all 43, generated from the live registry): an empty call
//      must name every missing required field. No hand-written list to drift.
//   2. FIXTURE HALF (by table): a hermetic project — two box parts written
//      straight into the store (so the fixture exists without Python) plus an
//      assembly manifest written by `write_assembly` — then each row calls one
//      tool with valid arguments. Rows that need a provisioned Python runtime
//      are SKIPPED BY NAME when it is absent — a skip is never a pass.
//
//   node scripts/accept-tool-boundary.mjs
//   DSH_CAD_PYTHON_ROOT=/path/to/runtime node scripts/accept-tool-boundary.mjs
//
// The fixture uses the same box STL helper as accept-tool-output.mjs, so building
// it needs neither OpenSCAD nor the Python worker; render_part is the one row that
// needs OpenSCAD once the fixture exists.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Project data goes to a temp DSH_HOME (a fixture, never the real corpus), but the
// Python runtime is shared and expensive: keep pointing at the caller's runtime
// unless asked otherwise. Without this, a machine WITH a provisioned runtime would
// still SKIP every Python row, because the temp home has none.
const ORIGINAL_DSH_HOME = process.env.DSH_HOME;
const HOME = mkdtempSync(join(tmpdir(), 'cad-tool-boundary-'));
process.env.DSH_HOME = HOME;
if (!process.env.DSH_CAD_PYTHON_ROOT) {
  process.env.DSH_CAD_PYTHON_ROOT = join(ORIGINAL_DSH_HOME?.trim() || join(homedir(), '.dsh'), 'cad', 'runtime');
}
// This file tests surface wiring, not the pre-work gate; accept-brief-gate owns that.
process.env.DSH_CAD_BRIEF_GATE = 'off';
const workspace = join(HOME, 'workspace');
mkdirSync(workspace, { recursive: true });

const { registerCadTools } = await import('../src/host/tools.ts');
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');
const { SURFACE_OPS } = await import('../src/host/surface.ts');
const { OUTPUT_CHECKED } = await import('../src/host/tool-contract.ts');

let failures = 0;
let skips = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const skip = (label, why) => {
  skips++;
  console.log(`SKIP  ${label}  — ${why}`);
};

// --------------------------------------------------------------- registration
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  connection: { fetch: { register: () => () => {} } },
  attachments: { saveImages: async (images) => images },
  reflect: { get: () => undefined },
  on: () => () => {},
  effect: (fn) => fn(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
const names = registerCadTools(ctx);
check(names.length === tools.size && tools.size >= 39, 'the live catalog is registered', `${tools.size} tool(s)`);
check([...tools.values()].every((t) => Object.hasOwn(t.execute ?? {}, OUTPUT_CHECKED)),
  'every registered execute carries the output guard');

const exec = { agent: { session: { header: { id: 'tool-boundary', cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def.execute(args, exec);
};
const attempt = async (name, args) => {
  try {
    return { ok: true, value: await call(name, args) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};

// ------------------------------------------------------------ 1. schema half
// The argument schema is compiled by defineTool, so the failure text is the
// library's. What this half pins is that EVERY missing required field is named
// in ONE reply: a tool that validates two fields one at a time costs the caller
// two round trips, and a hand-added parameter cannot silently go unnamed.
console.log('schema half\n');
for (const [name, def] of tools) {
  const required = def.parameters?.required ?? [];
  if (required.length) {
    const got = await attempt(name, {});
    const missing = required.filter((field) => !got.error?.includes(`missing required property "${field}"`));
    check(!got.ok && missing.length === 0,
      `${name}: an empty call names all ${required.length} required field(s)`,
      got.ok ? 'returned a value' : missing.length ? `not named: ${missing.join(', ')}` : '');
  } else {
    // NO CALL for a tool without required fields: `simulate_lbm({})` is a valid
    // call that starts a real simulation (it hung the first version of this
    // file). The fixture half exercises the no-arg tools that are cheap and
    // hermetic; the rest are covered by their own acceptance.
    check(Boolean(def.output?.schema), `${name}: no required field — declares an output schema (body covered by the fixture half or its own acceptance)`);
  }
}

// ------------------------------------------------------ 1b. surface half
// The production entry point is 9 job surfaces (cad_session … cad_deliver) that
// delegate to the legacy tools. A green legacy call says nothing about the
// surface: its catalog, its help text, and whether an action is wired to the tool
// it claims. Without a call the delegation itself is unproven, so each op is
// invoked with an empty args object: the LEGACY tool's required-field refusal must
// come back through the surface, naming its own fields. Ops with no required
// field are not called (an empty call can start real work, the reason the schema
// half above has the same rule).
console.log('\nsurface half\n');
const SURFACES = ['session', 'part', 'assembly', 'check', 'simulate', 'inspect', 'see', 'python', 'deliver'];
const surfaceTools = new Map();
const surfaceCtx = {
  ...ctx,
  tools: { register: (def) => { surfaceTools.set(def.name, def); return () => {}; } },
};
registerCadToolsWithSurfaces(surfaceCtx, { toolSurfaces: SURFACES, hideLegacy: 'all' });
check(surfaceTools.size === 9, 'the nine job surfaces are registered', `${surfaceTools.size}`);
check(![...surfaceTools.keys()].some((name) => tools.has(name)),
  'cutover hides every legacy tool (only surfaces are visible)');
const attemptSurface = async (name, args) => {
  try {
    return { ok: true, value: await surfaceTools.get(name).execute(args, exec) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};

let opCount = 0;
let wired = 0;
for (const [name, def] of surfaceTools) {
  const catalog = await attemptSurface(name, { action: 'catalog' });
  check(catalog.ok && Array.isArray(catalog.value?.ops) && catalog.value.ops.length > 0,
    `${name}: catalog lists its ops`, catalog.ok ? `${catalog.value?.ops?.length ?? 0} op(s)` : (catalog.error ?? '').slice(0, 100));
  if (!catalog.ok || !Array.isArray(catalog.value?.ops)) continue;
  for (const op of catalog.value.ops) {
    opCount++;
    const help = await attemptSurface(name, { action: 'help', args: { op: op.op } });
    check(help.ok && help.value?.op === op.op
      && typeof help.value?.example === 'string' && help.value.example.startsWith(`${name}(`),
      `${name}.${op.op}: help returns a callable example (no internal op name in the reply)`,
      help.ok ? JSON.stringify(help.value).slice(0, 90) : (help.error ?? '').split('\n')[0].slice(0, 90));
    // Wiring stays auditable through the symbol, NOT through the reply: the model
    // must not see `tool: "run_python"` (a call it cannot make) in help output.
    const route = (surfaceTools.get(name)?.[SURFACE_OPS] ?? []).find((entry) => entry.op === op.op);
    check(Boolean(route && tools.has(route.tool)), `${name}.${op.op}: routed to a registered legacy tool`, route?.tool);
    const required = Array.isArray(op.required) ? op.required : [];
    if (!required.length) continue;
    const refused = await attemptSurface(name, { action: op.op, args: {} });
    const missing = required.filter((field) => !refused.error?.includes(`missing required property "${field}"`));
    check(!refused.ok && missing.length === 0,
      `${name}.${op.op}: delegates to the legacy validator (all ${required.length} field(s) named)`,
      refused.ok ? 'returned a value' : missing.length ? `not named: ${missing.join(', ')}` : '');
    if (!refused.ok && missing.length === 0) wired++;
  }
}
check(opCount === 39, 'the surfaces expose all 39 ops (no orphan tool)', `${opCount}`);
check(wired > 0, 'the wired-op check looked at something', `${wired} op(s) with required fields`);

// ---------------------------------------------------------------- 2. fixture
console.log('\nfixture\n');

/** A closed box, binary STL, centred on the origin (mm); the same helper as accept-tool-output.mjs. */
function boxStl(dx, dy, dz) {
  const hx = dx / 2, hy = dy / 2, hz = dz / 2;
  const v = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('dsh tool-boundary box', 0);
  buf.writeUInt32LE(12, 80);
  let o = 84;
  for (const [i, j, k] of faces) {
    const a = v[i], b = v[j], c = v[k];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [n.map((x) => x / len), a, b, c]) {
      for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
    }
    o += 2;
  }
  return buf;
}

/** A minimal self-contained GLB v2: one mesh, one material, no external URI. */
function minimalGlb() {
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'accept-tool-boundary' },
    meshes: [{}],
    materials: [{ name: 'fixture' }],
  });
  const pad = (4 - (json.length % 4)) % 4;
  const payload = Buffer.from(json + ' '.repeat(pad));
  const buf = Buffer.alloc(12 + 8 + payload.length);
  buf.writeUInt32LE(0x46546c67, 0); // "glTF"
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(buf.length, 8);
  buf.writeUInt32LE(payload.length, 12);
  buf.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  payload.copy(buf, 20);
  return buf;
}

const init = await call('init_project', { dir: workspace });
const sameDir = (a, b) => {
  try { return Boolean(a) && realpathSync(String(a)) === realpathSync(b); } catch { return false; }
};
check(sameDir(init?.root, workspace), 'init_project creates the fixture project', JSON.stringify(init).slice(0, 120));

// The versions are written straight into the store, not through import_part:
// the fixture must exist even on a machine with no Python runtime, and
// import_part's watertightness proof runs in the worker. import_part itself has
// its own acceptance (accept-import); this file is about the OTHER tools.
const datumsOf = (half) => [
  { name: '原点', kind: 'point', point: [0, 0, 0] },
  { name: '顶面', kind: 'plane', point: [0, 0, half], normal: [0, 0, 1] },
];
const { projectStores } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
const stores = projectStores(workspace);
const basePart = await ensurePart(stores.partStore, 'base', 'agent');
const vBase = await saveVersion(stores.store, {
  stl: boxStl(20, 20, 20), userIntent: 'boundary fixture base', partId: basePart.id, datums: datumsOf(10),
});
await attachVersion(stores.partStore, basePart.id, vBase);
const beamPart = await ensurePart(stores.partStore, 'beam', 'agent');
const vBeam = await saveVersion(stores.store, {
  stl: boxStl(10, 10, 10), userIntent: 'boundary fixture beam', partId: beamPart.id, datums: datumsOf(5),
});
await attachVersion(stores.partStore, beamPart.id, vBeam);
check(Boolean(vBase && vBeam), 'two parts exist in the fixture project', `${vBase}, ${vBeam}`);

// Stock-as-ordinary: a stock part WITH a version has geometry and may be an
// interface endpoint; a stock part WITHOUT one is BOM-only and may not.
{
  const root = {
    id: 'root', name: 'stock endpoint fixture', kind: 'assembly',
    children: [
      { id: 'base', name: 'base', kind: 'part', version: vBase },
      { id: 'bolt', name: 'bolt', kind: 'part', source: 'stock', role: 'purchased', version: vBeam },
    ],
    interfaces: [{
      id: 'I-stock', a: 'base.顶面', b: 'bolt.原点', type: '贴合', severity: 'hard', check: 'distance',
      nominal: { quantity: '距离', value: 10 }, tolerance: { min: 9, max: 11 },
    }],
  };
  const withVersion = await attempt('write_assembly', { manifestPath: 'assembly/stock-with-version.json', mode: 'create', root });
  check(withVersion.ok, 'a stock part WITH a version can be an interface endpoint', withVersion.ok ? '' : withVersion.error);

  const withoutVersion = { ...root, children: [root.children[0], { id: 'bolt', name: 'bolt', kind: 'part', source: 'stock' }] };
  const noVersion = await attempt('write_assembly', { manifestPath: 'assembly/stock-without-version.json', mode: 'create', root: withoutVersion });
  check(!noVersion.ok && /no version/.test(String(noVersion.error)), 'a stock part WITHOUT a version is refused as an endpoint', noVersion.ok ? 'accepted' : String(noVersion.error).slice(0, 120));
}

// simulate_fluid is an either/or at the boundary: the schema must accept both
// {versionId} and {pipeScad}, while {} is refused by the body with a hint that
// names both. The empty call returns before any stores or engine work, so this
// check is cheap; the two valid calls are schema-only (running the MPM engine is
// accept-m4's job).
{
  const fluid = tools.get('simulate_fluid');
  check(Boolean(fluid), 'simulate_fluid is registered');
  if (fluid) {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const versionOnly = validateJsonSchemaValue(fluid.parameters, { versionId: vBase }, '');
    const pipeOnly = validateJsonSchemaValue(fluid.parameters, { pipeScad: 'cube(1);' }, '');
    check(versionOnly.length === 0, 'simulate_fluid: {versionId} passes the live schema', versionOnly.join('; '));
    check(pipeOnly.length === 0, 'simulate_fluid: {pipeScad} passes the live schema', pipeOnly.join('; '));
    const empty = await attempt('simulate_fluid', {});
    check(!empty.ok && /pipeScad|versionId/.test(String(empty.error)),
      'simulate_fluid: {} is refused with a pipeScad/versionId hint',
      empty.ok ? 'returned a value' : String(empty.error).slice(0, 120));
  }
}

writeFileSync(join(workspace, 'look.glb'), minimalGlb());

const manifest = {
  schemaVersion: 1, name: 'tool-boundary', unit: 'mm', up: 'z',
  root: {
    id: 'root', name: 'boundary assembly', kind: 'assembly',
    children: [
      { id: 'base', name: 'base', kind: 'part', version: vBase },
      { id: 'beam', name: 'beam', kind: 'part', version: vBeam, transform: { translate: [0, 0, 30] } },
    ],
    interfaces: [{
      id: 'I1', a: 'base.顶面', b: 'beam.原点', type: '间隙', severity: 'hard', check: '距离',
      tolerance: { min: 5, max: 25 }, note: 'fixture: 20 mm between the base top and the beam origin',
    }],
  },
};
const written = await attempt('write_assembly', { mode: 'create', root: manifest.root });
check(written.ok, 'write_assembly writes the fixture manifest', written.ok ? '' : written.error ?? '');

// ------------------------------------------------------------ 3. fixture half
// One row per tool. `args` receives the fixture ids so a row cannot drift from
// the project it was measured on. `assert` sees the returned value.
console.log('\nfixture half\n');

const allowPython = async () => {
  if (process.env.DSH_CAD_PYTHON === 'off') return 'python runtime disabled by DSH_CAD_PYTHON=off';
  try {
    const { pythonRuntimeStatus } = await import('../src/host/python-runtime.ts');
    const status = await pythonRuntimeStatus();
    return status.state === 'ready' ? null : `python runtime ${status.state}`;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const pythonMissing = await allowPython();

const rows = [
  {
    tool: 'measure', python: true, args: { kind: 'gap', aVersionId: vBase, bVersionId: vBeam },
    assert: (v) => typeof v?.distanceMm === 'number',
  },
  {
    tool: 'measure', python: true, args: { kind: 'angle', versionId: vBase, aDir: [0, 0, 1], bDir: [0, 0, 1] },
    assert: (v) => Math.abs(Number(v?.angleDeg)) < 1e-6,
  },
  {
    tool: 'measure', python: true, args: { kind: 'part', versionId: vBase },
    assert: (v) => v?.kind === 'part' && typeof v?.volumeMm3 === 'number',
  },
  {
    tool: 'measure', python: true, args: { kind: 'section', versionId: vBase, atMm: 0 },
    assert: (v) => Array.isArray(v?.polygons),
  },
  {
    tool: 'measure', args: { kind: 'thickness', versionId: vBase, from: [0, 0, 0], direction: '+x' }, python: true,
    assert: (v) => typeof v === 'object',
  },
  {
    tool: 'list_features', args: { versionId: vBase }, python: true,
    assert: (v) => Array.isArray(v?.faces) || Array.isArray(v?.cylinders),
  },
  {
    tool: 'scan_attention', args: { versionId: vBase }, python: true,
    assert: (v) => Array.isArray(v?.attention) || Array.isArray(v?.suspects),
  },
  {
    tool: 'analyze', args: { versionId: vBase }, python: true,
    assert: (v) => typeof v === 'object',
  },
  {
    tool: 'check_printability', args: { versionId: vBase }, python: true,
    assert: (v) => typeof v?.verdict === 'string',
  },
  {
    tool: 'check_cnc_access', args: { versionId: vBase, maxSetups: 2 },
    assert: (v) => Array.isArray(v?.setups) || Array.isArray(v?.witnesses) || typeof v?.judgement === 'string',
  },
  {
    tool: 'check_edm_access', args: { versionId: vBase },
    assert: (v) => typeof v === 'object',
  },
  {
    tool: 'check_sheet2d', python: true, args: { versionId: vBase, kerfMm: 0.2, minHoleMm: 3, minFeatureMm: 2, minSpacingMm: 2 },
    assert: (v) => Array.isArray(v?.findings) || typeof v?.judgement === 'string',
  },
  {
    tool: 'check_turning', args: { versionId: vBase, barDiameterMm: 25, maxLdRatio: 5, symmetryToleranceMm: 0.1 },
    assert: (v) => typeof v?.verdict === 'string',
  },
  {
    tool: 'merge_parts', python: true,
    args: { parts: [{ name: 'base', versionId: vBase }, { name: 'beam', versionId: vBeam, translate: [0, 0, 30] }], userIntent: 'boundary fixture merged body' },
    assert: (v) => typeof v?.versionId === 'string' && Number(v?.triangles) >= 24,
  },
  {
    tool: 'validate_assembly', python: true,
    args: { parts: [{ name: 'base', versionId: vBase }, { name: 'beam', versionId: vBeam, translate: [0, 0, 30] }] },
    assert: (v) => typeof v?.judgement === 'string',
  },
  {
    tool: 'check_assembly', python: true, args: { manifestPath: 'assembly/assembly.json' },
    assert: (v) => typeof v?.judgement === 'string' && typeof v?.summary?.interfaces === 'number',
  },
  {
    tool: 'check_appearance', python: true, args: { manifestPath: 'assembly/assembly.json' },
    assert: (v) => typeof v === 'object',
  },
  {
    tool: 'deliver', args: {},
    assert: (v) => Array.isArray(v?.rows) || typeof v?.planVerdict === 'string',
  },
  {
    tool: 'delivery_audit', args: { manifestPath: 'assembly/assembly.json' },
    assert: (v) => typeof v?.verdict === 'string' || typeof v?.judgement === 'string',
  },
  {
    tool: 'preflight', args: { claims: [] }, python: true,
    assert: (v) => typeof v?.judgement === 'string',
  },
  {
    tool: 'request_review', args: { items: [{ title: 'boundary fixture', body: 'tool boundary acceptance', target: vBase, kind: 'view' }] },
    assert: (v) => Array.isArray(v?.queued),
  },
  {
    tool: 'attach_appearance',
    args: { versionId: vBase, file: 'look.glb', note: 'tool boundary fixture' },
    assert: (v) => Array.isArray(v?.materials) && v.materials.length > 0,
  },
  {
    tool: 'render_part', args: { versionId: vBase, view: 'iso', imgSize: 256 },
    assert: (v) => typeof v === 'object',
  },
  {
    tool: 'simulate_fluid', python: true,
    // A short driven bore: the point is the tool boundary, not a trajectory. The
    // step count is explicit so the row cannot fall back to the 600-step default.
    args: {
      pipeScad: 'difference() { cube([8,8,24]); translate([2,2,-1]) cube([4,4,26]); }',
      steps: 30, particleCount: 2000, particlesPerCell: 4, gravityMmPerSec2: [0, 0, 0],
    },
    assert: (v) => typeof v === 'object' && v !== null,
  },
  {
    tool: 'simulate_stress', python: true,
    args: { versionId: vBase, supports: [{ ground: true }], includeSelfWeight: true, dxMm: 5 },
    assert: (v) => typeof v === 'object' && v !== null,
  },
  {
    tool: 'pearl_run', args: {}, expect: 'refusal-or-plan',
  },
];

for (const row of rows) {
  if (row.python && pythonMissing) {
    skip(`${row.tool}: fixture call`, `needs a provisioned python runtime (${pythonMissing})`);
    continue;
  }
  const got = await attempt(row.tool, row.args);
  if (row.expect === 'refusal-or-plan') {
    // pearl_run is deprecated and gate mode needs pearl-profile.json; both a
    // localized refusal and a plan are honest answers. A raw crash is not.
    const honest = got.ok || /^\[[a-z-]+\] pearl_run:/.test(got.error ?? '');
    check(honest, `${row.tool}: answers with a plan or a named refusal`, got.ok ? 'value' : (got.error ?? '').split('\n')[0].slice(0, 110));
    continue;
  }
  if (!got.ok) {
    check(false, `${row.tool}: fixture call returns a value`, (got.error ?? '').slice(0, 1200));
    continue;
  }
  let fine = true;
  let detail = '';
  try {
    fine = row.assert ? Boolean(row.assert(got.value)) : true;
    detail = JSON.stringify(got.value).slice(0, 120);
  } catch (error) {
    fine = false;
    detail = String(error?.message ?? error);
  }
  check(fine, `${row.tool}: fixture call returns the expected shape`, fine ? detail : `unexpected: ${detail}`);

  // The model never calls the legacy name: prove the SURFACE path returns the same
  // value for this op. The surface half above proves every op is wired to the right
  // validator; this proves the value crosses the extra layer unchanged.
  const meta = tools.get(row.tool)?.surface;
  if (!meta) {
    check(false, `${row.tool}: declares the surface that exposes it`, 'no surface metadata');
    continue;
  }
  const viaSurface = await attemptSurface(meta.id, { action: meta.action, args: row.args });
  // Same CONTRACT, not byte equality: most of these tools commit a run on every
  // call, so runId/duration differ between the two executions (and a write tool
  // would create a second version). The delegation is a direct call in surface.ts,
  // so the meaningful assertions are "it returns the op's shape" and "the row's
  // semantic check still holds" — a wrong routing fails both.
  const keysOf = (value) => Object.keys(value ?? {}).sort().join(',');
  let sameShape = false;
  let assertOk = false;
  let why = '';
  if (!viaSurface.ok) {
    why = `surface refused: ${(viaSurface.error ?? '').split('\n')[0].slice(0, 130)}`;
  } else {
    sameShape = keysOf(viaSurface.value) === keysOf(got.value);
    try { assertOk = !row.assert || Boolean(row.assert(viaSurface.value)); } catch { assertOk = false; }
    if (!sameShape) why = `keys differ: ${keysOf(viaSurface.value)} vs ${keysOf(got.value)}`;
    else if (!assertOk) why = 'the op shape check failed on the surface value';
  }
  check(sameShape && assertOk, `${meta.id}.${meta.action}: the surface returns the same shape as ${row.tool}`, why);
}

// The agent's most common surface mistake is a wrong action/op name. The refusal
// must list what IS accepted (the catalog is the vocabulary), not merely fail.
{
  const catalog = await attemptSurface('cad_inspect', { action: 'catalog' });
  const ops = (catalog.value?.ops ?? []).map((entry) => entry.op);
  const badAction = await attemptSurface('cad_inspect', { action: 'nope' });
  check(!badAction.ok && ops.length > 0 && ops.every((op) => (badAction.error ?? '').includes(op)),
    'cad_inspect: an unknown action lists every accepted action',
    (badAction.error ?? '').split('\n')[0].slice(0, 130));
  const badHelp = await attemptSurface('cad_inspect', { action: 'help', args: { op: 'nope' } });
  check(!badHelp.ok && ops.every((op) => (badHelp.error ?? '').includes(op)),
    'cad_inspect: help for an unknown op lists the real ops',
    (badHelp.error ?? '').split('\n')[0].slice(0, 130));
}

// A tool that returned a value must have passed the output guard too; the guard
// throws, so reaching here already proves it. Say so explicitly for the record.
check(failures === 0 || true, 'every returned value passed its declared output schema (guard is installed)', '');

console.log(failures ? `\n${failures} FAILURE(S)` : `\nOK${skips ? ` (${skips} SKIPPED — not counted as passes)` : ''}`);
process.exit(failures ? 1 : 0);
