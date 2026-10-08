// STL mesh → signed distance field on the solver grid (M4 boundary link).
//
// The MPM solver needs O(1) boundary queries per cell/particle; a triangle
// mesh cannot answer them directly. This module converts a watertight STL
// into a per-cell signed distance field:
//   sdf > 0  → void/fluid (pipe cavity and outside air)
//   sdf < 0  → solid (wall material)
// plus the two arrays mpm.ts consumes directly:
//   solidMask   (per-cell 0/1)
//   solidNormal (dominant axis code 0 = none, 1..6 = -x,+x,-y,+y,-z,+z)
//
// Sign is decided by ray-parity majority over three DIVERSE, non-axis-aligned
// rays with coincident hits deduped (watertight mesh assumed — Manifold merge()
// runs first); distance comes from the three-mesh-bvh closest-point query (same
// dependency M2 uses for clearance).

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import ManifoldModule from 'manifold-3d';
import { parseBinaryStl } from './mesh.ts';

/**
 * Directions for the sign probe. Deliberately **not** axis-aligned and not
 * coplanar: axis-aligned rays travel along the grid planes, where a mesh's
 * radial seams also live, so a ray can exit exactly through a shared edge and
 * have one crossing counted twice (measured: a point 7.5mm inside a 15mm wall
 * read as fluid). See the parity note in `buildSdfFromStl`.
 */
const SIGN_RAYS = [
  new Vector3(0.5773502692, 0.5773502692, 0.5773502692),
  new Vector3(0.7071067812, -0.7071067812, 0),
  new Vector3(0.2672612419, 0.5345224838, 0.8017837257),
];

export interface SdfField {
  /** Grid resolution in cells per axis. */
  cells: [number, number, number];
  /** Millimetres per cell. */
  dxMm: number;
  /** World position (mm) of cell (0,0,0) centre. */
  originMm: [number, number, number];
  /** Signed distance in mm per cell, layout (x*ny + y)*nz + z. */
  sdf: Float32Array;
  /** 1 = solid cell (sdf <= 0). Direct input for MpmWorldConfig.solidMask. */
  solidMask: Uint8Array;
  /** Dominant-normal axis code for boundary solid cells (0 = interior/none). */
  solidNormal: Uint8Array;
  stats: {
    cells: number;
    solidCells: number;
    boundaryCells: number;
    minSdf: number;
    maxSdf: number;
    buildMs: number;
  };
}

let manifoldMod: Awaited<ReturnType<typeof ManifoldModule>> | null = null;
async function M() {
  if (!manifoldMod) {
    manifoldMod = await ManifoldModule();
    manifoldMod.setup();
  }
  return manifoldMod;
}

/**
 * Build the SDF field for a watertight-ish STL on the given grid.
 * Grid layout and normal codes match mpm.ts exactly.
 */
