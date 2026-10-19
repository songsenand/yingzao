// Acceptance for `scan_attention` (HARNESS §11.14): a detector is trusted only after it
// has been shown to FIRE on a known defect AND to stay SILENT on the repaired part —
// a detector that only ever fires is noise, one that never fires is decoration.
//
// The pairs come from this repository's own corpus:
//   * 吊盘 v069 had 4 V-notches at the elbow (x≈±37, z≈42) — repaired in v077 by a gusset.
//   * 砝码 v058 was a 769-piece non-manifold mesh — rebuilt as v071 (1 body, watertight).
//   * 调零滑块 v052 is clean and must stay silent.
//
//   node scripts/accept-attention-scan.mjs [--runtime <dir>] [--corpus <dir>]
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAttention } from '../src/host/inspect.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(ROOT, '.tmp-cad-runtime')));
const CORPUS = resolve(argOf('--corpus', join(REPO, 'examples', 'toy-balance', 'cad-data')));
if (!existsSync(join(CORPUS, 'versions'))) {
  console.error(`no versions/ under ${CORPUS} — pass --corpus`);
  process.exit(2);
}
const store = { root: CORPUS };

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const scan = async (versionId) =>
  existsSync(join(CORPUS, 'versions', versionId, 'model.stl'))
    ? scanAttention(store, { versionId })
    : null;

const cornersNear = (report, zMin, zMax) =>
  (report?.suspects ?? []).filter((s) => s.kind === 'reentrant-corner'
    && typeof s.where?.atMm?.[2] === 'number' && s.where.atMm[2] >= zMin && s.where.atMm[2] <= zMax);

console.log('--- scan_attention: does it fire where it must, and stay quiet where it must ---');

const v069 = await scan('v069');
if (v069) {
  const elbow = cornersNear(v069, 41, 45);
  check(elbow.length >= 4, 'v069 吊盘: the elbow notches at z≈42 are FOUND',
    `${elbow.length} corner(s) in z∈[41,45]; e.g. ${JSON.stringify(elbow[0]?.where?.atMm)}`);
  check(Boolean(elbow[0]?.look?.args?.versionId), 'every suspect carries a RUNNABLE next observation (versionId filled in)');
} else {
  console.log('      (skipping v069: not in this corpus)');
}

const v077 = await scan('v077');
if (v077) {
  const elbow = cornersNear(v077, 41, 45);
  check(elbow.length === 0, 'v077 吊盘: after the gusset the elbow is CLEAN (negative control)',
    `${elbow.length} corner(s) in z∈[41,45]`);
  const apex = cornersNear(v077, 70, 73);
  console.log(`      note: the same scan still reports ${apex.length} corner(s) at the apex z≈71.5 — a real, unrepaired finding`);
}

const v058 = await scan('v058');
if (v058) {
  // v058's 768 "extra pieces" are triangles that COLLAPSE when welded (zero-area cap
  // fans from rotate_extrude) — not a broken solid. The scan must say so precisely:
  // naming it "non-manifold" would be the same mis-description this repo already had
  // to correct once.
  check((v058.suspects ?? []).some((s) => s.kind === 'degenerate-faces'),
    'v058 砝码: the 768 collapsed triangles are FLAGGED as degenerate faces',
    `degenerate ${v058.stats?.degenerateFaces} · bodies ${v058.stats?.bodies} · watertight ${v058.stats?.watertight}`);
  check(!(v058.suspects ?? []).some((s) => s.kind === 'non-manifold'),
    'v058 砝码: and NOT mis-labelled non-manifold (it is a closed solid once they are dropped)');
}
const v071 = await scan('v071');
if (v071) check((v071.suspects ?? []).length === 0, 'v071 砝码: the rebuilt weight is CLEAN (negative control)');

const v052 = await scan('v052');
if (v052) check((v052.suspects ?? []).length === 0, 'v052 调零滑块: a clean part stays silent (no noise)');

await resetPythonWorker?.();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
