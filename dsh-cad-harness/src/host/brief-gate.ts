// The pre-work gate: no design/evidence tool runs before the kickoff brief exists.
//
// WHY. The 2026-11-27 dog-piggy-bank run never wrote a brief or a BOM: "FDM" lived
// only in the user's first message, so no tool could tell which process the part was
// for, and the first process-aware screen had nothing to key on. A rule that lives
// only in a skill is a suggestion; the brief is small and has no geometry in it, so
// it can be a real precondition.
//
// WHAT is required (brief is on the ROOT node; children may be empty):
//   processes  — the SET of processes the user allows (non-empty strings)
//   verify     — what "working" means (assembly / motion / strength / ...)
//   buyVsMake  — the array must exist ([] is a valid "nothing is bought")
//
// WHAT is not gated: creating the brief (`cad_assembly write`), reads (inspect,
// see), session management and cad_python. Without the first exemption the model
// could never satisfy the gate; without the read exemptions it could not inspect
// the project to write the brief.
//
// A project with no binding is skipped here: the tool's own "select a project"
// refusal is the better message, and tests/headless callers have no session.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectCwd, sessionIdOf } from './project.ts';

/** Surfaces/actions that may write geometry or evidence. */
export function briefGateApplies(surface: string, action: string): boolean {
  if (surface === 'cad_part') return true; // catalog/help return before this point in surface.ts
  if (surface === 'cad_assembly') return action !== 'write' && action !== 'info';
  return surface === 'cad_check' || surface === 'cad_simulate';
}

interface BriefShape {
  processes?: unknown;
  verify?: unknown;
  buyVsMake?: unknown;
}

class BriefGateError extends Error {}

function gateError(missing: readonly string[], cwd: string): Error {
  return new BriefGateError(
    'BOM gate: the project has no complete kickoff brief; the requested tool was not run.\n' +
    `  project: ${cwd}\n` +
    `  missing:\n${missing.map((m) => `    - ${m}`).join('\n')}\n` +
    '  fix (before any design/evidence tool):\n' +
    '    cad_assembly({ action: "write", args: { mode: "create", expectedRevision: 0, reason: "kickoff brief",\n' +
    '      root: { kind: "assembly", id: "root", children: [],\n' +
    '        brief: { processes: ["fdm-pla-0.4"], verify: ["assembly"], buyVsMake: [] } } } })\n' +
    '  processes is the SET the user allows; verify says what "working" means; buyVsMake may be [].\n' +
    '  Not gated: cad_assembly write/info, cad_inspect, cad_see, cad_session, cad_python.',
  );
}

/**
 * Throw unless the project's root brief is complete. No-op when the caller has no
 * session (tests/headless) or no project is selected (the tool's own error is better).
 */
export async function assertBriefReady(exec: unknown): Promise<void> {
  if (process.env.DSH_CAD_BRIEF_GATE === 'off') return;
  if (!sessionIdOf(exec)) return;
  let cwd: string;
  try {
    cwd = (await resolveProjectCwd(exec, { requireSelection: true })).cwd;
  } catch {
    return; // let the delegated tool emit the selection error, which names the action
  }

  const file = join(cwd, 'assembly', 'assembly.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw gateError([
        'assembly/assembly.json does not exist (no brief to gate on)',
        'brief.processes: the allowed process set is missing',
        'brief.verify: "working" is missing (assembly / motion / strength / ...)',
        'brief.buyVsMake: the array is missing (use [] when nothing is bought)',
      ], cwd);
    }
    throw new Error(`BOM gate: cannot read ${file}: ${String((error as Error)?.message ?? error)}`);
  }

  let manifest: { root?: { kind?: unknown; brief?: BriefShape } };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch (error) {
    throw new Error(`BOM gate: ${file} is not valid JSON (${String((error as Error)?.message ?? error)})`);
  }
  const root = manifest.root;
  if (!root || root.kind !== 'assembly') {
    throw gateError(['root is not an assembly node (the brief lives on the root assembly)'], cwd);
  }

  const brief = root.brief;
  const missing: string[] = [];
  if (!brief || typeof brief !== 'object') {
    missing.push('root.brief is missing');
  } else {
    const processes = Array.isArray(brief.processes)
      ? brief.processes.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [];
    if (processes.length === 0) {
      missing.push('brief.processes: the allowed process set is empty (ask the user once: FDM / sheet / CNC / injection)');
    }
    if (!Array.isArray(brief.verify) || brief.verify.length === 0) {
      missing.push('brief.verify: "working" is undefined (assembly / motion / strength / ...)');
    }
    if (!Array.isArray(brief.buyVsMake)) {
      missing.push('brief.buyVsMake: array missing (use [] when nothing is bought)');
    }
  }
  if (missing.length > 0) throw gateError(missing, cwd);
}
