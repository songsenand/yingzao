// Acceptance for the optional bpy art lane (L1/L2, 2026-10-25).
//
// L1 makes user-installed bpy a *supported* lane without putting it in the lock:
// a skill map, a preflight, a baseline studio script, one example, and a QC
// handoff. This script proves the parts that can be proved on a machine that may
// not have bpy installed:
//
//   1  six skills exist; cad-art is reachable from the router; example is present
//   2  both Python scripts parse (they are the map's executable surface)
//   3  preflight runs on the system Python and tells the truth about Python/平台
//   4  preflight runs through the project runtime (overlay attached) and either
//      reports ready or gives the install recipe — never crashes
//   5  L2: render_part's OpenSCAD single/views, auto fallback, hero rejection,
//      old default, four attachments; with bpy: bpy views/hero + attachments
//   6  with bpy: a 64 px four-view smoke produces four non-trivial PNGs + metadata,
//      and a three-material GLB proves --keep-materials preserves color
//   7  without bpy: render_studio.py exits 3 with the install/preflight advice
//   8  with a Blender CLI: the same file renders through `blender -b -P` (dual entry)
//   9  A: attach_appearance + render_part({appearance:true}) keeps GLB materials
//
//   node scripts/accept-bpy-art.mjs
//   DSH_CAD_USER_SITE=/path/to/site-packages node scripts/accept-bpy-art.mjs   # test a temp bpy overlay

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKILLS = join(ROOT, 'skills');
const ART = join(SKILLS, 'cad-art');
const PREFLIGHT = join(ART, 'preflight.py');
const RENDER = join(ART, 'render_studio.py');
const EXAMPLE = resolve(ROOT, '..', 'examples', 'art-decor-panel');
const COLOR_GLB = resolve(ROOT, '..', 'experiments', '20261025_blender_color_design', 'panel-colors.glb');
const SYS_PY = process.platform === 'win32' ? 'python' : 'python3';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const skip = (label, why) => console.log(`SKIP  ${label}  — ${why}`);

const run = async (command, args, options = {}) => {
  try {
    const { runProcess } = await import('../src/host/python-runtime.ts');
    return await runProcess(command, args, { timeoutMs: 120_000, ...options });
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error), timedOut: false };
  }
};

const parseJson = (stdout) => {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
};

