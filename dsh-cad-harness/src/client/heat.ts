// Heatmap layer for the version preview.
//
// WHY THIS FILE EXISTS. Every check tool used to answer with aggregates ("981 mm² of
// overhang", "thinnest wall 1.00 mm"), which forces whoever reads it to go and find
// WHERE. HARNESS §11.14 makes pointing at the suspect a tool obligation; the panel is
// where a human consumes that pointer. The tool hands the panel the per-sample values
// (`attention.json`, written by check_printability) and this module turns them into
// per-vertex colours — one picture, drawn from the same object the JSON digest came
// from, so the picture cannot drift away from the numbers.
//
// The colour scale is the layer's OWN declared normalization, never a prettier one:
// a heatmap whose legend does not match the threshold that produced it is decoration.
import type { BufferGeometry } from 'three';
import { t as tr } from './i18n.ts';

export interface AttentionSample {
  /** Position in the part's own frame, mm. */
  p: number[];
  /** The measured value at that position. */
  v: number;
}

export interface AttentionLayerNormalization {
  warnAt?: number;
  badAt?: number;
  direction?: string;
  mode?: string;
  source?: string;
}

export interface AttentionPayload {
  id: string;
  versionId: string;
  normalization: Record<string, AttentionLayerNormalization>;
  samples: Record<string, AttentionSample[]>;
  /** Which run produced this field (the route fills it; older payloads omit it). */
  source?: { runId: string; kind: string; timestamp: string; title?: string };
}

export interface HeatLayer {
  id: string;
  samples: AttentionSample[];
  legend: string;
  /** 0 = safe end of the ramp, 1 = worst end. */
  score: (value: number) => number;
}

/** Pick a layer to draw, and say in words what its colours mean. */
export function pickHeatLayer(payload: AttentionPayload): HeatLayer | null {
  const wall = payload.samples?.wall ?? [];
  const overhang = payload.samples?.overhang ?? [];
  const wallNorm = payload.normalization?.wall ?? {};
  const overhangNorm = payload.normalization?.overhang ?? {};

  // The FUSED risk map first (analyze): |u| already means "how far from its own comfort
  // band", so the ramp spans 0..1 with no re-normalisation — each quantity was made
  // comparable by its own DECLARED band, not by a weight invented here.
  const fused = payload.samples?.fused ?? [];
  if (fused.length >= 8) {
    return {
      id: 'fused',
      samples: fused,
      legend: tr('ui.heat.risk', { count: fused.length }),
      score: (v) => Math.min(1, Math.max(0, v)),
    };
  }

  // Wall thickness next: a thin wall is a defect, an overhang is a process cost.
  if (wall.length >= 8) {
    const warn = wallNorm.warnAt ?? 1.2;
    const bad = wallNorm.badAt ?? warn * 0.4;
    const span = Math.max(1e-6, warn - bad);
    return {
      id: 'wall',
      samples: wall,
      legend: tr('ui.heat.wall', { bad: bad.toFixed(2), warn: warn.toFixed(2), count: wall.length }),
      score: (v) => Math.min(1, Math.max(0, (warn - v) / span)),
    };
  }
  if (overhang.length >= 8) {
    const warn = overhangNorm.warnAt ?? 20;
    return {
      id: 'overhang',
      samples: overhang,
      legend: tr('ui.heat.overhang', { warn, count: overhang.length }),
      score: (v) => Math.min(1, Math.max(0, v / warn)),
    };
  }
  // Structural stress (`simulate_stress`, DECISION-LOG 2026-10-19). The ramp is the
  // opposite of the wall layer's: for stress, LARGER is worse, so the layer's own
  // `warnAt`/`badAt` (stamped from the declared material) set the red end. An assumed
  // material is already reflected in those numbers — the picture must not look calmer
  // than the premise it was computed from.
  const stress = payload.samples?.['von-mises'] ?? [];
  if (stress.length >= 8) {
    const norm = payload.normalization?.['von-mises'] ?? {};
    const warn = norm.warnAt ?? 10;
    const bad = norm.badAt ?? warn * 1.6;
    const span = Math.max(1e-6, bad - warn);
    return {
      id: 'von-mises',
      samples: stress,
      legend: tr('ui.heat.stress', { bad, warn, count: stress.length }),
      score: (v) => Math.min(1, Math.max(0, (v - warn) / span)),
    };
  }
  return null;
}

