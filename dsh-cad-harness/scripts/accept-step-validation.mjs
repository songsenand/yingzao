#!/usr/bin/env node
// L1.4: one validation entry. STL is design evidence (Manifold); STEP is read
// back through import_mesh (cascadio) and compared to the STL; missing/invalid/
// mismatched artifacts get stable codes. Requires the Python runtime.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openVersionStore, readVersionEntry, revertVersion, saveVersion } from '../src/host/version.ts';
import { validateVersionGeometry } from '../src/host/geometry-validate.ts';
import { pythonRuntimeStatus } from '../src/host/python-runtime.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const runtime = await pythonRuntimeStatus();
if (runtime.state !== 'ready') {
  console.log(`SKIP  Python runtime is ${runtime.state}; STEP read-back needs it`);
  process.exit(0);
}

const fixture = (rel) => fileURLToPath(new URL(`../library/parts/${rel}`, import.meta.url));
const stl = new Uint8Array(await readFile(fixture('iso4762.M5x16/fit/model.stl')));
const step = new Uint8Array(await readFile(fixture('iso4762.M5x16/fit/model.step')));
const otherStep = new Uint8Array(await readFile(fixture('din127.M6/fit/model.step')));
const work = await mkdtemp(join(tmpdir(), 'step-accept-'));

const save = async (store, name, input) => {
  const id = await saveVersion(store, {
    userIntent: name,
    sourceCode: 'result = ...',
    sourceFile: 'model.py',
    backend: { kernel: 'cadquery' },
    ...input,
  });
  return id;
};

