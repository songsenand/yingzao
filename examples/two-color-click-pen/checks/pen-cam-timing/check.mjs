// checker/v1: two-color click pen functional invariant.
//
// This check does NOT read evidence/cam_timing.json. It reads the rotor STL that
// the V1 harness passes as geometry (the delivered/current version) and recovers
// the cam surface by a vertical ray cast at the two follower radii, then asserts:
//   - state 0/1/2 tip positions (black at world 0, red at world 180);
//   - black arm top vs red track bottom clearance over 0..360 deg.
//
// It is deliberately self-contained (Node builtins only): a check package must run
// on a temp copy of itself, so it cannot rely on the harness's node_modules.
// The negative sample is a flat plate at z=90: every state is wrong, so it must
// not pass.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'checker/v1';
const CHECKER = { id: 'pen-cam-timing', version: '1.0.0' };
const CRITERIA = [
  'state0-black-tip',
  'state0-red-tip',
  'state1-black-tip',
  'state1-red-tip',
  'state2-black-tip',
  'state2-red-tip',
  'black-arm-red-track-clearance',
];

const DEFAULTS = {
  rotorPartId: 'rotor',
  blackRadiusMm: 6.3,
  redRadiusMm: 3.6,
  refillLengthMm: 100,
  redOffsetMm: 8.5,
  noseZMm: 0,
  stateToleranceMm: 0.25,
  stepDeg: 2,
  minClearanceMm: 0.2,
  states: [
    { rotorDeg: 0, blackTipMm: -4, redTipMm: 8 },
    { rotorDeg: 120, blackTipMm: 4, redTipMm: -4 },
    { rotorDeg: 240, blackTipMm: 4, redTipMm: 8 },
  ],
};

const BASE = { apiVersion: API, checker: CHECKER, artifacts: [] };

function emit(report) {
  process.stdout.write(JSON.stringify(report));
}

function errorReport(code, message) {
  return {
    ...BASE,
    status: 'error',
    findings: [],
    coverage: { criteria: [], complete: false, skipped: [] },
    error: { code, message },
  };
}

// ── STL ─────────────────────────────────────────────────────────────────────
// Binary (OpenSCAD) and ASCII. Only vertices are needed: the ray is vertical, so
// the hit is a 2D point-in-triangle test plus the triangle plane's z.
function loadStl(path) {
  const buf = readFileSync(path);
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (n > 0 && buf.length === 84 + n * 50) {
      const tris = new Float64Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let v = 0; v < 3; v++) {
          tris[i * 9 + v * 3] = buf.readFloatLE(o + v * 12);
          tris[i * 9 + v * 3 + 1] = buf.readFloatLE(o + v * 12 + 4);
          tris[i * 9 + v * 3 + 2] = buf.readFloatLE(o + v * 12 + 8);
        }
      }
      return { tris, count: n };
    }
  }
  const text = buf.toString('utf8');
  const verts = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'vertex' && parts.length >= 4) {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) verts.push(x, y, z);
    }
  }
  return { tris: Float64Array.from(verts), count: Math.floor(verts.length / 9) };
}

function surfaceZ(tris, count, x, y) {
  let best = Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const x1 = tris[o], y1 = tris[o + 1], z1 = tris[o + 2];
    const x2 = tris[o + 3], y2 = tris[o + 4], z2 = tris[o + 5];
    const x3 = tris[o + 6], y3 = tris[o + 7], z3 = tris[o + 8];
    const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
    const b = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
    const c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    const z = a * z1 + b * z2 + c * z3;
    if (z < best) best = z;
  }
  return Number.isFinite(best) ? best : null;
}