export async function buildSdfFromStl(
  stl: Uint8Array,
  opts: { cells: [number, number, number]; dxMm: number; originMm: [number, number, number] },
): Promise<SdfField> {
  const t0 = performance.now();
  const mod = await M();

  // weld + validate the mesh
  const parsed = parseBinaryStl(stl);
  const mesh = new mod.Mesh({ numProp: 3, vertProperties: parsed.vertProperties, triVerts: parsed.triVerts });
  mesh.merge();
  const solid = new mod.Manifold(mesh);
  if (solid.status() !== 'NoError') {
    throw new Error(`sdf: mesh not manifold (status ${solid.status()})`);
  }
  const welded = solid.getMesh();

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(welded.vertProperties, 3));
  geometry.setIndex(new BufferAttribute(welded.triVerts, 1));
  const bvh = new MeshBVH(geometry);

  const [nx, ny, nz] = opts.cells;
  const [ox, oy, oz] = opts.originMm;
  const dx = opts.dxMm;
  const nyz = ny * nz;
  const total = nx * nyz;
  const sdf = new Float32Array(total);
  const solidMask = new Uint8Array(total);

  // ray used for the sign probe; directions live in SIGN_RAYS
  const point = new Vector3();
  const ray = new Ray(new Vector3(), new Vector3(1, 0, 0));

  for (let ix = 0; ix < nx; ix++) {
    const wx = ox + ix * dx;
    for (let iy = 0; iy < ny; iy++) {
      const wy = oy + iy * dx;
      for (let iz = 0; iz < nz; iz++) {
        const wz = oz + iz * dx;
        point.set(wx, wy, wz);
        const cell = ix * nyz + iy * nz + iz;

        const dist = bvh.closestPointToPoint(point)?.distance ?? 0;

        // Sign by ray parity over three DIVERSE, non-axis-aligned directions.
        //
        // Two traps this avoids — both measured on a Ø60/Ø30 annulus (2026-10-08),
        // where the stock axis-ray vote called a point 7.5mm INSIDE a 15mm wall
        // "fluid" (sdf +6.75, solidMask 0) and a point outside the part "solid":
        //   * axis-aligned rays run along the grid planes, and a cap's radial
        //     seam lies in those very planes — a ray exiting through a shared
        //     edge hits BOTH triangles, so one crossing counts twice and the
        //     parity flips;
        //   * three axis rays leave no tie-breaker when one is degenerate.
        // Coincident hits (same distance) are therefore deduped to one crossing.
        let inside = 0;
        for (const dir of SIGN_RAYS) {
          ray.origin.copy(point);
          ray.direction.copy(dir);
          const hits = bvh.raycast(ray, DoubleSide);
          let crossings = 0;
          let last = -Infinity;
          for (const d of hits.map((h) => h.distance).sort((a, b) => a - b)) {
            if (d - last > 1e-6) {
              crossings++;
              last = d;
            }
          }
          if (crossings % 2 === 1) inside++;
        }
        const sign = inside >= 2 ? -1 : 1;
        sdf[cell] = sign * dist;
        solidMask[cell] = sign < 0 || dist === 0 ? 1 : 0;
      }
    }
  }

  // dominant-normal codes for boundary solid cells (central differences on
  // the field; out-of-grid neighbours count as fluid)
  const solidNormal = new Uint8Array(total);
  let boundaryCells = 0;
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return 1; // outside grid = fluid
    return sdf[x * nyz + y * nz + z]!;
  };
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const cell = ix * nyz + iy * nz + iz;
        if (!solidMask[cell]) continue;
        const neighbours = [
          at(ix - 1, iy, iz), at(ix + 1, iy, iz),
          at(ix, iy - 1, iz), at(ix, iy + 1, iz),
          at(ix, iy, iz - 1), at(ix, iy, iz + 1),
        ];
        if (neighbours.every((v) => v < 0)) continue; // interior solid cell
        boundaryCells++;
        const gx = (at(ix + 1, iy, iz) - at(ix - 1, iy, iz)) / (2 * dx);
        const gy = (at(ix, iy + 1, iz) - at(ix, iy - 1, iz)) / (2 * dx);
        const gz = (at(ix, iy, iz + 1) - at(ix, iy, iz - 1)) / (2 * dx);
        // gradient points from solid into fluid; only the axis matters here
        const ax = Math.abs(gx), ay = Math.abs(gy), az = Math.abs(gz);
        if (ax >= ay && ax >= az) solidNormal[cell] = gx > 0 ? 2 : 1;
        else if (ay >= az) solidNormal[cell] = gy > 0 ? 4 : 3;
        else solidNormal[cell] = gz > 0 ? 6 : 5;
      }
    }
  }

  let minSdf = Infinity, maxSdf = -Infinity, solidCells = 0;
  for (let c = 0; c < total; c++) {
    const v = sdf[c]!;
    if (v < minSdf) minSdf = v;
    if (v > maxSdf) maxSdf = v;
    if (solidMask[c]) solidCells++;
  }

  return {
    cells: opts.cells,
    dxMm: opts.dxMm,
    originMm: opts.originMm,
    sdf,
    solidMask,
    solidNormal,
    stats: { cells: total, solidCells, boundaryCells, minSdf, maxSdf, buildMs: performance.now() - t0 },
  };
}

/**
 * Nearest-cell solid lookup (1 = solid material, 0 = fluid/void).
 *
 * A 0/1 mask cannot be interpolated, so this snaps to the containing cell.
 * Callers MUST use it alongside {@link sdfAt}: the SDF stores the distance to
 * the nearest surface and is therefore POSITIVE ON BOTH SIDES of a wall, so a
 * distance threshold alone cannot tell "0.75mm of clearance inside the cavity"
 * from "6.75mm deep inside the wall".
 */
export function solidMaskAt(field: SdfField, xMm: number, yMm: number, zMm: number): 0 | 1 {
  const [nx, ny, nz] = field.cells;
  const [ox, oy, oz] = field.originMm;
  const dx = field.dxMm;
  const cx = Math.min(nx - 1, Math.max(0, Math.floor((xMm - ox) / dx)));
  const cy = Math.min(ny - 1, Math.max(0, Math.floor((yMm - oy) / dx)));
  const cz = Math.min(nz - 1, Math.max(0, Math.floor((zMm - oz) / dx)));
  return field.solidMask[cx * ny * nz + cy * nz + cz] ? 1 : 0;
}

/** Trilinear SDF sample at a world position (mm). Out-of-grid clamps to the edge. */
export function sdfAt(field: SdfField, xMm: number, yMm: number, zMm: number): number {
  const [nx, ny, nz] = field.cells;
  const [ox, oy, oz] = field.originMm;
  const dx = field.dxMm;
  const clamp = (v: number, maxI: number) => Math.min(maxI, Math.max(0, v));
  const gx = clamp((xMm - ox) / dx, nx - 1);
  const gy = clamp((yMm - oy) / dx, ny - 1);
  const gz = clamp((zMm - oz) / dx, nz - 1);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
  const fx = gx - x0, fy = gy - y0, fz = gz - z0;
  const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1), z1 = Math.min(z0 + 1, nz - 1);
  const s = field.sdf;
  const c = (X: number, Y: number, Z: number) => s[X * ny * nz + Y * nz + Z]!;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const v00 = lerp(c(x0, y0, z0), c(x1, y0, z0), fx);
  const v10 = lerp(c(x0, y1, z0), c(x1, y1, z0), fx);
  const v01 = lerp(c(x0, y0, z1), c(x1, y0, z1), fx);
  const v11 = lerp(c(x0, y1, z1), c(x1, y1, z1), fx);
  return lerp(lerp(v00, v10, fy), lerp(v01, v11, fy), fz);
}
