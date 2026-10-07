#!/usr/bin/env node
// Materialise the 01b-diagnosis material from the microscope5 corpus.
//
// Two modes, on purpose:
//
//   node tools/materialize-01b.mjs dossier   (default)
//     Builds subjects/01b-diagnosis/dossier/ — the JSON evidence ONLY (assembly.json,
//     every run.json + report.json, cad-data/manifest.json). ~1.1MB, small enough
//     to commit, which is what makes this level self-contained and portable: a
//     fresh clone can run it without the (gitignored) 50MB corpus.
//
//     The whole diagnosis is answerable from the dossier: which interfaces were
//     machine-checked is in assembly.json; which runs covered how many parts and
//     whether they passed is in run.json; the failure detail is in report.json.
//
//   node tools/materialize-01b.mjs corpus
//     Builds subjects/01b-diagnosis/cad-data/ + assembly/ — a full corpus laid out
//     exactly where the CAD tools look (project root = <cwd>/cad-data/), so
//     `check_assembly` and `delivery_audit` can run against it. Gitignored, and
//     needs examples/microscope5/cad-data/ to be present locally.
//
// Either way, PROJECT.md / execution_summaries/ / docs/ from microscope5 are
// deliberately NOT copied: they are the previous agent's own narrative, and a
// diagnosis that reads the defendant's self-report is not a diagnosis.
//
// Both targets land under subjects/ — the candidate-visible side. The task
// prompt and the rubric stay in graders/, which the session never sees.

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, '..');
const levelDir = join(benchDir, 'subjects', '01b-diagnosis');
const sourceDir = resolve(benchDir, '..', 'microscope5');

const mode = process.argv[2] ?? 'dossier';
if (!['dossier', 'corpus'].includes(mode)) {
  console.error(`unknown mode "${mode}" — use "dossier" or "corpus"`);
  process.exit(2);
}

const sourceCad = join(sourceDir, 'cad-data');
const sourceAssembly = join(sourceDir, 'assembly');
if (!existsSync(sourceCad)) {
  console.error(
    `source corpus missing: ${sourceCad}\n` +
    `01b needs examples/microscope5/cad-data/ to be present locally (it is gitignored).`,
  );
  process.exit(1);
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function copyTree(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

async function dossier() {
  const out = join(levelDir, 'dossier');
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'runs'), { recursive: true });

  await copyTree(join(sourceAssembly, 'assembly.json'), join(out, 'assembly.json'));
  await copyTree(join(sourceCad, 'manifest.json'), join(out, 'cad-data-manifest.json'));

  let runs = 0;
  let bytes = 0;
  const entries = await readdir(join(sourceCad, 'runs'), { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const from = join(sourceCad, 'runs', e.name);
    const to = join(out, 'runs', e.name);
    await mkdir(to, { recursive: true });
    for (const f of ['run.json', 'report.json']) {
      const src = join(from, f);
      if (!existsSync(src)) continue;
      const body = await readFile(src);
      await writeFile(join(to, f), body);
      bytes += body.length;
    }
    runs++;
  }

  const assemblySize = (await stat(join(out, 'assembly.json'))).size;
  console.log(`dossier  -> ${out}`);
  console.log(`  assembly.json        ${kb(assemblySize)}`);
  console.log(`  cad-data-manifest    ${kb((await stat(join(out, 'cad-data-manifest.json'))).size)}`);
  console.log(`  runs/*/run.json etc. ${runs} runs, ${kb(bytes)}`);
  console.log('  (PROJECT.md / execution_summaries / docs deliberately excluded)');
}

async function corpus() {
  const cadData = join(levelDir, 'cad-data');
  const assembly = join(levelDir, 'assembly');
  await rm(cadData, { recursive: true, force: true });
  await rm(assembly, { recursive: true, force: true });
  console.log('copying corpus (50MB, this takes a moment)…');
  await copyTree(sourceCad, cadData);
  await copyTree(sourceAssembly, assembly);
  console.log(`corpus   -> ${cadData}`);
  console.log(`corpus   -> ${assembly}`);
  console.log('  the CAD tools resolve <cwd>/cad-data/, so run the session with');
  console.log(`  cwd = ${levelDir}`);
  console.log('  gitignored — do not commit.');
}

await (mode === 'dossier' ? dossier() : corpus());
