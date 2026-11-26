// "Re-run this check on the CURRENT version" — and what the corpus cannot rebuild.
//
// WHY A PLANNER AND NOT A BUTTON: a re-run is only a re-run if the INPUTS are the
// same question. `runs/rNNN/run.json` stores the kind, the versions and a summary
// subject — it does NOT store the request. So for a stress run the loads are gone,
// and for a motion run the joints and the drive are gone. Re-running those with
// defaults would produce a NEW ANSWER to a DIFFERENT QUESTION, filed under the same
// kind — the exact class of fabricated evidence the delivery audit exists to stop.
//
// So each check is classified by what the corpus can supply:
//
//   direct      inputs are fully derivable (the version, or the manifest):
//               printability, assembly-check;
//   needs-args  inputs came from the caller and were never persisted:
//               stress (loads, constraints), motion (joints, drive), physics
//               (joints, bodyType) — refused, naming exactly what is missing;
//   unavailable the kind has no runs and no derivable definition.
//
// The caller (route + panel) shows the classification, so "cannot re-run" is a
// visible state with reasons, never a silent default.

export type CheckKind = 'printability' | 'assembly-check' | 'stress' | 'motion' | 'physics';

export interface RerunSource {
  /** Version ids of the part, newest last. */
  versions: { id: string; partId: string }[];
  /** Existing runs, newest last, with their kind and cited versions. */
  runs: { id: string; kind: string; sourceVersionIds: string[]; request?: Record<string, unknown> }[];
  /** Whether `assembly/assembly.json` exists (the manifest path). */
  hasManifest: boolean;
}

export type RerunPlan =
  | { kind: CheckKind; mode: 'direct'; currentVersionId: string; note: string }
  /** A later run saved its request: the same question can be re-asked, version re-pinned. */
  | { kind: CheckKind; mode: 'replay'; args: Record<string, unknown>; lastRunId: string; note: string }
  | { kind: CheckKind; mode: 'needs-args'; needs: string[]; lastRunId: string | null; note: string }
  | { kind: CheckKind; mode: 'unavailable'; note: string };

/** What each kind needs that the corpus does not keep. */
const MISSING_INPUTS: Record<CheckKind, string[]> = {
  printability: [],
  'assembly-check': [],
  stress: ['material', 'loads', 'constraints'],
  motion: ['joints', 'drive'],
  physics: ['joints', 'bodyType'],
};

/**
 * The newest version of the part the caller is looking at.
 *
 * "Current" is per PART: a part's newest version is the current one even when other
 * parts moved on. Ordering is by the store's own array (append-only), not by id
 * string — `v10` sorts before `v9` lexically.
 */
export function currentVersionOf(versions: { id: string; partId: string }[], partId?: string): string | null {
  const pool = partId ? versions.filter((version) => version.partId === partId) : versions;
  return pool.length ? pool[pool.length - 1]!.id : null;
}

/**
 * Classify every check kind for this corpus.
 *
 * `kinds` defaults to all five; passing a subset keeps the panel's row list honest
 * when a project has no assembly at all.
 */
export function planCheckRerun(
  source: RerunSource,
  kinds: CheckKind[] = ['printability', 'assembly-check', 'stress', 'motion', 'physics'],
  partId?: string,
): RerunPlan[] {
  const currentVersionId = currentVersionOf(source.versions, partId);
  return kinds.map((kind) => {
    const last = [...source.runs].reverse().find((run) => run.kind === kind) ?? null;
    const missing = MISSING_INPUTS[kind];
    if (missing.length > 0) {
      // A run that PERSISTED its request can be replayed: same question, geometry
      // re-pinned to the current version. Runs written before the field existed
      // cannot — their inputs are gone, and pretending otherwise is the bug this
      // planner exists to prevent.
      if (last?.request) {
        const args = repinRequest(last.request, source.versions, last.sourceVersionIds, partId);
        return {
          kind,
          mode: 'replay',
          args,
          lastRunId: last.id,
          note: `replays the request saved by ${last.id}, with the version re-pinned to the current one`,
        };
      }
      return {
        kind,
        mode: 'needs-args',
        needs: missing,
        lastRunId: last?.id ?? null,
        note: `${kind} needs ${missing.join(', ')}: the run store keeps the answer, not the question`
          + (last ? ` (last ${kind} run: ${last.id}, written before requests were saved)` : ''),
      };
    }
    if (kind === 'printability') {
      if (!currentVersionId) return { kind, mode: 'unavailable', note: 'no versions — nothing to screen' };
      return {
        kind,
        mode: 'direct',
        currentVersionId,
        note: `screen ${currentVersionId} with the project's process profiles`,
      };
    }
    // assembly-check
    if (!source.hasManifest) return { kind, mode: 'unavailable', note: 'no assembly/assembly.json in this project' };
    return {
      kind,
      mode: 'direct',
      currentVersionId: currentVersionId ?? '',
      note: 're-check every interface contract against the CURRENT versions of its endpoints',
    };
  });
}

/**
 * Re-pin a saved request to the CURRENT versions, without touching anything else.
 *
 * Every version reference the tools use is covered: `versionId` (stress,
 * printability) and `parts[].versionId` (motion, physics). A reference whose part
 * cannot be identified is LEFT AS IT WAS — silently dropping a body would turn a
 * re-run of a mechanism into a different mechanism.
 */
export function repinRequest(
  request: Record<string, unknown>,
  versions: { id: string; partId: string }[],
  citedVersionIds: string[],
  partId?: string,
): Record<string, unknown> {
  const newestOf = (versionId: unknown): unknown => {
    if (typeof versionId !== 'string') return versionId;
    const owner = versions.find((version) => version.id === versionId);
    if (!owner) return versionId;
    return currentVersionOf(versions, partId ?? owner.partId) ?? versionId;
  };
  const out: Record<string, unknown> = { ...request };
  if (typeof out.versionId === 'string') out.versionId = newestOf(out.versionId);
  if (Array.isArray(out.parts)) {
    out.parts = (out.parts as Record<string, unknown>[]).map((part) => (
      part && typeof part === 'object' && typeof part.versionId === 'string'
        ? { ...part, versionId: newestOf(part.versionId) }
        : part
    ));
  }
  // The run's own citation should follow too, so a report can say what it replaced.
  out.replayedFrom = citedVersionIds;
  return out;
}

/**
 * The verdict for a plan the caller asked to execute.
 *
 * A route that runs `needs-args` kinds anyway is the failure mode this function
 * exists to make impossible: it returns the refusal with machine-readable `needs`,
 * so a UI can render "需要 material、loads" instead of an empty default run.
 */
export function canExecute(plan: RerunPlan): { ok: true } | { ok: false; reason: string; needs: string[] } {
  if (plan.mode === 'direct') return { ok: true };
  if (plan.mode === 'replay') return { ok: true };
  if (plan.mode === 'needs-args') {
    return { ok: false, reason: plan.note, needs: plan.needs };
  }
  return { ok: false, reason: plan.note, needs: [] };
}
