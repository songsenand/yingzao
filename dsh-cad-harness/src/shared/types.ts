// Shared types for Host/Client probe payloads.

export interface EchoRequest {
  message: string;
}

export interface EchoResponse {
  pong: boolean;
  receivedAt: string;
  echo: string | null;
}

// ---------------------------------------------------------------------------
// The browse tree: 零件 (part) → 记录 (version | run).
//
// A *part* is the thing being designed — the name a human would say out loud
// ("调焦轴"). A *version* is one immutable revision of it; a *run* is a
// validation pass whose geometry came from one or more versions. The panel
// picks a subject (a part, or the cross-part scene bucket) and then a record
// inside it; the record's own `type` decides how it is presented.
// ---------------------------------------------------------------------------

export type RunKind = 'assembly' | 'assembly-check' | 'physics' | 'motion' | 'fluid' | 'printability' | 'stress' | 'analyze';
export type RunStatus = 'pass' | 'check' | 'fail';
/**
 * The canonical judgement (src/shared/judgement.ts) as it travels on a run.
 *
 * WHY it lives on the RUN and not only in the tool's reply: the panel has to answer
 * "is this revision OK?" from the runs that named it, and `status` cannot answer it —
 * `pass`/`check`/`fail` is the tool's own two-or-three-value word, not the delivery
 * vocabulary. A run that never judged anything (a risk map, a fluid trend) carries NO
 * judgement, and that absence must read as "not a check", never as "clean"
 * (2026-10-23 audit, FIX-B5).
 */
export type RunJudgement = 'excluded' | 'difficult' | 'not-excluded';

export interface RunProduct {
  type: 'run';
  id: string;
  kind: RunKind;
  /** ISO timestamp of the commit. */
  timestamp: string;
  /**
   * The title the tool committed. Older corpora carry `kind · v014+v025+v022`
   * (version ids only), which a human cannot scan — see `displayTitle`.
   */
  title: string;
  /**
   * A title derived from the run's PARTS (`src/shared/labels.ts`), for every run
   * whose stored title is the unreadable legacy form. Absent when the run has no
   * user-named parts (fluid's synthetic `wall`, a manifest check) — then `title`
   * is the only name it has.
   */
  displayTitle?: string;
  status: RunStatus;
  /** The canonical judgement, present only when this run JUDGED something. */
  judgement?: RunJudgement;
  /** One-line metrics for the record list. */
  summary: string;
  /** Saved versions the geometry came from; empty = an inline-SCAD scene. */
  sourceVersionIds: string[];
  /**
   * Source versions that are NO LONGER the newest version of their part
   * (DESIGN §22): the run still says "pass", but it verified geometry that has
   * since been replaced. Evidence expires with the version it cites.
   */
  staleVersionIds?: string[];
  hasGeometry: boolean;
  /** Geometry names available as parts/<name>.stl. */
  parts: string[];
  /**
   * Where each part sat while the run was computed (assembly runs place parts
   * with translate/rotate). Absent for runs whose pose comes from a trajectory.
   */
  placements?: Record<string, { translate?: number[]; rotate?: number[] }>;
  /**
   * What the run is about, stable across iterations (a manifest path, a part
   * set). Absent for runs with no meaningful subject.
   */
  subject?: string;
  /**
   * Id of the newer run of the same kind about the same subject that replaced
   * this one. The run is still readable — this is a lifecycle pointer, not a
   * deletion — and it is the one field that may be written after commit.
   */
  supersededBy?: string;
  /** Ids of older runs this commit marked superseded. */
  supersedes?: string[];
  /**
   * The Python environment BEYOND the locked venv at commit time: the user
   * overlay's packages plus a digest over them. `packages: []` means "the locked
   * set only" and is written explicitly, so an absent field can only mean "an
   * older run" — never "unknown". A run whose numbers came from a library the
   * user installed says so here (the worker can import it: that was the call).
   */
  pythonOverlay?: { packages: string[]; overrides?: string[]; digest: string };
}

export interface VersionProduct {
  type: 'version';
  id: string;
  timestamp: string;
  status: string;
  title: string;
  /** Previous version of the SAME part; null = this part's first version. */
  parentVersion: string | null;
  partId: string;
  /**
   * Where the revision came from. `generated` = this harness compiled SCAD for
   * it; `imported` = an external file was read in. The panel says which, because
   * "who made this and from what" is the first question a human asks of a part
   * that arrived from someone else.
   */
  source: 'generated' | 'imported' | 'merged';
  /** Imported only: the file name it came from. */
  origin?: string;
  /**
   * Merged only: input versions that their part has since replaced. A merged body is a
   * DERIVED artifact, so it expires when its inputs do — and before this field existed
   * nothing looked (2026-10-23 audit, FIX-C5).
   */
  staleMergedInputs?: string[];
  /** False = stored with allowNonSolid; the geometric tools refuse it. */
  solid: boolean;
}

/** One entry in a part's history: a revision or a validation run on it. */
export type PartRecord = VersionProduct | RunProduct;

export interface PartProduct {
  id: string;
  name: string;
  /** 'agent' = declared by the tool call; 'intent' = derived (migration/fallback). */
  nameSource: 'agent' | 'intent';
  lastActiveAt: string;
  /** Newest first. */
  versions: VersionProduct[];
  /** Runs whose geometry touches this part, newest first. */
  runs: RunProduct[];
}

export interface ProductsResponse {
  parts: PartProduct[];
  /** Runs about 0 parts (inline SCAD) or ≥2 parts — the cross-part bucket. */
  scene: RunProduct[];
  /**
   * The project (session cwd) this tree was read from. Echoed so a panel that
   * has since switched projects can discard the slower reply it left behind.
   */
  project?: string;
}

/**
 * One browsable corpus: the unit of the panel's workspace dropdown.
 *
 * Discovery is read-only and separate from the WRITE scope (the session cwd);
 * the panel may look at any of these without changing where new versions land.
 */
export interface WorkspaceEntry {
  /** Project directory — the one that contains `cad-data/`. */
  cwd: string;
  /** Path relative to the discovery root; `.` for the root itself. */
  rel: string;
  /** Basename of {@link cwd}, for a compact label. */
  name: string;
  /** Parts declared in `parts/manifest.json` (0 when absent). */
  parts: number;
  /** Versions in `manifest.json` (counted from `versions/` when absent). */
  versions: number;
  /** Newest version timestamp (ISO) or null. */
  latest: string | null;
}

/** Reply of `GET /api/cad/projects`. */
export interface WorkspacesResponse {
  /** The absolute root discovery ran against (echoed for the panel's cache key). */
  root: string;
  workspaces: WorkspaceEntry[];
}
