"""Voxel hex8 linear-elastic static FEM — the solver behind `simulate_stress`.

WHY THIS FILE EXISTS, AND WHAT IT MAY NOT REPORT

Three engines were checked on 2026-10-08 and none could do static stress
(`docs/archive/M4-M5-REVIEW.md §7`): Manifold has no physics, rapier is rigid (no
internal stress by definition) and MPM is a purely fluid kernel with no
deformation gradient. But `sdf.ts` / trimesh already give a regular voxel grid,
which IS the hex8 mesh — so no volume mesher and no sparse assembly are needed:
a regular stencil means matrix-free CG with one shared element stiffness matrix.

Four probes fixed the capability boundary that the TOOL must not cross
(`experiments/20261008_cantilever_voxel_fem_probe.md`,
`experiments/20261008_hole_kt_voxel_fem_probe.md`, DECISION-LOG 2026-10-19):

  * INTEGRALS (reaction, section resultant, compliance, strain energy) are the
    trustworthy half — the reaction came out at exactly 100.00 N and the internal
    moment within 1.0%;
  * "the largest element stress" DOES NOT CONVERGE: refining the hole plate made
    it grow 1.002 -> 1.184, and fill-ratio weighting did not fix it (1.184 ->
    1.169, measured in `38037ec`). It is never a result here; the debug field
    `maxVonMisesBoundaryMPa` exists only so the acceptance can keep measuring
    that divergence, and the tool face strips it;
  * a PEAK is reported at a DECLARED distance from the boundary — `interiorCells`
    cells deep, the voxel form of critical-distance sampling, which did converge
    (97.6% of Kt on the circular-hole probe);
  * a hot spot's POSITION is only trustworthy when its feature spans about 8
    cells (the key coordinate error is a constant half cell, and at d/W = 0.1 the
    reported peak jumped to the far side of the hole), so every region carries
    its depth and its extent in cells plus a `trustworthy` flag.

Lengths mm, forces N, modulus MPa (= N/mm^2) -> displacements mm, stresses MPa,
energy N·mm = mJ.
"""

from __future__ import annotations

import json

import numpy as np

# The 8 corner offsets, in the node ordering the probe validated against
# scikit-fem. Keep this order: the Gauss-point B matrix below is written to it.
NODE_OFFSETS = np.array(
    [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ],
    dtype=np.int64,
)
NODE_SIGNS = np.array(
    [
        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ],
    dtype=np.float64,
)

_GP = 1.0 / np.sqrt(3.0)
GAUSS = (-_GP, _GP)

INTERIOR_CELLS_DEFAULT = 2
# How deep the near-surface band used for the per-region depth fit reaches.
EXTRAPOLATION_CELLS = 3
FEATURE_CELLS_MIN = 8
PEAKS_MAX = 6
REGIONS_MAX = 8
REGION_AREA_MIN_MM3 = 1.0


def element_stiffness(h: float, young: float, poisson: float):
    """24x24 hex8 stiffness for a CUBE of side h — computed once, shared by every
    element. That sharing is why this lane is cheap; anything that makes boundary
    elements non-cubic (surface snapping, cut cells) breaks it and costs 5-20x in
    the CG inner loop (measured 2026-10-08)."""
    lam = young * poisson / ((1.0 + poisson) * (1.0 - 2.0 * poisson))
    mu = young / (2.0 * (1.0 + poisson))
    D = np.zeros((6, 6))
    for i in range(3):
        for j in range(3):
            D[i, j] = lam + 2.0 * mu if i == j else lam
    D[3, 3] = D[4, 4] = D[5, 5] = mu

    KE = np.zeros((24, 24))
    for gx in GAUSS:
        for gy in GAUSS:
            for gz in GAUSS:
                B = _b_matrix(gx, gy, gz, h)
                KE += B.T @ D @ B * (h / 2.0) ** 3
    return KE, D


def _b_matrix(gx: float, gy: float, gz: float, h: float) -> np.ndarray:
    B = np.zeros((6, 24))
    for i in range(8):
        sx, sy, sz = NODE_SIGNS[i]
        d_n = np.array(
            [
                sx * (1.0 + sy * gy) * (1.0 + sz * gz),
                sy * (1.0 + sx * gx) * (1.0 + sz * gz),
                sz * (1.0 + sx * gx) * (1.0 + sy * gy),
            ]
        ) / 8.0 * (2.0 / h)
        c = 3 * i
        B[0, c] = d_n[0]
        B[1, c + 1] = d_n[1]
        B[2, c + 2] = d_n[2]
        B[3, c] = d_n[1]
        B[3, c + 1] = d_n[0]
        B[4, c + 1] = d_n[2]
        B[4, c + 2] = d_n[1]
        B[5, c] = d_n[2]
        B[5, c + 2] = d_n[0]
    return B


def _von_mises(sigma: np.ndarray) -> np.ndarray:
    sx, sy, sz, txy, tyz, tzx = (sigma[:, i] for i in range(6))
    return np.sqrt(
        0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2)
        + 3.0 * (txy**2 + tyz**2 + tzx**2)
    )