// ── check ───────────────────────────────────────────────────────────────────
function run(input) {
  const started = Date.now();
  const cfg = { ...DEFAULTS, ...(input.constraints?.checkConfig ?? {}) };
  if (!Array.isArray(cfg.states) || cfg.states.length !== 3) {
    return errorReport('bad-config', 'config.states must contain exactly three states');
  }
  const parts = input.geometry?.parts ?? [];
  const rotor = parts.find((p) => p.id === cfg.rotorPartId || String(p.id ?? '').endsWith(`/${cfg.rotorPartId}`));
  if (!rotor?.stl) {
    return errorReport('missing-geometry', `geometry has no part "${cfg.rotorPartId}" with an stl path`);
  }
  const stlPath = resolve(process.cwd(), rotor.stl);
  let mesh;
  try {
    mesh = loadStl(stlPath);
  } catch (e) {
    return errorReport('unreadable-stl', `${stlPath}: ${String(e?.message ?? e)}`);
  }
  if (mesh.count === 0) return errorReport('empty-stl', `${stlPath}: no triangles`);
  const { tris, count } = mesh;

  const deg2rad = (d) => (d * Math.PI) / 180;
  const blackX = (rotorDeg) => cfg.blackRadiusMm * Math.cos(deg2rad(-rotorDeg));
  const blackY = (rotorDeg) => cfg.blackRadiusMm * Math.sin(deg2rad(-rotorDeg));
  const redX = (rotorDeg) => cfg.redRadiusMm * Math.cos(deg2rad(180 - rotorDeg));
  const redY = (rotorDeg) => cfg.redRadiusMm * Math.sin(deg2rad(180 - rotorDeg));

  const tipAt = (rotorDeg) => {
    const zb = surfaceZ(tris, count, blackX(rotorDeg), blackY(rotorDeg));
    const zr = surfaceZ(tris, count, redX(rotorDeg), redY(rotorDeg));
    return {
      zb,
      zr,
      blackTip: zb === null ? null : zb - cfg.refillLengthMm,
      redTip: zr === null ? null : zr - cfg.redOffsetMm - cfg.refillLengthMm,
    };
  };

  const findings = [];
  const skipped = [];

  for (let i = 0; i < 3; i++) {
    const state = cfg.states[i];
    const tips = tipAt(state.rotorDeg);
    for (const side of ['black', 'red']) {
      const criterion = `state${i}-${side}-tip`;
      const measured = side === 'black' ? tips.blackTip : tips.redTip;
      const expected = side === 'black' ? state.blackTipMm : state.redTipMm;
      const surface = side === 'black' ? tips.zb : tips.zr;
      if (measured === null || surface === null) {
        skipped.push({ criterion, reason: 'ray did not hit the rotor at this radius/angle' });
        continue;
      }
      const err = Math.abs(measured - expected);
      const ok = err <= cfg.stateToleranceMm;
      findings.push({
        criterion,
        verdict: ok ? 'pass' : 'fail',
        measured: round(measured, 3),
        limit: expected,
        unit: 'mm',
        witness: {
          kind: 'cam-state',
          rotorDeg: state.rotorDeg,
          side,
          surfaceZ: round(surface, 3),
          tipZ: round(measured, 3),
          expectedTipZ: expected,
          errorMm: round(err, 3),
        },
        attention: [{
          kind: 'part',
          part: cfg.rotorPartId,
          where: [
            round(side === 'black' ? blackX(state.rotorDeg) : redX(state.rotorDeg), 3),
            round(side === 'black' ? blackY(state.rotorDeg) : redY(state.rotorDeg), 3),
            round(surface, 3),
          ],
          note: `rotor ${state.rotorDeg} deg, ${side} follower`,
        }],
        message: `state ${i} ${side} tip ${round(measured, 3)}mm at rotor ${state.rotorDeg} deg (expected ${expected} +/-${cfg.stateToleranceMm})`,
      });
    }
  }

  // Black arm top (r=6.3, world 0) vs red track bottom above it (r=3.6, world 0).
  let minClear = Infinity;
  let atDeg = null;
  let minBlack = null;
  let minRed = null;
  let clearanceMissing = false;
  for (let d = 0; d <= 360; d += cfg.stepDeg) {
    const m = deg2rad(-d);
    const zb = surfaceZ(tris, count, cfg.blackRadiusMm * Math.cos(m), cfg.blackRadiusMm * Math.sin(m));
    const zr = surfaceZ(tris, count, cfg.redRadiusMm * Math.cos(m), cfg.redRadiusMm * Math.sin(m));
    if (zb === null || zr === null) { clearanceMissing = true; break; }
    const clear = zr - zb;
    if (clear < minClear) { minClear = clear; atDeg = d; minBlack = zb; minRed = zr; }
  }
  if (clearanceMissing || atDeg === null) {
    skipped.push({ criterion: 'black-arm-red-track-clearance', reason: 'ray did not hit one of the two tracks' });
  } else {
    const ok = minClear >= cfg.minClearanceMm && minClear > -0.01;
    findings.push({
      criterion: 'black-arm-red-track-clearance',
      verdict: ok ? 'pass' : 'fail',
      measured: round(minClear, 3),
      limit: cfg.minClearanceMm,
      unit: 'mm',
      witness: {
        kind: 'cam-clearance',
        minDistanceMm: round(minClear, 3),
        atRotorDeg: atDeg,
        blackTopZ: round(minBlack, 3),
        redBottomZ: round(minRed, 3),
      },
      attention: [{
        kind: 'part',
        part: cfg.rotorPartId,
        where: [
          round(cfg.blackRadiusMm * Math.cos(deg2rad(-atDeg)), 3),
          round(cfg.blackRadiusMm * Math.sin(deg2rad(-atDeg)), 3),
          round(minBlack, 3),
        ],
        note: `black arm under red track, tightest at rotor ${atDeg} deg`,
      }],
      message: `black arm under red track min ${round(minClear, 3)}mm at rotor ${atDeg} deg (limit ${cfg.minClearanceMm}mm)`,
    });
  }

  const complete = skipped.length === 0;
  const status = !complete ? 'blocked' : findings.some((f) => f.verdict !== 'pass') ? 'fail' : 'pass';
  const evaluated = CRITERIA.filter((c) => !skipped.some((s) => s.criterion === c));
  emit({
    ...BASE,
    status,
    findings,
    coverage: { criteria: evaluated, complete, skipped },
    runtime: { ms: Date.now() - started },
  });
}

function round(v, n) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const early = run(JSON.parse(raw || '{}'));
    if (early) emit(early);
  } catch (e) {
    emit(errorReport('check-crashed', String(e?.stack ?? e)));
  }
});
