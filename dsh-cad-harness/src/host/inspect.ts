// Inspection tools (M3.5+): exact geometry measurements and on-demand
// section/perspective renders of saved versions.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asJudgement } from '../shared/judgement.ts';
import { ensurePythonWorker } from './python-worker.ts';
import { Vector3, Ray, DoubleSide } from 'three';
import { parseBinaryStl, boundingBox } from './mesh.ts';
import { renderScadPng } from './compile.ts';
import type { VersionStore } from './version.ts';

export interface MeasureReport {
  versionId: string;
  watertight: boolean;
  triangles: number;
  boundingBoxMm: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** Volume-weighted centroid, mm. */
  centerOfMassMm: [number, number, number];
  /**
   * Genus of the solid — for simple parts this equals the number of through
   * holes (a plate with N drilled holes has genus N).
   */
  genus: number;
}

/** Geometry fields the worker computes (everything but the caller's versionId). */
/** Options the printability screen takes (all optional except the version). */
export interface PrintabilityOptions {
  versionId: string;
  wallMinMm?: number;
  /** `null` = this process has no overhang limit (molding); not the same as the default. */
  overhangDeg?: number | null;
  samples?: number;
  /**
   * Thin area (percent of surface) at or below which a sub-threshold wall is
   * classified as a sharp-edge artefact instead of a thin shell. Default 1.0.
   * Set 0 to disable (every thin sample stays a blocking finding).
   */
  edgeOnlyThinPct?: number;
  /**
   * G6 (2026-10-29): the PRINT orientation as Rz·Ry·Rx degrees, applied before the
   * overhang/wall analysis. The modelling pose is not the printing pose — the roberval
   * beams print flat but were modelled upright, and the tool judged 890 mm² of
   * phantom overhang. Declared, not inferred.
   */
  printOrientationDeg?: [number, number, number];
  /**
   * Also return the per-sample values behind the field. They are what a heatmap is
   * drawn from, and they are deliberately NOT part of the report the model reads —
   * the caller writes them into a run and hands the digest to the LLM.
   */
  withSampleField?: boolean;
}

/** The values behind an attention layer: one point per sample, in the part's frame. */
export interface AttentionFieldSamples {
  id: string;
  samples: { [layerId: string]: { p: number[]; v: number }[] };
  normalization: { [layerId: string]: { [key: string]: Json } };
}

/** The screen's report — the tool's output schema, field for field. */
export interface PrintabilityReport {
  versionId: string;
  /** Canonical since 2026-10-20 (was ok/check/unprintable). */
  verdict: 'not-excluded' | 'difficult' | 'excluded';
  minWallMm?: number;
  /** Where the thinnest wall was found — the witness a human can go and look at. */
  minWallAtMm?: number[];
  /**
   * False = the ray half measured NOTHING. `ok` is then impossible: a screen that
   * could not run has not passed anything. The worker's guard exists because a
   * venv missing `rtree` made every ray throw, every throw was swallowed per ray,
   * and the tool reported a clean part with no wall finding at all.
   */
  wallMeasured: boolean;
  thinSamples: number;
  sampled: number;
  /** Area of the thin (sub-threshold) region, derived from the 1/step sample. */
  thinAreaMm2: number;
  /** …as a percentage of the whole surface — what tells a shell from a blunt edge. */
  thinAreaPct: number;
  /**
   * The measured surface area. Published because the sampling spacing (and therefore the
   * smallest wall difference this screen can resolve) is sqrt(area / sampled) — a band
   * without it would be invented (DESIGN §27.4, 2026-10-23).
   */
  surfaceAreaMm2: number;
  overhangAreaMm2: number;
  overhangZRange: number[];
  /** The print frame this screen was run in, when the caller declared one. */
  printOrientationDeg?: [number, number, number];
  /** The per-sample values behind the attention digest (withSampleField). */
  field?: AttentionFieldSamples;
  /**
   * Thin area at or below this percentage is classified as a sharp-edge sampling
   * artefact (a solid wedge), not a thin shell. A shell is SUSTAINED area; a
   * 0.2 mm reading on 0.7% of a hub face is the ray crossing a deburring edge.
   */
  edgeOnlyThinPct?: number;
  findings: string[];
  watertight: boolean;
  /** Where to look next, per quantity — empty layers when nothing was measured. */
  attention: AttentionField;
}

/**
 * A wall measurement only counts when the ray reaches the OTHER side of the
 * material: a hit on a coplanar sliver (a Manifold artefact at a crease or at an
 * exposed start-cap) has nearly the SAME normal and is not a wall. Measured on the
 * real corpus: a 0.012 mm² sliver reported a 0.17 mm "wall" that does not exist
 * (dot = −0.08), while a genuine 0.50 mm tube wall reports dot = −1.000.
 */