def _default_dx(size: np.ndarray) -> float:
    """A grid the caller did not choose: at least 8 cells across the thinnest
    dimension (the feature rule), but never past ~3M bounding-box cells."""
    finest = float(np.min(size)) / FEATURE_CELLS_MIN
    coarse = float(np.cbrt(np.prod(size) / 3.0e6))
    return max(finest, coarse, 0.2)


def _build_grid(mesh, dx: float):
    """Solid mask on a lattice whose cells TILE the bounding box: centres at
    `lo + dx/2 + i*dx`, so N = round(size/dx) cells span the part exactly.

    `mesh.voxelized(pitch).fill()` is NOT this lattice — it samples at `lo + i*dx`,
    which puts a cell centre on each bounding-box corner and therefore models a part
    half a cell fatter on every face. Measured on the 100x10x10 cantilever: the
    second moment of area came out 1.95x too large and the tip deflection -59% off
    beam theory. The probe that validated this lane built the lattice this way
    (`buildSdfFromStl(..., originMm: [dx/2, -5 + dx/2, -5 + dx/2])`).
    """
    lo = np.asarray(mesh.bounds[0], dtype=float)
    hi = np.asarray(mesh.bounds[1], dtype=float)
    counts = np.maximum(np.round((hi - lo) / dx).astype(int), 1)
    axes = [lo[a] + dx / 2.0 + dx * np.arange(counts[a]) for a in range(3)]
    grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    inside = np.asarray(mesh.contains(grid), dtype=bool).reshape(tuple(counts))
    if not inside.any():
        raise ValueError("no voxel centre falls inside the mesh — dxMm is too coarse for this part")
    # One cell of air all round: selectors below work on world coordinates, and the
    # nodes of the outermost solid cells must still belong to real elements.
    pad = 1
    return np.pad(inside, pad, constant_values=False), lo + dx / 2.0, pad


