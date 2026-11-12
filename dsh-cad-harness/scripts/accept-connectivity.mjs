// Acceptance for check_connectivity (DESIGN §18: a part must be ONE
// connected solid). Verified against the REAL tool code with a temp project
// store:
//
//   1. mesh level: two cubes apart → 2 bodies with correct bboxes; two cubes
//      sharing a face (a union) → 1 body; empty mesh → 0.
//   2. tool level: multi-body version → verdict multi-body with per-body
//      sizes; single-cube version → single-body.
//   3. generation discipline: the generate_part warning text exists and names
//      the rule (static check on the source — the compile path itself is
//      covered by the m1 acceptance).
//
//   node scripts/accept-connectivity.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { connectedBodies, parseBinaryStl } from '../src/host/mesh.ts';
import { registerCadTools } from '../src/host/tools.ts';


let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// Minimal binary-STL writer for hand-built triangles.
function writeStl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('hand-built for acceptance'.padEnd(80, ' '), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const [n, a, b, c] of tris) {
    for (const v of [n, a, b, c]) for (let k = 0; k < 3; k++) buf.writeFloatLE(v[k], off), off += 4;
    buf.writeUInt16LE(0, off); off += 2;
  }
  return buf;
}
function cubeTris(x0, y0, z0, s) {
  const [x1, y1, z1] = [x0 + s, y0 + s, z0 + s];
  const q = (a, b, c, d, n) => {
    // two triangles per quad, wound CCW from outside
    return [[n, a, b, c], [n, a, c, d]];
  };
  return [
    ...q([x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[0,0,-1]),
    ...q([x0,y1,z1],[x1,y1,z1],[x1,y0,z1],[x0,y0,z1],[0,0,1]),
    ...q([x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0],[0,-1,0]),
    ...q([x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1],[0,1,0]),
    ...q([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[-1,0,0]),
    ...q([x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0],[1,0,0]),
  ];
}

// ── 1. mesh level ────────────────────────────────────────────────────────────
{
  const apart = parseBinaryStl(new Uint8Array(writeStl([...cubeTris(0, 0, 0, 10), ...cubeTris(50, 0, 0, 10)])));
  const apartBodies = connectedBodies(apart);
  check(apartBodies.count === 2, 'two cubes apart → 2 bodies', `got ${apartBodies.count}`);
  check(apartBodies.bodies[0].max[0] - apartBodies.bodies[0].min[0] === 10,
    'per-body bbox is the cube itself', JSON.stringify(apartBodies.bodies[0]));

  const welded = parseBinaryStl(new Uint8Array(writeStl([...cubeTris(0, 0, 0, 10), ...cubeTris(10, 0, 0, 10)])));
  check(connectedBodies(welded).count === 1,
    'two cubes sharing a face (a union) → 1 body', `got ${connectedBodies(welded).count}`);

  check(connectedBodies({ vertProperties: new Float32Array(0), triVerts: new Uint32Array(0) }).count === 0,
    'empty mesh → 0 bodies');
}

// ── 2. tool level, against a real temp project store ─────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'cad-connectivity-'));
  process.env.DSH_HOME = home;
  const project = join(home, 'project');
  const { registerCadTools } = await import('../src/host/tools.ts');
  const registered = [];
  const ctx = {
    tools: { register: (d) => registered.push(d) },
    attachments: {},
    reflect: { get: () => null },
    on: () => {},
    fetch: { register: () => {} },
  };
  registerCadTools(ctx);
  const tool = registered.find((t) => t.name === 'measure_part');
  check(!!tool && JSON.stringify(tool.output?.schema ?? {}).includes('"bodies"'), 'measure_part is registered and carries the body fields (check_connectivity was merged into it)');
  check(registered.some((t) => t.name === 'generate_part'), 'generation tools still registered alongside');

  // A project with one multi-body version and one single-body version.
  const { projectStores, ensureProjectDir } = await import('../src/host/project.ts');
  const stores = projectStores(project);
  await ensureProjectDir(stores);
  mkdirSync(join(stores.root, 'versions', 'v001'), { recursive: true });
  writeFileSync(join(stores.root, 'versions', 'v001', 'model.stl'),
    writeStl([...cubeTris(0, 0, 0, 10), ...cubeTris(50, 0, 0, 10)]));
  mkdirSync(join(stores.root, 'versions', 'v002'), { recursive: true });
  writeFileSync(join(stores.root, 'versions', 'v002', 'model.stl'), writeStl(cubeTris(0, 0, 0, 10)));

  const exec = { agent: { session: { header: { cwd: project } } } };
  const multi = await tool.execute({ versionId: 'v001' }, exec);
  check(multi.bodyVerdict === 'multi-body' && multi.bodies === 2,
    'tool: a two-fragment version reports multi-body', JSON.stringify({ bodyVerdict: multi.bodyVerdict, bodies: multi.bodies }));
  check(JSON.stringify(multi.bodySizes[0]) === '[10,10,10]',
    'tool: per-body sizes are real mm', JSON.stringify(multi.bodySizes));

  const single = await tool.execute({ versionId: 'v002' }, exec);
  check(single.bodyVerdict === 'single-body' && single.bodies === 1,
    'tool: a single cube reports single-body', JSON.stringify({ bodyVerdict: single.bodyVerdict, bodies: single.bodies }));

  let refused = false;
  try { await tool.execute({ versionId: 'vXXX' }, exec); } catch (e) { refused = /no model\.stl|unknown version/.test(String(e.message)); }
  check(refused, 'missing version refuses with an actionable error');

  rmSync(home, { recursive: true, force: true });
  delete process.env.DSH_HOME;
}

// ── 3. generation discipline text exists ─────────────────────────────────────
{
  const src = new URL('../src/host/tools.ts', import.meta.url);
  const { readFileSync } = await import('node:fs');
  const tools = readFileSync(src, 'utf8');
  check(tools.includes('DISCIPLINE (DESIGN §18)') && tools.includes('Run measure_part to see where each body sits'),
    'generate_part warns with the single-solid discipline when shells > 1');
  // Read the WHOLE skills tree, not one file: the skill was split into layers
  // (tier-1 router + per-job skills + reference files), and a doc test pinned to a
  // single path silently stops testing anything the moment prose moves.
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const skillsRoot = new URL('../skills', import.meta.url).pathname;
  const walk = (dir) => readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.md') ? [full] : [];
  });
  const md = walk(skillsRoot).map((f) => readFileSync(f, 'utf8')).join('\n');
  check(md.includes('ONE connected solid') && md.includes('measure_part'),
    'the skill carries the single-solid discipline and routes to the tool (measure_part.bodies)');
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
