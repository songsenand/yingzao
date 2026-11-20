#!/usr/bin/env node
// L1.3: a version carries its sourceFile + backend pin; switching the kernel for
// a NEW version must not rewrite the old one; a compile job dispatches by pin.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openVersionStore, readManifest, readVersionEntry, readVersionSource, saveVersion,
} from '../src/host/version.ts';
import { getJob, openJobStore, startCompileJob } from '../src/host/jobs.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const work = await mkdtemp(join(tmpdir(), 'kernel-switch-'));
try {
  const store = openVersionStore(join(work, 'cad-data'));
  const stl = new Uint8Array([0x73, 0x74, 0x6c, 0x01]);
  const v1 = await saveVersion(store, {
    scadCode: 'cube(1);',
    stl,
    userIntent: 'SCAD pin',
    partId: 'p1',
    backend: { kernel: 'openscad', options: { compileBackend: 'auto' } },
  });
  const v1Entry = await readVersionEntry(store, v1);
  check(v1Entry?.sourceFile === 'model.scad', 'v001 records model.scad', v1Entry?.sourceFile);
  check(v1Entry?.backend?.kernel === 'openscad', 'v001 pins OpenSCAD', v1Entry?.backend?.kernel);

  const v1ScadBytes = await readFile(join(store.root, 'versions', v1, 'model.scad'), 'utf8');
  const v1StlStat = await stat(join(store.root, 'versions', v1, 'model.stl'));

  const v2 = await saveVersion(store, {
    sourceCode: 'result = cq.Workplane("XY").box(1, 2, 3)',
    sourceFile: 'model.py',
    backend: { kernel: 'cadquery', version: '2.8.0' },
    stl,
    userIntent: 'CQ pin',
    parentVersion: v1,
    partId: 'p1',
  });
  const v2Entry = await readVersionEntry(store, v2);
  check(v2Entry?.sourceFile === 'model.py', 'v002 records model.py', v2Entry?.sourceFile);
  check(v2Entry?.backend?.kernel === 'cadquery', 'v002 pins CadQuery', v2Entry?.backend?.kernel);

  const source1 = await readVersionSource(store, v1);
  const source2 = await readVersionSource(store, v2);
  check(source1?.kernel === 'openscad' && source1.code === 'cube(1);', 'v001 source stays OpenSCAD', JSON.stringify(source1));
  check(source2?.kernel === 'cadquery' && source2.code.includes('Workplane'), 'v002 source is Python', JSON.stringify({ kernel: source2?.kernel, file: source2?.sourceFile }));

  check(await readFile(join(store.root, 'versions', v1, 'model.scad'), 'utf8') === v1ScadBytes, 'saving v002 does not rewrite v001 source');
  check((await stat(join(store.root, 'versions', v1, 'model.stl'))).mtimeMs === v1StlStat.mtimeMs, 'saving v002 does not recompile v001 STL');

  const manifest = await readManifest(store);
  check(manifest.versions.length === 2, 'both versions are in the index', String(manifest.versions.length));

  // Legacy row: a vNNN/ with model.scad and no sourceFile/backend metadata.
  const legacyDir = join(store.root, 'versions', 'v999');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, 'model.scad'), 'cube(9);', 'utf8');
  const legacy = await readVersionSource(store, 'v999');
  check(legacy?.kernel === 'openscad' && legacy.code === 'cube(9);', 'legacy model.scad is readable without metadata', JSON.stringify(legacy));

  // Dispatch proof without a pack: the CQ job must choose model.py and report
  // cadquery_pack_missing (not "unknown version" / missing model.scad).
  const jobs = openJobStore(join(work, 'cad-data'));
  const savedPack = process.env.DSH_CAD_CQ_PACK;
  process.env.DSH_CAD_CQ_PACK = '/nonexistent/cadquery-pack';
  let job;
  try {
    job = await startCompileJob({ store: jobs, versions: store, project: work, versionId: v2, timeoutMs: 5000 });
    check(job.status === 'running', 'CQ job returns before compiling', job.status);
    for (let i = 0; i < 100 && job.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = getJob(jobs, job.id) ?? job;
    }
  } finally {
    if (savedPack === undefined) delete process.env.DSH_CAD_CQ_PACK; else process.env.DSH_CAD_CQ_PACK = savedPack;
  }
  check(job.status === 'failed', 'CQ job fails on the missing pack', `${job.status}: ${job.error}`);
  check(String(job.error).includes('cadquery_pack_missing'), 'CQ job dispatches to the CQ provider', String(job.error));
  const cqLog = await readFile(join(jobs.root, job.id, 'cadquery.log'), 'utf8').catch(() => '');
  check(cqLog.includes('cadquery_pack_missing'), 'the job writes cadquery.log, not openscad.log', cqLog.slice(0, 80));

  let missing = '';
  try {
    await startCompileJob({ store: jobs, versions: store, project: work, versionId: 'v9999' });
  } catch (error) { missing = String(error?.message ?? error); }
  check(missing.includes('unknown version'), 'unknown version is refused before a job row', missing);
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