def _solve_once(
    *,
    solid: np.ndarray,
    origin: np.ndarray,
    pad: int,
    dx: float,
    young: float,
    poisson: float,
    fixed_faces,
    fixed_points,
    loads,
    probe_at,
    resultants,
    exclude_from_report,
    critical_distance_mm: float,
    cg_tol: float,
    cg_max_iter: int,
    warn_at: float,
    bad_at: float,
):
    nx, ny, nz = solid.shape
    cells = np.argwhere(solid)
    if cells.shape[0] == 0:
        raise ValueError("voxelisation produced no solid cells")
    ne = int(cells.shape[0])

    # --- nodes -------------------------------------------------------------
    corner_idx = np.empty((ne, 8, 3), dtype=np.int64)
    for a in range(8):
        corner_idx[:, a, :] = cells + NODE_OFFSETS[a]
    uniq = np.unique(corner_idx.reshape(-1, 3), axis=0)
    nnode = int(uniq.shape[0])
    node_id = np.full((nx + 1, ny + 1, nz + 1), -1, dtype=np.int64)
    node_id[uniq[:, 0], uniq[:, 1], uniq[:, 2]] = np.arange(nnode, dtype=np.int64)
    elem_nodes = node_id[corner_idx[:, :, 0], corner_idx[:, :, 1], corner_idx[:, :, 2]]

    # Cell (i,j,k) sits at origin + (i-pad)*dx and node (i,j,k) at its corner half
    # a cell lower — the same convention the accepted voxel ops report (`centerMm`).
    node_world = origin + (uniq - pad - 0.5) * dx

    # --- supports ----------------------------------------------------------
    fixed = np.zeros(nnode, dtype=bool)
    for face in fixed_faces or []:
        axis = "xyz".index(str(face["axis"]))
        coord = node_world[:, axis]
        if str(face.get("side", "min")) == "max":
            fixed |= coord >= coord.max() - 0.75 * dx
        else:
            fixed |= coord <= coord.min() + 0.75 * dx
    for point in fixed_points or []:
        at = np.asarray(point["atMm"], dtype=float)
        radius = float(point.get("radiusMm") or 1.5 * dx)
        fixed |= np.linalg.norm(node_world - at, axis=1) <= radius
    if not fixed.any():
        raise ValueError(
            "no constrained node: an unsupported load is a rigid-body mode, so the solve "
            "would diverge instead of answering — declare a support"
        )

    # Node ids are 0..nnode-1 by construction (`uniq` is what `node_id` was filled
    # from), so the per-active-node DOF table is an arithmetic sequence. Deriving it
    # from the grid-shaped `node_id` instead would hand back -1/-2/-3 for the air
    # nodes and blow up on the first masked write.
    dof3 = np.arange(nnode, dtype=np.int64)[:, None] * 3 + np.arange(3, dtype=np.int64)[None, :]
    fixed_dof = np.zeros(nnode * 3, dtype=bool)
    for c in range(3):
        fixed_dof[dof3[fixed, c]] = True

    elem_dofs = np.empty((ne, 24), dtype=np.int64)
    for a in range(8):
        for c in range(3):
            elem_dofs[:, 3 * a + c] = dof3[elem_nodes[:, a], c]

    free_of_dof = np.full(nnode * 3, -1, dtype=np.int64)
    nfree = int((~fixed_dof).sum())
    free_of_dof[~fixed_dof] = np.arange(nfree, dtype=np.int64)
    # Fixed slots gather from a discarded extra slot, i.e. they read u = 0.
    edof = np.where(fixed_dof[elem_dofs], nfree, free_of_dof[elem_dofs]).astype(np.int64)
    sink = nfree

    # --- loads -------------------------------------------------------------
    rhs = np.zeros(nfree + 1)
    applied = np.zeros(nnode * 3)
    for load in loads or []:
        force = np.asarray(load["forceN"], dtype=float)
        if load.get("face"):
            axis = "xyz".index(str(load["face"]["axis"]))
            coord = node_world[:, axis]
            if str(load["face"].get("side", "max")) == "max":
                picked = np.where(coord >= coord.max() - 0.75 * dx)[0]
            else:
                picked = np.where(coord <= coord.min() + 0.75 * dx)[0]
        else:
            at = np.asarray(load["atMm"], dtype=float)
            radius = float(load.get("radiusMm") or 1.5 * dx)
            dist = np.linalg.norm(node_world - at, axis=1)
            picked = np.where(dist <= radius)[0]
            if picked.size == 0:
                # Snap to the nearest node rather than dropping the load silently: a
                # load that lands in air is a mistake in the caller's case, and the
                # reaction check would then disagree with it in a confusing way.
                picked = np.array([int(np.argmin(dist))])
        share = force / picked.size
        for i in picked:
            for c in range(3):
                gd = int(dof3[i, c])
                if fixed_dof[gd]:
                    continue
                applied[gd] += share[c]
                rhs[free_of_dof[gd]] += share[c]

    # --- stiffness + matrix-free CG ---------------------------------------
    KE, D = element_stiffness(dx, young, poisson)
    diag = np.zeros(nfree)
    for a in range(24):
        diag += np.bincount(edof[:, a], weights=np.full(ne, KE[a, a]), minlength=nfree + 1)[:nfree]
    diag[diag <= 0.0] = 1.0

    # `edof` maps fixed slots to the discarded sink index (nfree), so gather from a
    # buffer one longer than the solution vector — the sink holds 0, i.e. u = 0 at
    # a support. Gathering straight out of `x` would index past its end.
    padded = np.zeros(nfree + 1)

    def matvec(x: np.ndarray) -> np.ndarray:
        padded[:nfree] = x
        ue = padded[edof]
        fe = ue @ KE.T
        return np.bincount(edof.ravel(), weights=fe.ravel(), minlength=nfree + 1)[:nfree]

    u = np.zeros(nfree)
    r = rhs[:nfree].copy()
    norm0 = float(np.linalg.norm(r)) or 1.0
    z = r / diag
    p = z.copy()
    rz = float(r @ z)
    iterations = 0
    residual = 1.0
    for iterations in range(1, cg_max_iter + 1):
        Ap = matvec(p)
        pAp = float(p @ Ap)
        if not pAp > 0.0:
            break
        alpha = rz / pAp
        u += alpha * p
        r -= alpha * Ap
        residual = float(np.linalg.norm(r)) / norm0
        if residual < cg_tol:
            break
        z = r / diag
        rz_new = float(r @ z)
        p = z + (rz_new / rz) * p
        rz = rz_new

    # --- checks that do not need the answer to be right --------------------
    padded[:nfree] = u
    ue = padded[edof]
    fe = ue @ KE.T  # full 24 local internal forces, fixed rows included (u=0 there)
    internal_energy = 0.5 * float(np.sum(ue * fe))
    u_full = np.zeros(nnode * 3)
    u_full[~fixed_dof] = u
    external_work = 0.5 * float(applied @ u_full)
    energy_error_pct = 100.0 * abs(internal_energy - external_work) / (abs(external_work) or 1.0)

    internal_all = np.bincount(elem_dofs.ravel(), weights=fe.ravel(), minlength=nnode * 3)
    react = internal_all - applied
    reaction_sum = np.array([float(react[c::3][fixed].sum()) for c in range(3)])
    applied_sum = np.array([float(applied[c::3].sum()) for c in range(3)])
    equilibrium_pct = (
        float(np.linalg.norm(reaction_sum + applied_sum) / (np.linalg.norm(applied_sum) or 1.0) * 100.0)
    )

    # --- stresses at cell centres (vectorised) ----------------------------
    Bc = _b_matrix(0.0, 0.0, 0.0, dx)
    sigma = (ue @ Bc.T) @ D.T
    vm = _von_mises(sigma)

    # A support or load patch is an IDEALISATION, and the stress around it is an
    # artifact of that idealisation (the beam's knife edge really touches a pin on
    # two lines; a clamped patch is not that). Those cells are excluded from the
    # reported field, peaks, regions and percentiles, and the count is declared —
    # rather than left in to become the hottest spot in every picture.
    excluded = np.zeros(ne, dtype=bool)
    if exclude_from_report:
        centre_all = origin + (cells - pad) * dx
        for spec in exclude_from_report:
            at = np.asarray(spec["atMm"], dtype=float)
            radius = float(spec.get("radiusMm") or 2.0 * dx)
            excluded |= np.linalg.norm(centre_all - at, axis=1) <= radius
        vm = np.where(excluded, 0.0, vm)

    from scipy import ndimage

    depth = ndimage.distance_transform_edt(solid)
    cell_depth = depth[cells[:, 0], cells[:, 1], cells[:, 2]]
    # `distance_transform_edt` counts CELL STEPS to the nearest void cell, so the
    # outermost solid cell reads 1 while its centre is only half a cell from the
    # surface. Using cell_depth*dx as the physical abscissa shifts every sample by
    # +dx/2 and biases the surface extrapolation up by ~0.5dx/(t/2) (measured: the
    # cantilever came out +5.1% instead of ~0 with this bug).
    depth_mm = np.maximum(cell_depth - 0.5, 0.0) * dx
    # Peaks are read at a DECLARED distance inside the surface, never at it. One cell
    # is the smallest distance this grid can offer, and it is the reading that
    # converges — sampling deeper (the first draft used 2 cells) reads the neutral
    # axis on a coarse bending grid and reported -75%.
    # The grid cannot sample closer to the surface than one cell, so the declared
    # distance is a floor, not a promise: `effectiveDistanceMm` is what was actually
    # used, and it is reported next to the value.
    sampled = depth_mm >= critical_distance_mm
    if not sampled.any():
        # Nothing is as far in as asked: fall back to the deepest layer this grid has
        # and say so via `effectiveDistanceMm` rather than silently reporting a value
        # sampled somewhere else.
        sampled = depth_mm >= float(depth_mm.max()) - 1e-9
    effective_distance_mm = float(depth_mm[sampled].min())
    peak_idx = int(np.argmax(np.where(sampled, vm, -np.inf)))
    peak_at = origin + (cells[peak_idx] - pad) * dx
    cell_index = np.full(solid.shape, -1, dtype=np.int64)
    cell_index[cells[:, 0], cells[:, 1], cells[:, 2]] = np.arange(ne, dtype=np.int64)

    probe_displacement = None
    if probe_at is not None:
        at = np.asarray(probe_at, dtype=float)
        node = int(np.argmin(np.linalg.norm(node_world - at, axis=1)))
        probe_displacement = [float(u_full[3 * node + c]) for c in range(3)]

    # --- section resultants (the integral half) ---------------------------
    #
    # A section is a PLANE; the cells of one lattice layer are a slice of it, and a
    # section falling between two cell centres selects two layers. Each layer
    # independently integrates the whole cross-section, so the per-layer average is
    # the section value — summing both layers doubles it (measured: 9758 vs 5000 on
    # the cantilever mid-section, exactly 2x).
    voigt = {(0, 0): 0, (1, 1): 1, (2, 2): 2, (0, 1): 3, (1, 0): 3, (1, 2): 4, (2, 1): 4, (0, 2): 5, (2, 0): 5}
    # Hoisted above the loop: the region block below needs it too, and defining it
    # inside the `resultants` loop meant a run WITHOUT sections crashed there
    # (UnboundLocalError) — caught by scripts/accept-stress.mjs, which asks for no
    # sections on its coarse grid.
    centre = origin + (cells - pad) * dx
    resultants_out = []
    for spec in resultants or []:
        axis = "xyz".index(str(spec["axis"]))
        at_mm = float(spec["atMm"])
        pick = np.abs(centre[:, axis] - at_mm) <= 0.5 * dx
        if not pick.any():
            resultants_out.append(
                {"axis": "xyz"[axis], "atMm": at_mm, "refused": "no cells at that section"}
            )
            continue
        area = dx * dx
        sub_centre = centre[pick]
        sub_sigma = sigma[pick]
        layers = int(np.unique(cells[pick, axis]).size)
        centroid = sub_centre.mean(axis=0)
        traction = np.stack([sub_sigma[:, voigt[(axis, c)]] for c in range(3)], axis=1)
        # Section geometry, so a caller can close the analytic loop on a profile too
        # complex to hand-compute: I_b = integral (in-plane offset)^2 dA about the
        # centroid. `areaMm2` is the actual cut area (unlike a region's projected patch).
        lever_all = sub_centre - centroid
        second_moment = {
            "xyz"[b]: float((lever_all[:, b] ** 2).sum() * area / layers)
            for b in range(3)
            if b != axis
        }
        force = traction.sum(axis=0) * area / layers
        lever = sub_centre - centroid
        moment = np.cross(lever, traction).sum(axis=0) * area / layers
        resultants_out.append(
            {
                "axis": "xyz"[axis],
                "atMm": at_mm,
                "cells": int(pick.sum()),
                "latticeLayers": layers,
                "axialForceN": round(float(force[axis]), 4),
                "shearN": {
                    "xyz"[c]: round(float(force[c]), 4) for c in range(3) if c != axis
                },
                "momentNmm": {
                    "xyz"[c]: round(float(moment[c]), 4) for c in range(3) if c != axis
                },
                "centroidMm": [round(float(v), 3) for v in centroid],
                "areaMm2": round(float(pick.sum()) * area / layers, 4),
                "secondMomentMm4": {k: round(v, 3) for k, v in second_moment.items()},
                "note": (
                    "resultant of the traction on the section, averaged over the lattice "
                    "layers it spans; this is the integral half, and it is the quantity "
                    "the probes measured to converge (moment within 1.0%)"
                ),
            }
        )

    percentiles = {
        f"p{p}": float(np.percentile(vm, p)) for p in (50, 90, 99, 99.9)
    }

    # --- hot-spot regions above the tiers ---------------------------------
    regions = []
    for tier, threshold in (("bad", bad_at), ("warn", warn_at)):
        if threshold is None:
            continue
        above = np.zeros(solid.shape, dtype=bool)
        above[cells[:, 0], cells[:, 1], cells[:, 2]] = vm >= threshold
        if not above.any():
            continue
        labels, count = ndimage.label(above, structure=np.ones((3, 3, 3), dtype=int))
        if count == 0:
            continue
        label_per_cell = labels[cells[:, 0], cells[:, 1], cells[:, 2]]
        for lab in range(1, count + 1):
            sel = label_per_cell == lab
            if not sel.any():
                continue
            volume = float(sel.sum()) * dx**3
            # The attention contract asks a region for an AREA, and a hot zone is
            # three-dimensional. Report the patch it projects onto the surface:
            # volume / mean distance-to-surface. Documented in the layer's `domain`
            # so nobody reads it as a measured surface area.
            mean_depth_mm = float(np.mean(np.maximum(cell_depth[sel] - 0.5, 0.0) * dx))
            projected_area = volume / max(mean_depth_mm, 0.5 * dx)
            if volume < REGION_AREA_MIN_MM3:
                continue
            sub = cells[sel]
            sub_centre = centre[sel]
            bbox = [
                [float(origin[c] + (sub[:, c].min() - pad) * dx), float(origin[c] + (sub[:, c].max() - pad) * dx)]
                for c in range(3)
            ]
            extent_cells = [int(sub[:, c].max() - sub[:, c].min() + 1) for c in range(3)]
            local_peak = int(np.argmax(vm[sel]))
            # The probe's converged peak method: walk inward from the region's peak
            # cell along the depth gradient and read the fitted line at depth 0.
            local_peak = int(np.argmax(vm[sel]))
            path = _depth_path(cell_index, cells, cell_depth, vm, int(np.where(sel)[0][local_peak]))
            # Same half-cell correction as `depth_mm`: the path carries CELL STEPS.
            path_depth_mm = np.asarray([max(d - 0.5, 0.0) * dx for d, _ in path])
            path_v = np.asarray([v for _, v in path])
            extrapolated = None
            fit_r2 = None
            if path_depth_mm.size >= 3 and np.unique(path_depth_mm).size >= 2:
                slope, intercept = np.polyfit(path_depth_mm, path_v, 1)
                pred = slope * path_depth_mm + intercept
                ss_res = float(((path_v - pred) ** 2).sum())
                ss_tot = float(((path_v - path_v.mean()) ** 2).sum())
                fit_r2 = 1.0 - ss_res / ss_tot if ss_tot > 0.0 else 0.0
                extrapolated = float(intercept)
            # Feature size available to this tool: how far the path got before the
            # depth field stopped rising, doubled — i.e. the local wall it tunnels
            # through. The probe's rule was "the stress-concentration feature must
            # span >= ~8 cells"; this measures a wall, which is the closest thing a
            # voxel tool can measure without being told which feature to look at. It
            # is necessary, not sufficient: a sharp fillet inside a thick wall still
            # breaks the position rule.
            local_thickness_cells = 2 * int(round(path[-1][0]))
            trustworthy = bool(
                local_thickness_cells >= FEATURE_CELLS_MIN
                and path_depth_mm.size >= 3
                and (fit_r2 is None or fit_r2 >= 0.8)
            )
            why = None
            if not trustworthy:
                why = (
                    f"the inward path covers {local_thickness_cells} cells of wall "
                    f"(rule: >= {FEATURE_CELLS_MIN}) over {path_depth_mm.size} samples "
                    f"with R^2 {fit_r2 if fit_r2 is None else round(fit_r2, 3)} "
                    "(rule: >= 3 samples, R^2 >= 0.8). Refine dxMm before quoting a "
                    "position or a peak from this region."
                )
            regions.append(
                {
                    "tier": tier,
                    "cells": int(sel.sum()),
                    "volumeMm3": round(volume, 4),
                    "projectedAreaMm2": round(projected_area, 4),
                    "meanDepthMm": round(mean_depth_mm, 4),
                    "atMm": [round(float(v), 3) for v in sub_centre[local_peak]],
                    "bboxMm": [[round(v, 3) for v in pair] for pair in bbox],
                    "centroidMm": [round(float(v), 3) for v in sub_centre.mean(axis=0)],
                    "peakVonMisesMPa": round(float(vm[sel].max()), 3),
                    "peakDepthCells": int(cell_depth[sel][local_peak]),
                    "peakDepthMm": round(float(depth_mm[sel][local_peak]), 4),
                    "surfaceExtrapolatedMPa": None if extrapolated is None else round(extrapolated, 3),
                    "pathSamples": int(path_depth_mm.size),
                    "pathDepthMm": [round(float(v), 4) for v in path_depth_mm],
                    "pathVonMisesMPa": [round(float(v), 3) for v in path_v],
                    "fitR2": None if fit_r2 is None else round(fit_r2, 4),
                    "localThicknessCells": local_thickness_cells,
                    "minExtentCells": int(min(extent_cells)),
                    "extentCells": extent_cells,
                    "trustworthy": trustworthy,
                    "whyUntrustworthy": why,
                }
            )

    return {
        "dxMm": dx,
        "shape": [int(nx), int(ny), int(nz)],
        "solidCells": ne,
        "nodes": nnode,
        "freeDof": nfree,
        "cgIterations": int(iterations),
        "cgResidualRel": round(residual, 10),
        "criticalDistanceMm": critical_distance_mm,
        "effectiveDistanceMm": effective_distance_mm,
        "peakDeclaredDepthMPa": float(vm[peak_idx]),
        "peakDeclaredDepthAtMm": [round(float(v), 3) for v in peak_at],
        "peakDepthCells": int(cell_depth[peak_idx]),
        "maxVonMisesBoundaryMPa": float(vm.max()),
        "internalEnergyMj": internal_energy,
        "externalWorkMj": external_work,
        "energyBalancePct": energy_error_pct,
        "reactionN": [round(float(v), 4) for v in reaction_sum],
        "appliedN": [round(float(v), 4) for v in applied_sum],
        "equilibriumErrorPct": equilibrium_pct,
        "probeDisplacementMm": (
            None if probe_displacement is None else [round(v, 5) for v in probe_displacement]
        ),
        "resultants": resultants_out,
        "percentilesMPa": {k: round(v, 4) for k, v in percentiles.items()},
        "excludedCells": int(excluded.sum()),
        "regions": regions,
        "_vm": vm,
        "_cells": cells,
        "_cellDepth": cell_depth,
        "_origin": origin,
        "_pad": pad,
        "_sigma": sigma,
        "_uFull": u_full,
    }