try {
  const store = openVersionStore(join(work, 'cad-data'));

  const matching = await save(store, 'matching', { stl, step, brepValid: true, brepToleranceMm: 0.01 });
  const entry = await readVersionEntry(store, matching);
  check(entry?.stepFile === 'model.step' && entry.designEvidence === 'mesh', 'version binds the STEP artifact and design evidence', JSON.stringify({ stepFile: entry?.stepFile, designEvidence: entry?.designEvidence }));
  check(Boolean(entry?.stepSha256?.startsWith('sha256:')), 'version binds the STEP hash', entry?.stepSha256);
  check(entry?.brep?.valid === true && entry.brep.validatedBy === 'OCP', 'version carries provider BRepCheck provenance', JSON.stringify(entry?.brep));
  const good = await validateVersionGeometry(store, matching, { requireStep: true });
  const reverted = await revertVersion(store, matching, { reason: 'keep STEP provenance' });
  const revertedEntry = await readVersionEntry(store, reverted);
  const revertedValidation = await validateVersionGeometry(store, reverted, { requireStep: true });
  check(revertedEntry?.stepFile === 'model.step' && revertedEntry?.stepSha256 === entry?.stepSha256, 'revert copies the STEP artifact and hash', JSON.stringify({ stepFile: revertedEntry?.stepFile, hash: revertedEntry?.stepSha256 }));
  check(revertedValidation.step.valid && revertedValidation.consistent, 'reverted STEP still validates', JSON.stringify(revertedValidation.issues));
  check(good.designEvidence === 'mesh', 'design evidence is the STL mesh', good.designEvidence);
  check(good.stl.valid && good.stl.watertight === true, 'STL is a Manifold solid', JSON.stringify(good.stl));
  check(good.step.present && good.step.valid, 'STEP is read back through import_mesh', JSON.stringify(good.step));
  check(good.step.brepValid === true, 'provider BRepCheck is carried, not inferred', String(good.step.brepValid));
  check(good.consistent && good.issues.length === 0, 'matching artifacts are consistent', JSON.stringify(good.issues));

  const missing = await save(store, 'missing step', { stl, brepValid: true });
  const noStep = await validateVersionGeometry(store, missing);
  check(noStep.issues.some((i) => i.code === 'step_missing' && i.severity === 'warn'), 'missing STEP is a warn by default', JSON.stringify(noStep.issues));
  const required = await validateVersionGeometry(store, missing, { requireStep: true });
  check(required.issues.some((i) => i.code === 'step_missing' && i.severity === 'blocked'), 'requireStep turns missing STEP into a block');

  const invalidStep = await save(store, 'invalid step', {
    stl,
    step: new TextEncoder().encode('not a STEP\n'),
    brepValid: true,
  });
  const invalid = await validateVersionGeometry(store, invalidStep, { requireStep: true });
  check(invalid.issues.some((i) => i.code === 'step_invalid'), 'unreadable STEP has its own code', JSON.stringify(invalid.issues));

  const mismatch = await save(store, 'mismatch', { stl, step: otherStep, brepValid: true });
  const mismatched = await validateVersionGeometry(store, mismatch, { requireStep: true });
  check(!mismatched.consistent && mismatched.issues.some((i) => i.code === 'step_artifact_mismatch'), 'STL/STEP mismatch is detected', JSON.stringify(mismatched.issues));

  const datumsVersion = await save(store, 'datums', {
    stl,
    datumSet: { points: [{ name: 'top', point: [0, 0, 5] }], axes: [], planes: [], cylinders: [] },
  });
  const datumsValidation = await validateVersionGeometry(store, datumsVersion);
  check(datumsValidation.datums.present && datumsValidation.datums.valid && datumsValidation.datums.count === 1, 'valid datums.json is accepted', JSON.stringify(datumsValidation.datums));
  check(!datumsValidation.issues.some((i) => i.code === 'datum_outside_bbox'), 'an in-bounds datum is not warned about');

  const outsideDatums = await save(store, 'outside datums', {
    stl,
    datumSet: { points: [{ name: 'nowhere', point: [0, 0, 100] }], axes: [], planes: [], cylinders: [] },
  });
  const outsideValidation = await validateVersionGeometry(store, outsideDatums);
  check(outsideValidation.issues.some((i) => i.code === 'datum_outside_bbox'), 'a schema-valid datum outside the mesh is warned about', JSON.stringify(outsideValidation.issues));

  const badDatums = await save(store, 'bad datums', {
    stl,
    datumSet: { points: [{ name: '', point: [0, 0, 0] }], axes: [], planes: [], cylinders: [] },
  });
  const badDatumsValidation = await validateVersionGeometry(store, badDatums);
  check(badDatumsValidation.issues.some((i) => i.code === 'datums_invalid'), 'invalid datums.json has its own code', JSON.stringify(badDatumsValidation.issues));

  const hashVersion = await save(store, 'hash', { stl, step, brepValid: true });
  await writeFile(join(store.root, 'versions', hashVersion, 'model.step'), Buffer.concat([Buffer.from(step), Buffer.from('\n')]));
  const hashValidation = await validateVersionGeometry(store, hashVersion, { requireStep: true });
  check(hashValidation.issues.some((i) => i.code === 'step_hash_mismatch') && !hashValidation.consistent, 'STEP hash mismatch is detected', JSON.stringify(hashValidation.issues));

  const badBrep = await save(store, 'bad brep', { stl, step, brepValid: false });
  const bad = await validateVersionGeometry(store, badBrep, { requireStep: true });
  check(bad.issues.some((i) => i.code === 'step_invalid_brep'), 'provider BRepCheck=false blocks STEP', JSON.stringify(bad.issues));

  const noStl = await save(store, 'no stl', { sourceCode: 'result = ...' });
  const missingStl = await validateVersionGeometry(store, noStl);
  check(missingStl.issues.some((i) => i.code === 'stl_missing' && i.severity === 'blocked'), 'missing STL is a blocked design failure', JSON.stringify(missingStl.issues));

  const badStl = await save(store, 'bad stl', { stl: new TextEncoder().encode('not an STL'), step });
  const invalidStl = await validateVersionGeometry(store, badStl);
  check(invalidStl.issues.some((i) => i.code === 'stl_invalid'), 'unparseable STL has its own code', JSON.stringify(invalidStl.issues));

  // Control: no STEP at all still yields a valid STL design result (STEP is
  // secondary), so the entry point does not silently require the new artifact.
  const stlOnly = await save(store, 'stl only', { stl });
  const only = await validateVersionGeometry(store, stlOnly);
  check(only.stl.valid && only.issues.every((i) => i.code === 'step_missing'), 'STL-only remains valid (STEP optional)', JSON.stringify(only.issues));
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
