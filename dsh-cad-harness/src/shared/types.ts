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

export interface RunProduct {
  type: 'run';
  id: string;
  kind: RunKind;
  /** ISO timestamp of the commit. */
  timestamp: string;
  /** Human one-liner: what the run was about. */
  title: string;
  status: RunStatus;
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
  source: 'generated' | 'imported';
  /** Imported only: the file name it came from. */
  origin?: string;
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