def _depth_path(cell_index, cells, cell_depth, values, start: int, max_steps: int = 12):
    """Walk INWARD from `start` along the distance-to-surface field and return
    (depth_mm_cells, values) samples.

    This is the probe's peak method, not a whole-region regression. The probe
    regressed sigma_xx against y on the fixed-end section and extrapolated to the
    outer fibre (0.8% on the cantilever); doing the same over a whole 3D region
    mixes x positions with different stress levels at the same depth and destroys
    the fit (measured on the cantilever: R^2 0.19, surface -19%, while the same
    cells walked as a path recover the linear profile exactly). The walk always
    steps to the neighbour that raises the depth LEAST, which keeps it straight —
    i.e. perpendicular to the surface.
    """
    import numpy as np

    path = [(float(cell_depth[start]), float(values[start]))]
    pos = start
    for _ in range(max_steps):
        i, j, k = (int(v) for v in cells[pos])
        best = -1
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for dk in (-1, 0, 1):
                    if di == 0 and dj == 0 and dk == 0:
                        continue
                    cand = int(cell_index[i + di, j + dj, k + dk])
                    if cand < 0:
                        continue
                    if cell_depth[cand] <= cell_depth[pos]:
                        continue
                    if best < 0 or cell_depth[cand] < cell_depth[best]:
                        best = cand
        if best < 0:
            break
        pos = best
        path.append((float(cell_depth[pos]), float(values[pos])))
    return path


