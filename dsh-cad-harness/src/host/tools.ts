// M1 tools: generate_part (compile + version + multiview render to the model).

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import { compileAndRender, compileStlOnly, renderScadPng } from './compile.ts';
import { datumNames, readVersionDatums, readVersionDatumPoints, readVersionEntry, saveVersion, unionDatumSets, versionExists, writeVersionDatums } from './version.ts';
import {
  attachVersion, createUniquePart, derivePartName, ensurePart, findPartById, findPartByName,
  listParts, type PartEntry,
} from './parts.ts';
import { buildProducts } from './products.ts';
import { beginRun, latestRun, listRuns, readRun, runFilePath, safeArtifactName, type RunKind, type RunStatus } from './runs.ts';
import { validateAssembly, buildSolid, type AssemblyPartInput } from './assembly.ts';
import { assemblyFrameDir, renderAssemblyViews } from './assembly-render.ts';
import type { InterfaceCheckResult } from './assembly-check.ts';
import { resolveAssemblyManifestPath } from './manifest.ts';
import { registerUsageObserver, usageReport } from './usage.ts';
import { projectStoresFor, requestStores, ensureProjectDir, type ProjectStores } from './project.ts';
import { measureVersion, renderStlViews, renderVersionFrame, type RenderPartRequest } from './inspect.ts';
import { connectedBodies, parseBinaryStl, boundingBox as boundingBoxOf, boundingBoxCentre, isWatertight, rebaseMesh, shellCount, writeBinaryStl, type ParsedMesh } from './mesh.ts';
import { runPhysics, renderKeyframes, type PhysicsPartInput, type PhysicsReport } from './physics.ts';
import { runMotion } from './motion.ts';
import { runFluid, deriveFluidPreset } from './fluid.ts';
import { renderFluidSnapshot, gridBounds } from './fluid-render.ts';
import { measureDistance, closestPointsBetweenMeshes, closestPointsMeshVsSphere, buildMeshBvh, type MeshData } from './measure.ts';
import { Ray, Vector3, DoubleSide } from 'three';
import {
  deriveNameFromFile, importGeometry, normalizeDatums, type DatumInput, type Unit,
} from './import.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, join, relative } from 'node:path';

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
export function cadToolNames(): readonly string[] {
  return registeredCadTools;
}

