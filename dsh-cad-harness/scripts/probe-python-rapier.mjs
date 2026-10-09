// Feasibility probe for Q2=A (physics canonical moves to Python, DECISION-LOG
// 2026-10-08). Before porting ~1200 lines of rapier scene building, the question
// that decides HOW to port is measurable: on identical input, how far do the two
// bindings drift?
//
// The TS side is the incumbent (`@dimforge/rapier3d-compat` through physics.ts,
// baselines green: accept-m36 17/17, accept-p2, accept-p3). The Python side is
// `rapier3d` 0.36 from the pinned runtime. Same geometry (the same STL bytes),
// same gravity (mm scale, -9810), same dt (1/60), same step count, same
// integrator settings wherever the API allows.
//
// What this probe answers:
//   * does the Python API express the same scenes at all (bodies, colliders,
//     revolute/prismatic joints, limits)?
//   * how large is the trajectory divergence, and is it a different ANSWER or a
//     different rounding of the same answer?
//
//   node scripts/probe-python-rapier.mjs [--runtime <dir>] [--out <json>]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhysics } from '../src/host/physics.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const RUNTIME_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const OUT = resolve(argOf('--out', join(ROOT, 'data', 'bench', 'python-rapier-probe.json')));
process.env.DSH_CAD_PYTHON_ROOT = RUNTIME_ROOT;
const VENV_PYTHON = process.platform === 'win32'
  ? join(RUNTIME_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(RUNTIME_ROOT, 'venv', 'bin', 'python');
if (!existsSync(VENV_PYTHON)) {
  console.error(`no venv python at ${VENV_PYTHON}`);
  process.exit(2);
}

const PY_PROBE = String.raw`
import json, sys
import numpy as np
import rapier3d as R

scene = json.load(open(sys.argv[1]))

def vertices(path):
    data = open(path, 'rb').read()
    n = int.from_bytes(data[80:84], 'little')
    dt = np.dtype([('n', '<3f4'), ('v', '<9f4'), ('a', '<u2')])
    return np.frombuffer(data, dtype=dt, count=n, offset=84)['v'].reshape(-1, 3).astype(np.float64)

def quat_from_euler_xyz_deg(deg):
    rx, ry, rz = (np.radians(float(d)) for d in deg)
    cx, sx = np.cos(rx / 2), np.sin(rx / 2)
    cy, sy = np.cos(ry / 2), np.sin(ry / 2)
    cz, sz = np.cos(rz / 2), np.sin(rz / 2)
    # XYZ order, same composition as the TS eulerToQuat
    qx = sx * cy * cz + cx * sy * sz
    qy = cx * sy * cz - sx * cy * sz
    qz = cx * cy * sz + sx * sy * cz
    qw = cx * cy * cz - sx * sy * sz
    return (qx, qy, qz, qw)

world = R.PhysicsWorld(tuple(scene['gravity']))
world.integration_parameters.dt = scene['dt']

bodies = {}
for part in scene['parts']:
    builder = R.RigidBody.fixed() if part['bodyType'] == 'fixed' else R.RigidBody.dynamic().can_sleep(False).ccd_enabled(True)
    builder = builder.translation(tuple(part['position']))
    if part.get('rotation'):
        builder = builder.rotation(R.Rotation3.from_quaternion(quat_from_euler_xyz_deg(part['rotation'])))
    body = world.add_body(builder)
    verts = vertices(part['path'])
    if part['bodyType'] == 'dynamic':
        collider = R.Collider.convex_hull(verts).density(part.get('density', 1.05e-6))
    else:
        collider = R.Collider.convex_hull(verts)
    world.add_collider(collider, body)
    if part.get('initialAngularVelocity'):
        world.rigid_bodies[body].angvel = tuple(part['initialAngularVelocity'])
    bodies[part['name']] = body

for joint in scene.get('joints', []):
    a, b = bodies[joint['bodyA']], bodies[joint['bodyB']]
    axis = tuple(joint['axis'])
    if joint['type'] == 'revolute':
        builder = R.RevoluteJoint.builder(axis=axis) if hasattr(R.RevoluteJoint, 'builder') else None
        if builder is None:
            raise RuntimeError('no revolute builder')
        builder = builder.local_anchor1(tuple(joint['anchorA'])).local_anchor2(tuple(joint['anchorB']))
    else:
        builder = R.PrismaticJoint.builder(axis=axis)
        builder = builder.local_anchor1(tuple(joint['anchorA'])).local_anchor2(tuple(joint['anchorB']))
        if joint.get('limits'):
            builder = builder.limits(joint['limits'][0], joint['limits'][1])
    world.impulse_joints.insert(a, b, builder.build())

samples = []
for step in range(scene['steps']):
    world.step()
    if step % scene['sampleEvery'] == 0 or step == scene['steps'] - 1:
        frame = {'step': step, 'parts': {}}
        for name, handle in bodies.items():
            body = world.rigid_bodies[handle]
            frame['parts'][name] = {
                'position': [float(v) for v in body.translation],
                'rotation': [float(v) for v in body.rotation.quaternion],
            }
        samples.append(frame)

final = {name: [float(v) for v in world.rigid_bodies[handle].translation] for name, handle in bodies.items()}
print(json.dumps({'samples': samples, 'finalPositions': final}))
`;

const { compileStlOnly } = await import('../src/host/compile.ts');
const box = await compileStlOnly('cube([40,40,100], center=true);');
const arm = await compileStlOnly('cube([120,10,10], center=true);');
const base = await compileStlOnly('cube([20,20,20], center=true);');
if (!box.success || !arm.success || !base.success) {
  console.error('compile failed');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'cad-rapier-probe-'));