/** A JSON value, so the `probe`/`look` a tool hands out is storable as-is. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A place the field is extreme at — the index into the picture, and a runnable re-measure. */
export interface AttentionPeak {
  atMm: number[];
  value: number;
  normalMm?: number[];
  evidence: string;
  probe: { tool: string; args: { [key: string]: Json } };
}

/** A connected region above a tier — what a human points at and an LLM can act on. */
export interface AttentionRegion {
  tier: 'warn' | 'bad';
  areaMm2: number;
  atMm: number[];
  bboxMm: number[][];
  look: { tool: string; args: { [key: string]: Json } };
  [key: string]: Json | undefined;
}

/** One scalar quantity over the part — the layer a heatmap would draw. */
export interface AttentionLayer {
  id: string;
  quantity: string;
  units: string;
  direction: string;
  domain: { [key: string]: Json };
  normalization: { [key: string]: Json };
  stats: { [key: string]: Json };
  peaks: AttentionPeak[];
  regions: AttentionRegion[];
}

/**
 * The ATTENTION half of a screen: one field, two views. The panel draws each layer as a
 * heatmap; the LLM gets this digest (peaks + regions + runnable probes) instead of a
 * grid. Both come from the same object — a picture may never outlive the geometry it
 * describes, which is why `id` carries the version and the parameters.
 */
export interface AttentionField {
  id: string;
  layers: AttentionLayer[];
}

/**
 * Union-find over 3D points with a link radius, bucketed so it stays linear.
 * Grouping only: it decides "these samples are one place", never "this is a defect".
 */
/**
 * Fill the versionId into every runnable command the field hands out. The worker
 * measures a file and does not know which version it is; the caller does. Both the
 * production path goes through here, so the field never advertises an unrunnable command.
 */
function withVersionInAttention(attention: AttentionField, versionId: string): AttentionField {
  return {
    id: `${versionId}:${attention.id}`,
    layers: attention.layers.map((layer) => ({
      ...layer,
      peaks: layer.peaks.map((peak) => ({
        ...peak,
        probe: { ...peak.probe, args: { versionId, ...peak.probe.args } },
      })),
      regions: layer.regions.map((region) => ({
        ...region,
        look: { ...region.look, args: { versionId, ...region.look.args } },
      })),
    })),
  };
}

/** The geometry half of the worker's answer (everything but the versionId). */
type PrintabilitySolve = Omit<PrintabilityReport, 'versionId'>;

/**
 * Manufacturability screen (Q1=B: the stored STL is the contract).
 *
 * Wall thickness is a ray cast along the inward normal — a spatial-index query,
 * which the matrix's negative-return table flagged as a risk. It was measured
 * BEFORE porting: 601 rays against the 28,830-triangle real part take 0.121 s with
 * trimesh's RayMeshIntersector, against this tool's 120 s budget — so the query is
 * not a reason to keep the screen in TypeScript.
 */
export async function checkPrintability(store: VersionStore, options: PrintabilityOptions): Promise<PrintabilityReport> {
  const path = join(store.root, 'versions', options.versionId, 'model.stl');
  const worker = await ensurePythonWorker();
  const solved = await worker.request<PrintabilitySolve & { field?: AttentionFieldSamples }>('check_printability', {
    path,
    wallMinMm: options.wallMinMm ?? 1.2,
    overhangDeg: options.overhangDeg === null ? null : (options.overhangDeg ?? 45),
    samples: Math.max(100, Math.min(options.samples ?? 600, 4000)),
    ...(options.printOrientationDeg ? { printOrientationDeg: options.printOrientationDeg } : {}),
    ...(options.withSampleField ? { withSampleField: true } : {}),
  });
  const { field, ...rest } = solved;
  // The Python half measures the wall but has no notion of "a solid sharp edge vs
  // a sustained thin shell". Apply the same classification as the TS half here, at
  // the single point where both engines' words are already normalised. Without
  // this, the tool path used edgeOnlyThinPct only in the TS parity path and every
  // real call still reported 0.18 mm / 0.9% as `difficult`.
  const edgePct = Math.max(0, options.edgeOnlyThinPct ?? 1.0);
  const findings = [...(rest.findings ?? [])];
  let verdict = asJudgement(rest.verdict);
  let edgeOnly = false;
  if (edgePct > 0 && rest.thinAreaPct > 0 && rest.thinAreaPct <= edgePct &&
      (rest.thinAreaMm2 ?? 0) <= 50 && (rest.thinSamples ?? 0) <= 60 &&
      typeof rest.minWallMm === 'number' && rest.minWallMm < (options.wallMinMm ?? 1.2)) {
    edgeOnly = true;
    const idx = findings.findIndex((f) => f.includes('薄**壳**') || f.includes('thin shell'));
    const edgeFinding =
      `最薄壁 ${rest.minWallMm.toFixed(2)}mm 是**实心锐边**，不是薄壳：薄区 ${(rest.thinAreaMm2 ?? 0).toFixed(1)}mm²，` +
      `${rest.thinSamples ?? 0} 个采样面，占表面 ${rest.thinAreaPct.toFixed(2)}% ≤ ${edgePct}% — 去毛刺/倒角即可；` +
      '若要把它当否决，设 edgeOnlyThinPct:0';
    // Replace IN PLACE: the worker emits wall then overhang, and appending the
    // edge note reordered the findings against the TS parity oracle.
    if (idx >= 0) findings[idx] = edgeFinding;
    else findings.push(edgeFinding);
    if (verdict === 'difficult' && rest.watertight !== false) verdict = 'not-excluded';
  }
  // The worker measures but does not know which version it is reading; the caller
  // does. Every "go look here" command must be runnable as-is, so inject it once —
  // and the field's id carries the version, so a picture cannot outlive its geometry.
  return {
    versionId: options.versionId,
    ...rest,
    verdict,
    findings,
    ...(edgeOnly ? { edgeOnlyThinPct: edgePct } : {}),
    ...(options.printOrientationDeg ? { printOrientationDeg: options.printOrientationDeg } : {}),
    // One normalisation point: the engine's own word (ok / check / unprintable, produced by
    // the Python path too) becomes the canonical three (src/shared/judgement.ts). Doing it
    // HERE rather than in the worker keeps the engine vocabulary internal and stops the two
    // implementations from drifting — which is what the parity acceptance compares.
    attention: withVersionInAttention(rest.attention, options.versionId),
    ...(field ? { field } : {}),
  };
}

