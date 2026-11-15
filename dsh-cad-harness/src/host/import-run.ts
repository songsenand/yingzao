/**
 * Import an EXTERNAL trajectory as a real run.
 *
 * WHY this exists (2026-11-15). The 64:1 gearbox session computed a 3 s window
 * with its own Python script — 320 input turns, 5 output turns — and could not
 * show it in the panel, because a run is not a file: the panel's RUNS list is the
 * store's index, written by `beginRun`/`commit` under a lock. The script wrote a
 * README instead, and the model's next idea was to edit the plugin, which is the
 * wrong end of the problem.
 *
 * "We are a VENUE, not a product" (HARNESS §6.1): material may arrive from
 * outside — a script, a colleague, another tool. So the venue needs a loading
 * dock: this importer writes through the SAME RunWriter the tools use, so the id
 * allocation, the index, the lock and the artifact layout stay one implementation.
 * It is a CLI, not a tool: the model does not need a new verb, a human or a script
 * needs a way in.
 *
 * What it deliberately does NOT do: judge anything. An imported run is `check`
 * by default — the venue did not witness how the numbers were produced, and
 * saying otherwise would be the "green number nobody can falsify" this project
 * keeps designing against.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beginRun, listRuns, type RunEntry } from './runs.ts';
import { projectStores } from './project.ts';
import { listVersions } from './version.ts';
import type { RunKind } from '../shared/types.ts';

/** The shape the panel's playback reads (`runs/<id>/trajectory.json`). */
export interface ImportedTrajectory {
  times: number[];
  parts: { name: string; bodyType?: 'fixed' | 'dynamic'; frames: number[][] }[];
  events?: { timeSec: number; label: string }[];
}

export interface ImportRequest {
  /** Project directory (the folder that owns `cad-data/`). */
  projectDir: string;
  trajectory: ImportedTrajectory;
  kind?: Extract<RunKind, 'motion' | 'physics'>;
  title?: string;
  summary?: string;
  status?: 'pass' | 'check' | 'fail';
  /** Versions the run was computed on; unknown ids are refused (a typo is not a source). */
  sourceVersionIds?: string[];
  /** name → binary STL, so the playback has geometry to draw. */
  parts?: Record<string, Uint8Array>;
}

/** Structural validation: refuse what the panel cannot play, before writing anything. */
export function validateTrajectory(t: unknown): string[] {
  const issues: string[] = [];
  const obj = t as ImportedTrajectory;
  if (!obj || typeof obj !== 'object') return ['trajectory must be an object'];
  if (!Array.isArray(obj.times) || obj.times.length < 2) {
    issues.push('trajectory.times must be an array with at least 2 entries');
  } else {
    for (let i = 0; i < obj.times.length; i++) {
      const v = obj.times[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) { issues.push(`times[${i}] is not a finite number`); break; }
      if (i > 0 && !(v > obj.times[i - 1]!)) { issues.push(`times[${i}] is not greater than times[${i - 1}]`); break; }
    }
  }
  const n = Array.isArray(obj.times) ? obj.times.length : 0;
  if (!Array.isArray(obj.parts) || obj.parts.length === 0) {
    issues.push('trajectory.parts must be a non-empty array');
  } else {
    const seen = new Set<string>();
    for (const part of obj.parts) {
      if (!part || typeof part.name !== 'string' || part.name.length === 0) { issues.push('a part has no name'); continue; }
      if (seen.has(part.name)) issues.push(`part "${part.name}" appears twice`);
      seen.add(part.name);
      if (!Array.isArray(part.frames)) { issues.push(`part "${part.name}" has no frames`); continue; }
      if (n > 0 && part.frames.length !== n) {
        issues.push(`part "${part.name}" has ${part.frames.length} frames but times has ${n}`);
      }
      for (let i = 0; i < part.frames.length; i++) {
        const f = part.frames[i];
        if (!Array.isArray(f) || f.length !== 7 || f.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
          issues.push(`part "${part.name}" frame ${i} is not 7 finite numbers [x,y,z,qx,qy,qz,qw]`);
          break;
        }
      }
    }
  }
  return issues;
}

/** Normalise a raw file into the stored shape (defaults applied, nothing invented). */
export function normalizeTrajectory(t: ImportedTrajectory): ImportedTrajectory {
  return {
    times: t.times.map((v) => +Number(v).toFixed(6)),
    parts: t.parts.map((p) => ({
      name: p.name,
      bodyType: p.bodyType === 'fixed' ? 'fixed' : 'dynamic',
      frames: p.frames.map((f) => f.map((v) => +Number(v).toFixed(6))),
    })),
    ...(Array.isArray(t.events) && t.events.length > 0
      ? { events: t.events.map((e) => ({ timeSec: +Number(e.timeSec).toFixed(6), label: String(e.label) })) }
      : {}),
  };
}

/**
 * Write the run through the store's own writer and return the committed entry.
 *
 * Throws on any structural problem; the panel then shows a run whose provenance
 * is `sourceVersionIds` + the `imported` marker in the summary.
 */
export async function importRun(req: ImportRequest): Promise<RunEntry> {
  const projectDir = resolve(req.projectDir);
  if (!existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`);
  const issues = validateTrajectory(req.trajectory);
  if (issues.length > 0) {
    throw new Error(`trajectory is not playable — ${issues.length} problem(s):\n  ${issues.join('\n  ')}`);
  }
  const project = projectStores(projectDir);

  const versions = req.sourceVersionIds ?? [];
  if (versions.length > 0) {
    const known = new Set((await listVersions(project.store)).map((v) => v.id));
    const unknown = versions.filter((v) => !known.has(v));
    if (unknown.length > 0) {
      throw new Error(`unknown version id(s): ${unknown.join(', ')} — an imported run names the versions it was computed on`);
    }
  }

  const kind = req.kind ?? 'motion';
  const title = req.title ?? `外部导入 · ${kind}`;
  const run = await beginRun(project.runStore, { kind, title });
  for (const [name, stl] of Object.entries(req.parts ?? {})) await run.part(name, stl);
  await run.json('trajectory.json', normalizeTrajectory(req.trajectory));
  return run.commit({
    status: req.status ?? 'check',
    summary: req.summary ?? '外部脚本导入的轨迹（场地未见证计算过程，按 check 记录）',
    sourceVersionIds: versions,
    subject: `imported:${kind}:${title}`,
  });
}

/** One-line hint printed by the CLI: where to look in the panel. */
export function playbackHint(runId: string): string {
  return `面板「运行」→ ${runId} → 回放（runs/${runId}/trajectory.json）`;
}

/** Read a trajectory JSON file and its optional STL directory. */
export async function readImportInputs(
  trajectoryPath: string,
  stlDir?: string,
): Promise<{ trajectory: ImportedTrajectory; parts: Record<string, Uint8Array> }> {
  const trajectory = JSON.parse(await readFile(trajectoryPath, 'utf8')) as ImportedTrajectory;
  const parts: Record<string, Uint8Array> = {};
  if (stlDir) {
    for (const part of trajectory.parts ?? []) {
      const path = join(stlDir, `${part.name}.stl`);
      if (existsSync(path)) parts[part.name] = new Uint8Array(await readFile(path));
    }
  }
  return { trajectory, parts };
}