def run(params: dict) -> dict:
    """One `simulate_stress` request. See the module docstring for the boundary."""
    import trimesh

    young = float(params["youngModulusMPa"])
    poisson = float(params.get("poissonRatio") or 0.35)
    if not 0.0 < poisson < 0.5:
        raise ValueError(f"poissonRatio must be in (0, 0.5), got {poisson}")
    if young <= 0.0:
        raise ValueError("youngModulusMPa must be positive")

    mesh = trimesh.load(params["path"], process=True)
    if not bool(mesh.is_watertight):
        return {"refused": "the mesh is not watertight — a voxel FEM needs a closed solid"}

    size = np.asarray(mesh.bounds[1], dtype=float) - np.asarray(mesh.bounds[0], dtype=float)
    dx = float(params["dxMm"]) if params.get("dxMm") else _default_dx(size)
    coarsen = float(params.get("coarsenFactor") or 1.5)
    run_check = bool(params.get("runConvergence", True))
    # Declared sampling distance for peaks, in mm. `interiorCells` is kept as an
    # alias so an older caller cannot silently get the surface value instead.
    if params.get("criticalDistanceMm"):
        critical_distance_mm = float(params["criticalDistanceMm"])
    else:
        critical_distance_mm = 1.0  # mm; floored by one cell inside `_solve_once`
    cg_tol = float(params.get("cgTolerance") or 1e-8)
    # 探针 3 的估计子对比（experiments/20261019_fillet_kt_voxel_fem_probe.md）测出：
    # 线性外推在圆角上跨分辨率偏 +17%，而拟合 R² 从 0.876 升到 0.901 照样好看。
    # 所以 **R² 不是充分条件**，必须另加跨分辨率判据；否则工具会交付一个看着成立的错峰值。
    stability_pct = float(params.get("stabilityPct") or 10.0)
    cg_max_iter = int(params.get("cgMaxIterations") or 20000)

    yield_mpa = params.get("yieldMPa")
    warn_at = None
    bad_at = None
    if yield_mpa:
        warn_at = float(yield_mpa) / float(params.get("warnFactor") or 2.5)
        bad_at = float(yield_mpa) / float(params.get("badFactor") or 1.5)

    solved = []
    for pitch in (dx, dx * coarsen):
        if len(solved) == 1 and not run_check:
            break
        solid, origin, pad = _build_grid(mesh, pitch)
        solved.append(
            _solve_once(
                solid=solid,
                origin=origin,
                pad=pad,
                dx=pitch,
                young=young,
                poisson=poisson,
                fixed_faces=params.get("fixedFaces"),
                fixed_points=params.get("fixedPoints"),
                loads=params.get("loads"),
                probe_at=params.get("probeAtMm"),
                resultants=params.get("resultants"),
                exclude_from_report=params.get("excludeFromReport"),
                critical_distance_mm=critical_distance_mm,
                cg_tol=cg_tol,
                cg_max_iter=cg_max_iter,
                warn_at=warn_at,
                bad_at=bad_at,
            )
        )

    fine = solved[0]
    coarse = solved[1] if len(solved) > 1 else None

    comparison: dict = {"checked": coarse is not None, "basis": ["reaction", "strain energy", "declared-depth peak"]}
    if coarse is not None:
        def rel(a: float, b: float) -> float:
            return 100.0 * abs(a - b) / (abs(b) or 1.0)

        probe_pct = None
        if fine["probeDisplacementMm"] is not None and coarse["probeDisplacementMm"] is not None:
            probe_pct = rel(
                float(np.linalg.norm(fine["probeDisplacementMm"])),
                float(np.linalg.norm(coarse["probeDisplacementMm"])),
            )
        comparison.update(
            coarseDxMm=coarse["dxMm"],
            probeDisplacementPct=None if probe_pct is None else round(probe_pct, 4),
            declaredDepthPeakPct=round(
                rel(fine["peakDeclaredDepthMPa"], coarse["peakDeclaredDepthMPa"]), 4
            ),
            strainEnergyPct=round(rel(fine["internalEnergyMj"], coarse["internalEnergyMj"]), 4),
            reactionPct=round(
                rel(float(np.linalg.norm(fine["reactionN"])), float(np.linalg.norm(coarse["reactionN"]))),
                4,
            ),
            boundaryMaxPct=round(
                rel(fine["maxVonMisesBoundaryMPa"], coarse["maxVonMisesBoundaryMPa"]), 4
            ),
        )
        deltas = [
            v
            for v in (comparison["declaredDepthPeakPct"], comparison["strainEnergyPct"], probe_pct)
            if v is not None
        ]
        comparison["verdict"] = "stable" if max(deltas) <= 10.0 else "drifting"
        comparison["note"] = (
            "Compared at dxMm and dxMm*coarsenFactor. The ratio bounds the discretisation "
            "error; it does not prove mesh independence. `boundaryMaxPct` is the measured "
            "non-convergence of 'the largest element stress' — that is why it is not a result."
        )

    field_path = params.get("fieldPath")
    if field_path:
        # The field goes BY FILE, in the same payload shape check_printability writes:
        # `{samples: {layer: [{p, v}]}, normalization: {layer: {...}}}`. The panel then
        # has ONE reader for every attention field, and the picture is drawn from the
        # same object the digest came from.
        cells = fine["_cells"]
        vm_all = fine["_vm"]
        origin = fine["_origin"]
        pad = fine["_pad"]
        pitch = fine["dxMm"]
        # Cap the sample count so a big part cannot produce a 100 MB payload: keep the
        # hottest cells (the ones the picture is about) plus an even stride of the rest.
        cap = int(params.get("fieldSampleCap") or 60000)
        if vm_all.size > cap:
            hot = np.argsort(-vm_all)[: cap // 2]
            stride = np.arange(0, vm_all.size, max(1, vm_all.size // (cap // 2)))
            keep = np.unique(np.concatenate([hot, stride]))
        else:
            keep = np.arange(vm_all.size)
        samples = []
        for idx in keep:
            world = origin + (cells[idx] - pad) * pitch
            samples.append(
                {"p": [round(float(world[0]), 3), round(float(world[1]), 3), round(float(world[2]), 3)],
                 "v": round(float(vm_all[idx]), 4)}
            )
        payload = {
            "samples": {"von-mises": samples},
            "normalization": {
                "von-mises": {
                    "mode": "absolute",
                    "warnAt": None if warn_at is None else round(warn_at, 4),
                    "badAt": None if bad_at is None else round(bad_at, 4),
                    "direction": "larger-is-worse",
                    "source": f"declared-material strengthMPa={params.get('yieldMPa')} / warn {params.get('warnFactor') or 2.5}, bad {params.get('badFactor') or 1.5}",
                }
            },
            "meta": {
                "dxMm": pitch,
                "solidCells": int(cells.shape[0]),
                "sampled": int(keep.size),
                "criticalDistanceMm": critical_distance_mm,
                "effectiveDistanceMm": fine["effectiveDistanceMm"],
            },
        }
        with open(field_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)

    peaks = []
    taken: list[np.ndarray] = []
    for idx in np.argsort(-fine["_vm"]):
        if len(peaks) >= PEAKS_MAX:
            break
        if fine["_cellDepth"][idx] * fine["dxMm"] < fine["criticalDistanceMm"]:
            continue
        world = fine["_origin"] + (fine["_cells"][idx] - fine["_pad"]) * fine["dxMm"]
        if any(np.linalg.norm(world - t) < 3.0 * fine["dxMm"] for t in taken):
            continue
        taken.append(world)
        peaks.append(
            {
                "atMm": [round(float(v), 3) for v in world],
                "value": round(float(fine["_vm"][idx]), 3),
                "depthCells": int(fine["_cellDepth"][idx]),
                "evidence": (
                    f"von Mises {float(fine['_vm'][idx]):.2f} MPa at a cell centre "
                    f"{int(fine['_cellDepth'][idx])} cells inside the surface (peaks are "
                    "sampled at a declared depth: the boundary maximum does not converge, "
                    "DECISION-LOG 2026-10-08)"
                ),
            }
        )

    regions = sorted(fine["regions"], key=lambda r: (r["tier"] != "bad", -r["volumeMm3"]))[:REGIONS_MAX]

    # 跨分辨率稳定性门禁：按峰值位置把细网格的区域配到粗网格的区域，比"外推的表面值"。
    # 比外推值而不是"声明距离读数"，是因为声明距离被格宽兜底（dx 越粗，采样点越深），
    # 跨分辨率比它是拿两个不同物理距离读数相比——那会误杀收敛量。
    for g in regions:
        why = g.get("whyUntrustworthy")
        if coarse is None:
            g["extrapolationCrossResolutionPct"] = None
            g["trustworthy"] = False
            g["whyUntrustworthy"] = (
                "no coarser grid was solved, so the peak's stability across resolutions is "
                "UNKNOWN and the extrapolated value may not be quoted; " + (why or "")
            )
            continue
        match = None
        for c in coarse["regions"]:
            d = float(np.linalg.norm(np.asarray(g["atMm"], dtype=float) - np.asarray(c["atMm"], dtype=float)))
            if match is None or d < match[0]:
                match = (d, c)
        if (
            match
            and match[0] <= max(3.0, 2.0 * coarse["dxMm"])
            and g["surfaceExtrapolatedMPa"]
            and match[1]["surfaceExtrapolatedMPa"]
        ):
            ref = float(match[1]["surfaceExtrapolatedMPa"])
            pct = 100.0 * abs(float(g["surfaceExtrapolatedMPa"]) - ref) / max(abs(ref), 1e-9)
            g["extrapolationCoarseMPa"] = round(ref, 3)
            g["extrapolationCrossResolutionPct"] = round(pct, 3)
            if pct > stability_pct:
                g["trustworthy"] = False
                g["whyUntrustworthy"] = (
                    f"the extrapolated surface value moves {pct:.1f}% between dx {fine['dxMm']} and "
                    f"dx {coarse['dxMm']} (rule: <= {stability_pct}%) — a good R^2 is NOT enough "
                    f"(measured on a fillet: R^2 0.90 with a 17% move). " + (why or "")
                )
        else:
            g["extrapolationCrossResolutionPct"] = None
            g["trustworthy"] = False
            g["whyUntrustworthy"] = (
                "no matching region on the coarser grid, so the extrapolated value's stability "
                "cannot be checked; " + (why or "")
            )

    trustworthy = [r for r in regions if r["trustworthy"]]

    return {
        "dxMm": fine["dxMm"],
        "gridCells": fine["shape"],
        "solidCells": fine["solidCells"],
        "nodes": fine["nodes"],
        "freeDof": fine["freeDof"],
        "cgIterations": fine["cgIterations"],
        "cgResidualRel": fine["cgResidualRel"],
        "criticalDistanceMm": round(fine["criticalDistanceMm"], 4),
        "effectiveDistanceMm": round(fine["effectiveDistanceMm"], 4),
        "peakDeclaredDepthMPa": round(fine["peakDeclaredDepthMPa"], 4),
        "peakDeclaredDepthAtMm": fine["peakDeclaredDepthAtMm"],
        "peakDepthCells": fine["peakDepthCells"],
        "maxVonMisesBoundaryMPa": round(fine["maxVonMisesBoundaryMPa"], 4),
        "internalEnergyMj": fine["internalEnergyMj"],
        "externalWorkMj": fine["externalWorkMj"],
        "energyBalancePct": round(fine["energyBalancePct"], 8),
        "reactionN": fine["reactionN"],
        "appliedN": fine["appliedN"],
        "equilibriumErrorPct": round(fine["equilibriumErrorPct"], 10),
        "probeDisplacementMm": fine["probeDisplacementMm"],
        "resultants": fine["resultants"],
        "percentilesMPa": fine["percentilesMPa"],
        "excludedCells": fine["excludedCells"],
        "peaks": peaks,
        "regions": regions,
        "regionsTrustworthy": len(trustworthy),
        "meshIndependence": comparison,
        "fieldPath": field_path,
    }