/** One place worth looking at, from the geometry scan — a location, not a verdict. */
export interface AttentionScanSuspect {
  kind: 'reentrant-corner' | 'degenerate-faces' | 'non-manifold' | 'multi-body';
  where: { atMm?: number[]; bboxMm: number[][] };
  why: string;
  severity: 'likely-defect' | 'look';
  look?: { tool: string; args: { [key: string]: Json } };
}

export interface AttentionScanReport {
  versionId: string;
  stats: { [key: string]: Json };
  suspects: AttentionScanSuspect[];
}

/**
 * Where to look, geometrically: mesh health plus reentrant corners (concave edges
 * sharper than a right angle, chained and located). The measurement is the worker's;
 * this side adds the version and fills the versionId into every runnable command.
 */
export async function scanAttention(
  store: VersionStore,
  options: { versionId: string; concaveMinDeg?: number; minChainMm?: number },
): Promise<AttentionScanReport> {
  const path = join(store.root, 'versions', options.versionId, 'model.stl');
  const worker = await ensurePythonWorker();
  const solved = await worker.request<Omit<AttentionScanReport, 'versionId'>>('scan_attention', {
    path,
    ...(options.concaveMinDeg !== undefined ? { concaveMinDeg: options.concaveMinDeg } : {}),
    ...(options.minChainMm !== undefined ? { minChainMm: options.minChainMm } : {}),
  });
  return {
    versionId: options.versionId,
    ...solved,
    suspects: (solved.suspects ?? []).map((suspect) => ({
      ...suspect,
      ...(suspect.look ? { look: { ...suspect.look, args: { versionId: options.versionId, ...suspect.look.args } } } : {}),
    })),
  };
}

interface MeasureSolve {
  watertight: boolean;
  triangles: number;
  boundingBoxMm: MeasureReport['boundingBoxMm'];
  volumeMm3: number;
  surfaceAreaMm2: number;
  centerOfMassMm: [number, number, number];
  genus: number;
}

/**
 * Whole-part ground truth (Q1=B: the stored STL is the contract).
 *
 * The worker reads the stored file BY PATH — nothing is copied — and returns every
 * measured field; this side only adds the versionId. The geometry is Manifold +
 * trimesh work, which is domain, not platform.
 */
export async function measureVersion(store: VersionStore, versionId: string): Promise<MeasureReport> {
  const path = join(store.root, 'versions', versionId, 'model.stl');
  const worker = await ensurePythonWorker();
  const solved = await worker.request<MeasureSolve>('measure_part', { path });
  return { versionId, ...solved };
}

/**
 * Round to the reported 0.001mm, and normalise -0 to 0.
 *
 * A symmetric part has a centroid coordinate that rounds to `-0`, and
 * `JSON.stringify(-0)` is `"0"` — so the tool result could not round-trip and
 * the harness rejected it as "not lossless JSON", which made `measure_part`
 * fail on *every* part. -0 and 0 are the same measurement; report the one JSON
 * can carry.
 */
function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

