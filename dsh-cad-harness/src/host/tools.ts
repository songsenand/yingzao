// M1 tools: generate_part (compile + version + multiview render to the model).

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import { compileAndRender, compileStlOnly, renderScadPng } from './compile.ts';
import { datumNames, listVersions, readVersionDatums, readVersionDatumPoints, readVersionEntry, saveVersion, unionDatumSets, versionExists, writeVersionDatums } from './version.ts';
import {
  attachVersion, createUniquePart, derivePartName, ensurePart, findPartById, findPartByName,
  listParts, type PartEntry,
} from './parts.ts';
import { buildProductsWire } from './products.ts';
import { storeFor } from './store.ts';
import { contentDisposition, downloadName } from '../shared/download-name.ts';
import { revertVersion as revertVersionHelper } from './version.ts';
import { enqueueReviews, readQueue, setReviewStatus } from './review-queue.ts';
import { beginRun, latestRun, listRuns, readRun, runFilePath, safeArtifactName, type RunKind, type RunStatus } from './runs.ts';
import { validateAssembly, type AssemblyPartInput } from './assembly.ts';
import { assemblyFrameDir, renderAssemblyViews } from './assembly-render.ts';
import { rotateVec, type InterfaceCheckResult } from './assembly-check.ts';
// `Json` gives an interface the index signature the output schema's free-form objects
// require (`additionalProperties: true` infers `Record<string, JsonValue>`); without it a
// typed interface is not assignable and the tool fails to register. Authority: inspect.ts.
import type { Json } from './inspect.ts';
import { resolveAssemblyManifestPath } from './manifest.ts';
import { registerUsageObserver, usageReport } from './usage.ts';
import { projectStoresFor, requestStores, ensureProjectDir, type ProjectStores } from './project.ts';
import { discoverWorkspaces } from './workspaces.ts';
import { checkPrintability, checkPrintabilityInTs, measureVersion, renderStlViews, renderVersionFrame, scanAttention, type AttentionFieldSamples, type RenderPartRequest } from './inspect.ts';
import { attachAppearance, appearancePath } from './appearance.ts';
import { resolveWorkspaceFile } from './unregistered.ts';
import {
  builtinDefaultProfile, disclosureLists, evaluableRules, measuredResolutionMm, profileHash, validateProfile, violatesRule,
  type ProcessProfile,
} from './process-profile.ts';
import { connectedBodies, parseBinaryStl, boundingBox as boundingBoxOf, boundingBoxCentre, isWatertight, rebaseMesh, shellCount, writeBinaryStl } from './mesh.ts';
import { suspectParts, formatSuspects, transformedAabb, SUSPECT_RULE, type SceneSolid } from './geometry-sanity.ts';
import { runPhysics, renderKeyframes, type PhysicsPartInput, type PhysicsReport } from './physics.ts';
import { assertAssembledAtStart, rebasedBodyPosition, runMotion, type MotionJointInput, type MotionPartInput } from './motion.ts';
import { runFluid, deriveFluidPreset } from './fluid.ts';
import { auditDelivery } from './delivery-audit.ts';
import { selectAttachedViews } from './render-attachments.ts';
import { asJudgement } from '../shared/judgement.ts';
import { runSubject } from '../shared/labels.ts';
import { preflightSummary, type PreflightStep } from './preflight.ts';
import { withDeadline } from './deadline.ts';
import { argError } from './arg-error.ts';
import { withOutputContract } from './tool-contract.ts';
import { nextLookFor } from './next-look.ts';
import { analyzeVersion, type BandNorm, type SuspectLike } from './analyze.ts';
import { renderFluidSnapshot, gridBounds } from './fluid-render.ts';
import { randomUUID } from 'node:crypto';
import { registerPythonTools } from './python-tools.ts';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import { geometrySuspectLayer, jsonSafe, readStressField, resolveStressMaterial, solveStress, stressAttention, stressDelivery, type GeometrySuspect } from './stress.ts';
import { buildMeshBvh } from './measure.ts';
import { Ray, Vector3, DoubleSide } from 'three';
import {
  deriveNameFromFile, importGeometry, normalizeDatums, type DatumInput, type Unit,
} from './import.ts';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';

interface GeneratePartArgs {
  scadCode: string;
  userIntent: string;
  parentVersion?: string;
  part?: string;
  /** Subset of ["top","front","side","iso"] to attach; default all four. */
  views?: string[];
}

interface PhysicsToolArgs {
  parts: { name: string; scadCode: string; bodyType: string; position: number[]; rotation?: number[]; density?: number; initialAngularVelocity?: number[] }[];
  joints?: { type?: string; bodyA: string; bodyB: string; anchorA: number[]; anchorB: number[]; axis: number[]; limits?: number[]; staticFriction?: number }[];
  durationSec?: number;
  gravity?: number[];
  /** Tilt gravity by this many degrees about tiltAboutAxis (default [0,1,0]) — the slope scenario without hand-computing a gravity vector. Ignored when gravity is given explicitly. */
  tiltDeg?: number;
  tiltAboutAxis?: number[];
}

interface GeneratePartResult {
  versionId: string;
  success: boolean;
  /** Part this version was filed under (the panel's browse axis). */
  part: string;
  errors: string[];
  warnings: string[];
  durationMs: number;
  views: string[];
  /** Bounding-box size in mm — the renders carry no scale reference. */
  sizeMm?: number[];
  bboxMin?: number[];
  bboxMax?: number[];
  /** Mesh truth at generation time — false means every later check is on sand. */
  watertight?: boolean;
  triangles?: number;
  shells?: number;
}

/** Render refs stashed by execute() for finalizeContent to emit as image blocks. */
const pendingRenderRefs = new Map<string, { view: string; ref: unknown }[]>();

let physicsResultForFinalize: { refs: { view: string; ref: unknown }[]; overall: string } | null = null;
let finalizeOnce: { versionId: string; label: string; file: string; refs: { view: string; ref: unknown }[] } | null = null;
let motionRefsForFinalize: { refs: { view: string; ref: unknown }[] } | null = null;
let fluidRefsForFinalize: { refs: { view: string; ref: unknown }[] } | null = null;
let assemblyRefsForFinalize: { refs: { view: string; ref: unknown }[]; views: number; runId: string; thresholdMm: number } | null = null;

/**
 * Collect every model-facing tool name this plugin registers.
 *
 * The preset tool scope (`tool-scope.ts`) needs the complete list to hide, and
 * collecting it at the registration site means a newly added CAD tool cannot
 * silently leak into a coding session's catalog. `cadToolNames()` exposes the
 * same list to the acceptance script.
 */
const registeredCadTools: string[] = [];

/** Names of every CAD tool registered so far, in registration order. */
/** Payloads of the worker's closest-point ops (`python/cad_worker/worker.py`). */
interface MeshMeshSolve {
  distanceMm: number;
  pointA: [number, number, number];
  pointB: [number, number, number];
  method: string;
  watertightA: boolean;
  watertightB: boolean;
}
interface MeshSphereSolve {
  distanceMm: number;
  meshPoint: [number, number, number];
  spherePoint: [number, number, number];
  method: string;
  intersected: boolean;
  watertight: boolean;
}
/** Payload of the worker's `connectivity` op. */
interface ConnectivitySolve {
  count: number;
  bodies: { min: number[]; max: number[] }[];
  /**
   * Sealed cavities: shells whose signed volume is NEGATIVE. A cavity's outward
   * normal (outward from the material) points into the void, so the divergence
   * theorem returns a negative volume for it and a positive one for a separate
   * body. That sign is the only thing that tells "trapped powder" from "two
   * floating fragments".
   */
  voids?: { volumeMm3: number; center: number[]; min: number[]; max: number[] }[];
  watertight: boolean;
  triangles: number;
}
/** Payload of the worker's `merge_solids` op. */
interface MergeSolve {
  triangles: number;
  volumeMm3: number;
  sizeMm: number[];
  shells: number;
  outBytes: number;
}
/** Payload of the worker's `measure_distance` op. */
interface MeasureDistanceSolve {
  distanceMm: number;
  dxMm: number;
  dyMm: number;
  dzMm: number;
  aSnapped: [number, number, number];
  bSnapped: [number, number, number];
  aSnapDistanceMm: number;
  bSnapDistanceMm: number;
  aOutside: boolean;
  bOutside: boolean;
  watertightA: boolean;
  watertightB: boolean;
}

/** Payload of the worker's `measure_thickness` op. */
interface MeasureThicknessSolve {
  direction: [number, number, number];
  from: [number, number, number];
  fromInsideSolid: boolean;
  spans: {
    part: string;
    enterMm: number;
    exitMm: number;
    thicknessMm: number;
    atMm: number;
    entryPoint: [number, number, number];
    exitPoint: [number, number, number];
    entryNormal?: [number, number, number];
    exitNormal: [number, number, number];
    clipped?: boolean;
  }[];
  gaps: { afterMm: number; beforeMm: number; gapMm: number; between: string }[];
  thinnestSpanMm: number;
  clipped: boolean;
  nudgedMm: number;
  probeAgreement: number;
  watertightA: boolean;
  watertightB: boolean | null;
  warnings: string[];
}

/** Payload of the worker's `list_features` op. */
interface ListFeaturesSolve {
  watertight: boolean;
  triangles: number;
  thresholds: { smoothDeg: number; minFaceAreaMm2: number; maxFaces: number; maxCylinders: number };
  faces: {
    id: string;
    normalMm: [number, number, number];
    originMm: [number, number, number];
    centroidMm: [number, number, number];
    areaMm2: number;
    smoothRegion: { facets: number; areaMm2: number; planar: boolean };
    holes: {
      id: string;
      centerMm: [number, number, number];
      axisMm: [number, number, number];
      kind: string;
      areaMm2: number;
      vertices: number;
      circularityResidualMm: number;
      areaRatioToCircle: number;
      diameterMm?: number;
      through?: boolean;
      depthMm?: number;
    }[];
  }[];
  facesOmitted: number;
  curvedSegmentFacets: number;
  cylinders: {
    id: string;
    kind: string;
    axisMm: [number, number, number];
    centerMm: [number, number, number];
    diameterMm: number;
    lengthMm: number;
    facets: number;
    areaMm2: number;
    largeFacets: number;
    fitResidualMm: number;
  }[];
  curvedSurfaces: { id: string; areaMm2: number; facets: number; largeFacets: number; reason: string }[];
  faceCount: number;
  holeCount: number;
  cylinderCount: number;
  warnings: string[];
}

/** Payload of the worker's `measure_section` op. */
interface MeasureSectionSolve {
  axisMm: [number, number, number];
  atMm: number;
  originMm: [number, number, number];
  uAxisMm: [number, number, number];
  vAxisMm: [number, number, number];
  planeRangeMm: [number, number];
  thresholds: {
    simplifyToleranceMm: number;
    maxPolygons: number;
    maxHolesPerPolygon: number;
    maxRingPoints: number;
  };
  empty: boolean;
  polygons: {
    id: string;
    areaMm2: number;
    perimeterMm: number;
    holeCount: number;
    outer: {
      pointsUv: [number, number][];
      pointsWorldMm: [number, number, number][];
      segmentsMm: number[];
      anglesDeg: number[];
      closed: boolean;
      pointsSubsampled: boolean;
    };
    holes: {
      id: string;
      centerUv: [number, number];
      centerWorldMm: [number, number, number];
      areaMm2: number;
      kind: string;
      circularityResidualMm: number;
      areaRatioToCircle: number;
      vertices: number;
      wallToOuterMm: number;
      diameterMm?: number;
      enclosingDiameterMm?: number;
      pointsUv?: [number, number][];
    }[];
  }[];
  polygonsOmitted: number;
  voidRegions: number;
  holeSpacing: { from: string; to: string; centerDistanceMm: number; clearanceMm: number }[];
  areaMm2: number;
  perimeterMm: number;
  bboxUvMm: [number, number][];
  holeCount: number;
  warnings: string[];
}

/** Payload of the worker's `measure_extent` op. */
interface MeasureExtentSolve {
  axisMm: [number, number, number];
  source: string;
  vertexCount: number;
  minMm: number;
  maxMm: number;
  sizeMm: number;
  centerMm: number;
  minPointMm: [number, number, number];
  maxPointMm: [number, number, number];
  asAxisAlignedMm: { min: number[]; max: number[] };
  warnings: string[];
}

/** Payload of the worker's `measure_angle` op. */
interface MeasureAngleSolve {
  aDirMm: [number, number, number];
  bDirMm: [number, number, number];
  aOriginMm: [number, number, number];
  bOriginMm: [number, number, number];
  aSource: string;
  bSource: string;
  anchoredAtOrigin: boolean;
  angleDeg: number;
  acuteDeg: number;
  supplementDeg: number;
  parallel: boolean;
  perpendicular: boolean;
  coplanar: boolean;
  lineDistanceMm: number;
  commonNormalMm: [number, number, number];
  crossingPointMm?: [number, number, number];
  convention: string;
  warnings: string[];
}

export function cadToolNames(): readonly string[] {
  return registeredCadTools;
}

/**
 * Where the shipped example profiles live, from BOTH build layouts: `src/host/` when a
 * script imports the source, `lib/` when the bundled plugin runs.
 */
const PROFILE_DIR_CANDIDATES = [
  new URL('../../schemas/examples/', import.meta.url),
  new URL('../schemas/examples/', import.meta.url),
];

/**
 * Resolve the profiles a call declared. NO SILENT DEFAULT: with nothing declared the
 * answer is the built-in fallback, and the caller is TOLD so (its id and hash go into
 * the report). An invalid profile is refused with the offending rule named — never
 * repaired, never partially applied.
 */
async function resolveProcessProfiles(
  a: { profileIds?: string[]; profilesJson?: string },
): Promise<{ profiles: ProcessProfile[]; source: 'declared' | 'builtin-default'; errors: string[] }> {
  const errors: string[] = [];
  const profiles: ProcessProfile[] = [];
  if (a.profilesJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(a.profilesJson);
    } catch (e) {
      errors.push(`profilesJson is not valid JSON: ${(e as Error).message}`);
      parsed = undefined;
    }
    if (parsed !== undefined) {
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const v = validateProfile(item);
        if (v.ok) profiles.push(v.profile);
        else errors.push(...v.errors);
      }
    }
  }
  for (const id of a.profileIds ?? []) {
    const dir = PROFILE_DIR_CANDIDATES.find((u) => existsSync(u));
    const file = dir ? new URL(`${id}.json`, dir) : null;
    if (!file || !existsSync(file)) {
      errors.push(`no shipped profile "${id}" — looked for ${id}.json in schemas/examples/`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      errors.push(`${id}.json is not readable JSON: ${(e as Error).message}`);
      continue;
    }
    const v = validateProfile(raw);
    if (v.ok) profiles.push(v.profile);
    else errors.push(...v.errors.map((m) => `${id}: ${m}`));
  }
  if (profiles.length === 0 && errors.length === 0) {
    return { profiles: [builtinDefaultProfile()], source: 'builtin-default', errors };
  }
  return { profiles, source: 'declared', errors };
}

/**
 * Per-version caches for the two expensive worker ops that profile-driven printability
 * calls need. A saved version's model.stl NEVER changes — that is the corpus's core
 * invariant (a corrected part is a NEW version) — so these results stay valid for the
 * process lifetime. Without the cache, every call re-runs `list_features` (face
 * clustering plus a depth ray per hole) and `connectivity`, which dominates the call.
 */
const featureCache = new Map<string, unknown>();
const connectivityCache = new Map<string, ConnectivitySolve>();

/** Cache key: the store root matters too — two projects can both have a "v001". */
function versionCacheKey(storeRoot: string, versionId: string): string {
  return `${storeRoot}::${versionId}`;
}

export function registerCadTools(
  ctx: Context,
  scope?: { toolScope?: string; presets?: readonly string[] },
): readonly string[] {
  const registered: string[] = [];
  /**
   * Register one tool, and self-check its OUTPUT against the schema it declares.
   *
   * WHY: the harness validates a tool's value at the runtime boundary
   * (`ToolRuntime.createSuccessResult`), but every `scripts/accept-*.mjs` calls
   * `def.execute()` directly — below that boundary. Four tools shipped with a schema that
   * disagreed with their own body while every acceptance stayed green (2026-10-23 audit,
   * FIX-A1). The guard lives in `tool-contract.ts` so it can be tested on its own.
   */
  const registerTool = (definition: { name: string; execute?: unknown; output?: { schema?: unknown } }) => {
    registered.push(definition.name);
    registeredCadTools.push(definition.name);
    return ctx.tools.register(withOutputContract(definition) as never);
  };

  // Stores are resolved PER CALL, never captured here: the plugin is applied
  // once for the whole profile, while every tool call and every browser request
  // belongs to one project (its session's cwd — see project.ts). Capturing them
  // at apply time is what made a new project list the previous project's parts.
  const allStores = (exec: unknown): Promise<ProjectStores> => projectStoresFor(exec);

  /**
   * The message for "I cannot find this version" — including what a version IS.
   * Observed: `measure_part(v999)` said only "version v999 has no model.stl"; the
   * caller had a part id, not a version id, and nothing said so. A rejected input
   * is where a caller learns the vocabulary, so the ids that DO exist ride along.
   */
  async function versionNotFound(store: ProjectStores['store'], id: string, where = ''): Promise<string> {
    const ids = (await listVersions(store)).map((v) => v.id);
    return `unknown version "${id}"${where} — this project has ${ids.length} version(s): ` +
      `${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}. ` +
      'A version id looks like "v001"; a part id ("p001") or a run id ("r044") is not one.';
  }

  /**
   * Which part a new version belongs to.
   *
   * A declared `part` wins; otherwise the parent's part is inherited; otherwise
   * a new part starts, named by `fallbackName` (the intent for a generated part,
   * the file name for an imported one). A parent that belongs to another part is
   * REFUSED rather than silently filed together — the shipped corpus had
   * exactly that bug (a shaft whose parent was a base plate).
   *
   * Shared by generate_part and import_part on purpose: "which part does this
   * geometry belong to, and may it descend from that version" must have one
   * answer regardless of where the geometry came from.
   */
  async function resolvePartForWrite(
    a: { part?: string; parentVersion?: string; fallbackName: string },
    project: ProjectStores,
  ): Promise<PartEntry> {
    const { store, partStore } = project;
    const parent = a.parentVersion ? await readVersionEntry(store, a.parentVersion) : null;
    if (a.parentVersion && !parent) throw new Error(`parentVersion ${a.parentVersion} does not exist`);

    if (a.part?.trim()) {
      const target = await ensurePart(partStore, a.part, 'agent');
      if (parent && parent.partId && parent.partId !== target.id) {
        const owner = await findPartById(partStore, parent.partId);
        throw new Error(
          `parentVersion ${a.parentVersion} belongs to part "${owner?.name ?? parent.partId}", ` +
          `but part "${target.name}" was declared. Pass part:"${owner?.name ?? ''}" to iterate that part, ` +
          `or omit parentVersion to start a new part.`);
      }
      // A version predating part identity: adopt it into the declared part.
      if (parent && !parent.partId) await attachVersion(partStore, target.id, parent.id);
      return target;
    }

    if (parent?.partId) {
      const owner = await findPartById(partStore, parent.partId);
      if (owner) return owner;
    }
    return createUniquePart(partStore, a.fallbackName, 'intent');
  }

  /** generate_part's view of the shared rule: the intent names a new part. */
  const resolvePartForGeneration = (a: GeneratePartArgs, project: ProjectStores): Promise<PartEntry> =>
    resolvePartForWrite(
      { part: a.part, parentVersion: a.parentVersion, fallbackName: derivePartName(a.userIntent) },
      project,
    );

  /**
   * Resolve one part's geometry for a run. A part either names a saved version
   * (`versionId` — the geometry is that version's STL, and the run records the
   * provenance) or carries inline `scadCode` (a scene part, no provenance).
   */
  async function resolvePartGeometry(p: { name: string; scadCode?: string; versionId?: string }, project: ProjectStores): Promise<{
    stl: Uint8Array;
    versionId: string | null;
  }> {
    const { store } = project;
    if (p.versionId) {
      try {
        return {
          stl: new Uint8Array(await readFile(join(store.root, 'versions', p.versionId, 'model.stl'))),
          versionId: p.versionId,
        };
      } catch {
        throw new Error(`part "${p.name}": version ${p.versionId} has no model.stl`);
      }
    }
    if (!p.scadCode) throw new Error(`part "${p.name}" needs scadCode or versionId`);
    const c = await compileStlOnly(p.scadCode);
    if (!c.success || !c.stl) throw new Error(`part "${p.name}" failed to compile: ${c.errors.join('; ') || 'unknown'}`);
    return { stl: c.stl, versionId: null };
  }

  /** `v019` / `v019+v020` / `内联 SCAD` — one label for the run title. */
  const provenanceLabel = (ids: string[]): string =>
    ids.length === 0 ? '内联 SCAD' : ids.join('+');

  /**
   * A manifest's identity for run-lifecycle purposes: its path relative to the
   * root it was found in, so the same manifest keeps the same subject whether it
   * is read from the workspace or (legacy) from the data root.
   */
  const relativeSubject = (project: ProjectStores, path: string): string => {
    const rel = relative(project.cwd, path);
    if (rel && !rel.startsWith('..')) return rel;
    const fromData = relative(project.root, path);
    return fromData && !fromData.startsWith('..') ? fromData : path;
  };

  /**
   * Part names reach the filesystem (`runs/<id>/parts/<name>.stl`) and the model
   * faces them back by name, so they are checked here, ONCE, before anything is
   * created — `run.part()` used to be the only guard, and by then `beginRun` had
   * already made the directory (the orphan `runs/r004/` in the microscope2
   * corpus). Names may be any language; see `safeArtifactName`.
   */
  const assertPartNames = (parts: { name?: string }[], tool: string): void => {
    for (const p of parts ?? []) {
      const name = typeof p?.name === 'string' ? p.name : '';
      if (safeArtifactName(name) === null) {
        throw new Error(
          `${tool}: part name ${JSON.stringify(name)} cannot be a file name. ` +
          'Any language is fine; it must be non-empty, must not start with ".", and must not ' +
          'contain a path separator, a control character, or one of : * ? " < > |',
        );
      }
    }
    const seen = new Set<string>();
    for (const p of parts ?? []) {
      const name = (p as { name: string }).name;
      if (seen.has(name)) throw new Error(`${tool}: duplicate part name ${JSON.stringify(name)}`);
      seen.add(name);
    }
  };

  /** Part names are constrained to a job's own compiled files (no traversal). */
  const safePart = (raw: string | null): string | null => (raw ? safeArtifactName(raw) : null);

  /** Collect the distinct saved versions a set of parts came from. */
  const collectVersions = (used: (string | null)[]): string[] => [
    ...new Set(used.filter((v): v is string => !!v)),
  ];

  // Shared by the simulate_motion tool (LLM-initiated) and the manual
  // POST /api/cad/motion/run route — identical report shape either way.
  async function runMotionJob(a: {
    parts: { name: string; scadCode?: string; versionId?: string; bodyType: string; position: number[]; rotation?: number[]; pivot?: number[] }[];
    joints?: { type: string; bodyA: string; bodyB: string; anchorA: number[]; anchorB: number[]; axis: number[]; limits?: [number, number] }[];
    drive?: { body: string; axis: number[]; omegaRadPerSec: number };
    oscillators?: { body: string; axis: number[]; amplitudeMm?: number; periodSec?: number; phaseRad?: number; pitchRadiusMm?: number }[];
    cycles?: number;
  }, project: ProjectStores) {
    const { runStore } = project;
    // `cycles` is the only sampling-adjacent knob the caller controls, and 0 used
    // to be coerced to 2 turns by the worker's `or 2` while the TS oracle kept 0.
    // Refuse it here: "no motion" is not a motion simulation, and a silent 2-turn
    // answer is the opposite of what the caller asked.
    if (a.cycles !== undefined && (!Number.isFinite(a.cycles) || a.cycles <= 0)) {
      throw argError(
        'simulate_motion', 'cycles', 'must be a positive finite number',
        'a number > 0; fractions are allowed (0.03 ≈ 10.8°) — 0 means "no motion", which is not a simulation',
        { received: a.cycles, example: 'cycles: 0.03' },
      );
    }
    const parts: MotionPartInput[] = [];
    const sceneSolids: SceneSolid[] = [];
    const stlFiles: { name: string; stlPath: string }[] = [];
    const usedVersions: (string | null)[] = [];
    const geometries: { name: string; stl: Uint8Array }[] = [];
    assertPartNames(a.parts, 'simulate_motion');

    // ---- pivot rebasing ----------------------------------------------------
    // A rapier body rotates about its OWN origin. Every part in this corpus is
    // modelled in world coordinates and placed with position [0,0,0], so a
    // driven gear modelled at z=265 did not spin on its shaft — it swung on a
    // 265mm arm (the microscope2 motion runs did exactly that and still reported
    // "0 interference" and "0.03mm joint drift", because the swing swept empty
    // space and the drift was sampled only at the final, whole-turn pose).
    //
    // So each part is re-based on a pivot BEFORE it reaches the engine: the
    // geometry is shifted by −pivot, the body is placed at position+pivot, and
    // every joint anchor that names the part is shifted the same way. The world
    // pose of every point is then unchanged:
    //
    //     R(local − p) + (pos + R·p) = R·local + pos
    //
    // THE BODY OFFSET IS R·p, NOT p, and getting that wrong is silent. The −p
    // shift happens in the part's file frame, but the body is then rotated by R,
    // so the compensation rotates with it. `pos + p` is right only when
    // R·p = p — identity rotation, or a pivot lying on the rotation axis.
    // The toy-balance beam (R = 90° about x, p = [0,84,5]) broke it by
    // |p − R·p| = 119.0mm: the beam sat 119mm from its own pin, its kinematic
    // body could not be pulled back, and the solver dragged the two pans across
    // the machine to the wrong anchors — while the report said "0 joint drift,
    // 0 interference, travel 160.2mm, pass". Nothing in that run was evidence.
    //
    // The stored STL is the re-based one and the trajectory is the engine's own,
    // so the panel's playback and the keyframe renders stay consistent.
    const jointsIn = a.joints ?? [];
    const pivotOf = new Map<string, [number, number, number]>();
    const pivots: Record<string, [number, number, number]> = {};
    for (const p of a.parts) {
      const g = await resolvePartGeometry(p, project);
      const mesh = parseBinaryStl(g.stl);
      const explicit = Array.isArray(p.pivot) && p.pivot.length === 3 ? p.pivot as [number, number, number] : null;
      // Default: the anchor of the first joint that names this part — that IS
      // the axis the part is meant to turn or slide about — else the geometry's
      // own centre, which is what "spin it in place" means for a free body.
      const joint = jointsIn.find((j) => j.bodyA === p.name || j.bodyB === p.name);
      const anchor = joint ? (joint.bodyA === p.name ? joint.anchorA : joint.anchorB) : null;
      const pivot: [number, number, number] = explicit
        ?? (anchor && anchor.length === 3 ? anchor as [number, number, number] : boundingBoxCentre(mesh));
      pivotOf.set(p.name, pivot);
      pivots[p.name] = pivot.map((v) => +v.toFixed(4)) as [number, number, number];

      // The world pose this run STARTS from: the sanity pass below asks "is this
      // part at the machine?" about the scene a human would see at t=0.
      sceneSolids.push({
        name: p.name,
        triangles: Math.round(mesh.triVerts.length / 3),
        ...transformedAabb(
          boundingBoxOf(mesh),
          p.position as [number, number, number],
          p.rotation as [number, number, number] | undefined,
        ),
      });
      const rebased = rebaseMesh(mesh, pivot);
      const stl = writeBinaryStl(rebased, `motion part ${p.name} rebased on its pivot`);
      usedVersions.push(g.versionId);
      geometries.push({ name: p.name, stl });
      parts.push({
        name: p.name,
        stl,
        bodyType: p.bodyType as 'dynamic' | 'fixed' | 'kinematic',
        position: rebasedBodyPosition(p.position, pivot, p.rotation as [number, number, number] | undefined),
        rotation: p.rotation as [number, number, number] | undefined,
      });
    }
    const rebasedJoints = jointsIn.map((j) => {
      const pa = pivotOf.get(j.bodyA) ?? [0, 0, 0];
      const pb = pivotOf.get(j.bodyB) ?? [0, 0, 0];
      return {
        ...j,
        anchorA: [j.anchorA[0]! - pa[0], j.anchorA[1]! - pa[1], j.anchorA[2]! - pa[2]],
        anchorB: [j.anchorB[0]! - pb[0], j.anchorB[1]! - pb[1], j.anchorB[2]! - pb[2]],
      };
    });

    // ---- initial-assembly gate --------------------------------------------
    // Measured BEFORE anything moves (see assertAssembledAtStart for why a gap
    // detected after the warm-up is worthless): a scenario that is not assembled
    // is refused with the joint named, instead of producing a run that looks
    // healthy while describing a pose nobody designed.
    const initialGaps = assertAssembledAtStart(parts, rebasedJoints as unknown as MotionJointInput[]);

    const sourceVersionIds = collectVersions(usedVersions);

    // ---- geometry sanity (a FACT, not a verdict) --------------------------
    // Is every part actually AT the machine? r013 parked two 12-triangle cubes at
    // (500,500), reported "interference 0", and nothing said so. The criterion is
    // a RATIO (gap to the nearest part ÷ the part's own diagonal > 5), declared
    // below and reported with every line — a fixed distance would flag a big
    // machine's normal spacing and miss a tiny part lost in space.
    for (const solid of sceneSolids) {
      solid.connected = jointsIn.some((j) => j.bodyA === solid.name || j.bodyB === solid.name)
        || (a.oscillators ?? []).some((o) => o.body === solid.name)
        || a.drive?.body === solid.name;
    }
    const suspectList = suspectParts(sceneSolids);
    const suspectLines = formatSuspects(suspectList);
    // Only placement suspects (离群 / degenerate) are warnings; a simple box is a
    // note, and turning every plate into a warning would make the warning useless.
    const warnCount = suspectList.filter((x) => x.warn).length;
    const suspectWarn = warnCount > 0;

    // The run owns its geometry: parts are written where the panel can fetch
    // them per run (and where the keyframe renderer can import them).
    const run = await beginRun(runStore, {
      kind: 'motion',
      title: runSubject('motion', geometries.map((g) => g.name), sourceVersionIds)
        ?? `机构运动 · ${provenanceLabel(sourceVersionIds)}`,
    });
    for (const g of geometries) {
      await run.part(g.name, g.stl);
      stlFiles.push({ name: g.name, stlPath: join(run.dir, 'parts', `${g.name}.stl`) });
    }
    const report = await runMotion({
      parts,
      joints: rebasedJoints as never,
      drive: a.drive
        ? { ...a.drive, axis: a.drive.axis as [number, number, number] }
        : undefined,
      oscillators: (a.oscillators ?? []).map((o) => ({ ...o, axis: o.axis as [number, number, number] })),
      cycles: a.cycles,
      recordParts: a.parts.map((p) => p.name).filter((n) => n !== a.drive?.body),
    });
    // Same facts in the stored report: a fact that only exists in the chat reply
    // is lost the moment another session opens the run.
    report.metrics.geometrySuspects = suspectLines;
    report.metrics.geometrySuspectRule = SUSPECT_RULE;
    report.metrics.geometrySuspectWarn = warnCount;
    await run.json('report.json', report);
    await run.json('trajectory.json', { kind: 'motion', durationSec: report.durationSec, trajectory: report.trajectory });
    const { frames, warnings: renderWarnings } = await renderKeyframes(report as unknown as PhysicsReport, stlFiles, join(run.dir, 'frames'));
    // A render that emits WARNING/ERROR is not a render you may trust (see
    // renderKeyframes' header): surface it instead of attaching silent pictures.
    if (renderWarnings.length > 0) {
      report.metrics.jointViolations.push(...renderWarnings.slice(0, 3).map((w) => `render: ${w}`));
    }
    const keep = frames.slice(0, 4);
    const refs: { view: string; ref: unknown }[] = [];
    try {
      for (const f of keep) {
        const [ref] = await ctx.attachments.saveImages([{ data: f.png, mediaType: 'image/png', name: `motion-${f.view}` }]);
        if (ref) refs.push({ view: f.view, ref });
      }
    } catch (e) {
      report.metrics.jointViolations.push(`attachment save failed: ${String((e as Error).message)}`);
    }
    motionRefsForFinalize = { refs };
    const followerList = Object.values(report.metrics.followers ?? {});
    // DESIGN §21: 干涉不是"黄牌提醒"，是交付阻塞。机构里两个零件在运动中
    // 相互重叠 = 几何上不可制造（要么留间隙要么有过盈声明），直接 fail（红）。
    const interferenceBlocking = report.metrics.interferenceCount > 0;
    const samplingSatisfied = report.metrics.samplingSatisfied === true;
    // A geometry suspect is a WARNING, the way a compiler warns: the build
    // (run) succeeded, but the numbers describe something you probably did not
    // mean — a part parked 500mm away makes "0 interference" unearned. It is not
    // a failure either: a long link really can be far from its neighbours.
    const motionStatus: 'pass' | 'check' | 'fail' =
      interferenceBlocking ? 'fail'
        : !samplingSatisfied || suspectWarn ? 'check'
          : report.overallStatus === 'pass' ? 'pass' : 'check';
    await run.commit({
      title: runSubject('motion', geometries.map((g) => g.name), sourceVersionIds)
        ?? `机构运动 · ${provenanceLabel(sourceVersionIds)}`,
      sourceVersionIds,
      status: motionStatus,
      // Interference is a witness (the solid overlaps in a real pose) -> excluded.
      // Anchor drift / constraint violations mean the numbers are not trustworthy
      // -> difficult, never a clean bill. Insufficient sampling is the same kind
      // of statement: there was no pose to test, so "0 interference" is unearned.
      judgement: interferenceBlocking ? 'excluded'
        : (!samplingSatisfied || suspectWarn || report.metrics.jointViolations.length > 0 || report.metrics.maxJointDriftMm > 2) ? 'difficult'
          : 'not-excluded',
      summary: (interferenceBlocking ? '❌ 不可交付 · ' : '') +
        (initialGaps.length ? `初始最大失配 ${Math.max(...initialGaps.map((g) => g.gapMm)).toFixed(2)}mm · ` : '') +
        `采样 ${report.metrics.interferenceChecks}/${24}${samplingSatisfied ? '' : '（不足，干涉未检查）'}` +
        ` · 干涉 ${report.metrics.interferenceCount} 次` +
        (followerList.length ? ` · 行程 ${followerList[0]!.travelMm.toFixed(1)}mm` : '') +
        (suspectWarn ? ` · ⚠ 几何疑点 ${warnCount}` : ''),
    });
    const blocking = interferenceBlocking
      ? report.metrics.interferenceEvents.slice(0, 6).map((e) =>
          `${e.partA}↔${e.partB} ${e.volumeMm3.toFixed(1)}mm³ @ t=${e.timeSec}s`)
      : [];
    return {
      overallStatus: motionStatus,
      blocking,
      ...(interferenceBlocking ? {
        deliverability: '❌ NOT DELIVERABLE — 零件在运动中相互重叠。要么修改几何留出间隙，' +
          '要么在装配契约中把该接口声明为有意过盈/预压（intent 严重级）。修复或声明之前，此机构不可交付。',
      } : {}),
      followers: report.metrics.followers,
      // Empty is the normal case; when it is not, the rule travels with it so the
      // reader can see the criterion, not just the verdict.
      geometrySuspects: suspectLines,
      geometrySuspectRule: SUSPECT_RULE,
      // "This run has no crank" is a fact about the run, not a missing field: the
      // schema cannot carry a null number (see maxSampleGapDeg below), so it is a
      // boolean. Without it, a prescribed-mover run is indistinguishable from one
      // whose crank was silently dropped.
      hasCrank: report.metrics.driveOmegaRadPerSec !== null,
      interferenceCount: report.metrics.interferenceCount,
      interferenceEvents: report.metrics.interferenceEvents,
      interferenceChecks: report.metrics.interferenceChecks,
      candidatePairs: report.metrics.candidatePairs,
      interferencePairChecks: report.metrics.interferencePairChecks,
      samplingSatisfied: report.metrics.samplingSatisfied,
      // The declared output schema is a number (not nullable); omit it when the
      // scenario has no drive, instead of encoding "no crank" as a magic value.
      ...(report.metrics.maxSampleGapDeg === null ? {} : { maxSampleGapDeg: report.metrics.maxSampleGapDeg }),
      maxJointDriftMm: report.metrics.maxJointDriftMm,
      // Measured BEFORE stepping (assertAssembledAtStart). It used to be computed and
      // thrown away, so a scenario 1.9mm from assembled passed under a 2mm tolerance with
      // no trace of how close it was (2026-10-23 audit, FIX-B2).
      initialJointGaps: initialGaps,
      jointToleranceMm: 2,
      jointViolations: report.metrics.jointViolations,
      keyframes: keep.map((f) => f.view),
      stepsRun: report.stepsRun,
      durationSec: report.durationSec,
      pivots,
    };
  }

  registerTool(defineTool({
    name: 'generate_part',
    description:
      'Compile OpenSCAD into a new part version; renders top/front/side/iso (all four attached by default; trim with `views` to save image budget on numeric iterations). Write complete self-contained code with $fn=64 (BOSL2 is available: std/screws/gears/walls). Declare anchors with `datum("name",[x,y,z])` at top level in final world coordinates; they do not affect the mesh. ' +
      'The FIRST version of a part also gets a sampled wall screen (minWallMm + warning) — when several parts share a new feature (a slot, a snap, a thread), generate ONE representative, fix its screen, then generate the family; regenerating N parts after a shared defect costs N rounds.',
    parameters: {
      scadCode: {
        type: 'string',
        required: true,
        description: 'Complete OpenSCAD source code for the part. Must be self-contained; no external libraries.',
      },
      userIntent: {
        type: 'string',
        required: true,
        description: 'One-line summary of what the part should look like, used in the version history.',
      },
      parentVersion: {
        type: 'string',
        description: 'Version id this iteration derives from, e.g. "v003". Must belong to the same part.',
      },
      part: {
        type: 'string',
        description:
          'Which part this version belongs to — the name the user would call it, e.g. "调焦轴". ' +
          'ALWAYS pass this when iterating: it is what groups versions into one part in the panel. ' +
          'Omit only for a brand-new part with no parentVersion (a name is then derived from userIntent), ' +
          'or to inherit the parentVersion\'s part.',
      },
      views: {
        type: 'array',
        description:
          'Which render views to ATTACH (each attached image spends context image budget): subset of ["top","front","side","iso"]. ' +
          'Default: all four — right for a new shape or a shape change you need to SEE. ' +
          'For an iteration that only changes a number you will verify by measurement (a hole Ø, a length), pass ["iso"]. ' +
          'Pass [] to register the version with NO images attached — the panel still shows the geometry, so the human is not blinded.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          success: { type: 'boolean', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          durationMs: { type: 'integer', required: true },
          views: { type: 'array', required: true, items: { type: 'string' } },
          sizeMm: { type: 'array', items: { type: 'number' }, description: 'Bounding-box size [x,y,z] mm.' },
          bboxMin: { type: 'array', items: { type: 'number' } },
          bboxMax: { type: 'array', items: { type: 'number' } },
          watertight: { type: 'boolean', description: 'False = open surface: fix before any downstream check.' },
          triangles: { type: 'integer' },
          shells: { type: 'integer' },
          minWallMm: { type: 'number', description: 'First version only: thinnest sampled wall (in-process TS screen, 600 samples). Below 1.2mm the reply says to fix the representative before generating its family.' },
          minWallAtMm: { type: 'array', items: { type: 'number' }, description: 'Where that thinnest wall was found (first version only).' },
          part: { type: 'string', required: true, description: 'The part this version belongs to.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    timeoutMs: 120_000,
    async execute(args: unknown, exec: unknown): Promise<GeneratePartResult> {
      const a = args as GeneratePartArgs;
      const project = await allStores(exec);
      const { store, partStore } = project;
      const part = await resolvePartForGeneration(a, project);
      const result = await compileAndRender(a.scadCode);
      if (!result.success) {
        // A failed round still lands on the part: the error is part of its history.
        const versionId = await saveVersion(store, {
          scadCode: a.scadCode,
          userIntent: a.userIntent,
          parentVersion: a.parentVersion ?? null,
          partId: part.id,
          datums: result.datums,
          datumSet: result.datumSet,
        });
        await attachVersion(partStore, part.id, versionId);
        return {
          versionId, success: false, part: part.name,
          errors: result.errors, warnings: result.warnings,
          durationMs: result.durationMs, views: [],
        };
      }
      const versionId = await saveVersion(store, {
        scadCode: a.scadCode,
        stl: result.stl,
        renders: result.renders,
        userIntent: a.userIntent,
        parentVersion: a.parentVersion ?? null,
        partId: part.id,
        datums: result.datums,
        datumSet: result.datumSet,
      });
      await attachVersion(partStore, part.id, versionId);

      // View selection: every attached image spends the session's image budget,
      // and a numeric iteration does not need four pictures of an unchanged
      // silhouette. An explicit [] means "register the version, spend no image
      // budget" — the panel still loads model.stl, so the human still sees it.
      const selection = selectAttachedViews(result.renders, a.views);
      if (selection.warning) result.warnings.push(selection.warning);
      const attachedRenders = selection.attached;

      // Persist renders as durable model-visible attachments.
      const refs: { view: string; ref: unknown }[] = [];
      try {
        for (const r of attachedRenders) {
          const [ref] = await ctx.attachments.saveImages([{
            data: r.png,
            mediaType: 'image/png',
            name: `${versionId}-${r.view}`,
          }]);
          if (ref) refs.push({ view: r.view, ref });
        }
      } catch (e) {
        result.warnings.push(`attachment save failed: ${String((e as Error).message)}`);
      }
      pendingRenderRefs.set(versionId, refs);

      // Scale, in numbers, next to the pictures. The four views carry no axes,
      // no grid and no dimension text, so a model comparing them cannot tell a
      // 4mm boss from a 40mm one; the bounding box is the cheapest honest fix
      // and it costs no extra render.
      const parsed = result.stl ? parseBinaryStl(result.stl) : null;
      const bbox = parsed ? boundingBoxOf(parsed) : null;
      const sizeMm = bbox
        ? [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]].map((v) => +v.toFixed(2))
        : null;

      // Mesh truth, computed HERE so the model never has a reason to skip the
      // check. microscope3's gear shaft shipped a non-closed, wrong-toothed
      // mesh through nine versions because nothing at generation time said
      // "this is not a solid"; the error was only caught when a human zoomed
      // into a panel screenshot.
      const watertight = parsed ? isWatertight(parsed).watertight : undefined;
      if (watertight === false) {
        result.warnings.push(
          'mesh is NOT watertight (open surface) — every later geometric check ' +
          '(interference, clearance, closest-point) runs on a false premise until this is fixed',
        );
      }
      if ((parsed ? shellCount(parsed) : 0) > 1) {
        result.warnings.push(
          `DISCIPLINE (DESIGN §18): ${shellCount(parsed!)} disconnected bodies in one version — a part must be a ` +
          'single connected solid. Either union the fragments in OpenSCAD, or model them as SEPARATE parts. ' +
          'Run measure_part to see where each body sits (it reports bodies, bodySizes, bodyCenters).',
        );
      }

      // REPRESENTATIVE-FIRST. The first version of a part is the representative a
      // family inherits its shared feature from (a slot, a snap, a thread). Screen
      // its walls HERE, in-process (TS path, ~60ms, no Python worker), so a
      // family-wide defect is visible before the siblings are generated. The
      // glucose sticks shipped v034-v037 with a 0.038mm lip because the screen
      // only ran after the whole family existed; v034 alone would have shown it.
      let minWallMm: number | undefined;
      let minWallAtMm: number[] | undefined;
      if (!a.parentVersion) {
        try {
          const screen = await checkPrintabilityInTs(store, {
            versionId, wallMinMm: 1.2, overhangDeg: 45, samples: 600,
          });
          minWallMm = screen.minWallMm;
          minWallAtMm = screen.minWallAtMm;
          if (minWallMm !== undefined) {
            const where = minWallAtMm ? ` @ [${minWallAtMm.map((n) => +n.toFixed(2)).join(', ')}]` : '';
            result.warnings.push(
              minWallMm < 1.2
                ? `first-version wall screen: thinnest ${minWallMm}mm${where} < 1.2mm — ` +
                  'fix this representative before generating parts that share the feature'
                : `first-version wall screen: thinnest ${minWallMm}mm${where}`,
            );
          }
        } catch (e) {
          result.warnings.push(`first-version wall screen unavailable: ${String((e as Error).message ?? e)}`);
        }
      }

      return {
        versionId, success: true,
        part: part.name,
        errors: [], warnings: result.warnings,
        durationMs: result.durationMs,
        views: attachedRenders.map((r) => r.view),
        ...(minWallMm !== undefined ? { minWallMm } : {}),
        ...(minWallAtMm ? { minWallAtMm } : {}),
        ...(sizeMm ? { sizeMm } : {}),
        ...(bbox ? { bboxMin: bbox.min.map((v) => +v.toFixed(2)), bboxMax: bbox.max.map((v) => +v.toFixed(2)) } : {}),
        ...(parsed
          ? {
              watertight,
              triangles: parsed.triVerts.length / 3,
              shells: shellCount(parsed),
            }
          : {}),
      };
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: GeneratePartResult }).value;
      if (!value) return undefined;
      const refs = pendingRenderRefs.get(value.versionId) ?? [];
      pendingRenderRefs.delete(value.versionId);
      const scale = value.sizeMm
        ? `Model size ${value.sizeMm.join(' × ')} mm (bbox min [${(value.bboxMin ?? []).join(', ')}] → max [${(value.bboxMax ?? []).join(', ')}]). `
        : '';
      const truth = value.watertight === false
        ? `⚠️ NOT WATERTIGHT (${value.shells} shell(s)) — fix the mesh before assembling, measuring or simulating; on an open surface every later number is a lie. `
        : '';
      const warns = (value.warnings ?? []).filter((w) => !w.startsWith('attachment save')).join(' ');
      const blocks: unknown[] = [{
        type: 'text',
        text: `Version ${value.versionId} saved to part "${value.part}". ` + scale + truth +
          `Attached render views in order: ${refs.map((r) => r.view).join(', ') || 'none'} ` +
          '(no axes or dimensions are drawn on them — use the size above, or measure_* for anything with a tolerance). ' +
          (warns ? warns : ''),
      }];
      for (const r of refs) {
        blocks.push({ type: 'image', attachment: r.ref });
      }
      return blocks as never;
    },
  }));

  // --- create_part: name a part before any geometry exists -------------------
  //
  // The part is the browse axis (versions and runs hang under it). Creating one
  // before the first version is the "git init" moment: it lets the human point
  // at a subject ("我们做一个调焦轴") while the geometry is still being argued
  // about. When geometry does exist, generate_part's own `part` argument creates
  // the part implicitly — this tool is not a prerequisite.
  registerTool(defineTool({
    name: 'create_part',
    description:
      'Name a part before any geometry exists; idempotent. generate_part creates a part automatically, so call this only to open a subject the user has merely talked about.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The name a human would call it, e.g. "调焦轴". Used as the part label in the panel.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          partId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          created: { type: 'boolean', required: true, description: 'false when the name already existed.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: unknown) {
      const a = args as { name: string };
      const { partStore } = await allStores(exec);
      if (!a?.name?.trim()) throw argError('create_part', 'name', 'is required (a non-empty string)', 'a display name, e.g. "吊盘架" — it becomes the part name everywhere',
          { example: 'create_part({ name: "吊盘架" })', received: a?.name });
      const existing = await findPartByName(partStore, a.name);
      if (existing) return { partId: existing.id, name: existing.name, created: false };
      const part = await createUniquePart(partStore, a.name, 'agent');
      return { partId: part.id, name: part.name, created: true };
    },
  }));

  // --- request_review: ask for attention, never take it ---------------------
  //
  // The queue exists because the panel must not move under the human: an agent
  // that finds something appends an item and stops. The limits are declared in
  // src/host/review-queue.ts (3/call, 6 calls/10 min, 20 unread, same target
  // merges). Refusals are returned as data, not thrown, because "the queue is
  // full" is a normal answer the agent should adapt to.
  registerTool(defineTool({
    name: 'request_review',
    description:
      'Ask the human to look at something (a version, a run, a part) or to consider a rollback — queued, never a popup. '
      + 'The panel badges the queue; the human opens it when they choose. Limits: 3 items per call, 6 calls per 10 minutes, '
      + '20 unread; repeating the same target within 10 minutes updates that item instead of adding another.',
    parameters: {
      items: {
        type: 'array',
        required: true,
        description: 'Up to 3 items. Each is one thing to look at, with a one-line title.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'One line: what to look at, e.g. "间隙 0 但行程只有 4.8mm".' },
            body: { type: 'string', description: 'Why it matters / what to check. Kept short — this is a queue entry, not a report.' },
            target: { type: 'string', description: 'Address the panel can open: v029 / r041 / p005 / u:relative/path.stl.' },
            kind: {
              type: 'string',
              enum: ['view', 'revert'],
              description: 'view = "look at this"; revert = "consider rolling back TO this version". Approval creates a NEW version; history is never rewritten.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true } },
            },
          },
          merged: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true } },
            },
          },
          dropped: { type: 'integer', required: true },
          unread: { type: 'integer', required: true },
          rateLimited: {
            type: 'object', additionalProperties: false,
            properties: {
              reason: { type: 'string', required: true },
              retryAfterSec: { type: 'integer', required: true },
              pending: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          queued: { id: string; title: string }[]; merged: { id: string; title: string }[];
          dropped: number; unread: number;
          rateLimited?: { reason: string; retryAfterSec: number; pending: number };
        };
        const parts = [
          v.queued.length ? `已排队 ${v.queued.length} 条（${v.queued.map((q) => `${q.id} ${q.title}`).join('；')}）` : '未新增条目',
          v.merged.length ? `${v.merged.length} 条与近 10 分钟内的同一目标合并` : '',
          v.dropped ? `${v.dropped} 条超出单次 3 条上限、未排队` : '',
          `队列未读 ${v.unread} 条`,
          v.rateLimited
            ? v.rateLimited.reason === 'queue_full'
              ? '队列已满（20 条未读）：人先清一轮再请求'
              : `被限流：${v.rateLimited.retryAfterSec}s 后可再请求（当前 ${v.rateLimited.pending} 条未读）`
            : '',
        ].filter(Boolean);
        return [{ type: 'text', text: parts.join('；') + '。' }];
      },
    },
    async execute(args: unknown, exec: unknown) {
      const a = args as { items?: { title?: string; body?: string; target?: string; kind?: string }[] };
      const items = Array.isArray(a?.items) ? a.items : [];
      if (items.length === 0) {
        throw argError('request_review', 'items', 'is required and must not be empty',
          'one entry per thing the human should look at', { example: 'request_review({ items: [{ title: "看这次间隙", target: "r041" }] })', received: a?.items });
      }
      const stores = await allStores(exec);
      // An address that resolves to nothing is noise in a queue: reject it here,
      // where the caller can still fix it, instead of parking a dead link.
      for (const it of items) {
        const target = String(it?.target ?? '').trim();
        if (!target || !/^[vrp]\d{3,}$/.test(target)) continue;
        if (!(await storeFor(stores).resolve(target))) {
          // The id itself rides in `received`: `argError` appends it, and the lint
          // requires the four leading arguments to be plain literals.
          throw argError('request_review', 'items', 'a target does not resolve in this project',
            'use a vNNN / rNNN / pNNN that exists here (ask list_* or use the id a tool just returned)',
            { example: 'request_review({ items: [{ title: "看这次间隙", target: "r041" }] })', received: target });
        }
      }
      return await enqueueReviews(stores.root, items.map((it) => ({
        kind: it?.kind === 'revert' ? 'revert' as const : 'view' as const,
        title: String(it?.title ?? ''),
        body: String(it?.body ?? ''),
        target: it?.target ? String(it.target).trim() : null,
      })));
    },
  }));

  // --- import_part: an external file becomes a first-class version ----------
  //
  // WHY A VERSION AND NOT A REFERENCE. Every tool here takes a `versionId` and
  // reads `versions/vNNN/model.stl`. Landing an import as a version is what
  // makes "someone else's part" usable by measure_part / render_part /
  // validate_assembly / check_assembly / simulate_* with no special case
  // anywhere — and what makes it reviewable in the panel like anything else. A
  // side channel ("external model reference") would have forced all eleven
  // consumers to learn about a second kind of geometry, which is how a
  // capability turns into eleven special cases.
  //
  // WHY IT REFUSES THINGS. An import that quietly accepts a mesh with holes
  // makes every downstream number a lie, and this harness's entire claim is
  // that its numbers are not lies. So the default is: prove it is a closed
  // solid, or store nothing. `allowNonSolid` is the escape hatch for looking at
  // broken geometry, and it brands the version so the geometric tools refuse it
  // out loud instead of measuring a shape that is not a body.

  interface ImportPartArgs {
    file: string;
    part?: string;
    parentVersion?: string;
    userIntent?: string;
    unit?: Unit;
    scale?: number;
    /** Extrusion depth (mm) for DXF 2D closed profiles. */
    depthMm?: number;
    /** Tessellation tolerances for STEP/3MF (ignored for STL/DXF). */
    tolLinear?: number;
    tolAngular?: number;
    datums?: DatumInput[];
    allowNonSolid?: boolean;
    render?: boolean;
  }

  interface ImportPartResult {
    versionId: string;
    part: string;
    format: string;
    solid: boolean;
    watertight: boolean;
    repaired: string[];
    triangles: number;
    shells: number;
    genus: number;
    volumeMm3: number;
    sizeMm: number[];
    unit: string;
    scaleApplied: number;
    sha256: string;
    sourcePath: string;
    datums: string[];
    warnings: string[];
    durationMs: number;
    views: string[];
  }

  /** Shared by the tool and POST /api/cad/import — one implementation, two doors. */
  async function importPartJob(a: ImportPartArgs, project: ProjectStores): Promise<ImportPartResult> {
    const started = Date.now();
    const { store, partStore } = project;
    if (!a?.file?.trim()) throw argError('import_part', 'file', 'is required', 'a path to an STL/3MF/STEP/DXF inside the session workspace (absolute, or relative to it)',
          { example: 'import_part({ file: "models/pan.stl" })', received: a?.file });

    const part = await resolvePartForWrite({
      part: a.part,
      parentVersion: a.parentVersion,
      fallbackName: deriveNameFromFile(a.file),
    }, project);

    const g = await importGeometry({
      file: a.file,
      cwd: project.cwd,
      unit: a.unit,
      scale: a.scale,
      depthMm: a.depthMm,
      tolLinear: a.tolLinear,
      tolAngular: a.tolAngular,
      allowNonSolid: a.allowNonSolid,
    });
    const datumSet = normalizeDatums(a.datums);

    // Renders come from the very bytes that are about to be stored (through a
    // temp file), so the picture and the version can never disagree.
    const warnings = [...g.warnings];
    let renders: { view: string; png: Uint8Array }[] = [];
    if (a.render !== false) {
      const tmp = await mkdtemp(join(tmpdir(), 'cad-import-'));
      try {
        const stlPath = join(tmp, 'model.stl');
        await writeFile(stlPath, g.stl);
        renders = await renderStlViews(stlPath);
      } catch (e) {
        warnings.push(`render failed: ${String((e as Error).message)}`);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    }

    const versionId = await saveVersion(store, {
      stl: g.stl,
      renders,
      userIntent: a.userIntent?.trim() || `导入自 ${basename(g.resolvedPath)}`,
      parentVersion: a.parentVersion ?? null,
      partId: part.id,
      ...(datumSet ? { datumSet } : {}),
      source: {
        kind: 'imported',
        file: g.resolvedPath,
        sha256: g.sha256,
        bytes: g.bytes,
        format: g.format,
        unit: g.unit,
        scale: g.appliedScale,
        repaired: g.repaired,
        at: new Date().toISOString(),
      },
      solid: g.solid,
    });
    await attachVersion(partStore, part.id, versionId);

    // Persist renders as durable model-visible attachments (same channel as
    // generate_part: the model must SEE an imported part, not just read about it).
    const refs: { view: string; ref: unknown }[] = [];
    try {
      for (const r of renders) {
        const [ref] = await ctx.attachments.saveImages([{
          data: r.png,
          mediaType: 'image/png',
          name: `${versionId}-${r.view}`,
        }]);
        if (ref) refs.push({ view: r.view, ref });
      }
    } catch (e) {
      warnings.push(`attachment save failed: ${String((e as Error).message)}`);
    }
    pendingRenderRefs.set(versionId, refs);

    const datumNames = datumSet
      ? [...datumSet.points, ...datumSet.axes, ...datumSet.planes, ...datumSet.cylinders].map((d) => d.name)
      : [];

    return {
      versionId,
      part: part.name,
      format: g.format,
      solid: g.solid,
      watertight: g.watertight,
      repaired: g.repaired,
      triangles: g.triangles,
      shells: g.shells,
      genus: g.genus,
      volumeMm3: g.volumeMm3,
      sizeMm: g.boundingBoxMm.size,
      unit: g.unit,
      scaleApplied: g.appliedScale,
      sha256: g.sha256,
      sourcePath: g.resolvedPath,
      datums: datumNames,
      warnings,
      durationMs: Date.now() - started,
      views: renders.map((r) => r.view),
    };
  }

  registerTool(defineTool({
    name: 'import_part',
    description:
      'Import an external STL (binary/ASCII, mm z-up), STEP/STP (OpenCASCADE tessellation) or 3MF (trimesh; a 3MF ' +
      'must contain ONE object — a plate of objects is refused, not stored as a multi-body part) or DXF (closed 2D ' +
      'profiles extruded by depthMm, or 3D mesh entities) as a new version of a part, so it can be measured, ' +
      'assembled and simulated like any generated part. STEP and 3MF carry their own units, honored and folded to ' +
      'mm; STL and DXF take the declared `unit`. ' +
      'This is the DEFAULT landing path for geometry produced outside generate_part: a file written ' +
      'straight to disk is invisible to the panel and to every tool, so anything the human must see ' +
      'or a check must address has to become a version. ' +
      'Runs the same truth engine on it and REFUSES a mesh that is not a closed solid unless allowNonSolid. ' +
      'IGES is not readable — re-export STEP or STL instead.',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Path to the file; a relative path resolves against the project directory. The bytes are copied into the version, never referenced.',
      },
      part: {
        type: 'string',
        description: 'Which part to file it under (defaults to the file name). Re-importing a corrected export under the same part is how you iterate an imported part.',
      },
      parentVersion: {
        type: 'string',
        description: 'Version id this import supersedes, e.g. "v003". Must belong to the same part.',
      },
      userIntent: {
        type: 'string',
        description: 'One-line summary for the version history; defaults to "导入自 <file>".',
      },
      unit: {
        type: 'string',
        description: 'The source file\'s unit as DECLARED by you: mm (default), cm, m or inch. STL carries no unit, so this is never inferred. STEP self-declares (mm only accepted); DXF $INSUNITS wins when set.',
      },
      scale: {
        type: 'number',
        description: 'Extra multiplier applied on top of unit, e.g. 0.5 for a half-scale model.',
      },
      depthMm: {
        type: 'number',
        description: 'Extrusion depth in mm for DXF 2D closed profiles, e.g. 10 for a 10mm plate. Required when a DXF has no 3D mesh entities; ignored otherwise.',
      },
      tolLinear: {
        type: 'number',
        description: 'Tessellation linear tolerance for STEP/3MF, mm (ignored for STL/DXF). Default is OpenCASCADE\'s ~0.01; lower = more triangles. Measured: 0.01 -> 3074 triangles, 0.002 -> 12254, volume differs <0.3%.',
      },
      tolAngular: {
        type: 'number',
        description: 'Tessellation angular tolerance for STEP/3MF, radians (ignored for STL/DXF). Lower = finer around curved faces.',
      },
      datums: {
        type: 'array',
        description: 'Anchors making the imported part an assembly interface endpoint (check_assembly addresses "<partId>.<datumName>"). Coordinates are in the file\'s own frame, after unit/scale.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Datum name, e.g. "内孔".' },
            kind: { type: 'string', required: true, description: 'point | axis | plane | cylinder.' },
            point: { type: 'array', required: true, description: '[x,y,z] mm.', items: { type: 'number' } },
            dir: { type: 'array', description: 'Direction (axis/cylinder).', items: { type: 'number' } },
            normal: { type: 'array', description: 'Normal (plane).', items: { type: 'number' } },
            radius: { type: 'number', description: 'Radius mm (cylinder; used by diameter-match).' },
          },
        },
      },
      allowNonSolid: {
        type: 'boolean',
        description: 'Store it even though it is not a closed solid (holes, T-junctions, inside-out winding); the geometric tools will then refuse this version. Default false.',
      },
      render: {
        type: 'boolean',
        description: 'Render four views into the conversation (default true, same views as generate_part).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          part: { type: 'string', required: true },
          format: { type: 'string', required: true, description: 'stl-binary, stl-ascii, step-cascadio, dxf-ezdxf-extrude or dxf-ezdxf-mesh.' },
          solid: { type: 'boolean', required: true },
          watertight: { type: 'boolean', required: true },
          repaired: { type: 'array', required: true, items: { type: 'string' }, description: 'What welding changed, in words.' },
          triangles: { type: 'integer', required: true },
          shells: { type: 'integer', required: true, description: 'Separate bodies in the file (edge-disjoint).' },
          genus: { type: 'integer', required: true, description: '0 when the mesh is not a solid.' },
          volumeMm3: { type: 'number', required: true },
          sizeMm: { type: 'array', required: true, items: { type: 'number' } },
          unit: { type: 'string', required: true },
          scaleApplied: { type: 'number', required: true },
          sha256: { type: 'string', required: true, description: 'Fingerprint of the file that was read.' },
          sourcePath: { type: 'string', required: true },
          datums: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          durationMs: { type: 'integer', required: true },
          views: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 180_000,
    async execute(args: unknown, exec: unknown): Promise<ImportPartResult> {
      return importPartJob(args as ImportPartArgs, await allStores(exec));
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: ImportPartResult }).value;
      if (!value) return undefined;
      const refs = pendingRenderRefs.get(value.versionId) ?? [];
      pendingRenderRefs.delete(value.versionId);
      const solidLine = value.solid
        ? `closed solid · ${value.triangles} triangles · ${value.sizeMm.map((v) => v.toFixed(1)).join(' × ')} mm`
        : `NOT A SOLID (stored because allowNonSolid was set) — the geometric tools will refuse ${value.versionId}`;
      const blocks: unknown[] = [{
        type: 'text',
        text: `Imported ${basename(value.sourcePath)} as version ${value.versionId} of part "${value.part}" (${value.format}). ` +
          `${solidLine}.` +
          (value.datums.length ? ` Datums: ${value.datums.join(', ')}.` : '') +
          ` Attached render views in order: ${refs.map((r) => r.view).join(', ') || 'none'}.`,
      }];
      for (const r of refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  // --- merge_parts: N parts at their placements → one solid version ----------
  //
  // WHY. A whole machine sometimes has to be ONE body: `simulate_physics` needs
  // a single rigid body to answer "does it topple", and a whole-machine
  // `measure_part` needs one solid to report mass properties. Neither
  // `generate_part` nor `import_part` can express that, so the microscope2 run
  // hand-wrote an OpenSCAD union over 16 exported STLs, got an empty object on
  // the first attempt, spent 2.5 minutes on the second, and filed the 83 MB
  // result as a fake part. Manifold is already linked into this host and already
  // has all N solids in hand inside `validate_assembly`; this is that union,
  // with a provenance record of what went into it.

  interface MergePartsArgs {
    parts: { name: string; scadCode?: string; versionId?: string; translate?: number[]; rotate?: number[] }[];
    part?: string;
    userIntent: string;
  }

  interface MergePartsResult {
    versionId: string;
    part: string;
    triangles: number;
    volumeMm3: number;
    sizeMm: number[];
    shells: number;
    sources: { name: string; versionId?: string }[];
    warnings: string[];
    durationMs: number;
    views: string[];
  }

  /** The union job behind the `merge_parts` tool. */
  async function mergePartsJob(a: MergePartsArgs, project: ProjectStores): Promise<MergePartsResult> {
    const started = Date.now();
    const { store, partStore } = project;
    if (!Array.isArray(a.parts) || a.parts.length < 2) throw argError('merge_parts', 'parts', 'needs at least 2 parts (a merge of one is not a merge)', 'an array of { name, versionId } with ≥2 entries',
          { example: 'merge_parts({ parts: [{ name: "a", versionId: "v001" }, { name: "b", versionId: "v002" }], userIntent: "…" })', received: a?.parts });
    assertPartNames(a.parts, 'merge_parts');
    if (!a.userIntent?.trim()) throw argError('merge_parts', 'userIntent', 'is required', 'one sentence naming the merged part — it becomes the new part name',
          { example: 'merge_parts({ parts: […], userIntent: "把吊盘与立柱合成整机" })', received: a?.userIntent });

    const part = await resolvePartForWrite({
      part: a.part,
      parentVersion: undefined,
      fallbackName: derivePartName(a.userIntent),
    }, project);

    const warnings: string[] = [];
    const sources: { name: string; versionId?: string }[] = [];
    const provenance: { name: string; versionId: string | null }[] = [];
    // The union is Python's (batch 1). Each part's STL goes to the worker's
    // scratch directory and travels as a PATH; the worker writes the merged STL
    // itself, so the deliverable is produced on the side that computed it. What
    // stays here is resolution, provenance, renders and version storage.
    const scratch = await workerScratchDir();
    const inputs: string[] = [];
    const payload: { name: string; path: string; transform?: { translate?: number[]; rotate?: number[] } }[] = [];
    for (const p of a.parts) {
      const g = await resolvePartGeometry(p, project);
      sources.push({ name: p.name, ...(g.versionId ? { versionId: g.versionId } : {}) });
      provenance.push({ name: p.name, versionId: g.versionId });
      const path = join(scratch, `merge-${randomUUID()}.stl`);
      await writeFile(path, g.stl);
      inputs.push(path);
      payload.push({
        name: p.name,
        path,
        transform: {
          translate: p.translate as number[] | undefined,
          rotate: p.rotate as number[] | undefined,
        },
      });
    }
    const mergedPath = join(scratch, `merged-${randomUUID()}.stl`);
    let solved: MergeSolve;
    try {
      solved = await (await ensurePythonWorker()).request<MergeSolve>('merge_solids', {
        parts: payload,
        out: mergedPath,
        header: `dsh-cad-harness merge of ${a.parts.length} parts`,
      });
    } catch (e) {
      // The worker names the failing part; keep that attribution and drop the
      // protocol prefix so the message reads like it always did.
      const message = String((e as Error).message ?? e)
        .replace(/^[a-z_]+ failed: /, '')
        .replace(/^ValueError: /, '');
      throw new Error(`merge_parts: ${message}`);
    } finally {
      await Promise.all(inputs.map((path) => rm(path, { force: true }).catch(() => {})));
    }
    const stl = new Uint8Array(await readFile(mergedPath));
    await rm(mergedPath, { force: true }).catch(() => {});

    const shells = solved.shells;
    if (shells > 1) {
      warnings.push(
        `the merged body has ${shells} disjoint shells — the parts you merged do not all touch. ` +
        'That is legitimate for a rigid-body study, but a volume or centre-of-mass read off it ' +
        'is the sum over all shells, and a physics run will treat them as one rigid body.',
      );
    }
    const sizeMm = solved.sizeMm;

    // Renders come from the very bytes that are about to be stored.
    let renders: { view: string; png: Uint8Array }[] = [];
    const tmp = await mkdtemp(join(tmpdir(), 'cad-merge-'));
    try {
      const stlPath = join(tmp, 'model.stl');
      await writeFile(stlPath, stl);
      renders = await renderStlViews(stlPath);
    } catch (e) {
      warnings.push(`render failed: ${String((e as Error).message)}`);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }

    const versionId = await saveVersion(store, {
      stl,
      renders,
      userIntent: a.userIntent.trim(),
      parentVersion: null,
      partId: part.id,
      solid: true,
      source: { kind: 'merged', from: provenance, at: new Date().toISOString() },
    });
    await attachVersion(partStore, part.id, versionId);

    const refs: { view: string; ref: unknown }[] = [];
    try {
      for (const r of renders) {
        const [ref] = await ctx.attachments.saveImages([{
          data: r.png, mediaType: 'image/png', name: `${versionId}-${r.view}`,
        }]);
        if (ref) refs.push({ view: r.view, ref });
      }
    } catch (e) {
      warnings.push(`attachment save failed: ${String((e as Error).message)}`);
    }
    pendingRenderRefs.set(versionId, refs);

    return {
      versionId,
      part: part.name,
      triangles: solved.triangles,
      volumeMm3: solved.volumeMm3,
      sizeMm,
      shells,
      sources,
      warnings,
      durationMs: Date.now() - started,
      views: renders.map((r) => r.view),
    };
  }

  registerTool(defineTool({
    name: 'merge_parts',
    description:
      'Union two or more parts, each at its assembly placement, into ONE new solid part version. Use it when the whole machine must be a single rigid body: simulate_physics topple/stability, or a whole-assembly measure_part. Replaces hand-merging STLs in OpenSCAD. mm, z-up; rotate first (degrees in R = Rz·Ry·Rx — the OpenSCAD/Manifold composition; three.js order `ZYX`), then translate.',
    parameters: {
      parts: {
        type: 'array',
        required: true,
        description: 'Parts to union (at least 2), each with its placement in the merged body\'s frame.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Part name (any language; used in the provenance record).' },
            scadCode: { type: 'string', description: 'Complete OpenSCAD source for this part. Give this OR versionId.' },
            versionId: { type: 'string', description: 'Use a saved version\'s model.stl as this part\'s geometry. Overrides scadCode.' },
            translate: { type: 'array', description: 'Placement [x,y,z] in mm applied after rotation.', items: { type: 'number' } },
            rotate: { type: 'array', description: 'Rotation [rx,ry,rz] in degrees (XYZ order) applied before translation.', items: { type: 'number' } },
          },
        },
      },
      userIntent: { type: 'string', required: true, description: 'One-line summary for the version history, e.g. "整机刚体（用于倾倒测试）".' },
      part: { type: 'string', description: 'Which part the merged version belongs to. Defaults to a name derived from userIntent. Pass this to re-merge into an existing part.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          part: { type: 'string', required: true },
          triangles: { type: 'integer', required: true },
          volumeMm3: { type: 'number', required: true },
          sizeMm: { type: 'array', required: true, items: { type: 'number' } },
          shells: { type: 'integer', required: true },
          sources: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                versionId: { type: 'string' },
              },
            },
          },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          durationMs: { type: 'integer', required: true },
          views: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 300_000,
    async execute(args: unknown, exec: unknown): Promise<MergePartsResult> {
      return mergePartsJob(args as MergePartsArgs, await allStores(exec));
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: MergePartsResult }).value;
      if (!value) return undefined;
      const refs = pendingRenderRefs.get(value.versionId) ?? [];
      pendingRenderRefs.delete(value.versionId);
      const from = value.sources.map((s) => `${s.name}${s.versionId ? `(${s.versionId})` : ''}`).join(' + ');
      const blocks: unknown[] = [{
        type: 'text',
        text: `Merged ${value.sources.length} parts into version ${value.versionId} of part "${value.part}" ` +
          `(${from}). ${value.triangles} triangles · ${value.volumeMm3.toFixed(0)}mm³ · ` +
          `${value.sizeMm.map((v) => v.toFixed(1)).join(' × ')}mm · ${value.shells} shell(s). ` +
          (value.warnings.length ? `Warnings: ${value.warnings.join(' ')} ` : '') +
          `Attached render views in order: ${refs.map((r) => r.view).join(', ') || 'none'}.`,
      }];
      for (const r of refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  // --- set_datums: anchors are metadata, not a new version -------------------

  interface SetDatumsArgs {
    versionId: string;
    datums?: DatumInput[];
    replace?: boolean;
  }

  registerTool(defineTool({
    name: 'set_datums',
    description:
      'Read or declare the datum anchors of a version. Call it with only versionId to list what that version declares (names and world coordinates) — the input you need to write assembly interfaces. Call it with datums to record anchors; because an anchor is what an interface RESOLVES against, declaring them creates a NEW version (parent = the given one) instead of rewriting history: a run that cited the old anchors must keep meaning what it meant (§22 evidence). The mesh is copied byte-for-byte, so the geometry is identical.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Version to read or edit, e.g. "v003".' },
      datums: {
        type: 'array',
        description: 'Anchors to write. Omit to list the current ones. Coordinates are in the version\'s own stored frame, final world coordinates.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', required: true, description: 'point | axis | plane | cylinder' },
            point: { type: 'array', required: true, items: { type: 'number' } },
            dir: { type: 'array', description: 'axis/cylinder direction.', items: { type: 'number' } },
            normal: { type: 'array', description: 'plane normal.', items: { type: 'number' } },
            radius: { type: 'number', description: 'cylinder radius, mm.' },
          },
        },
      },
      replace: { type: 'boolean', description: 'true = drop the existing anchors and keep only these. Default false = merge by name (an incoming anchor of the same name replaces the old one).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true, description: 'The version these anchors belong to. In write mode this is the NEW version; in list mode it is the one you asked about.' },
          previousVersionId: { type: 'string', description: 'Write mode only: the version that was read (its anchors are unchanged).' },
          userIntent: { type: 'string', required: true },
          mode: { type: 'string', required: true, description: 'list | versioned (a new version now carries these anchors) — the merge/replace distinction is reported in warnings.' },
          datums: { type: 'array', required: true, items: { type: 'string' } },
          counts: { type: 'object', required: true, additionalProperties: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: unknown) {
      const a = args as SetDatumsArgs;
      const { store } = await allStores(exec);
      const entry = await readVersionEntry(store, a.versionId);
      // The index is not the artifact: a version directory can exist without a
      // manifest row (hand-copied or older corpora). Refuse only when there is
      // nothing there at all.
      const known = entry ?? (await versionExists(store, a.versionId)
        ? { userIntent: '(not in the version index)', source: undefined as undefined }
        : null);
      if (!known) throw new Error(await versionNotFound(store, a.versionId));
      const warnings: string[] = entry ? [] : [`${a.versionId} exists on disk but is not in the version index`];
      const current = await readVersionDatums(store, a.versionId);
      const summarise = (set: typeof current) => ({
        points: set.points.length, axes: set.axes.length,
        planes: set.planes.length, cylinders: set.cylinders.length,
      });
      const describe = (set: typeof current) => [
        ...set.points.map((d) => `point "${d.name}" @ [${d.point.join(', ')}]`),
        ...set.axes.map((d) => `axis "${d.name}" @ [${d.point.join(', ')}] dir [${d.dir.join(', ')}]`),
        ...set.planes.map((d) => `plane "${d.name}" @ [${d.point.join(', ')}] normal [${d.normal.join(', ')}]`),
        ...set.cylinders.map((d) => `cylinder "${d.name}" @ [${d.point.join(', ')}] dir [${d.dir.join(', ')}] r${d.radius}`),
      ];

      if (!a.datums || a.datums.length === 0) {
        return {
          versionId: a.versionId,
          userIntent: known.userIntent,
          mode: 'list',
          datums: describe(current),
          counts: summarise(current),
          warnings: [
            ...warnings,
            ...(describe(current).length === 0
              ? ['this version declares no datums, so it cannot be an endpoint of an assembly interface']
              : []),
          ],
        };
      }

      const incoming = normalizeDatums(a.datums);
      if (!incoming) throw new Error('set_datums: no usable anchors in the request');
      const next = a.replace ? incoming : unionDatumSets(current, incoming);
      if (entry?.source?.kind === 'merged') {
        warnings.push('this version is a merged body; its anchors live in the merged frame, which is where check_assembly resolves them');
      }
      const removed = a.replace
        ? datumNames(current).filter((n) => !datumNames(next).includes(n))
        : [];
      if (removed.length > 0) {
        // Interfaces addressing a dropped anchor stop resolving; say so here
        // rather than letting check_assembly report it as an unknown endpoint.
        warnings.push(`replaced: dropped ${removed.length} existing anchor(s) — ${removed.join(', ')}`);
      }
      // An anchor is not metadata: it is what an interface RESOLVES against (§6.4), so
      // rewriting it in place silently changes the meaning of every run that cited it.
      // Write a new version instead (user decision 2026-10-23, DESIGN §6.8/C4): the mesh
      // is copied byte-for-byte, the old anchors stay where they were, and the caller is
      // told which id now carries the new ones.
      const srcDir = join(store.root, 'versions', a.versionId);
      const stl = new Uint8Array(await readFile(join(srcDir, 'model.stl')));
      const newId = await saveVersion(store, {
        userIntent: `${known.userIntent} · 锚点变更（源自 ${a.versionId}）`,
        parentVersion: a.versionId,
        stl,
        datumSet: next,
        ...(entry?.partId ? { partId: entry.partId } : {}),
        ...(known.source ? { source: known.source } : {}),
        solid: true,
      });
      warnings.push(
        `${a.versionId} still declares its previous anchors; interfaces pointing at it must be re-pointed to ${newId}.`,
      );
      return {
        versionId: newId,
        previousVersionId: a.versionId,
        userIntent: a.replace ? known.userIntent : known.userIntent,
        mode: 'versioned',
        datums: describe(next),
        counts: summarise(next),
        warnings,
      };
    },
  }));

  // --- validate_assembly: multi-part interference and clearance check ---

  registerTool(defineTool({
    name: 'validate_assembly',
    description:
      'Static multi-part check: watertightness plus, for every pair, exact interference volume and minimum clearance, in the poses you give. Behaviour under gravity or motion is simulate_physics.',
    parameters: {
      parts: {
        type: 'array',
        required: true,
        description: 'Parts of the assembly.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Unique part name, e.g. "base-plate".' },
            scadCode: { type: 'string', description: 'Complete OpenSCAD source for this part. Give this OR versionId.' },
            versionId: { type: 'string', description: 'Use a saved version\'s model.stl as this part\'s geometry (records provenance: the run then lists that version as its source). Overrides scadCode.' },
            translate: {
              type: 'array',
              description: 'Placement [x,y,z] in mm applied after rotation.',
              items: { type: 'number' },
            },
            rotate: {
              type: 'array',
              description: 'Rotation [rx,ry,rz] in degrees (XYZ order) applied before translation.',
              items: { type: 'number' },
            },
            pose: {
              type: 'object',
              description: 'THE ASSEMBLY POSE: rotate about a datum axis of THIS part (versionId parts only), datums following. Use for meshing angles etc. — a whole-part rotate would drag unrelated features along.',
              additionalProperties: false,
              properties: {
                datum: { type: 'string', description: 'Datum name (axis/cylinder/plane anchors the axis; a point needs axis too).' },
                axis: { type: 'array', items: { type: 'number' }, description: 'Axis direction [x,y,z] in the part local frame (required only for a point datum).' },
                angleDeg: { type: 'number', required: true, description: 'Rotation about the axis, degrees, right-hand rule.' },
              },
            },
          },
        },
      },
      clearanceThreshold: {
        type: 'number',
        description: 'Minimum allowed clearance in mm between non-interfering parts. Default 0.75.',
      },
      interferenceEpsilonMm3: {
        type: 'number',
        description: 'Interference below this volume (mm³) counts as polygonal-fit residual, not a clash. Default 1e-3. Raise it (e.g. 1) when a printed thread\'s segmentation noise keeps drowning the report.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          overallStatus: { type: 'string', required: true },
          judgement: { type: 'string', required: true, description: '"excluded" | "difficult" | "not-excluded" — the canonical judgement (src/shared/judgement.ts); read THIS, not overallStatus.' },
          judgedBy: { type: 'object', required: true, additionalProperties: true, description: 'Counts the judgement was derived from: hardViolations / intentFlags / skipped / undeclared. A skipped interface is "unevaluable" and must never read as a pass.' },
          parts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                watertight: { type: 'boolean', required: true },
                volume: { type: 'number', required: true },
              },
            },
          },
          pairs: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                partA: { type: 'string', required: true },
                partB: { type: 'string', required: true },
                intersectionVolume: { type: 'number', required: true },
                minDistance: { type: 'number', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    timeoutMs: 300_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        parts: { name: string; scadCode?: string; versionId?: string; translate?: number[]; rotate?: number[]; pose?: { datum?: string; axis?: number[]; angleDeg: number } }[];
        clearanceThreshold?: number;
        interferenceEpsilonMm3?: number;
      };
      const project = await allStores(exec);
      const { runStore, store } = project;
      if (!Array.isArray(a.parts) || a.parts.length < 2) {
        throw argError('validate_assembly', 'parts', 'needs at least 2 parts', 'an array of { name, versionId } — per-pair interference needs two solids',
          { example: 'validate_assembly({ parts: [{ name: "a", versionId: "v001" }, { name: "b", versionId: "v002" }] })', received: a?.parts });
      }
      assertPartNames(a.parts, 'validate_assembly');
      const inputs: AssemblyPartInput[] = [];
      const usedVersions: (string | null)[] = [];
      const geometries: { name: string; stl: Uint8Array; translate?: number[]; rotate?: number[] }[] = [];
      for (const p of a.parts) {
        const g = await resolvePartGeometry(p, project);
        usedVersions.push(g.versionId);
        geometries.push({ name: p.name, stl: g.stl, translate: p.translate, rotate: p.rotate });
        // Assembly pose: rotate about a datum axis of the part itself. Resolved
        // from the version's datums.json; the same affine is applied to the
        // mesh (as a leading 3×3) — datums are not re-exported here, but the
        // geometry the pairs are computed on is the posed one.
        let matrix: readonly (readonly [number, number, number])[] | undefined;
        if (p.pose && typeof p.pose.angleDeg === 'number' && p.pose.angleDeg !== 0 && g.versionId) {
          const raw = await readVersionDatums(store, g.versionId);
          let anchor: [number, number, number] | null = null;
          let dir = (p.pose.axis as [number, number, number] | undefined) ?? null;
          for (const d of raw.axes) if (d.name === p.pose.datum) { anchor = d.point; dir = d.dir; }
          for (const d of raw.cylinders) if (d.name === p.pose.datum) { anchor = d.point; dir = d.dir; }
          for (const d of raw.planes) if (d.name === p.pose.datum) { anchor = d.point; dir = d.normal; }
          for (const d of raw.points) if (d.name === p.pose.datum) anchor = d.point;
          if (!anchor || !dir) {
            throw new Error(`pose datum "${p.pose.datum ?? '?'}" not found on version ${g.versionId}`);
          }
          const { axisAngleAffine, eulerMatrix } = await import('./assembly-check.ts');
          const poseA = axisAngleAffine(anchor, dir, p.pose.angleDeg);
          const rotM = p.rotate ? eulerMatrix(p.rotate as [number, number, number]) : null;
          const full = rotM
            ? [0, 1, 2].map((r) => [0, 1, 2].map((c) =>
                rotM[r]![0]! * poseA.m[0]![c]! + rotM[r]![1]! * poseA.m[1]![c]! + rotM[r]![2]! * poseA.m[2]![c]!,
              )) as unknown as readonly (readonly [number, number, number])[]
            : poseA.m;
          matrix = full;
        }
        inputs.push({
          name: p.name,
          stl: g.stl,
          transform: {
            translate: p.translate as [number, number, number] | undefined,
            // With a pose, the matrix already carries rotate∘pose — never both.
            ...(matrix
              ? { matrix }
              : { rotate: p.rotate as [number, number, number] | undefined }),
          },
        });
      }
      const sourceVersionIds = collectVersions(usedVersions);
      const report = await validateAssembly(inputs, a.clearanceThreshold ?? 0.75, a.interferenceEpsilonMm3 ?? 1e-3);

      // Persist as a run: the panel browses it as a product, and the geometry it
      // was computed on travels with it.
      const run = await beginRun(runStore, {
        kind: 'assembly',
        title: runSubject('assembly', geometries.map((g) => g.name), sourceVersionIds)
          ?? `装配间隙 · ${provenanceLabel(sourceVersionIds)}`,
      });
      for (const g of geometries) {
        await run.part(g.name, g.stl, { translate: g.translate, rotate: g.rotate });
      }
      await run.json('report.json', report);

      // ... and render the assembly the report is about. This is the only tool
      // that ever has every part at its placement in one place, so it is the
      // only place a whole-machine picture can come from; see assembly-render.ts.
      const pngs = await renderAssemblyViews(
        geometries.map((g) => ({
          name: g.name,
          stlPath: join(run.dir, 'parts', `${g.name}.stl`),
          translate: g.translate,
          rotate: g.rotate,
        })),
        assemblyFrameDir(run.dir),
      );
      const refs: { view: string; ref: unknown }[] = [];
      try {
        for (const f of pngs) {
          const [ref] = await ctx.attachments.saveImages([{
            data: f.png, mediaType: 'image/png', name: `assembly-${f.view}`,
          }]);
          if (ref) refs.push({ view: f.view, ref });
        }
      } catch { /* pictures are a bonus; the numeric verdict already stands */ }

      const tight = report.pairs.filter((x) => x.status === 'too_tight').length;
      const clash = report.pairs.filter((x) => x.status === 'interference').length;
      // The canonical judgement (src/shared/judgement.ts). L0 geometry has no noise band:
      // a witness either contradicts the declared clearance (interference, or a measured
      // gap below `clearanceThreshold`) or nothing was found. So the honest mapping is
      // two-valued, and `difficult` is deliberately never emitted here — the margin lives
      // in `pairs[].minDistance` vs `clearanceThresholdMm`, both of which travel with it.
      // Computed ONCE, before the commit, so the run and the reply cannot disagree.
      const nonWatertight = report.parts.filter((p) => !p.watertight).map((p) => p.name);
      const judgement = nonWatertight.length > 0 || clash > 0 || tight > 0 ? 'excluded' : 'not-excluded';
      const judgedBy = {
        parts: report.parts.length,
        pairs: report.pairs.length,
        nonWatertight,
        interference: clash,
        tooTight: tight,
        clearanceThresholdMm: report.thresholdMm,
        interferenceEpsilonMm3: report.interferenceEpsilonMm3,
      };
      await run.commit({
        title: runSubject('assembly', geometries.map((g) => g.name), sourceVersionIds)
          ?? `装配间隙 · ${provenanceLabel(sourceVersionIds)}`,
        sourceVersionIds,
        status: report.overallStatus === 'pass' ? 'pass' : 'fail',
        // Same value the tool returns; the run carries it so the panel can answer
        // "is this revision excluded?" without parsing a report.
        judgement,
        summary: `${report.pairs.length} 对 · 干涉 ${clash} · 过紧 ${tight}`,
        // Same part set = same question re-asked; the newest answer is the one
        // that counts, so older runs about this exact set become history.
        subject: `parts:${a.parts.map((p) => p.name).slice().sort().join('+')}`,
      });

      assemblyRefsForFinalize = { refs, views: pngs.length, runId: run.id, thresholdMm: report.thresholdMm };
      return {
        overallStatus: report.overallStatus,
        judgement,
        judgedBy,
        parts: report.parts.map((p) => ({ name: p.name, watertight: p.watertight, volume: p.volume })),
        pairs: report.pairs,
      };
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: { overallStatus: string; parts: unknown[]; pairs: { partA: string; partB: string; intersectionVolume: number; minDistance: number; status: string }[] } }).value;
      const state = assemblyRefsForFinalize;
      assemblyRefsForFinalize = null;
      if (!value || !state) return undefined;
      const pairs = value.pairs;
      const clash = pairs.filter((p) => p.status === 'interference').length;
      const tight = pairs.filter((p) => p.status === 'too_tight').length;
      // Worst first: interference, then the smallest gaps. A 16-part assembly is
      // 120 pairs — the model needs the ones that are decisions, plus the scale
      // of what it is not being shown, not 120 rows of JSON.
      const rank = (p: { status: string }) => (p.status === 'interference' ? 0 : p.status === 'too_tight' ? 1 : 2);
      const sorted = [...pairs].sort((a, b) => rank(a) - rank(b) || a.minDistance - b.minDistance);
      const CAP = 24;
      const shown = sorted.slice(0, CAP);
      const hidden = sorted.slice(CAP);
      const lines = [
        `Assembly ${value.overallStatus}: ${value.parts.length} parts, ${pairs.length} pairs ` +
          `at a ${state.thresholdMm}mm clearance threshold — ${clash} interference, ${tight} too tight.`,
        `"interference" = the solids overlap; "too tight" = gap below ${state.thresholdMm}mm; "ok" = gap at or above it ` +
          '(the threshold is your choice, not a design fact — pass clearanceThreshold to change it).',
        ...shown.map((p) => `  ${p.status === 'interference'
          ? `INTERFERENCE ${p.partA}↔${p.partB} ${p.intersectionVolume.toFixed(2)}mm³`
          : `${p.minDistance.toFixed(3)}mm ${p.partA}↔${p.partB}${p.status === 'too_tight' ? ' (too tight)' : ''}`}`),
        ...(hidden.length
          ? [`  … and ${hidden.length} more pair(s), all with a gap ≥ ${hidden[0]!.minDistance.toFixed(3)}mm`]
          : []),
        (state.refs.length
          ? `Attached views of the whole assembly in order: ${state.refs.map((r) => r.view).join(', ')}. Look at these before trusting a shape.`
          : 'Assembly render unavailable (OpenSCAD/display) — numbers only.'),
        `Full pair list: runs/${state.runId}/report.json (run ${state.runId}).`,
        // Delivery gate, stated where delivery is being decided: green numbers
        // are two of the three claims; eyes and printability are the other two.
        '交付前纪律：绿色数字 ≠ 设计完成 — 必须看过装配渲染图（本条附带的图片），并对每个零件跑过 check_printability，才能宣布设计完成。',
      ];
      const blocks: unknown[] = [{ type: 'text', text: lines.join('\n') }];
      for (const r of state.refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  /** Shared by the simulate_physics tool and POST /api/cad/physics/run (docs/archive/M4-PREP.md §4.6 path ②). */
  async function runPhysicsJob(a: PhysicsToolArgs, project: ProjectStores) {
      const { runStore } = project;
      if (!Array.isArray(a.parts) || a.parts.length < 1) throw argError('simulate_physics', 'parts', 'needs at least 1 part', 'an array of { name, versionId } plus the body settings',
          { example: 'simulate_physics({ parts: [{ name: "a", versionId: "v001" }] })', received: a?.parts });
      assertPartNames(a.parts, 'simulate_physics');

      const parts: PhysicsPartInput[] = [];
      const stlFiles: { name: string; stlPath: string }[] = [];
      const usedVersions: (string | null)[] = [];
      const geometries: { name: string; stl: Uint8Array }[] = [];

      const sceneSolids: SceneSolid[] = [];
      for (const p of a.parts) {
        const g = await resolvePartGeometry(p, project);
        usedVersions.push(g.versionId);
        geometries.push({ name: p.name, stl: g.stl });
        // Same sanity pass as motion, same criterion (gap ÷ the part's own size):
        // a body dropped 500mm from everything gives "settled penetration 0" for
        // exactly the same empty reason a parked motion part does.
        sceneSolids.push({
          name: p.name,
          triangles: Math.round(parseBinaryStl(g.stl).triVerts.length / 3),
          ...transformedAabb(
            boundingBoxOf(parseBinaryStl(g.stl)),
            p.position as [number, number, number],
            p.rotation as [number, number, number] | undefined,
          ),
        });
        parts.push({
          name: p.name,
          stl: g.stl,
          bodyType: p.bodyType === 'fixed' ? 'fixed' : 'dynamic',
          position: p.position as [number, number, number],
          rotation: p.rotation as [number, number, number] | undefined,
          density: p.density,
          initialAngularVelocity: p.initialAngularVelocity as [number, number, number] | undefined,
        });
      }
      const sourceVersionIds = collectVersions(usedVersions);
      for (const solid of sceneSolids) {
        solid.connected = (a.joints ?? []).some((j) => j.bodyA === solid.name || j.bodyB === solid.name);
      }
      const suspectList = suspectParts(sceneSolids);
      const suspectLines = formatSuspects(suspectList);
      const warnCountPhys = suspectList.filter((x) => x.warn).length;
      const suspectWarnPhys = warnCountPhys > 0;

      const run = await beginRun(runStore, {
        kind: 'physics',
        title: runSubject('physics', geometries.map((g) => g.name), sourceVersionIds)
          ?? `刚体物理 · ${provenanceLabel(sourceVersionIds)}`,
      });
      for (const g of geometries) {
        await run.part(g.name, g.stl);
        stlFiles.push({ name: g.name, stlPath: join(run.dir, 'parts', `${g.name}.stl`) });
      }

      // Slope scenario without hand-computing a gravity vector: PROJECT.md had
      // to teach the agent `[9810·sin5°, 0, −9810·cos5°]`. Explicit gravity
      // still wins when given.
      let gravity = a.gravity as [number, number, number] | undefined;
      if (!gravity && typeof a.tiltDeg === 'number' && a.tiltDeg !== 0) {
        const th = (a.tiltDeg * Math.PI) / 180;
        const ax = (a.tiltAboutAxis ?? [0, 1, 0]) as [number, number, number];
        const alen = Math.hypot(...ax) || 1;
        const [ux, uy, uz] = ax.map((x) => x / alen);
        const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
        const rot = (v: [number, number, number]): [number, number, number] => [
          c * v[0] + C * ux * (ux * v[0] + uy * v[1] + uz * v[2]) + s * (uy * v[2] - uz * v[1]),
          c * v[1] + C * uy * (ux * v[0] + uy * v[1] + uz * v[2]) + s * (uz * v[0] - ux * v[2]),
          c * v[2] + C * uz * (ux * v[0] + uy * v[1] + uz * v[2]) + s * (ux * v[1] - uy * v[0]),
        ];
        gravity = rot([0, 0, -9810]);
      }
      const report = await runPhysics({
        parts,
        joints: a.joints as never,
        durationSec: a.durationSec,
        gravity,
        keyframeCount: 6,
      });
      // Render keyframes and persist the newest 4 as model-visible attachments.
      const { frames, warnings: renderWarnings } = await renderKeyframes(report, stlFiles, join(run.dir, 'frames'));
      if (renderWarnings.length > 0) {
        report.metrics.jointViolations.push(...renderWarnings.slice(0, 3).map((w) => `render: ${w}`));
      }
      const keep = frames.slice(0, 4);
      const refs: { view: string; ref: unknown }[] = [];
      try {
        for (const f of keep) {
          const [ref] = await ctx.attachments.saveImages([{ data: f.png, mediaType: 'image/png', name: `physics-${f.view}` }]);
          if (ref) refs.push({ view: f.view, ref });
        }
      } catch (e) {
        report.metrics.jointViolations.push(`attachment save failed: ${String((e as Error).message)}`);
      }

      report.metrics.geometrySuspects = suspectLines;
      report.metrics.geometrySuspectRule = SUSPECT_RULE;
      report.metrics.geometrySuspectWarn = warnCountPhys;
      await run.json('report.json', report);
      await run.json('trajectory.json', { kind: 'physics', durationSec: report.durationSec, trajectory: report.trajectory });
      const svg = report.metrics;
      const sank = svg.settledPenetrationMm > 1;
      const fellNames = Object.entries(svg.fellOver).filter(([, v]) => v === true).map(([n]) => n);
      const overall: RunStatus = sank || fellNames.length > 0 || svg.jointViolations.length > 0 || suspectWarnPhys ? 'check' : 'pass';
      await run.commit({
        title: runSubject('physics', geometries.map((g) => g.name), sourceVersionIds)
          ?? `刚体物理 · ${provenanceLabel(sourceVersionIds)}`,
        sourceVersionIds,
        status: overall,
        // Physics has no "excluded" case (a topple is not a contract violation),
        // but nothing here is a clean bill either: every warning is `difficult`.
        judgement: overall === 'check' ? 'difficult' : 'not-excluded',
        summary: `稳态穿透 ${svg.settledPenetrationMm.toFixed(2)}mm` +
          (fellNames.length ? ` · 倒下 ${fellNames.join(',')}` : '') +
          (svg.jointViolations.length ? ` · 约束异常 ${svg.jointViolations.length}` : '') +
          (suspectWarnPhys ? ` · ⚠ 几何疑点 ${warnCountPhys}` : ''),
      });

      const result = {
        overallStatus: overall,
        settledPenetrationMm: svg.settledPenetrationMm,
        maxPenetrationMm: svg.maxPenetrationMm,
        fellOver: svg.fellOver,
        jointViolations: svg.jointViolations,
        ...(svg.holdAnalysis ? { holdAnalysis: svg.holdAnalysis } : {}),
        notes: svg.notes,
        geometrySuspects: suspectLines,
        geometrySuspectRule: SUSPECT_RULE,
        keyframes: keep.map((f) => f.view),
      };
      physicsResultForFinalize = { refs, overall: result.overallStatus };
      return result;
  }

  // --- simulate_physics: rigid-body drop/swing/topple validation ---
  registerTool(defineTool({
    name: 'simulate_physics',
    description:
      'Rigid-body simulation (rapier, z-up, millimetres) over discrete parts: settled penetration, toppling, joint violations, drift, plus keyframe images. Joints may be revolute (hinge) or prismatic (slide). Start parts slightly separated — gravity closes the gap.',
    parameters: {
      parts: {
        type: 'array',
        required: true,
        description: 'Parts in the scene.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Unique part name.' },
            scadCode: { type: 'string', description: 'Complete OpenSCAD source for this part. Give this OR versionId.' },
            versionId: { type: 'string', description: 'Use a saved version\'s model.stl as this part\'s geometry (records provenance: the run then lists that version as its source). Overrides scadCode.' },
            bodyType: { type: 'string', required: true, enum: ['dynamic', 'fixed'], description: '"dynamic" (moves) or "fixed" (immovable boundary).' },
            position: {
              type: 'array', required: true,
              description: 'Initial position [x,y,z] mm. For a fixed ground plate remember cube(..., center=true) vs corner-origin.',
              items: { type: 'number' },
            },
            rotation: { type: 'array', description: 'Initial rotation [rx,ry,rz] degrees XYZ.', items: { type: 'number' } },
            density: { type: 'number', description: 'kg/mm³. Default 1.05e-6 (ABS plastic).' },
            initialAngularVelocity: { type: 'array', description: 'rad/s, e.g. a push on a hinged door.', items: { type: 'number' } },
          },
        },
      },
      joints: {
        type: 'array',
        description: 'Joints between parts: "revolute" (hinge) or "prismatic" (slide).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', description: '"revolute" (hinge, default) or "prismatic" (slide along the axis).' },
            bodyA: { type: 'string', required: true },
            bodyB: { type: 'string', required: true },
            anchorA: { type: 'array', required: true, description: 'Joint point in A local frame [x,y,z] mm.', items: { type: 'number' } },
            anchorB: { type: 'array', required: true, description: 'Joint point in B local frame [x,y,z] mm.', items: { type: 'number' } },
            axis: { type: 'array', required: true, description: 'Hinge/slide axis in local frames [x,y,z].', items: { type: 'number' } },
            limits: { type: 'array', description: 'prismatic only: allowed travel [min,max] mm along the axis.', items: { type: 'number' } },
            staticFriction: {
              type: 'number',
              description: 'prismatic only: static friction μ. Adds a quasi-static hold analysis (μ·m·|g⊥| vs m·|g∥| → holds/slides) to the report — rapier joints carry no friction, so this is analytic, not simulated.',
            },
          },
        },
      },
      durationSec: { type: 'number', description: 'Simulation length. Default 2.' },
      gravity: { type: 'array', description: 'mm/s². Default [0,0,-9810] (z-up).' },
      tiltDeg: {
        type: 'number',
        description: 'Tilt gravity by this many degrees about tiltAboutAxis (default [0,1,0]) — the slope scenario without hand-computing the gravity vector. Ignored when gravity is given.',
      },
      tiltAboutAxis: { type: 'array', description: 'Axis to tilt about, default [0,1,0].', items: { type: 'number' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          overallStatus: { type: 'string', required: true },
          settledPenetrationMm: { type: 'number', required: true },
          geometrySuspects: {
            type: 'array', required: true, items: { type: 'string' },
            description: 'Parts far from everything BY THEIR OWN SIZE (gap ÷ bbox diagonal > 5) or simple box geometry (<= 24 triangles). A fact, not a verdict: status is unchanged. Empty is the normal case.',
          },
          geometrySuspectRule: { type: 'string', required: true, description: 'The rule applied to produce geometrySuspects, in words.' },
          maxPenetrationMm: { type: 'number', required: true },
          fellOver: { type: 'object', required: true, additionalProperties: true },
          jointViolations: { type: 'array', required: true, items: { type: 'string' } },
          holdAnalysis: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                joint: { type: 'string', required: true },
                mu: { type: 'number', required: true },
                massKg: { type: 'number', required: true },
                axialDriveN: { type: 'number', required: true },
                frictionCapN: { type: 'number', required: true },
                holds: { type: 'boolean', required: true },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
          keyframes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    timeoutMs: 300_000,
    async execute(args: unknown, exec: unknown) {
      return runPhysicsJob(args as PhysicsToolArgs, await allStores(exec));
    },
    finalizeContent(_exec, result) {
      const value = (result as {
        value?: {
          overallStatus: string;
          settledPenetrationMm: number;
          maxPenetrationMm: number;
          fellOver: Record<string, boolean>;
          jointViolations: string[];
          holdAnalysis?: { joint: string; holds: boolean; mu: number; axialDriveN: number; frictionCapN: number }[];
          notes?: string[];
          keyframes: string[];
        };
      }).value;
      if (!value || !physicsResultForFinalize) return undefined;
      const { refs, overall } = physicsResultForFinalize;
      physicsResultForFinalize = null;
      // Same reason as simulate_motion: the penetration and topple numbers are
      // the result, and this finalizer is the last place they can reach the
      // model. Dropping them made every stability run cost an extra disk read.
      const fell = Object.entries(value.fellOver ?? {});
      const holds = (value.holdAnalysis ?? []).map((h) =>
        `HOLD ${h.joint}: μ=${h.mu} → cap ${h.frictionCapN}N vs axial drive ${h.axialDriveN}N → ` +
        (h.holds ? 'HOLDS (self-locking, quasi-static estimate)' : 'SLIDES under gravity'),
      );
      const lines = [
        `Physics ${overall}. Settled penetration ${value.settledPenetrationMm}mm ` +
          `(max ${value.maxPenetrationMm}mm).`,
        ...(fell.length
          ? fell.map(([name, over]) => `${name}: ${over ? 'FELL OVER' : 'stayed upright'}`)
          : ['No body tipped over.']),
        ...((value.jointViolations ?? []).length
          ? [`Joint violations: ${value.jointViolations.join('; ')}`]
          : []),
        ...holds,
        ...(((value as { geometrySuspects?: string[] }).geometrySuspects ?? []).length
          ? [`几何疑点（${(value as { geometrySuspectRule?: string }).geometrySuspectRule ?? ''}）：` +
             `${((value as { geometrySuspects?: string[] }).geometrySuspects ?? []).join('；')}`]
          : []),
        ...((value.notes ?? []).length ? ['Notes:', ...(value.notes ?? []).map((n) => `- ${n}`)] : []),
        `Attached keyframes in order: ${refs.map((r) => r.view).join(', ') || 'none'}.`,
        'Inspect the motion: does the part rest stably? does the hinge stay anchored?',
      ];
      const blocks: unknown[] = [{ type: 'text', text: lines.join('\n') }];
      for (const r of refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  /** Shared by the simulate_fluid tool, the panel preset button and POST /api/cad/fluid/run. */
  interface FluidToolArgs {
    pipeScad?: string;
    versionId?: string;
    fluidRegionMm?: { min: number[]; max: number[] };
    inletBandMm?: [number, number];
    inletVelocityMmPerSec?: number;
    outletPlaneMm?: number;
    dxMm?: number;
    particlesPerCell?: number;
    particleCount?: number;
    steps?: number;
    gravityMmPerSec2?: number[];
  }

  async function runFluidJob(a: FluidToolArgs, project: ProjectStores) {
    const { store, runStore } = project;
    let pipeStl: Uint8Array;
    if (a.versionId) {
      pipeStl = new Uint8Array(await readFile(join(store.root, 'versions', a.versionId, 'model.stl')));
    } else if (a.pipeScad) {
      const c = await compileStlOnly(a.pipeScad);
      if (!c.success || !c.stl) throw new Error(`pipe compile failed: ${c.errors.join('; ')}`);
      pipeStl = c.stl;
    } else {
      throw new Error('simulate_fluid needs pipeScad or versionId');
    }
    const sourceVersionIds = a.versionId ? [a.versionId] : [];

    const preset = deriveFluidPreset(pipeStl, a.dxMm ?? 2, a.inletVelocityMmPerSec ?? 100);
    const { report, sdf } = await runFluid({
      pipeStl,
      gridCells: preset.gridCells,
      gridOriginMm: preset.gridOriginMm,
      dxMm: preset.dxMm,
      fluidRegionMm: a.fluidRegionMm
        ? { min: a.fluidRegionMm.min as [number, number, number], max: a.fluidRegionMm.max as [number, number, number] }
        : preset.fluidRegionMm,
      inlet: {
        axis: preset.axis,
        bandMm: a.inletBandMm ?? preset.inletBandMm,
        velocityMmPerSec: a.inletVelocityMmPerSec ?? 100,
      },
      outletPlaneMm: a.outletPlaneMm ?? preset.outletPlaneMm,
      particlesPerCell: a.particlesPerCell,
      particleCount: a.particleCount,
      steps: a.steps ?? preset.steps,
      gravityMmPerSec2: a.gravityMmPerSec2 as [number, number, number] | undefined,
      snapshotCount: 8,
    });

    // render snapshot PNGs + playback frames into the run's own directory
    const run = await beginRun(runStore, {
      kind: 'fluid',
      title: `流体仿真 · ${provenanceLabel(sourceVersionIds)}`,
    });
    await run.part('wall', pipeStl);
    const wallVerts = parseBinaryStl(pipeStl).vertProperties;
    const bounds = gridBounds(preset.gridCells, preset.gridOriginMm, preset.dxMm);
    const frames: { view: string; png: Uint8Array; path: string }[] = [];
    const manifest = {
      particleCount0: report.metrics.particleCount0,
      dxMm: preset.dxMm,
      boundsMm: bounds,
      vmaxMmPerSec: Math.max(report.metrics.maxVelocityMmPerSec, 1),
      versionId: a.versionId ?? null,
      frames: [] as { step: number; timeSec: number; particles: number; file: string }[],
    };
    for (const snap of report.snapshots) {
      const png = renderFluidSnapshot(snap.posMm, snap.speedMmPerSec, {
        boundsMm: bounds,
        wallVertsMm: wallVerts,
        vmaxMmPerSec: Math.max(report.metrics.maxVelocityMmPerSec, 1),
      });
      const pngName = `fluid_${String(snap.step).padStart(6, '0')}.png`;
      await run.frame(pngName, png);
      frames.push({ view: `t${snap.timeSec}s`, png, path: join(run.dir, 'frames', pngName) });

      // playback frame: Float32 pos[3N] ++ speed[N] (16 bytes/particle)
      const n = snap.speedMmPerSec.length;
      const bin = new Float32Array(4 * n);
      bin.set(snap.posMm, 0);
      bin.set(snap.speedMmPerSec, 3 * n);
      const file = `frame_${String(snap.step).padStart(6, '0')}.bin`;
      await run.frame(file, Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
      manifest.frames.push({ step: snap.step, timeSec: snap.timeSec, particles: n, file });
    }
    await run.json('fluid-manifest.json', manifest);

    const { snapshots, ...reportSlim } = report;
    void snapshots;
    await run.json('report.json', { ...reportSlim, frames: frames.map((f) => f.path) });

    const m = report.metrics;
    await run.commit({
      title: `流体仿真 · ${provenanceLabel(sourceVersionIds)}`,
      sourceVersionIds,
      status: report.overallStatus === 'pass' ? 'pass' : 'check',
      summary: `到达率 ${m.outletArrivalRatio ?? '—'} · 穿透 ${m.penetrationCount ?? '—'} · 粒子 ${m.particleCount0 ?? '—'}`
        + ((m.seedStats?.stacksPerSeed ?? 1) > 1.5 ? ` · ⚠ 粒子堆叠 ×${m.seedStats!.stacksPerSeed}` : ''),
    });

    const keep = frames.slice(-2);
    const refs: { view: string; ref: unknown }[] = [];
    try {
      for (const f of keep) {
        const [ref] = await ctx.attachments.saveImages([{ data: f.png, mediaType: 'image/png', name: `fluid-${f.view}` }]);
        if (ref) refs.push({ view: f.view, ref });
      }
    } catch (e) {
      console.warn('[cad-harness] fluid attachment save failed:', String((e as Error).message));
    }
    fluidRefsForFinalize = { refs };

    return {
      overallStatus: report.overallStatus,
      metrics: report.metrics,
      frames: frames.map((f) => f.path),
    };
  }

  // --- simulate_motion: mechanism kinematics + motion interference (M3.6) ---
  registerTool(defineTool({
    name: 'simulate_motion',
    description:
      'Assembled-mechanism kinematics: a constant-speed crank AND/OR prescribed sinusoidal movers (no crank is required when every mover is an oscillator), revolute/prismatic followers, optionally parts on prescribed sinusoidal paths. Returns stroke/period, an exact interference timeline at >=24 sampled poses per run (final pose included; fewer means check, never pass), joint anchor drift, keyframes. Gravity is off.',
    parameters: {
      parts: {
        type: 'array',
        required: true,
        description: 'Parts of the mechanism. The crank should be bodyType "kinematic".',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Unique part name.' },
            scadCode: { type: 'string', description: 'Complete OpenSCAD source for this part. Give this OR versionId.' },
            versionId: { type: 'string', description: 'Use a saved version\'s model.stl as this part\'s geometry (records provenance: the run then lists that version as its source). Overrides scadCode.' },
            bodyType: { type: 'string', required: true, enum: ['dynamic', 'fixed', 'kinematic'], description: '"dynamic" (follows joints), "fixed" (frame), or "kinematic" (driven/prescribed).' },
            position: { type: 'array', required: true, description: 'Initial position [x,y,z] mm.', items: { type: 'number' } },
            rotation: { type: 'array', description: 'Initial rotation [rx,ry,rz] degrees XYZ.', items: { type: 'number' } },
            pivot: { type: 'array', description: 'Point the body turns/slides about, in the part\'s own file frame [x,y,z] mm. Default: the anchor of the first joint naming this part (its axis), else the geometry centre. Geometry is re-based on it automatically — set it explicitly only when the rotation axis passes through neither.', items: { type: 'number' } },
          },
        },
      },
      joints: {
        type: 'array',
        required: true,
        description: 'Joints between parts.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, description: '"revolute" (hinge) or "prismatic" (slide).' },
            bodyA: { type: 'string', required: true },
            bodyB: { type: 'string', required: true },
            anchorA: { type: 'array', required: true, description: 'Joint anchor in A local frame [x,y,z] mm.', items: { type: 'number' } },
            anchorB: { type: 'array', required: true, description: 'Joint anchor in B local frame [x,y,z] mm.', items: { type: 'number' } },
            axis: { type: 'array', required: true, description: 'Rotation/slide axis [x,y,z].', items: { type: 'number' } },
            limits: { type: 'array', description: 'Prismatic travel limits [min,max] mm.', items: { type: 'number' } },
          },
        },
      },
      drive: {
        type: 'object',
        // OPTIONAL (2026-10-28). A crank is one way to make a mechanism move, not a
        // precondition for measuring one: a guide/valve on a prescribed sinusoid has
        // NO crank, and demanding one forced authors to park a dummy crank+base far
        // outside the assembly just to pass validation (fructose-molecule r013: two
        // 12-triangle cubes at (500,500), and an "interference 0" that could never
        // have been anything else). When drive is absent the time base is the
        // oscillator period, and the report says driveOmegaRadPerSec: null.
        description: 'The constant-speed crank drive. Omit it when every mover is a prescribed oscillator (' +
          'a guide/valve following a sinusoid): the time base is then the oscillator period. A run with neither ' +
          'a drive nor an oscillator is refused — nothing would move.',
        additionalProperties: false,
        properties: {
          body: { type: 'string', required: true, description: 'Name of the driven (kinematic) part.' },
          axis: { type: 'array', required: true, description: 'Rotation axis [x,y,z].', items: { type: 'number' } },
          omegaRadPerSec: { type: 'number', required: true, description: 'Angular speed rad/s.' },
        },
      },
      oscillators: {
        type: 'array',
        description: 'Prescribed sinusoidal movers (valves). bodyType must be "kinematic".',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            body: { type: 'string', required: true },
            axis: { type: 'array', required: true, description: 'Translation direction [x,y,z].', items: { type: 'number' } },
            amplitudeMm: { type: 'number', description: 'Sinusoidal mode: peak deviation from the initial position, mm.' },
            periodSec: { type: 'number', description: 'Sinusoidal mode: full oscillation period, s. Use 2× crank period for four-stroke valves.' },
            phaseRad: { type: 'number', description: 'Phase offset, rad. Default 0.' },
            pitchRadiusMm: { type: 'number', description: 'RACK & PINION mode: travel per radian of drive rotation (= the pitch radius, mm). Displacement = pitchRadiusMm × ω × t, so the rack stays in ratio with the driven pinion; negative reverses direction. Requires a drive. Do NOT approximate a rack with a sinusoid — it drifts out of ratio and the teeth gnash by construction.' },
          },
        },
      },
      cycles: {
        type: 'number',
        description: 'Drive cycles to simulate. Default 2. FRACTIONAL values are meaningful and are honoured: ' +
          'a balance whose design range is ±14° sweeps 0.078 of a turn, and asking for a whole turn instead ' +
          'answers a different question (the beam becomes a windmill and every part of it collides).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          overallStatus: { type: 'string', required: true },
          followers: { type: 'object', required: true, additionalProperties: true },
          interferenceCount: { type: 'integer', required: true },
          interferenceEvents: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          interferenceChecks: { type: 'integer', required: true, description: 'Sampled poses actually boolean-tested. 0 means no interference check was performed.' },
          candidatePairs: { type: 'integer', required: true },
          interferencePairChecks: { type: 'integer', required: true, description: 'interferenceChecks × candidatePairs.' },
          samplingSatisfied: { type: 'boolean', required: true, description: 'false when fewer than 24 poses could be sampled; the run is then check, never pass.' },
          maxSampleGapDeg: { type: 'number', description: 'Largest crank rotation between samples (null without a drive).' },
          blocking: { type: 'array', items: { type: 'string' }, description: 'Present (and run status = fail) when ANY interference occurred: partA↔partB, volume, time.' },
          deliverability: { type: 'string', description: 'Present only when blocking: why this mechanism is not deliverable and the two ways out.' },
          maxJointDriftMm: { type: 'number', required: true },
          geometrySuspects: {
            type: 'array', required: true, items: { type: 'string' },
            description: 'Parts that are far from everything BY THEIR OWN SIZE (gap ÷ bbox diagonal > 5) or are placeholder geometry (<= 24 triangles). A fact, not a verdict: status is unchanged. Each line carries the numbers behind it.',
          },
          geometrySuspectRule: { type: 'string', required: true, description: 'The rule applied to produce geometrySuspects, in words.' },
          hasCrank: {
            type: 'boolean', required: true,
            description: 'false when the run has no crank — every mover follows a prescribed path (oscillators). Read this before quoting a period.',
          },
          initialJointGaps: {
            type: 'array', required: true,
            description: 'Per joint: the anchor gap measured in the STARTING pose, before the first step. The run refuses a gap over the tolerance; this is how close the accepted ones were (margin, not just a pass/fail).',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                joint: { type: 'string', required: true },
                gapMm: { type: 'number', required: true },
              },
            },
          },
          jointToleranceMm: { type: 'number', required: true, description: 'The tolerance the starting gaps were judged against.' },
          jointViolations: { type: 'array', required: true, items: { type: 'string' } },
          pivots: { type: 'object', required: true, additionalProperties: true, description: 'Per part: the point its body rotates/slides about, in the part\'s own file frame. Geometry is re-based on it before the run.' },
          keyframes: { type: 'array', required: true, items: { type: 'string' } },
          stepsRun: { type: 'integer', required: true },
          durationSec: { type: 'number', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 300_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as Parameters<typeof runMotionJob>[0];
      if (!Array.isArray(a.parts) || a.parts.length < 2) throw argError('simulate_motion', 'parts', 'needs at least 2 parts', 'an array of { name, versionId } — a mechanism has at least two bodies',
          { example: 'simulate_motion({ parts: […], joints: […], drive: {…} })', received: a?.parts });
      // A drive is one kind of mover, not a requirement. What IS required is that
      // something moves: a kinematics run of nothing but fixed parts answers nothing.
      if (!a.drive && !(Array.isArray(a.oscillators) && a.oscillators.length > 0)) {
        throw argError('simulate_motion', 'drive',
          'is absent and no oscillator is given — nothing would move',
          'either a crank drive {body, axis, omegaRadPerSec}, or oscillators [{body, axis, periodSec, amplitudeMm}] ' +
          '(a guide/valve on a prescribed path has no crank). The time base is then the oscillator period',
          { received: { drive: a?.drive, oscillators: a?.oscillators } });
      }
      const result = await runMotionJob(a, await allStores(exec));
      motionRefsForFinalize = motionRefsForFinalize ?? { refs: [] };
      return result;
    },
    finalizeContent(_exec, result) {
      const value = (result as {
        value?: {
          overallStatus: string;
          followers: Record<string, { travelMm: number; axis: string; periodSec: number | null }>;
          interferenceCount: number;
          interferenceEvents: { timeSec: number; partA: string; partB: string; volumeMm3: number; label?: string }[];
          interferenceChecks: number;
          candidatePairs: number;
          interferencePairChecks: number;
          samplingSatisfied: boolean;
          maxSampleGapDeg?: number;
          maxJointDriftMm: number;
          jointViolations: string[];
          pivots: Record<string, number[]>;
          keyframes: string[];
          stepsRun: number;
          durationSec: number;
          geometrySuspects?: string[];
          geometrySuspectRule?: string;
        };
      }).value;
      const state = motionRefsForFinalize;
      motionRefsForFinalize = null;
      if (!value || !state) return undefined;
      const pivots = Object.entries(value.pivots ?? {})
      // The numbers ARE the answer — the keyframes only say whether to believe
      // them. They used to be dropped here (this finalizer replaced the rendered
      // JSON with one prose line), which forced the model to leave the tool
      // result and go read runs/<id>/report.json off disk after every run.
      const followers = Object.entries(value.followers ?? {});
      const events = (value.interferenceEvents ?? []).slice(0, 5).map((e) =>
        `t=${e.timeSec.toFixed(3)}s ${e.partA}↔${e.partB}${e.volumeMm3 ? ` ${e.volumeMm3.toFixed(2)}mm³` : ''}${e.label ? ` (${e.label})` : ''}`);
      const more = (value.interferenceEvents?.length ?? 0) - events.length;
      const blockingEvents = (value as { blocking?: string[] }).blocking ?? [];
      const lines = [
        (blockingEvents.length
          ? `❌ NOT DELIVERABLE — parts overlap during motion. Fix the geometry to leave clearance, or declare the interface as intentional interference in the assembly contract.`
          : `Motion ${value.overallStatus}.`) + ` Ran ${value.stepsRun} steps / ${value.durationSec}s.`,
        `Interference: ${value.interferenceCount} event(s)` +
          (events.length ? ` — ${events.join('; ')}` : '') +
          (more > 0 ? ` (+${more} more in the run report)` : ''),
        `Sampling: ${value.interferenceChecks ?? 0}/24 poses × ${value.candidatePairs ?? 0} candidate pair(s)` +
          ` = ${value.interferencePairChecks ?? 0} interference checks` +
          (typeof value.maxSampleGapDeg === 'number' ? ` · max gap ${value.maxSampleGapDeg}°` : '') +
          (value.samplingSatisfied === true
            ? ''
            : ' — INSUFFICIENT: too little travel to sample 24 poses; "0 interference" is NOT evidence.'),
        ...(value.geometrySuspects?.length
          ? [`几何疑点（${value.geometrySuspectRule}）：${value.geometrySuspects.join('；')}`]
          : []),
        `Max joint drift: ${value.maxJointDriftMm}mm` +
          ((value.jointViolations ?? []).length ? ` — VIOLATIONS: ${value.jointViolations.join('; ')}` : '.') +
          (pivots.length ? ` Rotation/slide pivots (part file frame): ${pivots.map(([n, p]) => `${n}[${(p as number[]).join(',')}]`).join(' ')}` : ''),
        ...followers.map(([name, f]) =>
          `${name}: travel ${typeof f.travelMm === 'number' ? f.travelMm.toFixed(3) : '—'}mm on ${f.axis}` +
          (f.periodSec ? `, period ${f.periodSec.toFixed(3)}s` : '')),
        `Attached keyframes in order: ${state.refs.map((r) => r.view).join(', ') || 'none'}.`,
        'Read the interference timeline as the jamming test, not a single keyframe.',
      ];
      const blocks: unknown[] = [{ type: 'text', text: lines.join('\n') }];
      for (const r of state.refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  // --- simulate_fluid: MPM through-flow validation (M4) ---
  registerTool(defineTool({
    name: 'simulate_fluid',
    description:
      'MPM (CPU) flow through a pipe or part cavity: arrival, section velocities, conservation, snapshots. The solid boundary stays fixed for the whole run.',
    parameters: {
      pipeScad: {
        type: 'string',
        required: true,
        description: 'Complete OpenSCAD source of the pipe/cavity (the SOLID; the fluid flows through its bore). Self-contained, $fn=48+.',
      },
      fluidRegionMm: {
        type: 'object',
        description: 'Particle seed box {min:[x,y,z], max:[x,y,z]} in mm. Default: derived from the pipe (30% of the length at the inlet end, 3mm wall clearance).',
        additionalProperties: false,
        properties: {
          min: { type: 'array', required: true, items: { type: 'number' } },
          max: { type: 'array', required: true, items: { type: 'number' } },
        },
      },
      inletVelocityMmPerSec: { type: 'number', description: 'Inlet axial speed. Default 100 mm/s.' },
      particleCount: { type: 'number', description: 'Explicit particle count. Default auto (4-8 particles/cell, typically 50k-300k).' },
      particlesPerCell: { type: 'number', description: 'Seed density (sweet spot 4-8). Default 6.' },
      steps: { type: 'number', description: 'Simulation steps (dt=4ms). Default derived from travel time ×1.6, min 600.' },
      gravityMmPerSec2: { type: 'array', description: 'Gravity [x,y,z] mm/s². Default [0,0,-98.1]; use [0,0,0] for pure driven flow.', items: { type: 'number' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          overallStatus: { type: 'string', required: true },
          metrics: { type: 'object', required: true, additionalProperties: true },
          frames: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 300_000,
    async execute(args: unknown, exec: unknown) {
      const result = await runFluidJob(args as FluidToolArgs, await allStores(exec));
      fluidRefsForFinalize = fluidRefsForFinalize ?? { refs: [] };
      return { overallStatus: result.overallStatus, metrics: result.metrics, frames: result.frames };
    },
    finalizeContent(_exec, result) {
      const value = (result as {
        value?: {
          overallStatus: string;
          metrics: Record<string, unknown>;
          frames: string[];
        };
      }).value;
      const state = fluidRefsForFinalize;
      fluidRefsForFinalize = null;
      if (!value || !state) return undefined;
      // Same defect as the other two simulators: the metrics are the answer and
      // this finalizer is their last chance to reach the model.
      const m = (value.metrics ?? {}) as Record<string, unknown>;
      const num = (k: string): string =>
        typeof m[k] === 'number' ? (m[k] as number).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : '—';
      const lines = [
        `Fluid ${value.overallStatus}${m.diverged === true ? ' (DIVERGED)' : ''}. ` +
          `Ran ${num('stepsRun')} steps; snapshots kept: ${(value.frames ?? []).length}.`,
        `Outlet arrival ratio ${num('outletArrivalRatio')} · penetration ${num('penetrationCount')} · ` +
          `particles ${num('particleCount0')} · escaped ${num('escaped')} · active ${num('active')} · ` +
          `max speed ${num('maxVelocityMmPerSec')}mm/s · avg ${num('avgVelocityMmPerSec')}mm/s · ` +
          `mass error ${num('massConservationError')} · ` +
          `time to outlet ${m.timeToOutletSteps === null ? 'never' : `${num('timeToOutletSteps')} steps`}`,
        `Attached snapshots (newest last): ${state.refs.map((r) => r.view).join(', ') || 'none'}.`,
        'Check: did the fluid reach the outlet, stay inside the bore, and keep a sensible speed profile?',
      ];
      const blocks: unknown[] = [{ type: 'text', text: lines.join('\n') }];
      for (const r of state.refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  // --- simulate_lbm: XLB lattice-Boltzmann channel template (CFD lane stage A, 2026-10-15) ---
  registerTool(defineTool({
    name: 'simulate_lbm',
    description:
      'Lattice-Boltzmann channel flow (XLB, CPU): developed velocity profile vs the Poiseuille parabola, mirror symmetry and stability at a chosen Reynolds number. Stage-A template — the domain is a rectangular channel with box walls; no embedded solids, no heat, single phase.',
    parameters: {
      cells: {
        type: 'array',
        description: 'Lattice resolution [nx,ny,nz]; nx is the flow direction. Default [48,24,24]. Keep the product ≤ ~200k on CPU; runtime is linear in steps×cells.',
        items: { type: 'number' },
      },
      reynolds: {
        type: 'number',
        description: 'Channel Reynolds number based on (ny-1) cells. Default 100. Development length grows ~with Re — raise steps together with Re.',
      },
      latticeVelocity: {
        type: 'number',
        description: 'Inlet speed in lattice units. Default 0.05; keep ≤0.1 (weakly compressible LBM).',
      },
      steps: {
        type: 'number',
        description: 'Time steps. Default 20000 (≈75% developed on the default grid); quote numbers only near the developed end.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          overallStatus: { type: 'string', required: true },
          metrics: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 300_000,
    async execute(args: unknown) {
      const a = args as { cells?: number[]; reynolds?: number; latticeVelocity?: number; steps?: number };
      const result = await (await ensurePythonWorker()).request<Record<string, unknown>>('lbm_channel', {
        gridShape: a.cells ?? [48, 24, 24],
        reynolds: a.reynolds ?? 100,
        latticeVelocity: a.latticeVelocity ?? 0.05,
        steps: a.steps ?? 20000,
      });
      const latticeVelocity = Number(result.latticeVelocity) || 0.05;
      const peakRatio = (Number(result.peakUx) || 0) / (1.5 * latticeVelocity);
      const overallStatus = result.stable !== true
        ? 'diverged'
        : peakRatio >= 0.9
          ? 'developed'
          : peakRatio >= 0.6
            ? 'developing'
            : 'underdeveloped';
      return { overallStatus, metrics: result as unknown as { [key: string]: Json } };
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: { overallStatus: string; metrics: Record<string, unknown> } }).value;
      if (!value) return undefined;
      const m = value.metrics as Record<string, unknown>;
      const n = (k: string): string => {
        const v = m[k];
        return typeof v === 'number' ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : '—';
      };
      const latticeVelocity = Number(m.latticeVelocity ?? 0.05);
      const theory = 1.5 * latticeVelocity;
      const ratio = (Number(m.peakUx) || 0) / theory;
      const lines = [
        `LBM channel ${value.overallStatus}. ${n('steps')} steps on ${JSON.stringify(m.grid)} lattice (${n('msPerStep')} ms/step, Re ${n('reynolds')}).`,
        `Centerline peak ${n('peakUx')} of ${theory.toFixed(4)} theoretical (ratio ${ratio.toFixed(2)}) · mirror symmetry ${(Number(m.mirrorError) * 100 || 0).toFixed(2)}% of peak · inlet ${n('inletUx')}.`,
        'Check: is the profile symmetric and developed enough for the question asked? Development length grows with Re — raise steps or the duct length before quoting numbers near the inlet.',
      ];
      return [{ type: 'text', text: lines.join('\n') }] as never;
    },
  }));

  // --- render_part: on-demand view with camera params (model-initiated) ---
  registerTool(defineTool({
    name: 'render_part',
    description:
      'One image of a saved version with explicit camera control: preset view, custom rotation, zoom, optional section cut. Sub-second, so request freely.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version to render, e.g. "v003".' },
      view: { type: 'string', description: 'Preset view: front | side | top | iso. Default iso.' },
      rotate: { type: 'array', description: 'Custom camera rotation [rx,ry,rz] degrees — overrides view.', items: { type: 'number' } },
      zoom: { type: 'number', description: 'Zoom over auto-fit: 2 = twice as close, 0.5 = further out. Default 1.' },
      imgSize: { type: 'integer', description: 'Image size in px (default 512).' },
      section: {
        type: 'object',
        description: 'Optional cross-section cut.',
        additionalProperties: false,
        properties: {
          axis: { type: 'string', required: true, description: 'x | y | z' },
          fraction: { type: 'number', required: true, description: 'Cut plane position as 0..1 fraction of the bounding box along the axis.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { versionId: { type: 'string', required: true }, label: { type: 'string', required: true }, file: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as RenderPartRequest & { versionId: string };
      const { store } = await allStores(exec);
      const { png, label } = await renderVersionFrame(store, a, `${Date.now()}`);
      // A bounded cache, not a growing pile in the version directory: each call used to
      // leave `versions/vNNN/inspect_<ts>.png` behind forever, and a version is supposed to
      // hold the artifacts of its own creation, not every look anybody took at it
      // (2026-10-23, E4 follow-up). Same version + same camera => same path, overwritten.
      const renderDir = join(store.root, 'render');
      await mkdir(renderDir, { recursive: true });
      const pngPath = join(renderDir, `${safeArtifactName(`${a.versionId}-${label}`) ?? `${a.versionId}-${label}`}.png`);
      await writeFile(pngPath, png);
      const [ref] = await ctx.attachments.saveImages([{ data: png, mediaType: 'image/png', name: `render-${a.versionId}` }]);
      pendingRenderRefs.set(`${a.versionId}:${label}`, [{ view: label, ref }]);
      finalizeOnce = { versionId: a.versionId, label, file: pngPath, refs: [{ view: label, ref }] };
      return { versionId: a.versionId, label, file: pngPath };
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: { versionId: string; label: string } }).value;
      if (!value || !finalizeOnce) return undefined;
      const { refs } = finalizeOnce;
      finalizeOnce = null;
      const blocks: unknown[] = [{
        type: 'text',
        text: `Render of ${value.versionId} — ${value.label}`,
      }];
      for (const r of refs) blocks.push({ type: 'image', attachment: r.ref });
      return blocks as never;
    },
  }));

  // --- attach_appearance: give a version a color/material sidecar ---
  registerTool(defineTool({
    name: 'attach_appearance',
    description:
      'Attach a self-contained GLB color/material design to a saved version as a sidecar. The version keeps model.stl as geometry truth; the GLB is stored as versions/<id>/appearance.glb + appearance.json for external viewers and future panel work. There is no Blender/bpy render path and the panel still previews STL. The GLB must be v2, contain at least one mesh and one material, and embed its buffers/images.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version to attach the appearance to, e.g. "v003".' },
      file: { type: 'string', required: true, description: 'Workspace path to a self-contained .glb (GLB v2, embedded buffers/images).' },
      note: { type: 'string', description: 'Optional human note recorded in appearance.json (e.g. "three-color panel").' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          file: { type: 'string', required: true, description: 'Stored path: versions/<id>/appearance.glb.' },
          sha256: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          materials: { type: 'array', items: { type: 'string' }, required: true },
          meshes: { type: 'integer', required: true },
          replaced: { type: 'boolean', required: true, description: 'True when an older appearance.glb was overwritten.' },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 30_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as { versionId?: string; file?: string; note?: string };
      if (!a.versionId?.trim()) {
        throw argError('attach_appearance', 'versionId', 'is required',
          'a saved version id, e.g. "v003"', { example: 'attach_appearance({versionId:"v003", file:"panel.glb"})' });
      }
      if (!a.file?.trim()) {
        throw argError('attach_appearance', 'file', 'is required',
          'a workspace path to a self-contained .glb',
          { example: 'attach_appearance({versionId:"v003", file:"panel.glb"})' });
      }
      const { store, cwd } = await allStores(exec);
      if (!(await versionExists(store, a.versionId))) {
        throw new Error(await versionNotFound(store, a.versionId));
      }
      const resolved = await resolveWorkspaceFile(a.file, cwd);
      if (!resolved.toLowerCase().endsWith('.glb')) {
        throw argError('attach_appearance', 'file', 'must be a .glb',
          'a self-contained GLB v2; convert .blend/.gltf to .glb first',
          { received: a.file, example: 'attach_appearance({versionId:"v003", file:"panel.glb"})' });
      }
      const { record, replaced } = await attachAppearance(store.root, a.versionId, resolved, {
        ...(a.note ? { note: a.note } : {}),
      });
      const result: {
        versionId: string;
        file: string;
        sha256: string;
        bytes: number;
        materials: string[];
        meshes: number;
        replaced: boolean;
        note?: string;
      } = {
        versionId: record.versionId,
        file: appearancePath(store.root, record.versionId),
        sha256: record.sha256,
        bytes: record.bytes,
        materials: record.materials,
        meshes: record.meshes,
        replaced,
      };
      if (record.note) result.note = record.note;
      return result;
    },
  }));

  // --- measure_part: exact geometry ground truth ---
  registerTool(defineTool({
    name: 'measure_part',
    description:
      'Whole-part ground truth in one call: bounding box (size AND min/max), volume, surface area, centre of ' +
      'mass, triangle count, watertightness, genus, and the mutually disconnected BODIES with each one\'s ' +
      'bbox (a part must be a single body). Pass `axis` (x|y|z, a leading "-" flips it) or `axisVector` for ' +
      'a non-principal direction and you also get the projection along it: min/max, size, centre and the two ' +
      'extremal VERTICES — the coordinates you would otherwise hunt for by hand, and a point ON the part to ' +
      'hand to another measurement. mm, z-up. For a per-feature extent (a cylinder\'s length, a hole\'s ' +
      'depth) use `list_features` instead. On an open / non-manifold mesh the mass properties are OMITTED ' +
      '(with a warning) rather than guessed, but the body count still comes back.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version, e.g. "v003".' },
      axis: { type: 'string', description: 'Optional. Project on x | y | z (a leading "-" flips it). For anything else use axisVector. Without either, only the axis-aligned bbox is reported.' },
      axisVector: { type: 'array', description: 'Optional projection axis [x,y,z] for a non-principal direction (a diagonal, a slanted boss); normalised internally.', items: { type: 'number' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          watertight: { type: 'boolean', required: true },
          triangles: { type: 'integer', required: true },
          // NOT required: on an open / non-manifold mesh these are refused rather
          // than guessed (a plausible volume for an open surface is a lie). The
          // body fields below stay required — they are meaningful either way.
          sizeMm: { type: 'array', items: { type: 'number' }, description: 'Bounding-box size [dx,dy,dz]. Absent when the mesh is not a valid manifold solid.' },
          bboxMinMm: { type: 'array', items: { type: 'number' } },
          bboxMaxMm: { type: 'array', items: { type: 'number' } },
          volumeMm3: { type: 'number' },
          surfaceAreaMm2: { type: 'number' },
          centerOfMassMm: { type: 'array', items: { type: 'number' } },
          genus: { type: 'integer' },
          bodies: { type: 'number', required: true, description: 'Mutually disconnected solids, by SHARED EDGE. >1 means this is not one solid: union the fragments, or model them as SEPARATE parts.' },
          bodySizes: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } }, description: 'Per body [dx,dy,dz] mm, largest first.' },
          bodyCenters: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } }, description: 'Per body bbox centre [x,y,z] mm.' },
          bodyVerdict: { type: 'string', required: true, description: '"single-body" | "multi-body".' },
          extent: {
            type: 'object', additionalProperties: false,
            description: 'Present only when axis/axisVector was given.',
            properties: {
              axisMm: { type: 'array', required: true, items: { type: 'number' } },
              source: { type: 'string', required: true },
              vertexCount: { type: 'number', required: true },
              minMm: { type: 'number', required: true, description: 'Smallest projection onto the axis.' },
              maxMm: { type: 'number', required: true },
              sizeMm: { type: 'number', required: true },
              centerMm: { type: 'number', required: true },
              minPointMm: { type: 'array', required: true, items: { type: 'number' }, description: 'The vertex at minMm.' },
              maxPointMm: { type: 'array', required: true, items: { type: 'number' }, description: 'The vertex at maxMm.' },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    // 2026-10-11: measure_extent and check_connectivity were merged INTO here.
    // All three answered "what IS this part" about the whole body: extent's
    // `asAxisAlignedMm` was already the bounding box this tool reports as `sizeMm`,
    // and connectivity's body count belongs to the same watertight/genus family.
    // Three entry points for one question is where "which of these do I call?"
    // comes from. The fields are a pure UNION — nothing changed meaning, extent's
    // axis simply became optional (absent = no projection block).
    async execute(args: unknown, exec: unknown) {
      const a = args as { versionId: string; axis?: string; axisVector?: number[] };
      const { store, runStore } = await allStores(exec);
      const modelPath = join(store.root, 'versions', a.versionId, 'model.stl');
      if (!existsSync(modelPath)) throw new Error(await versionNotFound(store, a.versionId));
      const worker = await ensurePythonWorker();
      // BODY COUNT FIRST, and never let a broken mesh hide it. This is the one
      // field that must survive an open/non-manifold model — it is precisely when
      // the mesh is broken that you need to know how many pieces there are. The
      // mass properties, by contrast, are REFUSED on such a mesh rather than
      // guessed (the measure op raises "not a valid manifold solid"; a plausible
      // volume for an open surface is worse than no volume). Hence the optional
      // fields in the schema: absent means "not obtainable", not "zero".
      const conn = await worker.request<ConnectivitySolve>('connectivity', { path: modelPath });
      let m: Awaited<ReturnType<typeof measureVersion>> | null = null;
      let massError: string | null = null;
      try {
        m = await measureVersion(store, a.versionId);
      } catch (e) {
        massError = (e as Error).message;
      }
      const size = (b: { min: number[]; max: number[] }) => b.max.map((n, i) => +(n - b.min[i]!).toFixed(2));
      const center = (b: { min: number[]; max: number[] }) => b.min.map((n, i) => +((n + b.max[i]!) / 2).toFixed(2));
      let extent: Omit<MeasureExtentSolve, 'asAxisAlignedMm' | 'warnings'> | undefined;
      if (m !== null && (a.axisVector !== undefined || a.axis !== undefined)) {
        const e = await worker.request<MeasureExtentSolve>('measure_extent', {
          path: modelPath,
          axis: a.axisVector ?? a.axis ?? 'z',
        });
        extent = {
          axisMm: e.axisMm, source: e.source, vertexCount: e.vertexCount,
          minMm: e.minMm, maxMm: e.maxMm, sizeMm: e.sizeMm, centerMm: e.centerMm,
          minPointMm: e.minPointMm, maxPointMm: e.maxPointMm,
        };
      }
      const warnings: string[] = [];
      if (massError !== null) {
        warnings.push(
          `volume / surface area / centre of mass / genus are OMITTED: the mesh is not a valid manifold ` +
          `solid (${massError}). Fix the mesh first — on an open surface those numbers would be fiction. ` +
          `The body count below is still meaningful.`,
        );
      }
      // Two strict manifold tests agree by construction on healthy meshes. If they
      // ever disagree, that disagreement IS the finding — report the conservative
      // value and say so, rather than picking one silently.
      if (m !== null && conn.watertight !== m.watertight) {
        warnings.push(
          `watertight disagrees between the strict manifold test (${conn.watertight}) and the measure op ` +
          `(${m.watertight}) — treat the part as NOT watertight and investigate the mesh`,
        );
      }
      return {
        versionId: a.versionId,
        watertight: m === null ? conn.watertight : conn.watertight && m.watertight,
        triangles: conn.triangles,
        bodies: conn.count,
        bodySizes: conn.bodies.map(size),
        bodyCenters: conn.bodies.map(center),
        bodyVerdict: conn.count === 1 ? 'single-body' : 'multi-body',
        ...(m !== null
          ? {
              sizeMm: m.boundingBoxMm.size,
              bboxMinMm: m.boundingBoxMm.min,
              bboxMaxMm: m.boundingBoxMm.max,
              volumeMm3: m.volumeMm3,
              surfaceAreaMm2: m.surfaceAreaMm2,
              centerOfMassMm: m.centerOfMassMm,
              genus: m.genus,
            }
          : {}),
        ...(extent ? { extent } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  }));

  // --- measure_gap: how far apart two things are, however you name them ------
  //
  // 2026-10-11: measure_closest and measure_distance were merged into this. Both
  // answered ONE question — "how far apart are these two things?" — but each
  // accepted only its own spelling of an endpoint, so a caller had to work out
  // which tool took which form before it could ask. Now each endpoint is named ONE
  // of four ways and the tool routes itself:
  //
  //   aVersionId / bVersionId   a whole saved solid   → solved closest-point pair
  //   aSphere    / bSphere      an analytic sphere    → solved exactly
  //   aPoint     / bPoint       a coordinate          → snapped to the surface
  //   aDatum     / bDatum       a declared datum      → EXACT, never snapped
  //
  // Both endpoints must be the same KIND of thing: solid/sphere with solid/sphere
  // (solved, no coordinates needed from you) or point/datum with point/datum (your
  // inputs, snapped, with per-endpoint diagnostics). Mixing a solid with a point is
  // REFUSED with an explicit message rather than silently picking one engine —
  // that is a deliberate v1 scope, not a physical impossibility.
  //
  // Porting notes for callers of the two retired tools:
  //   measure_closest  → unchanged (`pointA`/`pointB`, `method`, `frame`, render).
  //   measure_distance → `aSnapped`/`bSnapped` are now `pointA`/`pointB`, and
  //     `dxMm`/`dyMm`/`dzMm` are reported for solved pairs too (arithmetic on the
  //     points, not a new measurement). Its `bVersionId`-as-"the part to snap B
  //     onto" is now `bOn`, because `bVersionId` means "endpoint B IS that solid",
  //     which is what it always meant in closest. The snap/inside diagnostics are
  //     now OMITTED for a datum endpoint instead of being forced to 0/false:
  //     a datum is never snapped, so those numbers would be invented.
  registerTool(defineTool({
    name: 'measure_gap',
    description:
      'How far apart two things are, however you name them. Each endpoint is ONE of: a saved solid ' +
      '(`aVersionId`/`bVersionId`), an analytic sphere (`aSphere`/`bSphere`, solved exactly), a coordinate ' +
      '(`aPoint`/`bPoint`, snapped to the surface by default) or a declared datum (`aDatum`/`bDatum`, ' +
      'resolved EXACTLY and never snapped). Solid/sphere pairs are solved as a closest-point problem and ' +
      'come back with an annotated render; point/datum pairs come back with per-endpoint snap distances and ' +
      'whether your input point was inside the solid. Both endpoints must be the same kind — a solid cannot ' +
      'be paired with a point in one call. mm, z-up.',
    parameters: {
      versionId: { type: 'string', description: 'The base part: it owns endpoint A and, unless bOn says otherwise, endpoint B. Required for point/datum endpoints; a solid/sphere pair does not need it.' },
      aVersionId: { type: 'string', description: 'Endpoint A as a whole solid: saved version id.' },
      aSphere: {
        type: 'object',
        description: 'Endpoint A as an analytic sphere probe {center:[x,y,z], radius} — solved exactly.',
        additionalProperties: false,
        properties: {
          center: { type: 'array', required: true, items: { type: 'number' } },
          radius: { type: 'number', required: true },
        },
      },
      aPoint: { type: 'array', description: 'Endpoint A as a coordinate [x,y,z] mm — approximate is fine (snapped to versionId\'s surface). Give this OR aDatum.', items: { type: 'number' } },
      aDatum: { type: 'string', description: 'Endpoint A as a datum anchor declared via datum("name",[x,y,z]). Resolved EXACT (no snapping) — prefer over aPoint.' },
      bVersionId: { type: 'string', description: 'Endpoint B as a whole solid: saved version id.' },
      bSphere: {
        type: 'object',
        description: 'Endpoint B as an analytic sphere probe.',
        additionalProperties: false,
        properties: {
          center: { type: 'array', required: true, items: { type: 'number' } },
          radius: { type: 'number', required: true },
        },
      },
      bPoint: { type: 'array', description: 'Endpoint B as a coordinate [x,y,z] mm — snapped to bOn\'s surface (bOn defaults to versionId). Give this OR bDatum.', items: { type: 'number' } },
      bDatum: { type: 'string', description: 'Endpoint B as a datum anchor on bOn (defaults to versionId). Resolved EXACT — prefer over bPoint.' },
      bOn: { type: 'string', description: 'Which part a bPoint/bDatum endpoint belongs to. Defaults to versionId. (This is what the retired measure_distance meant by bVersionId.)' },
      snap: { type: 'boolean', description: 'Snap raw coordinate inputs to the nearest surface point. Default true. Datum-resolved points are never snapped.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          distanceMm: { type: 'number', required: true },
          dxMm: { type: 'number', required: true, description: 'pointB − pointA, componentwise.' },
          dyMm: { type: 'number', required: true },
          dzMm: { type: 'number', required: true },
          pointA: { type: 'array', required: true, items: { type: 'number' } },
          pointB: { type: 'array', required: true, items: { type: 'number' } },
          method: { type: 'string', description: 'How the pair was solved. Present for solid/sphere endpoints.' },
          frame: { type: 'string', description: 'Path of the annotated render, when one was produced.' },
          aSnapDistanceMm: { type: 'number', description: 'How far endpoint A\'s raw coordinate was from the surface. Present for aPoint endpoints only (a datum is never snapped).' },
          bSnapDistanceMm: { type: 'number' },
          aOutside: { type: 'boolean', description: 'Whether endpoint A\'s input point was inside the part. Present for aPoint endpoints only.' },
          bOutside: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 180_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string;
        aVersionId?: string; bVersionId?: string;
        aSphere?: { center: number[]; radius: number };
        bSphere?: { center: number[]; radius: number };
        aPoint?: number[]; bPoint?: number[];
        aDatum?: string; bDatum?: string;
        bOn?: string; snap?: boolean;
      };
      const { store } = await allStores(exec);
      const versionStl = (id: string) => join(store.root, 'versions', id, 'model.stl');
      if (a.versionId !== undefined && !existsSync(versionStl(a.versionId))) {
        throw new Error(await versionNotFound(store, a.versionId));
      }

      // Name the endpoints first: exactly one spelling each, and the same KIND on
      // both sides. Every error names the spellings that were accepted, because a
      // rejected call is where a caller learns the vocabulary.
      const classify = (side: 'a' | 'b'): 'solid' | 'sphere' | 'point' | 'datum' => {
        const spellings: [string, unknown][] = side === 'a'
          ? [['aVersionId', a.aVersionId], ['aSphere', a.aSphere], ['aPoint', a.aPoint], ['aDatum', a.aDatum]]
          : [['bVersionId', a.bVersionId], ['bSphere', a.bSphere], ['bPoint', a.bPoint], ['bDatum', a.bDatum]];
        const named = spellings.filter(([, v]) => v !== undefined).map(([k]) => k);
        if (named.length !== 1) {
          throw new Error(
            `endpoint ${side} needs exactly ONE of ${spellings.map(([k]) => k).join(' / ')} — ` +
            `got ${named.length === 0 ? 'none' : named.join(' + ')}`,
          );
        }
        const key = named[0]!;
        return key.endsWith('VersionId') ? 'solid'
          : key.endsWith('Sphere') ? 'sphere'
          : key.endsWith('Datum') ? 'datum'
          : 'point';
      };
      const kindA = classify('a');
      const kindB = classify('b');
      const solvedA = kindA === 'solid' || kindA === 'sphere';
      const solvedB = kindB === 'solid' || kindB === 'sphere';
      if (solvedA !== solvedB) {
        throw new Error(
          `cannot pair a ${kindA} endpoint with a ${kindB} endpoint in one call: solid/sphere pairs are ` +
          'solved as a closest-point problem, point/datum pairs are snapped. Name both endpoints the same ' +
          'way, or measure the two steps separately.',
        );
      }

      const warnings: string[] = [];
      const axis = (p: [number, number, number], q: [number, number, number]) =>
        [0, 1, 2].map((i) => +(q[i]! - p[i]!).toFixed(3)) as [number, number, number];

      if (!solvedA && a.versionId === undefined) {
        throw argError('measure_gap', 'versionId', 'is required for a point/datum endpoint', 'the version the endpoint belongs to; a b-side point/datum may instead name another part with `bOn`. Only a solid/sphere pair can be measured without a base part',
          { example: 'measure_gap({ versionId: "v050", aVersionId: "v050", aDatum: "中心", bDatum: "顶尖", bOn: "v058" })' });
      }
      if (solvedA) {
        // ---- solved pair: solid / sphere, no coordinates from the caller ------
        if (a.aSphere && a.bSphere) {
          throw new Error(
          'measure_gap does not screen sphere-vs-sphere: the analytic centre distance is what you want ' +
            '(subtract the two centres). Supported kinds: ' +
            'part-vs-part (mesh distance), sphere-vs-part, sphere-vs-plane. ' +
            'Signature: measure_gap({ a: { versionId, kind: "sphere", centreMm, radiusMm }, b: {…} })',
        );
        }
        const warnIfOpen = (v: string, label: string, watertight: boolean) => {
          if (!watertight) {
            warnings.push(`part ${label} (${v}) is NOT watertight — a closest-point pair on an open surface is not a clearance between solids (microscope3: this exact tool reported a fake 0.05mm margin on a broken mesh)`);
          }
        };
        const worker = await ensurePythonWorker();
        let distanceMm: number;
        let pointA: [number, number, number];
        let pointB: [number, number, number];
        let method: string;
        if (a.aSphere && a.bVersionId) {
          const solved = await worker.request<MeshSphereSolve>('closest_mesh_sphere', {
            mesh: versionStl(a.bVersionId), center: a.aSphere.center, radius: a.aSphere.radius,
          });
          distanceMm = solved.distanceMm;
          pointA = solved.spherePoint;
          pointB = solved.meshPoint;
          method = solved.method;
          warnIfOpen(a.bVersionId, 'b', solved.watertight);
        } else if (a.bSphere && a.aVersionId) {
          const solved = await worker.request<MeshSphereSolve>('closest_mesh_sphere', {
            mesh: versionStl(a.aVersionId), center: a.bSphere.center, radius: a.bSphere.radius,
          });
          distanceMm = solved.distanceMm;
          pointA = solved.meshPoint;
          pointB = solved.spherePoint;
          method = solved.method;
          warnIfOpen(a.aVersionId, 'a', solved.watertight);
        } else {
          const solved = await worker.request<MeshMeshSolve>('closest_mesh_mesh', {
            meshA: versionStl(a.aVersionId!), meshB: versionStl(a.bVersionId!),
          });
          distanceMm = solved.distanceMm;
          pointA = solved.pointA;
          pointB = solved.pointB;
          method = solved.method;
          warnIfOpen(a.aVersionId!, 'a', solved.watertightA);
          warnIfOpen(a.bVersionId!, 'b', solved.watertightB);
        }

        // Annotated render: parts + marker spheres + connector.
        //
        // The INPUTS are scratch (a temp dir, deleted at the end); the OUTPUT is a single
        // cache file beside the corpus that is overwritten each call. Before this, every
        // call left `measure/a.stl`, `b.stl` and a new `gap_<timestamp>.scad/.png` behind
        // forever, and the pair files were shared names two concurrent calls could fight
        // over (2026-10-23 audit, FIX-E4).
        const measureDir = join(store.root, 'measure');
        await mkdir(measureDir, { recursive: true });
        const scratchDir = await mkdtemp(join(tmpdir(), 'cad-measure-'));
        let scratchCleaned = false;
        const cleanScratch = async () => {
          if (scratchCleaned) return;
          scratchCleaned = true;
          await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        };
        const partScad = async (versionId: string | undefined, color: string, name: string): Promise<string> => {
          if (!versionId) return '';
          const bytes = await readFile(join(store.root, 'versions', versionId, 'model.stl'));
          const path = join(scratchDir, `${name}.stl`);
          await writeFile(path, bytes);
          return `color("${color}", 0.7) import("${path}");\n`;
        };
        let scad = '';
        scad += await partScad(a.aVersionId, '#4a7dbd', 'a');
        scad += await partScad(a.bVersionId, '#c0392b', 'b');
        if (a.aSphere) scad += `color("#4a7dbd", 0.5) translate([${a.aSphere.center.join(',')}]) sphere(r=${a.aSphere.radius}, $fn=64);\n`;
        if (a.bSphere) scad += `color("#c0392b", 0.5) translate([${a.bSphere.center.join(',')}]) sphere(r=${a.bSphere.radius}, $fn=64);\n`;
        const f = (v: [number, number, number]) => v.map((x) => x.toFixed(4)).join(',');
        scad += `color("red") translate([${f(pointA)}]) sphere(r=2.2, $fn=32);\n`;
        scad += `color("royalblue") translate([${f(pointB)}]) sphere(r=2.2, $fn=32);\n`;
        scad += `color("black") hull() { translate([${f(pointA)}]) sphere(r=0.5, $fn=16); translate([${f(pointB)}]) sphere(r=0.5, $fn=16); }\n`;

        const scadPath = join(scratchDir, 'gap.scad');
        // One overwritten cache, not an ever-growing pile: the annotated render is a
        // convenience for the current answer, and the reply carries the numbers anyway.
        const pngPath = join(measureDir, 'last-gap.png');
        await writeFile(scadPath, scad, 'utf8');
        const ok = await renderScadPng(scadPath, pngPath, { rotate: [65, 0, 25] });
        const frame = ok ? pngPath : '';
        await cleanScratch();
        try {
          await ctx.attachments.saveImages([{ data: await readFile(pngPath), mediaType: 'image/png', name: 'gap-closest-points' }]);
        } catch { /* headless: frame on disk is enough */ }
        const [dxMm, dyMm, dzMm] = axis(pointA, pointB);
        return { distanceMm, dxMm, dyMm, dzMm, pointA, pointB, method, frame, warnings };
      }

      // ---- snapped pair: point / datum --------------------------------------
      const bPart = a.bOn ?? a.versionId;
      if (!existsSync(versionStl(bPart))) throw new Error(await versionNotFound(store, bPart, ' (bOn)'));
      const resolve = async (part: string, datumName?: string, point?: number[]): Promise<[number, number, number]> => {
        if (!datumName) return point as [number, number, number];
        const datums = await readVersionDatumPoints(store, part);
        const hit = datums[datumName];
        if (!hit) {
          const known = Object.keys(datums).join(', ') || 'none';
          throw new Error(`datum "${datumName}" not found on ${part} (declared: ${known})`);
        }
        return hit;
      };
      const aPt = await resolve(a.versionId!, a.aDatum, a.aPoint);
      const bPt = await resolve(bPart, a.bDatum, a.bPoint);
      // The solve is Python's (batch 1); the parts travel as paths. Datum-resolved
      // points are exact declarations — never snap them.
      const snapRaw = a.snap ?? true;
      const out = await (await ensurePythonWorker()).request<MeasureDistanceSolve>('measure_distance', {
        meshA: versionStl(a.versionId!),
        meshB: bPart === a.versionId ? null : versionStl(bPart),
        a: aPt,
        b: bPt,
        snapA: snapRaw && kindA === 'point',
        snapB: snapRaw && kindB === 'point',
      });
      // A snapped distance on an open surface is a number about a mesh that does
      // not describe a solid (microscope3: measure_closest reported 0.05mm
      // "clearance" on exactly such a mesh). Never refuse — datums still resolve
      // exactly — but roar. The flag is the STRICT manifold verdict, not trimesh's.
      for (const [label, watertight, v] of [['a', out.watertightA, a.versionId!], ['b', out.watertightB, bPart]] as const) {
        if (!watertight) {
          warnings.push(`part ${label} (${v}) is NOT watertight — surface snapping on an open mesh is unreliable, fix the mesh before trusting this number`);
        }
      }
      return {
        distanceMm: out.distanceMm,
        dxMm: out.dxMm,
        dyMm: out.dyMm,
        dzMm: out.dzMm,
        pointA: out.aSnapped,
        pointB: out.bSnapped,
        ...(kindA === 'point' ? { aSnapDistanceMm: out.aSnapDistanceMm, aOutside: out.aOutside } : {}),
        ...(kindB === 'point' ? { bSnapDistanceMm: out.bSnapDistanceMm, bOutside: out.bOutside } : {}),
        warnings,
      };
    },
  }));

  // --- measure_thickness: every material span along one ray (the aiming-tolerant one) ---
  //
  // Why this exists beside measure_distance: measure_distance needs a point ON the
  // surface you mean, and a caller that did not author the geometry (an imported
  // STL, an existing corpus) has no way to name one — that is the whole reason the
  // bench once measured ZERO measure_distance calls. A LINE only has to cross the
  // wall it asks about, and every crossing comes back, so "how deep do I aim" stops
  // being a question. The solve is Python's (`measure_thickness` op); what lives
  // here is the schema, datum/axis resolution and the report.
  registerTool(defineTool({
    name: 'measure_thickness',
    description:
      'Every material span along one ray, in a single call: wall thicknesses, internal cavities and ' +
      'cross-part clearances. Give a start point (APPROXIMATE IS FINE — the ray only has to cross the ' +
      'wall, not hit a surface) and an axis. Returns, for each span, the enter/exit distance from the ' +
      'start, the thickness, the point and surface normal at each end, plus the gap between consecutive ' +
      'spans. Opposite entry/exit normals mean a wall; same-facing normals mean a slot, not a wall. ' +
      'Pass bVersionId to read a clearance between two parts along the same line (tagged "a→b"). ' +
      'Prefer this over measure_distance whenever you cannot name an exact surface point. mm, z-up.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version to probe, e.g. "v003".' },
      from: { type: 'array', description: 'Start point [x,y,z] mm — approximate is fine. Give this OR fromDatum.', items: { type: 'number' } },
      fromDatum: { type: 'string', description: 'Datum anchor name, resolved EXACTLY (no guessing). Prefer over `from` when the part declares one.' },
      direction: { type: 'string', description: 'Ray direction along a principal axis: +x | -x | +y | -y | +z | -z. Give this OR directionVector. Pick the axis that crosses the feature you care about.' },
      directionVector: { type: 'array', description: 'Ray direction [x,y,z] for a non-axis-aligned probe; normalised internally.', items: { type: 'number' } },
      bVersionId: { type: 'string', description: 'Second part included in the same ray, so a gap between the two comes back tagged "a→b".' },
      maxSpanMm: { type: 'number', description: 'Stop reporting past this distance from `from`, mm. A span cut by the limit comes back with clipped:true.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          direction: { type: 'array', required: true, items: { type: 'number' } },
          from: { type: 'array', required: true, items: { type: 'number' } },
          fromInsideSolid: { type: 'boolean', required: true, description: 'The start point was inside material (then the first span begins at 0 and has no entryNormal).' },
          spans: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                part: { type: 'string', required: true, description: '"a" = versionId, "b" = bVersionId.' },
                enterMm: { type: 'number', required: true },
                exitMm: { type: 'number', required: true },
                thicknessMm: { type: 'number', required: true },
                atMm: { type: 'number', required: true },
                entryPoint: { type: 'array', required: true, items: { type: 'number' } },
                exitPoint: { type: 'array', required: true, items: { type: 'number' } },
                entryNormal: { type: 'array', items: { type: 'number' } },
                exitNormal: { type: 'array', required: true, items: { type: 'number' } },
                clipped: { type: 'boolean' },
              },
            },
          },
          gaps: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                afterMm: { type: 'number', required: true },
                beforeMm: { type: 'number', required: true },
                gapMm: { type: 'number', required: true },
                between: { type: 'string', required: true, description: '"same-part" (a cavity) or "a→b" (a clearance).' },
              },
            },
          },
          thinnestSpanMm: { type: 'number', required: true },
          clipped: { type: 'boolean', required: true },
          nudgedMm: { type: 'number', required: true, description: 'How far the accepted probe line sits from the requested one, mm (0 = the requested line was used). Offsets are perpendicular, so they do not move a crossing by more than d²/2R.' },
          probeAgreement: { type: 'number', required: true, description: 'Share of the 17 probe lines that agreed with the reported answer. Below 1 the ray runs near-tangent to a surface: read the warnings.' },
          watertightA: { type: 'boolean', required: true },
          watertightB: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string; from?: number[]; fromDatum?: string;
        direction?: string; directionVector?: number[];
        bVersionId?: string; maxSpanMm?: number;
      };
      const { store } = await allStores(exec);
      const versionStl = (v: string) => join(store.root, 'versions', v, 'model.stl');
      if (!existsSync(versionStl(a.versionId))) throw new Error(await versionNotFound(store, a.versionId));
      if (a.bVersionId && !existsSync(versionStl(a.bVersionId))) throw new Error(await versionNotFound(store, a.bVersionId));

      let from: [number, number, number];
      if (a.fromDatum) {
        const datums = await readVersionDatumPoints(store, a.versionId);
        const hit = datums[a.fromDatum];
        if (!hit) {
          const known = Object.keys(datums).join(', ') || 'none';
          throw new Error(`datum "${a.fromDatum}" not found on ${a.versionId} (declared: ${known})`);
        }
        from = hit;
      } else if (a.from) {
        if (a.from.length !== 3) throw new Error('`from` needs three numbers [x,y,z] mm');
        from = a.from as [number, number, number];
      } else {
        throw new Error('measure_thickness needs `from` [x,y,z] or `fromDatum`');
      }

      // The axis argument travels as given: a principal-axis name or a vector. The
      // WORKER owns what an axis means (`_axis_vector`), because the same argument
      // reaches three ops and a second parser here had already drifted from it.
      const direction = a.directionVector ?? a.direction;
      if (direction === undefined) {
        throw new Error('measure_thickness needs `direction` ("+x" … "-z") or `directionVector`');
      }

      const out = await (await ensurePythonWorker()).request<MeasureThicknessSolve>('measure_thickness', {
        meshes: [versionStl(a.versionId), a.bVersionId ? versionStl(a.bVersionId) : null],
        from,
        direction,
        maxSpanMm: a.maxSpanMm,
      });
      return {
        direction: out.direction,
        from: out.from,
        fromInsideSolid: out.fromInsideSolid,
        spans: out.spans,
        gaps: out.gaps,
        thinnestSpanMm: out.thinnestSpanMm,
        clipped: out.clipped,
        nudgedMm: out.nudgedMm,
        probeAgreement: out.probeAgreement,
        watertightA: out.watertightA,
        // Omitted (not false) when no second part was given: false would claim a
        // verdict about a solid that was never opened.
        ...(out.watertightB === null ? {} : { watertightB: out.watertightB }),
        warnings: out.warnings,
      };
    },
  }));

  // --- list_features: WHERE things are, for geometry you did not draw ---
  //
  // This is the op that makes the rest of the measure family usable on geometry the
  // caller did not author: measure_distance wants a point on a surface, and an
  // imported STL or a corpus part offers no way to name one. Holes come back with
  // centres and diameters, cylinders with their axes, planar faces with normals and
  // areas — so every later measurement can be written against a feature instead of
  // against a guessed coordinate.
  //
  // The limits are stated in the description on purpose: holes are found on PLANAR
  // faces only (a hole drilled into a cylindrical wall needs the curved-surface
  // path), and a flat facet that a tangent fillet joins to a bore lands in the
  // curved region rather than the face list — which is why each curved region
  // reports `largeFacets`.
  registerTool(defineTool({
    name: 'list_features',
    description:
      'The coordinate inventory of a saved version: planar faces (normal, a point on the plane, area, centroid), ' +
      'the HOLES in them (centre, diameter, and whether each is through or how deep), and cylindrical surfaces ' +
      '(axis, diameter, length, and bore-vs-boss). Use this FIRST whenever you must measure or assemble geometry ' +
      'you did not generate — an imported STL, an existing corpus part — because measure_distance needs a point ' +
      'on a surface and this is where those coordinates come from. Each face also reports the smooth region it ' +
      'belongs to, so a 5.9mm² facet that is one of 64 in a 377mm² non-planar region is readable as a bore ' +
      'segment rather than a face. Thresholds (`minFaceAreaMm2`, `smoothDeg`) are choices and are echoed in the ' +
      'result, together with how many faces and curved segments were left out. Holes are detected on planar ' +
      'faces only. mm, z-up.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version to inspect, e.g. "v003".' },
      minFaceAreaMm2: { type: 'number', description: 'A planar face smaller than this is not listed as a face. Default 4.0. Raise it to cut bore-segment noise on a finely tessellated part; lower it to catch small lands.' },
      smoothDeg: { type: 'number', description: 'Dihedral angle below which two facets are treated as one smooth (curved) surface. Default 10 (a 64-segment bore steps 5.6°).' },
      maxFaces: { type: 'integer', description: 'Cap on listed faces, largest first. Default 40; the result reports facesOmitted.' },
      maxCylinders: { type: 'integer', description: 'Cap on listed cylinders. Default 24.' },
      withHoleDepth: { type: 'boolean', description: 'Probe each hole along its axis to report depth / through-hole. Default true (one ray per hole).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          watertight: { type: 'boolean', required: true },
          triangles: { type: 'integer', required: true },
          thresholds: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              smoothDeg: { type: 'number', required: true },
              minFaceAreaMm2: { type: 'number', required: true },
              maxFaces: { type: 'number', required: true },
              maxCylinders: { type: 'number', required: true },
            },
          },
          faces: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                normalMm: { type: 'array', required: true, items: { type: 'number' }, description: 'Outward unit normal.' },
                originMm: { type: 'array', required: true, items: { type: 'number' }, description: 'Any point on the plane.' },
                centroidMm: { type: 'array', required: true, items: { type: 'number' } },
                areaMm2: { type: 'number', required: true },
                smoothRegion: {
                  type: 'object', required: true, additionalProperties: false,
                  properties: {
                    facets: { type: 'number', required: true, description: 'Facets in this smooth region; 1 means a genuinely isolated flat face.' },
                    areaMm2: { type: 'number', required: true },
                    planar: { type: 'boolean', required: true, description: 'false means this facet is a segment of a curved surface (a bore quad).' },
                  },
                },
                holes: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      centerMm: { type: 'array', required: true, items: { type: 'number' } },
                      axisMm: { type: 'array', required: true, items: { type: 'number' }, description: 'Hole axis = the face normal (the hole goes INTO the material).' },
                      kind: { type: 'string', required: true, description: '"round" | "non-circular" (a slot or a polygon pocket).' },
                      areaMm2: { type: 'number', required: true },
                      vertices: { type: 'number', required: true },
                      circularityResidualMm: { type: 'number', required: true },
                      areaRatioToCircle: { type: 'number', required: true, description: 'Loop area ÷ fitted-circle area. Below 0.95 the loop is a polygon, not a circle — a rectangle\'s four corners are concyclic, so residual alone cannot tell them apart.' },
                      diameterMm: { type: 'number', description: 'Present only when kind is "round".' },
                      through: { type: 'boolean', description: 'Present when withHoleDepth was on.' },
                      depthMm: { type: 'number', description: 'Distance to the first surface behind the hole; absent when the hole is through.' },
                    },
                  },
                },
              },
            },
          },
          facesOmitted: { type: 'number', required: true, description: 'Planar faces above the area threshold left out by maxFaces.' },
          curvedSegmentFacets: { type: 'number', required: true, description: 'Facets belonging to curved surfaces — deliberately not listed as faces.' },
          cylinders: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true, description: '"bore" (a hole: material outside) | "boss" (a shaft: material inside).' },
                axisMm: { type: 'array', required: true, items: { type: 'number' } },
                centerMm: { type: 'array', required: true, items: { type: 'number' }, description: 'A point on the axis, at the region centroid height.' },
                diameterMm: { type: 'number', required: true },
                lengthMm: { type: 'number', required: true },
                facets: { type: 'number', required: true },
                areaMm2: { type: 'number', required: true },
                largeFacets: { type: 'number', required: true, description: 'Facets here big enough to count as faces; nonzero means a flat facet is hidden inside this region (a tangent fillet).' },
                fitResidualMm: { type: 'number', required: true },
              },
            },
          },
          curvedSurfaces: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                areaMm2: { type: 'number', required: true },
                facets: { type: 'number', required: true },
                largeFacets: { type: 'number', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          faceCount: { type: 'number', required: true },
          holeCount: { type: 'number', required: true },
          cylinderCount: { type: 'number', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string; minFaceAreaMm2?: number; smoothDeg?: number;
        maxFaces?: number; maxCylinders?: number; withHoleDepth?: boolean;
      };
      const { store } = await allStores(exec);
      const path = join(store.root, 'versions', a.versionId, 'model.stl');
      if (!existsSync(path)) throw new Error(await versionNotFound(store, a.versionId));
      const out = await (await ensurePythonWorker()).request<ListFeaturesSolve>('list_features', {
        path,
        minFaceAreaMm2: a.minFaceAreaMm2,
        smoothDeg: a.smoothDeg,
        maxFaces: a.maxFaces,
        maxCylinders: a.maxCylinders,
        withHoleDepth: a.withHoleDepth,
      });
      return { versionId: a.versionId, ...out };
    },
  }));

  // --- measure_section: the cross-section as data, so nothing has to be aimed at ---
  //
  // A cut plane has no surface on a mesh — it is an interpretation of the geometry —
  // so there is nothing to click on. This returns the interpretation AS NUMBERS:
  // each polygon's outer ring (points in the plane's own 2D frame AND in world
  // coordinates, plus per-segment lengths and angles), each hole in it (centre,
  // diameter, and the exact wall thickness to the outside) and the spacing between
  // holes. Hole spacing, wall thickness and in-plane angles are then read off the
  // reply instead of being aimed at.
  registerTool(defineTool({
    name: 'measure_section',
    description:
      'Cut a saved version with a plane and return the SECTION AS DATA: every polygon, its outer ring ' +
      '(points in the plane\'s 2D frame AND in world mm, with per-segment lengths and angles), every hole ' +
      'in it (centre, diameter, kind, and the exact segment-to-segment wall thickness to the outside), and ' +
      'the centre distance and clearance between neighbouring holes. Use it for hole spacing, wall thickness ' +
      'or an in-plane angle WITHOUT naming any 3D point — `axis` plus `fraction` is the whole input. The ' +
      'plane\'s own u/v axes are reported, so a follow-up `measure_distance` can be written against the ' +
      'world coordinates it returns. Holes are found by polygonising the cut, so a slot is reported as ' +
      'non-circular rather than forced through a circle. mm, z-up.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version to section, e.g. "v003".' },
      axis: { type: 'string', description: 'Plane normal along a principal axis: x | y | z (a leading "-" flips it). Default z, i.e. a horizontal cut.' },
      fraction: { type: 'number', description: 'Where to cut, as 0..1 across the bounding box along the axis. Default 0.5 (mid-height).' },
      atMm: { type: 'number', description: 'Explicit cut position in mm along the axis — wins over `fraction`. The version\'s extent along that axis is reported as planeRangeMm.' },
      simplifyToleranceMm: { type: 'number', description: 'Ring vertices within this distance of the line through their neighbours are dropped. Default 0.01 (a $fn=64 R=10 circle keeps every vertex).' },
      maxPolygons: { type: 'integer', description: 'Cap on reported polygons, largest first. Default 12.' },
      maxHolesPerPolygon: { type: 'integer', description: 'Cap on holes reported per polygon. Default 24.' },
      maxHoleNeighbours: { type: 'integer', description: 'How many nearest holes to relate to each hole. Default 3.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          axisMm: { type: 'array', required: true, items: { type: 'number' } },
          atMm: { type: 'number', required: true },
          originMm: { type: 'array', required: true, items: { type: 'number' }, description: 'A point on the cut plane (axisMm × atMm).' },
          uAxisMm: { type: 'array', required: true, items: { type: 'number' }, description: 'In-plane +u direction in world coordinates.' },
          vAxisMm: { type: 'array', required: true, items: { type: 'number' }, description: 'In-plane +v direction; (u, v, axis) is right-handed.' },
          planeRangeMm: { type: 'array', required: true, items: { type: 'number' }, description: 'The version\'s extent along the axis ([low, high]); gives the valid atMm range.' },
          thresholds: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              simplifyToleranceMm: { type: 'number', required: true },
              maxPolygons: { type: 'number', required: true },
              maxHolesPerPolygon: { type: 'number', required: true },
              maxRingPoints: { type: 'number', required: true },
            },
          },
          empty: { type: 'boolean', required: true, description: 'true when the plane misses the solid; warning says why.' },
          polygons: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                areaMm2: { type: 'number', required: true },
                perimeterMm: { type: 'number', required: true },
                holeCount: { type: 'number', required: true },
                outer: {
                  type: 'object', required: true, additionalProperties: false,
                  properties: {
                    pointsUv: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
                    pointsWorldMm: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
                    segmentsMm: { type: 'array', required: true, items: { type: 'number' }, description: 'Segment i runs from point i to point i+1 (wrapping at the end).' },
                    anglesDeg: { type: 'array', required: true, items: { type: 'number' }, description: 'Direction of segment i from +u, in [0,180) — a line has no preferred sign.' },
                    closed: { type: 'boolean', required: true },
                    pointsSubsampled: { type: 'boolean', required: true },
                  },
                },
                holes: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      centerUv: { type: 'array', required: true, items: { type: 'number' } },
                      centerWorldMm: { type: 'array', required: true, items: { type: 'number' } },
                      areaMm2: { type: 'number', required: true },
                      kind: { type: 'string', required: true, description: '"round" | "non-circular".' },
                      circularityResidualMm: { type: 'number', required: true },
                      areaRatioToCircle: { type: 'number', required: true },
                      vertices: { type: 'number', required: true },
                      wallToOuterMm: { type: 'number', required: true, description: 'Exact segment-to-segment distance to this polygon\'s outer ring — the thinnest material between the hole and the outside.' },
                      diameterMm: { type: 'number', description: 'Present only when kind is "round": the least-squares fit, which on a tessellated bore reads slightly SMALL.' },
                      enclosingDiameterMm: { type: 'number', description: 'The circumscribed (minimum enclosing circle) diameter. For a tessellated bore this is the nominal diameter; compare it with diameterMm to see the triangulation gap.' },
                      pointsUv: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Present only for non-circular holes, where a diameter cannot describe the shape.' },
                    },
                  },
                },
              },
            },
          },
          polygonsOmitted: { type: 'number', required: true },
          voidRegions: {
            type: 'number', required: true,
            description: 'Enclosed rings that are NOT material — the void a through-hole or slot punches in the section; material polygons + voidRegions = rings the cut found.',
          },
          holeSpacing: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                centerDistanceMm: { type: 'number', required: true },
                clearanceMm: { type: 'number', required: true, description: 'Ring-to-ring gap between the two holes (0 when they break into each other).' },
              },
            },
          },
          areaMm2: { type: 'number', required: true },
          perimeterMm: { type: 'number', required: true },
          bboxUvMm: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
          holeCount: { type: 'number', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string; axis?: string; fraction?: number; atMm?: number;
        simplifyToleranceMm?: number; maxPolygons?: number; maxHolesPerPolygon?: number; maxHoleNeighbours?: number;
      };
      const { store } = await allStores(exec);
      const path = join(store.root, 'versions', a.versionId, 'model.stl');
      if (!existsSync(path)) throw new Error(await versionNotFound(store, a.versionId));
      const out = await (await ensurePythonWorker()).request<MeasureSectionSolve>('measure_section', {
        path,
        axis: a.axis ?? 'z',
        atMm: a.atMm,
        fraction: a.fraction,
        simplifyToleranceMm: a.simplifyToleranceMm,
        maxPolygons: a.maxPolygons,
        maxHolesPerPolygon: a.maxHolesPerPolygon,
        maxHoleNeighbours: a.maxHoleNeighbours,
      });
      return { versionId: a.versionId, ...out };
    },
  }));


  // --- measure_angle: the angle between two things, with the convention stated ---
  //
  // "Angle" is the measurement most likely to produce a "your number does not match
  // mine" round trip, because 30° and 150° describe the same pair of lines and a
  // face-to-face angle is the supplement of the normal-to-normal one. So the reply
  // carries `angleDeg` (as given), `acuteDeg` (0..90) and `supplementDeg` together,
  // plus which of the three ways each side was named. The arithmetic is the worker's
  // — the same `_axis_line_metrics` that `check_assembly`'s `coaxial` operator uses,
  // so the two can never drift.
  registerTool(defineTool({
    name: 'measure_angle',
    description:
      'The angle between two directions, plus the distance between their lines. Name each side ONE of three ways: ' +
      '`aProbe` [x,y,z] (a point — the direction becomes the normal of the face it lands on, so a rough guess is ' +
      'enough), `aDatum` (an axis / cylinder / plane datum, resolved exactly), or `aPoints` [[x,y,z],[x,y,z]] ' +
      '(the direction is the segment; give [apex, point] for a corner) / `aDir` (a vector you already know). ' +
      'Returns angleDeg (between the vectors AS GIVEN, 0..180), acuteDeg (0..90 — the usual reading of "the angle ' +
      'between two lines") and supplementDeg TOGETHER, with lineDistanceMm (perpendicular offset for parallel ' +
      'lines, closest approach for skew), commonNormalMm and the crossing point when they meet. Angles are ' +
      'degrees. mm, z-up.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Version whose surface side b snaps a probe to (and the default for side b\'s datum).' },
      aVersionId: { type: 'string', description: 'Version for side a when the two sides live on different parts. Defaults to versionId.' },
      bVersionId: { type: 'string', description: 'Version for side b. Defaults to versionId.' },
      aProbe: { type: 'array', description: 'Side a as a POINT [x,y,z] mm: the direction becomes the normal of the nearest face. Approximate is fine.', items: { type: 'number' } },
      bProbe: { type: 'array', description: 'Side b as a point (nearest face normal).', items: { type: 'number' } },
      aDatum: { type: 'string', description: 'Side a as a datum name declared on aVersionId: axis / cylinder / plane give a direction, resolved EXACTLY.' },
      bDatum: { type: 'string', description: 'Side b as a datum name declared on bVersionId.' },
      aPoints: { type: 'array', description: 'Side a as two points [[x,y,z],[x,y,z]]; the direction is the segment between them.', items: { type: 'array', items: { type: 'number' } } },
      bPoints: { type: 'array', description: 'Side b as two points.', items: { type: 'array', items: { type: 'number' } } },
      aDir: { type: 'array', description: 'Side a as a direction vector [x,y,z] you already know (e.g. a face normal read out of list_features).', items: { type: 'number' } },
      bDir: { type: 'array', description: 'Side b as a direction vector.', items: { type: 'number' } },
      aOrigin: { type: 'array', description: 'A point ON side a\'s line. Needed for a meaningful lineDistanceMm / coplanar / crossing point when you gave aDir instead of a position.', items: { type: 'number' } },
      bOrigin: { type: 'array', description: 'A point on side b\'s line.', items: { type: 'number' } },
      parallelToleranceDeg: { type: 'number', description: 'Within this many degrees of 0 the lines count as parallel (and 90 as perpendicular). Default 0.5.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          aDirMm: { type: 'array', required: true, items: { type: 'number' }, description: 'Unit direction of side a, as given (sign preserved).' },
          bDirMm: { type: 'array', required: true, items: { type: 'number' } },
          aOriginMm: { type: 'array', required: true, items: { type: 'number' }, description: 'The point the side-a line was anchored at.' },
          bOriginMm: { type: 'array', required: true, items: { type: 'number' } },
          aSource: { type: 'string', required: true, description: 'How side a was named (probe / datum / points / dir).' },
          bSource: { type: 'string', required: true },
          anchoredAtOrigin: { type: 'boolean', required: true, description: 'A side gave a direction with no point on it, so the origin was assumed: lineDistanceMm and coplanar describe that anchor.' },
          angleDeg: { type: 'number', required: true, description: 'Between the direction vectors AS GIVEN, 0..180. Flipping one input flips this to its supplement.' },
          acuteDeg: { type: 'number', required: true, description: 'min(angleDeg, 180−angleDeg), 0..90 — the usual "angle between two lines".' },
          supplementDeg: { type: 'number', required: true, description: '180 − angleDeg.' },
          parallel: { type: 'boolean', required: true, description: 'acuteDeg within parallelToleranceDeg of 0.' },
          perpendicular: { type: 'boolean', required: true, description: 'acuteDeg within parallelToleranceDeg of 90.' },
          coplanar: { type: 'boolean', required: true, description: 'The lines meet or are parallel.' },
          lineDistanceMm: { type: 'number', required: true, description: 'Parallel: perpendicular offset. Skew: closest approach.' },
          commonNormalMm: { type: 'array', required: true, items: { type: 'number' }, description: 'Direction of the shortest connecting segment (the cross product when the lines meet).' },
          crossingPointMm: { type: 'array', items: { type: 'number' }, description: 'Present only when the lines actually meet.' },
          convention: { type: 'string', required: true, description: 'Restates which number means what, so it travels with the result.' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string; aVersionId?: string; bVersionId?: string;
        aProbe?: number[]; bProbe?: number[]; aDatum?: string; bDatum?: string;
        aPoints?: number[][]; bPoints?: number[][];
        aDir?: number[]; bDir?: number[]; aOrigin?: number[]; bOrigin?: number[];
        parallelToleranceDeg?: number;
      };
      const { store } = await allStores(exec);
      const versionOf = (side: 'a' | 'b') => (side === 'a' ? (a.aVersionId ?? a.versionId) : (a.bVersionId ?? a.versionId));
      const versionStl = (v: string) => join(store.root, 'versions', v, 'model.stl');

      /** Turn a datum name into a direction + a point on it; a point datum cannot. */
      const datumSide = async (side: 'a' | 'b', name: string) => {
        const version = versionOf(side);
        const datums = await readVersionDatums(store, version);
        const found = [
          ...datums.axes.map((entry) => ({ kind: 'axis', name: entry.name, point: entry.point, dir: entry.dir })),
          ...datums.cylinders.map((entry) => ({ kind: 'cylinder', name: entry.name, point: entry.point, dir: entry.dir })),
          ...datums.planes.map((entry) => ({ kind: 'plane', name: entry.name, point: entry.point, dir: entry.normal })),
          ...datums.points.map((entry) => ({ kind: 'point', name: entry.name, point: entry.point, dir: null })),
        ].find((entry) => entry.name === name);
        if (!found) {
          const known = [...datums.axes, ...datums.cylinders, ...datums.planes, ...datums.points].map((e) => e.name);
          throw new Error(`datum "${name}" not found on ${version} (declared: ${known.join(', ') || 'none'})`);
        }
        if (!found.dir) {
          throw new Error(
            `datum "${name}" on ${version} is a POINT — a point has no direction to measure an angle against. ` +
            'Use aPoints [[x,y,z],[x,y,z]] (the corner and a point along one arm), aDir, or an axis/plane/cylinder datum.',
          );
        }
        return { dir: found.dir, origin: found.point, source: `datum ${found.kind} "${name}" on ${version}` };
      };

      const payload: Record<string, unknown> = {
        meshes: [versionStl(versionOf('a')), versionStl(versionOf('b'))],
        parallelToleranceDeg: a.parallelToleranceDeg,
      };
      for (const side of ['a', 'b'] as const) {
        const datum = side === 'a' ? a.aDatum : a.bDatum;
        const probe = side === 'a' ? a.aProbe : a.bProbe;
        const points = side === 'a' ? a.aPoints : a.bPoints;
        const dir = side === 'a' ? a.aDir : a.bDir;
        const origin = side === 'a' ? a.aOrigin : a.bOrigin;
        const given = [datum, probe, points, dir].filter((value) => value !== undefined).length;
        if (given === 0) {
          throw new Error(
            `side ${side} needs a direction: ${side}Probe [x,y,z], ${side}Datum "<name>", "${side}Points" [[x,y,z],[x,y,z]] or ${side}Dir [x,y,z]`,
          );
        }
        if (given > 1) {
          throw new Error(
            `side ${side} got ${given} ways of naming a direction — give exactly one of ${side}Probe / ${side}Datum / ${side}Points / ${side}Dir`,
          );
        }
        if (datum) {
          const resolved = await datumSide(side, datum);
          payload[`${side}Dir`] = resolved.dir;
          payload[`${side}Origin`] = origin ?? resolved.origin;
          payload[`${side}SourceHint`] = resolved.source;
        } else if (probe) {
          const stl = versionStl(versionOf(side));
          if (!existsSync(stl)) {
            throw new Error(
              `side ${side} probes a face, but version ${versionOf(side)} has no model.stl — ` +
              'pass aVersionId/bVersionId that exists, or name the direction with aDir/aPoints',
            );
          }
          payload[`${side}Probe`] = probe;
        } else if (points) {
          payload[`${side}Points`] = points;
        } else {
          payload[`${side}Dir`] = dir;
          if (origin) payload[`${side}Origin`] = origin;
        }
      }

      const out = await (await ensurePythonWorker()).request<MeasureAngleSolve>('measure_angle', payload);
      // A datum resolved here says so in the report: "datum axis 镜筒轴 on v010" is
      // evidence about WHICH geometry was measured, and the worker cannot know it.
      return {
        versionId: a.versionId,
        ...out,
        aSource: (payload.aSourceHint as string | undefined) ?? out.aSource,
        bSource: (payload.bSourceHint as string | undefined) ?? out.bSource,
      };
    },
  }));

  // --- check_printability: "符合逻辑"与"打得出来"是两回事 ---------------------
  //
  // microscope 系列两次交付了薄到打不出来的零件（渲染好看、装配全绿、壁却只有
  // 0.x mm），因为几何真值工具回答"是什么"，从不回答"造不造得出"。本工具用
  // 射线回答最便宜的两个制造问题：壁厚（沿内法线打到**对面壁**的距离）和
  // 悬垂（朝下的、比临界角更平的面的面积）。findings 给出位置，改不改由设计判断。
  //
  // 2026-10-11 修掉三个"静默"缺陷，都在这条链上真实发生过：
  //  1. 悬垂面积曾经只在 1/step 采样面上求和，是把面积当 mm² 报出来的**有偏低
  //     估计**（真件 200 vs 2022 mm²，差 10 倍）。现在全量三角面精确求和。
  //  2. 壁厚曾经接受任意命中当"对面壁"，一处 0.012mm² 的共面退化面因此报出
  //     0.17mm 的假壁。现在要求出射面法线与入射面反向（dot < −0.5）。
  //  3. 射线引擎整个不可用时（venv 缺 rtree），每根射线的异常都被吞掉，工具对
  //     任何零件都给"干净"结论。现在 wallMeasured=false 会显式报出来，且
  //     **未测到壁厚时永不返回 ok**。
  /**
   * The profile-aware manufacturing screen, as ONE job (DESIGN §25.7).
   *
   * WHY a job and not just a tool body: `preflight` must run the SAME screening as
   * `check_printability` — same profiles, same witnesses, same run record. The first cut
   * called the low-level engine directly, which does not even accept a profile: a caller
   * who declared `profileIds` got a verdict about the uncalibrated fallback, and the
   * printability run it created was missing, so the green could not back a claim
   * (2026-10-23 audit, FIX-B8). Extracting the body is what makes "same job" true.
   */
  async function screenVersionJob(
    a: {
      versionId: string; wallMinMm?: number; overhangDeg?: number; samples?: number;
      profileIds?: string[]; profilesJson?: string; mode?: string;
    },
    project: ProjectStores,
  ) {
    const store = project.store;
    const runStore = project.runStore;
    const resolved = await resolveProcessProfiles(a);
    if (resolved.errors.length > 0) {
      throw new Error(`invalid process profile:\n  - ${resolved.errors.join('\n  - ')}`);
    }
    // The shape the output schema declares. `excluded` carries witnesses; the other
    // value is `not-excluded` — never "ok", because "no counter-example found" is not
    // a statement that the part can be made.
    type ProfileEvaluation = {
      profileId: string;
      profileHash: string;
      verdict: 'excluded' | 'not-excluded';
      witnesses: { rule: string; measured: number; required: number; unit: string; locationMm?: number[] }[];
      notApplicable: string[];
      unevaluable: string[];
    };
    // Sealed cavities are needed only if some profile governs escape passages.
    // Fetched once, not per profile: the mesh does not change between profiles.
    const needsEscape = resolved.profiles.some((profile) =>
      profile.rules.escapePassageMinMm?.applies === true &&
      profile.rules.escapePassageMinMm.decidable === 'geometry');
    let voids: { volumeMm3: number; center: number[] }[] = [];
    if (needsEscape) {
      const modelPath = join(store.root, 'versions', a.versionId, 'model.stl');
      if (existsSync(modelPath)) {
        const cKey = versionCacheKey(store.root, a.versionId);
        let conn = connectivityCache.get(cKey);
        if (!conn) {
          conn = await (await ensurePythonWorker()).request<ConnectivitySolve>('connectivity', { path: modelPath });
          connectivityCache.set(cKey, conn);
        }
        voids = conn.voids ?? [];
      }
    }
    // CNC TOOL REACH. Circular bores are EXACT witnesses: a cutter of radius r cannot
    // enter a bore narrower than 2r, and a bore deeper than N diameters cannot be
    // drilled without the drill wandering. Non-circular slots and pockets need a voxel
    // reachability sweep, so they are DISCLOSED as not covered (see the finding below)
    // rather than quietly passed.
    const needsToolReach = resolved.profiles.some((profile) =>
      (profile.rules.toolRadiusMm?.applies === true && profile.rules.toolRadiusMm.decidable === 'geometry') ||
      (profile.rules.holeAspectMax?.applies === true && profile.rules.holeAspectMax.decidable === 'geometry'));
    // Draft is per-profile (each profile declares its own draftMinDeg), so unlike the
    // voids and bores above it is fetched INSIDE the loop.
    type DraftSolve = {
      coneEmpty: boolean;
      candidatesChecked: number;
      bestMarginDeg: number;
      bestWorstDraftDeg: number;
      feasiblePct: number;
      bestDirectionMm: number[];
      constrainingFaces: { atMm: number[]; draftAtBestDeg: number; deficitDeg: number; areaMm2: number; feasiblePctIfRelaxed: number }[];
    };
    // S2-b escape passages come from the same inventory: a HOLE in a face is an
    // opening, i.e. a passage. Round + through is EXACT (a detected circle's
    // diameter); anything else is reported as UNDETERMINED rather than passed —
    // see the loop. (A decorative blind depression must never exclude a part that
    // has a perfectly good drain hole elsewhere.)
    const escapeDeclared = resolved.profiles.some((profile) =>
      profile.rules.escapePassageMinMm?.applies === true && profile.rules.escapePassageMinMm.decidable === 'geometry');
    type HoleInfo = {
      // `diameterMm` is absent for a NON-CIRCULAR opening on purpose (list_features refuses to
      // invent a diameter for a shape a circle cannot describe). The escape rule used to filter
      // such holes out, which meant they were silently absent from the report rather than
      // reported as undetermined — measured 2026-10-13 on microscope4 v031: 32 of 53 openings
      // are non-circular, and none of them reached the rule. Now they stay, with `axisMm` and
      // `areaMm2` as what the passage bottleneck needs to be anchored.
      diameterMm?: number; through: boolean; depthMm?: number; kind?: string;
      centerMm: number[]; axisMm: number[]; areaMm2?: number; residualMm?: number;
    };
    let holes: HoleInfo[] = [];
    let bores: { diameterMm: number; lengthMm: number; centerMm: number[] }[] = [];
    const modelPath = join(store.root, 'versions', a.versionId, 'model.stl');
    if (needsToolReach || escapeDeclared) {
      if (existsSync(modelPath)) {
        const lfKey = versionCacheKey(store.root, a.versionId);
        const feats = (featureCache.get(lfKey) ?? await (await ensurePythonWorker()).request<{
          cylinders?: { kind?: string; diameterMm?: number; lengthMm?: number; centerMm?: number[] }[];
          faces?: { normalMm?: number[]; holes?: {
            kind?: string; diameterMm?: number; through?: boolean; depthMm?: number;
            centerMm?: number[]; areaMm2?: number; circularityResidualMm?: number;
          }[] }[];
        }>('list_features', { path: modelPath }).then((r) => {
          featureCache.set(lfKey, r);
          return r;
        })) as {
          cylinders?: { kind?: string; diameterMm?: number; lengthMm?: number; centerMm?: number[] }[];
          faces?: { normalMm?: number[]; holes?: { kind?: string; diameterMm?: number; through?: boolean; depthMm?: number; centerMm?: number[]; areaMm2?: number; circularityResidualMm?: number }[] }[];
        };
        bores = (feats.cylinders ?? [])
          .filter((c) => c.kind === 'bore' && typeof c.diameterMm === 'number' && typeof c.lengthMm === 'number')
          .map((c) => ({ diameterMm: c.diameterMm!, lengthMm: c.lengthMm!, centerMm: c.centerMm ?? [] }));
        holes = (feats.faces ?? []).flatMap((f) => {
          const axis = Array.isArray(f.normalMm) ? f.normalMm : null;
          if (!axis) return [];
          // A hole with neither a centre nor a face normal cannot be anchored later, so that is
          // the only kind dropped here. Circularity is NOT a filter any more (see HoleInfo).
          return (f.holes ?? [])
            .filter((h) => Array.isArray(h.centerMm))
            .map((h) => ({
              diameterMm: h.diameterMm, through: h.through === true, depthMm: h.depthMm,
              kind: h.kind, centerMm: h.centerMm ?? [], axisMm: axis,
              areaMm2: h.areaMm2, residualMm: h.circularityResidualMm,
            }));
        });
      }
    }
    const marginalNotes: string[] = [];
    const undeterminedNotes: string[] = [];
    const evaluations: ProfileEvaluation[] = [];
    let base: Awaited<ReturnType<typeof checkPrintability>> | null = null;
    for (const profile of resolved.profiles) {
      // The profile's OWN numbers drive the same measurement — that is the point:
      // the threshold stops being a literal and becomes a declared claim.
      const rules = evaluableRules(profile);
      const wall = rules.find((r) => r.rule === 'wallMinMm');
      const overhang = rules.find((r) => r.rule === 'overhangDeg');
      // `withSampleField` is what makes the heatmap POSSIBLE: the tool persists a run
      // carrying the per-sample values, and the panel draws those. Without it the
      // panel's /api/cad/attention finds no field and the 🔥 button does nothing —
      // which is exactly how the first version shipped (the option existed, the
      // caller never asked for it).
      const screen = await checkPrintability(store, {
        versionId: a.versionId,
        wallMinMm: wall?.value ?? a.wallMinMm,
        overhangDeg: overhang?.value ?? a.overhangDeg,
        samples: a.samples,
        withSampleField: true,
      });
      base = base ?? screen;
      const { notApplicable, unevaluable } = disclosureLists(profile);
      const witnesses: ProfileEvaluation['witnesses'] = [];
      // Only a HARD constraint excludes. A too-steep overhang needs supports; it does
      // not make the part impossible, so it stays a finding, not a witness.
      if (wall && screen.wallMeasured && screen.minWallMm !== undefined && violatesRule(screen.minWallMm, wall)) {
        witnesses.push({
          rule: 'wallMinMm',
          measured: screen.minWallMm,
          required: wall.value,
          unit: 'mm',
          ...(screen.minWallAtMm ? { locationMm: screen.minWallAtMm } : {}),
        });
      }
      // A sealed cavity is the one escape-passage witness a mesh can PROVE: there is
      // no passage at all, so its size is 0. A passage that merely looks narrow from
      // outside cannot be proved — the tunnel interior is not measured — so that case
      // is disclosed as not-checked rather than passed (see the finding below).
      const escape = profile.rules.escapePassageMinMm;
      if (escape?.applies === true && escape.decidable === 'geometry' && typeof escape.value === 'number') {
        for (const void_ of voids) {
          witnesses.push({
            rule: 'escapePassageMinMm',
            measured: 0,
            required: escape.value,
            unit: 'mm',
            locationMm: void_.center,
          });
        }
      }
      const escapeRule = profile.rules.escapePassageMinMm;
      if (escapeRule?.applies === true && escapeRule.decidable === 'geometry' && typeof escapeRule.value === 'number') {
        for (const hole of holes) {
          const where = JSON.stringify(hole.centerMm);
          if (hole.kind !== undefined && hole.kind !== 'round') {
            if (!hole.through) {
              undeterminedNotes.push(
                `排粉/排液通道 @ ${where} 是非圆截面盲特征（kind=${hole.kind}）：` +
                '盲特征是否积粉/积树脂无法仅由几何证明 —— 该处**未判定**，不是通过。',
              );
              continue;
            }
            // Non-circular + through: the width is now MEASURABLE — the bottleneck of the one
            // passage this opening names, as the smallest maximum-inscribed-circle over
            // transverse sections (worker op `passage_bottleneck`, anchored at this opening).
            // Anchoring is not optional: on the same plane a wide passage masks a narrow one
            // (measured: two parallel through holes Ø6 and Ø1, a global sweep reads 2.996 while
            // the tightest passage is 0.500).
            const passage = await (await ensurePythonWorker()).request<{
              reachable?: boolean; throughAlongAxis?: boolean; bottleneckRadiusMm?: number | null;
              tightestAtMm?: number[]; sectionsAccepted?: number; cuts?: number;
              coveredMm?: number[]; micToleranceMm?: number; stepMm?: number;
              endConditions?: Record<string, string>; refused?: string;
            }>('passage_bottleneck', {
              path: modelPath,
              fromMm: hole.centerMm,
              fromAxis: hole.axisMm,
              fromSizeMm: Math.sqrt(Math.max(hole.areaMm2 ?? 1, 1e-6)),
              budget: 200,
            });
            const radiusMm = passage.bottleneckRadiusMm;
            if (passage.reachable === true && passage.throughAlongAxis === true
              && typeof radiusMm === 'number') {
              // Same rule as the round branch: the uncertainty is the measurement's own
              // resolution, never an invented tolerance.
              const noise = Math.max(passage.micToleranceMm ?? 0, 0.01);
              const requiredRadius = escapeRule.value / 2;
              if (radiusMm < requiredRadius - noise) {
                witnesses.push({
                  rule: 'escapePassageMinMm',
                  measured: +(2 * radiusMm).toFixed(3),
                  required: escapeRule.value,
                  unit: 'mm',
                  locationMm: passage.tightestAtMm ?? hole.centerMm,
                });
              } else if (radiusMm <= requiredRadius + noise) {
                marginalNotes.push(
                  `排粉/排液通道余量过小（记为困难，不是通过）：非圆截面 @ ${where}，` +
                  `量得瓶颈 Ø${(2 * radiusMm).toFixed(3)}，要求 Ø${escapeRule.value}，` +
                  `余量 ${(2 * radiusMm - escapeRule.value).toFixed(3)}mm（≤ ${noise}mm）。`,
                );
              }
              continue;
            }
            undeterminedNotes.push(
              `排粉/排液通道 @ ${where} 是非圆截面通道（kind=${hole.kind}）：` +
              `量宽未成功（${passage.refused ? passage.refused.slice(0, 120) : '走查未覆盖整条通路'}）` +
              `${typeof passage.sectionsAccepted === 'number' ? `；已取得 ${passage.sectionsAccepted} 个截面` : ''} ` +
              '—— 该处**未判定**，不是通过。',
            );
            continue;
          }
          if (!hole.through) {
            // A BLIND feature. Whether it traps powder/resin is not a geometric
            // fact we can prove: a shallow dish drains, a deep well traps, and the
            // depth criterion (can the constriction be enumerated?) says we cannot
            // claim either. So it is UNDETERMINED — never a pass, and crucially
            // never an exclusion, or a cosmetic dimple would condemn a part whose
            // real drain hole is fine.
            undeterminedNotes.push(
              `排粉/排液通道 @ ${where} 是盲特征（Ø${hole.diameterMm}，深 ${hole.depthMm ?? '未知'}）：` +
              '盲特征是否积粉/积树脂无法仅由几何证明（只有可穷举的短颈才可判）—— 该处**未判定**，不是通过。',
            );
            continue;
          }
          // Round + through: EXACT. The uncertainty is the circle-fit residual, not
          // an invented tolerance — same rule as the voxel pitch elsewhere.
          if (typeof hole.diameterMm !== 'number') {
            // Cannot happen for a round hole (list_features sets the diameter only when the loop
            // fits a circle), but a missing diameter must never become a silent pass.
            undeterminedNotes.push(
              `排粉/排液通道 @ ${where} 没有直径（kind=${hole.kind ?? 'unknown'}）：**未判定**，不是通过。`,
            );
            continue;
          }
          const noise = Math.max(hole.residualMm ?? 0, 0.01);
          const radiusMm = hole.diameterMm / 2;
          const requiredRadius = escapeRule.value / 2;
          if (radiusMm < requiredRadius - noise) {
            witnesses.push({
              rule: 'escapePassageMinMm',
              measured: +hole.diameterMm.toFixed(3),
              required: escapeRule.value,
              unit: 'mm',
              locationMm: hole.centerMm,
            });
          } else if (radiusMm <= requiredRadius + noise) {
            marginalNotes.push(
              `排粉/排液通道余量过小（记为困难，不是通过）：Ø${hole.diameterMm} @ ${where}，` +
              `要求 Ø${escapeRule.value}，余量 ${(hole.diameterMm - escapeRule.value).toFixed(3)}mm ` +
              `（≤ ${noise}mm = 圆度拟合残差）。`,
            );
          }
        }
      }
      const draftRule = profile.rules.draftMinDeg;
      if (draftRule?.applies === true && draftRule.decidable === 'geometry' && typeof draftRule.value === 'number') {
        const modelPath = join(store.root, 'versions', a.versionId, 'model.stl');
        if (existsSync(modelPath)) {
          const solved = await (await ensurePythonWorker()).request<{ draft?: DraftSolve }>('check_printability', {
            path: modelPath, samples: a.samples, draftMinDeg: draftRule.value,
          });
          const dr = solved.draft;
          if (dr) {
            if (dr.coneEmpty) {
              // EXACT: no draw direction satisfies every face. The measured value is
              // the best achievable worst-face draft, so the witness says how far off
              // it is, and the location is a face that cannot make it.
              witnesses.push({
                rule: 'draftMinDeg',
                measured: dr.bestWorstDraftDeg,
                required: draftRule.value,
                unit: 'deg',
                ...(dr.constrainingFaces?.[0]?.atMm ? { locationMm: dr.constrainingFaces[0].atMm } : {}),
              });
            } else if (typeof dr.bestMarginDeg === 'number' && dr.bestMarginDeg <= 0.5) {
              // NOT a pass. Zero/near-zero margin is recorded as difficult
              // (DECISION-LOG 2026-10-11): the 0.5 deg band is the normal-bucketing
              // resolution, not an invented shop constant.
              marginalNotes.push(
                `拔模余量过小（记为困难，不是通过）：最佳抽芯方向下的最差面拔模 ${dr.bestWorstDraftDeg}°，` +
                `要求 ${draftRule.value}°，余量 ${dr.bestMarginDeg}°（≤ 0.5° = 法线分桶分辨率）。` +
                (dr.constrainingFaces?.length
                  ? `收紧它的面在 ${JSON.stringify(dr.constrainingFaces[0].atMm)}（该面拔模 ${dr.constrainingFaces[0].draftAtBestDeg}°，` +
                    `单独放宽后可行域可到 ${dr.constrainingFaces[0].feasiblePctIfRelaxed}%）。`
                  : ''),
              );
            }
          }
        }
      }
      const toolRadius = profile.rules.toolRadiusMm;
      if (toolRadius?.applies === true && toolRadius.decidable === 'geometry' && typeof toolRadius.value === 'number') {
        for (const bore of bores) {
          const radiusMm = bore.diameterMm / 2;
          if (violatesRule(radiusMm, toolRadius as { value: number; direction: 'min' | 'max' })) {
            witnesses.push({
              rule: 'toolRadiusMm',
              measured: +radiusMm.toFixed(3),
              required: toolRadius.value,
              unit: 'mm',
              locationMm: bore.centerMm,
            });
          }
        }
      }
      const holeAspect = profile.rules.holeAspectMax;
      if (holeAspect?.applies === true && holeAspect.decidable === 'geometry' && typeof holeAspect.value === 'number') {
        for (const bore of bores) {
          if (bore.diameterMm <= 0) continue;
          const aspect = bore.lengthMm / bore.diameterMm;
          if (violatesRule(aspect, holeAspect as { value: number; direction: 'min' | 'max' })) {
            witnesses.push({
              rule: 'holeAspectMax',
              measured: +aspect.toFixed(2),
              required: holeAspect.value,
              unit: 'ratio',
              locationMm: bore.centerMm,
            });
          }
        }
      }
      evaluations.push({
        profileId: profile.id,
        profileHash: profileHash(profile),
        verdict: witnesses.length > 0 ? 'excluded' : 'not-excluded',
        witnesses,
        notApplicable: notApplicable.map((r) => `${r.rule}: ${r.reason}`),
        unevaluable: unevaluable.map((r) => `${r.rule} (${r.decidable}): ${r.reason}`),
      });
    }
    const findings = [...(base?.findings ?? []), ...marginalNotes, ...undeterminedNotes];
    // Disclose the coverage gap ONLY where the tool-radius rule is declared. A profile
    // that merely caps hole aspect (FDM does — a deep narrow hole is a printing
    // problem too) is not making a claim about cutters, and a coverage note there
    // would be noise in `findings`, which must stay about the geometry.
    const toolReachDeclared = resolved.profiles.some((profile) =>
      profile.rules.toolRadiusMm?.applies === true && profile.rules.toolRadiusMm.decidable === 'geometry');
    if (toolReachDeclared) {
      findings.push(
        `刀具可达性：只检查了 ${bores.length} 个**圆孔**（直径与深度是精确值）。` +
        '非圆形的槽/窄凹腔需要体素可达性扫描，**本次未覆盖**——它们若窄于刀具直径，本报告不会发现；' +
        '所以这里的"未排除"不等于"能加工"。',
      );
    }
    if (needsEscape && voids.length === 0) {
      findings.push(
        '排粉/排液通道：未发现**封闭内腔**（无负体积壳）。注意这只否决了"完全封死"这一种情况——' +
        '**通道内部的截面没有被测量**，所以"有通道但中途变细"无法在此被证明，也不构成通过。',
      );
    }
    let verdict = base!.verdict;
    if (resolved.source === 'builtin-default') {
      const p = resolved.profiles[0]!;
      findings.push(
        `未声明工艺档案 —— 按内建默认档 "${p.id}"（hash ${profileHash(p)}）评估。` +
        '该档每一个数都是 assumed（从未按任何机器标定），**它是让继承来的默认值可见，不是推荐**。' +
        '要按真实工艺判断，请声明 profileIds 或 profilesJson。',
      );
      // "not-excluded" would claim the part passed a process the caller never named.
      // The geometry may be fine; the DECLARATION is missing, so the honest verdict is
      // `difficult`. Declaring a profile is what turns this into a pass.
      // (This guard used to test for the literal 'ok'; when the values were renamed it
      // silently stopped firing — caught by accept-p3.)
      if (verdict === 'not-excluded') verdict = 'difficult';
    }
    // A margin inside the instrument's noise is 'difficult', never a pass — and putting
    // it only in `findings` left the VERDICT saying not-excluded (2026-10-23 audit,
    // FIX-B2). Friendly escape-passage and draft checks both write `marginalNotes`.
    if (marginalNotes.length > 0 && verdict === 'not-excluded') {
      verdict = 'difficult';
      findings.push('余量落在测量噪声以内 —— 判定降为「困难」，不是通过（见上面每条的余量与分辨率）。');
    }
    const result = { ...base!, verdict, findings, profileSource: resolved.source, profiles: evaluations };

    // The attention field is also a PRODUCT, not just a reply: the panel draws it as a
    // heatmap, and a picture needs the per-sample values that would be noise in the
    // model's context. They travel in the run; the reply carries the digest only.
    const { field, ...forModel } = result as typeof result & { field?: AttentionFieldSamples };
    let runId: string | undefined;
    if (field) {
      const run = await beginRun(runStore, {
        kind: 'printability',
        title: `制造筛查 · ${a.versionId} · ${verdict}`,
      });
      runId = run.id;
      await run.json('report.json', forModel);
      await run.json('attention.json', {
        id: forModel.attention.id,
        versionId: a.versionId,
        normalization: field.normalization,
        samples: field.samples,
      });
      await run.commit({
        status: verdict === 'not-excluded' ? 'pass' : verdict === 'excluded' ? 'fail' : 'check',
        judgement: verdict,
        summary: `悬垂 ${forModel.overhangAreaMm2}mm² · 最薄 ${forModel.minWallMm ?? '—'}mm · 可疑处 ${forModel.attention.layers.reduce((n, l) => n + l.peaks.length, 0)}`,
        title: `制造筛查 · ${a.versionId}`,
        sourceVersionIds: [a.versionId],
        subject: `printability:${a.versionId}`,
      });
    }
    // DESIGN §25.7: the two channels are separated STRUCTURALLY in the REPLY. The run
    // keeps both halves — trimming the record would make the panel lose the field
    // whenever the model happened to ask for judge.
    const mode = a.mode ?? 'judge';
    const reply: Record<string, unknown> = { ...forModel };
    if (mode === 'scan') {
      delete reply.verdict;
      delete reply.profiles;
      delete reply.profileSource;
    }
    if (mode === 'judge') {
      delete reply.attention;
      // HARNESS §11.14: a verdict without a place is the failure this whole lane exists to
      // prevent. The field is trimmed (it is a picture, not context), so the reply carries
      // runnable next observations instead of an empty space (2026-10-23 audit, FIX-B3).
      reply.nextLook = nextLookFor({ source: 'printability', versionId: a.versionId, judgement: verdict });
    }
    // The output schema now allows per-layer region extras (triangles/samples/…),
    // so its inferred type carries an index signature the typed layers lack.
  return { reply, report: forModel, field, verdict, profileSource: forModel.profileSource, findings: forModel.findings, runId };
  }

  registerTool(defineTool({
    name: 'check_printability',
    description:
      // The field list lives in the output schema below, and the profile contract lives in
      // the cad-manufacturing skill (loaded on demand). What stays HERE is what a caller
      // must know at call time — every token in a tool description is paid on EVERY
      // request, while the skill is not (DESIGN §31.4 / DESIGN 13.12).
      'Manufacturability screen for a saved version: sampled wall thickness (ray to the opposite wall along the inward normal) plus exact down-facing area steeper than the overhang angle. The wall half is SAMPLED (a thin feature between samples is missed); the overhang area is exact. If wallMeasured is false the ray half measured nothing, so the verdict is never "ok". Run it before delivering and after any wall/angle-changing edit. ' +
      'Judge against a DECLARED process via `profileIds` (e.g. ["fdm-pla-0.4"]) or `profilesJson`: each profile returns "excluded" (with a witness: rule, location, measured vs required) or "not-excluded" — NOT-EXCLUDED IS NOT "CAN BE MADE". It never ranks or recommends. With no profile it uses a named built-in fallback (all numbers `assumed`) and downgrades ok to check. Authoring a profile: cad-manufacturing skill. ' +
      'JUDGEMENT vs DETECTION: this tool produces both halves; pass `mode` to get one. A green verdict says nothing about where to look, and the attention field is not a verdict (DESIGN §25.7).',
    parameters: {
      mode: {
        type: 'string',
        enum: ['judge', 'scan', 'both'],
        description: '"judge" (default) returns ONLY the judgement half (verdict / findings / profiles, no attention field); "scan" returns ONLY the attention field and NO verdict, because a risk map must never be read as a gate; "both" returns the two halves as separate keys. The run ALWAYS records both halves (report.json + attention.json) — the mode trims the reply, not the record (DESIGN §25.7).',
      },
      versionId: { type: 'string', required: true, description: 'Saved version id to screen, e.g. "v012".' },
      wallMinMm: { type: 'number', description: 'Wall thinner than this is reported. Default 1.2 (≈2× a 0.4mm nozzle line width).' },
      overhangDeg: {
        type: 'number',
        description: 'A down-facing face tilted more than this many degrees from vertical counts as needing support. Default 45.',
      },
      samples: { type: 'number', description: 'Approximate surface samples. Default 600; raise for big meshes, lower for quick passes.' },
      profileIds: { type: 'array', items: { type: 'string' }, description: 'Shipped process profiles to judge against, e.g. ["fdm-pla-0.4"]. Each yields its own two-valued verdict. Omit (with profilesJson) to use the built-in fallback, which the report then names.' },
      profilesJson: { type: 'string', description: 'An inline JSON array of process profiles (schema: schemas/process-profile.schema.json). Use for a profile you authored; an invalid one is REFUSED with the offending rule named.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          nextLook: {
            type: 'array',
            description: 'Present in judge mode: RUNNABLE next observations ({tool, args, why}) — judge trims the per-sample field on purpose, so the verdict must still say where to look (HARNESS §11.14).',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                tool: { type: 'string', required: true },
                args: { type: 'object', required: true, additionalProperties: true },
                why: { type: 'string', required: true },
              },
            },
          },
          // verdict / attention / profiles / profileSource are MODE-TRIMMED below
          // (judge drops attention; scan drops verdict+profiles+profileSource).
          // A static required list would reject every trimmed reply — that is how
          // all three modes came to fail at once. The run record keeps both halves.
          verdict: { type: 'string', description: '"not-excluded" | "difficult" | "excluded" (absent in scan mode; canonical since 2026-10-20, was ok/check/unprintable). "not-excluded" is impossible when wallMeasured is false, and it never means "safe".' },
          minWallMm: { type: 'number' },
          wallMeasured: { type: 'boolean', required: true, description: 'False = the ray half measured nothing (typically a broken ray engine). Never trust the rest of the report then, and never read it as a pass.' },
          thinSamples: { type: 'number', required: true },
          sampled: { type: 'number', required: true },
          thinAreaMm2: { type: 'number', required: true, description: 'Area of the sub-threshold region, scaled from the sample to the whole surface.' },
          thinAreaPct: { type: 'number', required: true, description: 'That area as a % of the whole surface — a thin SHELL spans a lot of it, a blunt edge only a strip.' },
          surfaceAreaMm2: { type: 'number', required: true, description: 'Measured surface area; sqrt(area / sampled) is the sampling spacing, i.e. the smallest wall difference this screen can resolve (the band width, DESIGN §27.4).' },
          overhangAreaMm2: { type: 'number', required: true, description: 'Exact: summed over every triangle, not sampled.' },
          overhangZRange: { type: 'array', items: { type: 'number' } },
          findings: { type: 'array', required: true, items: { type: 'string' } },
          minWallAtMm: { type: 'array', items: { type: 'number' }, description: 'Where the thinnest wall was found — the witness a human can go and look at.' },
          watertight: { type: 'boolean', required: true },
          attention: {
            type: 'object', additionalProperties: false,
            description: 'Where to LOOK, not what to conclude (absent in judge mode): one field per quantity (wall thickness, down-facing area), each with peaks, regions and a runnable next observation. The panel draws each layer as a heatmap from the same object — the picture and this digest cannot drift apart. Read an empty layer as "nothing found here", never as "clean".',
            properties: {
              id: { type: 'string', required: true, description: 'version + tool + parameters: a picture may not outlive the geometry it describes.' },
              layers: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true, description: '"wall" | "overhang".' },
                    quantity: { type: 'string', required: true, description: 'The physical quantity, named honestly: "wall-thickness", not "stress".' },
                    units: { type: 'string', required: true },
                    direction: { type: 'string', required: true, description: 'How to read the colour ramp, e.g. "smaller-is-worse".' },
                    domain: { type: 'object', required: true, additionalProperties: true },
                    normalization: { type: 'object', required: true, additionalProperties: true, description: 'Where the colour scale comes from: absolute thresholds and their source. Without it a heatmap is decoration.' },
                    stats: { type: 'object', required: true, additionalProperties: true },
                    peaks: {
                      type: 'array', required: true,
                      description: 'Local extremes, few and precise — the index into the picture.',
                      items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                          atMm: { type: 'array', required: true, items: { type: 'number' } },
                          value: { type: 'number', required: true },
                          normalMm: { type: 'array', items: { type: 'number' } },
                          evidence: { type: 'string', required: true },
                          probe: {
                            type: 'object', required: true, additionalProperties: false,
                            properties: {
                              tool: { type: 'string', required: true },
                              args: { type: 'object', required: true, additionalProperties: true, description: 'Ready to pass to that tool (versionId already filled in).' },
                            },
                          },
                        },
                      },
                    },
                    regions: {
                      type: 'array', required: true,
                      description: 'Connected areas above a tier, with a bbox and a ready render command.',
                      items: {
                        // Per-layer extras are part of the answer: `triangles` on an
                        // overhang patch, `samples`/`minWallMm` on a wall patch. A
                        // closed list rejected the field it was describing.
                        type: 'object', additionalProperties: true,
                        properties: {
                          tier: { type: 'string', required: true, description: '"warn" | "bad".' },
                          areaMm2: { type: 'number', required: true },
                          atMm: { type: 'array', required: true, items: { type: 'number' } },
                          bboxMm: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
                          look: {
                            type: 'object', required: true, additionalProperties: false,
                            properties: {
                              tool: { type: 'string', required: true },
                              args: { type: 'object', required: true, additionalProperties: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          profileSource: { type: 'string', description: '"declared" | "builtin-default" (absent in scan mode). The latter means NO process was declared: the numbers come from an uncalibrated fallback that the findings name.' },
          profiles: {
            type: 'array',
            description: 'One entry per declared profile (or the single built-in fallback; absent in scan mode). Two-valued on purpose: "excluded" carries a witness, "not-excluded" means no geometric counter-example was found.',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                profileId: { type: 'string', required: true },
                profileHash: { type: 'string', required: true, description: 'Content hash — a verdict without its premise is not evidence.' },
                verdict: { type: 'string', required: true, description: '"excluded" | "not-excluded" (never "ok", never a ranking).' },
                witnesses: {
                  type: 'array', required: true,
                  description: 'Why it is excluded. A rule plus a location is a witness; a bare number is an argument.',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      rule: { type: 'string', required: true },
                      measured: { type: 'number', required: true },
                      required: { type: 'number', required: true },
                      unit: { type: 'string', required: true },
                      locationMm: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
                notApplicable: { type: 'array', required: true, items: { type: 'string' }, description: 'Rules this process does not govern, with the reason. Never silently dropped: calling an SLS part overhang "needs support" is wrong, not conservative.' },
                unevaluable: { type: 'array', required: true, items: { type: 'string' }, description: 'Rules a tool cannot decide from the mesh (cost, tolerance capability) or that were never declared. A missing number is not "no constraint".' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 180_000,
    async execute(args: unknown, exec: unknown) {
      const job = await screenVersionJob(args as never, await allStores(exec));
      return job.reply as never;
    },
  }));

  // --- check_parts: screen a family in ONE call -------------------------------
  //
  // The glucose build made 11 measure_part + 22 check_printability calls for 7
  // parts (three printability rounds). Every call is a model step; the per-part
  // replies are also mostly repeated keys. This tool loops the SAME jobs the
  // single-part tools run — `measureVersion` and `screenVersionJob` — and returns
  // one compact table. The printability half writes one run per version (the
  // `runId` comes back), so a batch screen is evidence, not a shortcut around it.
  registerTool(defineTool({
    name: 'check_parts',
    description:
      'Screen up to 12 saved versions in ONE call: per version, the measure half (watertight / bodies / volume / bbox) and the SAME profile-aware printability job as check_printability. ' +
      'The printability half writes one printability run per version and returns its runId, so the rows can back a delivery claim; there is no second implementation. ' +
      'Use it to screen a family (which of these 7 is thin?) instead of N single calls; for one part the single tool is equivalent. ' +
      '`checks` defaults to both halves. The reply is deliberately compact — run the single-part tool when you need the full findings/attention for one part.',
    parameters: {
      versionIds: {
        type: 'array', required: true, items: { type: 'string' },
        description: 'Versions to screen, e.g. ["v031","v032","v033"]. Duplicates are removed; at most 12 are screened per call.',
      },
      checks: {
        type: 'array', items: { type: 'string' },
        description: 'Which halves to run: "measure" and/or "printability". Default both.',
      },
      profileIds: { type: 'array', items: { type: 'string' }, description: 'Shipped process profiles for the printability half, e.g. ["fdm-pla-0.4"]. Omit to use the built-in fallback (which downgrades a pass, as in check_printability).' },
      wallMinMm: { type: 'number', description: 'Wall thinner than this is reported (printability half). Default 1.2.' },
      overhangDeg: { type: 'number', description: 'Down-facing faces steeper than this count as overhang (printability half). Default 45.' },
      samples: { type: 'number', description: 'Approximate surface samples for the wall half. Default 600.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          parts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                versionId: { type: 'string', required: true },
                partName: { type: 'string' },
                watertight: { type: 'boolean' },
                bodies: { type: 'integer' },
                volumeMm3: { type: 'number' },
                sizeMm: { type: 'array', items: { type: 'number' } },
                printability: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    verdict: { type: 'string', required: true },
                    minWallMm: { type: 'number' },
                    minWallAtMm: { type: 'array', items: { type: 'number' } },
                    thinAreaPct: { type: 'number' },
                    overhangAreaMm2: { type: 'number' },
                    profiles: {
                      type: 'array',
                      items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                          profileId: { type: 'string', required: true },
                          verdict: { type: 'string', required: true },
                        },
                      },
                    },
                    wallMeasured: { type: 'boolean' },
                    runId: { type: 'string', description: 'The printability run this row wrote — cite it as evidence.' },
                  },
                },
              },
            },
          },
          failures: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                versionId: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          summary: {
            type: 'object', additionalProperties: false,
            properties: {
              requested: { type: 'integer', required: true },
              ok: { type: 'integer', required: true },
              failed: { type: 'integer', required: true },
              thinnestMm: { type: 'number' },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 180_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionIds?: string[]; checks?: string[]; profileIds?: string[];
        wallMinMm?: number; overhangDeg?: number; samples?: number;
      };
      const ids = [...new Set((a.versionIds ?? []).filter((id) => typeof id === 'string' && id.trim()))].slice(0, 12);
      if (ids.length === 0) throw new Error('versionIds must name at least one saved version');
      const checks = new Set((a.checks?.length ? a.checks : ['measure', 'printability'])
        .filter((c) => c === 'measure' || c === 'printability'));
      if (checks.size === 0) throw new Error('checks must include "measure" and/or "printability"');
      const project = await allStores(exec);
      const cad = storeFor(project);
      const parts: Record<string, unknown>[] = [];
      const failures: { versionId: string; error: string }[] = [];
      for (const versionId of ids) {
        try {
          const resolved = await cad.resolve(versionId);
          const partName = resolved?.kind === 'version' ? resolved.partName ?? undefined : undefined;
          const row: Record<string, unknown> = { versionId, ...(partName ? { partName } : {}) };
          if (checks.has('measure')) {
            const m = await measureVersion(project.store, versionId);
            row.watertight = m.watertight;
            // Body count is the connectivity op's, not the mass-properties op's:
            // it must survive a broken mesh (the measure op refuses an open one).
            const modelPath = join(project.store.root, 'versions', versionId, 'model.stl');
            const cKey = versionCacheKey(project.store.root, versionId);
            let conn = connectivityCache.get(cKey);
            if (!conn) {
              conn = await (await ensurePythonWorker()).request<ConnectivitySolve>('connectivity', { path: modelPath });
              connectivityCache.set(cKey, conn);
            }
            row.bodies = conn.count;
            if (m.volumeMm3 !== undefined) row.volumeMm3 = m.volumeMm3;
            row.sizeMm = m.boundingBoxMm.size;
          }
          if (checks.has('printability')) {
            const screened = await screenVersionJob({
              versionId,
              ...(a.profileIds?.length ? { profileIds: a.profileIds } : {}),
              ...(a.wallMinMm !== undefined ? { wallMinMm: a.wallMinMm } : {}),
              ...(a.overhangDeg !== undefined ? { overhangDeg: a.overhangDeg } : {}),
              ...(a.samples !== undefined ? { samples: a.samples } : {}),
            }, project);
            const report = screened.report;
            row.printability = {
              verdict: screened.verdict,
              ...(report.minWallMm !== undefined ? { minWallMm: report.minWallMm } : {}),
              ...(report.minWallAtMm ? { minWallAtMm: report.minWallAtMm } : {}),
              ...(report.thinAreaPct !== undefined ? { thinAreaPct: report.thinAreaPct } : {}),
              ...(report.overhangAreaMm2 !== undefined ? { overhangAreaMm2: report.overhangAreaMm2 } : {}),
              ...(report.profiles?.length
                ? { profiles: report.profiles.map((p) => ({ profileId: p.profileId, verdict: p.verdict })) }
                : {}),
              wallMeasured: report.wallMeasured,
              ...(screened.runId ? { runId: screened.runId } : {}),
            };
          }
          parts.push(row);
        } catch (e) {
          failures.push({ versionId, error: String((e as Error).message ?? e) });
        }
      }
      const thinnest = parts
        .map((p) => (p.printability as { minWallMm?: number } | undefined)?.minWallMm)
        .filter((v): v is number => typeof v === 'number')
        .sort((x, y) => x - y)[0];
      return {
        parts, failures,
        summary: {
          requested: ids.length, ok: parts.length, failed: failures.length,
          ...(thinnest !== undefined ? { thinnestMm: thinnest } : {}),
        },
      } as never;
    },
  }));

  // --- simulate_stress: 内部应力的"注意力场"（DECISION-LOG 2026-10-19）--------
  //
  // 与 check_printability 共用 attention 形状：同一个场对象既画热力图、也给 LLM 读
  // （图与 JSON 同源，不许各说一套）。能力边界写死在描述里（DESIGN §25.2 要求 1），
  // 因为 2026-10-08 的探针测出这条车道的两半极不对称：积分量精确、热点位置可用，
  // 而"取最大单元应力"在加密下发散（圆孔 1.002→1.184，①填充比加权也救不了）。
  // 求解器在 python/cad_worker/stress_fem.py；本工具的产出里**没有**那个字段。
  registerTool(defineTool({
    name: 'simulate_stress',
    description:
      'Static linear-elastic stress of a saved version (voxel hex8 FEM, matrix-free CG). You must declare the CASE — material, supports and loads — because "the stress" without one is not a number. ' +
      'TRUST from this tool: the integrals (reaction, section force/moment, compliance, strain energy), the hot-spot LOCATIONS, and the surface stress recovered by extrapolating the depth profile inward from each hot spot. ' +
      'DO NOT ASK IT FOR "the largest element stress": there is no such field, because on a curved or notched boundary it grows without bound under refinement (measured 1.002 → 1.184, and fill-ratio weighting did not fix it). ' +
      'DO NOT read a tier or a peak as a safety factor: the model is isotropic, so an FDM part\'s layer-direction weakness — usually what breaks first — is invisible to it. ' +
      'Peaks are read at `criticalDistanceMm` inside the surface (a declared distance; the distance actually used comes back as effectiveSampleDistanceMm) — that declared-distance reading is the number to quote. A region\'s `surfaceExtrapolatedMPa` (the depth profile fitted out to the surface) is a HIGHER estimate and is only quoted when it passes BOTH its own fit check and a cross-resolution check (`extrapolationCrossResolutionPct`), because a good fit R^2 is not sufficient: on a fillet the fit looked fine (R^2 0.90) while the value moved 17% between grids. Every region also carries the wall thickness it tunnels through in cells and a `trustworthy` flag with `whyUntrustworthy`; an untrustworthy region means the position/value may not be quoted — refine dxMm. ' +
      'Deliver against `delivery` (excluded / difficult / not-excluded, with witnesses), NOT against `verdict`: a missing number is not a pass, and the geometry suspects in `attention` are DETECTION (where to look), never delivery evidence. ' +
      'THIS TOOL IS NEVER SILENT: when it cannot certify any region it still returns a `geometry-suspects` layer — the reentrant corners already known from the geometry scan, labelled as geometry and NOT as stress — so a run always says where to look next (HARNESS §11.14). ' +
      'A part whose members are thinner than the voxel cannot be certified at any affordable dxMm — the report then says so (verdict check, zero trustworthy regions) instead of drawing an authoritative-looking heatmap. ' +
      'Run it once per load case, and again after any change to the material, the supports or the geometry: comparing two versions under the SAME case is the re-check.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version id to analyse, e.g. "v050".' },
      loads: {
        type: 'array',
        required: true,
        description: 'The load case. Each entry is a force in N applied either to a whole bounding-box face or to the nodes within radiusMm of atMm.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            forceN: { type: 'array', required: true, items: { type: 'number' }, description: 'Force [fx,fy,fz] in N (mm / N / MPa units throughout).' },
            face: {
              type: 'object', additionalProperties: false,
              description: 'Spread the force over a bounding-box face, e.g. a weight sitting on a pan.',
              properties: {
                axis: { type: 'string', required: true, description: 'x | y | z' },
                side: { type: 'string', description: '"min" (default) or "max".' },
              },
            },
            atMm: { type: 'array', items: { type: 'number' }, description: 'Apply near this point in mm instead of on a face.' },
            radiusMm: { type: 'number', description: 'Radius around atMm that shares the force. Default 1.5 cells.' },
          },
        },
      },
      supports: {
        type: 'array',
        description: 'Where the part is held. A face locks the outermost node layer; atMm locks the nodes within radiusMm (e.g. a knife edge resting on a pin). An unsupported load is a rigid-body mode and is REFUSED, not fudged.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            face: {
              type: 'object', additionalProperties: false,
              properties: {
                axis: { type: 'string', required: true, description: 'x | y | z' },
                side: { type: 'string', description: '"min" (default) or "max".' },
              },
            },
            atMm: { type: 'array', items: { type: 'number' }, description: 'Lock the nodes near this point.' },
            radiusMm: { type: 'number', description: 'Radius around atMm. Default 1.5 cells.' },
          },
        },
      },
      mode: {
        type: 'string',
        enum: ['judge', 'scan', 'both'],
        description: '"judge" (default) returns ONLY the delivery judgement; "scan" returns ONLY the attention field and NO verdict, because a risk map must never be read as a gate; "both" returns the two halves as separate keys. The default is the stricter half (DESIGN §25.7).',
      },
      excludeFromReport: {
        type: 'array',
        description: 'Cells to drop from the reported field, peaks, regions and percentiles — for SUPPORT and LOAD patches, whose stress is an artifact of the idealisation (a clamped patch is not a knife edge on a pin). The excluded cell count comes back in method.excludedCells, so the exclusion is declared rather than silent.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            atMm: { type: 'array', required: true, items: { type: 'number' } },
            radiusMm: { type: 'number', description: 'Default 2 cells.' },
          },
        },
      },
      materialIds: { type: 'array', items: { type: 'string' }, description: 'Shipped materials, e.g. ["fdm-pla"]. The strength behind the tiers is the LAYER-ADHESION band, not the bulk figure. Omit (with materialJson) for your own; the built-in is marked assumed.' },
      materialJson: { type: 'string', description: 'Inline material: {"id","name","youngModulusMPa","poissonRatio","strengthMPa"}. Use for a filament you have data for.' },
      dxMm: { type: 'number', description: 'Voxel size in mm. Default: 8 cells across the thinnest dimension. Halving it costs ~8x. A hot spot thinner than ~8 cells needs a finer grid before its position is trustworthy.' },
      criticalDistanceMm: { type: 'number', description: 'Distance inside the surface at which peaks are read. Default 1.0 mm (the grid cannot sample closer than one cell; the distance actually used comes back as effectiveSampleDistanceMm).' },
      probeAtMm: { type: 'array', items: { type: 'number' }, description: 'Watch this point: report its displacement, e.g. a pan centre or a beam tip.' },
      resultants: {
        type: 'array',
        description: 'Section resultants to integrate — the trustworthy half of this tool: axial force, shear, bending moment, plus the section area and its second moment so an analytic check can be closed on a profile too complex to hand-compute. Place the cut AWAY from a support: a cut through the support patch swallows part of the reaction.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            axis: { type: 'string', required: true, description: 'Cut normal: x | y | z' },
            atMm: { type: 'number', required: true, description: 'Position of the cut along that axis, mm.' },
          },
        },
      },
      runConvergence: { type: 'boolean', description: 'Also solve a coarser grid and report the deltas (default true; costs ~30% more). A drifting verdict means refine before quoting.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          // Mode-trimmed below exactly like check_printability: judge drops `attention`,
          // scan drops `verdict`+`delivery`. A static required list made BOTH modes
          // fail, so the default call was broken. The run record keeps both halves.
          nextLook: {
            type: 'array',
            description: 'Present in judge mode: RUNNABLE next observations ({tool, args, why}) — judge trims the per-sample field on purpose, so the verdict must still say where to look (HARNESS §11.14).',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                tool: { type: 'string', required: true },
                args: { type: 'object', required: true, additionalProperties: true },
                why: { type: 'string', required: true },
              },
            },
          },
          verdict: { type: 'string', description: '"ok" | "check" | "overstressed" (absent in scan mode) — a SUMMARY for a human, NOT the delivery form. Deliver against `delivery` (excluded / difficult / not-excluded), which is the two-or-three-valued judgement with witnesses.' },
          delivery: { type: 'object', additionalProperties: true, description: 'The delivery discipline: an allowable-stress requirement and a three-valued verdict — "excluded" (a witness contradicts it), "difficult" (the bounds straddle it), "not-excluded" (no counter-example; NEVER "ok"); plus `unevaluable` for numbers this mesh cannot decide. DETECTION IS NOT DELIVERY: the geometry suspects live in `attention`, never as witnesses here.' },
          material: { type: 'object', required: true, additionalProperties: true },
          method: { type: 'object', required: true, additionalProperties: true, description: 'What was actually solved: grid, degrees of freedom, CG iterations and residual, the sampling distance, the field file, how many cells the report excluded. A result without this is not reproducible.' },
          checks: { type: 'object', required: true, additionalProperties: true, description: 'Self-checks that do not need the answer to be right: equilibrium residual, strain-energy balance, mesh-independence deltas.' },
          resultants: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          capability: { type: 'object', required: true, additionalProperties: true, description: 'What this run may and may not be used to claim.' },
          attention: {
            type: 'object', additionalProperties: false,
            description: 'Where to LOOK, not what to conclude (absent in judge mode): one field per quantity, each with peaks, regions and a runnable next observation. The panel draws each layer as a heatmap from the same object — the picture and this digest cannot drift apart. Read an empty layer as "nothing found here", never as "clean".',
            properties: {
              id: { type: 'string', required: true, description: 'version + tool + the parameters that change the numbers: a picture may not outlive the case it describes.' },
              layers: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true, description: '"von-mises".' },
                    quantity: { type: 'string', required: true, description: 'The physical quantity, named honestly: "von-mises-stress".' },
                    units: { type: 'string', required: true },
                    direction: { type: 'string', required: true, description: 'How to read the colour ramp: "larger-is-worse".' },
                    domain: { type: 'object', required: true, additionalProperties: true },
                    normalization: { type: 'object', required: true, additionalProperties: true, description: 'Where the colour scale comes from: the declared material strength and its factors. Without it a heatmap is decoration.' },
                    stats: { type: 'object', required: true, additionalProperties: true },
                    peaks: {
                      type: 'array', required: true,
                      description: 'Local extremes, few and precise — the index into the picture. Each was sampled at the declared distance inside the surface.',
                      items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                          atMm: { type: 'array', required: true, items: { type: 'number' } },
                          value: { type: 'number', required: true },
                          normalMm: { type: 'array', items: { type: 'number' } },
                          evidence: { type: 'string', required: true },
                          probe: {
                            type: 'object', required: true, additionalProperties: false,
                            properties: {
                              tool: { type: 'string', required: true },
                              args: { type: 'object', required: true, additionalProperties: true, description: 'Ready to pass to that tool (versionId already filled in).' },
                            },
                          },
                        },
                      },
                    },
                    regions: {
                      type: 'array', required: true,
                      description: 'Connected areas above a tier, with a bbox, the wall thickness in cells and a ready render command.',
                      items: {
                        // The region carries its own evidence (volumeMm3, peak depth,
                        // extrapolation R², trustworthy/whyUntrustworthy, …). It is the
                        // point of the field, so the schema must not close it.
                        type: 'object', additionalProperties: true,
                        properties: {
                          tier: { type: 'string', required: true, description: '"warn" | "bad".' },
                          areaMm2: { type: 'number', required: true, description: 'Projected surface patch (volume / mean depth), not a measured surface area — see domain.regionAreaIs.' },
                          atMm: { type: 'array', required: true, items: { type: 'number' } },
                          bboxMm: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
                          look: {
                            type: 'object', required: true, additionalProperties: false,
                            properties: {
                              tool: { type: 'string', required: true },
                              args: { type: 'object', required: true, additionalProperties: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 600_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string;
        mode?: 'judge' | 'scan' | 'both';
        loads: { forceN: number[]; face?: { axis: string; side?: string }; atMm?: number[]; radiusMm?: number }[];
        supports?: { face?: { axis: string; side?: string }; atMm?: number[]; radiusMm?: number }[];
        excludeFromReport?: { atMm: number[]; radiusMm?: number }[];
        materialIds?: string[];
        materialJson?: string;
        dxMm?: number;
        criticalDistanceMm?: number;
        probeAtMm?: number[];
        resultants?: { axis: string; atMm: number }[];
        runConvergence?: boolean;
      };
      const { store, runStore } = await allStores(exec);
      const modelPath = join(store.root, 'versions', a.versionId, 'model.stl');
      if (!existsSync(modelPath)) {
        throw new Error(await versionNotFound(store, a.versionId));
      }
      const material = resolveStressMaterial(a.materialJson, a.materialIds);
      const bb = boundingBoxOf(parseBinaryStl(await readFile(modelPath)));
      const bbox = [bb.min.map(Number), bb.max.map(Number)] as [number[], number[]];

      // The field is an artifact of ONE run, so it lives IN that run (2026-10-23 audit,
      // FIX-E4). Previously the filename was `<version>-<material>-<dx>`, which says
      // nothing about the LOAD CASE: two different loads on the same version overwrote
      // each other, and the report handed the model a path whose contents might belong to
      // a different question. The run id makes it addressable and immutable.
      const run = await beginRun(runStore, {
        kind: 'stress',
        title: `应力分析 · ${a.versionId}`,   // final title (with verdict) is set at commit
      });
      await mkdir(run.dir, { recursive: true });
      const fieldPath = join(run.dir, 'stress-field.f32');

      const result = await solveStress({
        path: modelPath,
        material,
        dxMm: a.dxMm,
        loads: a.loads.map((l) => ({
          forceN: l.forceN,
          face: l.face
            ? { axis: l.face.axis as 'x' | 'y' | 'z', side: (l.face.side as 'min' | 'max') ?? 'min' }
            : undefined,
          atMm: l.atMm,
          radiusMm: l.radiusMm,
        })),
        fixedFaces: (a.supports ?? [])
          .filter((s) => s.face)
          .map((s) => ({ axis: s.face!.axis as 'x' | 'y' | 'z', side: (s.face!.side as 'min' | 'max') ?? 'min' })),
        fixedPoints: (a.supports ?? [])
          .filter((s) => s.atMm)
          .map((s) => ({ atMm: s.atMm!, radiusMm: s.radiusMm })),
        excludeFromReport: a.excludeFromReport ?? [],
        probeAtMm: a.probeAtMm,
        resultants: a.resultants?.map((r) => ({ axis: r.axis as 'x' | 'y' | 'z', atMm: r.atMm })),
        criticalDistanceMm: a.criticalDistanceMm,
        runConvergence: a.runConvergence,
        fieldPath,
      });
      if (result.refused) throw new Error(`simulate_stress refused ${a.versionId}: ${result.refused}`);
      const field = await readStressField(fieldPath);

      // The tiers. These factors are the colour scale's premise and NOT a safety
      // factor: the peak method under-reads at the declared distance, and the model
      // is isotropic while an FDM part's weakness is between layers.
      // Declared heuristics, not calibrated: `badFactor` is the divisor that produces the
      // allowable stress, so it is a DESIGN decision, not a colour knob. Named here and
      // echoed in the report's `method` block so a reader can see the premise
      // (2026-10-23 audit, FIX-B6).
      const warnFactor = 2.5;
      const badFactor = 1.5;
      const FACTOR_SOURCE = 'declared heuristic (strength/warn, strength/bad) — not calibrated; DESIGN §27.1';
      const attention = stressAttention({
        versionId: a.versionId,
        material,
        result,
        bbox,
        warnFactor,
        badFactor,
      });
      // HARNESS §11.14: a tool may not go silent. When the stress half certifies nothing
      // (sub-voxel members — the usual answer for the toy-balance parts), an empty field
      // reads as "all fine", which is the attention failure the principle forbids. The
      // geometry scan already knows the suspects, so hand them over instead.
      if (result.regionsTrustworthy === 0) {
        try {
          const scan = await (await ensurePythonWorker()).request<{ suspects?: GeometrySuspect[] }>(
            'scan_attention',
            { path: modelPath },
          );
          const suspects = scan.suspects ?? [];
          if (suspects.length > 0) {
            attention.layers.push(geometrySuspectLayer(a.versionId, bbox, suspects));
          }
        } catch {
          // A courtesy scan must never turn a stress run into a failure.
        }
      }
      const bad = result.regions.filter((r) => r.tier === 'bad' && r.trustworthy);
      const warn = result.regions.filter((r) => r.tier === 'warn' && r.trustworthy);
      const drifting = result.meshIndependence.verdict === 'drifting';
      // "ok" is impossible for an assumed material, an unchecked mesh, or a part whose
      // members are thinner than the voxel: the verdict may not be greener than its
      // premises (the rule check_printability follows for its built-in profile).
      const verdict =
        bad.length > 0
          ? 'overstressed'
          : drifting || warn.length > 0 || material.assumed || result.regionsTrustworthy === 0
            ? 'check'
            : 'ok';

      // The field is a PRODUCT, not just a reply: the panel draws it as a heatmap and
      // needs the per-sample values that would be noise in the model's context. They
      // travel in the run, in the same `attention.json` shape check_printability
      // writes, so the panel needs no second format and the picture cannot drift from
      // the digest (DECISION-LOG 2026-10-19).
      const delivery = stressDelivery({ material, result, warnFactor, badFactor });
      await run.json('report.json', {
        versionId: a.versionId,
        verdict,
        delivery,
        material,
        method: {
          dxMm: result.dxMm, criticalDistanceMm: result.criticalDistanceMm,
          // The factors decide the allowable stress; a reader must be able to see that they
          // are a declared heuristic, not a calibration (DESIGN §27.1).
          warnFactor, badFactor, factorSource: FACTOR_SOURCE,
        },
        checks: {
          equilibriumErrorPct: result.equilibriumErrorPct,
          energyBalancePct: result.energyBalancePct,
          meshIndependence: result.meshIndependence,
        },
        resultants: result.resultants,
        attention,
      });
      await run.json('attention.json', {
        id: attention.id,
        versionId: a.versionId,
        normalization: field.normalization,
        samples: field.samples,
      });
      await run.commit({
        status: verdict === 'ok' ? 'pass' : verdict === 'overstressed' ? 'fail' : 'check',
        // The DELIVERY half, not the display word: a stress run with no trustworthy
        // region is `difficult`, which `ok` could never express. `verdicts` is a list
        // (one per question), so the run carries the WORST of them.
        judgement: delivery.verdicts.some((v) => v.verdict === 'excluded') ? 'excluded'
          : delivery.verdicts.some((v) => v.verdict === 'difficult') ? 'difficult'
            : 'not-excluded',
        summary: `${material.id} · dx ${result.dxMm}mm · 峰值(声明深度) ${result.peakDeclaredDepthMPa}MPa · 可信热点 ${result.regionsTrustworthy}`,
        title: `应力分析 · ${a.versionId} · ${verdict}`,
        sourceVersionIds: [a.versionId],
        subject: `stress:${a.versionId}`,
      });

      const out: Record<string, unknown> = {
        versionId: a.versionId,
        verdict,
        // It was written to the run report but never to the REPLY, so "deliver against
        // `delivery`" was impossible: judge mode returned a verdict with no judgement.
        delivery: delivery as unknown as { [key: string]: Json },
        material: material as unknown as { [key: string]: Json },
        method: {
          solver: 'voxel-hex8-linear-elastic (numpy matrix-free CG, python/cad_worker/stress_fem.py)',
          warnFactor, badFactor, factorSource: FACTOR_SOURCE,
          dxMm: result.dxMm,
          gridCells: result.gridCells,
          solidCells: result.solidCells,
          freeDof: result.freeDof,
          cgIterations: result.cgIterations,
          cgResidualRel: result.cgResidualRel,
          criticalDistanceMm: result.criticalDistanceMm,
          effectiveSampleDistanceMm: result.effectiveDistanceMm,
          excludedCells: result.excludedCells,
          fieldPath,
        },
        // The schema declares these objects free-form, which infers `Record<string, JsonValue>`;
        // `meshIndependence` carries optional members (`Json | undefined`) and the resultants are
        // a typed interface, so both need the index signature. What reaches the model is the
        // JSON-serialised form, where an absent member is simply absent.
        checks: {
          equilibriumErrorPct: result.equilibriumErrorPct,
          energyBalancePct: result.energyBalancePct,
          reactionN: result.reactionN,
          appliedN: result.appliedN,
          meshIndependence: result.meshIndependence,
          displacementAtProbeMm: result.probeDisplacementMm,
        } as unknown as { [key: string]: Json },
        resultants: result.resultants as unknown as { [key: string]: Json }[],
        capability: {
          canReport: [
            'integrals: reaction, section force/moment/area/second moment, strain energy (equilibrium and energy balance are built-in self-checks)',
            'hot-spot locations with their extent and local wall thickness in cells (feature >= ~8 cells)',
            'surface stress per trustworthy region, extrapolated from the depth profile',
          ],
          cannotReport: [
            'the largest element stress (not convergent on a curved or notched boundary: 1.002 -> 1.184 under refinement)',
            'a safety factor (the peak method under-reads at the declared distance; the model is isotropic)',
            'layer-direction failure of a printed part, fatigue, creep, buckling, contact/Hertz, dynamics',
            'anything about a member thinner than the voxel: it is smeared into a thicker one, which reads stiff and safe',
          ],
          tiers: `warn above ${(material.strengthMPa / warnFactor).toFixed(2)} MPa, bad above ${(material.strengthMPa / badFactor).toFixed(2)} MPa (strength ${material.strengthMPa} MPa / ${warnFactor}, / ${badFactor}) — a colour scale, not a safety factor`,
        },
        attention,
      };
      // The two channels are separated STRUCTURALLY, not by convention: scan mode has no
      // verdict at all, so a risk map cannot be misread as a gate; judge mode has no
      // attention field, so a verdict cannot be mistaken for a fingerprint of where it
      // looked. Default = judge (the stricter half, DESIGN §25.7).
      const mode = a.mode ?? 'judge';
      if (mode === 'scan') {
        delete out.verdict;
        delete out.delivery;
      }
      if (mode === 'judge') {
        delete out.attention;
        // Same obligation as check_printability: judge mode trims the field, so it must
        // point somewhere runnable (HARNESS §11.14; 2026-10-23 audit, FIX-B3).
        out.nextLook = nextLookFor({
          source: 'stress',
          versionId: a.versionId,
          judgement: (delivery.verdicts.some((v) => v.verdict === 'excluded') ? 'excluded'
            : delivery.verdicts.some((v) => v.verdict === 'difficult') ? 'difficult'
              : 'not-excluded'),
        });
      }
      // `out` is assembled in a MODE-DEPENDENT shape (scan mode carries no verdict, judge
      // mode no field), so its static type is a record even though every key it can emit
      // is declared in `output.schema` and validated there at the boundary. The cast
      // bridges exactly that gap; it does not loosen what the caller receives.
      // `jsonSafe` normalises numpy's -0 (JSON cannot represent it losslessly) — without
      // it the whole tool call fails as "value is not lossless JSON".
      return jsonSafe(out) as any;
    },
  }));

  // --- scan_attention: 把注意力指向可能出错的几何（HARNESS §11.14）------------
  //
  // 这个工具不判"能不能造"、不排序、不给结论。它回答的是"我该看哪里"：网格表示层
  // 的问题（不闭合、多个体）与几何层的应力集中起点（内凹尖角——法向夹角越大，
  // 材料侧凹角越尖）。每条 suspect 都带坐标、包围盒与一条可执行的观测命令，因为
  // 一个没有位置的告警等于把找缺陷的活退回给使用者。判定留给设计者。
  registerTool(defineTool({
    name: 'scan_attention',
    description:
      'Where to LOOK on a saved version — not a verdict. Mesh health (watertight, body count) plus ' +
      'REENTRANT CORNERS: concave edges whose face normals turn by more than `concaveMinDeg` (default 100°), ' +
      'chained and located. θ=90° is an ordinary T-junction (not reported); θ=135° is a 45° V-notch; ' +
      'θ→180° is a knife slit. A notch is where printed parts initiate cracks, so each one comes back with ' +
      'a coordinate, a bbox and a runnable next observation. Run it on a new part, and again after any ' +
      'geometry change: it is how a fix is shown to have worked (the repaired part must go quiet).',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version id to scan, e.g. "v012".' },
      concaveMinDeg: { type: 'number', description: 'Report concave edges sharper than this face-normal angle. Default 100 (just past a right angle).' },
      minChainMm: { type: 'number', description: 'Ignore chained edges shorter than this, mm. Default 0.5.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          stats: { type: 'object', required: true, additionalProperties: true },
          suspects: {
            type: 'array', required: true,
            description: 'Places to look, worst first. Never a ranking of the part, never a pass/fail.',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, description: '"reentrant-corner" | "degenerate-faces" | "non-manifold" | "multi-body".' },
                where: {
                  type: 'object', required: true, additionalProperties: false,
                  properties: {
                    atMm: { type: 'array', items: { type: 'number' } },
                    bboxMm: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
                  },
                },
                why: { type: 'string', required: true, description: 'The evidence, with numbers.' },
                severity: { type: 'string', required: true, description: '"likely-defect" | "look".' },
                look: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    tool: { type: 'string', required: true },
                    args: { type: 'object', required: true, additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: [
          `scan_attention ${value.versionId} — faces ${value.stats?.faces} · watertight ${value.stats?.watertight} · bodies ${value.stats?.bodies}`,
          ...(value.suspects ?? []).map((s: any) =>
            `  [${s.severity}] ${s.kind} @ ${JSON.stringify(s.where?.atMm ?? s.where?.bboxMm)} — ${s.why}`),
          ...((value.suspects ?? []).length === 0 ? ['  （无可疑处）'] : []),
        ].join('\n'),
      }],
    },
    timeoutMs: 120_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as { versionId: string; concaveMinDeg?: number; minChainMm?: number };
      const { store } = await allStores(exec);
      if (!existsSync(join(store.root, 'versions', a.versionId, 'model.stl'))) {
        throw new Error(await versionNotFound(store, a.versionId));
      }
      return scanAttention(store, a);
    },
  }));

  // --- delivery_audit: 交付前的"证据体检"（DESIGN §23）------------------------
  //
  // microscope5 的教训：过期证据、红牌运行、未验证版本、契约缺机构接口、
  // 重复运行——这些事实全都在语料里，但**没有任何一处把它们摆在一起**，于是
  // 交付时没人看见。本工具一次读三个 store（+ 装配清单）算出结论。
  registerTool(defineTool({
    name: 'delivery_audit',
    description:
      'Audit the corpus before delivering: failing runs that are still the newest of their kind, ' +
      'parts whose newest version no run ever checked, runs citing superseded geometry (stale evidence), ' +
      'contract gaps (e.g. no motion-clearance interface while the assembly has several parts), ' +
      'contract nodes pointing at replaced versions, repeated runs that add no information, and mesh files ' +
      'on disk that NO version accounts for (a part written straight to a file never reaches the panel or any ' +
      'tool — a human cannot see it). ' +
      'Run this BEFORE any delivery claim; a blocked verdict means the corpus itself contradicts the claim.',
    parameters: {
      manifestPath: {
        type: 'string',
        description: 'Assembly manifest to audit against. Defaults to assembly/assembly.json in the session workspace.',
      },
      claims: {
        type: 'array',
        description: 'Delivery CLAIMS to back with evidence: {kind, statement}. kind is strength | motion | assembly | manufacturability | appearance | review. A claim with no fresh run of the kind it needs is reported as claim-without-evidence (blocked). Omit it and the audit declines to judge any delivery claim — it only says whether the CORPUS is coherent.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, description: 'strength | motion | assembly | manufacturability | appearance | review' },
            statement: { type: 'string', required: true, description: 'The claim in words, e.g. "the beam carries 80 g without yielding".' },
          },
        },
      },
      scanPaths: {
        type: 'array',
        description: 'Workspace-relative roots scanned for mesh files no version accounts for. Default ["."] (whole workspace, skipping the corpus, nested projects and common build dirs); pass [] to disable. A found file NEWER than the newest version is blocked — register it with import_part or declare it exempt.',
        items: { type: 'string' },
      },
      exempt: {
        type: 'array',
        description: 'Declared exceptions for files intentionally left as files (e.g. bought/reference geometry): {path, reason}. Reported as info, never blocked, and the reason is echoed. Use it instead of narrowing scanPaths when the file is a legitimate non-version.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Workspace-relative file or directory.' },
            reason: { type: 'string', required: true, description: 'Why this file is not a version (e.g. "reference STL from the vendor").' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', required: true, description: '"excluded" | "difficult" | "not-excluded" (canonical since 2026-10-20; was blocked/attention/ok).' },
          judgement: { type: 'string', required: true, description: 'The canonical judgement for management: excluded | difficult | not-excluded. Read THIS, not `verdict`, when deciding whether something is excluded (src/shared/judgement.ts).' },
          findings: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true },
                code: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
          versions: { type: 'object', required: true, additionalProperties: true },
          parts: { type: 'object', required: true, additionalProperties: true },
          runs: { type: 'object', required: true, additionalProperties: true },
          contract: { type: 'object', required: true, additionalProperties: true },
          unregistered: { type: 'object', required: true, additionalProperties: true, description: 'Mesh files on disk that no version accounts for: {scanned, files[], exempt[], missingExempt[], truncated}.' },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: [
          // Canonical vocabulary (src/shared/judgement.ts): the render still compared
          // the retired words, so a corpus with a blocked finding printed "✓ OK".
          `${value.verdict === 'excluded' ? '❌ BLOCKED' : value.verdict === 'difficult' ? '⚠ DIFFICULT' : '✓ NOT-EXCLUDED'} — ${value.summary}`,
          ...(value.findings ?? []).map((f: any) => `  [${f.severity}] ${f.code}: ${f.detail}`),
        ].join('\n'),
      }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        manifestPath?: string;
        claims?: import('./delivery-audit.ts').DeliveryClaim[];
        scanPaths?: string[];
        exempt?: { path: string; reason: string }[];
      };
      const project = await allStores(exec);
      const report = await auditDelivery(project, {
        manifestPath: a.manifestPath,
        claims: a.claims,
        scanPaths: a.scanPaths,
        exempt: a.exempt,
      });
      const blocked = report.findings.filter((f) => f.severity === 'blocked').length;
      const warn = report.findings.filter((f) => f.severity === 'warn').length;
      const info = report.findings.filter((f) => f.severity === 'info').length;
      return {
        ...report,
        // The single key management and the delivery audit read (DESIGN §25.7). `verdict` is
        // kept because the panel and the skills display it; `judgement` is the canonical one.
        judgement: asJudgement(report.verdict),
        summary: `${report.versions.total} versions / ${report.parts.total} parts / ${report.runs.total} runs · ` +
          `${blocked} blocked · ${warn} warn · ${info} info · ` +
          `stale runs ${report.runs.stale.length} · newest-unvalidated parts ${report.parts.newestNeverValidated.length}` +
          (report.unregistered.files.length ? ` · unregistered files ${report.unregistered.files.length}` : ''),
      };
    },
  }));


  // Per-call usage telemetry (observer on llm/stream; never blocks anything).
  // Profile-wide on purpose: this observes every session at once, and the
  // numbers describe the request, not the project (project.ts → telemetryRoot).
  registerUsageObserver(ctx);

  // --- preflight: the mandatory sequence as ONE call -------------------------
  //
  // WHY one tool: the failure this kills is "the gate was forgotten". Six names to
  // remember is six chances to skip one; one call is one. Steps NOT orchestrated here
  // are reported as not-run WITH a reason — never silently green (DESIGN §25.7).
  registerTool(defineTool({
    name: 'preflight',
    description:
      'Run the mandatory delivery sequence in one call: printability for every part (newest version, ' +
      'against the `profileIds` you declare), mesh health, support cost, the assembly contract and the ' +
      'corpus audit with your `claims`. `judgement` is the worst step that RAN; a step that was attempted ' +
      'and failed forces `difficult`, and it never averages away. Steps this cut does not orchestrate at ' +
      'all (simulation evidence, the assembly render) are listed in `coverage.notCovered` with a reason — ' +
      'they are named, not silently green, and they do not enter the judgement. Read `unevaluable` before ' +
      'claiming anything: not-excluded means "no counter-example", never "ok" and never "safe".',
    parameters: {
      claims: {
        type: 'array',
        description: 'Delivery claims to back with evidence: {kind, statement}. kind = strength | motion | assembly | manufacturability | appearance | review.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            statement: { type: 'string', required: true },
          },
        },
      },
      profileIds: { type: 'array', items: { type: 'string' }, description: 'Declared process profiles to screen against (same meaning as in check_printability).' },
      scanPaths: {
        type: 'array',
        description: 'Workspace-relative roots for the unregistered-geometry scan (same meaning as in delivery_audit). Default ["."]; [] disables it.',
        items: { type: 'string' },
      },
      exempt: {
        type: 'array',
        description: 'Declared exceptions for files intentionally left as files: {path, reason} (same meaning as in delivery_audit).',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          judgement: { type: 'string', required: true, description: 'The WORST step: excluded | difficult | not-excluded.' },
          steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          ran: { type: 'array', required: true, items: { type: 'string' } },
          notRun: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          unevaluable: { type: 'array', required: true, items: { type: 'string' } },
          coverage: {
            type: 'object', required: true, additionalProperties: true,
            description: '{ran, notRun, notCovered}. `notCovered` = steps this cut does not orchestrate (with a reason); they do NOT enter `judgement`. A step in `notRun` was attempted and failed, and it forces `difficult`.',
          },
          summary: { type: 'string', required: true },
          timings: { type: 'object', required: true, additionalProperties: true, description: 'Per-step wall time in ms. A step that blew its budget is reported in notRun/unevaluable WITH the reason — the tool never sits waiting without saying so.' },
        },
      },
      render: (_a, v) => {
        const out = v as unknown as {
          judgement: string;
          steps: { step: string; ran: boolean; judgement: string; detail: string }[];
          ran: string[];
          notRun: { step: string; why: string }[];
          unevaluable: string[];
          coverage?: { ran: string[]; notRun: string[]; notCovered: { step: string; why: string }[] };
          summary: string;
        };
        // A one-line summary is not an error report: "excluded" must name the step
        // that excluded it, and a step that did not run must say why. The model reads
        // THIS text, not the value object.
        const lines = [`preflight → ${out.judgement}`, out.summary];
        const flagged = (out.steps ?? []).filter((s) => s.ran && (s.judgement === 'excluded' || s.judgement === 'difficult'));
        if (flagged.length) {
          lines.push('flagged:');
          for (const s of flagged.slice(0, 12)) lines.push(`  - ${s.step}: ${s.judgement} — ${s.detail}`);
          if (flagged.length > 12) lines.push(`  … ${flagged.length - 12} more`);
        }
        if (out.unevaluable?.length) {
          lines.push('unevaluable (attempted, no usable number):');
          for (const u of out.unevaluable) lines.push(`  - ${u}`);
        }
        // Not-covered steps are printed too: the judgement no longer stands for them, so
        // the text has to carry them or they become the silent pass this tool exists to
        // prevent.
        const notCovered = out.coverage?.notCovered ?? [];
        if (notCovered.length) {
          lines.push('not covered by this cut (NOT in the judgement):');
          for (const g of notCovered) lines.push(`  - ${g.step}: ${g.why}`);
        }
        return [{ type: 'text', text: lines.join('\n') }] as never;
      },
    },
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        claims?: { kind: string; statement: string }[];
        profileIds?: string[];
        scanPaths?: string[];
        exempt?: { path: string; reason: string }[];
      };
      const project = await allStores(exec);
      const parts = await listParts(project.partStore);
      const versions = await listVersions(project.store);
      const newest = new Map<string, string>();
      for (const v of versions) {
        if (!v.partId) continue;
        const cur = newest.get(v.partId);
        const curT = cur ? (versions.find((x) => x.id === cur)?.timestamp ?? '') : '';
        if (!cur || v.timestamp > curT) newest.set(v.partId, v.id);
      }

      const steps: PreflightStep[] = [];
      const timings: Record<string, number> = {};
      for (const part of parts) {
        const vid = newest.get(part.id);
        if (!vid) {
          steps.push({ step: `printability:${part.name}`, ran: false, judgement: 'difficult', detail: 'no version for this part' });
          continue;
        }
        // The SAME job check_printability runs (`screenVersionJob`), including the declared
        // profiles and the run record it writes. Screening with the low-level engine while
        // the caller named a process produced a verdict about a process nobody asked for —
        // and wrote no printability run, so preflight's own green could not back a claim
        // (2026-10-23 audit, FIX-B8).
        const r = await withDeadline(
          screenVersionJob({ versionId: vid, ...(a.profileIds?.length ? { profileIds: a.profileIds } : {}) }, project),
          45_000,
          `printability ${part.name}`,
        );
        timings[`printability:${part.name}`] = r.ms;
        if (!r.ok) {
          steps.push({ step: `printability:${part.name}@${vid}`, ran: false, judgement: 'difficult', detail: r.reason });
          continue;
        }
        const screen = r.value;
        steps.push({
          step: `printability:${part.name}@${vid}`,
          ran: true,
          judgement: asJudgement(screen.verdict),
          detail: `verdict ${screen.verdict} · ${screen.findings.length} finding(s)` +
            // Name the premise: a builtin-default verdict is not a declared-process verdict.
            (screen.profileSource === 'builtin-default' ? ' · judged against the BUILTIN fallback (no profile declared)' : ''),
        });
      }

      // mesh-health: the SAME engine op measure_part uses (`connectivity`), so this is not
      // a second implementation of the check — and a broken mesh is a hard fact, so it can
      // exclude rather than merely warn.
      const worker = await ensurePythonWorker();
      for (const part of parts) {
        const vid = newest.get(part.id);
        if (!vid) continue;
        const modelPath = join(project.store.root, 'versions', vid, 'model.stl');
        try {
          const rConn = await withDeadline(worker.request<Record<string, unknown>>('connectivity', { path: modelPath }), 30_000, `connectivity ${part.name}`);
          timings[`mesh-health:${part.name}`] = rConn.ms;
          if (!rConn.ok) throw new Error(rConn.reason); // the catch below reports it as ran:false
          const conn = rConn.value;
          const watertight = conn.watertight !== false;
          const bodies = Number(conn.bodies ?? conn.components ?? conn.shells ?? 1);
          steps.push({
            step: `mesh-health:${part.name}@${vid}`,
            ran: true,
            judgement: !watertight ? 'excluded' : bodies > 1 ? 'difficult' : 'not-excluded',
            detail: `watertight ${watertight} · bodies ${bodies} · keys ${Object.keys(conn).join(',')}`,
          });
        } catch (e) {
          steps.push({
            step: `mesh-health:${part.name}@${vid}`,
            ran: false,
            judgement: 'difficult',
            detail: `connectivity failed: ${String((e as Error)?.message ?? e)}`,
          });
        }
      }

      // support: mass-based, so a bowl is not "1 m² of overhang"; a real hanging plate is.
      // It is a process COST (supports / reorient), never an exclusion.
      //
      // PER PART: the first cut measured only `parts[0]` and still reported ONE corpus-wide
      // step, so a hanging plate on part B came back clean (2026-10-23 audit, FIX-B8).
      for (const part of parts) {
        const vid = newest.get(part.id);
        if (!vid) {
          steps.push({ step: `support:${part.name}`, ran: false, judgement: 'difficult', detail: 'no version for this part' });
          continue;
        }
        try {
          const rSup = await withDeadline(
            worker.request<{ regions?: { massG: number; atMm: number[] }[]; totals?: { massG?: number } }>('support_map', {
              path: join(project.store.root, 'versions', vid, 'model.stl'),
              dxMm: 1.0,
            }),
            45_000,
            `support ${part.name}`,
          );
          timings[`support:${part.name}`] = rSup.ms;
          if (!rSup.ok) throw new Error(rSup.reason);
          const sup = rSup.value;
          const regions = sup.regions ?? [];
          steps.push({
            step: `support:${part.name}@${vid}`,
            ran: true,
            judgement: regions.length > 0 ? 'difficult' : 'not-excluded',
            detail: regions.length > 0
              ? `${regions.length} 处悬空质量超阈（最大 ${Math.max(...regions.map((r) => r.massG)).toFixed(2)} g）——需支撑或改朝向，不是失败`
              : `无超阈悬空区（总计 ${sup.totals?.massG ?? 0} g）`,
          });
        } catch (e) {
          steps.push({ step: `support:${part.name}@${vid}`, ran: false, judgement: 'difficult', detail: `support_map failed: ${String((e as Error)?.message ?? e)}` });
        }
      }

      const rAudit = await withDeadline(
        auditDelivery(project, { claims: a.claims as never, scanPaths: a.scanPaths, exempt: a.exempt }),
        30_000,
        'audit',
      );
      timings.audit = rAudit.ms;
      if (!rAudit.ok) throw new Error(rAudit.reason);
      const audit = rAudit.value;
      const blockedFindings = audit.findings.filter((f) => f.severity === 'blocked');
      steps.push({
        step: 'audit',
        ran: true,
        judgement: audit.verdict,
        // A count is not a reason: name the blocked finding(s) in the step detail,
        // otherwise "excluded" sends the reader to a second tool call to learn why.
        detail: `${audit.findings.length} finding(s), claims ${a.claims?.length ?? 0}` +
          (blockedFindings.length ? ` — ${blockedFindings.slice(0, 2).map((f) => f.detail).join(' | ')}` : ''),
      });

      // assembly: the SAME job check_assembly runs (runAssemblyCheckJob), so this is the
      // real contract evaluation, not a second implementation. Absence of a manifest is
      // NOT a pass: it comes back as ran:false with the reason.
      try {
        const rAsm = await withDeadline(runAssemblyCheckJob(undefined, project), 60_000, 'assembly');
        timings.assembly = rAsm.ms;
        if (!rAsm.ok) throw new Error(rAsm.reason);
        const { report, manifestFile } = rAsm.value;
        const hard = (report.results ?? []).filter((r) => r.verdict === 'hard-violation').length;
        const skipped = (report.results ?? []).filter((r) => r.verdict === 'skipped').length;
        const intent = (report.results ?? []).filter((r) => r.verdict === 'intent-flag').length;
        steps.push({
          step: 'assembly',
          ran: true,
          judgement: hard > 0 ? 'excluded' : skipped > 0 || intent > 0 ? 'difficult' : 'not-excluded',
          detail: `${manifestFile} · hard ${hard} · skipped ${skipped} · intent ${intent}`,
        });
      } catch (e) {
        steps.push({
          step: 'assembly',
          ran: false,
          judgement: 'difficult',
          detail: `no assembly contract was evaluated (${String((e as Error)?.message ?? e)}) — an absent manifest is NOT a pass`,
        });
      }

      // Declared gaps — the honest part, and a DIFFERENT category from a failed step: this
      // cut does not orchestrate them at all, so they must not turn `judgement` into a
      // permanent `difficult` (that is a constant, not a signal). They are named in
      // `coverage.notCovered` and repeated in every reply.
      const notCovered = [
        { step: 'simulation-evidence', why: 'simulations need a declared case; they produce evidence, preflight only checks for it (via claims)' },
        { step: 'render', why: 'the assembly render is a HUMAN look: preflight can check freshness, not content' },
      ];

      const summary = preflightSummary(steps, notCovered);
      // The schema's object type has an index signature; PreflightStep is a typed
      // record. The values are identical — the cast is the boundary, not a dodge.
      return {
        ...summary,
        steps,
        timings,  // a blown budget must be visible, not felt as a pause
        summary: `${summary.ran.length} step(s) ran · ${summary.notRun.length} attempted-and-failed · ` +
          `${notCovered.length} not covered · judgment ${summary.judgement} — read unevaluable before claiming anything`,
      } as never;
    },
  }));

  // --- analyze: the risk map (detection only; never gates) ------------------
  registerTool(defineTool({
    name: 'analyze',
    description:
      'EXPERIMENTAL — do not base a delivery claim on this yet: its overhang handling is still AREA-based, ' +
      'which lights up whole regions (the toy-balance pan showed 1041 of 2871 samples red) instead of pointing. ' +
      'Build the risk map for a version and say where to LOOK: geometry corners (scan_attention) + ' +
      'measured wall thickness + overhang faces, each normalised to |u| in [0,1] against its own DECLARED ' +
      'band (dead band + saturating scales; a one-sided quantity is an open band), then fused as max|u| plus ' +
      'an agreement count. It never gates and never returns a verdict: a peak means "look here", not "this ' +
      'will break". Comfortable regions are dropped, so an empty peak list means "nothing stands out", NOT "safe".',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version id, e.g. "v069".' },
      cellMm: { type: 'number', description: 'Clustering cell for peaks (default 8 mm).' },
      wallMinMm: { type: 'number', description: 'Wall band lower edge (default: the declared profile\'s wallMinMm, else 1.2 mm — and the reply says which).' },
      wallMaxMm: { type: 'number', description: 'Wall band upper edge — thick masses are a risk too (default 4.0 mm, a DECLARED heuristic, not a measurement).' },
      profileIds: { type: 'array', items: { type: 'string' }, description: 'Process profiles to take the wall band from (same meaning as in check_printability). Omit and the band source says "no profile" — an unsigned threshold, which DESIGN §27.1 exists to prevent.' },
      dxMm: { type: 'number', description: 'Voxel size for the support estimate (default 1.0 mm).' },
      minMassG: { type: 'number', description: 'Unsupported MASS above which a hanging region is reported (default 1.0 g, declared). A 0.2 g sliver is free.' },
      bridgeMaxMm: { type: 'number', description: 'Horizontal span a printer can bridge without support (default 10 mm, declared).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          peaks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          layers: { type: 'object', required: true, additionalProperties: true },
          notMapped: { type: 'array', required: true, items: { type: 'string' } },
          partNotes: { type: 'object', required: true, additionalProperties: true, description: 'Per-PART facts that are not places: overhang faces/area (a global support cost). Deliberately not a point layer — scoring it per sample paints whole bowls red and buries the local signals.' },
          support: { type: 'object', additionalProperties: true, description: 'Support adequacy by MASS: regions of material with no 45-degree support path to the bed, above `minMassG`, with bridgeable spans excused. null when the runtime could not run it (the reply says so).' },
          bands: { type: 'object', required: true, additionalProperties: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_a, v) => {
        const out = v as unknown as { peaks: { atMm: number[]; risk: number; count: number; layers: string[] }[]; note: string };
        const lines = [out.note];
        for (const p of out.peaks.slice(0, 8)) {
          lines.push(`  |u|=${p.risk.toFixed(2)} count=${p.count} at=[${p.atMm.map((x) => x.toFixed(1))}] ${p.layers.join('+')}`);
        }
        return [{ type: 'text', text: lines.join('\n') }] as never;
      },
    },
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        versionId: string; cellMm?: number; wallMinMm?: number; wallMaxMm?: number;
        // Declared in `parameters` above; the cast used to omit them, so `tsc` flagged the
        // three reads below as errors on a type that the runtime does populate.
        dxMm?: number; minMassG?: number; bridgeMaxMm?: number;
        profileIds?: string[];
      };
      const project = await allStores(exec);
      // The band is a DECLARED claim, so the reply must say where it came from. Before this,
      // the source string said "(declared)" for numbers this very function had just
      // invented — a declaration with no author (2026-10-23 audit, FIX-B6).
      let wallMin = a.wallMinMm ?? 1.2;
      const wallMax = a.wallMaxMm ?? 4.0;
      let bandSource = 'declared heuristic: lower 1.2 mm / upper 4.0 mm — NO process profile ' +
        '(DESIGN §27.1: an unsigned threshold quietly shapes the design)';
      if (a.profileIds?.length) {
        const resolvedBand = await resolveProcessProfiles({ profileIds: a.profileIds });
        if (resolvedBand.errors.length > 0) {
          throw new Error(`invalid process profile:\n  - ${resolvedBand.errors.join('\n  - ')}`);
        }
        const prof = resolvedBand.profiles[0]!;
        const wallRule = evaluableRules(prof).find((r) => r.rule === 'wallMinMm');
        if (wallRule) {
          wallMin = a.wallMinMm ?? wallRule.value;
          bandSource = `profile ${prof.id} (hash ${profileHash(prof)}) rule wallMinMm=${wallRule.value}` +
            (wallRule.direction === 'max' ? ' — declared direction "max", i.e. read here as an UPPER bound' : '');
        }
      }
      const modelPath = join(project.store.root, 'versions', a.versionId, 'model.stl');
      if (!existsSync(modelPath)) {
        const ids = (await listVersions(project.store)).map((v) => v.id);
        throw new Error(
          `unknown version "${a.versionId}" — this project has ${ids.length} version(s): ` +
            `${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}. ` +
            `Pass a version id from generate_part/import_part (a part id like "p001" is not a version id).`,
        );
      }
      const t0 = Date.now();
      const timings: Record<string, number> = {};
      // The field is the primary input: if it cannot answer inside its budget the call
      // fails FAST with the reason, instead of occupying the harness for two silent minutes.
      const rScreen = await withDeadline(checkPrintability(project.store, { versionId: a.versionId, withSampleField: true }), 45_000, 'printability field');
      timings.printability = rScreen.ms;
      if (!rScreen.ok) throw new Error(rScreen.reason);
      const screen = rScreen.value;

      // §27.4: the band's width is the measurement's resolution, not a second invented
      // number. A wall screen samples the surface, so its spacing is ≈ sqrt(area/count);
      // below that, "1.15 vs 1.20 mm" is not a difference the screen can resolve.
      const wallResolutionMm = measuredResolutionMm({
        surfaceAreaMm2: screen.surfaceAreaMm2,
        sampled: screen.sampled,
      });
      const wallBand: BandNorm = {
        id: 'wall', quantity: 'wall-thickness', units: 'mm',
        lo: wallMin, hi: wallMax,
        scaleLo: wallResolutionMm > 0 ? wallResolutionMm : wallMin,
        scaleHi: wallResolutionMm > 0 ? wallResolutionMm : wallMax,
        source: wallResolutionMm > 0
          ? `${bandSource}; 灰带 ±${wallResolutionMm.toFixed(3)}mm = 测量分辨率 ` +
            `sqrt(面积 ${screen.surfaceAreaMm2.toFixed(1)}mm² / 采样 ${screen.sampled})`
          : `${bandSource}; 分辨率未知，灰带退回绝对边界`,
      };

      let suspects: SuspectLike[] = [];
      let cornerError: string | null = null;
      {
        const rScan = await withDeadline(
          (await ensurePythonWorker()).request<{ suspects?: SuspectLike[] }>('scan_attention', { path: modelPath }),
          30_000,
          'scan_attention',
        );
        timings.scan = rScan.ms;
        if (rScan.ok) {
          suspects = rScan.value.suspects ?? [];
        } else {
          // A missing layer is NOT "no corners". The map must say which route is absent
          // (the same rule as `notMapped` on the stress tool).
          cornerError = rScan.reason;
        }
      }
      // Support adequacy, by MASS (not area): a little overhang is free, a 3 g plate with
      // nothing beneath it is not. Declared thresholds; the answer is "needs support",
      // never "will fail".
      let support: Record<string, unknown> | null = null;
      let supportError: string | null = null;
      {
        const rSup = await withDeadline(
          (await ensurePythonWorker()).request<Record<string, unknown>>('support_map', {
            path: modelPath,
            dxMm: a.dxMm ?? 1.0,
            minMassG: a.minMassG ?? 1.0,
            bridgeMaxMm: a.bridgeMaxMm ?? 10.0,
          }),
          45_000,
          'support_map',
        );
        timings.support = rSup.ms;
        if (rSup.ok) support = rSup.value;
        else supportError = rSup.reason; // reported, never swallowed
      }
      const out = analyzeVersion({ suspects, field: screen.field as never, wallBand, cellMm: a.cellMm });
      if (cornerError) out.notMapped.push(`corner-scan: ${cornerError}`);
      if (supportError) out.notMapped.push(`support: ${supportError}`);
      if (!screen.field) out.notMapped.push('wall-field: per-sample field missing — wall layer absent from this map');
      // Persist the map so the panel can DRAW it and a later reader can audit it: the
      // heat map and the JSON come from the same object (one surface, two readers).
      const run = await beginRun(project.runStore, {
        kind: 'analyze',
        title: `风险图 · ${a.versionId}`,
      });
      await run.json('report.json', { peaks: out.peaks, layers: out.layers, bands: { wall: wallBand }, notMapped: out.notMapped });
      await run.json('attention.json', {
        id: 'analyze',
        versionId: a.versionId,
        normalization: { fused: { mode: 'absolute', warnAt: 0.5, badAt: 1.0, source: 'each quantity\'s declared band' } },
        samples: { fused: out.samples.fused },
      });
      await run.commit({
        // Provenance belongs to the COMMIT: beginRun only names the run.
        sourceVersionIds: [a.versionId],
        subject: `analyze:${a.versionId}`,
        // Always 'check': a risk map is something to look at, and "no peaks" is not a
        // clean bill (the tool says so itself). It carries no judgement, so the revision
        // band reads 未验证 rather than borrowing this word (2026-10-23 audit, FIX-B4).
        status: 'check',
        summary: `${out.peaks.length} 处风险峰 · ${suspects.length} 处再入角 · 最高 |u| ${out.peaks[0]?.risk.toFixed(2) ?? '—'}` +
          (cornerError ? ' · 角扫描失败（见 notMapped）' : ''),
      });
      // `samples` is the panel's fused field (already in the run's attention.json).
      // It is not in the reply schema and MUST NOT ride into the model's context:
      // the schema is closed, so it rejected the whole reply
      // (`"value.samples" is not a declared property`).
      const { samples: _samples, ...forModel } = out;
      void _samples;
      return {
        ...forModel,
        support,
        timings: { ...timings, total: Date.now() - t0 },
        bands: { wall: wallBand },
        note: `${out.peaks.length} peak(s) · ${suspects.length} corner suspect(s) · ${support ? `${(support.regions as unknown[]).length} 处质量超阈的悬空区（需支撑或改朝向，不是失败）` : `悬空质量未评估`} · |u| 是"离各自舒适带多远"（逐点取最坏那一路）；峰=该看，不是会坏${out.notMapped.length ? ` · ${out.notMapped.length} 类未映射` : ""}`,
      } as never;
    },
  }));

  // --- assembly manifest v1: executable interface contracts (L0) ---
  // Shared by the check_assembly tool (LLM-initiated) and the manual
  // POST /api/cad/assembly/run route — identical report shape either way.
  //
  // The manifest is a file the AGENT authors, so a relative path resolves
  // against the session workspace first and the plugin data root second; see
  // resolveAssemblyManifestPath() for why the order is that way round.
  async function runAssemblyCheckJob(
    manifestPath: string | undefined,
    project: ProjectStores,
    opts: { adjacencyThresholdMm?: number } = {},
  ): Promise<{ report: Awaited<ReturnType<typeof import('./assembly-check.ts').runAssemblyCheck>>; manifestFile: string; origin: string }> {
    const { store, runStore } = project;
    const { runAssemblyCheck, saveAssemblyCheckPointer } = await import('./assembly-check.ts');
    const resolved = await resolveAssemblyManifestPath(manifestPath, {
      workspace: project.cwd,
      dataRoot: store.root,
    });
    const path = resolved.path;
    // The runs are what a motion-clearance interface cites as its evidence, so
    // the checker has to see them (see assembly-check.ts).
    const runs = await listRuns(runStore);
    const report = await runAssemblyCheck(store, path, {
      adjacencyThresholdMm: opts.adjacencyThresholdMm,
      runs,
    });

    // Provenance: manifest part nodes name their version, so the check is tied
    // to exactly the versions it audited.
    let sourceVersionIds: string[] = [];
    try {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { root?: unknown };
      const found = new Set<string>();
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.version === 'string') found.add(node.version);
        for (const child of node.children ?? []) walk(child);
      };
      walk(manifest.root);
      sourceVersionIds = [...found];
    } catch { /* manifest unreadable — the report already carries the error */ }

    const run = await beginRun(runStore, {
      kind: 'assembly-check',
      title: `装配清单检查 · ${report.manifestName}`,
    });
    await run.json('report.json', report);
    await run.commit({
      sourceVersionIds,
      // The canonical judgement (same derivation as the tool's reply): a hard violation
      // is a witness; a skipped/intent interface is "nobody evaluated it" -> difficult.
      judgement: report.results.some((r) => r.verdict === 'hard-violation')
        ? 'excluded'
        : (report.results.length === 0 || report.results.some((r) => r.verdict === 'skipped' || r.verdict === 'intent-flag'))
          ? 'difficult'
          : 'not-excluded',
      status: report.overallStatus,
      summary: `${report.summary.interfaces} 接口 · 通过 ${report.summary.pass} · ` +
        `硬冲突 ${report.summary.hardViolations} · 未声明 ${report.summary.undeclared}`,
      // The manifest IS the subject of a contract check: re-running it after a
      // design change replaces the previous verdict, while a negative control
      // (a different manifest) stays a separate, still-meaningful record.
      subject: `manifest:${relativeSubject(project, path)}`,
    });
    // ONE authority: the run holds the report; the file next to the manifest is a
    // pointer that names it (2026-10-23 audit, FIX-C1).
    await saveAssemblyCheckPointer(path, {
      runId: run.id,
      checkedAt: report.checkedAt,
      manifestPath: path,
      manifestHash: report.manifestHash,
      schema: 'assembly-check-pointer/v1',
    });
    return { report, manifestFile: path, origin: resolved.origin };
  }

  registerTool(defineTool({
    name: 'check_assembly',
    description:
      'Validate the assembly manifest (BOM + interface contracts): distance, diameter-match and coaxial (axis-to-axis offset between datum_axis/datum_cyl endpoints) checks, motion-clearance (static distance plus the motion run you cite in params.runId), spring-preload (stiffness × deflection from the measured installed length), plus a discovery pass for undeclared near-touching pairs. Nodes accept transform.pose {datum, angleDeg} to rotate a part about its own datum axis (assembly/meshing pose) with the datums following. Interfaces with no implementable operator OR no declared tolerance come back in `skipped` with what would make them checkable — a missing criterion is not a pass. A structurally invalid manifest is rejected with path-addressed issues and a minimal example (schema: schemas/assembly-manifest.schema.json). mm, z-up. A relative manifestPath resolves against the session workspace first, then the plugin data root.',
    parameters: {
      manifestPath: {
        type: 'string',
        description:
          'Path to the assembly manifest JSON. Relative paths are tried against the session workspace ' +
          '(e.g. "assembly/assembly.json" → <workspace>/assembly/assembly.json, which the agent can write) ' +
          'and then against the plugin data root; an absolute path is used as given. Defaults to "assembly/assembly.json".',
      },
      adjacencyThresholdMm: {
        type: 'number',
        description:
          'How close counts as "near" in the undeclared-adjacency discovery pass, mm. Default 0.75. ' +
          'Raise it (1.5–2) when the design keeps deliberate clearance gaps you want to see listed; ' +
          'a pair is reported when it interferes OR its gap is below this value.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          overallStatus: { type: 'string', required: true },
          // The canonical judgement (src/shared/judgement.ts). Declared HERE because the
          // body returns it HERE — 0849989 put these two lines on validate_assembly by
          // mistake, which made both tools violate their own output contract (the runtime
          // rejects the value before the model ever sees it).
          judgement: { type: 'string', required: true, description: 'The canonical judgement: excluded | difficult | not-excluded. Read THIS, not overallStatus.' },
          judgedBy: {
            type: 'object', required: true, additionalProperties: true,
            description: 'The counts the judgement was derived from. A skipped interface is "unevaluable" and must never read as a pass.',
          },
          manifestPath: { type: 'string' },
          adjacencyThresholdMm: { type: 'number' },
          summary: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              interfaces: { type: 'integer', required: true },
              pass: { type: 'integer', required: true },
              hardViolations: { type: 'integer', required: true },
              intentFlags: { type: 'integer', required: true },
              skipped: { type: 'integer', required: true },
              undeclared: { type: 'integer', required: true },
            },
          },
          hardViolations: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                interfaceId: { type: 'string', required: true },
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                verdict: { type: 'string', required: true },
                measured: { type: 'number' },
                detail: { type: 'string', required: true },
              },
            },
          },
          intentFlags: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                interfaceId: { type: 'string', required: true },
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                verdict: { type: 'string', required: true },
                measured: { type: 'number' },
                detail: { type: 'string', required: true },
              },
            },
          },
          skipped: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                interfaceId: { type: 'string', required: true },
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                verdict: { type: 'string', required: true },
                // `verdictFor` sets `measured` on every skipped item too (the
                // "missing criterion is not a pass" verdicts still carry the
                // number they measured). Omitting it here rejected the tool's
                // own value on tolerance-less manifests while the run had
                // already committed — the worst half of both worlds.
                measured: { type: 'number' },
                detail: { type: 'string', required: true },
              },
            },
          },
          undeclared: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                partA: { type: 'string', required: true },
                partB: { type: 'string', required: true },
                minDistance: { type: 'number', required: true },
                intersectionVolume: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    async execute(args: unknown, exec: unknown) {
      const a = args as { manifestPath?: string; adjacencyThresholdMm?: number };
      const { report, manifestFile } = await runAssemblyCheckJob(a.manifestPath, await allStores(exec), {
        adjacencyThresholdMm: a.adjacencyThresholdMm,
      });
      const trim = (r: InterfaceCheckResult) => ({
        interfaceId: r.interfaceId, a: r.a, b: r.b,
        verdict: r.verdict, measured: r.measured, detail: r.detail,
      });
      return {
        overallStatus: report.overallStatus,
        // Which file was actually audited: the agent can no longer tell from the
        // path it passed (workspace vs data root), and the answer matters when a
        // stale copy is the reason a check disagrees with the source of truth.
        manifestPath: manifestFile,
        adjacencyThresholdMm: report.adjacencyThresholdMm,
        summary: report.summary,
        hardViolations: report.results.filter((r) => r.verdict === 'hard-violation').map(trim),
        intentFlags: report.results.filter((r) => r.verdict === 'intent-flag').map(trim),
        // The canonical judgement (src/shared/judgement.ts). Derived, not re-decided:
        //   hard-violation -> excluded   (a witness contradicts the contract)
        //   skipped/intent -> difficult  (an interface nobody evaluated, or a soft signal:
        //                                 a skipped check is exactly "unevaluable", and it
        //                                 must never read as pass — microscope2 had two)
        //   none           -> not-excluded
        judgement: report.results.some((r) => r.verdict === 'hard-violation')
          ? 'excluded'
          : (report.results.length === 0 || report.results.some((r) => r.verdict === 'skipped' || r.verdict === 'intent-flag'))
            ? 'difficult'   // an EMPTY contract is an unevaluated one, not a satisfied one
            : 'not-excluded',
        judgedBy: {
          hardViolations: report.results.filter((r) => r.verdict === 'hard-violation').length,
          intentFlags: report.results.filter((r) => r.verdict === 'intent-flag').length,
          skipped: report.results.filter((r) => r.verdict === 'skipped').length,
          undeclared: (report.undeclared ?? []).length,
        },
        // The skips carry the instructions for how to make them checkable; a
        // bare count let "overallStatus: pass" read as "everything was verified"
        // (the microscope2 run had two interfaces nobody ever evaluated).
        skipped: report.results.filter((r) => r.verdict === 'skipped').map(trim),
        undeclared: report.undeclared,
      };
    },
  }));

  // --- recall_reference_image: bring a pruned user attachment back into vision ---
  //
  // WHY: the image-offload policy is OLDEST-FIRST with no user-image exemption
  // (verified against the stock dsh 0.2.0 — DESIGN §15.1), so the user's
  // reference image is always the FIRST occurrence pruned once the budget
  // fires. The route leaves a text placeholder naming the attachment and its
  // local path; this tool turns that name back into a visible image block on
  // the CURRENT tool result — the newest image in the request, so it survives
  // pruning for the following rounds. Bytes are re-committed through the
  // content-addressed attachment store, so a recall of an already-stored
  // image dedupes to the same object; nothing is duplicated.
  type RecallArgs = { attachmentId?: string; path?: string; name?: string };
  type RecallRef = { ref: unknown; label: string };
  const pendingRecallRefs = new Map<string, RecallRef>();

  /** Sniff the media type from magic bytes; null when not a supported image. */
  function sniffImageType(b: Uint8Array): string | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
    return null;
  }

  registerTool(defineTool({
    name: 'recall_reference_image',
    description:
      'Re-attach a user-uploaded reference image (or any earlier attachment) as a fresh image on this tool result. ' +
      'Use it when a reference image has been pruned from context (its placeholder reads "image omitted; <name>; path=<path>") ' +
      'and the task depends on seeing it again — comparing a build against a reference, matching proportions or colors. ' +
      'Pass the `path` from the placeholder, or the `attachmentId`. The recalled image becomes the NEWEST image in context, ' +
      'so it survives pruning for the following rounds; recall again when needed.',
    parameters: {
      path: {
        type: 'string',
        description: 'Local file path of the pruned image, exactly as the "image omitted" placeholder names it (preferred).',
      },
      attachmentId: {
        type: 'string',
        description: 'Durable attachment id (sha256:…) if the placeholder or history named one instead of a path.',
      },
      name: {
        type: 'string',
        description: 'Display name to keep for the recalled image; defaults to the file name or the attachment id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recalled: { type: 'boolean', required: true },
          source: { type: 'string', required: true, description: 'Where the bytes came from.' },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          attached: { type: 'boolean', required: true, description: 'Whether an image block rides on this result.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: JSON.stringify(value, (k, v) => (k === 'recallToken' ? undefined : v)),
      }],
    },
    timeoutMs: 30_000,
    async execute(args: unknown, exec: unknown): Promise<{ recalled: boolean; source: string; mediaType: string; bytes: number; attached: boolean }> {
      const a = args as RecallArgs;
      let data: Uint8Array;
      let source: string;
      let fallbackName: string;
      if (a.attachmentId) {
        const ref = { attachmentId: a.attachmentId };
        try {
          data = new Uint8Array(await (ctx.attachments as any).readImage(ref));
        } catch (e) {
          throw new Error(
            `attachment ${a.attachmentId} could not be read (${String((e as Error)?.message ?? e)}). ` +
            'If the pruned-image placeholder named a path, pass `path` instead.');
        }
        source = `attachment ${a.attachmentId}`;
        fallbackName = a.attachmentId.slice(0, 19);
      } else if (a.path) {
        // Bounded read with a magic-byte check: the bytes must decode as an
        // image we actually serve, and stay far below any request limit.
        const MAX = 20 * 1024 * 1024;
        const st = await readFile(a.path).then(
          (b) => b,
          () => { throw new Error(`path ${a.path} does not exist on the host — copy it from the "image omitted" placeholder verbatim`); },
        );
        if (st.byteLength > MAX) throw new Error(`image at ${a.path} is ${st.byteLength} bytes; over the 20 MiB recall cap`);
        const type = sniffImageType(st);
        if (!type) throw new Error(`file at ${a.path} is not a PNG/JPEG/WebP image (magic bytes)`);
        data = st;
        source = `path ${a.path}`;
        fallbackName = basename(a.path);
      } else {
        throw new Error('recall_reference_image needs `path` (from the "image omitted" placeholder) or `attachmentId`');
      }
      const mediaType = (sniffImageType(data) ?? 'image/png') as never;
      const [ref] = await ctx.attachments.saveImages([{
        data, mediaType, name: a.name?.trim() || fallbackName,
      }]);
      if (!ref) throw new Error('attachment store returned no reference for the recalled image');
      const token = randomUUID();
      pendingRecallRefs.set(token, { ref, label: a.name?.trim() || fallbackName });
      return {
        recalled: true, source, mediaType,
        bytes: data.byteLength,
        attached: true,
        // consumed by finalizeContent (stripped from the rendered JSON below)
        recallToken: token,
      } as never;
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: { attached?: boolean; recallToken?: string } & Record<string, unknown> }).value;
      if (!value?.attached || !value.recallToken) return undefined;
      const entry = pendingRecallRefs.get(value.recallToken);
      if (!entry) return undefined;
      pendingRecallRefs.delete(value.recallToken);
      const { ref, label } = entry;
      return [
        {
          type: 'text',
          text: `Recalled reference image "${label}" — this is the newest image in context now. ` +
            'If it is pruned again later, call recall_reference_image once more with the same path/id.',
        },
        { type: 'image', attachment: ref },
      ] as never;
    },
  }));

  // --- version preview routes for the client panel (web profiles only) ---
  // The connection service may activate after this plugin, so poll for it
  // instead of declaring an inject dependency (headless never has one).
  const registerWhenReady = (attempt = 0) => {
    const connection = ctx.reflect.get('connection');
    if (!connection) {
      if (attempt < 30) setTimeout(() => registerWhenReady(attempt + 1), 2000);
      return;
    }

    // What the host decided about tool visibility, profile-wide. The panel needs
    // it to tell a human "this session has no CAD tools" instead of showing an
    // innocent empty part list while the agent silently cannot make anything
    // (the two halves of this plugin are scoped differently on purpose: routes
    // are global, tools are per preset).
    void connection.fetch.register({
      path: '/api/cad/scope',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const presets = [...(scope?.presets ?? [])];
        // Display names, so the panel can say 「造物模式」而不是「cad」. Read
        // through reflect (no inject requirement): the roster service may not be
        // active when this plugin applies, but it is by the time anyone asks.
        const names: Record<string, string> = {};
        try {
          const roster = await ctx.reflect.get('agentPresets')?.list?.();
          for (const preset of roster ?? []) {
            if (presets.includes(preset?.id) && typeof preset?.name === 'string') names[preset.id] = preset.name;
          }
        } catch { /* ids alone still identify the situation */ }
        return new Response(JSON.stringify({
          toolScope: scope?.toolScope === 'preset' ? 'preset' : 'global',
          presets,
          names,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    void connection.fetch.register({
      path: '/api/cad/usage',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response(JSON.stringify(await usageReport(), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    void connection.fetch.register({
      path: '/api/cad/manifest',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { store } = requestStores(request);
        const { readManifest } = await import('./version.ts');
        const manifest = await readManifest(store);
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // --- products: the one browse axis the panel uses (versions + runs) ------
    // A version is a part artifact; a run is a validation artifact that names
    // the version(s) it was computed on. The panel picks a product and lets its
    // `type` decide the presentation — there is no mode to choose first.
    void connection.fetch.register({
      path: '/api/cad/products',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        // ONE read port (src/host/store.ts): it owns the snapshot cache, the
        // change sequence and the address grammar. This route no longer reads
        // three manifests itself.
        const project = requestStores(request);
        const cadStore = storeFor(project);
        const url = new URL(request.url);
        const since = Number(url.searchParams.get('since') ?? NaN);
        const { wire, seq, stamp } = await cadStore.snapshot();
        // The ETag is the manifests' content stamp, so a reconnecting client can
        // revalidate even after the host restarted (the seq resets with it).
        const etag = `W/"${stamp.replace(/[^\w.:-]/g, '_')}"`;
        const inm = request.headers.get('if-none-match');
        if ((inm && inm === etag) || (Number.isFinite(since) && since === seq)) {
          return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
        }
        // `project` rides the payload so a panel that switched projects can
        // discard the reply of the one it just left. Wire shape: every run once
        // + `runIds` per part; the panel inflates with `coerceProducts`.
        const payload = { ...wire, project: project.cwd, seq };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' },
        });
      },
    });

    // --- unregistered geometry: the panel's 未登记 category -------------------
    // The SAME scan `delivery_audit` blocks on, so the human sees the machine's
    // list (one implementation, two readers). Read-only: the bytes come from
    // /api/cad/file below, and nothing here can create a version.
    void connection.fetch.register({
      path: '/api/cad/unregistered',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        const { readManifest } = await import('./version.ts');
        const { scanUnregistered } = await import('./unregistered.ts');
        const manifest = await readManifest(project.store);
        const scan = await scanUnregistered({
          project,
          workspace: project.cwd,
          scanPaths: ['.'],
          versions: manifest.versions,
        });
        // `project` rides the payload so a panel that switched projects can
        // discard a stale reply (same rule as /api/cad/products).
        return new Response(JSON.stringify({ ...scan, project: project.cwd }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // --- the review queue: badge, decisions, and the ONE write it can cause --
    //
    // Reading the queue is cheap and idempotent; changing an item's status is the
    // human saying "seen it" / "no"; approving a rollback is the only action that
    // touches the corpus, and it does so by ADDING a version (never rewriting).
    void connection.fetch.register({
      path: '/api/cad/review/queue',
      methods: ['GET'],
      fetch: async (request: Request) => {
        const project = requestStores(request);
        const state = await readQueue(project.root);
        return new Response(JSON.stringify({
          items: state.items,
          unread: state.items.filter((i) => i.status === 'unread').length,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    void connection.fetch.register({
      path: '/api/cad/review/status',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const body = await request.json() as { id?: string; status?: string };
        const status = body?.status;
        if (!body?.id || (status !== 'unread' && status !== 'read' && status !== 'dismissed')) {
          return new Response(JSON.stringify({ error: 'id and status (unread|read|dismissed) are required' }),
            { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const project = requestStores(request);
        const item = await setReviewStatus(project.root, body.id, status);
        return item
          ? new Response(JSON.stringify({ item }), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ error: `unknown queue item "${body.id}"` }),
            { status: 404, headers: { 'content-type': 'application/json' } });
      },
    });
    void connection.fetch.register({
      path: '/api/cad/review/approve',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const body = await request.json() as { id?: string };
        if (!body?.id) {
          return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const project = requestStores(request);
        const state = await readQueue(project.root);
        const item = state.items.find((i) => i.id === body.id) ?? null;
        if (!item) {
          return new Response(JSON.stringify({ error: `unknown queue item "${body.id}"` }), { status: 404, headers: { 'content-type': 'application/json' } });
        }
        if (item.kind !== 'revert') {
          return new Response(JSON.stringify({ error: 'this item is not a rollback proposal' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const target = String(item.target ?? '');
        if (!/^v\d{3,}$/.test(target)) {
          return new Response(JSON.stringify({ error: 'the proposal has no version target' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        try {
          // Immutable: the rollback is a NEW version whose parent is the head.
          const versionId = await revertVersionHelper(project.store, target, { reason: item.title });
          await setReviewStatus(project.root, item.id, 'read', versionId);
          return new Response(JSON.stringify({ versionId, from: target }), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (e: any) {
          return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
      },
    });

    // A workspace file's geometry, tessellated for PREVIEW: the same readers as
    // import (STL as-is, STEP/3MF through the worker), nothing stored. The
    // storage policies (closed solid, one object) are suspended here on purpose —
    // a human deciding whether to import needs to SEE the broken plate.
    void connection.fetch.register({
      path: '/api/cad/file',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        const wanted = new URL(request.url).searchParams.get('path') ?? '';
        const { previewGeometry } = await import('./import.ts');
        try {
          const preview = await previewGeometry({ file: wanted, cwd: project.cwd });
          return new Response(preview.stl as unknown as BodyInit, {
            status: 200,
            headers: {
              'content-type': 'model/stl',
              'x-cad-format': preview.format,
              // 'file' = an STL's numbers are whatever its author used; the panel
              // must not print "mm" over a unit nobody declared.
              'x-cad-units': preview.unitsMm ? 'mm' : 'file',
              'x-cad-solid': preview.solid ? '1' : '0',
              'x-cad-shells': String(preview.shells),
              'x-cad-size': preview.boundingBoxMm.size.map((v) => v.toFixed(3)).join(','),
              'x-cad-warnings': encodeURIComponent(preview.warnings.join(' | ')),
              'cache-control': 'no-store',
            },
          });
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          return new Response(JSON.stringify({ error: message }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
      },
    });

    // --- workspaces: which corpora the panel may VIEW ------------------------
    // The write side stays bound to the session cwd; this endpoint only answers
    // "what else is here to look at". `root` is an absolute workspace root (the
    // session cwd), so a project with components/ or examples/ exposes them
    // without anyone opening a session inside each one.
    void connection.fetch.register({
      path: '/api/cad/projects',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const q = new URL(request.url).searchParams;
        const { cwd } = requestStores(request);
        const rootParam = q.get('root')?.trim();
        // Only an absolute path names a discovery root; a relative or missing
        // value falls back to the corpus already being viewed. Discovery reads
        // shallowly and never creates anything, so this cannot escape the demo.
        const root = rootParam && isAbsolute(rootParam) ? rootParam : cwd;
        const workspaces = await discoverWorkspaces(root);
        return new Response(JSON.stringify({ root, workspaces }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // One run's metadata + artifacts, addressed by run id — so a playback never
    // again means "whatever ran last".
    const runQuery = (request: Request) => {
      const q = new URL(request.url).searchParams;
      return { id: q.get('id') ?? '', q };
    };
    const runFileRoute = (
      routePath: string,
      file: (q: URLSearchParams) => string,
      missing: string,
      contentType: string,
      download?: (q: URLSearchParams, id: string) => string,
    ) =>
      void connection.fetch.register({
        path: routePath,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const { runStore } = requestStores(request);
          const { id, q } = runQuery(request);
          const path = runFilePath(runStore, id, file(q));
          if (!path) return new Response('bad run id', { status: 400 });
          try {
            const buf = await readFile(path);
            const headers: Record<string, string> = { 'content-type': contentType };
            // A saved artifact must say WHAT it is: `r098_B01.stl`, not `stl`.
            if (download) headers['content-disposition'] = contentDisposition(download(q, id));
            return new Response(buf as unknown as BodyInit, { status: 200, headers });
          } catch {
            return new Response(missing, { status: 404 });
          }
        },
      });

    void connection.fetch.register({
      path: '/api/cad/run',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { runStore } = requestStores(request);
        const { id } = runQuery(request);
        const entry = await readRun(runStore, id);
        return entry
          ? new Response(JSON.stringify(entry), {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'content-disposition': contentDisposition(downloadName([id, 'run'], 'json')),
              },
            })
          : new Response('no such run', { status: 404 });
      },
    });
    runFileRoute('/api/cad/run/report', () => 'report.json', 'no report for this run', 'application/json',
      (_q, id) => downloadName([id, 'report'], 'json'));
    // The panel's heatmap source: per-sample values for the attention field, written by
    // check_printability. Kept OUT of the tool reply (a 700-point field is noise to the
    // model and the whole picture to a human) and served to the browser instead.
    runFileRoute('/api/cad/run/attention', () => 'attention.json', 'no attention field for this run', 'application/json',
      (_q, id) => downloadName([id, 'attention'], 'json'));
    runFileRoute('/api/cad/run/trajectory', () => 'trajectory.json', 'no trajectory for this run', 'application/json',
      (_q, id) => downloadName([id, 'trajectory'], 'json'));
    runFileRoute('/api/cad/run/fluid-manifest', () => 'fluid-manifest.json', 'not a fluid run', 'application/json',
      (_q, id) => downloadName([id, 'fluid-manifest'], 'json'));
    runFileRoute('/api/cad/run/stl', (q) => {
      const part = safePart(q.get('part'));
      return `parts/${part ?? 'NONE'}.stl`;
    }, 'no such part in this run', 'model/stl',
      (q, id) => downloadName([id, safePart(q.get('part')) ?? 'part'], 'stl'));
    runFileRoute('/api/cad/run/image', (q) => `frames/${q.get('name') ?? 'NONE'}`, 'no such frame in this run', 'image/png',
      (q, id) => downloadName([id, (q.get('name') ?? 'image').split('/').pop() ?? 'image'], 'png'));
    void connection.fetch.register({
      path: '/api/cad/run/frame',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { runStore } = requestStores(request);
        const { id, q } = runQuery(request);
        const i = Number(q.get('i') ?? '0');
        const manifestPath = runFilePath(runStore, id, 'fluid-manifest.json');
        if (!manifestPath) return new Response('bad run id', { status: 400 });
        try {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { frames: { file: string }[] };
          const entry = manifest.frames[i];
          const path = entry ? runFilePath(runStore, id, `frames/${entry.file}`) : null;
          if (!path) return new Response('frame index out of range', { status: 404 });
          const bin = await readFile(path);
          return new Response(bin as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        } catch {
          return new Response('no fluid frames for this run', { status: 404 });
        }
      },
    });

    // Assembly-manifest check report (distinct schema from validate_assembly's
    // assembly-report.json which the panel parses). The report is written beside
    // whichever manifest was audited, so it is looked up the same way.
    void connection.fetch.register({
      path: '/api/cad/assembly/check',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        try {
          const { path } = await resolveAssemblyManifestPath(
            new URL(request.url).searchParams.get('manifestPath') ?? undefined,
            { workspace: project.cwd, dataRoot: project.root },
          );
          const raw = await readFile(join(path, '..', 'assembly-check-report.json'), 'utf8');
          // That file is a POINTER to the immutable run (FIX-C1). Follow it, and say which
          // run the answer came from — a consumer must be able to cite it. Old corpora
          // still hold a full report there; those are returned as-is.
          let parsed: { schema?: string; runId?: string } | null = null;
          try { parsed = JSON.parse(raw) as { schema?: string; runId?: string }; } catch { parsed = null; }
          if (parsed?.schema === 'assembly-check-pointer/v1' && typeof parsed.runId === 'string') {
            const reportPath = runFilePath(project.runStore, parsed.runId, 'report.json');
            if (!reportPath) return new Response('pointer names an unsafe run id', { status: 500 });
            const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
            return new Response(JSON.stringify({ ...report, runId: parsed.runId }), {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'content-disposition': contentDisposition(downloadName([parsed.runId, 'check'], 'json')),
              },
            });
          }
          return new Response(raw, {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-disposition': contentDisposition(downloadName([basename(path).replace(/\.[^.]+$/, ''), 'check'], 'json')),
            },
          });
        } catch {
          return new Response('no assembly check report yet', { status: 404 });
        }
      },
    });
    void connection.fetch.register({
      path: '/api/cad/assembly/manifest',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        try {
          const { path } = await resolveAssemblyManifestPath(
            new URL(request.url).searchParams.get('manifestPath') ?? undefined,
            { workspace: project.cwd, dataRoot: project.root },
          );
          const raw = await readFile(path, 'utf8');
          return new Response(raw, {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-disposition': contentDisposition(downloadName([basename(path).replace(/\.[^.]+$/, '')], 'json')),
            },
          });
        } catch {
          return new Response('no assembly manifest yet', { status: 404 });
        }
      },
    });

    // Manual initiation path ②: same runAssemblyCheckJob as the tool.
    void connection.fetch.register({
      path: '/api/cad/assembly/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        try {
          const body = await request.json().catch(() => ({}) as { manifestPath?: string });
          const { report, manifestFile } = await runAssemblyCheckJob(body.manifestPath, project);
          return new Response(JSON.stringify({ ...report, manifestPath: manifestFile }, null, 2), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        } catch (e) {
          return new Response(`assembly check failed: ${String((e as Error).message ?? e)}`, { status: 500 });
        }
      },
    });

    const EXPORT_FORMATS: Record<string, string> = {
      stl: 'model/stl', '3mf': 'model/3mf', obj: 'text/plain', off: 'text/plain', wrl: 'model/vrml',
    };
    void connection.fetch.register({
      path: '/api/cad/export',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        const { store } = project;
        const url = new URL(request.url);
        const v = url.searchParams.get('v');
        const format = (url.searchParams.get('format') ?? 'stl').toLowerCase();
        if (!v) return new Response('missing v', { status: 400 });
        if (!EXPORT_FORMATS[format]) return new Response(`unsupported format: ${format}`, { status: 400 });
        // The saved file must name the part, not just `model_v031`: a download is
        // read out of context, and `v031` alone does not say "碳原子 C".
        const resolved = await storeFor(project).resolve(v);
        const partName = resolved?.kind === 'version' ? resolved.partName : null;
        const versionDir = join(store.root, 'versions', v);
        try {
          // STL is stored at creation; other formats convert once and cache.
          let bytes: Uint8Array;
          if (format === 'stl') {
            bytes = await readFile(join(versionDir, 'model.stl'));
          } else {
            const cached = join(versionDir, `export_${format}.${format}`);
            try {
              bytes = await readFile(cached);
            } catch {
              const { exportScad } = await import('./compile.ts');
              // An imported version has no model.scad, but the mesh is still the
              // truth — wrap it in the smallest source that reproduces it. 3MF
              // is the print-handoff format, so this path has to work for a
              // partner's or a purchased part, not only for generated ones.
              let source = join(versionDir, 'model.scad');
              try {
                await readFile(source);
              } catch {
                source = join(versionDir, 'export_source.scad');
                await writeFile(source, `import("${join(versionDir, 'model.stl')}");\n`, 'utf8');
              }
              bytes = await exportScad(source, cached, format);
            }
          }
          return new Response(bytes as unknown as BodyInit, {
            status: 200,
            headers: {
              'content-type': EXPORT_FORMATS[format]!,
              'content-disposition': contentDisposition(downloadName([partName, v], format, `model_${v}`)),
            },
          });
        } catch (e: any) {
          return new Response(`export failed: ${String(e?.message ?? e)}`, { status: 500 });
        }
      },
    });

    // docs/archive/M4-PREP.md §4.6 manual-initiation path ②: import an external file without
    // going through the LLM. Body = import_part args. The file path is resolved
    // server-side against the project directory (or may be absolute), so this is
    // the door a script, a Makefile or a colleague's hand-off uses.
    void connection.fetch.register({
      path: '/api/cad/import',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as ImportPartArgs;
          if (!body?.file) return new Response('bad request: file required', { status: 400 });
          const project = requestStores(request);
          await ensureProjectDir(project);
          const result = await importPartJob(body, project);
          return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (e: any) {
          return new Response(`import failed: ${String(e?.message ?? e)}`, { status: 400 });
        }
      },
    });

    // docs/archive/M4-PREP.md §4.6 manual-initiation path ②: run a mechanism motion job
    // without going through the LLM. Body = simulate_motion tool args.
    void connection.fetch.register({
      path: '/api/cad/motion/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as Parameters<typeof runMotionJob>[0];
          if (!body?.parts || !body?.drive) return new Response('bad request: parts and drive required', { status: 400 });
          const result = await runMotionJob(body, requestStores(request));
          return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (e: any) {
          return new Response(`motion run failed: ${String((e as Error)?.message ?? e)}`, { status: 500 });
        }
      },
    });

    // docs/archive/M4-PREP.md §4.6 manual-initiation path ②: fluid run without the LLM
    void connection.fetch.register({
      path: '/api/cad/fluid/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as FluidToolArgs;
          if (!body?.pipeScad && !body?.versionId) return new Response('bad request: pipeScad or versionId required', { status: 400 });
          const result = await runFluidJob(body, requestStores(request));
          return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (e: any) {
          return new Response(`fluid run failed: ${String(e?.message ?? e)}`, { status: 500 });
        }
      },
    });

    // manual-initiation path ② for rigid-body physics
    void connection.fetch.register({
      path: '/api/cad/physics/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          const body = await request.json() as PhysicsToolArgs;
          if (!body?.parts || body.parts.length < 1) return new Response('bad request: parts required', { status: 400 });
          const result = await runPhysicsJob(body, requestStores(request));
          return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (e: any) {
          return new Response(`physics run failed: ${String(e?.message ?? e)}`, { status: 500 });
        }
      },
    });

    // --- legacy aliases: "latest run of kind X" ------------------------------
    // The panel addresses runs by id now; these stay so older consumers and any
    // script that hit the old URLs keep working.
    const latestFileRoute = (routePath: string, kinds: RunKind[], file: string, missing: string, contentType: string) =>
      void connection.fetch.register({
        path: routePath,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const { runStore } = requestStores(request);
          const run = await latestRun(runStore, kinds);
          const path = run ? runFilePath(runStore, run.id, file) : null;
          if (!path) return new Response(missing, { status: 404 });
          try {
            const buf = await readFile(path);
            return new Response(buf as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType } });
          } catch {
            return new Response(missing, { status: 404 });
          }
        },
      });

    latestFileRoute('/api/cad/assembly', ['assembly'], 'report.json', 'no assembly report yet', 'application/json');
    latestFileRoute('/api/cad/physics', ['physics'], 'report.json', 'no physics report yet', 'application/json');
    latestFileRoute('/api/cad/motion', ['motion'], 'report.json', 'no motion report yet', 'application/json');
    latestFileRoute('/api/cad/fluid', ['fluid'], 'report.json', 'no fluid report yet', 'application/json');
    latestFileRoute('/api/cad/motion/trajectory', ['motion', 'physics'], 'trajectory.json', 'no motion trajectory yet', 'application/json');
    latestFileRoute('/api/cad/physics/trajectory', ['physics'], 'trajectory.json', 'no physics trajectory yet', 'application/json');
    latestFileRoute('/api/cad/fluid/manifest', ['fluid'], 'fluid-manifest.json', 'no fluid frames yet', 'application/json');
    latestFileRoute('/api/cad/fluid/wall', ['fluid'], 'parts/wall.stl', 'no fluid wall yet', 'model/stl');

    // part names are constrained to the run's own compiled files (no traversal)
    const partRoute = (routePath: string, kinds: RunKind[]) => void connection.fetch.register({
      path: routePath,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { runStore } = requestStores(request);
        const part = safePart(new URL(request.url).searchParams.get('part'));
        const run = await latestRun(runStore, kinds);
        const path = run && part ? runFilePath(runStore, run.id, `parts/${part}.stl`) : null;
        if (!path) return new Response('no such stl', { status: 404 });
        try {
          const stl = await readFile(path);
          return new Response(stl as unknown as BodyInit, { status: 200, headers: { 'content-type': 'model/stl' } });
        } catch {
          return new Response('no such stl', { status: 404 });
        }
      },
    });
    partRoute('/api/cad/motion/stl', ['motion']);
    partRoute('/api/cad/physics/stl', ['physics']);

    void connection.fetch.register({
      path: '/api/cad/fluid/frame',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { runStore } = requestStores(request);
        const i = Number(new URL(request.url).searchParams.get('i') ?? '0');
        const run = await latestRun(runStore, ['fluid']);
        const manifestPath = run ? runFilePath(runStore, run.id, 'fluid-manifest.json') : null;
        if (!manifestPath) return new Response('no fluid frames yet', { status: 404 });
        try {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { frames: { file: string }[] };
          const entry = manifest.frames[i];
          const path = entry && run ? runFilePath(runStore, run.id, `frames/${entry.file}`) : null;
          if (!path) return new Response('frame index out of range', { status: 404 });
          const bin = await readFile(path);
          return new Response(bin as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        } catch {
          return new Response('no fluid frames yet', { status: 404 });
        }
      },
    });

    // The attention field for a VERSION (not a run): the newest printability run that
    // measured it. The panel asks by version because that is what its preview shows;
    // asking it to know run ids would be the client guessing at server bookkeeping.
    void connection.fetch.register({
      path: '/api/cad/attention',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { store, runStore } = requestStores(request);
        const params = new URL(request.url).searchParams;
        // `?id=<runId>` pins the field to the artifact the human selected (DESIGN §6.9b:
        // the product is the subject). `?v=<versionId>` keeps the old "newest field for
        // this version" behaviour for the version view, and the response names the run.
        const pinnedId = params.get('id');
        if (pinnedId) {
          if (!/^r\d{3,}$/.test(pinnedId)) return new Response('bad run id', { status: 400 });
          const pinnedPath = runFilePath(runStore, pinnedId, 'attention.json');
          if (!pinnedPath) return new Response('bad run id', { status: 400 });
          try {
            const body = await readFile(pinnedPath);
            const run = (await listRuns(runStore)).find((r) => r.id === pinnedId);
            const field = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            return new Response(JSON.stringify({
              ...field,
              source: { runId: pinnedId, kind: run?.kind ?? 'unknown', timestamp: run?.timestamp ?? '', title: run?.title },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          } catch {
            return new Response(`run ${pinnedId} has no attention field`, { status: 404 });
          }
        }
        const wanted = params.get('v');
        if (!wanted) return new Response('missing v (or id)', { status: 400 });
        const runs = await listRuns(runStore);
        const candidates = runs
          .filter((r) => (r.kind === 'printability' || r.kind === 'stress' || r.kind === 'analyze') && (r.sourceVersionIds ?? []).includes(wanted))
          .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        for (const run of candidates) {
          const path = runFilePath(runStore, run.id, 'attention.json');
          if (!path) continue;
          try {
            const body = await readFile(path);
            const field = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            // WHICH run this field came from is part of the picture: several runs can
            // carry a field for the same version (press/stress/analyze) and the newest
            // wins here, so a legend that does not name its source is unattributable
            // (2026-10-23 audit, FIX-E5). The client renders this.
            const payload = {
              ...field,
              source: { runId: run.id, kind: run.kind, timestamp: run.timestamp, title: run.title },
            };
            return new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          } catch { /* try the next one */ }
        }
        return new Response(`no attention field for ${wanted}`, { status: 404 });
      },
    });

    void connection.fetch.register({
      path: '/api/cad/stl',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { store } = requestStores(request);
        const { listVersions } = await import('./version.ts');
        const wanted = new URL(request.url).searchParams.get('v');
        const versions = await listVersions(store);
        const target = versions.find((v) => v.id === wanted)
          ?? versions.find((v) => v.status !== 'rejected');
        if (!target) return new Response('no versions', { status: 404 });
        try {
          const stl = await readFile(join(store.root, 'versions', target.id, 'model.stl'));
          return new Response(stl as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'model/stl' },
          });
        } catch {
          return new Response(`no stl for ${target.id}`, { status: 404 });
        }
      },
    });
  };
  // --- run_python / python_runtime: the bundled Python runtime --------------
  //
  // Registered through the same helper as every other CAD tool, so the preset
  // scope filter hides them from sessions that never named the CAD preset. The
  // runtime itself is an artifact this plugin ships (DECISION-LOG 2026-10-08),
  // not a capability we assume the host machine has.
  registerPythonTools(registerTool, ctx.logger);

  registerWhenReady();
  return registered;
}
