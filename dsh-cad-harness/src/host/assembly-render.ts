// One picture of the whole assembly.
//
// WHY THIS MODULE EXISTS. Every other geometry tool puts an image in front of
// the model: `generate_part` and `import_part` return four views, the three
// simulators return keyframes, `measure_closest` returns its annotated pair.
// `validate_assembly` — the only tool that has every part of an assembly in one
// scene — returned numbers only, so the single moment where "show me the whole
// thing" is both possible and useful was the one moment with nothing to look at.
// The microscope2 run is the evidence: 148 part renders reached the model and a
// finished 16-part machine was never once seen as a whole.
//
// So this renders the assembly the way the simulators render a pose: one SCAD
// scene that imports each part's exported STL at its placement, framed from
// three fixed angles. Placement order matches every other consumer in the
// plugin (`rotate` degrees in R = Rz·Ry·Rx, then `translate` — the Manifold
// convention used by assembly.ts, assembly-check.ts and the panel's
// StaticPartsView; see client/placement.ts for why three needs order 'ZYX').
//
// mm, z-up.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderScadPng } from './compile.ts';

export interface AssemblyRenderPart {
  name: string;
  /** Absolute path to the part's exported STL. */
  stlPath: string;
  translate?: number[];
  rotate?: number[];
}

export interface AssemblyRender {
  view: string;
  png: Uint8Array;
  path: string;
}

/** The two views that answer "does it look like the thing", plus one flat one. */
const ASSEMBLY_VIEWS: { view: string; rotate: [number, number, number] }[] = [
  { view: 'iso', rotate: [65, 0, 25] },
  { view: 'front', rotate: [90, 0, 0] },
  { view: 'side', rotate: [0, 90, 0] },
];

/**
 * Distinct colours per part, matching the panel's static assembly view so the
 * picture and the viewport read the same way. OpenSCAD `color()` on an import
 * is honoured in preview rendering (the mode `renderScadPng` uses).
 */
const PALETTE: [number, number, number][] = [
  [0.29, 0.49, 0.74], [0.75, 0.22, 0.17], [0.18, 0.80, 0.44],
  [0.95, 0.61, 0.07], [0.61, 0.35, 0.71], [0.10, 0.74, 0.61],
  [0.35, 0.35, 0.40], [0.85, 0.45, 0.55], [0.45, 0.60, 0.25],
  [0.20, 0.45, 0.45], [0.70, 0.55, 0.20], [0.50, 0.25, 0.55],
];

/** Trim a number for the SCAD source: 30 not 30.0000, 12.5 not 12.5000. */
const fmt = (v: number): string => (Math.abs(v) < 1e-9 ? '0' : String(Number(v.toFixed(4))));

/** A SCAD statement that places one part, or null when it has no geometry. */
function placementLine(part: AssemblyRenderPart, index: number): string {
  const [r, g, b] = PALETTE[index % PALETTE.length]!;
  const transform: string[] = [];
  // ORDER MATTERS, and it is the opposite of how it reads. The plugin's
  // convention everywhere (assembly.ts, assembly-check.ts, the panel) is
  // `world = translate + R·local`, i.e. rotate about the origin first, then
  // place. OpenSCAD applies the RIGHTMOST transform to the child first, so the
  // translate has to be written on the LEFT and the rotate on the right:
  //   translate(t) rotate(R) import(...)   ==   p → R·p → t + R·p
  // Emitting them the other way round silently teleports any part that has both
  // — caught on the real microscope2 manifest, whose left knob is a mirrored
  // placement (`rotate([0,180,0]) translate([0,0,530])` in the manifest) and
  // rendered 795mm below the machine until this was fixed.
  if (part.translate && part.translate.some((v) => v !== 0)) {
    transform.push(`translate([${part.translate.map(fmt).join(',')}])`);
  }
  if (part.rotate && part.rotate.some((v) => v !== 0)) {
    transform.push(`rotate([${part.rotate.map(fmt).join(',')}])`);
  }
  return `color([${r},${g},${b}]) ${transform.join(' ')}${transform.length ? ' ' : ''}import("${part.stlPath}");`;
}

/**
 * Render one scene containing every part at its placement.
 *
 * Never throws on a render failure: the pictures are an addition to the numeric
 * verdict, and a missing OpenSCAD (or a headless display) must not turn a
 * successful interference check into a failed tool call. Failed views are
 * simply absent from the returned list.
 */
export async function renderAssemblyViews(
  parts: AssemblyRenderPart[],
  outDir: string,
  opts: { imgSize?: number } = {},
): Promise<AssemblyRender[]> {
  if (parts.length === 0) return [];
  await mkdir(outDir, { recursive: true });
  const stem = 'assembly';
  const scadPath = join(outDir, `${stem}.scad`);
  const lines = [
    '// Whole assembly at its declared placements — rendered by validate_assembly.',
    '// One colour per part; rotate (XYZ deg) then translate, per part.',
    ...parts.map((p, i) => placementLine(p, i)),
  ];
  await writeFile(scadPath, `${lines.join('\n')}\n`, 'utf8');

  const { readFile } = await import('node:fs/promises');
  const out: AssemblyRender[] = [];
  for (const { view, rotate } of ASSEMBLY_VIEWS) {
    const pngPath = join(outDir, `${stem}_${view}.png`);
    let ok = false;
    try {
      ok = await renderScadPng(scadPath, pngPath, { rotate, imgSize: opts.imgSize ?? 512 });
    } catch { ok = false; }
    if (!ok) continue;
    try {
      out.push({ view, png: await readFile(pngPath), path: pngPath });
    } catch { /* written then vanished — treat as a failed view */ }
  }
  return out;
}

/** Directory a run keeps its render frames in (same place the simulators use). */
export function assemblyFrameDir(runDir: string): string {
  return join(runDir, 'frames');
}