// z-up convention: [0,0,0] looks at the xy plane from +z = TOP view.
// The names are a literal tuple (not Object.keys) so the four views are typed
// and enumerated in one place.
const VIEW_NAMES = ['top', 'front', 'side', 'iso'] as const;
export type ViewName = typeof VIEW_NAMES[number];
const VIEW_ROTATIONS: Record<ViewName, [number, number, number]> = {
  top: [0, 0, 0], front: [90, 0, 0], side: [0, 90, 0], iso: [65, 0, 25],
};

export interface StlFrameOptions {
  view?: 'front' | 'side' | 'top' | 'iso';
  /** Custom camera rotation; overrides view preset. */
  rotate?: [number, number, number];
  /** 1 = auto-fit; 2 = twice as close; 0.5 = half as close. */
  zoom?: number;
  imgSize?: number;
  /** Cut the model: keep the part beyond `fraction` along axis (0..1 of bbox). */
  section?: { axis: 'x' | 'y' | 'z'; fraction: number };
}

export interface RenderPartRequest extends StlFrameOptions {
  versionId: string;
}

/**
 * Render one frame from an STL file.
 *
 * The mesh — not the source — is the input, which is the property that lets an
 * imported part be reviewed exactly like a generated one: the four views, the
 * section cut, the zoom and the framing all work on geometry that never had a
 * single line of SCAD. It is also why historical versions still render after
 * their source has been superseded.
 *
 * Scratch files live in a temp directory, not in the version directory: a
 * read-only view of a version must not litter it (`inspect_*.scad` used to
 * accumulate there, one pair per render).
 */
export async function renderStlFramePng(
  stlPath: string,
  opts: StlFrameOptions,
  stem = 'frame',
): Promise<{ png: Uint8Array; label: string }> {
  // Read once: an imported STL can be tens of megabytes, and the original
  // implementation re-read it for every bbox it needed.
  const stlBytes = await readFile(stlPath); // throws if missing
  const bb = boundingBox(parseBinaryStl(stlBytes));
  const dir = await mkdtemp(join(tmpdir(), 'cad-frame-'));
  try {
    const lines = [`import("${stlPath}");`];
    if (opts.section) {
      const axisIdx = { x: 0, y: 1, z: 2 }[opts.section.axis];
      // The cut plane sits at a fraction of the model's own bounding box.
      const cut = bb.min[axisIdx]! + (bb.max[axisIdx]! - bb.min[axisIdx]!) * Math.min(1, Math.max(0, opts.section.fraction));
      const BIG = Math.max(...bb.max.map((v, i) => Math.abs(v - bb.min[i]!))) * 10 + 100;
      const center = [0, 1, 2].map((i) => (i === axisIdx ? cut + BIG / 2 : 0));
      const sizes = [0, 1, 2].map(() => BIG);
      lines[0] = `intersection() { import("${stlPath}"); translate([${center.map((v) => v.toFixed(3)).join(',')}]) cube([${sizes.join(',')}], center=true); }`;
    }
    const scadPath = join(dir, `${stem}.scad`);
    await writeFile(scadPath, lines.join('\n'), 'utf8');

    const rotate = opts.rotate ?? VIEW_ROTATIONS[opts.view ?? 'iso']!;
    const diagonal = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    const pngPath = join(dir, `${stem}.png`);
    const ok = await renderScadPng(scadPath, pngPath, {
      rotate,
      zoom: opts.zoom,
      imgSize: opts.imgSize,
      target: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2],
      modelDiagonal: diagonal,
    });
    if (!ok) throw new Error(`render failed for ${stlPath}`);
    const sectionLabel = opts.section ? ` section:${opts.section.axis}@${opts.section.fraction}` : '';
    const label = `${opts.rotate ? `rot(${opts.rotate.join(',')})` : (opts.view ?? 'iso')}${opts.zoom && opts.zoom !== 1 ? ` zoom×${opts.zoom}` : ''}${sectionLabel}`;
    return { png: await readFile(pngPath), label };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The four fixed views of an STL, shaped exactly like `compileAndRender`'s
 * renders so an imported version reaches the model through the same channel as
 * a generated one (four images, same view names, same order).
 */
export async function renderStlViews(
  stlPath: string,
  opts: { imgSize?: number } = {},
): Promise<{ view: string; png: Uint8Array }[]> {
  const out: { view: string; png: Uint8Array }[] = [];
  for (const view of VIEW_NAMES) {
    const { png } = await renderStlFramePng(stlPath, { view, imgSize: opts.imgSize }, `view_${view}`);
    out.push({ view, png });
  }
  return out;
}

/** Render one frame of a saved version (thin wrapper over the STL path). */
export async function renderVersionFrame(
  store: VersionStore,
  req: RenderPartRequest,
  outName: string,
): Promise<{ png: Uint8Array; label: string }> {
  const stlPath = join(store.root, 'versions', req.versionId, 'model.stl');
  return renderStlFramePng(stlPath, req, `inspect_${outName}`);
}
