#!/usr/bin/env node
/**
 * `dsh-cad-import-run` — the venue's loading dock for a trajectory computed
 * OUTSIDE the plugin (a Python script, a colleague's sweep, another tool).
 *
 * It writes through the same RunWriter the tools use, so the run lands in the
 * panel exactly like a native one — no hand-edited index, no shadow channel.
 *
 *   dsh-cad-import-run --trajectory sim/traj.json --kind physics \
 *       --title "外部脚本 · 3 s @6400 rpm" --versions v016,v014 \
 *       --stl-dir sim/parts --project .
 *
 * The trajectory file is the shape the panel already plays:
 *   { "times": [...], "parts": [{ "name", "frames": [[x,y,z,qx,qy,qz,qw], ...] }] }
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importRun, playbackHint, readImportInputs, validateTrajectory } from './import-run.ts';

const HELP = `dsh-cad-import-run — put an externally computed trajectory into the panel

usage:
  dsh-cad-import-run --trajectory <file.json> [options]

options:
  --project <dir>        project folder (the one owning cad-data/); default: cwd
  --kind motion|physics  run kind shown in the panel; default: motion
  --title <text>         run title; default: "外部导入 · <kind>"
  --summary <text>       one-line summary stored with the run
  --status pass|check|fail   default: check (the venue did not witness the computation)
  --versions v001,v002   versions the trajectory was computed on (unknown ids are refused)
  --stl-dir <dir>        folder holding <part name>.stl, so playback has geometry
  --help                 this text

The file must be playable: times strictly increasing, every part's frames the same
count as times, each frame 7 finite numbers [x,y,z,qx,qy,qz,qw].`;

interface Args {
  project: string;
  trajectory: string;
  kind: 'motion' | 'physics';
  title?: string;
  summary?: string;
  status?: 'pass' | 'check' | 'fail';
  versions: string[];
  stlDir?: string;
}

export function parseArgs(argv: string[]): Args | { help: true } {
  const args: Args = { project: process.cwd(), trajectory: '', kind: 'motion', versions: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--help': case '-h': return { help: true };
      case '--project': args.project = value(); break;
      case '--trajectory': args.trajectory = value(); break;
      case '--kind': {
        const k = value();
        if (k !== 'motion' && k !== 'physics') throw new Error('--kind must be motion or physics');
        args.kind = k;
        break;
      }
      case '--title': args.title = value(); break;
      case '--summary': args.summary = value(); break;
      case '--status': {
        const s = value();
        if (s !== 'pass' && s !== 'check' && s !== 'fail') throw new Error('--status must be pass, check or fail');
        args.status = s;
        break;
      }
      case '--versions': args.versions = value().split(',').map((v) => v.trim()).filter(Boolean); break;
      case '--stl-dir': args.stlDir = value(); break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!args.trajectory) throw new Error('--trajectory is required');
  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args | { help: true };
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`dsh-cad-import-run: ${(e as Error).message}\n`);
    console.error(HELP);
    return 2;
  }
  if ('help' in args) { console.log(HELP); return 0; }

  try {
    const { trajectory, parts } = await readImportInputs(resolve(args.trajectory), args.stlDir && resolve(args.stlDir));
    const issues = validateTrajectory(trajectory);
    if (issues.length > 0) {
      console.error(`trajectory is not playable — ${issues.length} problem(s):`);
      for (const issue of issues) console.error(`  - ${issue}`);
      return 1;
    }
    const run = await importRun({
      projectDir: args.project,
      trajectory,
      kind: args.kind,
      ...(args.title ? { title: args.title } : {}),
      ...(args.summary ? { summary: args.summary } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.versions.length > 0 ? { sourceVersionIds: args.versions } : {}),
      parts,
    });
    const drawn = Object.keys(parts).length;
    console.log(`imported ${run.id}  (${args.kind}, ${trajectory.times.length} frames, ${trajectory.parts.length} part(s)${drawn ? `, ${drawn} with STL` : ', no STL — playback will show poses only'})`);
    if (!drawn) console.log('  tip: pass --stl-dir so the playback has geometry to draw');
    console.log(`  ${playbackHint(run.id)}`);
    return 0;
  } catch (e) {
    console.error(`dsh-cad-import-run: ${(e as Error).message}`);
    return 1;
  }
}

// Re-exported for the acceptance: it asserts the same validator the CLI uses.
export { validateTrajectory } from './import-run.ts';
export { readFileSync };