const boxPath = join(dir, 'box.stl');
const armPath = join(dir, 'arm.stl');
const basePath = join(dir, 'base.stl');
writeFileSync(boxPath, box.stl);
writeFileSync(armPath, arm.stl);
writeFileSync(basePath, base.stl);

const groundScad = 'translate([0,0,-5]) cube([400,400,10], center=true);';
const ground = await compileStlOnly(groundScad);
const groundPath = join(dir, 'ground.stl');
writeFileSync(groundPath, ground.stl);

const DT = 1 / 60;
const DURATION = 2;
const STEPS = Math.round(DURATION / DT);

const SCENARIOS = [
  {
    label: 'topple: a 40×40×100 box on the ground, kicked about Y',
    parts: [
      { name: 'ground', path: groundPath, stl: ground.stl, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'box', path: boxPath, stl: box.stl, bodyType: 'dynamic', position: [0, 0, 50], initialAngularVelocity: [0, 6, 0] },
    ],
    joints: [],
  },
  {
    label: 'pendulum: 120mm arm hinged about X on a fixed base',
    parts: [
      { name: 'base', path: basePath, stl: base.stl, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'arm', path: armPath, stl: arm.stl, bodyType: 'dynamic', position: [70, 0, 0] },
    ],
    // axis Y (across the arm) so gravity actually swings it down; axis X would
    // only let it roll about its own length — a degenerate case both engines agree on.
    joints: [{ type: 'revolute', bodyA: 'base', bodyB: 'arm', anchorA: [10, 0, 0], anchorB: [-60, 0, 0], axis: [0, 1, 0] }],
  },
  {
    // The same joint WITHOUT anything to collide with: the base hangs off to the
    // -X side of the pivot, so the arm sweeps a clean quarter circle. This is the
    // case that separates "the two engines solve the same constraint" from "the
    // two engines resolve the same contact".
    label: 'free pendulum: 120mm arm, nothing in its path',
    parts: [
      { name: 'base', path: basePath, stl: base.stl, bodyType: 'fixed', position: [-10, 0, 60] },
      { name: 'arm', path: armPath, stl: arm.stl, bodyType: 'dynamic', position: [60, 0, 60] },
    ],
    joints: [{ type: 'revolute', bodyA: 'base', bodyB: 'arm', anchorA: [10, 0, 0], anchorB: [-60, 0, 0], axis: [0, 1, 0] }],
  },
  {
    label: 'slider: a box on a prismatic joint along Z, limited, under gravity',
    parts: [
      { name: 'rail', path: basePath, stl: base.stl, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'carriage', path: boxPath, stl: box.stl, bodyType: 'dynamic', position: [0, 0, 60] },
    ],
    joints: [{ type: 'prismatic', bodyA: 'rail', bodyB: 'carriage', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1], limits: [-50, 10] }],
  },
];