const pngSize = (buffer) => {
  if (buffer.length < 24) return null;
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const countPngs = async (dir) => {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.png')).sort();
};

const tinyStl = (path) => {
  const triangles = [
    [[0, 0, 0], [20, 0, 0], [20, 20, 0]], [[0, 0, 0], [20, 20, 0], [0, 20, 0]],
    [[0, 0, 20], [20, 20, 20], [20, 0, 20]], [[0, 0, 20], [0, 20, 20], [20, 20, 20]],
    [[0, 0, 0], [0, 20, 0], [0, 20, 20]], [[0, 0, 0], [0, 20, 20], [0, 0, 20]],
    [[20, 0, 0], [20, 20, 20], [20, 20, 0]], [[20, 0, 0], [20, 0, 20], [20, 20, 20]],
    [[0, 0, 0], [20, 0, 20], [20, 0, 0]], [[0, 0, 0], [0, 0, 20], [20, 0, 20]],
    [[0, 20, 0], [20, 20, 0], [20, 20, 20]], [[0, 20, 0], [20, 20, 20], [0, 20, 20]],
  ];
  const lines = ['solid fixture'];
  for (const [a, b, c] of triangles) {
    lines.push(' facet normal 0 0 0', '  outer loop');
    for (const v of [a, b, c]) lines.push(`   vertex ${v.join(' ')}`);
    lines.push('  endloop', ' endfacet');
  }
  lines.push('endsolid fixture', '');
  return writeFile(path, lines.join('\n'), 'utf8');
};

const tinyBinaryStl = (path) => {
  const triangles = [
    [[0, 0, 0], [20, 0, 0], [20, 20, 0]], [[0, 0, 0], [20, 20, 0], [0, 20, 0]],
    [[0, 0, 20], [20, 20, 20], [20, 0, 20]], [[0, 0, 20], [0, 20, 20], [20, 20, 20]],
    [[0, 0, 0], [0, 20, 0], [0, 20, 20]], [[0, 0, 0], [0, 20, 20], [0, 0, 20]],
    [[20, 0, 0], [20, 20, 20], [20, 20, 0]], [[20, 0, 0], [20, 0, 20], [20, 20, 20]],
    [[0, 0, 0], [20, 0, 20], [20, 0, 0]], [[0, 0, 0], [0, 0, 20], [20, 0, 20]],
    [[0, 20, 0], [20, 20, 0], [20, 20, 20]], [[0, 20, 0], [20, 20, 20], [0, 20, 20]],
  ];
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write('binary fixture', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const [a, b, c] of triangles) {
    offset += 12; // normal (0,0,0)
    for (const v of [a, b, c]) {
      for (const value of v) { buffer.writeFloatLE(value, offset); offset += 4; }
    }
    offset += 2; // attribute byte count
  }
  return writeFile(path, buffer);
};

// ── 1. map and artifacts ───────────────────────────────────────────────────
console.log('--- map ---');
const skillDirs = (await readdir(SKILLS, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
  .map((entry) => entry.name).sort();
check(skillDirs.length === 6, 'six skills are present', skillDirs.join(', '));
check(skillDirs.includes('cad-art'), 'cad-art is a skill directory');
const artSkill = await readFile(join(ART, 'SKILL.md'), 'utf8');
for (const needle of ['render_studio.py', 'preflight.py', 'run_python', 'render_part', 'keep-materials', 'python_runtime',
  'import_part', 'check_printability', '3/7', 'GPL-3.0']) {
  check(artSkill.includes(needle), `cad-art skill mentions ${needle}`);
}
const router = await readFile(join(SKILLS, 'cad-toolbox', 'SKILL.md'), 'utf8');
check(/cad-art/.test(router), 'the toolbox router points at cad-art');
check((await readdir(ART)).includes('render_studio.py') && (await readdir(ART)).includes('preflight.py'),
  'the art skill ships both executable artifacts');
check(existsSync(join(EXAMPLE, 'panel.scad')) && existsSync(join(EXAMPLE, 'README.md')),
  'the decorative-panel example exists (source + README)');
check(existsSync(join(EXAMPLE, 'panel-hero.png')), 'the example has a rendered hero image');

// ── 2. syntax (no bytecode next to the skill) ─────────────────────────────
console.log('--- syntax ---');
const parse = await run(SYS_PY, ['-c',
  'import ast,sys; [ast.parse(open(p, encoding="utf-8").read(), filename=p) for p in sys.argv[1:]]',
  PREFLIGHT, RENDER,
], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (parse.code === -1) skip('Python scripts parse', `${SYS_PY} is not available`);
else check(parse.code === 0, 'preflight.py and render_studio.py parse', parse.stderr.split('\n').slice(-2).join(' '));

// ── 3. preflight on the system Python (the version/platform gate) ─────────
console.log('--- preflight: system python ---');
const sysPy = await run(SYS_PY, ['--version']);
const sysMajorMinor = /(\d+)\.(\d+)/.exec(sysPy.stdout || sysPy.stderr);
const sysPreflightRun = await run(SYS_PY, [PREFLIGHT, '--json']);
const sysPreflight = parseJson(sysPreflightRun.stdout);
if (sysPreflightRun.code === -1) {
  skip('preflight on the system Python', `${SYS_PY} is not available`);
} else {
  check(sysPreflight !== null, 'preflight emits a JSON object on the system Python',
    sysPreflightRun.stderr.split('\n').slice(-2).join(' '));
}
if (sysPreflight) {
  check(['ready', 'not-installed', 'unsupported', 'unsupported-python', 'low-disk', 'version-mismatch']
    .includes(sysPreflight.status), 'preflight status is a known state', sysPreflight.status);
  if (sysMajorMinor && `${sysMajorMinor[1]}.${sysMajorMinor[2]}` !== '3.13') {
    check(sysPreflight.python.ok === false && /unsupported-python|unsupported/.test(sysPreflight.status),
      'preflight rejects a non-3.13 interpreter before the download', sysPreflight.status);
  }
}

// ── 4. preflight through the project runtime (overlay attached) ────────────
console.log('--- preflight: project runtime ---');
let runtime = null;
try {
  const mod = await import('../src/host/python-runtime.ts');
  runtime = { ...mod, status: await mod.pythonRuntimeStatus() };
} catch (error) {
  skip('project runtime preflight', `cannot load the runtime module: ${error}`);
}
let preflight = null;
if (runtime) {
  if (runtime.status.state !== 'ready') {
    skip('project runtime preflight', `runtime is ${runtime.status.state}; acceptance does not provision one`);
  } else {
    const launch = runtime.pythonLaunchArgs(PREFLIGHT, ['--json']);
    const result = await run(runtime.status.venvPython, launch);
    preflight = parseJson(result.stdout);
    check(preflight !== null, 'preflight emits JSON through the runtime + overlay',
      result.stderr.split('\n').slice(-2).join(' '));
    if (preflight) {
      check(!String(result.stderr).includes('Traceback'), 'preflight does not crash through the overlay');
      check(['ready', 'not-installed', 'unsupported', 'unsupported-python', 'low-disk', 'version-mismatch']
        .includes(preflight.status), 'runtime preflight status is a known state', preflight.status);
      if (preflight.status === 'not-installed') {
        check(preflight.install?.args?.packages?.includes('bpy==5.2.3'),
          'not-installed carries the exact bpy==5.2.3 install recipe');
      }
    }
  }
}


const work = await mkdtemp(join(tmpdir(), 'cad-bpy-art-'));
const stl = join(work, 'fixture.stl');
await tinyStl(stl);

// ── 5. L2: render_part's native backend ───────────────────────────────────
console.log('--- L2 native render_part backend ---');
{
  const { renderArt, ArtRenderError } = await import('../src/host/art-render.ts');
  const l2cwd = join(work, 'l2');
  const storeRoot = join(l2cwd, 'cad-data');
  await mkdir(join(storeRoot, 'versions', 'v001'), { recursive: true });
  await tinyBinaryStl(join(storeRoot, 'versions', 'v001', 'model.stl'));

  const single = await renderArt(storeRoot, l2cwd, { versionId: 'v001', engine: 'openscad', mode: 'single', imgSize: 64 });
  check(single.engine === 'openscad' && single.files.length === 1 && single.images.length === 1,
    'L2 openscad single returns one file/image', `${single.files.length}/${single.images.length}`);
  const views = await renderArt(storeRoot, l2cwd, { versionId: 'v001', engine: 'openscad', mode: 'views', imgSize: 64 });
  check(views.files.length === 4 && views.images.length === 4,
    'L2 openscad views returns four files/images', `${views.files.length}/${views.images.length}`);

  const previousPython = process.env.DSH_CAD_PYTHON;
  process.env.DSH_CAD_PYTHON = 'off';
  try {
    const auto = await renderArt(storeRoot, l2cwd, { versionId: 'v001', engine: 'auto', mode: 'single', imgSize: 64 });
    check(auto.fallback === true && auto.engine === 'openscad',
      'L2 auto falls back to OpenSCAD when the runtime/bpy is unavailable', auto.fallbackReason ?? '');
  } finally {
    if (previousPython === undefined) delete process.env.DSH_CAD_PYTHON;
    else process.env.DSH_CAD_PYTHON = previousPython;
  }
  let heroCode = null;
  try { await renderArt(storeRoot, l2cwd, { versionId: 'v001', engine: 'openscad', mode: 'hero' }); }
  catch (error) { if (error instanceof ArtRenderError) heroCode = error.code; }
  check(heroCode === 'invalid', 'L2 hero without bpy is a named error, not a silent downgrade', heroCode ?? 'none');

  // Tool-level attachment proof: the native render_part must attach 4 images and 4 files.
  const { registerCadTools } = await import('../src/host/tools.ts');
  const { projectStores } = await import('../src/host/project.ts');
  const { saveVersion } = await import('../src/host/version.ts');
  const tools = new Map();
  const fakeCtx = {
    tools: { register: (def) => { tools.set(def.name, def); } },
    attachments: { saveImages: async (items) => items.map((item) => ({ kind: 'stub', name: item.name })) },
    reflect: { get: () => undefined }, on: () => {},
  };
  registerCadTools(fakeCtx);
  const project = projectStores(l2cwd);
  const stlBytes = await readFile(join(storeRoot, 'versions', 'v001', 'model.stl'));
  const versionId = await saveVersion(project.store, { stl: stlBytes, userIntent: 'L2 acceptance cube' });
  const exec = { agent: { session: { header: { cwd: l2cwd } } } };
  const renderPart = tools.get('render_part');

  // A: the appearance sidecar. The GLB is copied into the workspace so the tool's
  // workspace-containment check is exercised, not bypassed with a repo absolute path.
  const attachAppearance = tools.get('attach_appearance');
  await writeFile(join(l2cwd, 'panel-colors.glb'), await readFile(COLOR_GLB));
  const attached = await attachAppearance.execute(
    { versionId, file: 'panel-colors.glb', note: 'L2 acceptance' },
    exec,
  );
  check(attached.materials.length === 3,
    'attach_appearance records three materials', attached.materials.join(', '));
  check(existsSync(join(project.root, 'versions', versionId, 'appearance.glb')),
    'attach_appearance writes appearance.glb into the version');
  let appearanceError = null;
  try {
    await renderPart.execute({ versionId, engine: 'openscad', appearance: true }, exec);
  } catch (error) {
    appearanceError = String(error.message);
  }
  check(/appearance renders need engine "bpy"/.test(appearanceError ?? ''),
    'appearance rejects the OpenSCAD backend instead of dropping color', appearanceError ?? 'no error');
  const defaultValue = await renderPart.execute({ versionId }, exec);
  check(defaultValue.engine === 'openscad' && defaultValue.mode === 'single' && defaultValue.files.length === 1,
    'render_part keeps its old default: OpenSCAD single', `${defaultValue.engine}/${defaultValue.mode}`);
  const value = await renderPart.execute({ versionId, engine: 'openscad', mode: 'views', imgSize: 64 }, exec);
  const blocks = renderPart.finalizeContent(exec, { value });
  const images = (blocks ?? []).filter((block) => block.type === 'image');
  check(value.files.length === 4 && value.engine === 'openscad' && images.length === 4,
    'L2 render_part returns four files and attaches four images', `${value.files.length}/${images.length}`);

  if (preflight?.status === 'ready') {
    const bpyValue = await renderPart.execute({ versionId, engine: 'bpy', mode: 'views', imgSize: 64 }, exec);
    const bpyBlocks = renderPart.finalizeContent(exec, { value: bpyValue });
    const bpyImages = (bpyBlocks ?? []).filter((block) => block.type === 'image');
    check(bpyValue.engine === 'bpy' && bpyValue.files.length === 4 && bpyImages.length === 4,
      'L2 render_part bpy views returns four files and attaches four images',
      `${bpyValue.engine}/${bpyValue.files.length}/${bpyImages.length}`);
    const heroValue = await renderPart.execute(
      { versionId, engine: 'bpy', mode: 'hero', imgSize: 64, samples: 4 },
      exec,
    );
    const heroBlocks = renderPart.finalizeContent(exec, { value: heroValue });
    const heroImages = (heroBlocks ?? []).filter((block) => block.type === 'image');
    check(heroValue.engine === 'bpy' && heroValue.mode === 'hero' && heroValue.files.length === 1 && heroImages.length === 1,
      'L2 render_part bpy hero returns one material image', `${heroValue.engine}/${heroValue.files.length}/${heroImages.length}`);
    const autoValue = await renderPart.execute({ versionId, engine: 'auto', mode: 'single', imgSize: 64 }, exec);
    check(autoValue.engine === 'bpy' && autoValue.fallback === false,
      'L2 auto prefers bpy when it is usable', `${autoValue.engine}/${autoValue.fallback}`);
    const appearanceValue = await renderPart.execute(
      { versionId, engine: 'bpy', appearance: true, mode: 'views', imgSize: 64 },
      exec,
    );
    const appearanceBlocks = renderPart.finalizeContent(exec, { value: appearanceValue });
    const appearanceImages = (appearanceBlocks ?? []).filter((block) => block.type === 'image');
    check(appearanceValue.engine === 'bpy' && appearanceValue.appearance === true
      && appearanceValue.files.length === 4 && appearanceImages.length === 4,
      'A: render_part appearance=true returns four files/attachments',
      `${appearanceValue.engine}/${appearanceValue.appearance}/${appearanceValue.files.length}/${appearanceImages.length}`);
    const appearanceAuto = await renderPart.execute(
      { versionId, engine: 'auto', appearance: true, mode: 'single', imgSize: 64 },
      exec,
    );
    check(appearanceAuto.engine === 'bpy' && appearanceAuto.appearance === true,
      'A: auto + appearance prefers bpy and does not fall back',
      `${appearanceAuto.engine}/${appearanceAuto.appearance}`);
    const cyclesSingle = await renderPart.execute(
      { versionId, engine: 'bpy', mode: 'single', renderer: 'cycles', imgSize: 64, samples: 4 },
      exec,
    );
    const cyclesBlocks = renderPart.finalizeContent(exec, { value: cyclesSingle });
    const cyclesImages = (cyclesBlocks ?? []).filter((block) => block.type === 'image');
    check(cyclesSingle.engine === 'bpy' && cyclesSingle.files.length === 1 && cyclesImages.length === 1,
      'L2 bpy single + cycles is lit and attached', `${cyclesSingle.engine}/${cyclesImages.length}`);
  }
}

// ── 6/7. bpy smoke, or the actionable missing path ─────────────────────────
if (runtime && runtime.status.state === 'ready' && preflight?.status === 'ready') {
  console.log('--- bpy smoke (64 px, Workbench, four views) ---');
  const out = join(work, 'bpy');
  const launch = runtime.pythonLaunchArgs(RENDER, [stl, '--out', out, '--mode', 'views',
    '--engine', 'workbench', '--size', '64', '--samples', '1', '--quiet']);
  const result = await run(runtime.status.venvPython, launch);
  check(result.code === 0, 'render_studio.py exits 0 under the runtime overlay',
    result.stderr.split('\n').filter(Boolean).slice(-2).join(' '));
  const pngs = await countPngs(out);
  check(pngs.length === 4, 'four view PNGs were written', pngs.join(', '));
  for (const name of pngs) {
    const buffer = await readFile(join(out, name));
    const size = pngSize(buffer);
    check(size?.width === 64 && size?.height === 64, `${name} is 64×64`, size ? `${size.width}×${size.height}` : 'not a PNG');
    check(buffer.length > 1200, `${name} is non-trivial (${buffer.length} bytes)`);
  }
  let metadata = null;
  try { metadata = parseJson(await readFile(join(out, 'metadata.json'), 'utf8')); } catch { /* reported below */ }
  check(metadata?.ok === true && metadata?.engine === 'workbench' && metadata?.mode === 'views',
    'metadata records ok/engine/mode', JSON.stringify(metadata?.engine));
  check(Math.abs((metadata?.bbox_mm?.x ?? 0) - 20) < 1e-6, 'metadata bbox keeps mm (20 mm cube)');

  console.log('--- bpy color smoke: preserved GLB materials ---');
  if (existsSync(COLOR_GLB)) {
    const colorOut = join(work, 'color');
    const colorLaunch = runtime.pythonLaunchArgs(RENDER, [COLOR_GLB, '--out', colorOut,
      '--mode', 'hero', '--engine', 'workbench', '--size', '64', '--keep-materials',
      '--json', join(colorOut, 'metadata.json'), '--quiet']);
    const colorResult = await run(runtime.status.venvPython, colorLaunch);
    check(colorResult.code === 0, 'render_studio.py --keep-materials exits 0',
      colorResult.stderr.split('\n').filter(Boolean).slice(-2).join(' '));
    let colorMetadata = null;
    try { colorMetadata = parseJson(await readFile(join(colorOut, 'metadata.json'), 'utf8')); } catch { /* reported below */ }
    const colorPngs = await countPngs(colorOut);
    check(colorMetadata?.materials_preserved === true,
      'color metadata says materials_preserved', String(colorMetadata?.materials_preserved));
    check(Array.isArray(colorMetadata?.source_materials) && colorMetadata.source_materials.length === 3,
      'color metadata keeps three source materials',
      Array.isArray(colorMetadata?.source_materials) ? colorMetadata.source_materials.join(', ') : 'none');
    check(colorPngs.length === 1 && colorPngs[0]?.endsWith('.png'),
      'color smoke writes one PNG', colorPngs.join(', '));
  } else {
    check(false, 'color design fixture exists', COLOR_GLB);
  }
} else {
  console.log('--- missing bpy: the actionable failure path ---');
  const out = join(work, 'missing');
  const result = await run(SYS_PY, [RENDER, stl, '--out', out, '--mode', 'views',
    '--engine', 'workbench', '--size', '64', '--samples', '1', '--quiet']);
  // A system Python that happens to have bpy can render; otherwise the expected
  // exit is 3 and the message must name both the install command and preflight.
  if (result.code === 3) {
    check(/bpy is not importable/.test(result.stderr), 'missing bpy exits 3 with a named cause');
    check(/python_runtime action=install/.test(result.stderr), 'the failure names the install command');
    check(/preflight\.py/.test(result.stderr), 'the failure points at preflight');
  } else {
    check(result.code === 0, 'system Python unexpectedly rendered or failed for an unknown reason',
      `exit ${result.code}`);
  }
}

// ── 7. dual entry: a Blender CLI renders the same file without bpy ────────
console.log('--- Blender CLI dual entry ---');
const blenderVersion = await run('blender', ['--version'], { timeoutMs: 20_000 });
if (blenderVersion.code !== 0) {
  skip('Blender CLI renders the same script', 'blender is not on PATH');
} else {
  const out = join(work, 'cli');
  const result = await run('blender', ['-b', '--factory-startup', '-noaudio', '-P', RENDER, '--',
    stl, '--out', out, '--mode', 'views', '--engine', 'workbench', '--size', '64',
    '--samples', '1', '--quiet'], { timeoutMs: 120_000 });
  check(result.code === 0, 'blender -b -P render_studio.py exits 0',
    result.stderr.split('\n').filter(Boolean).slice(-2).join(' '));
  const pngs = await countPngs(out);
  check(pngs.length === 4, 'CLI path writes four PNGs', pngs.join(', '));
  let metadata = null;
  try { metadata = parseJson(await readFile(join(out, 'metadata.json'), 'utf8')); } catch { /* reported below */ }
  check(metadata?.ok === true, 'CLI path writes metadata');
}

await rm(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