export function registerCadTools(
  ctx: Context,
  scope?: { toolScope?: string; presets?: readonly string[] },
): readonly string[] {
  const registered: string[] = [];
  const registerTool = (definition: { name: string }) => {
    registered.push(definition.name);
    registeredCadTools.push(definition.name);
    return ctx.tools.register(definition as never);
  };

  // Stores are resolved PER CALL, never captured here: the plugin is applied
  // once for the whole profile, while every tool call and every browser request
  // belongs to one project (its session's cwd — see project.ts). Capturing them
  // at apply time is what made a new project list the previous project's parts.
  const allStores = (exec: unknown): Promise<ProjectStores> => projectStoresFor(exec);

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
    const parts = [];
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
    // pose of every point is unchanged (R(local−p) + (pos+p) = R·local + pos),
    // and the stored STL is the re-based one, so the panel's playback and the
    // keyframe renders stay consistent with the trajectory.
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

      const rebased = rebaseMesh(mesh, pivot);
      const stl = writeBinaryStl(rebased, `motion part ${p.name} rebased on its pivot`);
      usedVersions.push(g.versionId);
      geometries.push({ name: p.name, stl });
      parts.push({
        name: p.name,
        stl,
        bodyType: p.bodyType as 'dynamic' | 'fixed' | 'kinematic',
        position: [p.position[0]! + pivot[0], p.position[1]! + pivot[1], p.position[2]! + pivot[2]] as [number, number, number],
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
    const sourceVersionIds = collectVersions(usedVersions);

    // The run owns its geometry: parts are written where the panel can fetch
    // them per run (and where the keyframe renderer can import them).
    const run = await beginRun(runStore, {
      kind: 'motion',
      title: `机构运动 · ${provenanceLabel(sourceVersionIds)}`,
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
    await run.json('report.json', report);
    await run.json('trajectory.json', { kind: 'motion', durationSec: report.durationSec, trajectory: report.trajectory });
    const pngs = await renderKeyframes(report as unknown as PhysicsReport, stlFiles, join(run.dir, 'frames'));
    const keep = pngs.slice(0, 4);
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
    await run.commit({
      title: `机构运动 · ${provenanceLabel(sourceVersionIds)}`,
      sourceVersionIds,
      status: report.overallStatus === 'pass' ? 'pass' : 'check',
      summary: `干涉 ${report.metrics.interferenceCount} 次` +
        (followerList.length ? ` · 行程 ${followerList[0]!.travelMm.toFixed(1)}mm` : ''),
    });
    return {
      overallStatus: report.overallStatus,
      followers: report.metrics.followers,
      interferenceCount: report.metrics.interferenceCount,
      interferenceEvents: report.metrics.interferenceEvents,
      maxJointDriftMm: report.metrics.maxJointDriftMm,
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
      'Compile OpenSCAD into a new part version; renders top/front/side/iso (all four attached by default; trim with `views` to save image budget on numeric iterations). Write complete self-contained code with $fn=64 (BOSL2 is available: std/screws/gears/walls). Declare anchors with `datum("name",[x,y,z])` at top level in final world coordinates; they do not affect the mesh.',
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
          'For an iteration that only changes a number you will verify by measurement (a hole Ø, a length), pass ["iso"] and keep the budget for the pictures that matter.',
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
      // silhouette. Unrecognised names never silently attach nothing.
      const wantedViews = (Array.isArray(a.views) && a.views.length)
        ? (result.renders ?? []).map((r) => r.view).filter((v) => (a.views as string[]).includes(v))
        : null;
      const attachedRenders = wantedViews?.length
        ? (result.renders ?? []).filter((r) => wantedViews.includes(r.view))
        : (result.renders ?? []);

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
          `DISCIPLINE (DESGIGN §18): ${shellCount(parsed!)} disconnected bodies in one version — a part must be a ` +
          'single connected solid. Either union the fragments in OpenSCAD, or model them as SEPARATE parts. ' +
          'Run check_connectivity to see where each body sits.',
        );
      }

      return {
        versionId, success: true,
        part: part.name,
        errors: [], warnings: result.warnings,
        durationMs: result.durationMs,
        views: attachedRenders.map((r) => r.view),
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
      if (!a?.name?.trim()) throw new Error('create_part needs a non-empty name');
      const existing = await findPartByName(partStore, a.name);
      if (existing) return { partId: existing.id, name: existing.name, created: false };
      const part = await createUniquePart(partStore, a.name, 'agent');
      return { partId: part.id, name: part.name, created: true };
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
    if (!a?.file?.trim()) throw new Error('import_part needs a file path');

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
      'Import an external STL (binary or ASCII, mm z-up) as a new version of a part, so it can be measured, assembled and simulated like any generated part. ' +
      'Runs the same truth engine on it and REFUSES a mesh that is not a closed solid unless allowNonSolid. STEP/IGES unsupported (no B-rep kernel) — convert to STL first.',
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
        description: 'The source file\'s unit as DECLARED by you: mm (default), cm, m or inch. STL carries no unit, so this is never inferred.',
      },
      scale: {
        type: 'number',
        description: 'Extra multiplier applied on top of unit, e.g. 0.5 for a half-scale model.',
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
          format: { type: 'string', required: true, description: 'stl-binary or stl-ascii.' },
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
    if (!Array.isArray(a.parts) || a.parts.length < 2) throw new Error('merge_parts needs at least 2 parts');
    assertPartNames(a.parts, 'merge_parts');
    if (!a.userIntent?.trim()) throw new Error('merge_parts needs a userIntent — it names the merged part');

    const part = await resolvePartForWrite({
      part: a.part,
      parentVersion: undefined,
      fallbackName: derivePartName(a.userIntent),
    }, project);

    const warnings: string[] = [];
    const sources: { name: string; versionId?: string }[] = [];
    const provenance: { name: string; versionId: string | null }[] = [];
    let union: Awaited<ReturnType<typeof buildSolid>>['solid'] | null = null;
    for (const p of a.parts) {
      const g = await resolvePartGeometry(p, project);
      sources.push({ name: p.name, ...(g.versionId ? { versionId: g.versionId } : {}) });
      provenance.push({ name: p.name, versionId: g.versionId });
      let solid: Awaited<ReturnType<typeof buildSolid>>['solid'];
      try {
        ({ solid } = await buildSolid(g.stl, {
          translate: p.translate as [number, number, number] | undefined,
          rotate: p.rotate as [number, number, number] | undefined,
        }));
      } catch (e) {
        throw new Error(`merge_parts: part "${p.name}" is not a usable solid — ${(e as Error).message}`);
      }
      union = union ? union.add(solid) : solid;
    }
    if (!union) throw new Error('merge_parts produced nothing');

    const gm = union.getMesh();
    const mesh: ParsedMesh = { vertProperties: gm.vertProperties, triVerts: gm.triVerts };
    const stl = writeBinaryStl(mesh, `dsh-cad-harness merge of ${a.parts.length} parts`);
    const shells = shellCount(mesh);
    if (shells > 1) {
      warnings.push(
        `the merged body has ${shells} disjoint shells — the parts you merged do not all touch. ` +
        'That is legitimate for a rigid-body study, but a volume or centre-of-mass read off it ' +
        'is the sum over all shells, and a physics run will treat them as one rigid body.',
      );
    }
    const bb = boundingBoxOf(mesh);
    const sizeMm = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

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
      triangles: mesh.triVerts.length / 3,
      volumeMm3: union.volume(),
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
      'Union two or more parts, each at its assembly placement, into ONE new solid part version. Use it when the whole machine must be a single rigid body: simulate_physics topple/stability, or a whole-assembly measure_part. Replaces hand-merging STLs in OpenSCAD. mm, z-up; rotate (XYZ degrees) first, then translate.',
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
      'Read or write the datum anchors of an EXISTING version, without creating a new one. Call it with only versionId to list what a version declares (names and world coordinates) — the input you need to write assembly interfaces. Call it with datums to add or replace anchors on that same version, since datums are metadata and do not change the mesh.',
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
          versionId: { type: 'string', required: true },
          userIntent: { type: 'string', required: true },
          mode: { type: 'string', required: true },
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
      if (!known) throw new Error(`unknown version ${a.versionId}`);
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
      await writeVersionDatums(store, a.versionId, next);
      return {
        versionId: a.versionId,
        userIntent: known.userIntent,
        mode: a.replace ? 'replaced' : 'merged',
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
        throw new Error('validate_assembly needs at least 2 parts');
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
        title: `装配间隙 · ${provenanceLabel(sourceVersionIds)}`,
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
      await run.commit({
        title: `装配间隙 · ${provenanceLabel(sourceVersionIds)}`,
        sourceVersionIds,
        status: report.overallStatus === 'pass' ? 'pass' : 'fail',
        summary: `${report.pairs.length} 对 · 干涉 ${clash} · 过紧 ${tight}`,
        // Same part set = same question re-asked; the newest answer is the one
        // that counts, so older runs about this exact set become history.
        subject: `parts:${a.parts.map((p) => p.name).slice().sort().join('+')}`,
      });

      assemblyRefsForFinalize = { refs, views: pngs.length, runId: run.id, thresholdMm: report.thresholdMm };
      return {
        overallStatus: report.overallStatus,
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

  /** Shared by the simulate_physics tool and POST /api/cad/physics/run (M4-PREP §4.6 path ②). */
  async function runPhysicsJob(a: PhysicsToolArgs, project: ProjectStores) {
      const { runStore } = project;
      if (!Array.isArray(a.parts) || a.parts.length < 1) throw new Error('simulate_physics needs at least 1 part');
      assertPartNames(a.parts, 'simulate_physics');

      const parts: PhysicsPartInput[] = [];
      const stlFiles: { name: string; stlPath: string }[] = [];
      const usedVersions: (string | null)[] = [];
      const geometries: { name: string; stl: Uint8Array }[] = [];

      for (const p of a.parts) {
        const g = await resolvePartGeometry(p, project);
        usedVersions.push(g.versionId);
        geometries.push({ name: p.name, stl: g.stl });
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

      const run = await beginRun(runStore, {
        kind: 'physics',
        title: `刚体物理 · ${provenanceLabel(sourceVersionIds)}`,
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
      const pngs = await renderKeyframes(report, stlFiles, join(run.dir, 'frames'));
      const keep = pngs.slice(0, 4);
      const refs: { view: string; ref: unknown }[] = [];
      try {
        for (const f of keep) {
          const [ref] = await ctx.attachments.saveImages([{ data: f.png, mediaType: 'image/png', name: `physics-${f.view}` }]);
          if (ref) refs.push({ view: f.view, ref });
        }
      } catch (e) {
        report.metrics.jointViolations.push(`attachment save failed: ${String((e as Error).message)}`);
      }

      await run.json('report.json', report);
      await run.json('trajectory.json', { kind: 'physics', durationSec: report.durationSec, trajectory: report.trajectory });
      const svg = report.metrics;
      const sank = svg.settledPenetrationMm > 1;
      const fellNames = Object.entries(svg.fellOver).filter(([, v]) => v === true).map(([n]) => n);
      const overall: RunStatus = sank || fellNames.length > 0 || svg.jointViolations.length > 0 ? 'check' : 'pass';
      await run.commit({
        title: `刚体物理 · ${provenanceLabel(sourceVersionIds)}`,
        sourceVersionIds,
        status: overall,
        summary: `稳态穿透 ${svg.settledPenetrationMm.toFixed(2)}mm` +
          (fellNames.length ? ` · 倒下 ${fellNames.join(',')}` : '') +
          (svg.jointViolations.length ? ` · 约束异常 ${svg.jointViolations.length}` : ''),
      });

      const result = {
        overallStatus: overall,
        settledPenetrationMm: svg.settledPenetrationMm,
        maxPenetrationMm: svg.maxPenetrationMm,
        fellOver: svg.fellOver,
        jointViolations: svg.jointViolations,
        ...(svg.holdAnalysis ? { holdAnalysis: svg.holdAnalysis } : {}),
        notes: svg.notes,
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
            bodyType: { type: 'string', required: true, description: '"dynamic" (moves) or "fixed" (immovable boundary).' },
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
      summary: `到达率 ${m.outletArrivalRatio ?? '—'} · 穿透 ${m.penetrationCount ?? '—'} · 粒子 ${m.particleCount0 ?? '—'}`,
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
      'Assembled-mechanism kinematics: one constant-speed crank, revolute/prismatic followers, optionally parts on prescribed sinusoidal paths. Returns stroke/period, an exact interference timeline per sampled pose, joint anchor drift, keyframes. Gravity is off.',
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
            bodyType: { type: 'string', required: true, description: '"dynamic" (follows joints), "fixed" (frame), or "kinematic" (driven/prescribed).' },
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
        required: true,
        description: 'The constant-speed crank drive.',
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
      cycles: { type: 'number', description: 'Drive cycles to simulate. Default 2.' },
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
          maxJointDriftMm: { type: 'number', required: true },
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
      if (!Array.isArray(a.parts) || a.parts.length < 2) throw new Error('simulate_motion needs at least 2 parts');
      if (!a.drive) throw new Error('simulate_motion needs a drive (crank) specification');
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
          maxJointDriftMm: number;
          jointViolations: string[];
          pivots: Record<string, number[]>;
          keyframes: string[];
          stepsRun: number;
          durationSec: number;
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
      const lines = [
        `Motion ${value.overallStatus}. Ran ${value.stepsRun} steps / ${value.durationSec}s.`,
        `Interference: ${value.interferenceCount} event(s)` +
          (events.length ? ` — ${events.join('; ')}` : '') +
          (more > 0 ? ` (+${more} more in the run report)` : ''),
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
      const pngPath = join(store.root, 'versions', a.versionId, `inspect_${Date.now()}.png`);
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

  // --- measure_part: exact geometry ground truth ---
  registerTool(defineTool({
    name: 'measure_part',
    description:
      'Whole-part ground truth: bounding box, volume, surface area, centre of mass, triangle count, watertightness, genus.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version, e.g. "v003".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          watertight: { type: 'boolean', required: true },
          triangles: { type: 'integer', required: true },
          sizeMm: { type: 'array', required: true, items: { type: 'number' } },
          volumeMm3: { type: 'number', required: true },
          surfaceAreaMm2: { type: 'number', required: true },
          centerOfMassMm: { type: 'array', required: true, items: { type: 'number' } },
          genus: { type: 'integer', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 30_000,
    async execute(args: unknown, exec: unknown) {
      const { versionId } = args as { versionId: string };
      const { store } = await allStores(exec);
      const m = await measureVersion(store, versionId);
      return {
        versionId: m.versionId,
        watertight: m.watertight,
        triangles: m.triangles,
        sizeMm: m.boundingBoxMm.size,
        volumeMm3: m.volumeMm3,
        surfaceAreaMm2: m.surfaceAreaMm2,
        centerOfMassMm: m.centerOfMassMm,
        genus: m.genus,
      };
    },
  }));

  // --- measure_distance: two-point surface measurement (M2/M3 gap fill) ---
  registerTool(defineTool({
    name: 'measure_distance',
    description:
      'Exact distance between two points, each snapped to its part\'s surface; reports the snapped coordinates, how far your input was from the surface, and whether it was inside the solid. Datums resolve exactly, without snapping.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version of the base part, e.g. "v003".' },
      aPoint: { type: 'array', description: 'First point [x,y,z] mm — approximate is fine (snapped to surface). Give this OR aDatum.', items: { type: 'number' } },
      bPoint: { type: 'array', description: 'Second point [x,y,z] mm. Give this OR bDatum.', items: { type: 'number' } },
      bVersionId: { type: 'string', description: 'Second part to snap b onto (cross-part measurement). Defaults to versionId.' },
      aDatum: { type: 'string', description: 'Name of a datum anchor declared via datum("name",[x,y,z]) in the part code. Resolved EXACT (no snapping) — prefer over aPoint.' },
      bDatum: { type: 'string', description: 'Datum anchor name for b. Prefer over bPoint.' },
      snap: { type: 'boolean', description: 'Snap raw coordinate inputs to the nearest surface point. Default true. Datum-resolved points are never snapped.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          distanceMm: { type: 'number', required: true },
          dxMm: { type: 'number', required: true },
          dyMm: { type: 'number', required: true },
          dzMm: { type: 'number', required: true },
          aSnapped: { type: 'array', required: true, items: { type: 'number' } },
          bSnapped: { type: 'array', required: true, items: { type: 'number' } },
          aSnapDistanceMm: { type: 'number', required: true },
          bSnapDistanceMm: { type: 'number', required: true },
          aOutside: { type: 'boolean', required: true },
          bOutside: { type: 'boolean', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as { versionId: string; aPoint?: number[]; bPoint?: number[]; aDatum?: string; bDatum?: string; bVersionId?: string; snap?: boolean };
      const { store } = await allStores(exec);
      const loadMesh = async (v: string): Promise<MeshData> => {
        const bytes = await readFile(join(store.root, 'versions', v, 'model.stl'));
        return parseBinaryStl(new Uint8Array(bytes));
      };
      const loadDatums = (v: string): Promise<Record<string, [number, number, number]>> =>
        readVersionDatumPoints(store, v);
      const resolve = async (side: 'a' | 'b', datumName?: string, point?: number[]): Promise<[number, number, number]> => {
        if (datumName) {
          const datums = await loadDatums(side === 'a' ? a.versionId : (a.bVersionId ?? a.versionId));
          const hit = datums[datumName];
          if (!hit) {
            const known = Object.keys(datums).join(', ') || 'none';
            throw new Error(`datum "${datumName}" not found on ${side === 'a' ? a.versionId : (a.bVersionId ?? a.versionId)} (declared: ${known})`);
          }
          return hit;
        }
        if (!point) throw new Error(`point ${side} needs aPoint/bPoint or ${side}Datum`);
        return point as [number, number, number];
      };
      const aPt = await resolve('a', a.aDatum, a.aPoint);
      const bPt = await resolve('b', a.bDatum, a.bPoint);
      const meshA = await loadMesh(a.versionId);
      const meshB = a.bVersionId ? await loadMesh(a.bVersionId) : null;
      // A snapped distance on an open surface is a number about a mesh that
      // does not describe a solid (microscope3: measure_closest reported
      // 0.05mm "clearance" on exactly such a mesh). Never refuse — datums
      // still resolve exactly — but roar.
      const warnings: string[] = [];
      for (const [label, m, v] of [['a', meshA, a.versionId], ['b', meshB, a.bVersionId ?? a.versionId]] as const) {
        if (m && !isWatertight(m).watertight) {
          warnings.push(`part ${label} (${v}) is NOT watertight — surface snapping on an open mesh is unreliable, fix the mesh before trusting this number`);
        }
      }
      // datum-resolved points are exact declarations — never snap them;
      // raw coordinate inputs snap to the nearest surface by default
      const snapRaw = a.snap ?? true;
      const out = measureDistance(meshA, meshB, aPt, bPt, {
        snapA: snapRaw && !a.aDatum,
        snapB: snapRaw && !a.bDatum,
      });
      const aSnapDistanceMm = a.aDatum ? 0 : out.aSnapDistanceMm;
      const bSnapDistanceMm = a.bDatum ? 0 : out.bSnapDistanceMm;
      const aOutside = a.aDatum ? false : out.aOutside;
      const bOutside = a.bDatum ? false : out.bOutside;
      return {
        distanceMm: out.distanceMm,
        dxMm: out.dxMm,
        dyMm: out.dyMm,
        dzMm: out.dzMm,
        aSnapped: out.aSnapped,
        bSnapped: out.bSnapped,
        aSnapDistanceMm,
        bSnapDistanceMm,
        aOutside,
        bOutside,
        warnings,
      };
    },
  }));

  // --- measure_closest: solved closest-point pair between two solids (no coordinates from the model) ---
  registerTool(defineTool({
    name: 'measure_closest',
    description:
      'Solved closest point pair between two solids: give two version ids, or a version plus an analytic sphere probe. Returns the distance, both 3D points, and an annotated render. No coordinates needed from you.',
    parameters: {
      aVersionId: { type: 'string', description: 'First solid: saved version id.' },
      bVersionId: { type: 'string', description: 'Second solid: saved version id.' },
      aSphere: {
        type: 'object',
        description: 'First solid as an analytic sphere probe {center:[x,y,z], radius} — solved exactly.',
        additionalProperties: false,
        properties: {
          center: { type: 'array', required: true, items: { type: 'number' } },
          radius: { type: 'number', required: true },
        },
      },
      bSphere: {
        type: 'object',
        description: 'Second solid as an analytic sphere probe.',
        additionalProperties: false,
        properties: {
          center: { type: 'array', required: true, items: { type: 'number' } },
          radius: { type: 'number', required: true },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          distanceMm: { type: 'number', required: true },
          pointA: { type: 'array', required: true, items: { type: 'number' } },
          pointB: { type: 'array', required: true, items: { type: 'number' } },
          method: { type: 'string', required: true },
          frame: { type: 'string', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 180_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as {
        aVersionId?: string; bVersionId?: string;
        aSphere?: { center: number[]; radius: number };
        bSphere?: { center: number[]; radius: number };
      };
      const { store } = await allStores(exec);
      const loadMesh = async (v: string): Promise<MeshData> => {
        const bytes = await readFile(join(store.root, 'versions', v, 'model.stl'));
        return parseBinaryStl(new Uint8Array(bytes));
      };
      const exactlyOne = (x?: unknown, y?: unknown) => (x ? 1 : 0) + (y ? 1 : 0) === 1;
      if (!exactlyOne(a.aVersionId, a.aSphere)) throw new Error('specify exactly one of aVersionId / aSphere');
      if (!exactlyOne(a.bVersionId, a.bSphere)) throw new Error('specify exactly one of bVersionId / bSphere');

      // solve
      let distanceMm: number, pointA: [number, number, number], pointB: [number, number, number], method: string;
      const wtWarnings: string[] = [];
      const checkWt = async (v: string, label: string) => {
        const m = parseBinaryStl(new Uint8Array(await readFile(join(store.root, 'versions', v, 'model.stl'))));
        if (!isWatertight(m).watertight) {
          wtWarnings.push(`part ${label} (${v}) is NOT watertight — a closest-point pair on an open surface is not a clearance between solids (microscope3: this exact tool reported a fake 0.05mm margin on a broken mesh)`);
        }
      };
      if (a.aVersionId) await checkWt(a.aVersionId, 'a');
      if (a.bVersionId) await checkWt(a.bVersionId, 'b');
      if (a.aSphere && a.bSphere) throw new Error('sphere-vs-sphere: subtract the centres yourself — distance is analytic');
      if (a.aSphere && a.bVersionId) {
        ({ distanceMm, pointA, pointB } = closestPointsMeshVsSphere(await loadMesh(a.bVersionId), a.aSphere.center as [number, number, number], a.aSphere.radius));
        [pointA, pointB] = [pointB, pointA]; // sphere branch returns mesh point first
        method = 'sphere-analytic';
      } else if (a.bSphere && a.aVersionId) {
        ({ distanceMm, pointA, pointB } = closestPointsMeshVsSphere(await loadMesh(a.aVersionId), a.bSphere.center as [number, number, number], a.bSphere.radius));
        method = 'sphere-analytic';
      } else {
        const [ma, mb] = await Promise.all([loadMesh(a.aVersionId!), loadMesh(a.bVersionId!)]);
        ({ distanceMm, pointA, pointB } = closestPointsBetweenMeshes(ma, mb));
        method = 'mesh-vertex-exact';
      }

      // annotated render: parts + marker spheres + connector
      const measureDir = join(store.root, 'measure');
      await mkdir(measureDir, { recursive: true });
      const partScad = async (versionId: string | undefined, color: string, name: string): Promise<string> => {
        if (!versionId) return '';
        const bytes = await readFile(join(store.root, 'versions', versionId, 'model.stl'));
        const path = join(measureDir, `${name}.stl`);
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

      const scadPath = join(measureDir, `closest_${Date.now()}.scad`);
      const pngPath = scadPath.replace(/\.scad$/, '.png');
      await writeFile(scadPath, scad, 'utf8');
      const ok = await renderScadPng(scadPath, pngPath, { rotate: [65, 0, 25] });
      const frame = ok ? pngPath : '';

      const result = { distanceMm, pointA, pointB, method, frame, warnings: wtWarnings };
      try {
        await ctx.attachments.saveImages([{ data: await readFile(pngPath), mediaType: 'image/png', name: 'closest-points' }]);
      } catch { /* headless: frame on disk is enough */ }
      return result;
    },
  }));

  // --- check_printability: "符合逻辑"与"打得出来"是两回事 ---------------------
  //
  // microscope 系列两次交付了薄到打不出来的零件（渲染好看、装配全绿、壁却只有
  // 0.x mm），因为几何真值工具回答"是什么"，从不回答"造不造得出"。本工具用
  // 采样射线回答最便宜的两个制造问题：壁厚（沿内法线打到对面的距离）和
  // 悬垂（朝下的、比临界角更平的面的面积）。这是**采样估计**，不是完整可
  // 制造性分析——findings 给出位置，改不改由设计判断。
  registerTool(defineTool({
    name: 'check_printability',
    description:
      'Manufacturability screen for a saved version (FDM bias): sampled wall thickness (ray to the opposite wall along the inward normal), plus down-facing area steeper than the overhang angle. Returns min wall, thin-spot count, unsupported area, findings with locations, and a verdict. A SAMPLED estimate, not a full DFM analysis — run it before delivering a part; run it again after any wall/angle-changing edit.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version id to screen, e.g. "v012".' },
      wallMinMm: { type: 'number', description: 'Wall thinner than this is reported. Default 1.2 (≈2× a 0.4mm nozzle line width).' },
      overhangDeg: {
        type: 'number',
        description: 'A down-facing face tilted more than this many degrees from vertical counts as needing support. Default 45.',
      },
      samples: { type: 'number', description: 'Approximate surface samples. Default 600; raise for big meshes, lower for quick passes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          verdict: { type: 'string', required: true, description: '"ok" | "check" | "unprintable".' },
          minWallMm: { type: 'number' },
          thinSamples: { type: 'number', required: true },
          sampled: { type: 'number', required: true },
          overhangAreaMm2: { type: 'number', required: true },
          overhangZRange: { type: 'array', items: { type: 'number' } },
          findings: { type: 'array', required: true, items: { type: 'string' } },
          watertight: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 120_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as { versionId: string; wallMinMm?: number; overhangDeg?: number; samples?: number };
      const { store } = await allStores(exec);
      const wallMinMm = a.wallMinMm ?? 1.2;
      const overhangDeg = a.overhangDeg ?? 45;
      const targetSamples = Math.max(100, Math.min(a.samples ?? 600, 4000));

      const bytes = new Uint8Array(await readFile(join(store.root, 'versions', a.versionId, 'model.stl')));
      const mesh = parseBinaryStl(bytes);
      const watertight = isWatertight(mesh).watertight;
      const bvh = buildMeshBvh(mesh);

      const triCount = mesh.triVerts.length / 3;
      const step = Math.max(1, Math.floor(triCount / targetSamples));
      const v = (i: number) => new Vector3(mesh.vertProperties[i * 3]!, mesh.vertProperties[i * 3 + 1]!, mesh.vertProperties[i * 3 + 2]!);
      const bb = boundingBoxOf(mesh);
      const zFloor = bb.min[2];

      let minWall = Infinity;
      let minWallAt: [number, number, number] | null = null;
      let thinSamples = 0;
      let sampled = 0;
      let overhangArea = 0;
      let overhangZMin = Infinity;
      let overhangZMax = -Infinity;
      const overhangSin = Math.sin((overhangDeg * Math.PI) / 180);

      for (let t = 0; t < triCount; t += step) {
        const ia = mesh.triVerts[t * 3]!, ib = mesh.triVerts[t * 3 + 1]!, ic = mesh.triVerts[t * 3 + 2]!;
        const va = v(ia), vb = v(ib), vc = v(ic);
        const centroid = va.clone().add(vb).add(vc).multiplyScalar(1 / 3);
        const n = vb.clone().sub(va).cross(vc.clone().sub(va)).normalize();
        const area = vb.clone().sub(va).cross(vc.clone().sub(va)).length() / 2;
        sampled++;

        // down-facing overhang: normal points below horizontal by overhangDeg
        if (n.z < -overhangSin && centroid.z - zFloor > 0.8) {
          overhangArea += area;
          overhangZMin = Math.min(overhangZMin, centroid.z);
          overhangZMax = Math.max(overhangZMax, centroid.z);
        }

        // wall thickness: from 0.05 outside the surface, march along -n; the
        // FIRST hit is the sample triangle's own plane (DoubleSide backface at
        // ≈0.05), the SECOND is the opposite wall → wall = dist − 0.05.
        const ray = new Ray(centroid.clone().addScaledVector(n, 0.05), n.clone().negate());
        let wall: number | null = null;
        try {
          const hits = bvh.raycast(ray, DoubleSide) as { distance: number }[];
          for (const h of hits) {
            if (h.distance > 0.075) { wall = h.distance - 0.05; break; }
          }
        } catch { /* degenerate region — skip this sample */ }
        if (wall !== null && Number.isFinite(wall)) {
          if (wall < minWall) { minWall = wall; minWallAt = [centroid.x, centroid.y, centroid.z]; }
          if (wall < wallMinMm) thinSamples++;
        }
      }

      const findings: string[] = [];
      if (!watertight) {
        findings.push('mesh is NOT watertight — printability numbers below are computed on an open surface and are unreliable; fix the mesh first');
      }
      if (minWallAt && minWall < wallMinMm) {
        findings.push(
          `最薄壁 ${minWall.toFixed(2)}mm @ [${minWallAt.map((x) => x.toFixed(1)).join(',')}]（阈值 ${wallMinMm}mm；` +
          `${sampled} 个采样面中 ${thinSamples} 个低于阈值）— 薄壁打印要么断要么翘，加厚、加筋或改朝向`,
        );
      }
      if (overhangArea > 20) {
        findings.push(
          `${overhangArea.toFixed(0)}mm² 朝下悬垂面比 ${overhangDeg}° 更平（z ∈ [${overhangZMin.toFixed(0)}, ${overhangZMax.toFixed(0)}]）` +
          ' — 需要支撑、改打印朝向、或改成 45° 以内/桥接',
        );
      }

      const severe = Number.isFinite(minWall) && minWall < wallMinMm * 0.4;
      const verdict = severe ? 'unprintable' : findings.length > 0 ? 'check' : 'ok';
      return {
        versionId: a.versionId,
        verdict,
        ...(Number.isFinite(minWall) ? { minWallMm: +minWall.toFixed(3) } : {}),
        thinSamples,
        sampled,
        overhangAreaMm2: +overhangArea.toFixed(1),
        overhangZRange: Number.isFinite(overhangZMin) ? [+overhangZMin.toFixed(1), +overhangZMax.toFixed(1)] : [],
        findings,
        watertight,
      };
    },
  }));

  // --- check_connectivity: 零件必须是单一连通实体（DESGIGN §18）---------------
  //
  // 生成端已经报 `shells`（连通体数），但没有位置信息，模型无法判断"多出来的
  // 体是什么、在哪"。本工具给出每个连通体的包围盒与尺寸，并把纪律落到结果
  // 文本里：多体 = 要么 union 成一体，要么按多个零件分别建模。薄片检测
  // （check_printability）回答"打不打得出来"，本工具回答"它是不是一个零件"。
  registerTool(defineTool({
    name: 'check_connectivity',
    description:
      'Connectivity check for a saved version: counts the mutually disconnected solids (bodies) in the mesh ' +
      "and reports each body's bounding box and size. A part MUST be a single connected solid — run this " +
      'when shells > 1 is reported at generation, when a part looks like floating fragments, or before ' +
      'delivering. Multi-body means: either union the fragments into one solid, or model them as SEPARATE parts.',
    parameters: {
      versionId: { type: 'string', required: true, description: 'Saved version id to check, e.g. "v012".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versionId: { type: 'string', required: true },
          verdict: { type: 'string', required: true, description: '"single-body" | "multi-body".' },
          bodies: { type: 'number', required: true },
          bodySizes: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } }, description: 'Per body: [dx, dy, dz] mm, largest first.' },
          bodyCenters: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } }, description: 'Per body: bbox center [x, y, z] mm.' },
          watertight: { type: 'boolean', required: true },
          triangles: { type: 'number', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: unknown, exec: unknown) {
      const a = args as { versionId: string };
      const { store } = await allStores(exec);
      const bytes = new Uint8Array(await readFile(join(store.root, 'versions', a.versionId, 'model.stl'))
        .catch(() => { throw new Error(`version ${a.versionId} has no model.stl`); }));
      const mesh = parseBinaryStl(bytes);
      const { count, bodies } = connectedBodies(mesh);
      const size = (b: { min: number[]; max: number[] }) => b.max.map((n, i) => +(n - b.min[i]).toFixed(2));
      const center = (b: { min: number[]; max: number[] }) => b.min.map((n, i) => +((n + b.max[i]) / 2).toFixed(2));
      return {
        versionId: a.versionId,
        verdict: count === 1 ? 'single-body' : 'multi-body',
        bodies: count,
        bodySizes: bodies.map(size),
        bodyCenters: bodies.map(center),
        watertight: isWatertight(mesh).watertight,
        triangles: mesh.triVerts.length / 3,
      };
    },
  }));

  // Per-call usage telemetry (observer on llm/stream; never blocks anything).
  // Profile-wide on purpose: this observes every session at once, and the
  // numbers describe the request, not the project (project.ts → telemetryRoot).
  registerUsageObserver(ctx);

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
    const { runAssemblyCheck, saveAssemblyReport } = await import('./assembly-check.ts');
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
    await saveAssemblyReport(path, report);

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
      status: report.overallStatus,
      summary: `${report.summary.interfaces} 接口 · 通过 ${report.summary.pass} · ` +
        `硬冲突 ${report.summary.hardViolations} · 未声明 ${report.summary.undeclared}`,
      // The manifest IS the subject of a contract check: re-running it after a
      // design change replaces the previous verdict, while a negative control
      // (a different manifest) stays a separate, still-meaningful record.
      subject: `manifest:${relativeSubject(project, path)}`,
    });
    return { report, manifestFile: path, origin: resolved.origin };
  }

  registerTool(defineTool({
    name: 'check_assembly',
    description:
      'Validate the assembly manifest (BOM + interface contracts): distance, diameter-match and coaxial (axis-to-axis offset between datum_axis/datum_cyl endpoints) checks, motion-clearance (static distance plus the motion run you cite in params.runId), spring-preload (stiffness × deflection from the measured installed length), plus a discovery pass for undeclared near-touching pairs. Nodes accept transform.pose {datum, angleDeg} to rotate a part about its own datum axis (assembly/meshing pose) with the datums following. Interfaces with no implementable operator come back in `skipped` with what would make them checkable. mm, z-up. A relative manifestPath resolves against the session workspace first, then the plugin data root.',
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
  // (verified against the stock dsh 0.2.0 — DESGIGN §15.1), so the user's
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
        const { store, partStore, runStore, cwd } = requestStores(request);
        const { readManifest } = await import('./version.ts');
        const [vm, parts, runs] = await Promise.all([
          readManifest(store), listParts(partStore), listRuns(runStore),
        ]);
        // `project` rides the payload so a panel that switched projects can
        // discard the reply of the one it just left.
        const payload = { ...buildProducts(vm.versions, parts, runs), project: cwd };
        return new Response(JSON.stringify(payload), {
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
    const runFileRoute = (routePath: string, file: (q: URLSearchParams) => string, missing: string, contentType: string) =>
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
            return new Response(buf as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType } });
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
          ? new Response(JSON.stringify(entry), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response('no such run', { status: 404 });
      },
    });
    runFileRoute('/api/cad/run/report', () => 'report.json', 'no report for this run', 'application/json');
    runFileRoute('/api/cad/run/trajectory', () => 'trajectory.json', 'no trajectory for this run', 'application/json');
    runFileRoute('/api/cad/run/fluid-manifest', () => 'fluid-manifest.json', 'not a fluid run', 'application/json');
    runFileRoute('/api/cad/run/stl', (q) => {
      const part = safePart(q.get('part'));
      return `parts/${part ?? 'NONE'}.stl`;
    }, 'no such part in this run', 'model/stl');
    runFileRoute('/api/cad/run/image', (q) => `frames/${q.get('name') ?? 'NONE'}`, 'no such frame in this run', 'image/png');
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
          return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
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
          return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
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

    void connection.fetch.register({
      path: '/api/cad/params',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { store } = requestStores(request);
        const v = new URL(request.url).searchParams.get('v');
        if (!v) return new Response('missing v', { status: 400 });
        try {
          const scad = await readFile(join(store.root, 'versions', v, 'model.scad'), 'utf8');
          const { parseParams } = await import('./compile.ts');
          return new Response(JSON.stringify({ versionId: v, params: parseParams(scad) }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        } catch {
          return new Response('no such version', { status: 404 });
        }
      },
    });

    void connection.fetch.register({
      path: '/api/cad/preview',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const { store } = requestStores(request);
        try {
          const body = await request.json() as { versionId: string; overrides?: Record<string, number>; rotate?: number[]; zoom?: number; section?: { axis: 'x'|'y'|'z'; fraction: number } };
          const scad = await readFile(join(store.root, 'versions', body.versionId, 'model.scad'), 'utf8');
          const { parseParams, renderScadPng } = await import('./compile.ts');
          const bb = boundingBoxOf(parseBinaryStl(await readFile(join(store.root, 'versions', body.versionId, 'model.stl'))));
          // Apply overrides by substituting values into the source text (the
          // saved STL/bbox stay as-authored; only the preview geometry changes).
          let source = scad;
          for (const p of parseParams(scad)) {
            const o = body.overrides?.[p.name];
            if (o !== undefined && o !== p.value) {
              source = source.replace(new RegExp(`(\\b${p.name}\\s*=\\s*)-?\\d+(?:\\.\\d+)?\\s*;`), `$1${o};`);
            }
          }
          if (body.section) {
            const axisIdx = { x: 0, y: 1, z: 2 }[body.section.axis];
            const cut = bb.min[axisIdx]! + (bb.max[axisIdx]! - bb.min[axisIdx]!) * Math.min(1, Math.max(0, body.section.fraction));
            const BIG = Math.max(...[0,1,2].map(i => bb.max[i]! - bb.min[i]!)) * 10 + 100;
            const center = [0,1,2].map(i => i === axisIdx ? cut + BIG/2 : 0);
            source = `intersection() { ${scad}\ntranslate([${center.join(',')}]) cube([${BIG},${BIG},${BIG}], center=true); }`;
          }
          const tmp = join(store.root, 'versions', body.versionId, `preview_${Date.now()}.scad`);
          await writeFile(tmp, source);
          const pngPath = tmp.replace(/\.scad$/, '.png');
          const rotate = (body.rotate ?? [65, 0, 25]) as [number, number, number];
          const ok = await renderScadPng(tmp, pngPath, { rotate, zoom: body.zoom, imgSize: 512, target: [(bb.min[0]+bb.max[0])/2, (bb.min[1]+bb.max[1])/2, (bb.min[2]+bb.max[2])/2], modelDiagonal: Math.hypot(bb.max[0]-bb.min[0], bb.max[1]-bb.min[1], bb.max[2]-bb.min[2]) });
          if (!ok) return new Response('render failed', { status: 500 });
          const png = await readFile(pngPath);
          return new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });
        } catch (e: any) {
          return new Response(`preview failed: ${String(e?.message ?? e)}`, { status: 500 });
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
        const { store } = requestStores(request);
        const url = new URL(request.url);
        const v = url.searchParams.get('v');
        const format = (url.searchParams.get('format') ?? 'stl').toLowerCase();
        if (!v) return new Response('missing v', { status: 400 });
        if (!EXPORT_FORMATS[format]) return new Response(`unsupported format: ${format}`, { status: 400 });
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
              'content-disposition': `attachment; filename="model_${v}.${format}"`,
            },
          });
        } catch (e: any) {
          return new Response(`export failed: ${String(e?.message ?? e)}`, { status: 500 });
        }
      },
    });

    void connection.fetch.register({
      path: '/api/cad/apply-params',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const project = requestStores(request);
        const { store, partStore } = project;
        try {
          const body = await request.json() as { versionId: string; overrides: Record<string, number>; intent?: string };
          if (!body.versionId || !body.overrides) return new Response('bad request', { status: 400 });
          const scad = await readFile(join(store.root, 'versions', body.versionId, 'model.scad'), 'utf8');
          let source = scad;
          for (const [name, value] of Object.entries(body.overrides)) {
            source = source.replace(new RegExp(`(\\b${name}\\s*=\\s*)-?\\d+(?:\\.\\d+)?\\s*;`), `$1${value};`);
          }
          if (source === scad) return new Response('no overrides applied', { status: 400 });
          const c = await compileStlOnly(source);
          if (!c.success || !c.stl) return new Response(`compile failed: ${c.errors.join('; ')}`, { status: 500 });
          // A parameter tweak is a revision of whatever part the source
          // version belongs to — never a new part.
          const sourceEntry = await readVersionEntry(store, body.versionId);
          const newId = await saveVersion(store, {
            scadCode: source,
            stl: c.stl,
            userIntent: `参数调整自 ${body.versionId}: ${Object.entries(body.overrides).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            parentVersion: body.versionId,
            ...(sourceEntry?.partId ? { partId: sourceEntry.partId } : {}),
          });
          if (sourceEntry?.partId) await attachVersion(partStore, sourceEntry.partId, newId);
          return new Response(JSON.stringify({ versionId: newId }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        } catch (e: any) {
          return new Response(`apply failed: ${String(e?.message ?? e)}`, { status: 500 });
        }
      },
    });

    // M4-PREP §4.6 manual-initiation path ②: import an external file without
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

    // M4-PREP §4.6 manual-initiation path ②: run a mechanism motion job
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

    // M4-PREP §4.6 manual-initiation path ②: fluid run without the LLM
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
  registerWhenReady();
  return registered;
}