function runPython(scenePath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(VENV_PYTHON, ['-I', '-c', PY_PROBE, scenePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('close', (code) => {
      if (code === 0) resolvePromise(JSON.parse(out));
      else reject(new Error(`python exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

const results = [];
for (const scenario of SCENARIOS) {
  console.log(`--- ${scenario.label} ---`);

  // TS incumbent
  const tsReport = await runPhysics({
    parts: scenario.parts.map(({ name, stl, bodyType, position, initialAngularVelocity }) => ({
      name, stl, bodyType, position, ...(initialAngularVelocity ? { initialAngularVelocity } : {}),
    })),
    joints: scenario.joints,
    durationSec: DURATION,
    timestepSec: DT,
    keyframeCount: 6,
  });
  const tsTrajectory = new Map(tsReport.trajectory.parts.map((part) => [part.name, part.frames]));

  // Python
  const sceneFile = join(dir, `${scenario.label.split(':')[0]}.json`);
  writeFileSync(sceneFile, JSON.stringify({
    gravity: [0, 0, -9810],
    dt: DT,
    steps: STEPS,
    sampleEvery: 1,
    parts: scenario.parts.map(({ name, path, bodyType, position, initialAngularVelocity }) => ({
      name, path, bodyType, position, ...(initialAngularVelocity ? { initialAngularVelocity } : {}),
    })),
    joints: scenario.joints,
  }));
  const py = await runPython(sceneFile);

  // Divergence: per-step position delta for each part, and the final pose.
  const perPart = {};
  for (const part of scenario.parts) {
    const tsFrames = tsTrajectory.get(part.name) ?? [];
    let maxDelta = 0;
    let lastDelta = 0;
    for (const sample of py.samples) {
      const frame = tsFrames[sample.step];
      if (!frame) continue;
      const position = sample.parts[part.name]?.position;
      if (!position) continue;
      const delta = Math.hypot(position[0] - frame[0], position[1] - frame[1], position[2] - frame[2]);
      maxDelta = Math.max(maxDelta, delta);
      lastDelta = delta;
    }
    const tsFinal = tsReport.finalPositions[part.name] ?? [NaN, NaN, NaN];
    const pyFinal = py.finalPositions[part.name] ?? [NaN, NaN, NaN];
    perPart[part.name] = {
      tsFinal: tsFinal.map((v) => +v.toFixed(3)),
      pyFinal: pyFinal.map((v) => +v.toFixed(3)),
      finalDeltaMm: +Math.hypot(...tsFinal.map((v, i) => v - pyFinal[i])).toFixed(3),
      maxTrajectoryDeltaMm: +maxDelta.toFixed(3),
      lastStepDeltaMm: +lastDelta.toFixed(3),
      tsFrames: tsFrames.length,
      pySamples: py.samples.length,
    };
    console.log(`  ${part.name.padEnd(9)} TS ${JSON.stringify(perPart[part.name].tsFinal)} → py ${JSON.stringify(perPart[part.name].pyFinal)}`);
    console.log(`             final Δ ${perPart[part.name].finalDeltaMm} mm · max trajectory Δ ${perPart[part.name].maxTrajectoryDeltaMm} mm`);
  }
  results.push({ scenario: scenario.label, parts: perPart, steps: STEPS, dtSec: DT });
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), tsEngine: 'rapier3d-compat (physics.ts)', pyEngine: 'rapier3d 0.36', results }, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
