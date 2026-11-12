#!/usr/bin/env node
// Re-run a stored motion scenario, optionally on newer versions.
//
//   node scripts/replay-motion.mjs <project-dir> <run-id> [--set part=vNNN]... [--cycles N]
//
// A motion run stores its input as `cad-data/runs/<id>/motion-spec.json`. Without
// it, "re-run on the new version" means rebuilding joints/drive by hand; runs
// created before the spec existed say so in `verify` (`motion-not-replayable`).
//
// The replay is a normal simulate_motion call through the real tool object, so
// it writes a new run, a new spec, and the same evidence as a fresh call.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [projectArg, runId, ...rest] = process.argv.slice(2);
if (!projectArg || !runId) {
  console.error('usage: replay-motion.mjs <project-dir> <run-id> [--set part=vNNN]... [--cycles N]');
  process.exit(3);
}

const overrides = {};
let cycles;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--set') {
    const pair = rest[++i] ?? '';
    const at = pair.indexOf('=');
    if (at <= 0) { console.error(`bad --set "${pair}" (want part=vNNN)`); process.exit(3); }
    overrides[pair.slice(0, at)] = pair.slice(at + 1);
  } else if (rest[i] === '--cycles') {
    cycles = Number(rest[++i]);
  } else {
    console.error(`unknown argument "${rest[i]}"`);
    process.exit(3);
  }
}

const project = resolve(projectArg);
const specPath = join(project, 'cad-data', 'runs', runId, 'motion-spec.json');
let spec;
try {
  spec = JSON.parse(await readFile(specPath, 'utf8'));
} catch {
  console.error(`no motion-spec.json at ${specPath} — this run predates input capture and cannot be replayed`);
  process.exit(2);
}

const known = new Set((spec.parts ?? []).map((p) => p.name));
for (const name of Object.keys(overrides)) {
  if (!known.has(name)) {
    console.error(`--set names "${name}", which is not a part of ${runId} (${[...known].join(', ')})`);
    process.exit(3);
  }
}

process.env.DSH_HOME ??= await mkdtemp(join(tmpdir(), 'replay-motion-home-'));
const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { listRuns } = await import('../src/host/runs.ts');

const tools = new Map();
registerCadTools({
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
});
const exec = { agent: { session: { header: { cwd: project } } } };

const parts = (spec.parts ?? []).map((p) => {
  const versionId = overrides[p.name] ?? p.versionId;
  const copy = { ...p };
  if (versionId) {
    copy.versionId = versionId;
    delete copy.scadCode;
  }
  return copy;
});

const args = {
  parts,
  joints: spec.joints ?? [],
  ...(spec.drive ? { drive: spec.drive } : {}),
  ...(spec.oscillators?.length ? { oscillators: spec.oscillators } : {}),
  ...(cycles !== undefined ? { cycles } : (spec.cycles !== null && spec.cycles !== undefined ? { cycles: spec.cycles } : {})),
};

const value = await tools.get('simulate_motion').execute(args, exec);
const runs = await listRuns(projectStores(project).runStore);
const latest = runs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
console.log(JSON.stringify({
  replayedFrom: runId,
  newRun: latest?.id,
  sourceVersionIds: latest?.sourceVersionIds,
  overrides,
  overallStatus: value.overallStatus,
  interferenceCount: value.interferenceCount,
  samplingSatisfied: value.samplingSatisfied,
  maxJointDriftMm: value.maxJointDriftMm,
}, null, 2));
