// Acceptance for the CHECK-ONLY hole-pattern matcher (C framework v1).
//
// The matcher is pure: it takes list_features-style holes and a declaration.
// This test deliberately does not need Python or a mesh — the integration path
// (checkManifestFeatures) is typechecked and exercised by check_assembly when a
// runtime is available.
//
//   node scripts/accept-features.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkManifestFeatures, matchHolePattern } from '../src/host/features.ts';
import { validateManifest } from '../src/host/manifest.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const feature = {
  kind: 'hole-pattern',
  axis: [1, 0, 0],
  centerMm: [0, 0, 0],
  pcdMm: 208,
  count: 8,
  diameterMm: 18,
  toleranceMm: 0.2,
  through: true,
};
const holes = (opts = {}) => {
  const n = opts.count ?? 8;
  const r = opts.radius ?? 104;
  const d = opts.diameter ?? 18;
  const x = opts.x ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const a = (22.5 + i * 45) * Math.PI / 180;
    return {
      centerMm: [x, r * Math.cos(a), r * Math.sin(a)],
      axisMm: [1, 0, 0],
      diameterMm: d,
      through: opts.through ?? true,
    };
  });
};

const pass = matchHolePattern(feature, holes());
check(pass.verdict === 'pass' && pass.matched === 8, '8 holes on PCD 208 pass', pass.detail);

const missing = matchHolePattern(feature, holes().slice(0, 7));
check(missing.verdict === 'fail' && missing.missing === 1, 'a missing hole fails', missing.detail);

const offPcd = matchHolePattern(feature, holes({ radius: 90 }));
check(offPcd.verdict === 'fail' && offPcd.missing === 8, 'holes on the wrong PCD do not count', offPcd.detail);

const wrongDia = matchHolePattern(feature, holes({ diameter: 20 }));
check(wrongDia.verdict === 'fail' && wrongDia.wrongDiameter === 8, 'wrong diameter is reported separately', wrongDia.detail);

// A through hole appears on the entry and exit faces; the matcher must not
// count the same physical hole twice.
const duplicated = holes().flatMap((h) => [h, { ...h, centerMm: [10, h.centerMm[1], h.centerMm[2]] }]);
const deduped = matchHolePattern(feature, duplicated);
check(deduped.verdict === 'pass' && deduped.matched === 8, 'entry/exit duplicates are deduped', deduped.detail);

const notThrough = matchHolePattern(feature, holes({ through: false }));
check(notThrough.verdict === 'fail' && notThrough.throughFailures === 8, 'through requirement is enforced', notThrough.detail);

const wrongAxis = matchHolePattern(feature, holes().map((h) => ({ ...h, axisMm: [0, 1, 0] })));
check(wrongAxis.verdict === 'fail', 'holes with a non-parallel axis do not count', wrongAxis.detail);

const noHoles = matchHolePattern(feature, []);
check(noHoles.verdict === 'fail' && noHoles.matched === 0, 'no holes is a failure, not a pass', noHoles.detail);

// Manifest validation: a feature is a declared contract, so it must be
// structurally valid before any checker sees it.
const manifest = (features) => ({
  schemaVersion: 1,
  root: {
    id: 'root', kind: 'assembly',
    children: [{ id: 'flange', name: 'flange', kind: 'part', version: 'v001', features }],
  },
});
const valid = validateManifest(manifest([feature]));
check(valid.length === 0, 'a valid hole-pattern declaration passes manifest validation', JSON.stringify(valid));
const badCount = validateManifest(manifest([{ ...feature, count: 0 }]));
check(badCount.some((i) => i.path.includes('features[0]/count')), 'count 0 is rejected at the manifest boundary');
const badAxis = validateManifest(manifest([{ ...feature, axis: [0, 0, 0] }]));
check(badAxis.some((i) => i.path.includes('features[0]/axis')), 'a zero axis is rejected at the manifest boundary');

// The worker-backed path must not turn a missing runtime into a pass. With
// DSH_CAD_PYTHON=off, checkManifestFeatures returns skipped (with the reason),
// not pass/fail.
{
  const prev = process.env.DSH_CAD_PYTHON;
  process.env.DSH_CAD_PYTHON = 'off';
  const dir = mkdtempSync(join(tmpdir(), 'cad-feature-'));
  const manifestPath = join(dir, 'assembly.json');
  writeFileSync(manifestPath, JSON.stringify(manifest([feature]), null, 2));
  const skipped = await checkManifestFeatures(dir, manifestPath);
  check(skipped.length === 1 && skipped[0].verdict === 'skipped' && /python/i.test(skipped[0].detail),
    'a missing Python runtime is skipped with a reason, never a pass', JSON.stringify(skipped));
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.DSH_CAD_PYTHON;
  else process.env.DSH_CAD_PYTHON = prev;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
