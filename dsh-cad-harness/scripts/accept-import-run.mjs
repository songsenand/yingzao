// Acceptance: an external script can put its trajectory into the panel.
//
// WHY: the 64:1 gearbox session computed a 3 s / 6400 rpm window in its own
// Python script and could not show it — a run is not a file, the panel's RUNS
// list is the store index. HARNESS §6.1 says this is a VENUE, so material from
// outside must be able to come in. This acceptance drives the actual CLI
// (`dsh-cad-import-run`) against a throwaway project and then reads the store
// the way the panel does.
//
//   node scripts/accept-import-run.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'scripts', 'import-run.mjs');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const project = mkdtempSync(join(tmpdir(), 'cad-import-'));
mkdirSync(join(project, 'sim'), { recursive: true });

// Two parts, 5 frames, a plain rotation about z: what a script would write.
const frames = (phase) => Array.from({ length: 5 }, (_, i) => {
  const a = phase + i * 0.05;
  return [0, 0, 0, Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
});
const trajectory = {
  times: [0, 0.01, 0.02, 0.03, 0.04],
  parts: [
    { name: 'gear_a', bodyType: 'dynamic', frames: frames(0) },
    { name: 'gear_b', bodyType: 'dynamic', frames: frames(0.1) },
  ],
  events: [{ timeSec: 0.02, label: 'engraved' }],
};
const trajPath = join(project, 'sim', 'traj.json');
writeFileSync(trajPath, JSON.stringify(trajectory));

const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// ---- 1. the happy path -----------------------------------------------------
{
  const r = run(['--project', project, '--trajectory', trajPath, '--kind', 'physics', '--title', '外部脚本 · 5 帧']);
  check(r.code === 0, 'the CLI exits 0', r.out.trim().slice(0, 300));
  const id = (r.out.match(/imported (r\d{3,})/) ?? [])[1];
  check(Boolean(id), 'it prints the new run id', r.out.trim().split('\n')[0]);
  check(r.out.includes('回放'), 'it prints where to watch it');

  const dir = join(project, 'cad-data', 'runs', id ?? 'r000');
  check(existsSync(join(dir, 'trajectory.json')), 'runs/<id>/trajectory.json exists');
  check(existsSync(join(dir, 'run.json')), 'runs/<id>/run.json exists (the self-describing record)');

  const manifest = JSON.parse(readFileSync(join(project, 'cad-data', 'runs', 'manifest.json'), 'utf8'));
  const entry = manifest.runs.find((x) => x.id === id);
  check(Boolean(entry), 'the run is REGISTERED in the index the panel lists', id);
  check(entry?.kind === 'physics', 'kind is what was asked for', entry?.kind);
  check(entry?.status === 'check', 'status defaults to check — the venue did not witness the computation', entry?.status);

  const stored = JSON.parse(readFileSync(join(dir, 'trajectory.json'), 'utf8'));
  check(stored.times.length === 5 && stored.parts.length === 2, 'trajectory stored intact', `${stored.times.length} times`);
  check(stored.events?.[0]?.label === 'engraved', 'events survive the import');
}

// ---- 2. playability is enforced BEFORE anything is written -----------------
{
  const bad = [
    { name: 'times not increasing', t: { times: [0, 0.02, 0.01], parts: [{ name: 'a', frames: [[0,0,0,0,0,0,1],[0,0,0,0,0,0,1],[0,0,0,0,0,0,1]] }] } },
    { name: 'frame count differs from times', t: { times: [0, 0.01], parts: [{ name: 'a', frames: [[0,0,0,0,0,0,1]] }] } },
    { name: 'frame is not 7 numbers', t: { times: [0, 0.01], parts: [{ name: 'a', frames: [[0,0,0,1],[0,0,0,1]] }] } },
  ];
  for (const c of bad) {
    const p = join(project, 'sim', `bad-${c.name.replace(/\W+/g, '-')}.json`);
    writeFileSync(p, JSON.stringify(c.t));
    const r = run(['--project', project, '--trajectory', p]);
    check(r.code !== 0, `refuses: ${c.name}`, `${r.code}`);
    check(/not playable/.test(r.out), `  …and says why: ${c.name}`);
  }
}

// ---- 3. an unknown version id is refused (a typo is not a source) ----------
{
  const r = run(['--project', project, '--trajectory', trajPath, '--versions', 'v999']);
  check(r.code !== 0 && /unknown version/.test(r.out), 'refuses an unknown --versions id', r.out.trim().slice(0, 160));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