/** blue (safe) → cyan → yellow → red (worst). */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.16, 0.38, 0.72]],
    [0.4, [0.20, 0.72, 0.72]],
    [0.7, [0.95, 0.80, 0.20]],
    [1.0, [0.85, 0.15, 0.12]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]!;
    const [t0, c0] = stops[i - 1]!;
    if (t <= t1) {
      const k = (t - t0) / Math.max(1e-6, t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return stops[stops.length - 1]![1];
}

/**
 * Per-vertex colours for a non-indexed STL geometry: every triangle takes the value of
 * its nearest sample. A grid keeps it linear in the number of samples rather than
 * samples × triangles (a 3000-triangle part against 4000 samples is 12M distances
 * otherwise — fine once, not fine on every slider move).
 */
export function buildHeatColors(
  geometry: BufferGeometry,
  layer: HeatLayer,
  cellMm = 4,
  maxDistanceMm = 8,
): { colors: Float32Array; colored: number } {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);

  const cell = (v: number) => Math.floor(v / cellMm);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  layer.samples.forEach((s, i) => {
    const k = key(cell(s.p[0]!), cell(s.p[1]!), cell(s.p[2]!));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  });

  const nearest = (x: number, y: number, z: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 3 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        for (const i of grid.get(key(cell(x) + dx, cell(y) + dy, cell(z) + dz)) ?? []) {
          const p = layer.samples[i]!.p;
          const d = (p[0]! - x) ** 2 + (p[1]! - y) ** 2 + (p[2]! - z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    // Nothing within reach = NOT MEASURED THERE. Colour it neutral and say so in the
    // legend; extending the nearest sample's value into unmeasured space would be the
    // same lie as a heatmap with an invented scale.
    return bestD <= maxDistanceMm * maxDistanceMm ? best : -1;
  };

  let colored = 0;
  for (let t = 0; t < count; t += 3) {
    const cx = (position.getX(t) + position.getX(t + 1) + position.getX(t + 2)) / 3;
    const cy = (position.getY(t) + position.getY(t + 1) + position.getY(t + 2)) / 3;
    const cz = (position.getZ(t) + position.getZ(t + 1) + position.getZ(t + 2)) / 3;
    const i = nearest(cx, cy, cz);
    const [r, g, b] = i < 0 ? [0.55, 0.58, 0.62] : ramp(layer.score(layer.samples[i]!.v));
    for (let k = 0; k < 3; k++) {
      colors[(t + k) * 3] = r;
      colors[(t + k) * 3 + 1] = g;
      colors[(t + k) * 3 + 2] = b;
    }
    if (i >= 0) colored++;
  }
  return { colors, colored };
}

/** Run kinds that can own an `attention.json`. */
export const ATTENTION_RUN_KINDS = ['printability', 'stress', 'analyze'] as const;

export interface HeatQuery {
  /** Query string for `/api/cad/attention`. */
  query: string;
  /** True when the answer must come from THIS run (id=) rather than the version's newest. */
  pinnedToRun: boolean;
}

/**
 * Which field to ask for.
 *
 * "产物即主体" (DESIGN §6.9b/§30.15): when the human has selected a RUN that owns a field,
 * the picture must be THAT run's field — not the newest one for the version. Otherwise
 * selecting the stress run and seeing the printability map is the same class of lie as the
 * old "latest run" tabs. With a version selected, the newest field wins and the legend
 * names it (2026-10-23 audit, FIX-E5).
 */
export function attentionQuery(source: {
  run?: { id: string; kind: string } | null;
  versionId: string;
}): HeatQuery {
  const { run, versionId } = source;
  if (run && (ATTENTION_RUN_KINDS as readonly string[]).includes(run.kind)) {
    return { query: `id=${encodeURIComponent(run.id)}`, pinnedToRun: true };
  }
  return { query: `v=${encodeURIComponent(versionId)}`, pinnedToRun: false };
}
