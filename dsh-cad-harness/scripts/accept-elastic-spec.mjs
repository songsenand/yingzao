#!/usr/bin/env node
// S0 elastic-spec validation: the `elastic` envelope must be checked before a
// manifest reaches the worker. A typo in `freeLengthMm` must not silently turn a
// spring check into a skip; an impossible solid height must be rejected up front.

import { validateManifest } from '../src/host/manifest.ts';
import { formatSnapFitChecks } from '../src/host/assembly-check.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const base = (elastic) => ({
  schemaVersion: 1,
  name: 'elastic-spec',
  root: {
    id: 'root', kind: 'assembly',
    children: [
      { id: 'base', kind: 'part', version: 'v001' },
      { id: 'beam', kind: 'part', version: 'v002' },
    ],
    interfaces: [
      { id: 'I1', a: 'base.端', b: 'beam.端', type: '弹簧', severity: 'hard', elastic },
    ],
  },
});

const issuesOf = (elastic) => validateManifest(base(elastic));
const hasPath = (issues, suffix) => issues.some((i) => i.path.endsWith(suffix));

const good = issuesOf({ behavior: 'axial-spring', direction: 'compression', freeLengthMm: 10, stiffnessNPerMm: 2, solidHeightMm: 3, forceBudgetN: 5, stiffnessTolerancePct: 20, source: 'catalog' });
check(good.length === 0, 'a complete axial-spring spec validates', JSON.stringify(good));

const badSolid = issuesOf({ freeLengthMm: 10, stiffnessNPerMm: 2, solidHeightMm: 20 });
check(hasPath(badSolid, '/elastic/solidHeightMm'), 'solid height above free length is rejected', JSON.stringify(badSolid));

const badBehavior = issuesOf({ behavior: 'spring', freeLengthMm: 10, stiffnessNPerMm: 2 });
check(hasPath(badBehavior, '/elastic/behavior'), 'unknown behavior is rejected', JSON.stringify(badBehavior));

const badGuided = issuesOf({ freeLengthMm: 10, stiffnessNPerMm: 2, guided: 'yes' });
check(hasPath(badGuided, '/elastic/guided'), 'non-boolean guided is rejected', JSON.stringify(badGuided));

const typo = issuesOf({ freeLengthMm: 10, stiffnessNPerM: 2 });
check(hasPath(typo, '/elastic/stiffnessNPerM'), 'a typo key is rejected rather than ignored', JSON.stringify(typo));

const badTolerance = issuesOf({ freeLengthMm: 10, stiffnessNPerMm: 2, stiffnessTolerancePct: 150 });
check(hasPath(badTolerance, '/elastic/stiffnessTolerancePct'), 'tolerance outside [0,100] is rejected', JSON.stringify(badTolerance));

const badTravel = issuesOf({ freeLengthMm: 10, stiffnessNPerMm: 2, requiredTravelMm: 20, maxTravelMm: 10 });
check(hasPath(badTravel, '/elastic/requiredTravelMm'), 'requirement above max travel is rejected', JSON.stringify(badTravel));

const goodSnap = issuesOf({
  behavior: 'snap-fit', lobeCount: 4, lobeWidthMm: 8.9, lobeThicknessMm: 0.8,
  leverArmMm: 4, radialInterferenceMm: 0.125, youngModulusMPa: 3500,
  leadAngleDeg: 45, frictionCoeff: 0.3, forceBudgetN: 20, maxStrainPct: 2, retentionLoadN: 5,
});
check(goodSnap.length === 0, 'a complete snap-fit spec validates', JSON.stringify(goodSnap));

const missingLobe = issuesOf({
  behavior: 'snap-fit', lobeWidthMm: 8.9, lobeThicknessMm: 0.8,
  leverArmMm: 4, radialInterferenceMm: 0.125, youngModulusMPa: 3500,
});
check(hasPath(missingLobe, '/elastic/lobeCount'), 'a declared snap-fit without lobeCount is rejected', JSON.stringify(missingLobe));

const fractionalLobe = issuesOf({
  behavior: 'snap-fit', lobeCount: 2.5, lobeWidthMm: 8.9, lobeThicknessMm: 0.8,
  leverArmMm: 4, radialInterferenceMm: 0.125, youngModulusMPa: 3500,
});
check(hasPath(fractionalLobe, '/elastic/lobeCount'), 'a fractional lobe count is rejected', JSON.stringify(fractionalLobe));

const badLead = issuesOf({
  behavior: 'snap-fit', lobeCount: 4, lobeWidthMm: 8.9, lobeThicknessMm: 0.8,
  leverArmMm: 4, radialInterferenceMm: 0.125, youngModulusMPa: 3500, leadAngleDeg: 90,
});
check(hasPath(badLead, '/elastic/leadAngleDeg'), 'a 90-degree lead angle is rejected', JSON.stringify(badLead));

const l2 = formatSnapFitChecks({
  checks: [
    { check: 'insertion', utilization: 2.9, marginPct: -190, verdict: 'over' },
    { check: 'retention', verdict: 'unknown' },
    { check: 'strain', utilization: 0.47, marginPct: 53, verdict: 'ok' },
  ],
});
check(l2.includes('insertion 2.9x (margin -190%) over') && l2.includes('retention ? unknown') && l2.includes('strain 0.47x (margin 53%) ok'),
  'L2 formatter is one compact line per check', l2);

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
