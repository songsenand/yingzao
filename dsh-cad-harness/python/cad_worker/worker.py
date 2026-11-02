"""Resident worker for the CAD harness Python domain runtime.

HARNESS §12.3 fixes the shape: one long-lived process, `{id, op, params}` frames
in, `{id, ok, result}` / `{id, ok: false, error, traceback}` frames out, a
`protocolVersion` handshake, and **large payloads by file path** instead of
through the pipe.

The prototype measured why (2026-10-08, `scripts/proto-python-worker.mjs`):

    1M float64 arguments      inline JSON 106.4 ms  vs  file 0.72 ms   (148×)
    100k×3 float32 result     inline JSON  98.2 ms
                              inline base64 16.3 ms
                              file           0.92 ms  (+0.16 ms host read)

So the rule is not "very large payloads go by file" but "anything past roughly a
megabyte goes by file"; base64 inline is only for small results.

Wire (JSON lines on stdout; stdout is reserved for frames, so every diagnostic
goes to stderr):

    child -> host  {"type": "hello", "protocolVersion": 1, "python": "3.13.16", "ops": [...]}
    host  -> child {"id": 1, "op": "ping", "params": {}}
    child -> host  {"id": 1, "ok": true, "result": {...}, "ms": 0.02}
    child -> host  {"id": 1, "ok": false, "error": "ValueError: ...",
                    "traceback": "Traceback ...", "ms": 1.2}

v1 ops are the ones the first migrated tools need, plus the two the acceptance
drives:

    ping            liveness + latency
    versions        versions of the pinned packages that actually import here
    stl_stats       parse a binary STL (path in) and summarise it
    closest_points  exact closest-point-on-surface; points in by file, out by file
    closest_mesh_mesh    solved closest pair between two solids (measure_closest)
    closest_mesh_sphere  solved closest pair between a solid and an analytic sphere
    connectivity    connected bodies + strict watertight test (check_connectivity)
    validate_assembly  per-part solid facts + pairwise interference/clearance
    merge_solids    union of placed solids → merged STL on disk + facts
    measure_distance   two-point distance with surface snapping (measure_distance)
    measure_thickness  every material span along one ray (measure_thickness)
    list_features   planar faces, holes and cylinders with coordinates (list_features)
    measure_section    one cross-section as polygons, rings, holes and walls
    measure_extent     axial min/max/centre and the extremal vertices, any axis
    measure_angle      angle + line distance between two named directions
    assembly_contracts the contract half of check_assembly: five operators, undeclared neighbours
    import_mesh     parse/scale/weld one STL/STEP/DXF into a storable mesh (import_part)
                    STEP via cascadio(OpenCASCADE)→GLB, DXF via ezdxf (2D profiles
                    extruded with depthMm through manifold3d, or 3D mesh entities)
    scad_prelude        the datum prelude injected into every part
    scad_parse_output   errors/warnings/datums from one OpenSCAD run
    scad_parse_params   the `// PARAMS` convention
    simulate_physics    step a rigid-body scenario and report what happened
    simulate_motion     drive a mechanism + exact interference timeline
    measure_part        whole-part ground truth (volume/area/centroid/genus)
    check_printability  wall thickness + overhang screen
    mpm_create/step/state/destroy   MLS-MPM fluid kernel (stateful, keyed by id)
                                    Two engines behind one entry (`_mpm_step_once`):
                                    numba JIT (adopted 2026-10-14, 5.1-8.7x over
                                    numpy / 1.3-2.0x over TS, DECISION-LOG same day,
                                    module `mpm_numba.py`) and the numpy kernel as
                                    oracle + platform fallback. `CAD_MPM_ENGINE`
                                    forces (forced numba + unavailable = raise).
    fluid_run           drive the fluid scenario + SDF projection + audit
    crash           raises on purpose, to prove the traceback path

This worker is deliberately SINGLE-THREADED. The acceptance measures that two
in-flight requests serialise (140 ms for 120 + 20 ms of work); that is a fact the
host must account for in its timeouts, not a bug to hide. CPU-bound geometry work
does not go faster by racing processes on one core — when real parallelism is
needed it belongs in a worker pool, decided with data.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import traceback

PROTOCOL_VERSION = 1

# Ops are imported lazily: `ping` must stay cheap, and a missing optional library
# should break one op, not the worker.
OPS = [
    "ping",
    "versions",
    "stl_stats",
    "closest_points",
    "closest_mesh_mesh",
    "closest_mesh_sphere",
    "support_map",
    "connectivity",
    "validate_assembly",
    "merge_solids",
    "measure_distance",
    "measure_thickness",
    "list_features",
    "measure_section",
    "passage_bottleneck",
    "measure_extent",
    "measure_angle",
    "assembly_contracts",
    "import_mesh",
    "scad_prelude",
    "scad_parse_output",
    "scad_parse_params",
    "simulate_physics",
    "simulate_motion",
    "measure_part",
    "check_printability",
    "scan_attention",
    "check_appearance",
    "stress_field",
    "mpm_create",
    "mpm_step",
    "mpm_state",
    "mpm_destroy",
    "fluid_run",
    "crash",
]

# The reference implementation samples at most ~20k vertices per side and projects
# each exactly onto the other solid (src/host/measure.ts). The same rule is used
# here so the two answers can be compared directly, and the parity script asserts
# they are equal.
MAX_QUERY_POINTS = 20000


def _send(frame: dict) -> None:
    sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(f"[cad_worker] {message}\n")
    sys.stderr.flush()


def op_ping(_params: dict) -> dict:
    return {"pong": True, "pid": os.getpid()}


def op_versions(_params: dict) -> dict:
    import importlib

    wanted = ["numpy", "scipy", "trimesh", "manifold3d", "numba", "networkx", "skfem", "rtree", "rapier3d", "shapely", "cascadio", "ezdxf"]
    found = {}
    for name in wanted:
        try:
            module = importlib.import_module(name)
            found[name] = getattr(module, "__version__", "unknown")
        except BaseException as exc:  # noqa: BLE001 - report, do not die
            found[name] = f"unavailable: {type(exc).__name__}"
    # xlb is reported by spec, not by import: importing pulls warp+jax (~seconds)
    # and versions must stay cheap. The engine itself reports on first lbm_channel.
    import importlib.util

    found["xlb"] = "available (spec)" if importlib.util.find_spec("xlb") else "unavailable: not installed"
    return {"python": sys.version.split()[0], "packages": found}


def op_stl_stats(params: dict) -> dict:
    import numpy as np
    import trimesh

    path = params["path"]
    mesh = trimesh.load(path, process=True)
    return {
        "path": path,
        "triangles": int(len(mesh.faces)),
        "vertices": int(len(mesh.vertices)),
        "watertight": bool(mesh.is_watertight),
        "bounds": np.asarray(mesh.bounds, dtype=float).round(4).tolist(),
    }


def op_closest_points(params: dict) -> dict:
    """Exact closest point on the surface for a batch of query points.

    Points in by file (`points.f64`, N×3 float64), distances and closest points
    out by file — never through the pipe (see the module docstring).
    """
    import numpy as np
    import trimesh

    mesh = trimesh.load(params["mesh"], process=True)
    points = np.fromfile(params["points"], dtype="<f8").reshape(-1, 3)

    engine = "none"
    for candidate in ("rtree", "embree"):
        try:
            __import__(candidate)
            engine = candidate
            break
        except BaseException:  # noqa: BLE001
            continue

    if engine == "none":
        closest, distance, _ = trimesh.proximity.closest_point_naive(mesh, points)
    else:
        closest, distance, _ = trimesh.proximity.ProximityQuery(mesh).on_surface(points)

    np.asarray(distance, dtype="<f8").tofile(params["distances"])
    np.asarray(closest, dtype="<f8").tofile(params["closest"])
    return {
        "count": int(points.shape[0]),
        "engine": engine,
        "distanceBytes": int(os.path.getsize(params["distances"])),
        "closestBytes": int(os.path.getsize(params["closest"])),
    }


def op_crash(_params: dict) -> dict:
    raise ValueError("intentional failure for traceback passthrough")


def _load(path: str):
    import trimesh

    return trimesh.load(path, process=True)


def _aabb_lower_bound(points, target):
    """Rigorous lower bound on the distance from each point to the target surface.

    The surface is inside the bounding box, so the distance to the box can never
    exceed the distance to the surface. That is what makes the pruning below
    sound rather than an approximation.
    """
    import numpy as np

    bounds = np.asarray(target.bounds, dtype=float)
    gap = np.maximum(0.0, np.maximum(bounds[0] - points, points - bounds[1]))
    return np.linalg.norm(gap, axis=1)


def _project(target, points):
    import numpy as np
    import trimesh

    closest, distance, _ = trimesh.proximity.ProximityQuery(target).on_surface(points)
    return np.asarray(closest, dtype=float), np.asarray(distance, dtype=float)


def _closest_side(vertices, target, seed_count: int = 64, chunk: int = 2048, max_points=None) -> dict:
    """Closest pair between one vertex set and a target solid (branch and bound).

    WHY NOT A PLAIN FULL SCAN (measured 2026-10-08): `trimesh`'s candidate search
    widens with the query distance, so points far from the target cost ~0.45 ms
    each. 底座 ↔ 上半机 took **15 s** against the TS reference's 141 ms purely
    because most of 上半机's vertices are ~150 mm away from 底座. Pruning by the
    bounding-box lower bound skips every point that cannot win, and a seed taken
    from the points nearest the box gives the bound something to bite on.

    The answer is the same as a full scan by construction: a point whose lower
    bound already exceeds the best exact distance found cannot be the minimum.
    When several points tie exactly, any of them is returned (the TS reference
    keeps the first in scan order; that tie-break is not reproduced).
    """
    import numpy as np

    points = np.asarray(vertices, dtype=float)
    if max_points is None:
        sampled = points
    else:
        stride = max(1, int(math.ceil(len(points) / max_points)))
        sampled = points[::stride]
    if len(sampled) == 0:
        return {"value": float("nan"), "query": (0.0, 0.0, 0.0), "hit": (0.0, 0.0, 0.0), "queries": 0}
    lower = _aabb_lower_bound(sampled, target)
    order = np.argsort(lower, kind="stable")

    state = {"value": float("inf"), "query": (0.0, 0.0, 0.0), "hit": (0.0, 0.0, 0.0), "queries": 0}

    def consider(indices) -> None:
        if len(indices) == 0:
            return
        closest, distance = _project(target, sampled[indices])
        state["queries"] += len(indices)
        index = int(np.argmin(distance))
        value = float(distance[index])
        if value < state["value"]:
            state["value"] = value
            state["query"] = tuple(float(x) for x in sampled[indices][index])
            state["hit"] = tuple(float(x) for x in closest[index])

    consider(order[:seed_count])
    cursor = seed_count
    while cursor < len(order):
        remaining = order[cursor:]
        candidates = remaining[lower[remaining] < state["value"]]
        if len(candidates) == 0:
            break
        consider(candidates[:chunk])
        cursor += chunk
    return state


def _closest_between_meshes(mesh_a, mesh_b) -> dict:
    """Solved closest pair between two solids.

    Same method as the TS reference (src/host/measure.ts): up to ~20k vertices per
    side projected exactly onto the other solid, global minimum wins; `pointA`
    always belongs to A's surface, `pointB` to B's. Ties across the two scan
    directions resolve to the A side, exactly like the reference.
    """
    side_a = _closest_side(mesh_a.vertices, mesh_b, max_points=MAX_QUERY_POINTS)
    side_b = _closest_side(mesh_b.vertices, mesh_a, max_points=MAX_QUERY_POINTS)
    if side_a["value"] <= side_b["value"]:
        point_a, point_b, value = side_a["query"], side_a["hit"], side_a["value"]
    else:
        point_a, point_b, value = side_b["hit"], side_b["query"], side_b["value"]
    return {
        "distanceMm": round(value, 4),
        "pointA": list(point_a),
        "pointB": list(point_b),
        "method": "mesh-vertex-exact",
        "queries": side_a["queries"] + side_b["queries"],
        "queriesWithoutPruning": min(len(mesh_a.vertices), MAX_QUERY_POINTS) + min(len(mesh_b.vertices), MAX_QUERY_POINTS),
    }


def op_closest_mesh_mesh(params: dict) -> dict:
    mesh_a = _load(params["meshA"])
    mesh_b = _load(params["meshB"])
    result = _closest_between_meshes(mesh_a, mesh_b)
    result["watertightA"] = bool(mesh_a.is_watertight)
    result["watertightB"] = bool(mesh_b.is_watertight)
    return result


def op_closest_mesh_sphere(params: dict) -> dict:
    """Exact distance between a solid and an analytic sphere.

    One exact projection of the sphere centre; the sphere-side point lies on the
    centre→hit direction. An intersecting sphere reports 0 and collapses both
    points onto the hit, exactly like the TS reference.
    """
    import numpy as np
    import trimesh

    mesh = _load(params["mesh"])
    center = np.asarray(params["center"], dtype=float).reshape(3)
    radius = float(params["radius"])
    closest, _distance, _ = trimesh.proximity.ProximityQuery(mesh).on_surface(center.reshape(1, 3))
    hit = np.asarray(closest[0], dtype=float)
    direction = hit - center
    center_distance = float(np.linalg.norm(direction))
    if center_distance <= radius:
        return {
            "distanceMm": 0,
            "meshPoint": [float(x) for x in hit],
            "spherePoint": [float(x) for x in hit],
            "method": "sphere-analytic",
            "intersected": True,
            "watertight": bool(mesh.is_watertight),
        }
    unit = direction / center_distance
    sphere_point = center + unit * radius
    return {
        "distanceMm": round(center_distance - radius, 4),
        "meshPoint": [float(x) for x in hit],
        "spherePoint": [float(x) for x in sphere_point],
        "method": "sphere-analytic",
        "intersected": False,
        "watertight": bool(mesh.is_watertight),
    }


def op_void_reach(params: dict) -> dict:
    """Voxel reachability: where can a ball of radius r NOT go?

    ONE engine for two rules, because they ask the same question with a different r:
      * CNC `toolRadiusMm` — r = the smallest cutter radius. A void region the cutter
        cannot enter is a slot/pocket it cannot machine.
      * `escapePassageMinMm` — r = required passage width / 2. A cavity (or the deep end
        of a pocket) the ball cannot reach is where powder or uncured resin stays.

    How it works, and the two mistakes the probe caught (both kept as comments because
    each one produced plausible-looking numbers):

      * "void with dt < r" is NOT "unreachable". The whole boundary layer of the outside
        air has dt < r. Unreachable means: connected to the far field at t=0 but NOT
        reachable by a ball of radius r. The first version reported ~2700 mm3 of phantom
        cavity on a plain box.
      * the ball sweep must use a SPHERICAL structuring element. `binary_dilation`'s
        default is a diamond (L1), which under-covers the diagonals: a 4mm slot with a
        3mm tool still reported 66 mm3 unreachable.
      * a one-voxel-thick residual shell at the solid interface is voxelisation error,
        not a pocket. Eroding the residual by one voxel removes the shell and keeps a
        real pocket, so the criterion is "a region at least ~2 voxels thick".

    THE 2-VOXEL FLOOR DOES NOT SCALE WITH THE RADIUS, and that bounds where the EXCLUSION
    half may be trusted (measured 2026-10-13). A ball sweeping a cornered — or merely
    voxelised, i.e. staircase — surface always leaves a residue whose depth grows with the
    radius, so past a radius the floor is cleared by an artifact rather than by a pocket.
    On the 20x6mm through-slot family at pitch 0.2 the boundary sits near r ≈ 1.7mm:
    slots of 3.0/4.0/6.0mm at r = half the slot width (tool exactly fits ⇒ must NOT be
    excluded) report 0mm3, 3.1mm3 (4 regions) and 31.0mm3 (4 regions) respectively, and a
    round tunnel at exactly its own radius reports ~79mm3. Those small, corner-shaped
    regions are the tool's unreachable corner, not a blocked passage — real for CNC
    (`toolRadiusMm`), noise for powder/resin evacuation (`escapePassageMinMm`). Which of
    the two a caller is asking about is a rule-layer decision this op cannot make.
    Every threshold verdict reports a MARGIN, not a flag (DECISION-LOG 2026-10-11):
    the caller gets each region's bottleneck radius, so zero/near-zero clearance can be
    recorded as difficult instead of silently passing.
    """
    import numpy as np
    import trimesh
    from scipy import ndimage

    pitch = float(params["pitchMm"])
    required = float(params["requiredRadiusMm"])
    max_voxels = int(params.get("maxVoxels") or 4_000_000)

    mesh = trimesh.load(params["path"], process=True)
    if not bool(mesh.is_watertight):
        return {"refused": "the mesh is not watertight — voxelisation needs a closed solid"}

    # The padding must leave a far-field air layer: `reachable()` identifies the region
    # connected to the GRID BOUNDARY, so with no air layer that set is empty and every
    # void voxel reads as unreachable. `ceiling` keeps that layer at least as thick as the
    # largest radius the op asks about.
    # NOTE (2026-10-13): this padding was once credited with the 1.600mm plateau that the
    # margin half used to report. That attribution was WRONG — the value did not move when
    # the padding was fixed, and the plateau is a corner artifact of the ball sweep (see
    # the refusal in the return value and `experiments/20261013_void_reach_tightest_plateau.md`).
    ceiling = max(2.0 * required, 4.0 * pitch)
    grid = mesh.voxelized(pitch=pitch).fill()
    solid = np.asarray(grid.matrix)
    # Voxel (i, j, k) sits at `origin + i*pitch` in mesh coordinates, and the padding is
    # counted in array indices — so every coordinate handed back must add `origin` again
    # (`centerMm` below). Omitting it put every reported pocket centre off by the mesh AABB
    # minimum: 2026-10-13 probe on a part whose bounds start at (-10, -10, -5) had the
    # reported centres 10-12mm away from the pockets they named.
    origin = np.asarray(grid.transform[:3, 3], dtype=float)
    pad = int(np.ceil((ceiling + 4.0 * pitch) / pitch))
    solid = np.pad(solid, pad, constant_values=False)
    dims = [int(x) for x in solid.shape]
    if dims[0] * dims[1] * dims[2] > max_voxels:
        return {
            "refused": (
                f"a {pitch}mm grid over this part needs {dims[0]}x{dims[1]}x{dims[2]} = "
                f"{dims[0]*dims[1]*dims[2]} voxels (limit {max_voxels}). Refusing rather than "
                "coarsening silently: a coarser grid would over-report widths and could pass "
                "exactly the feature this rule exists to catch."
            )
        }

    void = ~solid
    dt = ndimage.distance_transform_edt(void) * pitch

    def ball(rv: int):
        g = np.ogrid[-rv:rv + 1, -rv:rv + 1, -rv:rv + 1]
        return (g[0] ** 2 + g[1] ** 2 + g[2] ** 2) <= rv * rv

    def reachable(radius: float):
        """Void voxels a ball of `radius` can sweep, coming from the far field."""
        mask = (dt > 0.0) if radius <= 0.0 else (dt >= radius)
        lab, _ = ndimage.label(mask)
        edge = set()
        for face in (lab[0, :, :], lab[-1, :, :], lab[:, 0, :], lab[:, -1, :], lab[:, :, 0], lab[:, :, -1]):
            edge |= set(np.unique(face).tolist())
        edge.discard(0)
        return np.isin(lab, list(edge))

    outside = reachable(0.0)
    swept = ndimage.binary_dilation(reachable(required), structure=ball(int(np.ceil(required / pitch))))
    residual = outside & ~swept
    genuine = ndimage.binary_erosion(residual, structure=ball(1))

    labels, count = ndimage.label(genuine)
    regions = []
    if count > 0:
        sizes = ndimage.sum(genuine, labels, index=np.arange(1, count + 1))
        order = np.argsort(-np.asarray(sizes))
        for rank, idx in enumerate(order):
            cluster = labels == (idx + 1)
            voxels = int(sizes[idx])
            coords = np.argwhere(cluster)
            centre = coords.mean(axis=0)
            entry = {
                "centerMm": [round(float(origin[i] + (centre[i] - pad) * pitch), 3) for i in range(3)],
                "voxelCount": voxels,
                "volumeMm3": round(voxels * pitch ** 3, 3),
            }
            # The MEASURED value: the largest radius that still reaches this region.
            # Binary search, only for the biggest few regions (each step is a labelling).
            if rank < 3:
                probe = tuple(int(x) for x in coords[len(coords) // 2])
                lo, hi = 0.0, required
                for _ in range(12):
                    mid = (lo + hi) / 2
                    if reachable(mid)[probe]:
                        lo = mid
                    else:
                        hi = mid
                entry["bottleneckRadiusMm"] = round(lo, 3)
            regions.append(entry)

    # THE TIGHTEST PASSAGE IS **NOT REPORTED**, and that is deliberate (2026-10-13).
    #
    # A `tightest(lo, hi)` bisection used to live here: it returned the largest radius at
    # which the ball sweep stopped leaving a residue thicker than the 2-voxel noise floor.
    # It was meant to be the clearance of a passage that the ball still fits through (the
    # zero-clearance case the margin band is about), but it does not measure passage WIDTH:
    # for any passage whose cross-section has a CORNER — every polygon, and every staircase
    # step of a voxelised curved surface — the ball sweep ALWAYS leaves a corner residue,
    # whose depth grows with the radius. So the first radius at which that residue clears
    # the noise floor is a property of the corner, not of the passage.
    #
    # Measured 2026-10-13 on the 20x6mm through-slot family (pitch 0.2, probe:
    # experiments/scripts/probe_void_reach_tightest.py, report:
    # experiments/20261013_void_reach_tightest_plateau.md):
    #   * square slots 3.0 / 4.0 / 6.0mm ALL returned 1.600 — width-independent, and
    #     1.600 = 8 x pitch, i.e. the flip sits on the pitch grid;
    #   * the flip is driven by the removal of the dt == 1.600 voxel shell (forcing the
    #     structuring element radius does not move it);
    #   * the surviving residue is 100% inside the slot's four CORNERS;
    #   * a ROUND tunnel of the same widths tracks the true radius (1.397 / 1.887 / 2.883);
    #   * an L-inf structuring element (which cannot leave a corner residue) returns
    #     2.0 / 3.0 for the 4.0 / 6.0mm slots.
    # No choice of structuring element repairs this (a cube over-reports a round passage),
    # so a corner-free definition of the margin half is a DESIGN decision, not a fix. Until
    # it is made, `tightestPassageRadiusMm` is null and the per-region
    # `bottleneckRadiusMm` (which asks "does a ball of radius r reach THIS point" and is
    # corner-free by construction) is the number to use.
    #
    # Reporting null instead of a plausible-looking wrong number is the rule this op
    # already follows for `maxVoxels` and non-watertight meshes.

    return {
        "pitchMm": pitch,
        "requiredRadiusMm": required,
        "dims": dims,
        "resolvableMm": round(3.0 * pitch, 3),
        "tightestPassageRadiusMm": None,
        "tightestUnavailable": (
            "not reported: the residual-based bisection measured corner sharpness, not passage "
            "width (2026-10-13 — 3.0/4.0/6.0mm square slots all returned the same 1.600mm). "
            "Use each region's bottleneckRadiusMm. See "
            "experiments/20261013_void_reach_tightest_plateau.md for the evidence and the "
            "corner-free definitions still to be chosen."
        ),
        "unreachable": regions,
        "unreachableVolumeMm3": round(float(genuine.sum()) * pitch ** 3, 3),
    }


def _extent_along_axis(mesh, axis):
    """[low, high] of the vertex envelope along `axis` — same convention as `measure_extent`."""
    import numpy as np

    projections = np.asarray(mesh.vertices, dtype=float) @ np.asarray(axis, dtype=float)
    return float(np.min(projections)), float(np.max(projections))


def _surface_topology(mesh) -> dict:
    """壳数 + 每个壳的亏格 —— "有没有路"是拓扑问题，不是几何测量问题。

    闭合可定向的单壳曲面满足 `欧拉数 = 2 − 2g`，所以 `g = (2 − euler)/2` 就是这条壳上的
    **独立隧道条数**；壳数则是"含几个封闭内腔"。整数运算，**没有 pitch、没有分辨率取舍**——
    这正是体素路线栽跟头的地方。实测 9 个已知件全部分类正确
    （见 `experiments/20261013_section_mic_strategy.md`）。
    """
    shells = mesh.split(only_watertight=False)
    genus = [int(round((2.0 - float(shell.euler_number)) / 2.0)) for shell in shells]
    return {"shells": len(shells), "genusPerShell": genus, "tunnels": int(sum(genus))}


def _cut_section(mesh, normal, at_mm):
    """一张切片里的**空隙区域**（材料截面凸包 − 材料），外加"必须是内孔"的过滤。

    返回 `(void, frame, cutThePart)`：
      * `void` 是 shapely 几何（可能是 MultiPolygon）；`None` 表示这一刀没有可用截面；
      * `cutThePart` 说明这一刀到底有没有切到零件 —— 走查靠它区分"通路到了表面"（切不到）
        与"通路在零件内部断掉"（切到但空隙没了，即盲特征）。
    构造与示例台架 `examples/passage-bottleneck/tools/bottleneck_report.py` 的 `void_region`
    一致：精确切割 → `polygonize` → 面内一点判材料 → 凸包减材料。
    """
    import numpy as np
    import trimesh
    from shapely.geometry import LineString
    from shapely.ops import polygonize, unary_union

    n = np.asarray(normal, dtype=float)
    n = n / np.linalg.norm(n)
    origin = n * at_mm
    u, v = _plane_basis(n)
    segments = trimesh.intersections.mesh_plane(mesh, n, origin)
    if len(segments) == 0:
        return None, (u, v, origin), False
    flat = np.asarray(segments, dtype=float).reshape(-1, 3) - origin
    uv = np.round(np.column_stack([flat @ u, flat @ v]).reshape(-1, 2, 2), 6)
    material = []
    for candidate in polygonize(unary_union([LineString(s) for s in uv])):
        point = np.asarray(candidate.representative_point().coords, dtype=float)[0]
        world = origin + u * point[0] + v * point[1]
        if bool(mesh.contains(world.reshape(1, 3))[0]):
            material.append(candidate)
    if not material:
        return None, (u, v, origin), True
    solid_section = unary_union(material)
    hull = solid_section.convex_hull
    void = hull.difference(solid_section)
    # 「必须是内孔」：空隙截面不能碰到截面外轮廓。碰到只有两种情形——刀口切出零件之外
    # （那里的"空隙"是尖角薄片，内切圆可以任意小 ⇒ 假报窄），或刀口顺着通路走
    # （不把两端分开，它的数不支撑任何结论）。实测：不加这一条，30° 斜孔的近两端切片
    # 被读成 0.178mm（真值 4.000）。
    if void.is_empty or void.boundary.distance(hull.boundary) <= 1e-3:
        return None, (u, v, origin), True
    return void, (u, v, origin), True


def _pick_anchored(void, anchor_uv, previous_uv, jump_limit_mm):
    """从一张切片的空隙区域里挑出**锚点所在的那一条**（其余通路不参与）。

    这是"必须锚定到开口"的执行形式（DECISION-LOG 2026-10-13）：同一张平面上可能有好几条
    通路，而一张平面只能给一个可证的数（取各分量的**最大**），于是宽通路会把窄的盖住 ——
    实测 Ø6 与 Ø1 两条平行孔盲扫读 2.996，真相 0.500。

    首刀取离锚点投影最近的分量；之后取**与上一刀所选分量最近**的那个，于是沿通路"跟着走"。
    但"最近的那个"永远存在 —— 锚的那条一旦断掉，纯取最近会**安静地跳到另一条通路上**。
    实测 2026-10-13：零件上有一条 Ø3 贯通排液孔和一个 Ø1 盲孔，锚在盲孔上时，走查在盲孔底
    之后跳到了排液孔上，把死胡同报成"贯通、瓶颈 0.499"。所以这里加**跳跃上限**：
    候选必须落在上一刀截面附近（同一段通路相邻两刀的相对位移量级 = 步长×tanθ），
    超出上限就返回 `None` ⇒ 走查认定"这一端在零件内部断掉" ⇒ 不出数。
    """
    import shapely

    parts = [void] if void.geom_type == "Polygon" else list(void.geoms)
    parts = [part for part in parts if part.geom_type == "Polygon" and part.area > 0]
    if not parts:
        return None
    if previous_uv is not None:
        best = min(parts, key=lambda part: part.distance(previous_uv))
        return best if best.distance(previous_uv) <= jump_limit_mm else None
    point = shapely.Point(anchor_uv)
    best = min(parts, key=lambda part: part.distance(point))
    return best if best.distance(point) <= jump_limit_mm else None


def _mic_radius(geometry, tolerance_mm: float):
    """该截面的最大内切圆半径；切成多块时取**各块的最大值**（不是面积最大的那块）。

    最大内切圆只能落在其中一块里；按面积挑块会把"大而扁"的一块当成答案，从而**低报**
    （实测：斜孔上低报到 0.178mm）。取最大分量同时也是可证性要求的：一张平面上的结论只能是
    "没有半径 r 的球能停在**这张平面**上"。
    """
    import shapely

    parts = [geometry] if geometry.geom_type == "Polygon" else list(geometry.geoms)
    best = None
    for part in parts:
        if part.geom_type != "Polygon" or part.area <= 0:
            continue
        radius = float(shapely.length(shapely.maximum_inscribed_circle(part, tolerance_mm)))
        if best is None or radius > best:
            best = radius
    return best


def _ray_leaves_the_part(mesh, origin, direction, u, v) -> bool:
    """从空隙里的一个点沿轴射出去，是不是**直接离开零件**（一次都不碰料）。

    单条射线会栽在三角形接缝/顶点上：盲孔底的圆心正是一圈扇形三角面的**顶点**，实测从孔内
    沿轴射出得到 0 次相交（看起来像"从开口出去了"），于是一个死胡同被判成贯通。这与
    DESIGN.md §13.8b 记的三条引擎约束第 1 条是同一个坑（`$fn=64` 圆管上沿顶点线射 4 次
    却报 0 次）。所以按同样的处置：**一簇微小偏移探针取中位数**，落单的退化值被票数压掉。
    """
    import numpy as np

    counts = []
    for magnitude in (0.0, 0.01, 0.05):
        for step in range(0 if magnitude == 0.0 else 8):
            angle = (2.0 * math.pi * step) / 8.0
            offset = u * (magnitude * math.cos(angle)) + v * (magnitude * math.sin(angle))
            probe = origin + offset
            hits = mesh.ray.intersects_location(
                ray_origins=np.asarray(probe, dtype=float).reshape(1, 3),
                ray_directions=np.asarray(direction, dtype=float).reshape(1, 3))[0]
            counts.append(len(hits))
    counts.sort()
    return counts[len(counts) // 2] == 0


def op_passage_bottleneck(params: dict) -> dict:
    """一条**指名通路**的瓶颈半径 —— 截面最大内切圆沿通路取最小。

    为什么是这个形状（三条都已定案，见 DECISION-LOG 2026-10-13）：

    1. **先拓扑**：`tunnels = 0` 就没有通路，不出数；有封闭内腔转 S2-a 的负体积判据（尺寸 0）。
    2. **锚定到一个开口**：输入是**一个开口**（点 + 轴），不是"一个零件"。全零件盲扫会把
       窄通路盖住 —— 实测 Ø6 + Ø1 两条平行贯通孔，盲扫读 2.996，而最窄那条是 0.500。
       锚点就用 `list_features` 报出的孔（`centerMm` + `axisMm`）。
    3. **只在横切上出数**：`MIC(空隙 ∩ 平面) ≥ 平面上最大的 dt`，而穿过通路的球心必须穿过
       把两端分开的平面 ⇒ `MIC < r` 证明半径 r 的球过不去。切到零件但空隙截面不是"内孔"
       的刀一律不要（`_cut_section`）。

    **走查**：从锚点站位沿 ±轴各走一趟，步长 = 轴向量程 / max(8, budget/6)，记下每刀接受的
    半径；某一方向连续两刀没有可用截面就停。停下的那一刀**还切到材料** ⇒ 通路在零件内部
    断掉（盲特征）⇒ 报 `未判定`，不出数；**切不到材料** ⇒ 这一端到了表面。两侧都到表面才
    算 `throughAlongAxis`。然后在最小站位附近二分细化（预算的一半）。

    已知边界：走查步长可能跨过一段很短的颈（采样问题），所以输出必须带 `sectionsAccepted`
    与最窄处位置，让人能判断"查得够不够全"；锚点只认**平面面上的开口**，曲面上的开口
    （`list_features` 报不出）在本 op 里无法锚定，那属于后续工作。
    """
    import numpy as np

    mesh = _load(params["path"])
    if not bool(mesh.is_watertight):
        return {"refused": "the mesh is not watertight — a section needs a closed solid"}
    axis = np.asarray(_axis_vector(params.get("fromAxis") or params.get("axisMm") or "z"),
                      dtype=float)
    axis = axis / float(np.linalg.norm(axis))
    anchor = np.asarray(params.get("fromMm"), dtype=float).reshape(3)
    budget = max(16, int(params.get("budget") or 120))

    topology = _surface_topology(mesh)
    if topology["tunnels"] == 0:
        return {
            "topology": topology,
            "reachable": False,
            "refused": ("no passage exists on this solid (every shell has genus 0): the surface has "
                        "only blind dents/cavities. A fully sealed cavity is S2-a's negative-volume "
                        "verdict (passage size 0), and a blind dent is UNDETERMINED — neither is a "
                        "width this op may report."),
        }

    low, high = _extent_along_axis(mesh, axis)
    span = float(high - low)
    tolerance = max(1e-4, span * 1e-5)
    # 步长必须按**开口自身**的尺度取，不能按整个零件的量程取。实测 microscope4 v031：
    # 开口面积 11.56mm² 的非圆贯通孔，按 span/20（那件 ~10mm）走一步就**跨过了 3mm 厚的壁**，
    # 于是每个站位都落空、被误判成"死胡同"。开尺度大约束"多小的收窄还分辨得出"，
    # 所以它决定步长；span 只用来兜底（上下限）。调用方从 list_features 拿到面积就能给 fromSizeMm。
    try:
        feature_size = float(params.get("fromSizeMm") or 0.0)
    except (TypeError, ValueError):
        feature_size = 0.0
    if not (feature_size > 0):
        feature_size = span / 50.0
    # 均匀步长，尺度取**开口自身**而不是整个零件：开口尺度大约束"多细的收窄还分辨得出"，
    # 所以它决定步长，span 只用来兜底上下限。曾经试过"近处细、远处按 ×1.5 渐粗"，在真实件上
    # 失败：300mm 的件步长会涨到 15mm，而跳跃上限（2×步长）随之涨到 30mm，走查开始在相距
    # 几十毫米的特征之间乱跳。**代价是长通路可能走不完**——那就如实报"没走完"
    # （`endConditions` / `coveredMm`），由调用方决定要不要加预算，而不是靠悄悄跨步掩盖。
    step = min(max(feature_size / 6.0, span / 400.0), max(span / 20.0, 1e-6))

    # 锚点在"切片 uv"里的位置与站位无关：平面的两个基向量都垂直于轴。
    _u, _v = _plane_basis(axis)
    anchor_uv = (float(anchor @ _u), float(anchor @ _v))
    start = float(anchor @ axis)

    # 跳跃上限：同一段通路相邻两刀的相对位移量级是 步长×tanθ（θ 为斜穿角）；两条不同通路的
    # 分开距离通常是"中间隔着的材料"。取 2 倍步长，既容得下斜穿的漂移，又拦得住跳过去。
    jump_limit = max(2.0 * step, 3.0 * tolerance)

    sections = []          # [(站位, 半径, 截面几何(uv), 世界圆心)]
    cuts = 0
    ends = {}
    accepted_per_direction = {"+": 0, "-": 0}
    for direction, tag in ((1.0, "+"), (-1.0, "-")):
        # 参照点：先是锚点自身（它就在开口平面上），之后是上一刀截面的中心。用它判断
        # "这一端出去了没有"——**不能**用"这一刀还切不切到零件"：同一个高度上零件别处的料
        # 照样会让平面切到东西。实测 microscope4 v031 的 h48：锚点在 z=301.87，往 +z 走
        # 8 刀都"切到零件"（那是零件别处的料），于是这个**开口自己的面**被误判成死胡同，
        # 一条真贯通的 3.4mm 孔被报成不出数。同理，斜孔出零件后平面还会切零件的角
        # （03-tilted-bore 实测约 2mm）。所以判据是"延续点在不在实体里"，而且要往外多推几档。
        ref_world = anchor.copy()
        ref_station = start
        previous = None
        ends[tag] = "ran out of range"
        station = start + direction * step
        while cuts < budget and low - step <= station <= high + step:
            void, _frame, _cut_the_part = _cut_section(mesh, axis, station)
            cuts += 1
            picked = None
            if void is not None:
                picked = _pick_anchored(void, anchor_uv, previous, jump_limit)
            if picked is None:
                # 到头了。是"到了表面"还是"在材料内部断掉"？**从最后一个已知在空隙里的点，
                # 沿轴射一条线**：这条射线要么穿过开口出去（0 次相交），要么撞上前面的料
                # （≥1 次相交 ⇒ 死胡同）。
                #   之前用过两种更朴素的判据，都在真实件上翻过车：
                #   ① "这一刀还切不切到零件" —— 同一高度上零件别处的料会骗过它（h48）；
                #   ② "把中心往外推几档再问实体" —— 推近了会停在孔内（孔内不是实体，于是被当成
                #      空气 ⇒ 假"表面"，A′ 的盲孔就是这样变成贯通的），推远了又会越过薄壁。
                # 射线只有一个前提：起点必须在空隙里（用截面的 representative_point，而不是质心）。
                origin = ref_world + axis * (1e-3 * direction)
                # 射线方向必须跟着**这一趟走的方向**：用 +axis 会让 - 方向那一趟朝开口上方射，
                # 于是 0 次相交、死胡同被判成贯通（实测 A′ 的 Ø1 盲孔）。
                ends[tag] = ("surface"
                             if _ray_leaves_the_part(mesh, origin, axis * direction, _u, _v)
                             else "dead end inside the material")
                break
            radius = _mic_radius(picked, tolerance)
            if radius is not None:
                # representative_point 而不是质心：质心可能落在非凸截面的料里，那样后面的射线
                # 判据、以及"最窄处在哪"都会被污染。
                inside_uv = np.asarray(picked.representative_point().coords, dtype=float)[0]
                ref_world = axis * float(station) + _u * inside_uv[0] + _v * inside_uv[1]
                ref_station = float(station)
                sections.append((float(station), float(radius), picked, ref_world.copy()))
                previous = picked
                accepted_per_direction[tag] += 1
            station += direction * step
        if tag == "-" and ends["-"].startswith("dead end"):
            break

    # 只统计**这一段通路真正存在的方向**：锚点落在零件的内部台阶面上时，朝外的那一侧
    # 根本就是料（0 个截面），那不是"通路在这里断掉"。实测 microscope4 v031 的 h48：
    # 锚点在 z=301.87 的内部台阶面上，通路朝上走 5 刀后出到表面（r=1.7），朝下那侧是实心；
    # 早先把"朝下那侧没有截面"也当成死胡同，于是一条真贯通的孔被拒绝出数。
    active = [tag for tag, count in accepted_per_direction.items() if count > 0]
    dead_end = [tag for tag in active if ends[tag].startswith("dead end")]
    at_surface = [tag for tag in active if ends[tag] == "surface"]
    common = {
        "topology": topology,
        "anchorMm": [_round3(float(x)) for x in anchor],
        "axisMm": [_round3(float(x)) for x in axis],
        "endConditions": ends,
        "stepMm": _round3(step),
        "featureSizeMm": _round3(feature_size),
        "cuts": cuts,
        "sectionsAccepted": len(sections),
    }
    if not sections:
        return dict(common, reachable=False, refused=(
            "the anchor does not name a passage: no section of the void could be attributed to it. "
            "Check that `fromMm` lies on an opening of a through passage (list_features reports the "
            "openings it can name)."))
    if dead_end:
        # 走查在零件内部断掉 ⇒ 这个开口是**死胡同**（盲特征），或者通路拐出了跳跃上限。
        # 无论哪一种，都把数字扣下：不出数才是诚实的结果。
        return dict(common, reachable=False, throughAlongAxis=False, bottleneckRadiusMm=None,
                    sampledSpanMm=[_round3(min(item[0] for item in sections)),
                                   _round3(max(item[0] for item in sections))],
                    refused=(
                        "the anchored walk stopped inside the material on the "
                        f"{'/'.join(dead_end)} side: this opening is a dead end (a blind feature) or "
                        "the passage turns further than one step allows. A dead end is NOT a "
                        "bottleneck of width 0, so no width is reported. A sealed cavity is S2-a's "
                        "verdict; a blind dent stays UNDETERMINED unless a profile declares a depth "
                        "threshold."))

    # 自适应细化：在最小站位与它相邻的较小一侧之间二分（台架里 C 策略实测 0.1%）。
    while cuts < budget and len(sections) >= 2:
        sections.sort(key=lambda item: item[0])
        best = min(range(len(sections)), key=lambda index: sections[index][1])
        neighbours = [sections[index] for index in (best - 1, best + 1) if 0 <= index < len(sections)]
        if not neighbours:
            break
        neighbour = min(neighbours, key=lambda item: item[1])
        if abs(neighbour[0] - sections[best][0]) < 1e-4:
            break
        station = (sections[best][0] + neighbour[0]) / 2.0
        void, _frame, _cut = _cut_section(mesh, axis, station)
        picked = None if void is None else _pick_anchored(
            void, anchor_uv, sections[best][2], jump_limit)
        if picked is None:
            break
        radius = _mic_radius(picked, tolerance)
        cuts += 1
        if radius is None:
            break
        centre_uv = np.asarray(picked.centroid.coords, dtype=float)[0]
        sections.append((float(station), float(radius), picked,
                         axis * float(station) + _u * centre_uv[0] + _v * centre_uv[1]))

    tightest = min(sections, key=lambda item: item[1])
    intervals = sorted(item[0] for item in sections)
    return {
        "topology": topology,
        "anchorMm": [_round3(float(x)) for x in anchor],
        "axisMm": [_round3(float(x)) for x in axis],
        "reachable": True,
        # 两端都走到表面才算"这条通路被完整走完"。没走全时**仍然出数**——单个可用截面就是
        # "这里过不去"的证据（下界性质），覆盖不全只会漏报，不会假排除——但必须披露。
        # "这条通路被完整走完" = 它存在的每个方向都走到了表面。只走通一侧（另一侧没有通路）
        # 也算走完；一侧在材料内部断掉则是死胡同，上面已经拒绝。
        "throughAlongAxis": bool(active) and len(at_surface) == len(active),
        "bottleneckRadiusMm": _round3(float(tightest[1])),
        "tightestAtMm": [_round3(float(x)) for x in tightest[3]],
        "endConditions": ends,
        "coveredMm": [_round3(min(item[0] for item in sections)),
                       _round3(max(item[0] for item in sections))],
        "extentAlongAxisMm": [_round3(low), _round3(high)],
        "sectionsAccepted": len(sections),
        "cuts": cuts,
        "sampledSpanMm": [_round3(intervals[0]), _round3(intervals[-1])],
        "micToleranceMm": tolerance,
        "disclosure": (
            "this is the bottleneck of the ONE passage named by the anchor, measured as the "
            "smallest maximum-inscribed-circle over transverse sections. It is proof of "
            "'too narrow' when below a requirement, and never proof of 'wide enough to vent' — a "
            "wide spot can still be a dead end. Sampling can step over a very short neck, so "
            "`sectionsAccepted`/`sampledSpanMm` are part of the answer. Other openings of this "
            "part were NOT measured unless they are asked for in their own call, and a passage "
            "whose openings cannot be named (holes on curved surfaces, or two tunnels that cannot "
            "be paired up) stays UNDETERMINED."
        ),
    }



def op_support_map(params: dict) -> dict:
    """Does anything actually HOLD UP a print-overhang? (mass, not area)

    WHY: the area-based print-overhang screen is unactionable — it lights up a whole bowl
    underside (the toy-balance pan: 1451 mm² flagged) and says nothing about whether the
    print will hold. What matters is unsupported MASS: a 0.2 g sliver is free, a 12 g
    plate with nothing beneath it is not. So: voxelise, sweep z upward, mark a solid cell
    supported if the layer below has material within the support cone, let bridgeable
    spans through, and report the remaining unsupported regions with their mass.

    DECLARED, not measured: the support cone (45° default), the bridgeable span, and the
    density. This answers "does this need support / a redesign", never "will it fail".

    This is print-overhang/support only: structural overhang / self-weight stress is a
    strength question (simulate_stress), not this tool (2026-10-29).
    """
    path = str(params.get("path") or "")
    dx = float(params.get("dxMm") or 1.0)
    angle = float(params.get("supportAngleDeg") or 45.0)
    bridge_mm = float(params.get("bridgeMaxMm") or 10.0)
    density = float(params.get("densityGPerMm3") or 0.00124)  # PLA
    min_mass = float(params.get("minMassG") or 1.0)
    if not (0.05 <= dx <= 5.0):
        raise ValueError("dxMm must be within 0.05..5")
    import numpy as np
    import trimesh
    from scipy import ndimage

    mesh = trimesh.load(path, process=True)
    m4 = _print_frame_matrix(params.get("printOrientationDeg"))
    if m4 is not None:
        mesh = mesh.copy()
        mesh.apply_transform(m4)
    vox = mesh.voxelized(pitch=dx).fill()
    grid = np.asarray(vox.matrix, dtype=bool)
    if grid.ndim != 3 or not grid.any():
        return {"regions": [], "totals": {"unsupportedCells": 0, "bridgedCells": 0, "massG": 0.0}, "dxMm": dx}

    grid = np.moveaxis(grid, 2, 0)           # trimesh indexes (x,y,z) -> use (z,y,x)
    nz, ny, nx = grid.shape
    off = np.asarray(vox.translation, dtype=float)   # (x0,y0,z0)

    def dilate26(m):
        """8-neighbourhood in the layer below, WITHOUT wrap-around (np.roll wraps, which
        invents support across the array edge — it made a 30 mm flange 'bridged')."""
        out = m.copy()
        pad = np.zeros((m.shape[0] + 2, m.shape[1] + 2), dtype=bool)
        pad[1:-1, 1:-1] = m
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                out |= pad[1 + dy:1 + dy + m.shape[0], 1 + dx:1 + dx + m.shape[1]]
        return out

    # REACHABILITY from the bed through a 45-degree support path. Everything solid that
    # cannot be reached this way is material hanging in the air — that is the mass that
    # needs support (for the toy-balance T-shape: the whole 30x30x10 flange, ~11 g, not
    # just its bottom skin, which a per-layer test would have measured as 0.9 g).
    reach = np.zeros_like(grid)
    reach[0] = grid[0]
    for k in range(1, nz):
        reach[k] = grid[k] & dilate26(reach[k - 1])
    unreachable = grid & ~reach

    # BRIDGING: a short horizontal gap whose two ends are already reachable can be printed
    # without support (declared span). Only the COLUMNS hanging off that gap are excused —
    # a bridge does not excuse a big plate that merely touches one.
    max_run = max(1, int(round(bridge_mm / dx)))
    gap_ok = np.zeros_like(unreachable)
    for axis in (2, 1):
        moved = np.moveaxis(unreachable, axis, 0).copy()
        rea = np.moveaxis(reach, axis, 0)
        brv = np.zeros_like(moved)
        n = moved.shape[0]
        for j in range(moved.shape[1]):
            for k in range(moved.shape[2]):
                row = moved[:, j, k]
                ok = rea[:, j, k]
                i = 0
                while i < n:
                    if not row[i]:
                        i += 1
                        continue
                    a0 = i
                    while i < n and row[i]:
                        i += 1
                    a1 = i - 1
                    if a0 > 0 and a1 + 1 < n and ok[a0 - 1] and ok[a1 + 1] and (a1 - a0 + 1) <= max_run:
                        brv[a0:a1 + 1, j, k] = True
        gap_ok |= np.moveaxis(brv, 0, axis)

    # A column is excused only if its LOWEST unreachable cell sits in a bridgeable gap.
    column_bridged = np.zeros((ny, nx), dtype=bool)
    first = np.full((ny, nx), nz, dtype=int)
    for k in range(nz):
        m = unreachable[k] & (first == nz)
        first[m] = k
    for k in range(nz):
        sel = (first == k) & gap_ok[k]
        column_bridged |= sel
    bridged = unreachable & column_bridged[None, :, :]
    unsupported = unreachable
    need = unsupported & ~bridged
    # Connected regions (26-connectivity) over the cells that still need support.
    labels, count = ndimage.label(need, structure=np.ones((3, 3, 3), dtype=bool))
    off = np.asarray(vox.translation, dtype=float)
    regions = []
    total_mass = 0.0
    for idx in range(1, count + 1):
        cells = np.argwhere(labels == idx)
        if cells.size == 0:
            continue
        vol = cells.shape[0] * dx ** 3
        mass = vol * density
        total_mass += mass
        zyx_lo = cells.min(axis=0)[::-1]
        zyx_hi = (cells.max(axis=0) + 1)[::-1]
        zyx_ctr = (cells.mean(axis=0) + 0.5)[::-1]
        lo = off + zyx_lo * dx
        hi = off + zyx_hi * dx
        ctr = off + zyx_ctr * dx
        span = float(max(hi[0] - lo[0], hi[1] - lo[1]))  # horizontal extent
        if mass < min_mass:
            continue
        regions.append({
            "atMm": [round(float(ctr[0]), 2), round(float(ctr[1]), 2), round(float(ctr[2]), 2)],
            "bboxMm": [[round(float(lo[0]), 2), round(float(lo[1]), 2), round(float(lo[2]), 2)],
                       [round(float(hi[0]), 2), round(float(hi[1]), 2), round(float(hi[2]), 2)]],
            "massG": round(float(mass), 3),
            "volumeMm3": round(float(vol), 1),
            "spanMm": round(span, 2),
            "cells": int(cells.shape[0]),
        })
    regions.sort(key=lambda r: -r["massG"])
    return {
        "dxMm": dx,
        "supportAngleDeg": angle,
        "bridgeMaxMm": bridge_mm,
        "minMassG": min_mass,
        "densityGPerMm3": density,
        "regions": regions,
        "totals": {
            "unsupportedCells": int(unsupported.sum()),
            "bridgedCells": int((unsupported & bridged).sum()),
            "neededCells": int(need.sum()),
            "massG": round(float(total_mass), 3),
            "regionsAboveThreshold": len(regions),
        },
        "note": "支撑需求估计（质量口径），不是会不会塌：阈值与锥角均为声明值。",
    }

def op_connectivity(params: dict) -> dict:
    """Connected bodies + strict watertight test for one saved version.

    Two details are reproduced deliberately, because "26 bodies" is only half the
    answer and the ORDER of the bodies is part of the tool's output:

    * connectivity is by SHARED EDGE (two triangles that meet only at a vertex are
      separate bodies), which is what `face_adjacency` gives;
    * bodies are ordered by their XY bounding-box area, descending, ties broken by
      the first triangle each body was seen at — the same order the TS
      union-find produced, so `bodySizes`/`bodyCenters` stay comparable between
      runs of the two implementations.
    """
    import numpy as np
    import trimesh

    mesh = trimesh.load(params["path"], process=True)
    faces = np.asarray(mesh.faces)
    if len(faces) == 0:
        return {"bodies": [], "count": 0, "watertight": False, "triangles": 0}

    vertices = np.asarray(mesh.vertices, dtype=float)
    adjacency = trimesh.graph.face_adjacency(faces)
    components = trimesh.graph.connected_components(adjacency, nodes=np.arange(len(faces)))

    bodies = []
    for component in components:
        indices = np.asarray(component, dtype=np.int64)
        used = np.unique(faces[indices].reshape(-1))
        points = vertices[used]
        low = points.min(axis=0)
        high = points.max(axis=0)
        bodies.append(
            {
                "min": [round(float(x), 3) for x in low],
                "max": [round(float(x), 3) for x in high],
                "firstFace": int(indices.min()),
            }
        )
    bodies.sort(key=lambda body: (-(body["max"][0] - body["min"][0]) * (body["max"][1] - body["min"][1]), body["firstFace"]))
    for body in bodies:
        body.pop("firstFace", None)

    # ENCLOSED VOIDS (2026-10-11). A sealed cavity — a hollow modelled as a boolean
    # difference with no drain/escape hole — is invisible to the body count: it is a
    # SECOND shell, and shells>1 is also what two floating fragments look like. The
    # divider is the SIGN of each shell's volume. For a consistently wound solid the
    # divergence theorem gives the outer surface a positive volume and a cavity's
    # surface a NEGATIVE one, because a cavity's outward normal (outward from the
    # MATERIAL) points into the void. Sum them and you get the material volume back:
    # hollow sphere R10/r9 → +4188.8 − 3053.6 = +1135.2 mm³. So: negative = a void,
    # positive = a separate body. That distinction is what makes "trapped powder /
    # uncured resin can never leave" a geometric WITNESS rather than a guess.
    voids = []
    for component in components:
        tris = faces[np.asarray(component, dtype=np.int64)]
        a = vertices[tris[:, 0]]
        b = vertices[tris[:, 1]]
        c = vertices[tris[:, 2]]
        signed = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)
        if signed >= -1e-6:
            continue
        used = np.unique(tris.reshape(-1))
        points = vertices[used]
        voids.append(
            {
                "volumeMm3": round(abs(signed), 3),
                "center": [round(float(x), 3) for x in points.mean(axis=0)],
                "min": [round(float(x), 3) for x in points.min(axis=0)],
                "max": [round(float(x), 3) for x in points.max(axis=0)],
            }
        )
    voids.sort(key=lambda void: -void["volumeMm3"])

    # --- G3 (2026-10-29): HOLE-CORE STRAY SHELLS ----------------------------
    # A horizontal/closed boolean difference can leave the CUT MATERIAL inside as
    # its own tiny positive shell — the "孔芯" the roberval bottom beam shipped
    # with (two 3.4×17×3.4 plugs inside the part, bodies=3, silently). They are
    # the difference between "3 bodies" and "why 3 bodies". Classification, NOT
    # removal: auto-dropping shells can mask a real modelling error, so the
    # verdict stays with the human. A stray is a POSITIVE-volume body that is
    # (a) tiny against the main body (<1% of its bbox-diagonal-scaled volume
    # proxy: both plugs were ~1/5000) and (b) strictly inside the main body's
    # bbox — a legitimate second body (a dowel, a key) sticks OUT or is
    # comparable in size.
    strays = []
    if len(components) > 1:
        comps = []
        for component in components:
            tris = faces[np.asarray(component, dtype=np.int64)]
            a = vertices[tris[:, 0]]
            b = vertices[tris[:, 1]]
            c = vertices[tris[:, 2]]
            signed = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)
            pts = vertices[np.unique(tris.reshape(-1))]
            comps.append({"signed": signed, "min": pts.min(axis=0), "max": pts.max(axis=0), "center": pts.mean(axis=0)})
        comps.sort(key=lambda e: -float((e["max"] - e["min"]).prod()))
        main = comps[0]
        main_vol = abs(main["signed"])
        main_diag = float(np.linalg.norm(main["max"] - main["min"]))
        for e in comps[1:]:
            if e["signed"] <= 0:
                continue  # a void shell — already reported above
            vol = abs(e["signed"])
            inside = bool(
                np.all(e["min"] > main["min"] + 1e-6) and np.all(e["max"] < main["max"] - 1e-6)
            )
            tiny = vol < 0.01 * main_vol and vol < 0.001 * main_diag**3
            if inside and tiny:
                strays.append(
                    {
                        "volumeMm3": round(vol, 3),
                        "center": [round(float(x), 3) for x in e["center"]],
                        "min": [round(float(x), 3) for x in e["min"]],
                        "max": [round(float(x), 3) for x in e["max"]],
                    }
                )
    strays.sort(key=lambda s: -s["volumeMm3"])

    return {
        "bodies": bodies,
        "count": len(bodies),
        "voids": voids,
        "strayShells": strays,
        "watertight": _is_watertight(faces),
        "triangles": int(len(faces)),
    }


def _watertight_bad_edges(faces) -> int:
    """How many directed-edge keys violate the strict manifold rule — the TS
    `isWatertight`'s `undirectedBad`: a directed edge must appear exactly once AND
    its reverse must exist. trimesh's own `is_watertight` only counts undirected
    edge sharing, which is laxer and would silence real warnings.

    WHY SORTS AND `searchsorted` INSTEAD OF `np.unique` / `np.isin` (measured
    2026-10-13, numpy 2.5.3, 1.29M directed-edge keys = a 430k-triangle part):
    `np.unique` WITHOUT `return_counts` and `np.isin` take numpy's hash path, which
    on this array cost 765ms and 750–1539ms per call against 55ms for a plain sort
    and 27ms for a binary search. Same rule, evaluated on sorted keys, ~10× faster —
    and this function is what made `list_features` slow (see `_mesh_watertight`).
    """
    import numpy as np

    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if faces.size == 0:
        return 1
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0).astype(np.int64)
    # Vertex indices are packed into one sortable key; 2**32 is above anything a
    # 32-bit vertex buffer can hold, so the packing stays injective.
    forward = np.sort(edges[:, 0] * 4294967296 + edges[:, 1])
    if len(forward) == 0:
        return 1
    reverse = np.sort(edges[:, 1] * 4294967296 + edges[:, 0])

    # Group starts of a sorted key array: a new distinct key begins wherever the
    # neighbour differs. Group SIZE is the old `counts`.
    starts = np.empty(len(forward), dtype=bool)
    starts[0] = True
    np.not_equal(forward[1:], forward[:-1], out=starts[1:])
    group_start = np.flatnonzero(starts)
    sizes = np.diff(np.append(group_start, len(forward)))
    bad = int(np.count_nonzero(sizes != 1))

    # `reverse` is already sorted, so its distinct keys are its group starts — no
    # second dedupe pass — and membership is a C-level binary search, not a hash set.
    reverse_starts = np.empty(len(reverse), dtype=bool)
    reverse_starts[0] = True
    np.not_equal(reverse[1:], reverse[:-1], out=reverse_starts[1:])
    reverse_unique = reverse[np.flatnonzero(reverse_starts)]
    present = forward[group_start]
    position = np.searchsorted(reverse_unique, present)
    np.clip(position, 0, len(reverse_unique) - 1, out=position)
    missing = int(np.count_nonzero(reverse_unique[position] != present))
    return bad + missing


def _is_watertight(faces) -> bool:
    """Strict manifold test, identical to the TS `isWatertight`: every DIRECTED edge
    occurs exactly once and its reverse exists. The tool reports this flag next to a
    "this part must be a single connected solid" verdict, so the stricter definition
    is the one that had to survive the migration.
    """
    import numpy as np

    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    return bool(faces.size > 0 and _watertight_bad_edges(faces) == 0)


def _mesh_watertight(mesh) -> bool:
    """`_is_watertight` for a trimesh mesh, asked at most ONCE per mesh object.

    Not a micro-optimisation — this was the whole cost of `list_features` on a big
    part (measured 2026-10-13): `_ray_spans` needs the flag to decide whether a
    point-in-solid test means anything, and `op_list_features` calls `_ray_spans`
    once per hole. On a 21.5MB / 430k-triangle part that recomputed the same
    1.29M-directed-edge pass 40 times: 50.9s of the op's 56.4s wall time.

    The flag is a function of `mesh.faces` alone and nothing in this worker mutates
    a mesh in place, so caching it on the object is the same answer for free. It is
    per-object rather than module-level on purpose: the worker is long-lived, and an
    id()-keyed global could serve a stale answer to a recycled address.
    """
    import numpy as np

    cached = getattr(mesh, "_cad_watertight", None)
    if cached is None:
        cached = _is_watertight(np.asarray(mesh.faces))
        try:
            mesh._cad_watertight = cached
        except AttributeError:  # a slotted or immutable mesh still gets the right answer
            pass
    return cached


def _parse_stl_raw(path: str):
    """Raw binary-STL triangles, float64, no welding — the TS parser's input."""
    import numpy as np

    data = open(path, "rb").read()
    if len(data) < 84:
        raise ValueError(f"STL too short: {len(data)} bytes")
    count = int.from_bytes(data[80:84], "little")
    expected = 84 + count * 50
    if len(data) < expected:
        raise ValueError(f"STL truncated: {len(data)} < {expected}")
    dtype = np.dtype([("normal", "<3f4"), ("vertices", "<9f4"), ("attr", "<u2")])
    triangles = np.frombuffer(data, dtype=dtype, count=count, offset=84)
    return triangles["vertices"].reshape(count, 3, 3).astype(np.float64)


def _weld(vertices, faces):
    """Mirror of the TS `MeshBuilder` + welding step.

    Coordinates are keyed at 1e-5 mm, the FIRST occurrence's exact values survive,
    and triangles with a repeated vertex are dropped as degenerate (their count is
    returned — the TS parser counts them too, it just never reports them).

    ORDER MATTERS. `np.unique` hands back unique keys SORTED, while the TS builder
    assigns indices in FIRST-ENCOUNTER order — and vertex order propagates into the
    stored STL, so a sorted rebuild produced byte-different (though geometrically
    identical) deliverables. `remap` restores the encounter order.
    """
    import numpy as np

    vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    keys = np.round(vertices * 1e5).astype(np.int64)
    unique_keys, first_index, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    encounter = np.argsort(first_index, kind="stable")
    remap = np.empty(len(unique_keys), dtype=np.int64)
    remap[encounter] = np.arange(len(unique_keys), dtype=np.int64)
    mapped = remap[inverse][faces]
    keep = (mapped[:, 0] != mapped[:, 1]) & (mapped[:, 1] != mapped[:, 2]) & (mapped[:, 0] != mapped[:, 2])
    degenerate = int(np.count_nonzero(~keep))
    return vertices[first_index[encounter]].astype(np.float32), mapped[keep].astype(np.uint32), degenerate


def _weld_raw(raw):
    """Weld a raw (n,3,3) triangle array: flat vertices + implicit faces."""
    import numpy as np

    vertices = np.asarray(raw, dtype=np.float64).reshape(-1, 3)
    return _weld(vertices, np.arange(len(vertices), dtype=np.int64).reshape(-1, 3))


def _detect_stl_format(data: bytes) -> str:
    """The TS `detectStlFormat`: the binary test is the exact length identity, so a
    binary file whose header starts with "solid" is not mistaken for ASCII."""
    import re

    if len(data) >= 84:
        count = int.from_bytes(data[80:84], "little")
        if 84 + count * 50 == len(data):
            return "binary"
    head = data[: min(len(data), 2048)].decode("utf-8", "replace").lstrip()
    if re.match(r"^solid\b", head) and re.search(r"\bfacet\b", head):
        return "ascii"
    return "unknown"


def _parse_ascii_vertices(data: bytes):
    """The TS `parseAsciiStl`: only `vertex x y z` lines carry geometry, and a
    dangling vertex count is an error rather than a silently partial mesh."""
    import numpy as np

    vertices = []
    for raw_line in data.decode("utf-8", "replace").split("\n"):
        line = raw_line.strip()
        if not line.startswith("vertex"):
            continue
        parts = line.split()
        try:
            x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
        except (IndexError, ValueError) as exc:
            raise ValueError(f'ASCII STL: unparseable vertex line "{line[:60]}"') from exc
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            raise ValueError(f'ASCII STL: unparseable vertex line "{line[:60]}"')
        vertices.append((x, y, z))
    if len(vertices) % 3 != 0:
        raise ValueError(f"ASCII STL: {len(vertices) % 3} dangling vertex/vertices (not a multiple of 3)")
    return np.asarray(vertices, dtype=np.float64).reshape(-1, 3)


def _solid_from_stl(path: str, transform) -> dict:
    """Bytes → placed solid, mirroring `solidify.ts` step for step.

    matrix (rightmost, applied to the welded mesh) → Manifold merge → status and
    volume checks (a non-solid or inside-out mesh is REFUSED, never patched) →
    rotate → translate. The returned mesh is Manifold's output, so every consumer
    (watertight test, distance sampling, bbox) shares one coordinate frame —
    the same invariant the TS version documents.
    """
    import numpy as np
    from manifold3d import Error, Manifold, Mesh

    vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(path))
    if transform and transform.get("matrix"):
        matrix = np.asarray(transform["matrix"], dtype=np.float64)
        vertices = (vertices.astype(np.float64) @ matrix.T).astype(np.float32)
    mesh = Mesh(vertices, faces)
    mesh.merge()
    solid = Manifold(mesh)
    status = solid.status()
    volume = float(solid.volume())
    if status != Error.NoError:
        raise ValueError(f"not a solid: Manifold status {status.name}")
    if volume < 0:
        raise ValueError(f"mesh faces are wound inside-out (signed volume {volume} mm³) — not a usable solid")
    if transform and transform.get("rotate"):
        solid = solid.rotate([float(x) for x in transform["rotate"]])
    if transform and transform.get("translate"):
        solid = solid.translate([float(x) for x in transform["translate"]])
    out = solid.to_mesh()
    box = [float(x) for x in solid.bounding_box()]
    return {
        "solid": solid,
        "verts": np.asarray(out.vert_properties, dtype=np.float64)[:, :3],
        "faces": np.asarray(out.tri_verts, dtype=np.int64),
        "volume": float(solid.volume()),
        "bbox": {"min": box[0:3], "max": box[3:6]},
    }


def _aabb_gap(a: dict, b: dict) -> float:
    """Lower bound on the distance between two solids, from their AABBs.

    `_solid_from_stl` returns `bbox: {min: [x,y,z], max: [x,y,z]}` in world mm.
    Each axis contributes `max(0, a.min - b.max, b.min - a.max)`; the largest of
    the three is the box-to-box distance. Every point of a solid lies inside its
    box, so this is a LOWER bound on the solid-to-solid distance: `gap > threshold`
    proves the pair is farther apart than the threshold, and no boolean or
    sampling can change that. Used by the adjacency broad phase.
    """
    return max(
        0.0,
        a["min"][0] - b["max"][0], b["min"][0] - a["max"][0],
        a["min"][1] - b["max"][1], b["min"][1] - a["max"][1],
        a["min"][2] - b["max"][2], b["min"][2] - a["max"][2],
    )


def _min_distance_via_sampling(verts, faces, target_verts, target_faces, max_samples: int = 1200) -> float:
    """The TS `minDistanceViaBVH` sampling rule: walk triangles with a stride, take
    ALL THREE vertices of each sampled triangle, and keep the smallest exact
    distance to the other surface (0 short-circuits)."""
    import numpy as np
    import trimesh

    triangle_count = len(faces)
    if triangle_count == 0:
        return float("nan")
    step = max(1, triangle_count // max_samples)
    sampled = faces[::step]
    points = verts[np.unique(sampled.reshape(-1))]
    target = trimesh.Trimesh(vertices=target_verts, faces=target_faces, process=False)
    return _closest_side(points, target, max_points=None)["value"]


# ---------------------------------------------------------------------------
# The CONTRACT half of `check_assembly` (moved here 2026-10-12, DECISION-LOG #2).
#
# What moved: the layer/check derivation, the five operators
# (distance / motion-clearance / spring-preload / coaxial / diameter-match), the
# verdict-vs-tolerance rule, the undeclared-adjacency discovery, and the summary.
# What stayed in TS: manifest and store I/O, part world loading (STL path + datums +
# pose), endpoint resolution, the motion-run records and their evidence staleness —
# all of it needs the store, not the geometry.
#
# `coaxial` consumes `_axis_line_metrics`, the same arithmetic `measure_angle` uses,
# which is the whole reason the migration was scheduled with that tool.

DEFAULT_DERIVED = {
    "贴合": ("L0", "distance"),
    "间隙": ("L0", "distance"),
    "紧固": ("L0", "diameter-match"),
    "转动副": ("L1", "motion-clearance"),
    "滑动副": ("L1", "motion-clearance"),
    "弹簧": ("L1", "spring-behaviour"),
    "流道": ("L2", "flow"),
}

# Operators this engine can actually evaluate. Everything else is reported as
# `skipped` — deliberately, because a green verdict on a check nobody ran is the most
# expensive lie a validator can tell.
IMPLEMENTED_CHECKS = {"distance", "diameter-match", "coaxial", "motion-clearance", "spring-preload"}


def _js_num(value) -> str:
    """A number as a JS template literal renders it: `6`, not `6.0`.

    The detail strings are part of the report a human reads, so they are compared
    character for character in the parity acceptance — which means Python's `str(6.0)`
    ('6.0') is a parity break against JS's `${6}` ('6')."""
    number = float(value)
    if number.is_integer() and abs(number) < 1e15:
        return str(int(number))
    return repr(number)


def _num_param(iface: dict, keys: list) -> float | None:
    for key in keys:
        value = (iface.get("params") or {}).get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if math.isfinite(float(value)):
            return float(value)
    return None


def _assembly_base(iface: dict) -> dict:
    layer, check = DEFAULT_DERIVED.get(iface.get("type"), ("L1", "unknown"))
    return {
        "interfaceId": iface["id"],
        "ownerPath": iface.get("ownerPath") or [],
        "a": iface["a"],
        "b": iface["b"],
        "type": iface["type"],
        "severity": iface["severity"],
        "layer": iface.get("layer") or layer,
        "check": iface.get("check") or check,
        "verdict": "skipped",
        "detail": "",
    }


def _assembly_verdict(iface: dict, measured: float, detail: str) -> dict:
    """`verdictFor` in assembly-check.ts — including its layer/check defaults, which
    differ from `_assembly_base`'s (L0/distance here vs the type-derived pair there).
    That difference is reproduced deliberately: the parity acceptance is what proves
    the migration changed no number and no word."""
    tolerance = iface.get("tolerance")
    severity = iface["severity"]
    if not tolerance:
        # A measured quantity without a criterion is NOT a pass. The old rule was
        # `in_range = True` when tolerance was absent, so a coaxial interface with
        # a 116 mm axis offset printed "pass" (observed on the 2026-10-20 toy
        # balance: all 25 interfaces declared no tolerance and all 25 "passed").
        # The honest answer is skipped, with the fix named.
        verdict = "skipped"
        detail = detail + " — no tolerance declared: add tolerance {min,max}; a missing criterion is NOT a pass"
    else:
        in_range = measured >= tolerance["min"] and measured <= tolerance["max"]
        verdict = "pass" if in_range else ("hard-violation" if severity == "hard" else "intent-flag")
    out = {
        "interfaceId": iface["id"],
        "ownerPath": iface.get("ownerPath") or [],
        "a": iface["a"],
        "b": iface["b"],
        "type": iface["type"],
        "severity": severity,
        "layer": iface.get("layer") or "L0",
        "check": iface.get("check") or "distance",
        "verdict": verdict,
        "measured": measured,
        "detail": detail,
    }
    nominal = iface.get("nominal")
    if nominal:
        expected = {"quantity": nominal["quantity"]}
        if tolerance:
            if "min" in tolerance:
                expected["min"] = tolerance["min"]
            if "max" in tolerance:
                expected["max"] = tolerance["max"]
        out["expected"] = expected
    return out


def _datum_distance(ra: dict, rb: dict):
    """Distance between two resolved datums, honoring the FEATURE KIND.

    A plane datum's meaning is the plane, not its anchor point. `resolveEndpoint`
    (src/host/assembly-check.ts) already resolves `normal` for planes; keeping
    point-to-point here made two coplanar planes with laterally offset anchors
    report the offset as a gap (toy-balance2 I9: 8.5mm for a 0mm plane gap).

      plane/plane  → perpendicular distance; an angled pair reports the same
                     point-to-plane number but names the angle
      plane/point  → point-to-plane
      anything else → point-to-point (the pre-existing semantics)

    This is the worker twin of `datumDistance` in assembly-check.ts; the parity
    acceptance compares the two on real manifests.
    """
    pa = [float(x) for x in ra["point"]]
    pb = [float(x) for x in rb["point"]]

    def sub(u, v):
        return [u[0] - v[0], u[1] - v[1], u[2] - v[2]]

    def dot(u, v):
        return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]

    def unit(v):
        n = math.sqrt(dot(v, v)) or 1.0
        return [x / n for x in v]

    na, nb = ra.get("normal"), rb.get("normal")
    if na and nb:
        ua, ub = unit(na), unit(nb)
        # Anti-parallel normals describe the SAME plane orientation (0°, not 180°).
        angle = math.degrees(math.acos(max(-1.0, min(1.0, abs(dot(ua, ub))))))
        measured = _round_js(abs(dot(sub(pb, pa), ua)), 4)
        if angle <= 1.0:
            return measured, f"plane-to-plane distance {_js_num(measured)}mm (normals {angle:.3f}° apart)"
        return measured, (
            f"point-to-plane distance {_js_num(measured)}mm "
            f"(planes {angle:.3f}° apart — NOT parallel)"
        )
    if na:
        measured = _round_js(abs(dot(sub(pb, pa), unit(na))), 4)
        return measured, f"point-to-plane distance {_js_num(measured)}mm"
    if nb:
        measured = _round_js(abs(dot(sub(pa, pb), unit(nb))), 4)
        return measured, f"point-to-plane distance {_js_num(measured)}mm"
    return _round_js(math.dist(pa, pb), 4), "point-to-point distance between declared datums"


def op_assembly_contracts(params: dict) -> dict:
    """Evaluate the declared interfaces and discover undeclared neighbours.

    The reply is the report MINUS the store-derived fields (checkedAt, manifestPath,
    manifestName, partWarnings): those are the caller's, because only the caller has
    the manifest and the version store.
    """
    import numpy as np

    runs = params.get("runs") or {}
    thresholds = params.get("thresholds") or {}
    results: list = []

    for iface in params["interfaces"]:
        base = _assembly_base(iface)
        layer, check = base["layer"], base["check"]
        if layer != "L0" and check not in IMPLEMENTED_CHECKS:
            results.append({**base, "detail": f'{layer} check "{check}" not implemented in v1 — pending'})
            continue
        # `a`/`b` are the manifest ADDRESS strings and the report echoes them; the
        # resolved world features arrive under `aFeature`/`bFeature`. Folding the
        # features into `a`/`b` was my first attempt and the parity acceptance caught
        # it: the pre-migration report carried strings, so an object there is a
        # contract change for every consumer that reads the address.
        ra, rb = iface.get("aFeature") or {}, iface.get("bFeature") or {}
        if "error" in ra:
            results.append({**base, "detail": ra["error"]})
            continue
        if "error" in rb:
            results.append({**base, "detail": rb["error"]})
            continue

        pa = [float(x) for x in ra["point"]]
        pb = [float(x) for x in rb["point"]]

        if check in ("distance", "motion-clearance"):
            if check == "distance":
                measured, detail = _datum_distance(ra, rb)
            else:
                measured = _round_js(float(math.dist(pa, pb)), 4)
                detail = "point-to-point distance between declared datums"
            verdict = _assembly_verdict(iface, measured, detail)
            if check == "motion-clearance":
                # A motion claim has two halves and this engine can decide one: the
                # relationship at the modelled pose (a distance, evaluated above) and
                # whether the pair survives the travel (decided by simulate_motion).
                # An interface naming the run that proved it gets the halves tied
                # together here instead of being reported as unimplemented forever.
                raw = (iface.get("params") or {}).get("runId")
                cited = str(raw) if isinstance(raw, str) else None
                if not cited:
                    verdict["detail"] += " — motion half NOT evidenced: run simulate_motion over the travel and cite it with params.runId"
                else:
                    run = runs.get(cited)
                    if not run:
                        verdict["verdict"] = "hard-violation"
                        verdict["detail"] += f' — params.runId "{cited}" names no run in this project'
                    elif run.get("kind") != "motion":
                        verdict["verdict"] = "hard-violation"
                        verdict["detail"] += f' — run {cited} is a {run.get("kind")} run, not a motion run'
                    elif run.get("status") != "pass":
                        verdict["verdict"] = "hard-violation"
                        verdict["detail"] += f' — cited motion run {cited} did not pass ({run.get("summary")})'
                    elif run.get("staleVersionIds"):
                        stale = run["staleVersionIds"]
                        verdict["verdict"] = "hard-violation"
                        verdict["detail"] += (
                            f" — cited motion run {cited} is STALE: it verified {', '.join(stale)}, "
                            "which a part has since replaced. Re-run the motion over the current versions and cite that run "
                            "(evidence expires with the version it cites)."
                        )
                    else:
                        superseded = f", SUPERSEDED by {run['supersededBy']}" if run.get("supersededBy") else ""
                        verdict["detail"] += f' — motion evidenced by {cited} ({run.get("summary")}{superseded})'
            results.append(verdict)
        elif check == "spring-preload":
            stiffness = _num_param(iface, ["stiffnessNPerMm", "springRateNPerMm", "k"])
            free = _num_param(iface, ["freeLengthMm", "freeLength"])
            if stiffness is None or free is None:
                results.append({
                    **base,
                    "detail": "spring-preload needs params.freeLengthMm and params.stiffnessNPerMm, with a and b being the "
                              "spring's own two ends — without them there is nothing to measure a deflection against",
                })
                continue
            installed = _round_js(float(math.dist(pa, pb)), 4)
            deflection = _round_js(free - installed, 4)
            force = _round_js(stiffness * deflection, 4)
            detail = (
                f"installed {_js_num(installed)}mm vs free {_js_num(free)}mm → δ{_js_num(deflection)}mm × "
                f"{_js_num(stiffness)}N/mm = {_js_num(force)}N"
                + (" (STRETCHED past free length — negative deflection)" if deflection < 0 else "")
            )
            results.append(_assembly_verdict(iface, force, detail))
        elif check == "coaxial":
            dir_a = ra.get("dir")
            dir_b = rb.get("dir")
            if not dir_a or not dir_b:
                results.append({
                    **base,
                    "detail": "coaxial requires axis or cylinder datums (datum_axis / datum_cyl) on both endpoints — "
                              "a point datum has no direction to be coaxial WITH",
                })
                continue
            metrics = _axis_line_metrics(pa, dir_a, pb, dir_b)
            measured = _round_js(metrics["distanceMm"], 4)
            verdict = _assembly_verdict(
                iface, measured,
                f'axis offset {_js_num(measured)}mm, axes {metrics["acuteDeg"]:.3f}° apart (line-to-line, infinite extents)',
            )
            tolerance = iface.get("tolerance") or {}
            ceiling = tolerance.get("max", float("inf"))
            if metrics["acuteDeg"] > 1.0 and measured <= ceiling:
                # A tilted bore can pass the offset test while the parts will not
                # assemble; the tolerance speaks about the offset, so tilt gets its own
                # hard note rather than silently riding inside a pass.
                verdict["detail"] += " — axes NOT parallel: offset pass does not mean the bores line up"
                if iface["severity"] == "hard":
                    verdict["verdict"] = "hard-violation"
            results.append(verdict)
        elif check == "diameter-match":
            radius_a, radius_b = ra.get("radius"), rb.get("radius")
            if not isinstance(radius_a, (int, float)) or not isinstance(radius_b, (int, float)):
                results.append({**base, "detail": "diameter-match requires cylinder datums (datum_cyl) on both endpoints"})
                continue
            # a = hole (larger), b = shaft: diametral clearance
            measured = _round_js(2 * (float(radius_a) - float(radius_b)), 4)
            verdict = _assembly_verdict(
                iface, measured,
                f"diametral clearance Ø{_js_num(measured)} (hole Ø{_js_num(2 * float(radius_a))} "
                f"vs shaft Ø{_js_num(2 * float(radius_b))})",
            )
            if measured < 0 and iface["severity"] != "hard":
                verdict["verdict"] = "hard-violation"
                verdict["detail"] += " — negative clearance means interference, escalated to hard"
            results.append(verdict)
        else:
            results.append({**base, "detail": f'L0 check "{check}" is unknown — skipped'})

    # ---- adjacency discovery: near/interfering pairs with no declared interface ----
    undeclared: list = []
    geometric = [part for part in (params.get("parts") or []) if part.get("path")]
    if len(geometric) >= 2:
        threshold = float(thresholds.get("adjacencyThresholdMm", 0.75))
        built = [(part, _solid_from_stl(part["path"], part.get("transform"))) for part in geometric]
        declared_pairs = set()
        for iface in params["interfaces"]:
            head_a = str(iface.get("a", "")).split(".")[0]
            head_b = str(iface.get("b", "")).split(".")[0]
            if head_a and head_b:
                declared_pairs.add(tuple(sorted((head_a, head_b))))
        pairs = declared_skipped = bbox_skipped = exact_tests = 0
        for i in range(len(built)):
            for j in range(i + 1, len(built)):
                part_a, solid_a = built[i]
                part_b, solid_b = built[j]
                pairs += 1
                key = tuple(sorted((part_a["id"], part_b["id"])))
                if key in declared_pairs:
                    # The interface half already judged this pair; discovery exists
                    # for the pairs nobody declared. Skipping before the boolean is
                    # not a shortcut with a different answer — it is the same skip,
                    # one expensive operation earlier.
                    declared_skipped += 1
                    continue
                # BROAD PHASE: the AABB distance is a LOWER BOUND on the distance
                # between the solids. If the boxes are farther apart than the
                # threshold, no boolean or sampling can make the pair "near" —
                # skipping is exact, not heuristic.
                if _aabb_gap(solid_a["bbox"], solid_b["bbox"]) > threshold:
                    bbox_skipped += 1
                    continue
                exact_tests += 1
                intersection = solid_a["solid"] ^ solid_b["solid"]
                volume = 0.0 if intersection.is_empty() else max(0.0, float(intersection.volume()))
                min_distance = 0.0
                if volume <= 1e-6:
                    min_distance = min(
                        _min_distance_via_sampling(solid_a["verts"], solid_a["faces"], solid_b["verts"], solid_b["faces"]),
                        _min_distance_via_sampling(solid_b["verts"], solid_b["faces"], solid_a["verts"], solid_a["faces"]),
                    )
                if not (volume > 1e-6 or min_distance < threshold):
                    continue
                undeclared.append({
                    "partA": part_a["id"],
                    "partB": part_b["id"],
                    "minDistance": _round_js(min_distance, 4),
                    "intersectionVolume": _round_js(volume, 4),
                })
        _log(
            f"adjacency: {pairs} pairs, {declared_skipped} declared skipped, "
            f"{bbox_skipped} bbox skipped, {exact_tests} exact tests"
        )

    passed = sum(1 for r in results if r["verdict"] == "pass")
    hard = sum(1 for r in results if r["verdict"] == "hard-violation")
    intents = sum(1 for r in results if r["verdict"] == "intent-flag")
    skipped = sum(1 for r in results if r["verdict"] == "skipped")
    return {
        "results": results,
        "undeclared": undeclared,
        "summary": {
            "interfaces": len(results),
            "pass": passed,
            "hardViolations": hard,
            "intentFlags": intents,
            "skipped": skipped,
            "undeclared": len(undeclared),
        },
        # skipped is not a pass either: an interface nobody could decide leaves the
        # manifest unverified, so the report must say "check", not "pass".
        "overallStatus": "fail" if hard > 0 else ("check" if intents + len(undeclared) + skipped > 0 else "pass"),
    }


def op_validate_assembly(params: dict) -> dict:
    """The whole assembly report: per-part solid facts + pairwise interference and
    clearance. Mirrors `validateAssembly` in src/host/assembly.ts.

    Interference is decided by Manifold's intersection volume (sub-epsilon overlaps
    are reported as 'ok' with the volume visible, exactly like the TS version —
    microscope3's printed thread showed why), and only non-touching pairs pay for
    the distance sampling.
    """
    parts = params["parts"]
    threshold = float(params.get("thresholdMm", 0.75))
    epsilon = float(params.get("interferenceEpsilonMm3", 1e-3))

    built = []
    part_reports = []
    for part in parts:
        info = _solid_from_stl(part["path"], part.get("transform"))
        built.append({"name": part["name"], **info})
        part_reports.append(
            {
                "name": part["name"],
                # status is already NoError (otherwise _solid_from_stl refused it)
                "watertight": _is_watertight(info["faces"]),
                "volume": info["volume"],
                "boundingBox": info["bbox"],
                "triangles": int(len(info["faces"])),
            }
        )

    pairs = []
    failed = False
    for i in range(len(built)):
        for j in range(i + 1, len(built)):
            a, b = built[i], built[j]
            intersection = a["solid"] ^ b["solid"]
            volume = 0.0 if intersection.is_empty() else max(0.0, float(intersection.volume()))
            if volume > epsilon:
                pairs.append({"partA": a["name"], "partB": b["name"], "intersectionVolume": volume, "minDistance": 0, "status": "interference"})
                failed = True
                continue
            if volume > 1e-9:
                # residual: touching by a whisper — visible, not failing
                pairs.append({"partA": a["name"], "partB": b["name"], "intersectionVolume": volume, "minDistance": 0, "status": "ok"})
                continue
            distance = min(
                _min_distance_via_sampling(a["verts"], a["faces"], b["verts"], b["faces"]),
                _min_distance_via_sampling(b["verts"], b["faces"], a["verts"], a["faces"]),
            )
            status = "too_tight" if distance < threshold else "ok"
            pairs.append({"partA": a["name"], "partB": b["name"], "intersectionVolume": 0, "minDistance": distance, "status": status})
            if status != "ok":
                failed = True

    return {
        "parts": part_reports,
        "pairs": pairs,
        "overallStatus": "fail" if failed else "pass",
        "thresholdMm": threshold,
        "interferenceEpsilonMm3": epsilon,
    }


def _snap_to_surface(mesh, point):
    """Closest surface point + inside/outside by the hit triangle's geometric normal
    — the TS `snapToSurface`. Returns the snapped point, how far the input was from
    the surface, whether it sat on the outward side of that face, and the hit face's
    own normal and index (the last two exist for `measure_angle`, which needs the
    normal of the face a probe landed on; taking the nearest triangle CENTRE instead
    would pick a neighbouring facet whenever the probe lands near an edge)."""
    import numpy as np
    import trimesh

    closest, distance, face_ids = trimesh.proximity.ProximityQuery(mesh).on_surface(np.asarray(point, dtype=float).reshape(1, 3))
    snapped = np.asarray(closest[0], dtype=float)
    vertices = np.asarray(mesh.vertices, dtype=float)
    face_index = int(face_ids[0])
    face = np.asarray(mesh.faces[face_index], dtype=np.int64)
    va, vb, vc = vertices[face[0]], vertices[face[1]], vertices[face[2]]
    normal = np.cross(vb - va, vc - va)
    length = float(np.linalg.norm(normal))
    if length > 0:
        normal = normal / length
    return {
        "snapped": snapped,
        "distance": float(distance[0]),
        "outside": bool(float(np.dot(np.asarray(point, dtype=float) - snapped, normal)) > 0),
        "normal": normal,
        "faceId": face_index,
    }


def op_measure_distance(params: dict) -> dict:
    """Two-point distance with optional surface snapping (the `measure_distance`
    tool). Both parts travel as paths; the watertight flags come back with the
    numbers so the caller's warning keeps its teeth — and they use the STRICT
    manifold test, not trimesh's laxer one."""
    import numpy as np

    mesh_a = _load(params["meshA"])
    mesh_b = _load(params["meshB"]) if params.get("meshB") else mesh_a
    point_a = np.asarray(params["a"], dtype=float)
    point_b = np.asarray(params["b"], dtype=float)

    snap_a = _snap_to_surface(mesh_a, point_a) if params.get("snapA", True) else {"snapped": point_a, "distance": 0.0, "outside": False}
    snap_b = _snap_to_surface(mesh_b, point_b) if params.get("snapB", True) else {"snapped": point_b, "distance": 0.0, "outside": False}
    pa = np.asarray(snap_a["snapped"], dtype=float)
    pb = np.asarray(snap_b["snapped"], dtype=float)
    delta = pb - pa
    return {
        "distanceMm": round(float(np.linalg.norm(delta)), 4),
        "dxMm": round(float(delta[0]), 4),
        "dyMm": round(float(delta[1]), 4),
        "dzMm": round(float(delta[2]), 4),
        "aSnapped": [float(x) for x in pa],
        "bSnapped": [float(x) for x in pb],
        "aSnapDistanceMm": round(float(snap_a["distance"]), 4),
        "bSnapDistanceMm": round(float(snap_b["distance"]), 4),
        "aOutside": bool(snap_a["outside"]),
        "bOutside": bool(snap_b["outside"]),
        "watertightA": _is_watertight(np.asarray(mesh_a.faces)),
        "watertightB": _is_watertight(np.asarray(mesh_b.faces)),
    }


def _ray_spans(mesh, origin, direction, tolerance_mm, max_span_mm, label) -> dict:
    """Material spans along ONE ray through ONE solid (the `measure_thickness` core).

    Why this exists next to `measure_distance`: a caller that cannot name an exact
    surface point (an LLM measuring a part it did not write, an imported STL with no
    datums) can still name a LINE, and a line only has to cross the wall it is
    asking about. Every crossing is returned, so "how deep do I have to aim" stops
    being a question.

    TWO degeneracies are handled here, and both were measured, not guessed:

    * **Coincident crossings.** A ray that clips a triangle seam reports the same
      surface twice, and an un-deduped pair silently becomes a zero-thickness wall
      — that is how `sdf.ts` once flipped inside/outside on axis-aligned meshes.
      So crossings are clustered at `tolerance_mm` before pairing, and a cluster
      whose entering and exiting crossings cancel is a tangency, not material.

    * **A ray that lies exactly ON a seam or through a vertex reports NOTHING.**
      Measured on an OpenSCAD tube: `+x` at y=0, z=0 (the vertex line of a `$fn`
      cylinder) returned **0 crossings where 4 exist**. That is the one query a
      caller is most likely to type — round numbers, an axis, a bore — and it fails
      silently in the worst direction. So the requested line is probed together
      with two rings of small perpendicular offsets (1e-3mm and 1e-2mm, eight
      directions each), and the answer is the majority among the probes whose
      inside/outside walk is self-consistent. A perpendicular offset changes a
      crossing's distance by `d²/2R` (5e-6mm at d=0.01mm, R=10), i.e. below the
      0.001mm the tool reports — so the winning answer is the requested line's
      answer, and `nudgedMm` says how far the accepted line sits from it (0 when
      the requested line itself won).
    """
    import numpy as np

    in_origin = np.asarray(origin, dtype=float)
    in_dir = np.asarray(direction, dtype=float)

    # An orthonormal basis perpendicular to the ray. The offsets live in this
    # plane, so they never change which side of a wall the start point is on.
    seed = np.array([0.0, 0.0, 1.0]) if abs(in_dir[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(in_dir, seed)
    u = u / float(np.linalg.norm(u))
    v = np.cross(in_dir, u)

    watertight = _mesh_watertight(mesh)
    point_inside = bool(mesh.contains(in_origin.reshape(1, 3))[0]) if watertight else None

    def probe(offset) -> dict:
        """One ray cast + the resulting inside/outside walk."""
        off = u * offset[0] + v * offset[1]
        line_origin = in_origin + off
        hit_points, _index_ray, index_tri = mesh.ray.intersects_location(
            line_origin.reshape(1, 3), in_dir.reshape(1, 3), multiple_hits=True
        )
        events: list[dict] = []
        dropped = 0
        if len(hit_points):
            ts = (hit_points - line_origin) @ in_dir
            normals = np.asarray(mesh.face_normals, dtype=float)[index_tri]
            signs = normals @ in_dir
            order = np.argsort(ts, kind="stable")
            ts, hit_points, normals, signs = ts[order], hit_points[order], normals[order], signs[order]

            # Single-linkage clusters: crossings closer together than the tolerance
            # are one surface. Grouping on the previous crossing (not the cluster
            # start) cannot chain-drift — the tolerance is six orders below any wall.
            groups: list[list[int]] = [[0]]
            for i in range(1, len(ts)):
                if float(ts[i]) - float(ts[groups[-1][-1]]) <= tolerance_mm:
                    groups[-1].append(i)
                else:
                    groups.append([i])

            for group in groups:
                entering = [i for i in group if signs[i] < 0]
                exiting = [i for i in group if signs[i] > 0]
                net = len(entering) - len(exiting)
                if net == 0:
                    dropped += 1
                    continue
                side = entering if net > 0 else exiting
                normal = np.sum(normals[side], axis=0)
                length = float(np.linalg.norm(normal))
                events.append(
                    {
                        "kind": "enter" if net > 0 else "exit",
                        "t": float(np.mean(ts[side])),
                        "point": [float(x) for x in np.mean(hit_points[side], axis=0)],
                        "normal": [float(x) for x in (normal / length if length > 0 else normal)],
                    }
                )

        # State on THIS line: the first crossing's sign, else the point-in-solid
        # test (which is exact and does not care where the line sits).
        starts_inside = (events[0]["kind"] == "exit") if events else bool(point_inside)

        spans: list[dict] = []
        violations: list[str] = []
        inside = starts_inside
        start_t = 0.0 if inside else None
        start_point = [float(x) for x in line_origin] if inside else None
        start_normal = None
        for event in events:
            if event["kind"] == "enter":
                if inside:
                    violations.append(f"two entering crossings in a row at t={_round3(event['t'])}mm")
                inside, start_t, start_point, start_normal = True, event["t"], event["point"], event["normal"]
            else:
                if not inside:
                    violations.append(f"exiting crossing while already outside at t={_round3(event['t'])}mm")
                    continue
                spans.append(
                    {
                        "part": label,
                        "enterMm": start_t,
                        "exitMm": event["t"],
                        "thicknessMm": event["t"] - start_t,
                        "atMm": (start_t + event["t"]) / 2,
                        "entryPoint": start_point,
                        "exitPoint": event["point"],
                        "entryNormal": start_normal,
                        "exitNormal": event["normal"],
                    }
                )
                inside, start_t, start_point, start_normal = False, None, None, None

        # A missing crossing cannot be a legitimate answer when the start point is
        # inside the solid: a closed solid must be crossed on the way out.
        if point_inside and not events:
            violations.append("the start point is inside the solid but the ray found no crossings")
        if inside and not violations:
            violations.append("the ray is still inside material after its last crossing")
        return {
            "offset": offset,
            "spans": spans,
            "events": events,
            "startsInside": bool(starts_inside),
            "violations": violations,
            "dropped": dropped,
        }

    RING_1 = 1e-3
    RING_2 = 1e-2
    # 12 directions, not 8: a ray lying in an axis-aligned seam stays degenerate
    # for every offset whose perpendicular component along that seam's axis is
    # zero, so the ring needs enough directions with a NON-zero component on each
    # axis for the off-seam majority to be structural rather than lucky.
    unit_ring = [
        (math.cos(k * math.pi / 6), math.sin(k * math.pi / 6)) for k in range(12)
    ]
    candidates = [probe((0.0, 0.0))]
    for radius in (RING_1, RING_2):
        for dx, dy in unit_ring:
            candidates.append(probe((dx * radius, dy * radius)))

    clean = [candidate for candidate in candidates if not candidate["violations"]]
    pool = clean or candidates

    def same_answer(a: dict, b: dict) -> bool:
        if len(a["spans"]) != len(b["spans"]):
            return False
        if a["startsInside"] != b["startsInside"]:
            return False
        return all(
            abs(x["thicknessMm"] - y["thicknessMm"]) <= 1e-3 and abs(x["enterMm"] - y["enterMm"]) <= 1e-3
            for x, y in zip(a["spans"], b["spans"])
        )

    votes = [sum(1 for other in pool if same_answer(candidate, other)) for candidate in candidates if candidate in pool]
    best_index = max(range(len(pool)), key=lambda i: (votes[i], -abs(pool[i]["offset"][0]) - abs(pool[i]["offset"][1])))
    winner = pool[best_index]
    agreement = votes[best_index] / len(pool)

    nudged = float(np.hypot(winner["offset"][0], winner["offset"][1]))
    warnings: list[str] = []
    if winner["dropped"]:
        warnings.append(
            f"part {label}: dropped {winner['dropped']} zero-thickness crossing cluster(s) "
            "(a tangent ray, not a wall)"
        )
    if watertight and point_inside is not None and winner["startsInside"] != point_inside and nudged == 0:
        warnings.append(
            f"part {label}: the ray's first crossing says the start point is "
            f"{'inside' if winner['startsInside'] else 'outside'} but the solid test says "
            f"{'inside' if point_inside else 'outside'} — treat this part's spans as unreliable"
        )
    if winner["violations"]:
        warnings.append(
            f"part {label}: the inside/outside walk is inconsistent ({'; '.join(winner['violations'])}) — "
            "no probe of this line was self-consistent, so every span here is suspect"
        )
    if agreement < 1.0 and not winner["violations"]:
        warnings.append(
            f"part {label}: only {votes[best_index]}/{len(pool)} probes of this line agree — the ray runs "
            f"close to tangent to a surface, so the answer depends on a micron-scale offset. The reported "
            f"spans come from the line displaced by {_round3(nudged)}mm."
        )

    spans = winner["spans"]
    clipped = False
    if max_span_mm is not None:
        kept = []
        for span in spans:
            if span["enterMm"] > max_span_mm:
                clipped = True
                continue
            if span["exitMm"] > max_span_mm:
                span = dict(span, exitMm=max_span_mm, thicknessMm=max_span_mm - span["enterMm"], clipped=True)
                clipped = True
            kept.append(span)
        spans = kept

    return {
        "spans": spans,
        "crossings": winner["events"],
        "startsInside": bool(point_inside) if point_inside is not None else winner["startsInside"],
        "parityOdd": len(winner["events"]) % 2 == 1,
        "clipped": clipped,
        "nudgedMm": nudged,
        "probeAgreement": agreement,
        "warnings": warnings,
    }

def op_measure_thickness(params: dict) -> dict:
    """Every material span along one ray, through one or two solids.

    Deliberately coordinate-tolerant: the line has to cross the wall, the caller
    does not have to hit a surface. `meshes` is [a] or [a, b] so a cross-part
    clearance reads as the gap between a's last span and b's first span along the
    same line. Numbers are rounded to 0.001mm via `_round3` (JS rounding, -0
    normalised) because they are reported to the model verbatim.
    """
    import numpy as np

    paths = [path for path in params.get("meshes", []) if path]
    if not paths:
        raise ValueError("measure_thickness needs at least one mesh path")
    origin = np.asarray(params["from"], dtype=float)
    # A principal-axis name (`+x` … `-z`) or a vector; parsed by `_axis_vector`, the
    # one place axes are interpreted, so all three axis-taking ops agree.
    direction = _axis_vector(params["direction"], field="direction")

    warnings: list[str] = []
    watertight: dict[str, bool] = {}
    parts: dict[str, dict] = {}
    for index, path in enumerate(paths[:2]):
        label = "ab"[index]
        mesh = _load(path)
        watertight[label] = _mesh_watertight(mesh)
        if not watertight[label]:
            warnings.append(
                f"part {label} is NOT watertight — every span computed on an open mesh is unreliable; "
                "fix the mesh before trusting this number"
            )
        parts[label] = _ray_spans(
            mesh, origin, direction, float(params.get("toleranceMm", 1e-6)), params.get("maxSpanMm"), label
        )
        warnings.extend(parts[label]["warnings"])
        if parts[label]["parityOdd"] and not parts[label]["startsInside"]:
            warnings.append(
                f"part {label}: an odd number of crossings ({len(parts[label]['crossings'])}) — "
                "that cannot happen on a closed solid, so the ray is grazing an edge or the mesh is open"
            )

    spans = [span for label in parts for span in parts[label]["spans"]]
    spans.sort(key=lambda span: span["enterMm"])

    gaps = []
    for first, second in zip(spans, spans[1:]):
        gaps.append(
            {
                "afterMm": first["exitMm"],
                "beforeMm": second["enterMm"],
                "gapMm": second["enterMm"] - first["exitMm"],
                "between": "same-part" if first["part"] == second["part"] else f"{first['part']}→{second['part']}",
            }
        )

    def clean(span: dict) -> dict:
        cleaned = {
            "part": span["part"],
            "enterMm": _round3(span["enterMm"]),
            "exitMm": _round3(span["exitMm"]),
            "thicknessMm": _round3(span["thicknessMm"]),
            "atMm": _round3(span["atMm"]),
            "entryPoint": [_round3(v) for v in span["entryPoint"]],
            "exitPoint": [_round3(v) for v in span["exitPoint"]],
            "exitNormal": [_round3(v) for v in span["exitNormal"]],
            **({"clipped": True} if span.get("clipped") else {}),
        }
        # A span that starts AT the origin (the ray began inside material) has no
        # entering crossing, so the key is omitted rather than filled with a
        # placeholder vector — a fabricated normal would read as a measured one.
        if span["entryNormal"] is not None:
            cleaned["entryNormal"] = [_round3(v) for v in span["entryNormal"]]
        return cleaned

    if not spans:
        warnings.append(
            "the ray crosses no material — check `from` (was it meant to be inside the part?) "
            "and `direction` (is the axis the one you meant?). A ray lying exactly in a face plane "
            "or along an edge is undefined: nudge `from` by a fraction of a millimetre and try again"
        )

    return {
        "direction": [_round3(v) for v in direction],
        "from": [_round3(v) for v in origin],
        "fromInsideSolid": any(parts[label]["startsInside"] for label in parts),
        "spans": [clean(span) for span in spans],
        "gaps": [
            {
                "afterMm": _round3(gap["afterMm"]),
                "beforeMm": _round3(gap["beforeMm"]),
                "gapMm": _round3(gap["gapMm"]),
                "between": gap["between"],
            }
            for gap in gaps
        ],
        "thinnestSpanMm": _round3(min((span["thicknessMm"] for span in spans), default=0.0)),
        "clipped": any(span.get("clipped") for span in spans),
        # How far the accepted probe line sits from the requested one (0 = the
        # requested line itself won the vote), and how many of the 17 probes agreed.
        # A perpendicular displacement does not change a crossing's distance beyond
        # d²/2R, so these report how much the answer leaned on that tie-break.
        "nudgedMm": _round3(max(parts[label]["nudgedMm"] for label in parts)),
        "probeAgreement": min(parts[label]["probeAgreement"] for label in parts),
        "watertightA": watertight.get("a", False),
        "watertightB": watertight.get("b"),
        "warnings": warnings,
    }


def _chain_loops(edges):
    """Chain boundary edge pairs (vertex indices) into closed loops of vertices.

    `mesh.facets_boundary` hands back the boundary of a planar region as EDGES,
    not as loops, so the loop structure — and with it "this region has an inner
    boundary, therefore a hole" — has to be recovered here. The walk takes any
    unused neighbour at a pinch point and stops when it returns to the start, so a
    non-manifold boundary degrades into extra loops instead of hanging.
    """
    from collections import defaultdict

    adjacency = defaultdict(list)
    for a, b in edges:
        adjacency[int(a)].append(int(b))
        adjacency[int(b)].append(int(a))
    remaining = {(min(int(a), int(b)), max(int(a), int(b))) for a, b in edges}

    loops = []
    while remaining:
        first = remaining.pop()
        loop = [first[0], first[1]]
        while True:
            tail = loop[-1]
            candidates = [n for n in adjacency[tail] if (min(tail, n), max(tail, n)) in remaining]
            if not candidates:
                break
            step = candidates[0]
            remaining.discard((min(tail, step), max(tail, step)))
            if step == loop[0]:
                break
            loop.append(step)
        if len(loop) >= 3:
            loops.append(loop)
    return loops


def _fit_circle(uv):
    """Algebraic (Kåsa) circle fit in 2D → centre, radius, max radial residual."""
    import numpy as np

    x, y = uv[:, 0], uv[:, 1]
    design = np.column_stack([2 * x, 2 * y, np.ones(len(x))])
    target = x * x + y * y
    solution, *_ = np.linalg.lstsq(design, target, rcond=None)
    cx, cy, constant = (float(v) for v in solution)
    radius = math.sqrt(max(constant + cx * cx + cy * cy, 0.0))
    residual = float(np.max(np.abs(np.hypot(x - cx, y - cy) - radius))) if len(x) else 0.0
    return cx, cy, radius, residual


def _axis_vector(spec, field: str = "axis"):
    """One axis argument, parsed in ONE place: `x`/`+x`/`-x`/`y`/`z`, or a vector.

    Three ops take an axis (`measure_thickness` as a ray direction, `measure_section`
    as a plane normal, `measure_extent` as a projection axis) and they must agree on
    what the argument means. Keeping the parser here rather than in the tool layer is
    also what keeps `tools.ts` to "schema + forward" — the alternative was a second
    copy of these rules in TypeScript, which had already drifted (only one of the
    three accepted a signed string).
    """
    import numpy as np

    table = {"x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0]}
    if isinstance(spec, str):
        key = spec.strip().lower()
        sign = 1.0
        # A sign may lead or trail (`-x`, `x-`): both are what a caller types, and
        # rejecting one of them only costs a round trip to learn nothing.
        if key[:1] in ("+", "-"):
            sign = -1.0 if key[0] == "-" else 1.0
            key = key[1:]
        elif key[-1:] in ("+", "-"):
            sign = -1.0 if key[-1] == "-" else 1.0
            key = key[:-1]
        if key not in table:
            raise ValueError(
                f'{field} must be "x", "y", "z" (optionally signed) or a [x,y,z] vector — got {spec!r}'
            )
        vector = np.asarray(table[key], dtype=float) * sign
    else:
        vector = np.asarray(spec, dtype=float)
        if vector.size != 3:
            raise ValueError(f"{field} as a vector needs exactly three components, got {vector.size}")
    length = float(np.linalg.norm(vector))
    if length <= 0:
        raise ValueError(f"{field} must be a non-zero vector")
    return vector / length


def _plane_basis(normal):
    """An orthonormal in-plane basis (u, v), chosen so principal sections read
    naturally: a +z section gets u=x, v=y rather than an arbitrary pair."""
    import numpy as np

    seed = np.zeros(3)
    seed[int(np.argmin(np.abs(normal)))] = 1.0
    u = seed - normal * float(seed @ normal)
    u = u / float(np.linalg.norm(u))
    return u, np.cross(normal, u)


def _simplify_closed(points, tolerance_mm):
    """Indices of the vertices that carry shape.

    A vertex is dropped only when it lies within `tolerance_mm` of the line through
    its neighbours, so the extra vertices a triangulator scatters along a straight
    edge disappear while a tessellated arc survives: at the 0.01mm default a $fn=64
    circle of R=10 keeps every vertex (its sagitta is 0.012mm).
    """
    import numpy as np

    count = len(points)
    if count < 4:
        return list(range(count))
    kept = []
    for index in range(count):
        previous = points[(index - 1) % count]
        current = points[index]
        following = points[(index + 1) % count]
        along = following - previous
        length = float(np.linalg.norm(along))
        if length <= 0:
            continue
        gap = current - previous
        # 2D cross product written out: np.cross on 2-vectors is deprecated in numpy 2.
        offset = abs(along[0] * gap[1] - along[1] * gap[0]) / length
        if offset > tolerance_mm:
            kept.append(index)
    return kept or list(range(count))


def _signed_area(uv) -> float:
    import numpy as np

    x, y = uv[:, 0], uv[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _interior_point_uv(ring):
    """A point guaranteed to lie INSIDE a closed ring (2D uv), or None if it degenerates.

    Why this exists next to `_fit_circle`: the fitted-circle centre is only guaranteed to be
    inside the loop when the loop is roughly round or convex. On an L-shaped opening the
    centre lands in the material that fills the missing corner, and every probe cast from
    there starts inside the solid — measured 2026-10-13 on a 40x40x6 plate with a through L
    slot: 25/25 samples along the wall thickness hit material from the fitted centre and
    0/25 from this point. `measure_section` already reaches for `representative_point()`
    for exactly this reason (an annulus' centroid sits in its bore).
    """
    import numpy as np
    import shapely

    points = np.asarray(ring, dtype=float)
    if len(points) < 3:
        return None
    polygon = shapely.Polygon(points)
    if not polygon.is_valid:                      # a self-touching ring is still a region
        polygon = polygon.buffer(0)
    if polygon.is_empty or polygon.area <= 0:
        return None
    return np.asarray(polygon.representative_point().coords, dtype=float)[0]


def op_list_features(params: dict) -> dict:
    """The coordinate inventory a caller needs to measure geometry it did not draw.

    `measure_distance` asks for a point on a surface; a caller looking at an
    imported STL or a corpus part has no way to name one. This op is where those
    coordinates come FROM: planar faces with their normals and areas, the holes in
    them (centre, diameter, depth), and the cylindrical surfaces (axis, diameter,
    and whether the material is inside — a bore — or outside — a boss).

    How the features are found, and the choice made at each step:

    * **Planar faces** are trimesh's `facets` — connected sets of exactly coplanar
      triangles. A tessellated cylinder contributes one facet per quad, so a facet
      alone is not a feature; each face therefore also reports the SMOOTH REGION it
      belongs to (facets reachable across a dihedral angle below `smoothDeg`), and a
      quad of a Ø12 bore is recognisable as "5.9mm², one of 64 facets, 377mm²".
      `minFaceAreaMm2` (default 4.0, echoed in `thresholds`) keeps the list
      readable; `facesOmitted` says what it dropped, and every entry carries its own
      area so nothing depends on the threshold being right.
    * **Holes** need no threshold: a planar region whose boundary chains into more
      than one loop HAS an inner boundary. The largest-|signed area| loop is the
      outer one and the rest are holes, so a slot or a polygon pocket is reported as
      such (`kind: "non-circular"`) instead of being forced through a circle fit.
    * **Cylinders** come from a smooth region that is not planar: the axis is the
      direction minimising `(n·a)²` over the region's face normals (every normal of
      a cylinder is perpendicular to its axis), then a circle fit in the
      perpendicular plane gives the radius. The fit is GATED on residual — a
      torus-like or conical region fails the gate and is reported as a
      `curvedSurface` instead of being described as a cylinder it is not.
    * **Bore vs boss** is the sign of `n · (p − axis)` over the region: normals
      pointing at the axis mean the material is outside (a bore).
    """
    import numpy as np

    mesh = _load(params["path"])
    triangles = np.asarray(mesh.faces)
    watertight = _mesh_watertight(mesh)
    smooth_deg = float(params.get("smoothDeg", 10.0))
    min_face_area = float(params.get("minFaceAreaMm2", 4.0))
    max_faces = int(params.get("maxFaces", 40))
    max_cylinders = int(params.get("maxCylinders", 24))
    with_hole_depth = bool(params.get("withHoleDepth", True))

    warnings: list[str] = []
    if not watertight:
        warnings.append(
            "the mesh is NOT watertight — face and hole inventories of an open mesh are incomplete "
            "by construction; fix the mesh first"
        )

    # SAFE fill, and the reason is a real crash: `mesh.facets` groups COPLANAR
    # adjacent triangles, and trimesh's pass EXCLUDES degenerate/sliver faces. With
    # `np.empty` those faces kept uninitialised memory, which then entered the
    # connectivity graph as a facet index — measured on a rackstack connector
    # (64 of 444 faces uncovered), it crashed with
    # `ValueError: axis 0 index 281479271743489 exceeds matrix dimension 84`.
    # They are not reported as faces either (there is no facet boundary loop for
    # them), so they are marked -1 and simply do not join a smooth region.
    facet_of_face = np.full(len(triangles), -1, dtype=np.int64)
    for index, region in enumerate(mesh.facets):
        facet_of_face[np.asarray(region, dtype=np.int64)] = index
    facet_count = len(mesh.facets)
    facet_area = np.asarray(mesh.facets_area, dtype=float)
    facet_normal = np.asarray(mesh.facets_normal, dtype=float)
    facet_origin = np.asarray(mesh.facets_origin, dtype=float)
    loose_faces = np.where(facet_of_face < 0)[0]
    if loose_faces.size:
        loose_area = float(np.asarray(mesh.area_faces, dtype=float)[loose_faces].sum())
        warnings.append(
            f"{int(loose_faces.size)} face(s) ({_round3(loose_area)}mm² total) belong to no coplanar facet "
            "region — trimesh's facet pass leaves bevel/chamfer strips out. They are NOT reported as faces "
            "or cylinders here (single-face regions get misread as tiny cylinders), so treat the inventories "
            "below as covering everything except those strips"
        )
    # Faces trimesh's coplanar-facet pass leaves out are NOT invented into regions.
    # Tried it, and it is worse: measured on this project's own 06 fixture, the two
    # loose faces are 115mm² each, and promoting them to single-face regions made the
    # circle fitter report them as Ø0.393 "cylinders" — four bogus features replacing
    # the real boss and bores. So they are excluded from the inventory and COUNTED in
    # a warning instead: the caller learns that this mesh has faces the facet pass
    # could not group (measured on a real rackstack connector: 64 of 444, all
    # chamfer/bevel strips) rather than being handed made-up features.

    # Smooth regions: group facets across edges whose dihedral angle is small. This
    # is what separates "one face of the part" from "one segment of a cylinder".
    region_of_facet = np.arange(facet_count)
    smooth_angles = np.asarray(mesh.face_adjacency_angles, dtype=float)
    pairs = np.asarray(mesh.face_adjacency, dtype=np.int64)
    if len(pairs):
        kept = pairs[smooth_angles <= math.radians(smooth_deg)]
        if len(kept):
            from scipy.sparse import coo_matrix
            from scipy.sparse.csgraph import connected_components

            i = facet_of_face[kept[:, 0]]
            j = facet_of_face[kept[:, 1]]
            # Both sides must be REAL facets: a sliver face (-1) has no region to join.
            keep = (i >= 0) & (j >= 0) & (i != j)
            graph = coo_matrix(
                (np.ones(int(keep.sum())), (i[keep], j[keep])), shape=(facet_count, facet_count)
            )
            _count, labels = connected_components(graph, directed=False)
            region_of_facet = labels

    region_facets: dict[int, list[int]] = {}
    for facet in range(facet_count):
        region_facets.setdefault(int(region_of_facet[facet]), []).append(facet)

    def faces_of_region(region: int):
        """The TRIANGLE indices of one smooth region.

        `facet_of_face` maps facet → faces; the inverse needs `region_of_facet` (which
        facet belongs to which region). Comparing `facet_of_face` against a REGION
        label looks like the same thing and is not: for a merged region only the facet
        whose id happens to equal the label matches, so a 64-facet bore wall collapses
        to a couple of triangles and the circle fit reports Ø0.393 — measured on this
        project's own 06 fixture, four bogus cylinders replacing the real boss and
        bores. The union over the region's facets is the correct set.
        """
        out = np.concatenate([np.asarray(mesh.facets[int(f)], dtype=np.int64) for f in region_facets[region]])
        return out

    region_stats = {}
    for region, facets in region_facets.items():
        indices = np.asarray(facets, dtype=np.int64)
        normals = facet_normal[indices]
        reference = normals[0]
        # Sign-align before averaging: a facet's outward normal never legitimately
        # points the other way inside one smooth region, and averaging raw normals
        # around a bore would cancel to zero.
        aligned = normals * np.where(normals @ reference < 0, -1.0, 1.0)[:, None]
        mean_normal = aligned.mean(axis=0)
        length = float(np.linalg.norm(mean_normal))
        if length > 0:
            cosines = np.clip((aligned @ (mean_normal / length)), -1, 1)
            spread = float(np.degrees(np.arccos(cosines.min())))
        else:
            spread = 180.0
        region_stats[region] = {
            "facets": len(facets),
            "areaMm2": float(facet_area[indices].sum()),
            "planar": spread <= 1.0,
            "spreadDeg": spread,
        }

    def boundary_loops(facet: int):
        edges = mesh.facets_boundary[facet]
        if edges is None or len(edges) == 0:
            return []
        return _chain_loops(np.asarray(edges, dtype=np.int64).reshape(-1, 2))

    def hole_depth(center, normal, label):
        """Depth of the void behind a face along its inward normal: the first
        entering crossing is where the hole bottoms out. No crossing = through."""
        probe = _ray_spans(
            mesh,
            np.asarray(center, dtype=float) - np.asarray(normal, dtype=float) * 1e-3,
            -np.asarray(normal, dtype=float),
            1e-6,
            None,
            label,
        )
        warnings.extend(probe["warnings"])
        if not probe["spans"]:
            return None
        return float(probe["spans"][0]["enterMm"] + 1e-3)

    # --- planar faces (and the holes in them) ---------------------------------
    # ONLY facets whose smooth region is planar are faces. A facet of a non-planar
    # region is a segment of a curved surface (one quad of a bore), and listing
    # those is exactly the noise that would drown the real faces — they are
    # described by `cylinders` / `curvedSurfaces` instead.
    order = [int(i) for i in np.argsort(-facet_area)]
    reported = []
    holes_total = 0
    hole_serial = 0
    segments_not_listed = 0
    for facet in order:
        stats = region_stats[int(region_of_facet[facet])]
        if not stats["planar"]:
            if float(facet_area[facet]) >= min_face_area:
                segments_not_listed += 1
            continue
        if len(reported) >= max_faces:
            continue
        if float(facet_area[facet]) < min_face_area:
            continue
        normal = facet_normal[facet]
        origin = facet_origin[facet]
        u, v = _plane_basis(normal)
        loops = boundary_loops(facet)
        uv_loops = []
        for loop in loops:
            points = np.asarray(mesh.vertices, dtype=float)[np.asarray(loop, dtype=np.int64)]
            uv = np.column_stack([(points - origin) @ u, (points - origin) @ v])
            uv_loops.append((loop, points, uv))
        uv_loops.sort(key=lambda item: -abs(_signed_area(item[2])))
        holes = []
        for loop, points, uv in uv_loops[1:]:
            hole_serial += 1
            cx, cy, radius, residual = _fit_circle(uv)
            loop_area = abs(_signed_area(uv))
            circle_area = math.pi * radius * radius if radius > 0 else 0.0
            area_ratio = loop_area / circle_area if circle_area > 0 else 0.0
            # Residual alone does NOT decide circularity: the four corners of a
            # RECTANGLE are concyclic, so an algebraic circle fit lands on a 10×6
            # pocket exactly (residual 0) and would call it round. The area ratio is
            # what separates a polygon from a circle — a regular 64-gon keeps 0.9988
            # of its circle, a 10×6 rectangle keeps 0.56, a hex socket 0.83.
            round_enough = residual <= max(0.05, 0.02 * radius) and area_ratio >= 0.95
            center = origin + u * cx + v * cy
            entry = {
                "id": f"h{hole_serial}",
                "centerMm": [_round3(float(x)) for x in center],
                "axisMm": [_round3(float(x)) for x in normal],
                "kind": "round" if round_enough else "non-circular",
                "areaMm2": _round3(loop_area),
                "vertices": len(points),
                "circularityResidualMm": _round3(residual),
                "areaRatioToCircle": _round3(area_ratio),
            }
            if round_enough:
                entry["diameterMm"] = _round3(2 * radius)
            if with_hole_depth:
                # The depth probe must start from a point that is INSIDE the opening loop.
                # The fitted-circle centre is only guaranteed to be inside when the loop is
                # roughly round/convex: on an L-shaped through slot it lands in the material
                # that fills the missing corner, the ray hits that material 25/25 times along
                # the wall thickness and the hole is reported as a BLIND one (`depthMm` ~
                # 0.001). Measured 2026-10-13 on a 40x40x6 plate with an L slot: fitted-circle
                # centre -> through false; `representative_point()` -> through true.
                # So the probe point is the loop's own interior point, and the reported
                # `centerMm` stays what it is (the fitted-circle centre, which is the right
                # answer for a hole that IS round).
                probe = center
                try:
                    point_uv = _interior_point_uv(uv)
                    if point_uv is not None:
                        probe = origin + u * point_uv[0] + v * point_uv[1]
                except Exception:  # noqa: BLE001 - a degenerate ring must not lose the probe
                    probe = center
                depth = hole_depth(probe, normal, "a")
                entry["through"] = depth is None
                if depth is not None:
                    entry["depthMm"] = _round3(depth)
            holes.append(entry)
        holes_total += len(holes)
        reported.append(
            {
                "id": f"f{facet}",
                "normalMm": [_round3(float(x)) for x in normal],
                "originMm": [_round3(float(x)) for x in origin],
                "centroidMm": [_round3(float(x)) for x in np.asarray(mesh.triangles_center)[np.asarray(mesh.facets[facet], dtype=np.int64)].mean(axis=0)],
                "areaMm2": _round3(float(facet_area[facet])),
                "smoothRegion": {
                    "facets": stats["facets"],
                    "areaMm2": _round3(stats["areaMm2"]),
                    "planar": stats["planar"],
                },
                "holes": holes,
            }
        )

    # --- cylinders (and whatever else is curved) -------------------------------
    cylinders = []
    curved = []
    for region, facets in sorted(region_facets.items(), key=lambda item: -region_stats[item[0]]["areaMm2"]):
        stats = region_stats[region]
        if stats["planar"] or stats["facets"] < 6:
            continue
        indices = np.asarray(facets, dtype=np.int64)
        normals = facet_normal[indices]
        areas = facet_area[indices]
        # A flat facet can end up inside a curved region when a tangent fillet joins
        # it to a bore (BOSL2 rounding does this). Those facets are not listed as
        # faces, so the count is reported with the region: silence about a missing
        # face would be worse than the extra number.
        large_facets = int((areas >= min_face_area).sum())
        weights = areas / areas.sum()
        scatter = (normals * weights[:, None]).T @ normals
        _values, vectors = np.linalg.eigh(scatter)
        axis = vectors[:, 0]
        pivot = int(np.argmax(np.abs(axis)))
        if axis[pivot] < 0:
            axis = -axis
        # `mesh.facets` is a list of ragged arrays of TRIANGLE indices (one array per
        # region) — not vertex indices, and not stackable — so the region's vertices
        # come from its triangles. (`facets_boundary`, by contrast, hands back VERTEX
        # index pairs; the two are easy to confuse and do not fail loudly.)
        region_triangles = faces_of_region(int(region))
        vertices = np.unique(triangles[region_triangles].reshape(-1))
        points = np.asarray(mesh.vertices, dtype=float)[vertices]
        u, v = _plane_basis(axis)
        mean = points.mean(axis=0)
        relative = points - mean
        cx, cy, radius, residual = _fit_circle(np.column_stack([relative @ u, relative @ v]))
        axis_point = mean + u * cx + v * cy
        along = float(np.max(points @ axis) - np.min(points @ axis))
        tolerance = max(0.05, 0.02 * radius)
        if residual > tolerance:
            curved.append(
                {
                    "id": f"s{region}",
                    "areaMm2": _round3(stats["areaMm2"]),
                    "facets": stats["facets"],
                    "largeFacets": large_facets,
                    "reason": f"no cylinder fits: max radial residual {_round3(residual)}mm vs tolerance {_round3(tolerance)}mm",
                }
            )
            continue
        # Bore vs boss: for a bore every facet normal points AT the axis, for a boss
        # every normal points AWAY from it. Area-weighted so a coarse tessellation
        # does not outvote a fine one.
        face_centroids = np.asarray(mesh.triangles_center)
        radial_sum = 0.0
        for facet in indices:
            region_faces = np.asarray(mesh.facets[int(facet)], dtype=np.int64)
            centre = face_centroids[region_faces].mean(axis=0)
            direction = centre - axis_point
            length = float(np.linalg.norm(direction))
            if length > 0:
                radial_sum += float(facet_normal[int(facet)] @ (direction / length)) * float(facet_area[int(facet)])
        cylinders.append(
            {
                "id": f"c{region}",
                "kind": "bore" if radial_sum < 0 else "boss",
                "axisMm": [_round3(float(x)) for x in axis],
                "centerMm": [_round3(float(x)) for x in axis_point],
                "diameterMm": _round3(2 * radius),
                "lengthMm": _round3(along),
                "facets": stats["facets"],
                "areaMm2": _round3(stats["areaMm2"]),
                "largeFacets": large_facets,
                "fitResidualMm": _round3(residual),
            }
        )

    cylinders.sort(key=lambda entry: -entry["areaMm2"])
    if len(cylinders) > max_cylinders:
        curved.append(
            {
                "id": "omitted",
                "areaMm2": 0.0,
                "facets": 0,
                "largeFacets": 0,
                "reason": f"{len(cylinders) - max_cylinders} cylinder(s) omitted by maxCylinders={max_cylinders}",
            }
        )
        cylinders = cylinders[:max_cylinders]

    planar_facets = [
        facet for facet in range(facet_count)
        if region_stats[int(region_of_facet[facet])]["planar"] and float(facet_area[facet]) >= min_face_area
    ]
    return {
        "watertight": watertight,
        "triangles": int(len(triangles)),
        "thresholds": {
            "smoothDeg": smooth_deg,
            "minFaceAreaMm2": min_face_area,
            "maxFaces": max_faces,
            "maxCylinders": max_cylinders,
        },
        "faces": reported,
        # Planar faces that met the area threshold and were left out by maxFaces.
        "facesOmitted": max(0, len(planar_facets) - len(reported)),
        # Facets of curved regions — bore quads and the like. Not listed as faces on
        # purpose; they are described by `cylinders` / `curvedSurfaces`.
        "curvedSegmentFacets": segments_not_listed,
        "cylinders": cylinders,
        "curvedSurfaces": curved,
        "faceCount": len(reported),
        "holeCount": holes_total,
        "cylinderCount": len(cylinders),
        "warnings": warnings,
    }


def op_measure_section(params: dict) -> dict:
    """A cross-section as DATA, not only as a picture.

    Why this exists: "pick two points on the cut plane" is the natural way to ask a
    question about a section, but on a mesh the cut plane has no surface to pick —
    the plane is an interpretation of the geometry, not part of it. So the section
    is returned as structure the caller can read directly: each polygon's outer ring
    with its segment lengths and angles, each hole in it with a centre, a diameter
    and the wall thickness to the outside, and the spacing between holes. After
    that, measuring in a section needs no aim at all — the numbers are in the reply.

    Method, and why each piece is where it is:

    * the cut comes from `trimesh.intersections.mesh_plane` (exact, numpy only);
    * the segments are polygonised with **shapely**, whose `polygonize` returns
      rings WITH their interiors — the holes. Hand-chaining the segments works until
      a section degenerates (a tangent plane, a hole touching an edge, coincident
      loops), which is exactly when the number is being relied on;
    * wall and web thicknesses are shapely ring-to-ring distances (exact segment to
      segment), not centre-to-centre approximations;
    * the inner loops are classified round vs non-circular by the SAME two tests as
      `list_features` (fit residual AND area ratio) because a rectangle's corners are
      concyclic and a residual alone calls a slot a circle.
    """
    import numpy as np
    import shapely
    import trimesh
    from itertools import product
    from shapely.geometry import LineString
    from shapely.ops import polygonize, unary_union

    mesh = _load(params["path"])
    normal = _axis_vector(params.get("axis", "z"))
    u, v = _plane_basis(normal)

    bounds = np.asarray(mesh.bounds, dtype=float)
    corners = np.array([[bounds[bit][axis] for axis, bit in enumerate(bits)] for bits in product((0, 1), repeat=3)])
    projections = corners @ normal
    low, high = float(projections.min()), float(projections.max())
    if params.get("atMm") is not None:
        at = float(params["atMm"])
    else:
        fraction = float(params.get("fraction", 0.5))
        if not 0.0 <= fraction <= 1.0:
            raise ValueError("fraction must be within 0..1")
        at = low + (high - low) * fraction
    origin = normal * at

    tolerance = float(params.get("simplifyToleranceMm", 0.01))
    max_polygons = int(params.get("maxPolygons", 12))
    max_holes = int(params.get("maxHolesPerPolygon", 24))
    max_ring_points = int(params.get("maxRingPoints", 128))
    max_neighbours = int(params.get("maxHoleNeighbours", 3))

    base = {
        "axisMm": [_round3(float(x)) for x in normal],
        "atMm": _round3(at),
        "originMm": [_round3(float(x)) for x in origin],
        "uAxisMm": [_round3(float(x)) for x in u],
        "vAxisMm": [_round3(float(x)) for x in v],
        "planeRangeMm": [_round3(low), _round3(high)],
        "thresholds": {
            "simplifyToleranceMm": tolerance,
            "maxPolygons": max_polygons,
            "maxHolesPerPolygon": max_holes,
            "maxRingPoints": max_ring_points,
        },
    }

    warnings: list[str] = []
    segments = trimesh.intersections.mesh_plane(mesh, normal, origin)
    if len(segments) == 0:
        warnings.append(
            f"the plane at {_round3(at)}mm along {base['axisMm']} does not cut this solid "
            f"(its extent along that axis is {_round3(low)}..{_round3(high)}mm) — no section exists"
        )
        return {**base, "empty": True, "polygons": [], "holeSpacing": [], "areaMm2": 0.0,
                "perimeterMm": 0.0, "bboxUvMm": [[0, 0], [0, 0]], "polygonsOmitted": 0,
                "voidRegions": 0, "holeCount": 0, "warnings": warnings}

    flat = np.asarray(segments, dtype=float).reshape(-1, 3) - origin
    uv_segments = np.column_stack([flat @ u, flat @ v]).reshape(-1, 2, 2)
    # Snap to a 1µm grid before polygonising. MEASURED, not prophylactic: one surface
    # point reached from two triangles that share an edge is computed in two different
    # orders, so the two endpoints differ in the last bits; GEOS then sees open
    # linework and `polygonize` returns NOTHING for a section that plainly has rings
    # (a $fn=64 tube cut at mid-height returned 0 polygons from 256 segments until
    # this line existed). A micrometre is three orders below the 0.001mm this tool
    # reports and far below the 0.01mm simplify tolerance.
    uv_segments = np.round(uv_segments, 6)
    merged = unary_union([LineString(segment) for segment in uv_segments])

    # `polygonize` cannot know which side of a closed ring is material: the void
    # inside a slot comes back as its own polygon next to the material around it. So
    # every candidate is classified by asking the SOLID, at a point guaranteed to lie
    # inside that polygon — `representative_point`, not `centroid`, because the
    # centroid of an annulus sits in its bore and would reject the material.
    def is_material(candidate) -> bool:
        point = np.asarray(candidate.representative_point().coords, dtype=float)[0]
        world = origin + u * point[0] + v * point[1]
        return bool(mesh.contains(world.reshape(1, 3))[0])

    candidates = sorted(polygonize(merged), key=lambda item: -item.area)
    polygons = [candidate for candidate in candidates if is_material(candidate)]
    void_regions = len(candidates) - len(polygons)

    hole_records = []
    reported = []
    hole_serial = 0
    for index, polygon in enumerate(polygons[:max_polygons]):
        outer = np.asarray(polygon.exterior.coords, dtype=float)[:-1]
        ring = outer[_simplify_closed(outer, tolerance)]
        subsampled = False
        if len(ring) > max_ring_points:
            step = int(math.ceil(len(ring) / max_ring_points))
            ring = ring[::step]
            subsampled = True
        lengths, angles = [], []
        for position in range(len(ring)):
            start, end = ring[position], ring[(position + 1) % len(ring)]
            delta = end - start
            lengths.append(_round3(float(np.linalg.norm(delta))))
            angles.append(_round3(float(np.degrees(math.atan2(delta[1], delta[0]))) % 180.0))

        holes = []
        interiors = sorted(polygon.interiors, key=lambda item: -abs(item.length))[:max_holes]
        for interior in interiors:
            hole_serial += 1
            ring_uv = np.asarray(interior.coords, dtype=float)[:-1]
            cx, cy, radius, residual = _fit_circle(ring_uv)
            area = abs(_signed_area(ring_uv))
            circle_area = math.pi * radius * radius
            ratio = area / circle_area if circle_area > 0 else 0.0
            round_enough = residual <= max(0.05, 0.02 * radius) and ratio >= 0.95
            centre_uv = np.array([cx, cy])
            centre_world = origin + u * cx + v * cy
            entry = {
                "id": f"s{index + 1}.h{hole_serial}",
                "centerUv": [_round3(float(cx)), _round3(float(cy))],
                "centerWorldMm": [_round3(float(x)) for x in centre_world],
                "areaMm2": _round3(area),
                "kind": "round" if round_enough else "non-circular",
                "circularityResidualMm": _round3(residual),
                "areaRatioToCircle": _round3(ratio),
                "vertices": len(ring_uv),
                # Exact segment-to-segment distance to the polygon's outer ring: the
                # thinnest material between this hole and the outside.
                "wallToOuterMm": _round3(float(interior.distance(polygon.exterior))),
            }
            if round_enough:
                entry["diameterMm"] = _round3(2 * radius)
                # A section ring can carry the MIDPOINTS of a triangle diagonal:
                # OpenSCAD splits every cylinder quad into two triangles and the cut
                # crosses the diagonal, so half the ring sits at r·cos(θ/2) — 0.002mm
                # inside the surface for $fn=64. A least-squares fit therefore reports
                # a tessellated bore slightly SMALL, so the circumscribed diameter is
                # reported beside it; for a tessellated bore that is the nominal one.
                entry["enclosingDiameterMm"] = _round3(2 * float(shapely.minimum_bounding_radius(interior)))
            else:
                points = ring_uv[_simplify_closed(ring_uv, tolerance)]
                entry["pointsUv"] = [[_round3(float(a)), _round3(float(b))] for a, b in points[:max_ring_points]]
            holes.append(entry)
            hole_records.append({"id": entry["id"], "center": centre_uv, "ring": interior})

        reported.append(
            {
                "id": f"s{index + 1}",
                "areaMm2": _round3(float(polygon.area)),
                "perimeterMm": _round3(float(polygon.exterior.length)),
                "holeCount": len(holes),
                "outer": {
                    "pointsUv": [[_round3(float(a)), _round3(float(b))] for a, b in ring],
                    "pointsWorldMm": [
                        [_round3(float(x)) for x in (origin + u * a + v * b)] for a, b in ring
                    ],
                    "segmentsMm": lengths,
                    "anglesDeg": angles,
                    "closed": True,
                    "pointsSubsampled": subsampled,
                },
                "holes": holes,
            }
        )

    spacing = []
    seen = set()
    for record in hole_records:
        nearest = sorted(
            (other for other in hole_records if other["id"] != record["id"]),
            key=lambda other: float(np.linalg.norm(other["center"] - record["center"])),
        )[:max_neighbours]
        for other in nearest:
            pair = tuple(sorted((record["id"], other["id"])))
            if pair in seen:
                continue
            seen.add(pair)
            spacing.append(
                {
                    "from": pair[0],
                    "to": pair[1],
                    "centerDistanceMm": _round3(float(np.linalg.norm(other["center"] - record["center"]))),
                    # Ring-to-ring: the material left between the two holes (0 when
                    # they break into each other).
                    "clearanceMm": _round3(float(record["ring"].distance(other["ring"]))),
                }
            )

    all_uv = uv_segments.reshape(-1, 2)
    return {
        **base,
        "empty": False,
        "polygons": reported,
        "polygonsOmitted": max(0, len(polygons) - len(reported)),
        # Enclosed rings that are NOT material — the void a through-hole or a slot
        # punches through the section. Reported as a count so the arithmetic of the
        # cut is legible (material polygons + voids = rings found).
        "voidRegions": void_regions,
        "holeSpacing": spacing,
        "areaMm2": _round3(float(sum(polygon.area for polygon in polygons))),
        "perimeterMm": _round3(float(sum(polygon.exterior.length for polygon in polygons))),
        "bboxUvMm": [
            [_round3(float(all_uv[:, 0].min())), _round3(float(all_uv[:, 1].min()))],
            [_round3(float(all_uv[:, 0].max())), _round3(float(all_uv[:, 1].max()))],
        ],
        "holeCount": len(hole_records),
        "warnings": warnings,
    }


def op_measure_extent(params: dict) -> dict:
    """How far the solid reaches along ANY axis, and the two points that decide it.

    `measure_part` answers this for x/y/z only, and hands back a size with no
    coordinates — so a caller who needs "how long is this along its own diagonal" or
    "which vertex is the top of this" has nothing to name. This reports the axial
    min/max/centre plus the extremal VERTICES, which are exactly the coordinates a
    later `measure_distance` needs.

    Per-feature extents do NOT live here: `list_features` already reports a
    cylinder's `lengthMm` and a hole's `depthMm`, from the feature itself rather than
    from a second measurement that could disagree with it.
    """
    import numpy as np

    mesh = _load(params["path"])
    axis = _axis_vector(params.get("axis", "z"))

    points = np.asarray(mesh.vertices, dtype=float)
    if points.size == 0:
        raise ValueError("the mesh has no vertices to measure")

    projections = points @ axis
    low_index = int(np.argmin(projections))
    high_index = int(np.argmax(projections))
    low, high = float(projections[low_index]), float(projections[high_index])

    warnings: list[str] = []
    if not _mesh_watertight(mesh):
        warnings.append(
            "the mesh is NOT watertight — its extent is still readable (it is the vertex envelope), "
            "but no volume or fit conclusion should be drawn from this part"
        )
    tied_low = int(np.sum(np.isclose(projections, low, atol=1e-9)))
    tied_high = int(np.sum(np.isclose(projections, high, atol=1e-9)))
    if tied_low > 1 or tied_high > 1:
        warnings.append(
            f"the extreme along this axis is not unique ({tied_low} vertices at the low end, "
            f"{tied_high} at the high end) — the reported point is one of them"
        )

    return {
        "axisMm": [_round3(float(x)) for x in axis],
        "source": "whole-part",
        "vertexCount": int(len(points)),
        "minMm": _round3(low),
        "maxMm": _round3(high),
        "sizeMm": _round3(high - low),
        "centerMm": _round3((low + high) / 2),
        "minPointMm": [_round3(float(x)) for x in points[low_index]],
        "maxPointMm": [_round3(float(x)) for x in points[high_index]],
        "asAxisAlignedMm": {
            "min": [_round3(float(x)) for x in np.asarray(mesh.bounds, dtype=float)[0]],
            "max": [_round3(float(x)) for x in np.asarray(mesh.bounds, dtype=float)[1]],
        },
        "warnings": warnings,
    }


def _axis_line_metrics(p1, d1, p2, d2) -> dict:
    """Angle and distance between two INFINITE lines, in ONE implementation.

    This is the arithmetic that `check_assembly`'s `coaxial` operator has been doing
    in TypeScript (`axisLineDistance` in src/host/assembly-check.ts): for parallel
    axes the perpendicular offset, for skew axes the closest approach, plus the angle
    between them so a tilted bore cannot hide behind a small offset. It lives here
    now because the new `measure_angle` needs the same numbers, and two copies of an
    angle would eventually disagree — the TS function stays as the parity ORACLE.

    Reported so that no caller has to guess a convention:
      `distanceMm`    line-to-line distance (parallel: perpendicular offset)
      `angleDeg`      the angle between the direction vectors AS GIVEN, 0..180
      `acuteDeg`      min(angle, 180−angle), 0..90 — what "the angle between two
                      lines" usually means, and what the TS oracle reports
      `supplementDeg` 180 − angleDeg
    """
    import numpy as np

    u1 = np.asarray(d1, dtype=float)
    u2 = np.asarray(d2, dtype=float)
    n1 = float(np.linalg.norm(u1))
    n2 = float(np.linalg.norm(u2))
    if n1 <= 0 or n2 <= 0:
        raise ValueError("a direction vector must be non-zero")
    u1, u2 = u1 / n1, u2 / n2
    a1 = np.asarray(p1, dtype=float)
    a2 = np.asarray(p2, dtype=float)
    w = a2 - a1

    dot = float(u1 @ u2)
    a = float(u1 @ u1)
    b = dot
    c = float(u2 @ u2)
    d = float(u1 @ w)
    e = float(u2 @ w)
    denom = a * c - b * b

    if abs(denom) < 1e-9:
        # Parallel (or antiparallel): the perpendicular component of w. The closest
        # PAIR is not unique for parallel lines, so this reports the pair found by
        # dropping a perpendicular from a2: (a2 - perp) on line 1, a2 on line 2.
        perp = w - u1 * d
        distance = float(np.linalg.norm(perp))
        close_a = a2 - perp
        close_b = a2
    else:
        # SIGN CONVENTION, and it is easy to get wrong: the s,t that solve this system
        # come out NEGATED relative to the parameters of the true closest pair, so the
        # closest points are `a1 - sc*u1` / `a2 - tc*u2`, and the separating vector is
        # `w + sc*u1 - tc*u2` — which is exactly the expression the TS oracle uses.
        # Measured the hard way: writing `w + tc*u2 - sc*u1` (my first port) reported
        # 58.085mm instead of 4.7245mm on a skew pair, i.e. it measured the FARTHEST
        # pair. Symmetric test fixtures hide this; a parity run over skew lines does not.
        sc = (b * e - c * d) / denom
        tc = (a * e - b * d) / denom
        close_a = a1 - u1 * sc
        close_b = a2 - u2 * tc
        distance = float(np.linalg.norm(close_b - close_a))

    angle = float(np.degrees(np.arccos(max(-1.0, min(1.0, dot)))))
    acute = min(angle, 180.0 - angle)
    return {
        "distanceMm": distance,
        "angleDeg": angle,
        "acuteDeg": acute,
        "supplementDeg": 180.0 - angle,
        "closeA": close_a,
        "closeB": close_b,
        "intersection": (close_a + close_b) / 2 if distance <= 1e-6 else None,
    }


def op_measure_angle(params: dict) -> dict:
    """The angle between two things, with every convention written down.

    Three ways to name a direction, because there are three ways a caller knows one:
      * `aDir` / `bDir`  — an exact vector (a datum axis the caller read out, a
        face normal from `list_features`, a direction it computed itself);
      * `aProbe` / `bProbe` — a POINT; the direction becomes the normal of the face
        nearest that point. This is the tolerant form: any point whose nearest face
        is the one you meant works, which is what makes "the angle between this face
        and that face" answerable without naming a feature;
      * `aPoints` / `bPoints` — two points per side, so the direction is the segment
        between them (three points total when one side is `[apex, other]`, which is
        how a corner is usually described).

    The output states `angleDeg` (as given), `acuteDeg` (0..90, the usual reading of
    "the angle between two lines") and `supplementDeg`, plus the line-to-line
    distance and the common normal. That redundancy is the point: "30°" and "150°"
    describe the same pair of lines, and a tool that reports only one of them
    produces the "your number does not match mine" round trip.
    """
    import numpy as np

    meshes = params.get("meshes") or [None, None]
    warnings: list[str] = []

    def side(label: str, index: int) -> dict:
        direction = params.get(f"{label}Dir")
        probe = params.get(f"{label}Probe")
        pair = params.get(f"{label}Points")
        origin = params.get(f"{label}Origin")
        if pair is not None:
            points = np.asarray(pair, dtype=float)
            if points.shape != (2, 3):
                raise ValueError(f"{label}Points needs exactly two [x,y,z] points")
            vector = points[1] - points[0]
            base = points[0] if origin is None else np.asarray(origin, dtype=float)
            return {"dir": vector, "origin": base, "source": f"{label}Points", "anchored": False}
        if direction is not None:
            vector = np.asarray(direction, dtype=float)
            if vector.size != 3:
                raise ValueError(f"{label}Dir needs three components")
            # No origin given: the line is anchored at the origin. That is a real
            # choice, and it is flagged — otherwise two direction-only sides always
            # "intersect" at (0,0,0) and `coplanar`/`lineDistanceMm` describe the
            # anchor rather than the part.
            anchored = origin is None
            base = np.asarray(origin, dtype=float) if origin is not None else np.zeros(3)
            return {"dir": vector, "origin": base, "source": f"{label}Dir", "anchored": anchored}
        if probe is not None:
            path = meshes[index] if index < len(meshes) else None
            if not path:
                raise ValueError(f"{label}Probe needs a mesh for that side (meshes[{index}])")
            mesh = _load(path)
            point = np.asarray(probe, dtype=float)
            snap = _snap_to_surface(mesh, point)
            # The normal of the face the probe LANDED on, from the snap itself.
            normal = np.asarray(snap["normal"], dtype=float)
            if not _mesh_watertight(mesh):
                warnings.append(
                    f"{label}: the mesh is NOT watertight — a face normal taken from an open mesh "
                    "may belong to a surface that is not a boundary of any solid"
                )
            return {
                "dir": normal,
                "origin": np.asarray(snap["snapped"], dtype=float),
                "source": f"{label}Probe (nearest face normal, snap distance {_round3(float(snap['distance']))}mm)",
                "anchored": False,
            }
        raise ValueError(
            f"{label} needs a direction: {label}Dir [[x,y,z]], {label}Probe [x,y,z] (nearest face) "
            f"or {label}Points [[x,y,z],[x,y,z]]"
        )

    first = side("a", 0)
    second = side("b", 1)
    metrics = _axis_line_metrics(first["origin"], first["dir"], second["origin"], second["dir"])

    anchored_at_origin = bool(first["anchored"] and second["anchored"])
    if first["anchored"] or second["anchored"]:
        warnings.append(
            "one side gave a direction with NO point on it, so that line is anchored at the ORIGIN. "
            "lineDistanceMm / coplanar / crossingPointMm therefore describe that anchor: pass "
            f"{'aOrigin' if first['anchored'] else ''}{' and ' if first['anchored'] and second['anchored'] else ''}"
            f"{'bOrigin' if second['anchored'] else ''} (a point on the line) for a distance that means something."
        )
    parallel_tolerance = float(params.get("parallelToleranceDeg", 0.5))
    parallel = metrics["acuteDeg"] <= parallel_tolerance
    perpendicular = abs(metrics["acuteDeg"] - 90.0) <= parallel_tolerance
    coplanar = metrics["distanceMm"] <= 1e-6 or parallel
    if parallel and metrics["distanceMm"] <= 1e-6:
        warnings.append(
            "the two directions are parallel AND their lines coincide — the angle is 0° but the "
            "lines are the same line, so a distance between them is not defined by this report"
        )

    return {
        "aDirMm": [_round3(float(x)) for x in (np.asarray(first["dir"], dtype=float) / float(np.linalg.norm(first["dir"])))],
        "bDirMm": [_round3(float(x)) for x in (np.asarray(second["dir"], dtype=float) / float(np.linalg.norm(second["dir"])))],
        "aOriginMm": [_round3(float(x)) for x in first["origin"]],
        "bOriginMm": [_round3(float(x)) for x in second["origin"]],
        "aSource": first["source"],
        "bSource": second["source"],
        "anchoredAtOrigin": anchored_at_origin,
        "angleDeg": _round3(metrics["angleDeg"]),
        "acuteDeg": _round3(metrics["acuteDeg"]),
        "supplementDeg": _round3(metrics["supplementDeg"]),
        "parallel": bool(parallel),
        "perpendicular": bool(perpendicular),
        "coplanar": bool(coplanar),
        "lineDistanceMm": _round3(metrics["distanceMm"]),
        "commonNormalMm": [
            _round3(float(x))
            for x in (
                (metrics["closeB"] - metrics["closeA"]) / float(np.linalg.norm(metrics["closeB"] - metrics["closeA"]))
                if metrics["distanceMm"] > 1e-9
                else np.cross(
                    np.asarray(first["dir"], dtype=float) / float(np.linalg.norm(first["dir"])),
                    np.asarray(second["dir"], dtype=float) / float(np.linalg.norm(second["dir"])),
                )
            )
        ],
        # Omitted rather than null when the lines are skew: there is no crossing, and a
        # null in a numeric field reads as "measured and unknown".
        **(
            {"crossingPointMm": [_round3(float(x)) for x in metrics["intersection"]]}
            if metrics["intersection"] is not None
            else {}
        ),
        "convention": "angleDeg is between the direction vectors as given (0..180); acuteDeg = min(angle, 180-angle) "
                      "is the usual 'angle between two lines'; supplementDeg = 180 - angleDeg. For two parallel axes "
                      "lineDistanceMm is the perpendicular offset, for skew axes the closest approach.",
        "warnings": warnings,
    }


def _round_js(value: float, digits: int = 3) -> float:
    """JS `Math.round(v * 10**d) / 10**d` — half away from zero TOWARD +∞, which is
    not Python's banker's rounding. The TS import path rounds this way, so the
    numbers it reported are the numbers that must come back."""
    factor = 10 ** digits
    rounded = math.floor(value * factor + 0.5) / factor
    return 0.0 if rounded == 0 else rounded


# ---------------------------------------------------------------------------
# The SCAD-side text protocol: the datum prelude and what OpenSCAD echoes back.
#
# WHY THIS IS THE DOMAIN RUNTIME'S BUSINESS. Datums are the harness's interface
# contract — a part declares an anchor, an assembly cites it. The WRITER (the
# prelude injected into every part) and the READER (the echo parser) therefore
# belong together, or a format change has two homes and one of them will lag.
# What stays in TypeScript is the OpenSCAD PROCESS (binary discovery, the bundled
# snapshot, xvfb, timeouts) and everything that touches images and the store.
# ---------------------------------------------------------------------------

DATUM_PRELUDE = """
// ---- harness datum anchors (do not remove) ----
// Signature: datum_axis(name, point, dir) — POINT FIRST. OpenSCAD positional
// arguments are silent: swapping p/dir compiles, but the reader (scad_parse_output)
// errors on a zero dir and warns when a dir dwarfs its own point (G2, 2026-10-29).
module datum(name, p = [0, 0, 0]) {
  echo(str("__DATUM__", name, "=", p[0], ",", p[1], ",", p[2]));
}
module datum_axis(name, p = [0, 0, 0], dir = [0, 0, 1]) {
  echo(str("__DATUM_AXIS__", name, "=", p[0], ",", p[1], ",", p[2], "|", dir[0], ",", dir[1], ",", dir[2]));
}
module datum_plane(name, p = [0, 0, 0], n = [0, 0, 1]) {
  echo(str("__DATUM_PLANE__", name, "=", p[0], ",", p[1], ",", p[2], "|", n[0], ",", n[1], ",", n[2]));
}
module datum_cyl(name, p = [0, 0, 0], dir = [0, 0, 1], r = 0) {
  echo(str("__DATUM_CYL__", name, "=", p[0], ",", p[1], ",", p[2], "|", dir[0], ",", dir[1], ",", dir[2], "|", r));
}
"""

_NUMBER = r"(-?[\d.eE+-]+)"
_DATUM_POINT = re.compile(r'ECHO:\s*"__DATUM__([^"=]+)=' + ",".join([_NUMBER] * 3) + '"')
_DATUM_AXIS = re.compile(r'ECHO:\s*"__DATUM_AXIS__([^"=]+)=' + ",".join([_NUMBER] * 3) + r"\|" + ",".join([_NUMBER] * 3) + '"')
_DATUM_PLANE = re.compile(r'ECHO:\s*"__DATUM_PLANE__([^"=]+)=' + ",".join([_NUMBER] * 3) + r"\|" + ",".join([_NUMBER] * 3) + '"')
_DATUM_CYL = re.compile(
    r'ECHO:\s*"__DATUM_CYL__([^"=]+)=' + ",".join([_NUMBER] * 3) + r"\|" + ",".join([_NUMBER] * 3) + r"\|" + _NUMBER + '"'
)
_PARAM_LINE = re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*//\s*PARAMS\s*(.*)$")


def op_scad_prelude(_params: dict) -> dict:
    return {"source": DATUM_PRELUDE}


def op_scad_parse_output(params: dict) -> dict:
    """What one OpenSCAD run said: errors, warnings and the datum anchors it echoed.

    The error/warning rule is the TS `parseMessages`: `ERROR:` / `WARNING:` lines are
    unwrapped, and `Trace:`/`In file` lines count as errors because that is where the
    useful part of an OpenSCAD failure lives.
    """
    raw = params["raw"]
    errors = []
    warnings = []
    for line in raw.split("\n"):
        text = line.strip()
        if text.startswith("ERROR:"):
            errors.append(text[6:].strip())
        elif text.startswith("WARNING:"):
            warnings.append(text[8:].strip())
        elif text.startswith("Trace:") or text.startswith("In file"):
            errors.append(text)

    points = []
    axes = []
    planes = []
    cylinders = []
    for line in raw.split("\n"):
        match = _DATUM_POINT.search(line)
        if match:
            points.append({"name": match.group(1).strip(), "point": [float(match.group(i)) for i in (2, 3, 4)]})
        match = _DATUM_AXIS.search(line)
        if match:
            axes.append(
                {
                    "name": match.group(1).strip(),
                    "point": [float(match.group(i)) for i in (2, 3, 4)],
                    "dir": [float(match.group(i)) for i in (5, 6, 7)],
                }
            )
        match = _DATUM_PLANE.search(line)
        if match:
            planes.append(
                {
                    "name": match.group(1).strip(),
                    "point": [float(match.group(i)) for i in (2, 3, 4)],
                    "normal": [float(match.group(i)) for i in (5, 6, 7)],
                }
            )
        match = _DATUM_CYL.search(line)
        if match:
            cylinders.append(
                {
                    "name": match.group(1).strip(),
                    "point": [float(match.group(i)) for i in (2, 3, 4)],
                    "dir": [float(match.group(i)) for i in (5, 6, 7)],
                    "radius": float(match.group(8)),
                }
            )

    # --- G2 (2026-10-29): the positional p/dir swap is silent in OpenSCAD ------
    # `datum_axis("rail", [0, 0, 1], [10, 0, 205])` compiles, echoes, and the
    # swapped numbers land in datums.json where `coaxial` reads them without
    # complaint (roberval-balance 2026-10-28: v048 bottom_axis was
    # point=[0,1,0] dir=[0,0,140]; four parts needed set_datums repair). Two
    # checks here, at the single READER half of the echo protocol:
    #   * a zero direction is ALWAYS wrong — an axis with no direction can never
    #     be an assembly endpoint — so it is a compile ERROR;
    #   * a direction that dwarfs its OWN point is the swap signature (the swap
    #     puts the short true dir into `point` and the long position into `dir`)
    #     — that is a WARNING. Model scale cannot disambiguate: v048's swapped
    #     dir [0,0,140] is indistinguishable from a legit endpoint-form dir in a
    #     205 mm model, and a missed swap (silent datums corruption) costs more
    #     than a spurious warning, so the warning is allowed to over-trigger.
    def _mag3(v):
        return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])

    for kind, group, vec_key in (("axis", axes, "dir"), ("plane", planes, "normal"), ("cylinder", cylinders, "dir")):
        for d in group:
            dname = d["name"]
            vec = d[vec_key]
            mag = _mag3(vec)
            pt_mag = _mag3(d["point"])
            if mag == 0.0:
                errors.append(
                    'datum_' + kind + ' "' + dname + '": direction is [0, 0, 0] — an axis with no direction '
                    "can never be an assembly endpoint. Signature: datum_" + kind + "(name, [x,y,z], [dx,dy,dz]); "
                    "pass a non-zero direction (named arguments recommended: datum_axis(name=, p=, dir=))."
                )
            elif mag > 4.0 * pt_mag + 10.0:
                warnings.append(
                    'datum_' + kind + ' "' + dname + '": |dir|=' + format(mag, ".6g") + " dwarfs its point (|p|="
                    + format(pt_mag, ".6g") + ") and the datum scale — this looks like swapped p/dir arguments "
                    "(signature: datum_" + kind + "(name, point, dir), the direction is a short vector). "
                    "If the magnitude is intentional (endpoint form), ignore this warning."
                )
    return {
        "errors": errors,
        "warnings": warnings,
        "datumSet": {"points": points, "axes": axes, "planes": planes, "cylinders": cylinders},
    }


def op_scad_parse_params(params: dict) -> dict:
    """The `// PARAMS <description>` convention: a top-level numeric assignment that
    the Customizer can turn, e.g. `wall = 3; // PARAMS 壁厚`."""
    found = []
    for line in params["scad"].split("\n"):
        match = _PARAM_LINE.match(line)
        if match:
            found.append({"name": match.group(1), "value": float(match.group(2)), "desc": (match.group(3) or "").strip()})
    return {"params": found}


# ---------------------------------------------------------------------------
# Rigid-body simulation (Q2=A: the physics canonical moved here).
#
# This mirrors `runPhysics` in src/host/physics.ts step for step. The probe
# (experiments/20261008_python_rapier_probe.md) established what to expect from the
# engine-version difference:
#   * joint/constraint-dominated quantities agree to ~0.01–0.05 mm,
#   * free flight and light contact to ~1 mm,
#   * contact-dominated trajectories diverge by millimetres to tens of millimetres.
# So this reproduces the ALGORITHM exactly; the thresholds that judge its output
# are the caller's business (and were re-baselined per that report).
#
# Units are millimetres and seconds throughout (gravity -9810 mm/s², densities
# ~1e-6 kg/mm³), which is why nothing here converts anything.
# ---------------------------------------------------------------------------


def _quat_to_matrix3(q) -> list:
    x, y, z, w = (float(v) for v in q)
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def _up_tilt_degrees(q) -> float:
    """Angle between world up and the body's local +Z, in degrees (z-up world)."""
    matrix = _quat_to_matrix3(q)
    uz = max(-1.0, min(1.0, matrix[2][2]))
    return math.acos(uz) * 180 / math.pi


def _euler_to_quat(deg) -> tuple:
    """Euler XYZ degrees → quaternion (x, y, z, w), same composition as TS."""
    rx, ry, rz = (float(d) * math.pi / 180 for d in deg)
    cx, sx = math.cos(rx / 2), math.sin(rx / 2)
    cy, sy = math.cos(ry / 2), math.sin(ry / 2)
    cz, sz = math.cos(rz / 2), math.sin(rz / 2)
    return (
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    )


def _scaled_axis_of_euler(deg) -> tuple:
    """A rapier body rotation, from Euler XYZ degrees.

    TRAP, found the hard way: in this binding `RigidBodyBuilder.rotation(v)` takes a
    SCALED-AXIS vector (axis × angle) in 3D — NOT a quaternion, and not three Euler
    angles. Passing a quaternion raises "expected sequence of 3 floats, got length 4",
    which is how this was discovered. `Rotation3.scaled_axis` bridges the two exactly
    (verified by round-trip on identity, a 90° Y rotation and a compound rotation).
    """
    import rapier3d as R

    qx, qy, qz, qw = _euler_to_quat(deg)
    return tuple(R.Rotation3.from_quaternion(qw, qx, qy, qz).scaled_axis)


def _is_convex(path: str) -> bool:
    """True when the mesh encloses the same volume as its convex hull (±1%) — the
    TS `isConvexStl`. A non-manifold input counts as NOT convex (trimesh path)."""
    from manifold3d import Manifold, Mesh

    try:
        vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(path))
        mesh = Mesh(vertices, faces)
        mesh.merge()
        solid = Manifold(mesh)
        hull = solid.hull()
        volume = float(solid.volume())
        if hull.is_empty() or volume <= 0:
            return False
        return abs(float(hull.volume()) - volume) / volume < 0.01
    except BaseException:  # noqa: BLE001 - mirror the TS catch-all
        return False


# ---------------------------------------------------------------------------
# Mechanism motion (M3.6): kinematics under a drive, verified by an exact
# interference timeline.
#
# Mirrors `runMotion` in src/host/motion.ts. rapier is used purely as a CONSTRAINT
# solver here — no colliders, no gravity — and spatial overlap is measured exactly
# by Manifold booleans at each sampled pose. So the Python port has two engines to
# satisfy: the joint solver (which the probe showed agrees to ~0.05 mm on
# constraint quantities) and the same Manifold build the rest of this file uses.
# ---------------------------------------------------------------------------


def _norm3(vector) -> list:
    length = math.hypot(float(vector[0]), float(vector[1]), float(vector[2])) or 1.0
    return [float(vector[0]) / length, float(vector[1]) / length, float(vector[2]) / length]


def _aabb_overlap(a, b) -> bool:
    (a_min, a_max), (b_min, b_max) = a, b
    return bool(
        a_min[0] <= b_max[0] and a_max[0] >= b_min[0]
        and a_min[1] <= b_max[1] and a_max[1] >= b_min[1]
        and a_min[2] <= b_max[2] and a_max[2] >= b_min[2]
    )


def _period_from_samples(values, sample_dt):
    """Period from successive maxima of a sampled signal — the TS `periodFromSamples`.
    Returns None when the signal has fewer than two usable peaks."""
    maxima = []
    for i, value in enumerate(values):
        left = values[i - 1] if i > 0 else float("-inf")
        right = values[i + 1] if i < len(values) - 1 else float("-inf")
        if value > left and value >= right:
            if not maxima or i - maxima[-1] > 3:
                maxima.append(i)
    if len(maxima) < 2:
        return None
    gaps = [maxima[k] - maxima[k - 1] for k in range(1, len(maxima))]
    return (sum(gaps) / len(gaps)) * sample_dt


def _welded_mesh(path: str):
    """`weldedOf`: parse → weld (1e-5 keys, first-encounter order) → Manifold merge."""
    import numpy as np
    from manifold3d import Mesh

    vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(path))
    mesh = Mesh(vertices, faces)
    mesh.merge()
    return np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3], np.asarray(mesh.tri_verts, dtype=np.int64)


def _transform_points(vertices, matrix, translation):
    import numpy as np

    source = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    return source @ np.asarray(matrix, dtype=np.float64).T + np.asarray(translation, dtype=np.float64)


def _js_round(value: float) -> int:
    """`Math.round` (ties toward +∞), which is NOT Python's banker's rounding."""
    return int(math.floor(value + 0.5))


def _js_to_fixed(value: float, digits: int) -> str:
    """`Number.prototype.toFixed`: the closest decimal, ties picking the LARGER
    value. Python's f-string uses banker's rounding, so 0.125 would print "0.12"
    where JS prints "0.13" — and these strings end up in the tool's findings.

    `Decimal(float)` is the exact binary value, which is what the spec operates on.
    """
    from decimal import Decimal, ROUND_HALF_UP

    quantum = Decimal(1).scaleb(-digits)
    rounded = Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP)
    return f"{rounded:.{digits}f}"


# ---------------------------------------------------------------------------
# MLS-MPM fluid kernel (M4) — the port of src/host/mpm.ts.
#
# WHY THIS IS THE DOMAIN RUNTIME'S JOB: it is arithmetic on arrays, all of it —
# P2G scatter, the weakly-compressible EOS, the grid update with boundary
# conditions, G2P with affine momentum transfer, advection and the outlet rules.
# Nothing here talks to a host service.
#
# The measured cost of doing it in Python is REAL and known: 2.5–4× slower than the
# TS kernel (the user accepted that on 2026-10-08 and asked for the tools to be
# marked as candidates for a later Rust/C kernel — the native ceiling measured
# 3.7–4.6× FASTER than TS, so that is where the performance work belongs).
#
# The state lives HERE, keyed by id, not in the IPC payload: pos/vel/C are
# 28 bytes per particle, which is 15 MB for the 564k-particle acceptance case —
# far past the "big payloads go by file" line. The caller sends a seed once and
# asks for statistics afterwards.
# ---------------------------------------------------------------------------

_MpmWorlds: dict = {}
_MpmNextId: int = 0


def _ipc_uint8(value):
    """A Uint8Array that crossed the JSON-lines pipe arrives as {"0":1,"1":0,...}.

    JSON has no typed arrays, so the worker has to put it back. (This cost a
    debugging round: a mask that silently became a dict made `np.asarray` raise, and
    an earlier version that swallowed it left the fluid run with NO wall boundary
    conditions — the whole flow field differed at high particle density.)
    """
    import numpy as np

    if isinstance(value, dict):
        ordered = [value[key] for key in sorted(value, key=lambda k: int(k))]
        return np.asarray(ordered, dtype=np.uint8)
    return np.asarray(value, dtype=np.uint8)


def _mpm_drop(world_id: str) -> None:
    _MpmWorlds.pop(world_id, None)


def op_mpm_create(params: dict) -> dict:
    """Create a world and seed particles. `seeds` are positions in cells."""
    import numpy as np

    global _MpmNextId

    config = params["config"]
    seeds = np.asarray(params["seeds"], dtype=np.float64).reshape(-1, 3)
    count = int(config.get("particleCount") or len(seeds))
    cells = [int(v) for v in config["cells"]]
    index = np.arange(count, dtype=np.float64)

    # Same jitter as the TS `jitter(i)`: a deterministic sine hash, no RNG.
    def jitter(offset: int) -> np.ndarray:
        s = np.sin((index + offset) * 12.9898) * 43758.5453
        return (s - np.floor(s) - 0.5) * 0.04

    positions = np.zeros((count, 3), dtype=np.float64)
    source = seeds[np.arange(count) % len(seeds)] if len(seeds) else np.zeros((count, 3))
    limits = np.array([cells[0] - 1.5, cells[1] - 1.5, cells[2] - 1.5])
    for axis in range(3):
        # The TS version clamps, then adds jitter for axis-specific offsets.
        positions[:, axis] = np.clip(source[:, axis], 1.5, limits[axis])
    positions[:, 0] += jitter(0)
    positions[:, 1] += jitter(7_000_000)
    positions[:, 2] += jitter(14_000_000)

    world_id = f"mpm{_MpmNextId}"
    _MpmNextId += 1
    world = {
        "config": config,
        "cells": cells,
        "n": count,
        "pos": positions.astype(np.float32),
        "vel": np.zeros((count, 3), dtype=np.float32),
        "C": np.zeros((count, 3, 3), dtype=np.float32),
        "transits": 0,
        "escaped": 0,
        "activeN": count,
        "nonFinite": 0,
        "restDensity": float(config["restDensity"]) if config.get("restDensity") is not None else 0.0,
        "lastStep": {"maxSpeed": 0.0, "clampedFraction": 0.0},
        "inletCounters": {"band": 0, "floored": 0, "injected": 0.0},
        "solidMask": None,
        "solidNormal": None,
    }
    if config.get("solidMask") is not None:
        world["solidMask"] = _ipc_uint8(config["solidMask"]).astype(bool)
    if config.get("solidNormal") is not None:
        world["solidNormal"] = _ipc_uint8(config["solidNormal"]).astype(np.int64)
    if config.get("restDensity") is None:
        world["restDensity"] = _mpm_calibrate(world)
    _MpmWorlds[world_id] = world
    return {
        "worldId": world_id,
        "particles": count,
        "restDensity": world["restDensity"],
        "activeN": world["activeN"],
    }


def _mpm_stencil(positions, cells):
    """The 27-cell quadratic B-spline stencil: per-axis base cell, fractions and the
    three weights. Mirrors the TS weight block exactly (0.5(0.5-f)², 0.75-f², 0.5(0.5+f)²)."""
    import numpy as np

    base = np.floor(positions).astype(np.int64) - 1
    frac = positions - np.floor(positions) - 0.5
    weights = np.stack(
        [0.5 * (0.5 - frac) ** 2, 0.75 - frac ** 2, 0.5 * (0.5 + frac) ** 2], axis=2
    )  # (n, 3 axes, 3 taps)
    return base, frac, weights


def _mpm_cell_index(base, offsets, cells):
    """Flat cell index for a stencil tap, matching the TS `(x*ny + y)*nz + z` order."""
    import numpy as np

    x = base[:, 0] + offsets[0]
    y = base[:, 1] + offsets[1]
    z = base[:, 2] + offsets[2]
    return (x * cells[1] + y) * cells[2] + z


def _mpm_calibrate(world) -> float:
    """Mass-only P2G pass; median density over occupied cells (first 8192 with m > 0.2)."""
    import numpy as np

    cells = world["cells"]
    total = cells[0] * cells[1] * cells[2]
    base, _frac, weights = _mpm_stencil(world["pos"][: world["activeN"]], cells)
    grid_mass = np.zeros(total, dtype=np.float64)
    for i in range(3):
        for j in range(3):
            for k in range(3):
                w = weights[:, 0, i] * weights[:, 1, j] * weights[:, 2, k]
                cell = _mpm_cell_index(base, (i, j, k), cells)
                grid_mass += np.bincount(cell, weights=w, minlength=total)
    occupied = grid_mass[grid_mass > 0.2]
    if occupied.size == 0:
        return 1.0
    samples = np.sort(occupied[:8192])
    return float(samples[samples.size // 2])


def _mpm_taps(base, pos, cells):
    """The 27-cell stencil as flat cell ids, weights and per-tap cell offsets.

    One quadratic B-spline per axis, same as the TS kernel:
    w = (0.5(0.5-f)², 0.75-f², 0.5(0.5+f)²) with f = frac - 0.5.
    """
    import numpy as np

    dx = [(base[:, 0] + i + 0.5) - pos[:, 0] for i in range(3)]
    dy = [(base[:, 1] + j + 0.5) - pos[:, 1] for j in range(3)]
    dz = [(base[:, 2] + k + 0.5) - pos[:, 2] for k in range(3)]
    # Per-axis weights are computed ONCE (three per axis), not once per 27 taps:
    # the naive version recomputed the same three arrays 9 times each.
    weights = [axis_weights(pos[:, axis]) for axis in range(3)]
    taps = []
    for i in range(3):
        for j in range(3):
            for k in range(3):
                cell = (base[:, 0] + i) * cells[1] * cells[2] + (base[:, 1] + j) * cells[2] + (base[:, 2] + k)
                taps.append(
                    {
                        "cell": cell,
                        "weight": weights[0][i] * weights[1][j] * weights[2][k],
                        "dist": np.stack([dx[i], dy[j], dz[k]], axis=1),
                    }
                )
    return taps


def axis_weights(coord):
    """The three quadratic B-spline weights along one axis (0.5(0.5-f)², 0.75-f², 0.5(0.5+f)²)."""
    import numpy as np

    frac = coord - np.floor(coord) - 0.5
    return (
        0.5 * (0.5 - frac) ** 2,
        0.75 - frac ** 2,
        0.5 * (0.5 + frac) ** 2,
    )


def weights_of(base, pos, i, j, k):
    """Quadratic B-spline weight for stencil tap (i, j, k)."""
    import numpy as np

    out = None
    for axis, tap in ((0, i), (1, j), (2, k)):
        frac = pos[:, axis] - np.floor(pos[:, axis]) - 0.5
        w = (0.5 * (0.5 - frac) ** 2, 0.75 - frac ** 2, 0.5 * (0.5 + frac) ** 2)[tap]
        out = w if out is None else out * w
    return out


def _mpm_scratch(world) -> dict:
    """Per-world work buffers, allocated ONCE.

    The first version allocated everything per step (and per tap), which at the
    564k-particle scale peaked at 941 MB for a 68 MB state and churned ~1.6 GB of
    temporaries per step — that churn IS the runtime. Buffers are reused here, the
    particle state is float32 exactly like the TS kernel (Float32Array), and the
    grid mass/momentum stay float64 exactly like the TS kernel (Float64Array).
    """
    import numpy as np

    cells = world["cells"]
    total = cells[0] * cells[1] * cells[2]
    scratch = world.get("scratch")
    if scratch is None or scratch["total"] != total or scratch["capacity"] < world["n"]:
        capacity = world["n"]
        scratch = {
            "total": total,
            "capacity": capacity,
            "grid_mass": np.zeros(total, dtype=np.float64),
            "grid_mom": np.zeros((total, 3), dtype=np.float64),
            "grid_vel": np.zeros((total, 3), dtype=np.float32),
            "cell": np.zeros(capacity, dtype=np.int32),
            "weight": np.zeros(capacity, dtype=np.float32),
            "d0": np.zeros(capacity, dtype=np.float32),
            "d1": np.zeros(capacity, dtype=np.float32),
            "d2": np.zeros(capacity, dtype=np.float32),
            "g0": np.zeros(capacity, dtype=np.float32),
            "g1": np.zeros(capacity, dtype=np.float32),
            "g2": np.zeros(capacity, dtype=np.float32),
            "gathered": np.zeros((capacity, 3), dtype=np.float32),
            "wsum": np.zeros(capacity, dtype=np.float32),
            "b": np.zeros((capacity, 9), dtype=np.float32),
            "C_new": np.zeros((capacity, 3, 3), dtype=np.float32),
        }
        world["scratch"] = scratch
    return scratch


def _weights32(coord, tap):
    """One quadratic B-spline tap along one axis, float32 (matches the TS kernel)."""
    import numpy as np

    frac = (coord - np.floor(coord) - 0.5).astype(np.float32)
    if tap == 0:
        return (0.5 * (0.5 - frac) * (0.5 - frac)).astype(np.float32)
    if tap == 1:
        return (0.75 - frac * frac).astype(np.float32)
    return (0.5 * (0.5 + frac) * (0.5 + frac)).astype(np.float32)


_MPM_ENGINE: str | None = None
_MPM_NUMBA_MODULE = None

_LBM_XLB_MODULE = None


def _load_lbm_xlb():
    """Load the XLB LBM engine sibling module, by explicit path.

    Same pattern as _load_mpm_numba: the worker runs with `python -I`, so the
    script directory is not on sys.path. The module owns the three xlb==0.3.1
    compat shims (warp pin is in the lock; overlap checker; ZouHe
    prescribed_values — see lbm_xlb.py docstring and DECISION-LOG 2026-10-15).
    """
    global _LBM_XLB_MODULE
    if _LBM_XLB_MODULE is not None:
        return _LBM_XLB_MODULE
    import importlib.util

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lbm_xlb.py")
    spec = importlib.util.spec_from_file_location("lbm_xlb", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load lbm_xlb from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["lbm_xlb"] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop("lbm_xlb", None)
        raise
    _LBM_XLB_MODULE = module
    return module


def _load_mpm_numba():
    """Load the sibling numba engine module, by explicit path.

    The worker runs with `python -I` (isolated mode: the script directory is NOT
    put on sys.path — python-worker.ts spawn), so a plain `import mpm_numba`
    fails even though the file sits next to this one. Loading by path keeps the
    engine a sibling file instead of inlining it into worker.py.
    """
    global _MPM_NUMBA_MODULE
    if _MPM_NUMBA_MODULE is not None:
        return _MPM_NUMBA_MODULE
    import importlib.util

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mpm_numba.py")
    spec = importlib.util.spec_from_file_location("mpm_numba", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load mpm_numba from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mpm_numba"] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop("mpm_numba", None)
        raise
    _MPM_NUMBA_MODULE = module
    return module


def _mpm_engine() -> str:
    """Which MPM kernel runs: "numba" when importable, else "numpy".

    Resolved once per process. `CAD_MPM_ENGINE` forces: `numba` RAISES when
    unavailable — a forced engine that silently fell back would turn every
    acceptance run into a silent false pass (the defect class HARNESS exists to
    prevent); `numpy` pins the oracle path. Auto fallback is a PLATFORM fact,
    not an error: the lock excludes numba on linux-musl and darwin-x64 (no cp313
    wheels, DECISION-LOG 2026-10-14), and those targets legitimately run numpy.
    Evidence of which engine ran goes to stderr once, and `op_versions` reports
    numba's presence.
    """
    global _MPM_ENGINE
    if _MPM_ENGINE is None:
        forced = os.environ.get("CAD_MPM_ENGINE", "").strip().lower()
        available = False
        reason = ""
        if forced != "numpy":
            try:
                _load_mpm_numba()
                available = True
            except BaseException as exc:  # noqa: BLE001 - report, do not die
                reason = f"{type(exc).__name__}: {exc}"
        if forced == "numba":
            if not available:
                raise RuntimeError(f"CAD_MPM_ENGINE=numba forced but numba is unavailable ({reason})")
            _MPM_ENGINE = "numba"
        elif forced == "numpy":
            _MPM_ENGINE = "numpy"
        else:
            _MPM_ENGINE = "numba" if available else "numpy"
        suffix = f" (numba unavailable: {reason})" if reason else ""
        _log(f"mpm engine: {_MPM_ENGINE}{suffix}")
    return _MPM_ENGINE


def _mpm_step_once(world) -> None:
    if _mpm_engine() == "numba":
        _load_mpm_numba().step_once(world)
        return
    import numpy as np

    config = world["config"]
    cells = world["cells"]
    nx, ny, nz = cells
    total = nx * ny * nz
    nyz = ny * nz
    dt = float(config["dt"])
    stiffness = float(config.get("stiffness", 50))
    viscosity = float(config.get("viscosity", 0.1))
    rest_density = world["restDensity"]
    active = world["activeN"]
    pos = world["pos"][:active]
    vel = world["vel"][:active]
    C = world["C"][:active]
    scratch = _mpm_scratch(world)
    grid_mass = scratch["grid_mass"]
    grid_mom = scratch["grid_mom"]
    grid_vel = scratch["grid_vel"]
    grid_mass.fill(0.0)
    grid_mom.fill(0.0)

    maximum = np.asarray(cells, dtype=np.int32) - 2
    base0 = np.clip(np.floor(pos[:, 0]).astype(np.int32) - 1, 0, maximum[0])
    base1 = np.clip(np.floor(pos[:, 1]).astype(np.int32) - 1, 0, maximum[1])
    base2 = np.clip(np.floor(pos[:, 2]).astype(np.int32) - 1, 0, maximum[2])
    wx = [_weights32(pos[:, 0], t) for t in range(3)]
    wy = [_weights32(pos[:, 1], t) for t in range(3)]
    wz = [_weights32(pos[:, 2], t) for t in range(3)]
    c00, c01, c02, c10, c11, c12, c20, c21, c22 = (C[:, a, b] for a in range(3) for b in range(3))

    # --- P2G pass 1: mass + APIC momentum ---
    for i in range(3):
        d0 = ((base0 + i + 0.5) - pos[:, 0]).astype(np.float32)
        for j in range(3):
            d1 = ((base1 + j + 0.5) - pos[:, 1]).astype(np.float32)
            for k in range(3):
                d2 = ((base2 + k + 0.5) - pos[:, 2]).astype(np.float32)
                cell = (base0 + i) * nyz + (base1 + j) * nz + (base2 + k)
                w = wx[i] * wy[j] * wz[k]
                grid_mass += np.bincount(cell, weights=w, minlength=total)
                # Q = C @ cellDist, then scatter the three components (no (n,3) temp)
                q0 = c00 * d0 + c01 * d1 + c02 * d2
                q1 = c10 * d0 + c11 * d1 + c12 * d2
                q2 = c20 * d0 + c21 * d1 + c22 * d2
                grid_mom[:, 0] += np.bincount(cell, weights=w * (vel[:, 0] + q0), minlength=total)
                grid_mom[:, 1] += np.bincount(cell, weights=w * (vel[:, 1] + q1), minlength=total)
                grid_mom[:, 2] += np.bincount(cell, weights=w * (vel[:, 2] + q2), minlength=total)

    # --- P2G pass 2: stress (weakly-compressible EOS + viscosity) ---
    density = np.zeros(active, dtype=np.float64)
    for i in range(3):
        for j in range(3):
            for k in range(3):
                cell = (base0 + i) * nyz + (base1 + j) * nz + (base2 + k)
                density += (wx[i] * wy[j] * wz[k]) * grid_mass[cell]
    volume = 1.0 / np.where(density != 0, density, 1.0)
    dr = density / rest_density if rest_density else np.zeros(active)
    pressure = stiffness * np.maximum(0.0, dr ** 5 - 1) if rest_density else np.zeros(active)
    scale = (volume * -4 * dt).astype(np.float64)
    s00 = (scale * (-pressure + viscosity * 2 * c00)).astype(np.float32)
    s11 = (scale * (-pressure + viscosity * 2 * c11)).astype(np.float32)
    s22 = (scale * (-pressure + viscosity * 2 * c22)).astype(np.float32)
    s01 = (scale * (viscosity * (c01 + c10))).astype(np.float32)
    s02 = (scale * (viscosity * (c02 + c20))).astype(np.float32)
    s12 = (scale * (viscosity * (c12 + c21))).astype(np.float32)
    for i in range(3):
        d0 = ((base0 + i + 0.5) - pos[:, 0]).astype(np.float32)
        for j in range(3):
            d1 = ((base1 + j + 0.5) - pos[:, 1]).astype(np.float32)
            for k in range(3):
                d2 = ((base2 + k + 0.5) - pos[:, 2]).astype(np.float32)
                cell = (base0 + i) * nyz + (base1 + j) * nz + (base2 + k)
                w = wx[i] * wy[j] * wz[k]
                grid_mom[:, 0] += np.bincount(cell, weights=w * (s00 * d0 + s01 * d1 + s02 * d2), minlength=total)
                grid_mom[:, 1] += np.bincount(cell, weights=w * (s01 * d0 + s11 * d1 + s12 * d2), minlength=total)
                grid_mom[:, 2] += np.bincount(cell, weights=w * (s02 * d0 + s12 * d1 + s22 * d2), minlength=total)

    # --- grid update: v = momentum/mass + boundary conditions ---
    mass_safe = np.where(grid_mass > 0, grid_mass, 1.0)
    grid_vel[:] = (grid_mom / mass_safe[:, None]).astype(np.float32)
    grid_vel[grid_mass <= 0] = 0.0
    grid_vel = grid_vel.reshape(nx, ny, nz, 3)
    if nx > 2:
        grid_vel[0, :, :, 0] = 0.0
        grid_vel[nx - 1, :, :, 0] = 0.0
    if ny > 2:
        grid_vel[:, 0, :, 1] = 0.0
        grid_vel[:, ny - 1, :, 1] = 0.0
    if nz > 2:
        grid_vel[:, :, 0, 2] = 0.0
        grid_vel[:, :, nz - 1, 2] = 0.0
    if world["solidMask"] is not None and world["solidNormal"] is not None:
        mask = world["solidMask"].reshape(nx, ny, nz)
        code = world["solidNormal"].reshape(nx, ny, nz)
        grid_vel[:, :, :, 0] = np.where(mask & ((code == 1) | (code == 2)), 0.0, grid_vel[:, :, :, 0])
        grid_vel[:, :, :, 1] = np.where(mask & ((code == 3) | (code == 4)), 0.0, grid_vel[:, :, :, 1])
        grid_vel[:, :, :, 2] = np.where(mask & ((code == 5) | (code == 6)), 0.0, grid_vel[:, :, :, 2])
    flat_vel = scratch["grid_vel"]

    # --- G2P: gather velocity + affine, advect, drives, clamps ---
    vmax = float(config["vmax"])
    gravity = np.asarray(config.get("gravity") or [0.0, 0.0, 0.0], dtype=np.float64)
    gathered = scratch["gathered"][:active]
    wsum = scratch["wsum"][:active]
    b = scratch["b"][:active]
    gathered.fill(0.0)
    wsum.fill(0.0)
    b.fill(0.0)
    mask_flat = world["solidMask"]
    for i in range(3):
        d0 = ((base0 + i + 0.5) - pos[:, 0]).astype(np.float32)
        for j in range(3):
            d1 = ((base1 + j + 0.5) - pos[:, 1]).astype(np.float32)
            for k in range(3):
                d2 = ((base2 + k + 0.5) - pos[:, 2]).astype(np.float32)
                cell = (base0 + i) * nyz + (base1 + j) * nz + (base2 + k)
                w = wx[i] * wy[j] * wz[k]
                if mask_flat is not None:
                    # free-slip renormalization: solid cells are EXCLUDED, otherwise
                    # near-wall particles get dragged by the zeros.
                    w = np.where(mask_flat[cell], np.float32(0.0), w)
                g0 = np.clip(flat_vel[cell, 0], -vmax, vmax).astype(np.float32)
                g1 = np.clip(flat_vel[cell, 1], -vmax, vmax).astype(np.float32)
                g2 = np.clip(flat_vel[cell, 2], -vmax, vmax).astype(np.float32)
                t0 = w * g0
                t1 = w * g1
                t2 = w * g2
                gathered[:, 0] += t0
                gathered[:, 1] += t1
                gathered[:, 2] += t2
                wsum += w
                b[:, 0] += t0 * d0; b[:, 1] += t0 * d1; b[:, 2] += t0 * d2
                b[:, 3] += t1 * d0; b[:, 4] += t1 * d1; b[:, 5] += t1 * d2
                b[:, 6] += t2 * d0; b[:, 7] += t2 * d1; b[:, 8] += t2 * d2

    scale = np.where(wsum > 0.5, 1.0 / np.where(wsum == 0.0, 1.0, wsum), 1.0).astype(np.float32)
    gathered *= scale[:, None]
    b *= scale[:, None]
    bad = ~np.isfinite(b[:, 0] + b[:, 4] + b[:, 8])
    if bad.any():
        b[bad] = 0.0
        gathered[bad] = 0.0
    C_new = scratch["C_new"][:active]
    C_new[:] = (4.0 * b).reshape(-1, 3, 3)

    gathered += (gravity[None, :] * dt).astype(np.float32)
    speed2 = np.einsum("pa,pa->p", gathered, gathered)
    over = speed2 > vmax * vmax
    safe_speed2 = np.where(speed2 > 0, speed2, 1.0)
    gathered *= np.where(over, vmax / np.sqrt(safe_speed2), 1.0)[:, None].astype(np.float32)
    max_speed = vmax if over.any() else (float(np.sqrt(speed2.max())) if active else 0.0)
    clamped = int(over.sum())

    inlet = config.get("inlet")
    if inlet:
        axis = int(inlet["axis"])
        in_band = (pos[:, axis] >= float(inlet["band"][0])) & (pos[:, axis] <= float(inlet["band"][1]))
        below = in_band & (gathered[:, axis] < float(inlet["speed"]))
        world["inletCounters"]["band"] += int(in_band.sum())
        world["inletCounters"]["floored"] += int(below.sum())
        if below.any():
            world["inletCounters"]["injected"] += float((float(inlet["speed"]) - gathered[below, axis]).sum())
        gathered[below, axis] = float(inlet["speed"])

    nan = ~np.isfinite(gathered).all(axis=1)
    if nan.any():
        world["nonFinite"] += int(nan.sum())
        gathered[nan] = 0.0
        if inlet and int(inlet["axis"]) == 0:
            gathered[nan, 0] = float(inlet["speed"])
        C_new[nan] = 0.0

    # advection + box clamp with normal-velocity kill (free-slip walls)
    new_pos = pos + gathered * dt
    high = np.array([nx - 1.5, ny - 1.5, nz - 1.5], dtype=np.float32)
    below_box = new_pos < 1.5
    above_box = new_pos > high[None, :]
    new_pos = np.clip(new_pos, 1.5, high[None, :])
    gathered = np.where(below_box & (gathered < 0), 0.0, gathered)
    gathered = np.where(above_box & (gathered > 0), 0.0, gathered)

    recycle = config.get("recycle")
    if recycle:
        axis = int(recycle["axis"])
        crossed = new_pos[:, axis] > float(recycle["at"])
        if crossed.any():
            new_pos[crossed, axis] = float(recycle["respawn"])
            world["transits"] += int(crossed.sum())

    escape = config.get("escape")
    if escape:
        axis = int(escape["axis"])
        removed_mask = new_pos[:, axis] > float(escape["at"])
        removed = int(removed_mask.sum())
        if removed:
            keep = ~removed_mask
            new_pos = new_pos[keep]
            gathered = gathered[keep]
            C_new = C_new[keep]
            world["escaped"] += removed
        world["activeN"] = active - removed

    world["pos"][: world["activeN"]] = new_pos
    world["vel"][: world["activeN"]] = gathered
    world["C"][: world["activeN"]] = C_new
    world["lastStep"] = {
        "maxSpeed": max_speed,
        "clampedFraction": (clamped / active) if active else 0.0,
    }


def op_mpm_step(params: dict) -> dict:
    """Advance a world by `steps` (default 1) and return its diagnostics."""
    world = _MpmWorlds.get(params["worldId"])
    if world is None:
        raise ValueError(f"unknown mpm world: {params['worldId']}")
    for _ in range(int(params.get("steps") or 1)):
        _mpm_step_once(world)
    return _mpm_stats(world)


    """Advance a world by `steps` (default 1) and return its diagnostics."""
    world = _MpmWorlds.get(params["worldId"])
    if world is None:
        raise ValueError(f"unknown mpm world: {params['worldId']}")
    for _ in range(int(params.get("steps") or 1)):
        _mpm_step_once(world)
    return _mpm_stats(world)


def _mpm_stats(world) -> dict:
    import numpy as np

    active = world["activeN"]
    pos = world["pos"][:active]
    vel = world["vel"][:active]
    speeds = np.linalg.norm(vel, axis=1) if active else np.zeros(0)
    return {
        "activeN": active,
        "escaped": world["escaped"],
        "transits": world["transits"],
        "nonFinite": world["nonFinite"],
        "restDensity": world["restDensity"],
        "maxSpeed": world["lastStep"]["maxSpeed"],
        "clampedFraction": world["lastStep"]["clampedFraction"],
        "meanSpeed": float(speeds.mean()) if active else 0.0,
        "massTotal": float(active),
        "positionSum": [float(v) for v in (pos.sum(axis=0) if active else np.zeros(3))],
        "velocitySum": [float(v) for v in (vel.sum(axis=0) if active else np.zeros(3))],
        "positionMagnitude": float(np.abs(pos).sum()) if active else 0.0,
    }


def op_mpm_state(params: dict) -> dict:
    """Diagnostics for a world, plus the per-particle arrays when asked (test-sized
    worlds only — the production path never ships the state through the pipe)."""
    world = _MpmWorlds.get(params["worldId"])
    if world is None:
        raise ValueError(f"unknown mpm world: {params['worldId']}")
    state = _mpm_stats(world)
    if params.get("particles"):
        active = world["activeN"]
        state["pos"] = [float(v) for v in world["pos"][:active].reshape(-1)]
        state["vel"] = [float(v) for v in world["vel"][:active].reshape(-1)]
    return state


def op_mpm_destroy(params: dict) -> dict:
    world = _MpmWorlds.get(params["worldId"])
    existed = world is not None
    _mpm_drop(params["worldId"])
    return {"destroyed": existed, "worlds": len(_MpmWorlds)}


# ---------------------------------------------------------------------------
# The fluid run: scenario drive + SDF projection + the conservation audit.
#
# This is the `runFluid` of src/host/fluid.ts minus the two halves that need the
# MESH rather than the field: building the SDF (buildSdfFromStl) and choosing seed
# positions (seedPositions). Those stay in TypeScript for now and hand their result
# over as FILES, because both are big: the SDF field is one float per cell and the
# seeds are three doubles per particle (13.5 MB at the 564k-particle acceptance
# case) — the "big payloads go by file" rule, and also Q1=B's "the file is the
# contract".
#
# File layout (written by TS, read here) — one header, then flat arrays:
#   sdf :  magic "CADFSDF1" | int32 nx,ny,nz | float64 dx | float64 ox,oy,oz
#          | float32 sdf[n] | uint8 solidMask[n] | uint8 solidNormal[n]
#   seed:  magic "CADFSEED" | int32 count | float64 xyz[3*count]
#   snap:  magic "CADFSNAP" | int32 count | { int32 step, float64 timeSec,
#          int32 n, float32 posMm[3n], float32 speed[n] } * count
# ---------------------------------------------------------------------------


def _read_fluid_sdf(path: str) -> dict:
    import numpy as np

    with open(path, "rb") as handle:
        magic = handle.read(8)
        if magic != b"CADFSDF1":
            raise ValueError(f"bad sdf file magic: {magic!r}")
        nx, ny, nz = np.fromfile(handle, dtype="<i4", count=3)
        dx = float(np.fromfile(handle, dtype="<f8", count=1)[0])
        origin = [float(v) for v in np.fromfile(handle, dtype="<f8", count=3)]
        total = int(nx) * int(ny) * int(nz)
        sdf = np.fromfile(handle, dtype="<f4", count=total)
        mask = np.fromfile(handle, dtype="<u1", count=total)
        normal = np.fromfile(handle, dtype="<u1", count=total)
    return {
        "cells": [int(nx), int(ny), int(nz)],
        "dxMm": dx,
        "originMm": origin,
        "sdf": sdf.astype(np.float64),
        "solidMask": mask,
        "solidNormal": normal,
    }


def _read_fluid_seeds(path: str):
    import numpy as np

    with open(path, "rb") as handle:
        magic = handle.read(8)
        if magic != b"CADFSEED":
            raise ValueError(f"bad seed file magic: {magic!r}")
        count = int(np.fromfile(handle, dtype="<i4", count=1)[0])
        values = np.fromfile(handle, dtype="<f8", count=3 * count)
    return values.reshape(-1, 3)


def _sdf_at(field: dict, x: float, y: float, z: float) -> float:
    """Trilinear sample of the grid SDF — the TS `sdfAt`, clamp-and-lerp for clamp-and-lerp."""
    nx, ny, nz = field["cells"]
    ox, oy, oz = field["originMm"]
    dx = field["dxMm"]
    sdf = field["sdf"]

    gx = min(nx - 1, max(0.0, (x - ox) / dx))
    gy = min(ny - 1, max(0.0, (y - oy) / dx))
    gz = min(nz - 1, max(0.0, (z - oz) / dx))
    x0, y0, z0 = int(gx), int(gy), int(gz)
    fx, fy, fz = gx - x0, gy - y0, gz - z0
    x1, y1, z1 = min(x0 + 1, nx - 1), min(y0 + 1, ny - 1), min(z0 + 1, nz - 1)

    def c(xx, yy, zz):
        return float(sdf[(xx * ny + yy) * nz + zz])

    def lerp(a, b, t):
        return a + (b - a) * t

    v00 = lerp(c(x0, y0, z0), c(x1, y0, z0), fx)
    v10 = lerp(c(x0, y1, z0), c(x1, y1, z0), fx)
    v01 = lerp(c(x0, y0, z1), c(x1, y0, z1), fx)
    v11 = lerp(c(x0, y1, z1), c(x1, y1, z1), fx)
    return lerp(lerp(v00, v10, fy), lerp(v01, v11, fy), fz)


def _sdf_at_many(field: dict, points):
    """Trilinear SDF samples for many points at once — the same clamp-and-lerp as
    `_sdf_at`, vectorized. The scalar version is kept for single lookups; the run
    loop needs this one (a per-particle Python loop over 1200 steps does not fit in
    any timeout)."""
    import numpy as np

    nx, ny, nz = field["cells"]
    dx = field["dxMm"]
    origin = np.asarray(field["originMm"], dtype=np.float64)
    sdf = field["sdf"]
    maximum = np.array([nx - 1, ny - 1, nz - 1], dtype=np.float64)
    grid = np.clip((np.asarray(points, dtype=np.float64) - origin) / dx, 0.0, maximum)
    low = np.floor(grid).astype(np.int64)
    frac = grid - low
    high = np.minimum(low + 1, maximum.astype(np.int64))

    def c(xx, yy, zz):
        return sdf[(xx * ny + yy) * nz + zz]

    x0, y0, z0 = low[:, 0], low[:, 1], low[:, 2]
    x1, y1, z1 = high[:, 0], high[:, 1], high[:, 2]
    fx, fy, fz = frac[:, 0], frac[:, 1], frac[:, 2]
    c000, c100 = c(x0, y0, z0), c(x1, y0, z0)
    c010, c110 = c(x0, y1, z0), c(x1, y1, z0)
    c001, c101 = c(x0, y0, z1), c(x1, y0, z1)
    c011, c111 = c(x0, y1, z1), c(x1, y1, z1)
    v00 = c000 + (c100 - c000) * fx
    v10 = c010 + (c110 - c010) * fx
    v01 = c001 + (c101 - c001) * fx
    v11 = c011 + (c111 - c011) * fx
    return (v00 + (v10 - v00) * fy) + ((v01 + (v11 - v01) * fy) - (v00 + (v10 - v00) * fy)) * fz


def op_fluid_run(params: dict) -> dict:
    """Drive the MPM world through the scenario and audit the result.

    Everything the TS `runFluid` did BETWEEN the SDF and the report happens here:
    calibration + EOS/damping scaling, the near-surface projection, outlet timing,
    section-averaged velocity, snapshots and the conservation metrics.
    """
    import numpy as np

    sdf = _read_fluid_sdf(params["sdfPath"])
    seeds = _read_fluid_seeds(params["seedsPath"])
    config = params["config"]
    steps = int(params.get("steps") or 1200)
    snapshot_count = int(params.get("snapshotCount") or 4)
    snapshot_every = int(params.get("snapshotEvery") or max(1, steps // (snapshot_count + 1)))
    section_count = int(params.get("sectionCount") or 20)
    flow_axis = int(params.get("flowAxis") or 0)
    dx_mm = float(config["dxMm"])
    origin = [float(v) for v in sdf["originMm"]]
    penetration_tol = float(params.get("penetrationTolMm") or 0.3)
    stiffness0 = float(params.get("stiffness0") or 50)
    viscosity0 = float(params.get("viscosity0") or 0.1)
    rest0 = float(params.get("restDensity0") or 1.5)

    count = int(config["particleCount"])
    created = op_mpm_create(
        {
            "config": config,
            "seeds": [float(v) for v in seeds.reshape(-1)],
        }
    )
    world = _MpmWorlds[created["worldId"]]
    # THE WALLS. The SDF file carries the solid mask + dominant normals, and the
    # MPM grid update needs them (they zero the normal velocity at wall cells and
    # the G2P excludes those cells from the interpolation). Without this the run
    # has NO boundary conditions at all — measured: arrival 0.098 where the TS
    # canonical gives 0.8643 on the same 50k-particle pipe, because the flow leaked
    # into the walls.
    world["solidMask"] = sdf["solidMask"].astype(bool)
    world["solidNormal"] = sdf["solidNormal"].astype(np.int64)
    world["activeN"] = count
    rest_density = _mpm_calibrate(world)
    world["restDensity"] = rest_density
    world["config"]["stiffness"] = stiffness0 * (rest_density / rest0)
    world["config"]["viscosity"] = viscosity0 * (rest_density / rest0)

    # near-surface mask: only particles in these cells need SDF projection
    nx, ny, nz = sdf["cells"]
    grid_cells = sdf["sdf"].reshape(nx, ny, nz)
    band = 2.5 * dx_mm
    near_surface = (grid_cells > -band) & (grid_cells < band)

    projection_stats = {
        "calls": 0, "moved": 0, "pushSum": 0.0, "last": None,
        "candidate": 0, "inside": 0, "killed": 0, "killedSpeedSum": 0.0,
    }

    def project_particles(is_last: bool = False) -> None:
        active = world["activeN"]
        if active == 0:
            return
        projection_stats["calls"] += 1
        pos = world["pos"][:active]
        vel = world["vel"][:active]
        cells = np.clip(np.floor(pos).astype(np.int64), 0, np.array([nx - 1, ny - 1, nz - 1]))
        candidates = near_surface[cells[:, 0], cells[:, 1], cells[:, 2]]
        if not candidates.any():
            return
        index = np.flatnonzero(candidates)
        tol = 0.05
        origin_array = np.asarray(origin, dtype=np.float64)
        world_mm = pos[index] * dx_mm + origin_array[None, :]
        distances = _sdf_at_many(sdf, world_mm)
        inside = distances < -tol
        if not inside.any():
            return
        index = index[inside]
        world_mm = world_mm[inside]
        distances = distances[inside]
        # outward gradient via central differences on the grid SDF, sampled exactly
        # where the TS version samples it (sdfAt at ±dx), vectorized
        offset = np.zeros((1, 3), dtype=np.float64)
        offset[0, 0] = dx_mm
        gx = _sdf_at_many(sdf, world_mm + offset) - _sdf_at_many(sdf, world_mm - offset)
        offset[0, 0] = 0.0
        offset[0, 1] = dx_mm
        gy = _sdf_at_many(sdf, world_mm + offset) - _sdf_at_many(sdf, world_mm - offset)
        offset[0, 1] = 0.0
        offset[0, 2] = dx_mm
        gz = _sdf_at_many(sdf, world_mm + offset) - _sdf_at_many(sdf, world_mm - offset)
        lengths = np.where((magnitude := np.sqrt(gx * gx + gy * gy + gz * gz)) > 0, magnitude, 1.0)
        normals = np.stack([gx / lengths, gy / lengths, gz / lengths], axis=1)
        push = (-distances + 0.15 * dx_mm) / dx_mm
        projection_stats["moved"] += int(index.size)
        projection_stats["pushSum"] += float(push.sum())
        projection_stats["inside"] += int(index.size)
        projection_stats["candidate"] += int(candidates.sum())
        pos[index] = pos[index] + normals * push[:, None]
        if is_last:
            # THE decisive reading: after the final projection of the run, how many
            # particles are STILL inside the wall? If this is non-zero the projection's
            # post-condition does not hold; if it is zero while the reported
            # penetration is not, the final-state sampling or the active set is at fault.
            after_mm = pos[index] * dx_mm + np.asarray(origin, dtype=np.float64)[None, :]
            after_depths = _sdf_at_many(sdf, after_mm)
            # Also the GLOBAL state right here: if this says zero penetrating while
            # the reported metric (computed after the loop) says otherwise, then
            # something between the last projection and the metric moves particles.
            global_depths = _sdf_at_many(sdf, pos * dx_mm + np.asarray(origin, dtype=np.float64)[None, :])
            projection_stats["last"] = {
                "insideBefore": int(index.size),
                "depthAfterMinMm": float(after_depths.min()),
                "depthAfterMeanMm": float(after_depths.mean()),
                "stillInside": int((after_depths < -tol).sum()),
                "globalPenetratingAfter": int((global_depths < -penetration_tol).sum()),
                "globalDepthMinMm": float(global_depths.min()),
                "posSumAfter": float(pos.sum()),
                "activeAfter": int(active),
            }
        # NO box clamp here. A projected particle can leave the box, and an earlier
        # defensive clamp pulled it back to the box FACE — which is inside the wall
        # for a pipe whose outer surface sits close to the grid boundary. Measured:
        # that clamp put 167(Ø60)/888(Ø100) particles ~0.9mm inside the wall at the
        # end of the run while the projection itself left none (its post-condition
        # holds: depthAfterMin +0.29mm, stillInside 0). The out-of-range stencil that
        # motivated the clamp is handled where it belongs — `_mpm_step_once` clips the
        # stencil base — and the kernel's own advection clamp brings the particle back
        # into the box on the next step, exactly as the TS implementation does.
        # kill the into-wall velocity component (free slip)
        vn = np.einsum("pa,pa->p", vel[index], normals)
        drag = vn < 0
        projection_stats["killed"] += int(drag.sum())
        projection_stats["killedSpeedSum"] += float(-vn[drag].sum()) if drag.any() else 0.0
        if drag.any():
            target = index[drag]
            vel[target] = vel[target] - normals[drag] * vn[drag][:, None]
        world["pos"][:active] = pos
        world["vel"][:active] = vel

    time_to_outlet = None
    escaped_before = 0
    has_sections = bool(params.get("hasSections"))
    lo = float(params.get("sectionLoMm") or 0.0)
    hi = float(params.get("sectionHiMm") or 0.0)
    section_vel_sum = np.zeros(section_count, dtype=np.float64)
    section_vel_n = np.zeros(section_count, dtype=np.float64)
    snapshots = []
    snapshot_steps = []

    skip_project = bool(params.get("skipProject"))
    debug_enabled = bool(params.get("debugPenetration"))
    block_checksums = []
    for step in range(1, steps + 1):
        _mpm_step_once(world)
        if not skip_project:
            project_particles(is_last=(debug_enabled and step == steps))
        if debug_enabled and step == steps:
            block_checksums.append(("afterProject", float(world["pos"][: world["activeN"]].sum())))
        if time_to_outlet is None and world["escaped"] > escaped_before:
            time_to_outlet = step
        escaped_before = world["escaped"]

        active = world["activeN"]
        if has_sections and active:
            pos = world["pos"][:active]
            vel = world["vel"][:active]
            along = pos[:, flow_axis] * dx_mm + origin[flow_axis]
            bins = np.floor((along - lo) / ((hi - lo) / section_count)).astype(np.int64)
            valid = (bins >= 0) & (bins < section_count)
            if valid.any():
                np.add.at(section_vel_sum, bins[valid], vel[valid, flow_axis] * dx_mm)
                np.add.at(section_vel_n, bins[valid], 1.0)

        if debug_enabled and step == steps:
            block_checksums.append(("afterSections", float(world["pos"][: world["activeN"]].sum())))
        if step % snapshot_every == 0 and len(snapshots) < snapshot_count:
            active = world["activeN"]
            pos_mm = (world["pos"][:active] * dx_mm + np.asarray(origin)[None, :]).astype(np.float32)
            speed = (np.linalg.norm(world["vel"][:active], axis=1) * dx_mm).astype(np.float32)
            snapshots.append((step, round(step * float(config["dt"]), 3), pos_mm, speed))
            snapshot_steps.append(step)

    if debug_enabled:
        block_checksums.append(("beforeMetrics", float(world["pos"][: world["activeN"]].sum())))
    # ---- metrics: penetration + speed stats over the final state ----
    active = world["activeN"]
    penetration_count = 0
    max_v = 0.0
    sum_v = 0.0
    if active:
        pos_mm = world["pos"][:active] * dx_mm + np.asarray(origin)[None, :]
        penetration_count = int((_sdf_at_many(sdf, pos_mm) < -penetration_tol).sum())
        metric_pos_sum = float(world["pos"][:active].sum())
        metric_depth_min = float(_sdf_at_many(sdf, pos_mm).min())
        speeds = np.linalg.norm(world["vel"][:active], axis=1) * dx_mm
        max_v = float(speeds.max())
        sum_v = float(speeds.sum())

    section_avg = []
    if params.get("hasSections") or params.get("inlet"):
        for i in range(section_count):
            section_avg.append(
                {
                    "positionMm": round(lo + ((hi - lo) * (i + 0.5)) / section_count, 1),
                    "velocityMmPerSec": round(float(section_vel_sum[i] / section_vel_n[i]) if section_vel_n[i] else 0.0, 1),
                }
            )

    debug_penetration = None
    if params.get("debugPenetration"):
        debug_penetration = {
            "projectionCalls": projection_stats["calls"],
            "projectionMoved": projection_stats["moved"],
            "projectionCandidate": projection_stats["candidate"],
            "projectionInside": projection_stats["inside"],
            "projectionKilled": projection_stats["killed"],
            "projectionKilledSpeedSum": round(projection_stats["killedSpeedSum"], 2),
            "projectionPushSum": round(projection_stats["pushSum"], 2),
            "inlet": dict(world["inletCounters"]),
        }
    if params.get("debugPenetration") and active:
        import numpy as _np

        pos_mm_all = world["pos"][:active] * dx_mm + _np.asarray(origin)[None, :]
        depths = _sdf_at_many(sdf, pos_mm_all)
        penetrating = depths < -penetration_tol
        debug_penetration["penetrating"] = int(penetrating.sum())
        debug_penetration["depthMinMm"] = round(float(depths.min()), 6)
        if penetrating.any():
            cells_of = _np.clip(_np.floor(world["pos"][:active]).astype(_np.int64), 0, _np.array([nx - 1, ny - 1, nz - 1]))
            cell_depth = grid_cells[cells_of[penetrating][:, 0], cells_of[penetrating][:, 1], cells_of[penetrating][:, 2]]
            in_band = (cell_depth > -band) & (cell_depth < band)
            # gradient magnitude at the penetrating positions: a zero gradient
            # means the projection's push has NO direction to work with.
            offset = np.zeros((1, 3), dtype=np.float64)
            offset[0, 0] = dx_mm
            gx = _sdf_at_many(sdf, pos_mm_all[penetrating] + offset) - _sdf_at_many(sdf, pos_mm_all[penetrating] - offset)
            offset[0, 0] = 0.0
            offset[0, 1] = dx_mm
            gy = _sdf_at_many(sdf, pos_mm_all[penetrating] + offset) - _sdf_at_many(sdf, pos_mm_all[penetrating] - offset)
            offset[0, 1] = 0.0
            offset[0, 2] = dx_mm
            gz = _sdf_at_many(sdf, pos_mm_all[penetrating] + offset) - _sdf_at_many(sdf, pos_mm_all[penetrating] - offset)
            gradient_norm = np.sqrt(gx * gx + gy * gy + gz * gz)
            debug_penetration.update({
                "count": int(penetrating.sum()),
                "gradMin": float(gradient_norm.min()),
                "gradMax": float(gradient_norm.max()),
                "gradZero": int((gradient_norm < 1e-9).sum()),
                "projectionMoved": projection_stats["moved"],
                "projectionCalls": projection_stats["calls"],
                "projectionPushSum": round(projection_stats["pushSum"], 2),
                "projectionCandidate": projection_stats.get("candidate", 0),
                "projectionInside": projection_stats.get("inside", 0),
                "projectionKilled": projection_stats.get("killed", 0),
                "projectionKilledSpeedSum": round(projection_stats.get("killedSpeedSum", 0.0), 2),
                **(projection_stats["last"] or {}),
                "depthMinMm": float(depths[penetrating].min()),
                "depthMaxMm": float(depths[penetrating].max()),
                "depthMeanMm": float(depths[penetrating].mean()),
                "withinBand": int(in_band.sum()),
                "outsideBand": int((~in_band).sum()),
                "cellDepthMinMm": float(cell_depth.min()),
                "metricPosSum": round(metric_pos_sum, 3),
                "metricDepthMinMm": round(metric_depth_min, 6),
                "metricActive": int(active),
                "blockChecksums": block_checksums,
            })

    count0 = count
    mass_error = abs(count0 - world["escaped"] - active) / count0 if count0 else 0.0
    arrival = (world["escaped"] / count0) if count0 else 0.0

    # snapshots go to a file (a 564k-particle snapshot is 6.8 MB)
    with open(params["snapshotsPath"], "wb") as handle:
        handle.write(b"CADFSNAP")
        np.asarray([len(snapshots)], dtype="<i4").tofile(handle)
        for step, time_sec, pos_mm, speed in snapshots:
            np.asarray([step], dtype="<i4").tofile(handle)
            np.asarray([time_sec], dtype="<f8").tofile(handle)
            np.asarray([pos_mm.shape[0]], dtype="<i4").tofile(handle)
            pos_mm.astype("<f4").tofile(handle)
            speed.astype("<f4").tofile(handle)

    result = {
        "particleCount0": count0,
        "restDensity": rest_density,
        "escaped": world["escaped"],
        "active": active,
        "massConservationError": round(mass_error, 6),
        "penetrationCount": penetration_count,
        "outletArrivalRatio": round(arrival, 4),
        "timeToOutletSteps": time_to_outlet,
        "sectionAvgVelocity": section_avg,
        "maxVelocityMmPerSec": round(max_v, 1),
        "avgVelocityMmPerSec": round(sum_v / max(1, active), 1),
        "diverged": bool(world["nonFinite"] > 0),
        "stepsRun": steps,
        "snapshotSteps": snapshot_steps,
        **({"debugPenetration": debug_penetration} if debug_penetration is not None else {}),
    }
    op_mpm_destroy({"worldId": created["worldId"]})
    return result


# A wall measurement only counts when the ray actually reaches the OTHER side of the
# material. `dot(n_in, n_exit) < OPPOSITE_WALL_DOT` is what "the other side" means:
# a hit on a coplanar sliver — a Manifold artefact at a crease or at an exposed
# start-cap — has nearly the SAME normal and is not a wall at all. Measured on the
# real corpus: a 0.012 mm² sliver face reported a 0.17 mm "wall" that does not exist
# (dot = −0.08), while a genuine 0.50 mm tube wall reports dot = −1.000.
OPPOSITE_WALL_DOT = -0.5

# `unprintable` is a delivery blocker, so a SINGLE sampled face must not be able to
# decide it. `check` already reports the minimum honestly; escalating to
# `unprintable` additionally requires the thin region to be a SUSTAINED area rather
# than one knife edge or one degenerate triangle.
UNPRINTABLE_MIN_THIN_AREA_MM2 = 50.0
UNPRINTABLE_MIN_THIN_AREA_FRACTION = 0.01


def _json_safe(value):
    """Normalise -0.0 to 0.0 recursively before a reply leaves the worker.

    JSON.stringify(-0) is "0", so a reply containing -0 is NOT a lossless round-trip
    and the host rejects the whole tool result as `value is not lossless JSON`
    (observed on the toy-balance base: a `directionVector` component of -0.0, and a
    region centroid rounded to -0.0, made the scan-mode reply undeliverable).
    Rounding at every call site would miss one eventually; this pass cannot.
    """
    if isinstance(value, float):
        return 0.0 if value == 0 else value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _print_frame_matrix(rotate_deg):
    """The Rz·Ry·Rx (degrees) matrix behind _rotated_print_frame — shared with the
    voxel-based support_map, which rotates the trimesh directly."""
    import numpy as np

    if not rotate_deg:
        return None
    rx, ry, rz = (float(v) for v in rotate_deg)

    def rot(axis, a):
        c, s = np.cos(a), np.sin(a)
        m = np.eye(3)
        if axis == "x":
            m[1, 1], m[1, 2], m[2, 1], m[2, 2] = c, -s, s, c
        elif axis == "y":
            m[0, 0], m[0, 2], m[2, 0], m[2, 2] = c, s, -s, c
        else:
            m[0, 0], m[0, 1], m[1, 0], m[1, 1] = c, -s, s, c
        return m

    m = rot("z", np.deg2rad(rz)) @ rot("y", np.deg2rad(ry)) @ rot("x", np.deg2rad(rx))
    m4 = np.eye(4)
    m4[:3, :3] = m
    return m4


def _rotated_print_frame(vertices, faces, rotate_deg):
    """G6 (2026-10-29): the PRINT orientation is a declaration, not the modelling
    pose — the roberval beams print FLAT but were modelled upright, so the tool
    judged 890 mm² of phantom overhang. Applies Rz·Ry·Rx (degrees, the same
    composition validate_assembly documents for R) to the vertices before any
    overhang/support analysis. Faces are untouched; winding is preserved because
    rotations are proper."""
    import numpy as np

    if not rotate_deg:
        return vertices, faces
    rx, ry, rz = (float(v) for v in rotate_deg)

    def rot(axis, a):
        c, s = np.cos(a), np.sin(a)
        m = np.eye(3)
        if axis == "x":
            m[1, 1], m[1, 2], m[2, 1], m[2, 2] = c, -s, s, c
        elif axis == "y":
            m[0, 0], m[0, 2], m[2, 0], m[2, 2] = c, s, -s, c
        else:
            m[0, 0], m[0, 1], m[1, 0], m[1, 1] = c, -s, s, c
        return m

    m = rot("z", np.deg2rad(rz)) @ rot("y", np.deg2rad(ry)) @ rot("x", np.deg2rad(rx))
    return np.asarray(vertices, dtype=float) @ m.T, faces


def op_check_printability(params: dict) -> dict:
    """Manufacturability screen (FDM bias): sampled wall thickness by a ray along the
    inward normal, plus down-facing overhang area — the `checkPrintabilityInTs` of
    src/host/inspect.ts.

    Only the WALL half is sampled, because only it is expensive (a spatial-index ray
    cast; measured before porting at 601 rays / 0.121 s on a 28,830-triangle part,
    against a 120 s budget). The overhang half is arithmetic and is computed over
    EVERY triangle: summing the areas of every Nth face misses the other N−1, which
    is a biased estimate, not noise (real 5.7" propeller: 200 mm² sampled against
    2022 mm² true — a 10x under-report rendered as "mm²").

    When the ray half cannot measure anything on a watertight mesh — the engine is
    unavailable rather than the geometry being degenerate — the report says so and
    never returns `ok`. Three silent failures are guarded here, each of which was
    observed for real: an engine that is missing, a sliver that fakes a thin wall,
    and a single face deciding a red verdict.
    """
    import numpy as np
    import trimesh

    wall_min_mm = float(params.get("wallMinMm") or 1.2)
    overhang_deg = float(params.get("overhangDeg") or 45)
    target_samples = max(100, min(int(params.get("samples") or 600), 4000))

    vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(params["path"]))
    vertices, faces = _rotated_print_frame(vertices, faces, params.get("printOrientationDeg"))
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    watertight = _is_watertight(triangles)

    tri_count = len(triangles)

    # ---- overhang: every triangle, no sampling -----------------------------
    all_corners = points[triangles]
    all_centroids = all_corners.mean(axis=1)
    all_cross = np.cross(all_corners[:, 1] - all_corners[:, 0], all_corners[:, 2] - all_corners[:, 0])
    all_lengths = np.linalg.norm(all_cross, axis=1)
    all_normals = all_cross / np.where(all_lengths[:, None] == 0, 1.0, all_lengths[:, None])
    all_areas = all_lengths / 2
    surface_area = float(np.sum(all_areas))
    z_floor = float(points[:, 2].min())

    # down-facing overhang: normal points below horizontal by overhangDeg
    overhang_sin = math.sin(overhang_deg * math.pi / 180)
    # 阈值余量：正好 45° 的面（数学上恰在界上）在 float32/float64 之间只差 1 ULP，
    # 严格 `<` 会让它们的归属由浮点噪声决定——实测 toy-balance v069：8 个 45° 面
    # 合计 50.1mm²（占悬垂面积 3.4%）在两种实现间翻来覆去。界上的面按"可桥接"处理，
    # 不算悬垂；1e-9 的松弛比噪声大 7 个数量级，比任何有意义的角差小 7 个数量级。
    OVERHANG_SIN_SLACK = 1e-9
    overhang_mask = (all_normals[:, 2] < -(overhang_sin + OVERHANG_SIN_SLACK)) & (all_centroids[:, 2] - z_floor > 0.8)
    overhang_area = float(np.sum(all_areas[overhang_mask]))
    overhang_z_min = float(np.min(all_centroids[overhang_mask][:, 2])) if bool(overhang_mask.any()) else float("inf")
    overhang_z_max = float(np.max(all_centroids[overhang_mask][:, 2])) if bool(overhang_mask.any()) else float("-inf")

    # ---- wall thickness: sampled ray cast (the expensive half) --------------
    step = max(1, tri_count // target_samples)
    sampled_index = np.arange(0, tri_count, step)
    centroids = all_centroids[sampled_index]
    normals = all_normals[sampled_index]
    areas = all_areas[sampled_index]
    sampled = int(len(sampled_index))

    # wall thickness: from 0.05 outside the surface, march along -n; the FIRST hit is
    # the sample triangle's own plane (at ≈0.05, skipped), the SECOND is the opposite
    # wall → wall = distance − 0.05.
    min_wall = float("inf")
    min_wall_at = None
    thin_samples = 0
    thin_area = 0.0
    measured = 0
    # 每个低于阈值的采样面都要留下位置，聚类之后才可能被"指出来"。
    # 只报一个最薄点是本轮 toy-balance 漏检的直接原因：注意力没有落点。
    field_wall: list = []          # 全部测到壁厚的采样点（热力图的底图）
    thin_points: list = []
    thin_normals: list = []
    thin_walls: list = []
    thin_areas: list = []
    mesh = trimesh.Trimesh(vertices=points, faces=triangles, process=False)
    origins = centroids + normals * 0.05
    directions = -normals
    try:
        locations, index_ray, index_tri = mesh.ray.intersects_location(origins, directions, multiple_hits=True)
        distances = np.linalg.norm(locations - origins[index_ray], axis=1) if len(locations) else np.zeros(0)
    except BaseException:  # noqa: BLE001 - degenerate region: fall back to per-ray
        locations, index_ray, distances, index_tri = [], [], [], []
        for ray_index in range(sampled):
            try:
                hit, hit_ray, hit_tri = mesh.ray.intersects_location(origins[ray_index : ray_index + 1], directions[ray_index : ray_index + 1], multiple_hits=True)
                for point, tri in zip(hit, hit_tri):
                    locations.append(point)
                    index_ray.append(ray_index)
                    index_tri.append(int(tri))
                    distances.append(float(np.linalg.norm(point - origins[ray_index])))
            except BaseException:  # noqa: BLE001
                continue
        index_ray = np.asarray(index_ray, dtype=np.int64)
        index_tri = np.asarray(index_tri, dtype=np.int64)
        distances = np.asarray(distances, dtype=np.float64)

    # Group the hits per ray ONCE. The previous form re-filtered the whole hit array
    # per ray (`distances[index_ray == ray_index]`) and dropped the hit's triangle —
    # which is exactly the datum that says whether the hit IS a wall.
    index_tri = np.asarray(index_tri, dtype=np.int64).reshape(-1)
    if len(index_ray):
        order = np.argsort(index_ray, kind="stable")
        ray_sorted, tri_sorted, dist_sorted = index_ray[order], index_tri[order], distances[order]
    else:
        ray_sorted = tri_sorted = np.zeros(0, dtype=np.int64)
        dist_sorted = np.zeros(0, dtype=np.float64)
    ray_ids = np.arange(sampled)
    starts = np.searchsorted(ray_sorted, ray_ids, side="left")
    ends = np.searchsorted(ray_sorted, ray_ids, side="right")

    for ray_index in range(sampled):
        lo, hi = int(starts[ray_index]), int(ends[ray_index])
        if hi <= lo:
            continue
        t = dist_sorted[lo:hi]
        keep = t > 0.075                      # the sample triangle's own plane
        if not bool(keep.any()):
            continue
        t, tris = t[keep], tri_sorted[lo:hi][keep]
        # …and only hits that face BACK at us (the far side of the material)
        facing = (all_normals[tris] @ normals[ray_index]) < OPPOSITE_WALL_DOT
        if not bool(facing.any()):
            continue
        wall = float(t[facing].min()) - 0.05
        measured += 1
        field_wall.append((centroids[ray_index].copy(), wall))
        if wall < min_wall:
            min_wall = wall
            min_wall_at = [float(v) for v in centroids[ray_index]]
        if wall < wall_min_mm:
            thin_samples += 1
            thin_area += float(areas[ray_index])
            thin_points.append(centroids[ray_index].copy())
            thin_normals.append(normals[ray_index].copy())
            thin_walls.append(wall)
            thin_areas.append(float(areas[ray_index]))

    # the thin half is measured on a 1/step sample → scale it back to the surface
    thin_area *= tri_count / max(1, sampled)
    thin_area_pct = (thin_area / surface_area * 100.0) if surface_area > 0 else 0.0
    wall_measured = measured > 0

    # ---- 注意力场（attention field）----------------------------------------
    # 画面给人、摘要给 LLM，两者同源。这里只做几何分组与描述，不改判定：
    # 阈值、面积、verdict 全部照旧；新增的是"哪里、多大、下一步怎么复测"。
    layers: list = []
    scale = tri_count / max(1, sampled)
    if thin_points:
        pts = np.asarray(thin_points, dtype=np.float64)
        nrm = np.asarray(thin_normals, dtype=np.float64)
        try:
            from scipy.spatial import cKDTree
            pairs = cKDTree(pts).query_pairs(r=6.0, output_type="ndarray")
        except BaseException:  # noqa: BLE001 - 无 scipy 时退化成"一簇"，绝不静默丢弃
            pairs = np.zeros((0, 2), dtype=np.int64)
        parent = list(range(len(pts)))

        def _find(a: int) -> int:
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def _union(a: int, b: int) -> None:
            ra, rb = _find(a), _find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)

        for a, b in pairs:
            _union(int(a), int(b))
        groups: dict = {}
        for i in range(len(pts)):
            groups.setdefault(_find(i), []).append(i)

        clusters = []
        for idx in groups.values():
            sub = pts[idx]
            walls = np.asarray([thin_walls[i] for i in idx])
            j = int(np.argmin(walls))
            i_min = idx[j]
            n_min = nrm[i_min]
            out = pts[i_min] + n_min * 0.5          # 从表面外 0.5mm 起量
            clusters.append({
                "samples": len(idx),
                "minWallMm": round(float(walls[j]), 3),
                "atMm": [round(float(v), 2) for v in pts[i_min]],
                "normalMm": [round(float(v), 4) for v in n_min],
                "probeFromMm": [round(float(v), 3) for v in out],
                "bboxMm": [[round(float(v), 2) for v in sub.min(axis=0)],
                           [round(float(v), 2) for v in sub.max(axis=0)]],
                "areaMm2": round(float(sum(thin_areas[i] for i in idx)) * scale, 1),
            })
        clusters.sort(key=lambda c: c["minWallMm"])
        peaks = [{
            "atMm": c["atMm"],
            "value": c["minWallMm"],
            "normalMm": c["normalMm"],
            "evidence": f"{c['samples']} 个采样面低于 {wall_min_mm}mm，最薄 {c['minWallMm']:.2f}mm，约 {c['areaMm2']:.1f}mm²",
            "probe": {"tool": "measure_thickness",
                      "args": {"from": c["probeFromMm"],
                               "directionVector": [round(-v, 4) for v in c["normalMm"]]}},
        } for c in clusters[:6]]
        regions = []
        for c in sorted(clusters, key=lambda c: -c["areaMm2"])[:8]:
            ext = [c["bboxMm"][1][k] - c["bboxMm"][0][k] for k in range(3)]
            axis_i = int(np.argmin(ext))
            at = (c["bboxMm"][0][axis_i] + c["bboxMm"][1][axis_i]) / 2
            regions.append({
                "tier": "bad" if c["minWallMm"] < wall_min_mm * 0.4 else "warn",
                "areaMm2": c["areaMm2"],
                "samples": c["samples"],
                "minWallMm": c["minWallMm"],
                "atMm": c["atMm"],
                "bboxMm": c["bboxMm"],
                "look": {"tool": "render_part",
                         "args": {"section": {"axis": "xyz"[axis_i], "atMm": round(float(at), 2)}}},
            })
        layers.append({
            "id": "wall",
            "quantity": "wall-thickness",
            "units": "mm",
            "direction": "smaller-is-worse",
            "domain": {"kind": "surface-samples", "samples": sampled, "measured": int(measured)},
            "normalization": {"mode": "absolute", "warnAt": wall_min_mm,
                              "badAt": round(wall_min_mm * 0.4, 3), "source": "declared-arg"},
            "stats": {"minWallMm": round(float(min_wall), 3) if math.isfinite(min_wall) else None,
                      "thinSamples": thin_samples, "thinAreaMm2": round(float(thin_area), 1)},
            "peaks": peaks,
            "regions": regions,
        })
    else:
        layers.append({
            "id": "wall",
            "quantity": "wall-thickness",
            "units": "mm",
            "direction": "smaller-is-worse",
            "domain": {"kind": "surface-samples", "samples": sampled, "measured": int(measured)},
            "normalization": {"mode": "absolute", "warnAt": wall_min_mm,
                              "badAt": round(wall_min_mm * 0.4, 3), "source": "declared-arg"},
            "stats": {"minWallMm": round(float(min_wall), 3) if math.isfinite(min_wall) else None,
                      "thinSamples": 0, "thinAreaMm2": 0.0},
            "peaks": [],
            "regions": [],
        })

    if bool(overhang_mask.any()):
        over_tris = [int(t) for t in np.where(overhang_mask)[0]]
        edge_faces: dict = {}
        for t in over_tris:
            a, b, c = (int(x) for x in triangles[t])
            for u, v in ((a, b), (b, c), (c, a)):
                key = (u, v) if u < v else (v, u)
                edge_faces.setdefault(key, []).append(t)
        parent2 = {t: t for t in over_tris}

        def _find2(a: int) -> int:
            while parent2[a] != a:
                parent2[a] = parent2[parent2[a]]
                a = parent2[a]
            return a

        def _union2(a: int, b: int) -> None:
            ra, rb = _find2(a), _find2(b)
            if ra != rb:
                parent2[max(ra, rb)] = min(ra, rb)

        for faces_ in edge_faces.values():
            for other in faces_[1:]:
                _union2(faces_[0], other)
        groups2: dict = {}
        for t in over_tris:
            groups2.setdefault(_find2(t), []).append(t)
        patches = []
        for tris in groups2.values():
            verts = np.unique(triangles[tris].reshape(-1))
            vp = points[verts]
            area_p = float(np.sum(all_areas[tris]))
            if area_p <= 0:
                continue
            w = all_areas[tris]
            centroid = (all_centroids[tris] * w[:, None]).sum(axis=0) / area_p
            i_rep = int(tris[int(np.argmax(all_areas[tris]))])
            patches.append({
                "areaMm2": round(area_p, 1),
                "triangles": len(tris),
                "centroidMm": [round(float(v), 2) for v in centroid],
                "atMm": [round(float(v), 2) for v in all_centroids[i_rep]],
                "bboxMm": [[round(float(v), 2) for v in vp.min(axis=0)],
                           [round(float(v), 2) for v in vp.max(axis=0)]],
            })
        patches.sort(key=lambda p_: -p_["areaMm2"])
        z0 = float(points[:, 2].min())
        z1 = float(points[:, 2].max())

        def _look(p_: dict) -> dict:
            frac = (p_["centroidMm"][2] - z0) / max(1e-9, (z1 - z0))
            return {"tool": "render_part",
                    "args": {"section": {"axis": "z", "fraction": round(float(frac), 3)}}}

        layers.append({
            "id": "overhang",
            "quantity": "down-facing-area",
            "units": "mm2",
            "direction": "larger-is-more-support",
            "domain": {"kind": "triangles", "triangles": len(over_tris)},
            "normalization": {"mode": "absolute", "warnAt": 20.0, "source": "declared-arg"},
            "stats": {"areaMm2": round(float(overhang_area), 1),
                      "zRangeMm": ([round(float(overhang_z_min), 1), round(float(overhang_z_max), 1)]
                                   if math.isfinite(overhang_z_min) else [])},
            "peaks": [{"atMm": p_["atMm"], "value": p_["areaMm2"],
                       "evidence": f"{p_['areaMm2']:.0f}mm² 朝下悬垂（{p_['triangles']} 个三角面）",
                       "probe": _look(p_)} for p_ in patches[:6]],
            "regions": [{"tier": "warn", "areaMm2": p_["areaMm2"], "triangles": p_["triangles"],
                         "atMm": p_["centroidMm"], "bboxMm": p_["bboxMm"], "look": _look(p_)}
                        for p_ in patches[:8] if p_["areaMm2"] >= 5],
        })

    field_id = f"check_printability:s{sampled}-w{wall_min_mm}-o{overhang_deg}"

    field_payload = {
        "id": field_id,
        # 热力图要的是**完整底图**：壁上每个测过的地方有多厚（不只是薄的地方），
        # 以及每个三角面朝下到什么程度（不朝下的记 0）。只给"可疑的那些点"会让
        # 画面把整片未测区域按最近的可疑点着色——那是编造。
        "samples": {
            "wall": [
                {"p": [round(float(v), 3) for v in p_], "v": round(float(v_), 4)}
                for p_, v_ in field_wall
            ],
            "overhang": [
                {"p": [round(float(v), 3) for v in all_centroids[int(t)]],
                 "v": round(float(all_areas[int(t)]), 4) if bool(overhang_mask[int(t)]) else 0.0}
                for t in range(tri_count)
            ],
        },
        "normalization": {
            "wall": {"warnAt": wall_min_mm, "badAt": round(wall_min_mm * 0.4, 3),
                     "direction": "smaller-is-worse"},
            "overhang": {"warnAt": 20.0, "direction": "larger-is-more-support"},
        },
    }

    # ---- draft (molding): the FEASIBLE DRAW-DIRECTION CONE --------------------
    #
    # A face with unit normal n needs draft delta: the angle between the face and the
    # draw direction must be >= delta. With phi = the acute angle between n and the
    # direction's LINE, draft = 90 - phi, so the face is satisfied iff
    #     |n . d| >= sin(delta)
    # i.e. TWO SPHERICAL CAPS of angular radius (90 - delta) around +n and -n. The
    # part's feasible draw directions are the INTERSECTION of those caps over all faces.
    #
    # This replaces a withdrawn design that searched a fixed set of 26 directions and
    # reported the least-bad one. That design was a TAUTOLOGY: some candidate direction
    # is always parallel to a given face normal, so a zero-draft cube reported 0 mm2 of
    # violation (draw along a body diagonal and all six faces have 35 deg of draft).
    # It was withdrawn rather than shipped (DECISION-LOG 2026-10-11).
    #
    # EXACT where it matters: faces i,j are incompatible iff even the best of the four
    # sign choices fails, which reduces to
    #     acute_angle(line_i, line_j) > (90 - delta_i) + (90 - delta_j)
    # That is a PROOF of infeasibility with a witness pair — no sampling involved. The
    # non-empty side is a sampled estimate of the cone's size, and says so: proof for
    # exclusion, estimate for the positive side, as everywhere else here.
    #
    # Faces are merged by orientation first: a mesh has thousands of triangles but few
    # distinct normals, and the cone depends only on orientation.
    draft = None
    if params.get("draftMinDeg") is not None:
        delta_deg = float(params["draftMinDeg"])
        delta = math.radians(delta_deg)
        keep = all_areas > 1e-4                      # drop true degenerate slivers
        nrm, ar, ctr = all_normals[keep], all_areas[keep], all_centroids[keep]
        if len(nrm) > 0:
            key = np.round(nrm * 200.0).astype(np.int32)     # ~0.3 deg buckets
            _uniq, inv = np.unique(key, axis=0, return_inverse=True)
            nf = int(inv.max()) + 1
            area_f = np.zeros(nf)
            acc = np.zeros((nf, 3))
            rep = np.zeros((nf, 3))
            np.add.at(area_f, inv, ar)
            np.add.at(acc, inv, nrm * ar[:, None])
            biggest = np.zeros(nf)
            for f in range(len(ar)):                 # representative = the biggest face
                if ar[f] > biggest[inv[f]]:
                    biggest[inv[f]] = ar[f]
                    rep[inv[f]] = ctr[f]
            norm = np.linalg.norm(acc, axis=1, keepdims=True)
            dirs_f = acc / np.where(norm == 0, 1.0, norm)

            # COMPLETE decision. An earlier version tested PAIRS of faces only, which is
            # sufficient but NOT complete: a cube at delta=45 has an EMPTY cone that no
            # pair reveals (every pair is satisfiable at zero margin — +x and +y both get
            # exactly 45 deg along (0.707, 0.707, 0) — while the three mutually
            # perpendicular ones together need |d.x|^2+|d.y|^2+|d.z|^2 >= 1.5 > 1).
            #
            # A non-empty intersection of caps either CONTAINS a cap centre or has an
            # extreme point on two cap boundaries, i.e. a pairwise circle-circle
            # intersection. So 2k centres + O(k^2) intersections decide emptiness EXACTLY.
            #
            # (All faces share one delta, so the caps share one radius; if per-face draft
            #  ever arrives, the |rho_a - rho_b| term must return to the overlap test.)
            cap_radius = 90.0 - delta_deg
            rho = math.radians(cap_radius)
            cos_rho, sin_rho = math.cos(rho), math.sin(rho)
            centres = np.vstack([dirs_f, -dirs_f])
            candidates = [c for c in centres]
            k2 = len(centres)
            for a in range(k2):
                for b in range(a + 1, k2):
                    u, v = centres[a], centres[b]
                    gamma = math.acos(max(-1.0, min(1.0, float(u @ v))))
                    if gamma > 2.0 * rho + 1e-12:
                        continue
                    e = v - float(v @ u) * u
                    ne = float(np.linalg.norm(e))
                    if ne < 1e-12 or abs(sin_rho) < 1e-12:
                        continue
                    e = e / ne
                    w = np.cross(u, e)
                    cos_t = (cos_rho - cos_rho * float(u @ v)) / (sin_rho * float(e @ v))
                    if abs(cos_t) > 1.0 + 1e-9:
                        continue
                    t = math.acos(max(-1.0, min(1.0, cos_t)))
                    for sgn in (1.0, -1.0):
                        candidates.append(cos_rho * u + sin_rho * (math.cos(t * sgn) * e + math.sin(t * sgn) * w))

            cone_empty = True
            best_cand = None
            for cand in candidates:
                nlen = float(np.linalg.norm(cand))
                if nlen < 1e-12:
                    continue
                unit = cand / nlen
                margin_c = float((np.degrees(np.arcsin(np.clip(np.abs(dirs_f @ unit), 0.0, 1.0))) - delta_deg).min())
                if best_cand is None or margin_c > best_cand[0]:
                    best_cand = (margin_c, unit)
                if margin_c >= -1e-9:
                    cone_empty = False
                    break

            N = 20000                                    # Fibonacci sphere
            kk = np.arange(N) + 0.5
            zz = 1.0 - 2.0 * kk / N
            rr = np.sqrt(np.maximum(0.0, 1.0 - zz * zz))
            gg = math.pi * (1.0 + 5.0 ** 0.5) * kk
            sphere = np.stack([rr * np.cos(gg), rr * np.sin(gg), zz], axis=1)
            proj = np.abs(dirs_f @ sphere.T)                     # (nf, N)
            satisfied = proj >= math.sin(delta) - 1e-12
            feasible = satisfied.all(axis=0)
            margins = np.degrees(np.arcsin(np.clip(proj, 0.0, 1.0))) - delta_deg
            worst = margins.min(axis=0)
            best_k = int(np.argmax(worst))
            deficits = margins[:, best_k]
            constraining = []
            for f in np.argsort(deficits)[:3]:
                relaxed = np.delete(satisfied, int(f), axis=0).all(axis=0) if nf > 1 else np.ones(N, bool)
                constraining.append({
                    "atMm": [round(float(x), 2) for x in rep[f]],
                    "draftAtBestDeg": round(float(deficits[f] + delta_deg), 2),
                    "deficitDeg": round(float(-deficits[f]), 2),
                    "areaMm2": round(float(area_f[f]), 3),
                    "feasiblePctIfRelaxed": round(float(relaxed.mean() * 100.0), 2),
                })
            draft = {
                "requiredDraftDeg": delta_deg,
                "distinctOrientations": nf,
                "coneEmpty": cone_empty,
                "candidatesChecked": len(candidates),
                "bestCandidateMarginDeg": round(float(best_cand[0]), 3) if best_cand else None,
                "bestCandidateDirectionMm": [round(float(x), 4) for x in best_cand[1]] if best_cand else None,
                "feasiblePct": round(float(feasible.mean() * 100.0), 3),
                "bestDirectionMm": [round(float(x), 4) for x in sphere[best_k]],
                # margin = draft - delta, so draft = margin + delta. (An earlier version
                # wrote 90 - (margin + delta), subtracting 90 twice and reporting 55.11 deg
                # for a cube's body diagonal whose true worst-face draft is 34.9 deg.)
                "bestWorstDraftDeg": round(float(worst[best_k] + delta_deg), 2),
                "bestMarginDeg": round(float(worst[best_k]), 3),
                "constrainingFaces": constraining,
                "directionsSampled": N,
                "note": ("feasiblePct is a SAMPLED estimate of the cone; infeasibility is "
                         "proved separately by the pairwise contradiction test"),
            }

    findings = []
    if not watertight:
        findings.append(
            "mesh is NOT watertight — printability numbers below are computed on an open surface and are unreliable; fix the mesh first"
        )
    if not wall_measured:
        findings.append(
            f"壁厚**未测到**：{sampled} 个采样面沿内法线都没有打到对面壁。闭合实体不该出现这个结果，"
            "最可能是射线引擎不可用（trimesh 的 ray 需要 rtree）——**本次一个壁厚都没量过，"
            "下面的结论不能当通过读**；先修运行时（python_runtime action=repair）再重跑"
        )
    elif min_wall_at is not None and min_wall < wall_min_mm:
        where = ",".join(_js_to_fixed(v, 1) for v in min_wall_at)
        findings.append(
            f"最薄壁 {_js_to_fixed(min_wall, 2)}mm @ [{where}]（阈值 {wall_min_mm}mm；"
            f"{sampled} 个采样面中 {thin_samples} 个低于阈值，薄区≈{_js_to_fixed(thin_area, 1)}mm²"
            f"（占表面 {_js_to_fixed(thin_area_pct, 1)}%））"
            " — 薄**壳**（两自由面近似平行、成片）会断或翘；实心件收敛到棱线的**薄边**"
            "（翼型前后缘那种）不属此列，用薄区面积占比区分"
        )
    if overhang_area > 20:
        findings.append(
            f"{_js_to_fixed(overhang_area, 0)}mm² 朝下悬垂面比 {overhang_deg}° 更平"
            f"（z ∈ [{_js_to_fixed(overhang_z_min, 0)}, {_js_to_fixed(overhang_z_max, 0)}]）"
            " — 需要支撑、改打印朝向、或改成 45° 以内/桥接"
        )

    severe = (
        wall_measured
        and math.isfinite(min_wall)
        and min_wall < wall_min_mm * 0.4
        and thin_area >= max(UNPRINTABLE_MIN_THIN_AREA_MM2,
                             UNPRINTABLE_MIN_THIN_AREA_FRACTION * surface_area)
    )
    # `ok` means "this part passed the screen". A screen that could not measure the
    # wall has not passed anything, so it can never return `ok`.
    verdict = "unprintable" if severe else ("ok" if (wall_measured and not findings) else "check")
    return _json_safe({
        "verdict": verdict,
        **({"minWallMm": float(_js_to_fixed(min_wall, 3))} if math.isfinite(min_wall) else {}),
        # The LOCATION of the thinnest wall. A number is not a witness: "0.60mm" is
        # an argument, "[2.7,5.1,5.7]" is something a human can go and look at.
        **({"minWallAtMm": [float(_js_to_fixed(v, 2)) for v in min_wall_at]} if min_wall_at else {}),
        "wallMeasured": wall_measured,
        # tools.ts declares surfaceAreaMm2 as REQUIRED (and the band width
        # sqrt(area / sampled) is unreadable without it), but the value — already
        # computed above for `severe` — was never returned, so every reply failed
        # its own output schema.
        "surfaceAreaMm2": float(_js_to_fixed(surface_area, 2)),
        "thinSamples": thin_samples,
        "sampled": sampled,
        "thinAreaMm2": float(_js_to_fixed(thin_area, 1)),
        "thinAreaPct": float(_js_to_fixed(thin_area_pct, 2)),
        "overhangAreaMm2": float(_js_to_fixed(overhang_area, 1)),
        "overhangZRange": (
            [float(_js_to_fixed(overhang_z_min, 1)), float(_js_to_fixed(overhang_z_max, 1))]
            if math.isfinite(overhang_z_min)
            else []
        ),
        **({"draft": draft} if draft else {}),
        "findings": findings,
        "watertight": watertight,
        "attention": {"id": field_id, "layers": layers},
        # 逐采样点的场数据：只为面板画热力图。宿主会把它写进 run 文件并从
        # LLM 看到的返回值里剥掉——一个 700 点的场对模型是纯噪声，对画面是全部。
        **({"field": field_payload} if params.get("withSampleField") else {}),
    })


def op_scan_attention(params: dict) -> dict:
    """把注意力指向可能出错的几何（HARNESS §11.14 的第一块工具落点）。

    只做两件便宜的事，不碰求解器：

      P1 网格体检   是否闭合、几个连通体、退化面 —— 表示层的缺陷
      P2 内凹尖角   内凹棱的二面角 θ —— 几何层的应力集中 / 层间裂纹起点

    判据是几何的，不是工艺的：内凹棱的法向夹角 θ 越大，材料侧的凹角越尖。
      θ = 90°  → 直角凹槽（普通 T 形相交，FDM 常见，不报）
      θ = 135° → 45° 的 V 形缺口（toy-balance 吊盘肘部就是这一种）
      θ → 180° → 刀口缝

    输出是"去哪看"：每条结论都带坐标、包围盒与一句证据；它不是判定，也不排序
    零件的"好坏"。工具只负责把注意力放到位置上，改不改由设计判断。
    """
    import numpy as np
    import trimesh

    concave_min_deg = float(params.get("concaveMinDeg") or 100.0)
    min_chain_mm = float(params.get("minChainMm") or 0.5)

    raw = _parse_stl_raw(params["path"])
    vertices, faces, degenerate = _weld_raw(raw)
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    watertight = _is_watertight(triangles)

    # 焊接时塌掉的三角形（顶点两两重合，规则同 `_weld`）：不是"多出来的面"，而是回转体
    # 端盖扇／尖角处留下的零面积碎片。保留它们的工具（严格流形测试、部分切片器）会看到
    # 一堆互不相连的碎片甚至判非水密；丢掉它们的核（Manifold）量到的是同一个实体。
    # 两种说法都对，但**必须说清是哪一种**——toy-balance 的砝码 v058 就曾被记成
    # "769 分片的破网格"，而它的体积与重建版 v071 完全相同。
    raw_pts = np.asarray(raw, dtype=np.float64).reshape(-1, 3, 3)
    raw_keys = np.round(raw_pts * 1e5).astype(np.int64)
    collapsed = ((raw_keys[:, 0] == raw_keys[:, 1])
                 | (raw_keys[:, 1] == raw_keys[:, 2])
                 | (raw_keys[:, 0] == raw_keys[:, 2]))

    mesh = trimesh.Trimesh(vertices=points, faces=triangles, process=False)
    mesh.merge_vertices()

    suspects: list = []
    stats = {"faces": int(len(mesh.faces)), "watertight": bool(watertight)}

    # ---- P1 网格体检 -------------------------------------------------------
    bodies = mesh.split(only_watertight=False)
    body_faces = sorted((int(len(b.faces)) for b in bodies), reverse=True)
    stats["bodies"] = len(bodies)
    stats["body_faces"] = body_faces[:8]
    stats["degenerateFaces"] = int(degenerate)
    if degenerate:
        pts = raw_pts[collapsed] if bool(collapsed.any()) else raw_pts
        flat = pts.reshape(-1, 3)
        suspects.append({
            "kind": "degenerate-faces",
            "where": {"atMm": [round(float(v), 2) for v in flat.mean(axis=0)],
                      "bboxMm": [[round(float(v), 2) for v in flat.min(axis=0)],
                                 [round(float(v), 2) for v in flat.max(axis=0)]]},
            "why": (f"{degenerate} 个三角形在焊接后塌掉（顶点重合，零面积）——"
                    "保留它们的工具会报一堆不相连的碎片或非水密，丢掉它们的核量到的是同一个实体；"
                    "清掉它们只是去掉垃圾面，几何不变"),
            "severity": "look",
        })
    if not watertight:
        suspects.append({
            "kind": "non-manifold",
            "where": {"bboxMm": [[round(float(v), 2) for v in mesh.bounds[0]],
                                 [round(float(v), 2) for v in mesh.bounds[1]]]},
            "why": f"严格流形测试为 false；{len(bodies)} 个连通体（前几个的面数 {body_faces[:5]}）",
            "severity": "likely-defect",
        })
    elif len(bodies) > 1:
        extra = bodies[1]
        suspects.append({
            "kind": "multi-body",
            "where": {"atMm": [round(float(v), 2) for v in extra.centroid],
                      "bboxMm": [[round(float(v), 2) for v in extra.bounds[0]],
                                 [round(float(v), 2) for v in extra.bounds[1]]]},
            "why": f"{len(bodies)} 个互不相连的实体（第二大的体有 {body_faces[1]} 个三角面）",
            "severity": "likely-defect",
        })

    # ---- P2 内凹尖角 -------------------------------------------------------
    sharp_edges = 0
    chain_edge_ids: set = set()
    if watertight and len(mesh.faces):
        angles = np.degrees(np.asarray(mesh.face_adjacency_angles, dtype=np.float64))
        convex = np.asarray(mesh.face_adjacency_convex, dtype=bool)
        edges = np.asarray(mesh.face_adjacency_edges, dtype=np.int64)
        concave = ~convex
        sharp = concave & (angles > concave_min_deg)
        idx = np.where(sharp)[0]
        chain_edge_ids = set(int(k) for k in idx)
        sharp_edges = int(len(idx))
        stats["concave_edges"] = int(concave.sum())
        stats["sharp_concave_edges"] = sharp_edges
        if len(idx):
            parent = list(range(len(idx)))

            def _find(a: int) -> int:
                while parent[a] != a:
                    parent[a] = parent[parent[a]]
                    a = parent[a]
                return a

            def _union(a: int, b: int) -> None:
                ra, rb = _find(a), _find(b)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)

            by_vert: dict = {}
            for k, e in enumerate(idx):
                for v in edges[e]:
                    by_vert.setdefault(int(v), []).append(int(k))
            for group in by_vert.values():
                for other in group[1:]:
                    _union(group[0], other)

            chains: dict = {}
            for k in range(len(idx)):
                chains.setdefault(_find(k), []).append(k)

            for members in chains.values():
                length = 0.0
                pts = []
                thetas = []
                for k in members:
                    a, b = edges[idx[k]]
                    pa, pb = points[a], points[b]
                    length += float(np.linalg.norm(pb - pa))
                    pts.extend([pa, pb])
                    thetas.append(float(angles[idx[k]]))
                if length < min_chain_mm:
                    continue
                pts_a = np.asarray(pts)
                worst = max(thetas)
                center = pts_a.mean(axis=0)
                suspects.append({
                    "kind": "reentrant-corner",
                    "where": {
                        "atMm": [round(float(v), 2) for v in center],
                        "bboxMm": [[round(float(v), 2) for v in pts_a.min(axis=0)],
                                   [round(float(v), 2) for v in pts_a.max(axis=0)]],
                    },
                    "why": (f"内凹棱链：长 {length:.1f}mm，二面角最大 {worst:.0f}°"
                            f"（void 角 {180 - worst:.0f}°，材料侧 {180 + worst:.0f}°）——"
                            "应力集中/层间裂纹起点"),
                    "severity": "likely-defect" if worst >= 120 else "look",
                    "look": {"tool": "render_part", "args": {"section": {
                        "axis": "y", "atMm": round(float(center[1]), 2)}}},
                })

    # ---- P2b 闭合的非平面锐边环：布尔缝候选 --------------------------------
    # A boolean seam on a curved or angled cut is a CLOSED loop of sharp edges that
    # does not lie in one plane. Flat circular hole rims and 90-degree pocket rims
    # are excluded on purpose: on a molecule with 44 bond necks, counting every
    # closed loop painted 44 normal seams (measured 2026-10-29, C3 at 80 deg).
    # Keeping only NON-PLANAR loops keeps this layer quiet; it is a "look", not a
    # verdict, and it never tries to prove a boolean was wrong.
    loop_min_deg = 80.0
    closed_sharp_loops = 0
    nonplanar_seam_loops = 0
    seam_candidates: list = []
    if watertight and len(mesh.faces):
        sel = np.where(angles >= loop_min_deg)[0]
        loop_parent: dict = {}

        def lfind(a: int) -> int:
            loop_parent.setdefault(a, a)
            while loop_parent[a] != a:
                loop_parent[a] = loop_parent[loop_parent[a]]
                a = loop_parent[a]
            return a

        def lunion(a: int, b: int) -> None:
            ra, rb = lfind(a), lfind(b)
            if ra != rb:
                loop_parent[ra] = rb

        for e in sel:
            a, b = edges[e]
            lunion(int(a), int(b))
        loop_groups: dict = {}
        for e in sel:
            a, b = edges[e]
            loop_groups.setdefault(lfind(int(a)), []).append(int(e))

        for members in loop_groups.values():
            deg: dict = {}
            for e in members:
                a, b = edges[e]
                deg[int(a)] = deg.get(int(a), 0) + 1
                deg[int(b)] = deg.get(int(b), 0) + 1
            if not deg or not all(d == 2 for d in deg.values()):
                continue
            closed_sharp_loops += 1
            if set(members).issubset(chain_edge_ids):
                continue  # already reported as a reentrant-corner chain
            pts_l = points[list(deg.keys())]
            if pts_l.shape[0] < 3:
                continue
            ctr = pts_l.mean(axis=0)
            _, _, vt = np.linalg.svd(pts_l - ctr)
            dev = float(np.abs((pts_l - ctr) @ vt[-1]).max())
            span = float(np.linalg.norm(pts_l.max(axis=0) - pts_l.min(axis=0)))
            if span <= 1e-6 or dev / span <= 0.02:
                continue  # planar: a hole/pocket rim, not a seam
            length = sum(float(np.linalg.norm(points[edges[e][0]] - points[edges[e][1]])) for e in members)
            if length < max(min_chain_mm, 2.0):
                continue
            worst = max(float(angles[e]) for e in members)
            nonplanar_seam_loops += 1
            seam_candidates.append((length, {
                "kind": "boolean-seam",
                "where": {
                    "atMm": [round(float(v), 2) for v in ctr],
                    "bboxMm": [[round(float(v), 2) for v in pts_l.min(axis=0)],
                               [round(float(v), 2) for v in pts_l.max(axis=0)]],
                },
                "why": (f"闭合的非平面锐边环：长 {length:.1f}mm，二面角最大 {worst:.0f}°，"
                        f"平面度偏差 {dev:.2f}mm（跨度 {span:.1f}mm）——曲面/斜切上的布尔缝常见形态；"
                        "若这里不该有孔/槽，检查 difference 的 cutter 或 translate"),
                "severity": "look",
                "look": {"tool": "render_part", "args": {"section": {
                    "axis": "xyz"[int(np.argmax(pts_l.max(axis=0) - pts_l.min(axis=0)))],
                    "atMm": round(float(ctr[int(np.argmax(pts_l.max(axis=0) - pts_l.min(axis=0)))]), 2)}}},
            }))
    # Attention budget: a part with many radial holes can produce 2 seams per hole.
    # Keep the longest 8; the count is still reported in stats so "the rest" is not silent.
    seam_candidates.sort(key=lambda t: -t[0])
    for _, seam in seam_candidates[:8]:
        suspects.append(seam)
    stats["closed_sharp_loops"] = closed_sharp_loops
    stats["nonplanar_seam_loops"] = nonplanar_seam_loops

    order = {"likely-defect": 0, "look": 1}
    suspects.sort(key=lambda s: order.get(s["severity"], 2))
    return {"stats": stats, "suspects": suspects}


def op_measure_part(params: dict) -> dict:
    """Whole-part ground truth: bbox, volume, surface area, centre of mass, triangle
    count, watertightness, genus — the `measureVersion` of src/host/inspect.ts.

    Two details are contract, not implementation:

    * `-0` IS NOT REPORTED. A symmetric part's centroid coordinate rounds to `-0`,
      and `JSON.stringify(-0)` is `"0"`, so a `-0` used to make the tool result fail
      the harness's lossless-JSON check and `measure_part` errored on *every*
      symmetric part. `_round3` normalises it.
    * The Manifold CONSTRUCTOR is a validity gate: the TS version throws on a
      non-manifold mesh. This binding does not raise, so the status is checked
      explicitly — otherwise a broken mesh would report a plausible-looking volume.
    """
    import numpy as np
    from manifold3d import Error, Manifold, Mesh

    vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(params["path"]))
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(faces, dtype=np.int64).reshape(-1, 3)

    mesh = Mesh(np.asarray(points, dtype=np.float32), np.asarray(triangles, dtype=np.uint32))
    mesh.merge()
    solid = Manifold(mesh)
    status = solid.status()
    if status != Error.NoError:
        raise ValueError(f"STL is not a valid manifold solid: {status}")

    corners = points[triangles]
    # Surface area from triangle cross products (not from Manifold: the TS version
    # computes it on the parsed mesh, and the two must agree to the last digit).
    edge_u = corners[:, 1] - corners[:, 0]
    edge_v = corners[:, 2] - corners[:, 0]
    cross = np.cross(edge_u, edge_v)
    area = float(np.sum(np.linalg.norm(cross, axis=1) / 2))

    # Volume-weighted centroid: the signed tetrahedron sum about the origin.
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    vol6 = np.einsum("ij,ij->i", a, np.cross(b, c))
    total = float(np.sum(vol6))
    if total != 0:
        centre = np.sum((a + b + c) * vol6[:, None], axis=0) / (4 * total)
        center_of_mass = [float(centre[0]), float(centre[1]), float(centre[2])]
    else:
        center_of_mass = [0.0, 0.0, 0.0]

    low = points.min(axis=0)
    high = points.max(axis=0)
    return {
        "watertight": _is_watertight(triangles),
        "triangles": int(len(triangles)),
        "boundingBoxMm": {
            "min": [_round3(float(v)) for v in low],
            "max": [_round3(float(v)) for v in high],
            "size": [_round3(float(high[i] - low[i])) for i in range(3)],
        },
        "volumeMm3": _round3(float(solid.volume())),
        "surfaceAreaMm2": _round3(area),
        "centerOfMassMm": [_round3(v) for v in center_of_mass],
        "genus": int(solid.genus()),
    }


def _round3(value: float) -> float:
    """Round to the reported 0.001mm and normalise -0 to 0 (see op_measure_part).

    Uses JS `Math.round` semantics (ties toward +∞), not Python's banker's rounding:
    the TS version is `Math.round(v * 1000) / 1000`, and a coordinate landing exactly
    on a half must round the same way on both sides.
    """
    rounded = _js_round(value * 1000) / 1000
    return 0.0 if rounded == 0 else rounded


def op_simulate_motion(params: dict) -> dict:
    """Drive a mechanism and report kinematics + the exact interference timeline."""
    import numpy as np
    import rapier3d as R
    from manifold3d import Manifold, Mesh

    scenario = params["scenario"]
    dt = 1 / 2000
    # FRACTIONAL cycles are meaningful and must not be truncated: the design range of a
    # balance is ±14°, which is 0.078 of a turn. `int()` here silently turned a request
    # for a partial sweep into a whole revolution (or, below 1, into a single step) — the
    # caller asked one question and the tool answered another. The TS oracle never
    # truncated, so the two implementations also disagreed.
    #
    # `or 2` treated an explicit 0 as "default" (2 turns) while the TS oracle kept 0;
    # use the same `is None` rule on both sides. The host refuses cycles <= 0, so this
    # only matters for direct engine callers — and it must not invent a motion.
    requested_cycles = scenario.get("cycles")
    cycles = 2.0 if requested_cycles is None else float(requested_cycles)
    sample_per_cycle = int(scenario.get("samplePerCycle") or 24)
    oscillator_inputs = scenario.get("oscillators") or []
    drive = scenario.get("drive")
    omega = float((drive or {}).get("omegaRadPerSec") or 0)
    # No crank -> the time base is the prescribed mover's period (mirrors
    # src/host/motion.ts; 1 s only when there is no oscillator to ask either).
    if omega > 0:
        cycle_period = (2 * math.pi) / omega
    else:
        _periods = [
            float(o["periodSec"]) for o in (scenario.get("oscillators") or [])
            if not o.get("pitchRadiusMm") and isinstance(o.get("periodSec"), (int, float)) and float(o["periodSec"]) > 0
        ]
        cycle_period = max(_periods) if _periods else 1.0
    total_sec = cycles * cycle_period
    steps = max(1, int(round(total_sec / dt)))
    # Interference is an EXACT Manifold boolean per sampled pose. "24 per crank
    # cycle" is a density per PERIOD, not per RUN: a 0.03-cycle working sweep got
    # sample_every = 1047 steps against 754 total, so the loop below never sampled
    # a pose — zero interference checks — while `interferenceCount = 0` and
    # `clean = True` still reported pass. Cap the interval so every run gets at
    # least MIN_MOTION_INTERFERENCE_POSES samples, and always include the final
    # pose (the end of travel is where a stop/collision lives).
    MIN_MOTION_INTERFERENCE_POSES = 24
    sample_every_by_cycle = max(1, int(round((cycle_period / sample_per_cycle) / dt)))
    sample_every_by_floor = max(1, (steps - 1) // (MIN_MOTION_INTERFERENCE_POSES - 1))
    sample_every = max(1, min(sample_every_by_cycle, sample_every_by_floor))

    world = R.PhysicsWorld((0.0, 0.0, 0.0))
    world.integration_parameters.dt = dt

    bodies: dict = {}
    base_pose: dict = {}
    welded: dict = {}
    for part in scenario["parts"]:
        name = part["name"]
        quaternion = _euler_to_quat(part.get("rotation") or [0, 0, 0])
        base_pose[name] = {"p": [float(v) for v in part["position"]], "q": quaternion}
        is_drive = bool(drive) and drive.get("body") == name
        if part["bodyType"] == "fixed":
            builder = R.RigidBody.fixed()
        elif is_drive:
            # velocity-integrated kinematic: setAngvel persists and is exact
            builder = R.RigidBody.kinematic_velocity_based()
        elif part["bodyType"] == "kinematic" or any(o["body"] == name for o in oscillator_inputs):
            builder = R.RigidBody.kinematic_position_based()
        else:
            # Collider-less dynamic body: translational mass alone breaks the joint
            # solver (zero rotational inertia → constraint drift), so give it an
            # AABB-estimated inertia tensor (m = 1 kg, box approximation).
            vertices, faces = _welded_mesh(part["path"])
            welded[name] = (vertices, faces)
            low = vertices.min(axis=0)
            high = vertices.max(axis=0)
            ex = max(1e-3, float(high[0] - low[0]))
            ey = max(1e-3, float(high[1] - low[1]))
            ez = max(1e-3, float(high[2] - low[2]))
            # `additional_mass_properties` takes a MassProperties OBJECT here (the
            # positional mass/com/inertia form of the JS API does not exist), and
            # MassProperties itself only constructs with keyword arguments.
            mass_properties = R.MassProperties(
                mass=1.0,
                local_com=R.Vec3(0.0, 0.0, 0.0),
                principal_inertia=((ey * ey + ez * ez) / 12, (ex * ex + ez * ez) / 12, (ex * ex + ey * ey) / 12),
            )
            builder = R.RigidBody.dynamic().additional_mass_properties(mass_properties).can_sleep(False)
        builder = builder.translation(tuple(float(v) for v in part["position"]))
        builder = builder.rotation(tuple(R.Rotation3.from_quaternion(quaternion[3], quaternion[0], quaternion[1], quaternion[2]).scaled_axis))
        bodies[name] = world.add_body(builder)
        if name not in welded:
            welded[name] = _welded_mesh(part["path"])

    if drive:
        axis = _norm3(drive["axis"])
        world.rigid_bodies[bodies[drive["body"]]].angvel = (axis[0] * omega, axis[1] * omega, axis[2] * omega)

    for joint in scenario["joints"]:
        a = bodies.get(joint["bodyA"])
        b = bodies.get(joint["bodyB"])
        if a is None or b is None:
            raise ValueError(f"motion: joint references unknown body ({joint['bodyA']}, {joint['bodyB']})")
        axis = _norm3(joint["axis"])
        anchor_a = tuple(float(v) for v in joint["anchorA"])
        anchor_b = tuple(float(v) for v in joint["anchorB"])
        if joint["type"] == "prismatic":
            builder = R.PrismaticJoint.builder(axis=tuple(axis)).local_anchor1(anchor_a).local_anchor2(anchor_b)
            if joint.get("limits"):
                builder = builder.limits(float(joint["limits"][0]), float(joint["limits"][1]))
        else:
            builder = R.RevoluteJoint.builder(axis=tuple(axis)).local_anchor1(anchor_a).local_anchor2(anchor_b)
        world.impulse_joints.insert(a, b, builder.build())

    oscillators = []
    for entry in oscillator_inputs:
        coupled = isinstance(entry.get("pitchRadiusMm"), (int, float)) and math.isfinite(float(entry["pitchRadiusMm"])) and float(entry["pitchRadiusMm"]) != 0
        if not coupled and not isinstance(entry.get("amplitudeMm"), (int, float)):
            raise ValueError(f'oscillator for "{entry["body"]}" needs amplitudeMm (sinusoidal) or pitchRadiusMm (rack & pinion)')
        if coupled and not drive:
            raise ValueError(f'oscillator for "{entry["body"]}" is rack-coupled (pitchRadiusMm) but the scenario has no drive to follow')
        if not coupled and not (entry.get("periodSec") and float(entry["periodSec"]) > 0):
            raise ValueError(f'oscillator for "{entry["body"]}" needs a positive periodSec')
        oscillators.append(
            {
                "body": bodies[entry["body"]],
                "axis": _norm3(entry["axis"]),
                "base": base_pose[entry["body"]]["p"],
                "amplitude": float(entry.get("amplitudeMm") or 0),
                "w": 0.0 if coupled else (2 * math.pi) / float(entry["periodSec"]),
                "coupled": coupled,
                "phi": float(entry.get("phaseRad") or 0),
                "r": float(entry["pitchRadiusMm"]) if coupled else 0.0,
            }
        )

    milestone_angles = [math.pi / 2, math.pi, (3 * math.pi) / 2]
    milestone_steps = {}
    for angle in milestone_angles:
        step = int(round((angle / omega) / dt)) if omega > 0 else 0
        if 0 < step < steps:
            milestone_steps[step] = f"crank{int(round(angle * 180 / math.pi))}"

    sample_times: list = []
    sample_steps: list = []
    sample_poses: list = []
    milestone_poses: dict = {}
    diverged = False

    warm_up_steps = max(1, min(int(round(steps * 0.05)), int(math.ceil(0.1 / dt))))
    warm = 0
    travel_lo: dict = {}
    travel_hi: dict = {}

    def seed_travel() -> None:
        for part in scenario["parts"]:
            if part["bodyType"] == "fixed":
                continue
            translation = world.rigid_bodies[bodies[part["name"]]].translation
            travel_lo[part["name"]] = [float(translation[i]) for i in range(3)]
            travel_hi[part["name"]] = [float(translation[i]) for i in range(3)]

    def track_travel() -> None:
        if warm < warm_up_steps:
            return
        for part in scenario["parts"]:
            if part["bodyType"] == "fixed":
                continue
            translation = world.rigid_bodies[bodies[part["name"]]].translation
            low = travel_lo[part["name"]]
            high = travel_hi[part["name"]]
            for axis in range(3):
                value = float(translation[axis])
                if value < low[axis]:
                    low[axis] = value
                elif value > high[axis]:
                    high[axis] = value

    seed_travel()
    for i in range(steps):
        t = (i + 1) * dt
        for oscillator in oscillators:
            s = oscillator["r"] * (omega * t + oscillator["phi"]) if oscillator["coupled"] else oscillator["amplitude"] * math.sin(oscillator["w"] * t + oscillator["phi"])
            world.rigid_bodies[oscillator["body"]].set_next_kinematic_translation(
                (
                    oscillator["base"][0] + oscillator["axis"][0] * s,
                    oscillator["base"][1] + oscillator["axis"][1] * s,
                    oscillator["base"][2] + oscillator["axis"][2] * s,
                )
            )
        world.step()
        warm += 1
        if warm == warm_up_steps:
            seed_travel()
        track_travel()

        if (i + 1) % sample_every == 0 or (i + 1) == steps:
            sample_times.append(t)
            sample_steps.append(i + 1)
            poses = {}
            for part in scenario["parts"]:
                body = world.rigid_bodies[bodies[part["name"]]]
                translation = body.translation
                rotation = body.rotation.quaternion
                poses[part["name"]] = {
                    "position": [float(translation[0]), float(translation[1]), float(translation[2])],
                    "rotation": [float(rotation[0]), float(rotation[1]), float(rotation[2]), float(rotation[3])],
                }
                if not all(math.isfinite(translation[a]) for a in range(3)):
                    diverged = True
            sample_poses.append(poses)

        if (i + 1) in milestone_steps:
            poses = {}
            for part in scenario["parts"]:
                body = world.rigid_bodies[bodies[part["name"]]]
                translation = body.translation
                rotation = body.rotation.quaternion
                poses[part["name"]] = {
                    "position": [float(translation[0]), float(translation[1]), float(translation[2])],
                    "rotation": [float(rotation[0]), float(rotation[1]), float(rotation[2]), float(rotation[3])],
                }
            milestone_poses[i + 1] = {"label": milestone_steps[i + 1], "poses": poses}

    # ---- interference timeline (exact Manifold booleans per sampled pose) ----
    is_fixed = {part["name"]: part["bodyType"] == "fixed" for part in scenario["parts"]}
    fixed_world: dict = {}
    for part in scenario["parts"]:
        if part["bodyType"] != "fixed":
            continue
        vertices, _faces = welded[part["name"]]
        pose = base_pose[part["name"]]
        fixed_world[part["name"]] = _transform_points(vertices, _quat_to_matrix3(pose["q"]), pose["p"])

    fixed_manifold: dict = {}
    for part in scenario["parts"]:
        if part["bodyType"] != "fixed":
            continue
        vertices, faces = welded[part["name"]]
        fixed_manifold[part["name"]] = Manifold(Mesh(np.asarray(fixed_world[part["name"]], dtype=np.float32), np.asarray(faces, dtype=np.uint32)))

    interference_events = []
    interference_count = 0
    first_interference_sample = -1

    revolute_linked = {
        "\u0000".join(sorted([joint["bodyA"], joint["bodyB"]]))
        for joint in scenario["joints"]
        if joint["type"] == "revolute"
    }
    pairs = []
    for index, first in enumerate(scenario["parts"]):
        for second in scenario["parts"][index + 1 :]:
            if is_fixed[first["name"]] and is_fixed[second["name"]]:
                continue
            if "\u0000".join(sorted([first["name"], second["name"]])) in revolute_linked:
                continue
            pairs.append((first["name"], second["name"]))

    for k, poses in enumerate(sample_poses):
        verts: dict = {}
        boxes: dict = {}
        for part in scenario["parts"]:
            name = part["name"]
            vertices, _faces = welded[name]
            if is_fixed[name]:
                world_vertices = fixed_world[name]
            else:
                pose = poses[name]
                world_vertices = _transform_points(vertices, _quat_to_matrix3(pose["rotation"]), pose["position"])
            verts[name] = world_vertices
            boxes[name] = (world_vertices.min(axis=0), world_vertices.max(axis=0))

        for a_name, b_name in pairs:
            if not _aabb_overlap(boxes[a_name], boxes[b_name]):
                continue
            manifold_a = fixed_manifold.get(a_name)
            if manifold_a is None:
                faces = welded[a_name][1]
                manifold_a = Manifold(Mesh(np.asarray(verts[a_name], dtype=np.float32), np.asarray(faces, dtype=np.uint32)))
            manifold_b = fixed_manifold.get(b_name)
            if manifold_b is None:
                faces = welded[b_name][1]
                manifold_b = Manifold(Mesh(np.asarray(verts[b_name], dtype=np.float32), np.asarray(faces, dtype=np.uint32)))
            intersection = manifold_a ^ manifold_b
            volume = 0.0 if intersection.is_empty() else float(intersection.volume())
            if volume > 1e-3:
                interference_count += 1
                time_sec = sample_times[k]
                interference_events.append(
                    {
                        "step": sample_steps[k],
                        "timeSec": time_sec,
                        "partA": a_name,
                        "partB": b_name,
                        "volumeMm3": round(volume, 3),
                    }
                )
                if first_interference_sample < 0:
                    first_interference_sample = k
    interference_events.sort(key=lambda event: (event["step"], -event["volumeMm3"]))

    # ---- followers: every part that is not fixed and not the drive body ----
    followers = {}
    followers_detail = {}
    # Mean spacing of the ACTUAL samples. The mandatory final pose can sit closer
    # than `sample_every`, so the uniform `sample_every * dt` would bias the period
    # estimate on short runs.
    sample_dt = (
        (sample_times[-1] - sample_times[0]) / (len(sample_times) - 1)
        if len(sample_times) > 1
        else sample_every * dt
    )
    record_set = set(scenario.get("recordParts") or [])
    for part in scenario["parts"]:
        name = part["name"]
        if part["bodyType"] == "fixed":
            continue
        if drive and drive.get("body") == name:
            continue
        ranges = [travel_hi[name][axis] - travel_lo[name][axis] for axis in range(3)]
        axis_index = 0 if ranges[0] >= ranges[1] and ranges[0] >= ranges[2] else (1 if ranges[1] >= ranges[2] else 2)
        axis_name = ("x", "y", "z")[axis_index]
        values = [round(poses[name]["position"][axis_index], 4) for poses in sample_poses]
        followers[name] = {
            "travelMm": round(ranges[axis_index], 3),
            "axis": axis_name,
            "periodSec": _period_from_samples(values, sample_dt),
        }
        if name in record_set:
            followers_detail[name] = {"t": [round(t, 4) for t in sample_times], "vals": values, "axis": axis_name}

    # ---- joint drift (final pose) ----
    max_joint_drift = 0.0
    joint_violations = []
    for joint in scenario["joints"]:
        a = bodies[joint["bodyA"]]
        b = bodies[joint["bodyB"]]
        wa = _world_anchor(world, a, joint["anchorA"])
        wb = _world_anchor(world, b, joint["anchorB"])
        drift = math.hypot(wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2])
        if joint["type"] == "prismatic":
            axis = _norm3(joint["axis"])
            delta = [wa[i] - wb[i] for i in range(3)]
            along = sum(delta[i] * axis[i] for i in range(3))
            drift = math.hypot(*[delta[i] - along * axis[i] for i in range(3)])
        if drift > max_joint_drift:
            max_joint_drift = drift
        if drift > 2:
            joint_violations.append(f"{joint['bodyA']}↔{joint['bodyB']}: anchor drift {drift:.2f}mm")

    # ---- keyframes: initial + crank milestones + first interference + final ----
    keyframes = []
    initial = {
        part["name"]: {"position": base_pose[part["name"]]["p"], "rotation": list(base_pose[part["name"]]["q"])}
        for part in scenario["parts"]
    }
    keyframes.append({"step": 0, "timeSec": 0, "label": "crank0", "poses": initial})
    for step, milestone in sorted(milestone_poses.items()):
        keyframes.append({"step": step, "timeSec": round(step * dt, 4), "label": milestone["label"], "poses": milestone["poses"]})
    if first_interference_sample >= 0:
        k = first_interference_sample
        keyframes.append(
            {
                "step": sample_steps[k],
                "timeSec": round(sample_times[k], 4),
                "label": "interference",
                "poses": sample_poses[k],
            }
        )
    if sample_poses:
        k = len(sample_poses) - 1
        keyframes.append({"step": steps, "timeSec": round(sample_times[k], 4), "label": "final", "poses": sample_poses[k]})

    # Coverage is part of the verdict: zero sampled poses means zero interference
    # checks, and "no counter-example" must never print as pass (DESIGN §25.7).
    interference_checks = len(sample_poses)
    candidate_pairs = len(pairs)
    interference_pair_checks = interference_checks * candidate_pairs
    sampling_satisfied = interference_checks >= MIN_MOTION_INTERFERENCE_POSES
    max_sample_gap_deg = round(360.0 * sample_every * dt / cycle_period, 2) if omega > 0 else None

    clean = (
        interference_count == 0
        and not diverged
        and max_joint_drift <= 2
        and sampling_satisfied
    )

    trajectory_frames = [initial] + sample_poses
    trajectory = {
        "times": [round(t, 4) for t in [0.0] + sample_times],
        "parts": [
            {
                "name": part["name"],
                "bodyType": part["bodyType"],
                "frames": [
                    [
                        frame[part["name"]]["position"][0],
                        frame[part["name"]]["position"][1],
                        frame[part["name"]]["position"][2],
                        frame[part["name"]]["rotation"][0],
                        frame[part["name"]]["rotation"][1],
                        frame[part["name"]]["rotation"][2],
                        frame[part["name"]]["rotation"][3],
                    ]
                    for frame in trajectory_frames
                ],
            }
            for part in scenario["parts"]
        ],
        "events": [
            {"timeSec": event["timeSec"], "label": f"干涉:{event['partA']}↔{event['partB']} {event['volumeMm3']:.1f}mm³"}
            for event in interference_events[:20]
        ],
    }

    return {
        "overallStatus": "pass" if clean else "check",
        "metrics": {
            "driveOmegaRadPerSec": float(drive["omegaRadPerSec"]) if drive and drive.get("omegaRadPerSec") is not None else None,
            "cyclePeriodSec": round(cycle_period, 4) if omega > 0 else None,
            "followers": followers,
            "interferenceCount": interference_count,
            "interferenceEvents": interference_events[:20],
            "interferenceChecks": interference_checks,
            "candidatePairs": candidate_pairs,
            "interferencePairChecks": interference_pair_checks,
            "samplingSatisfied": sampling_satisfied,
            "maxSampleGapDeg": max_sample_gap_deg,
            "maxJointDriftMm": round(max_joint_drift, 4),
            "jointViolations": joint_violations,
            "diverged": diverged,
        },
        "followersDetail": followers_detail,
        "keyframes": keyframes[:8],
        "trajectory": trajectory,
        "stepsRun": steps,
        "durationSec": round(total_sec, 3),
    }


def _world_anchor(world, handle, local) -> list:
    body = world.rigid_bodies[handle]
    matrix = _quat_to_matrix3(body.rotation.quaternion)
    translation = body.translation
    return [
        float(translation[i]) + matrix[i][0] * float(local[0]) + matrix[i][1] * float(local[1]) + matrix[i][2] * float(local[2])
        for i in range(3)
    ]


def op_simulate_physics(params: dict) -> dict:
    """Step a rigid-body scenario and report what happened.

    Everything about the WORLD (gravity, timestep, bodies, joints, contact sampling)
    and the REPORT (penetration, toppled, settled, joint violations, keyframes,
    trajectory) lives here; the caller keeps schema, rendering and storage.
    """
    import numpy as np
    import rapier3d as R

    scenario = params["scenario"]
    gravity = [float(v) for v in (scenario.get("gravity") or [0.0, 0.0, -9810.0])]
    dt = float(scenario.get("timestepSec") or 1 / 60)
    duration = float(scenario.get("durationSec") or 2)
    steps = max(1, int(round(duration / dt)))
    keyframe_budget = int(scenario.get("keyframeCount") or 6)
    keyframe_every = max(1, int(steps // keyframe_budget))

    world = R.PhysicsWorld(tuple(gravity))
    world.integration_parameters.dt = dt

    bodies: dict = {}
    colliders: dict = {}
    fell_over_checks: list = []
    initial_pos: dict = {}

    for part in scenario["parts"]:
        name = part["name"]
        if part["bodyType"] == "fixed":
            builder = R.RigidBody.fixed()
        else:
            builder = R.RigidBody.dynamic().can_sleep(False).ccd_enabled(True)
        builder = builder.translation(tuple(float(v) for v in part["position"]))
        if part.get("rotation"):
            builder = builder.rotation(_scaled_axis_of_euler(part["rotation"]))
        body = world.add_body(builder)
        raw = _parse_stl_raw(part["path"])
        if part["bodyType"] == "dynamic":
            collider = world.add_collider(
                R.Collider.convex_hull(raw.reshape(-1, 3)).density(float(part.get("density") or 1.05e-6)), body
            )
            if part.get("initialAngularVelocity"):
                world.rigid_bodies[body].angvel = tuple(float(v) for v in part["initialAngularVelocity"])
            if part.get("fellOverCheck", True) is not False:
                fell_over_checks.append(name)
        elif _is_convex(part["path"]):
            # CCD does not help a fixed body against a trimesh collider, so convex
            # fixed geometry MUST be a convex hull (robust + fast).
            collider = world.add_collider(R.Collider.convex_hull(raw.reshape(-1, 3)), body)
        else:
            vertices, faces, _degenerate = _weld_raw(raw)
            collider = world.add_collider(
                R.Collider.trimesh(np.asarray(vertices, dtype=np.float32), np.asarray(faces, dtype=np.uint32)), body
            )
        bodies[name] = body
        colliders[name] = collider
        initial_pos[name] = [float(v) for v in part["position"]]

    joint_anchors = []
    for joint in scenario.get("joints") or []:
        a = bodies.get(joint["bodyA"])
        b = bodies.get(joint["bodyB"])
        if a is None:
            raise ValueError(f"joint references unknown part: {joint['bodyA']}")
        if b is None:
            raise ValueError(f"joint references unknown part: {joint['bodyB']}")
        anchor_a = tuple(float(v) for v in joint["anchorA"])
        anchor_b = tuple(float(v) for v in joint["anchorB"])
        axis = tuple(float(v) for v in joint["axis"])
        if joint["type"] == "prismatic":
            builder = R.PrismaticJoint.builder(axis=axis).local_anchor1(anchor_a).local_anchor2(anchor_b)
            if joint.get("limits"):
                builder = builder.limits(float(joint["limits"][0]), float(joint["limits"][1]))
        else:
            builder = R.RevoluteJoint.builder(axis=axis).local_anchor1(anchor_a).local_anchor2(anchor_b)
        world.impulse_joints.insert(a, b, builder.build())
        joint_anchors.append(
            {
                "name": f"{joint['bodyA']}~{joint['bodyB']}",
                "type": joint["type"],
                "a": a,
                "b": b,
                "anchorA": anchor_a,
                "anchorB": anchor_b,
                "axis": axis,
            }
        )

    dynamic_names = [p["name"] for p in scenario["parts"] if p["bodyType"] == "dynamic"]
    fixed_names = [p["name"] for p in scenario["parts"] if p["bodyType"] == "fixed"]
    pair_colliders = []
    for i, first in enumerate(dynamic_names):
        for second in dynamic_names[i + 1 :]:
            pair_colliders.append((colliders[first], colliders[second]))
        for fixed in fixed_names:
            pair_colliders.append((colliders[first], colliders[fixed]))

    max_penetration = 0.0
    settled_penetration = 0.0
    settle_from = int(steps * 0.9)

    def pose_of(name: str) -> dict:
        body = world.rigid_bodies[bodies[name]]
        translation = body.translation
        rotation = body.rotation.quaternion
        return {
            "position": [float(translation[0]), float(translation[1]), float(translation[2])],
            "rotation": [float(rotation[0]), float(rotation[1]), float(rotation[2]), float(rotation[3])],
        }

    event_steps: dict = {}

    def note_step(step: int, reason: str) -> None:
        previous = event_steps.get(step)
        event_steps[step] = f"{previous}|{reason}" if previous else reason

    note_step(0, "start")

    max_pen_step = -1
    topple_noted = set()
    traj_every = max(1, int(math.ceil(steps / 160)))
    traj_times: list = []
    traj_poses: list = []

    def record_traj(step: int) -> None:
        traj_times.append(round(step * dt, 4))
        traj_poses.append({p["name"]: pose_of(p["name"]) for p in scenario["parts"]})

    for step in range(steps + 1):
        if not params.get("skipContacts"):
            for first, second in pair_colliders:
                pair = world.narrow_phase.contact_pair(first, second)
                if not pair:
                    continue
                for manifold in pair.manifolds:
                    for point in manifold.points:
                        distance = float(point.dist)
                        if distance < max_penetration:
                            max_penetration = distance
                            max_pen_step = step
                        if step >= settle_from and distance < settled_penetration:
                            settled_penetration = distance

        # Collision events would label first contacts here, but the TS incumbent
        # never enables ActiveEvents.COLLISION_EVENTS, so its EventQueue is always
        # empty and this label was unreachable. Mirroring that keeps keyframes
        # identical; enabling it is a behaviour change, not a migration, and is
        # left as an explicit follow-up (see the execution summary).
        for name in fell_over_checks:
            if name in topple_noted:
                continue
            rotation = pose_of(name)["rotation"]
            if _up_tilt_degrees(rotation) > 30:
                topple_noted.add(name)
                note_step(step, f"倾倒:{name}")

        if step % traj_every == 0:
            record_traj(step)
        if step < steps:
            world.step()

    if traj_times[-1] != round(steps * dt, 4):
        record_traj(steps)
    if max_pen_step >= 0:
        note_step(max_pen_step, "最大穿透")
    note_step(steps, "final")

    budget = keyframe_budget
    min_gap = max(1, int(steps // (budget * 4)))
    chosen: dict = {}
    for step in sorted(event_steps.keys()):
        if len(chosen) >= budget:
            break
        if not any(abs(k - step) < min_gap for k in chosen):
            chosen[step] = event_steps[step]
    if len(chosen) < budget:
        step = 0
        while step <= steps and len(chosen) < budget:
            if step not in chosen and not any(abs(k - step) < min_gap for k in chosen):
                chosen[step] = "context"
            step += keyframe_every
    if steps not in chosen:
        best = None
        for key, label in chosen.items():
            if label == "context" and (best is None or abs(key - steps) < abs(best - steps)):
                best = key
        if best is not None:
            del chosen[best]
        chosen[steps] = "final"

    def pose_at(step: int) -> dict:
        index = min(len(traj_poses) - 1, max(0, int(round(step / traj_every))))
        return traj_poses[index]

    keyframes = [
        {"step": step, "timeSec": round(step * dt, 3), "label": label, "poses": pose_at(step)}
        for step, label in sorted(chosen.items())
    ]

    fell_over = {}
    max_horizontal = {}
    final_positions = {}
    any_moving = False
    for name in fell_over_checks:
        fell_over[name] = _up_tilt_degrees(pose_of(name)["rotation"]) > 60
    for part in scenario["parts"]:
        name = part["name"]
        pose = pose_of(name)
        final_positions[name] = pose["position"]
        start = initial_pos[name]
        max_horizontal[name] = round(math.hypot(pose["position"][0] - start[0], pose["position"][2] - start[2]), 3)
        if part["bodyType"] == "dynamic":
            velocity = world.rigid_bodies[bodies[name]].linvel
            if math.hypot(float(velocity[0]), float(velocity[1]), float(velocity[2])) > 5:
                any_moving = True

    def world_point(handle, local) -> list:
        body = world.rigid_bodies[handle]
        matrix = _quat_to_matrix3(body.rotation.quaternion)
        translation = body.translation
        return [
            float(translation[i]) + matrix[i][0] * local[0] + matrix[i][1] * local[1] + matrix[i][2] * local[2]
            for i in range(3)
        ]

    joint_violations = []
    for joint in joint_anchors:
        point_a = world_point(joint["a"], joint["anchorA"])
        point_b = world_point(joint["b"], joint["anchorB"])
        delta = [point_a[i] - point_b[i] for i in range(3)]
        if joint["type"] == "prismatic":
            # A slider is SUPPOSED to let the anchors separate along its axis; only
            # motion ACROSS the axis is a violation.
            matrix = _quat_to_matrix3(world.rigid_bodies[joint["a"]].rotation.quaternion)
            axis = [sum(matrix[i][j] * joint["axis"][j] for j in range(3)) for i in range(3)]
            length = math.hypot(*axis) or 1.0
            unit = [value / length for value in axis]
            along = sum(delta[i] * unit[i] for i in range(3))
            perpendicular = math.hypot(*[delta[i] - along * unit[i] for i in range(3)])
            if perpendicular > 2:
                joint_violations.append(f"{joint['name']}: slide left its axis by {perpendicular:.2f}mm")
            continue
        drift = math.hypot(*delta)
        if drift > 2:
            joint_violations.append(f"{joint['name']}: anchor drift {drift:.2f}mm")

    trajectory = {
        "times": traj_times,
        "parts": [
            {
                "name": part["name"],
                "bodyType": part["bodyType"],
                "frames": [
                    [
                        poses[part["name"]]["position"][0],
                        poses[part["name"]]["position"][1],
                        poses[part["name"]]["position"][2],
                        poses[part["name"]]["rotation"][0],
                        poses[part["name"]]["rotation"][1],
                        poses[part["name"]]["rotation"][2],
                        poses[part["name"]]["rotation"][3],
                    ]
                    for poses in traj_poses
                ],
            }
            for part in scenario["parts"]
        ],
        "events": [
            {"timeSec": round(step * dt, 3), "label": label}
            for step, label in sorted(chosen.items())
            if label != "context"
        ],
    }

    # Honest-input diagnostics: a many-shell body with sparse ground contact reports
    # a settled penetration that is a solver artefact, not a fit measurement.
    notes = []
    total_shells = 0
    for part in scenario["parts"]:
        try:
            _vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(part["path"]))
            total_shells += _shell_count(faces)
        except BaseException:  # noqa: BLE001 - truth is best-effort
            pass
    if total_shells >= 4:
        notes.append(
            f"input has {total_shells} disconnected shells across {len(scenario['parts'])} part(s); "
            "with sparse ground contacts the settled-penetration figure is a solver artefact, not a fit measurement — "
            "cross-check part fit with check_assembly / validate_assembly instead"
        )

    hold_analysis = []
    for joint in scenario.get("joints") or []:
        friction = joint.get("staticFriction")
        if joint["type"] != "prismatic" or not isinstance(friction, (int, float)) or friction <= 0:
            continue
        body = bodies.get(joint["bodyB"])
        if body is None:
            continue
        mass_kg = float(world.rigid_bodies[body].mass)
        matrix = _quat_to_matrix3(world.rigid_bodies[body].rotation.quaternion)
        axis_world = [sum(matrix[i][j] * float(joint["axis"][j]) for j in range(3)) for i in range(3)]
        axis_length = math.hypot(*axis_world) or 1.0
        unit = [value / axis_length for value in axis_world]
        g_parallel = sum(gravity[i] * unit[i] for i in range(3))
        g_perp = [gravity[i] - g_parallel * unit[i] for i in range(3)]
        axial_drive = abs(g_parallel) * mass_kg
        normal = math.hypot(*g_perp) * mass_kg
        friction_cap = float(friction) * normal
        holds = friction_cap >= axial_drive
        hold_analysis.append(
            {
                "joint": f"{joint['bodyA']}~{joint['bodyB']}",
                "mu": float(friction),
                "massKg": round(mass_kg, 4),
                "axialDriveN": round(axial_drive, 4),
                "frictionCapN": round(friction_cap, 4),
                "holds": holds,
            }
        )
        notes.append(
            f"hold analysis for {joint['bodyA']}~{joint['bodyB']} is a QUASI-STATIC analytic estimate "
            f"(μ·m·|g⊥| = {friction_cap:.3f}N vs m·|g∥| = {axial_drive:.3f}N → "
            f"{'HOLDS (self-locking under gravity)' if holds else 'SLIDES (gravity drives it along the axis)'}); "
            "the rigid-body solver did not simulate friction"
        )

    metrics = {
        "maxPenetrationMm": round(abs(min(0.0, max_penetration)), 4),
        "settledPenetrationMm": round(abs(min(0.0, settled_penetration)), 4),
        "fellOver": fell_over,
        "maxHorizontalDisplacementMm": max_horizontal,
        "jointViolations": joint_violations,
        "settled": not any_moving,
        "notes": notes,
    }
    if hold_analysis:
        metrics["holdAnalysis"] = hold_analysis

    return {
        "metrics": metrics,
        "finalPositions": final_positions,
        "keyframes": keyframes[: budget + 1],
        "trajectory": trajectory,
        "stepsRun": steps,
        "durationSec": duration,
    }


def op_lbm_channel(params: dict) -> dict:
    """Run the XLB LBM channel template and report developed-flow metrics.

    Stage A of the CFD lane (DECISION-LOG 2026-10-15): one narrow scenario
    (rectangular channel, ZouHe velocity inlet, DoNothing outlet, halfway
    bounce-back walls) so the acceptance can check analytical truth
    (Poiseuille development, mirror symmetry), determinism and the compat
    shims. CAD_LBM_ENGINE=off refuses loudly; there is no fallback engine, so
    an unavailable xlb surfaces as a loud ok:false — never as an empty result.
    """
    forced = os.environ.get("CAD_LBM_ENGINE", "").strip().lower()
    if forced == "off":
        raise RuntimeError("CAD_LBM_ENGINE=off — LBM engine disabled by request")

    mod = _load_lbm_xlb()
    grid_shape = params.get("gridShape") or [48, 24, 24]
    result = mod.run_channel(
        grid_shape=[int(v) for v in grid_shape],
        lattice_velocity=float(params.get("latticeVelocity") or 0.05),
        reynolds=float(params.get("reynolds") or 100),
        steps=int(params.get("steps") or 5000),
    )
    return result


def op_import_mesh(params: dict) -> dict:
    """Parse → shells → scale → weld → solid verdict for `import_part`.

    Mirrors the domain half of `importGeometry` in src/host/import.ts. Formats:
    .stl (binary/ASCII, unit declared by the caller), .step/.stp (cascadio → GLB;
    the GLB declares METERS — probed 2026-10-15 — so the soup is scaled ×1000 and
    `appliedScale` reports the total), .3mf (trimesh+lxml; the file's own `unit`
    is folded through `native_to_mm` — trimesh stores it as metadata and does NOT
    scale, probed 2026-10-22), .dxf (ezdxf; $INSUNITS honoured, closed 2D
    profiles extruded by depthMm through manifold3d, 3D mesh entities welded like
    STL). What stays in TS: path resolution, extension checks, hashing, unit/scale
    validation, the 3MF multi-body refusal, datums and version storage. The
    welded, scaled mesh is WRITTEN to `out` — that file is what the version store
    holds — and its facts come back with it.
    """
    import numpy as np
    from manifold3d import Error, Manifold, Mesh

    path = params["path"]
    scale = float(params.get("scale", 1.0))
    out = params["out"]
    ext = os.path.splitext(path)[1].lower()

    if ext in (".step", ".stp"):
        vertices, fmt, native_to_mm, warnings = _load_step_soup(path, params)
    elif ext == ".3mf":
        vertices, fmt, native_to_mm, warnings = _load_3mf_soup(path, params)
    elif ext == ".dxf":
        vertices, fmt, native_to_mm, warnings = _load_dxf_soup(path, params)
    else:
        data = open(path, "rb").read()
        fmt = _detect_stl_format(data)
        if fmt == "unknown":
            raise ValueError(
                f'not an STL I can read ({len(data)} bytes; neither binary — 84+n*50 — nor an ASCII "solid/facet" file). '
                "If this is OBJ/OFF or another mesh format, see the import notes."
            )
        vertices = _parse_stl_raw(path).reshape(-1, 3) if fmt == "binary" else _parse_ascii_vertices(data)
        native_to_mm = 1.0
        warnings = []
    if len(vertices) == 0:
        raise ValueError("no triangles")

    # The declared unit/scale is applied ONCE, before anything is measured, so
    # every number this op returns is already in mm — native_to_mm folds the
    # format's own unit statement (STEP meters → ×1000) into the same multiply.
    applied_scale = scale * native_to_mm
    # When the format's native unit is NOT mm, scale BEFORE welding: the weld
    # grid is keyed at 1e-5 in the numbers it sees, and welding metre-scale
    # values would quantize 1000× coarser than the same part in mm. STL (native
    # mm) keeps the shipped order — weld first, then the declared scale.
    # applied_scale stays the TOTAL (what the result reports); pre_weld_scale is
    # only the part of it applied before the weld.
    pre_weld_scale = applied_scale if native_to_mm != 1.0 else 1.0
    if pre_weld_scale != 1.0:
        vertices = np.asarray(vertices, dtype=np.float64) * pre_weld_scale
    welded, faces, degenerate = _weld(vertices, np.arange(len(vertices), dtype=np.int64).reshape(-1, 3))
    raw_triangles = int(len(faces))
    raw_vertices = int(len(welded))
    # Shells are counted on the file AS DELIVERED (welded, pre-scale): welding can
    # only merge what touches, and a multi-body file is something the caller must know.
    shells = _shell_count(faces)
    if applied_scale != pre_weld_scale:
        welded = (welded.astype(np.float64) * (applied_scale / pre_weld_scale)).astype(np.float32)

    mesh = Mesh(welded, faces)
    mesh.merge()
    solid = Manifold(mesh)
    status = solid.status()
    ok = status == Error.NoError
    volume = float(solid.volume())
    inverted = bool(ok and volume < 0)
    out_mesh = solid.to_mesh()
    merged_verts = np.asarray(out_mesh.vert_properties, dtype=np.float32)[:, :3]
    merged_faces = np.asarray(out_mesh.tri_verts, dtype=np.uint32)
    bad_edges = _watertight_bad_edges(merged_faces)
    _write_binary_stl(out, merged_verts, merged_faces, f"imported {os.path.basename(path)}")
    # The bbox comes from the MERGED MESH VERTICES, which is what the TS
    # `boundingBox(result.mesh)` measured — not from Manifold's own box.
    low = merged_verts.min(axis=0) if len(merged_verts) else np.zeros(3)
    high = merged_verts.max(axis=0) if len(merged_verts) else np.zeros(3)
    box = [float(x) for x in low] + [float(x) for x in high]
    reason = None
    if not ok:
        reason = (
            f"Manifold rejected the mesh despite watertight edges: {status.name}"
            if bad_edges == 0
            else f"{bad_edges} edge(s) are not shared by exactly two triangles — the surface has holes or T-junctions"
        )
    return {
        "format": fmt if fmt.startswith(("step", "dxf", "3mf")) else ("stl-binary" if fmt == "binary" else "stl-ascii"),
        "solid": bool(ok and not inverted),
        "inverted": inverted,
        "signedVolumeMm3": _round_js(volume),
        "volumeMm3": _round_js(abs(volume)),
        "triangles": int(len(merged_faces)),
        "vertices": int(len(merged_verts)),
        "rawTriangles": raw_triangles,
        "rawVertices": raw_vertices,
        "shells": int(shells),
        "degenerate": int(degenerate),
        "badEdges": int(bad_edges),
        "genus": int(solid.genus()) if (ok and not inverted) else 0,
        "reason": reason,
        "bbox": {
            "min": [_round_js(v) for v in box[0:3]],
            "max": [_round_js(v) for v in box[3:6]],
            "size": [_round_js(box[3] - box[0]), _round_js(box[4] - box[1]), _round_js(box[5] - box[2])],
        },
        "appliedScale": applied_scale,
        "warnings": warnings,
        "outBytes": os.path.getsize(out),
    }


# --- CAD import formats (import_mesh) — adopted 2026-10-15, DECISION-LOG same day.
# Probe: experiments/20261015_cad_import_probe.md. Facts the code below relies on,
# all measured:
#   * cascadio's GLB declares METERS for STEP input (colored.step bbox 0.01 =
#     10 mm), so the soup is scaled ×1000 here and `appliedScale` reports the total;
#   * cascadio fails SILENTLY on formats OpenCASCADE cannot read (IGES): no
#     exception, NO output file — the output's existence is part of the verdict;
#   * manifold3d `CrossSection` (FillRule.EvenOdd) turns closed 2D DXF loops —
#     outer loops and holes together — into one solid via `extrude`, so no
#     triangulation add-on is needed; the result feeds the same STL tail flow.

_DXF_INSUNITS_TO_MM = {
    1: 25.4,       # inches
    2: 304.8,      # feet
    3: 1609344.0,  # miles
    4: 1.0,        # millimetres (CAD convention)
    5: 10.0,       # centimetres
    6: 1000.0,     # metres
    7: 1000000.0,  # kilometres
}


def _load_step_soup(path: str, params: dict) -> tuple:
    """STEP/STP → cascadio (OpenCASCADE) → GLB → trimesh → triangle soup in mm."""
    import numpy as np
    import trimesh
    import cascadio

    scratch = os.path.dirname(os.path.abspath(params["out"]))
    glb = os.path.join(scratch, f"step-{os.getpid()}-{time.time_ns()}.glb")
    kwargs = {}
    if params.get("tolLinear") is not None:
        kwargs["tol_linear"] = float(params["tolLinear"])
    if params.get("tolAngular") is not None:
        kwargs["tol_angular"] = float(params["tolAngular"])
    cascadio.step_to_glb(path, glb, **kwargs)
    try:
        # cascadio does NOT raise when OpenCASCADE cannot read a file — IGES does
        # exactly this: an ERR line on stderr and no output. Existence is the verdict.
        if not os.path.exists(glb) or os.path.getsize(glb) == 0:
            raise ValueError(
                "OpenCASCADE produced no geometry for this file (cascadio fails silently on formats it cannot "
                "read — IGES is the known case). Re-export as STEP or STL and import that."
            )
        scene = trimesh.load(glb, process=False)
        mesh = scene.to_mesh() if hasattr(scene, "to_mesh") else scene
        verts = np.asarray(mesh.vertices, dtype=np.float64)
        faces = np.asarray(mesh.faces, dtype=np.int64)
        if len(faces) == 0:
            raise ValueError("the STEP contains no tessellatable solids (empty geometry)")
        # Soup stays in the FILE'S units (metres here); the op applies
        # native_to_mm exactly once, before welding (the weld grid is 1e-5 mm).
        soup = verts[faces].reshape(-1, 3)
        return soup, "step-cascadio", 1000.0, [
            "STEP units come from the file itself; appliedScale includes the ×1000 metres→mm step of the GLB "
            "intermediate (probed 2026-10-15). Use scale for size corrections — the unit argument does not apply."
        ]
    finally:
        try:
            os.remove(glb)
        except OSError:
            pass


_THREEMF_UNIT_TO_MM = {
    "micron": 0.001,
    "millimeter": 1.0,
    "centimeter": 10.0,
    "inch": 25.4,
    "foot": 304.8,
    "meter": 1000.0,
}


def _load_3mf_soup(path: str, params: dict) -> tuple:
    """3MF → trimesh (lxml) → triangle soup, with the file's own unit folded in.

    trimesh's reader already handles the parts that are easy to get wrong:
    build-item 4×3 transforms, `<components>` nesting and multi-instance baking
    (probed 2026-10-22: a +20 mm build transform lands at bounds 15..25; a
    component reference does the same; two items bake to volume 2000, body_count
    2). What it does NOT do is scale: `unit` is stored as metadata and the
    vertices stay raw (a `unit="inch"` file still reports 10-unit bounds), so the
    conversion is ours — applied exactly once through `native_to_mm`.

    Multi-body policy lives in the TS layer (`importGeometry`): a 3MF is a
    container of objects, so "N separate bodies" is refused there rather than
    silently stored as one multi-body part.
    """
    import numpy as np
    import trimesh

    try:
        scene = trimesh.load(path, file_type="3mf")
    except ImportError as e:  # lxml missing — name the fix, not a stack trace
        raise ValueError(
            "the 3MF reader needs lxml, which this runtime cannot import — "
            f"run python_runtime action=repair and retry ({e})"
        )
    except StopIteration:
        # trimesh looks up the model part by name and raises a bare StopIteration
        # when it is absent — a zip that is not a 3MF. Say what is wrong.
        raise ValueError(
            f"{os.path.basename(path)} is a zip but not a 3MF: it has no 3D/3dmodel.model part. "
            "Re-export it as 3MF from your slicer, or use STL/STEP."
        )
    except Exception as e:
        # type(e).__name__ matters: some parser errors stringify to "".
        raise ValueError(f"3MF parse failed ({type(e).__name__}): {e}")

    units = str(getattr(scene, "metadata", {}).get("units") or "millimeter").lower()
    factor = _THREEMF_UNIT_TO_MM.get(units)
    if factor is None:
        raise ValueError(
            f"3MF declares an unknown unit {units!r}; the spec allows "
            "micron / millimeter / centimeter / inch / foot / meter"
        )

    # to_geometry() is the current API; dump(concatenate=True) is deprecated in
    # trimesh 5.1. Both bake every build item and component transform.
    if hasattr(scene, "to_geometry"):
        mesh = scene.to_geometry()
    elif hasattr(scene, "dump"):
        mesh = scene.dump(concatenate=True)
    else:
        mesh = scene
    verts = np.asarray(getattr(mesh, "vertices", []), dtype=np.float64)
    faces = np.asarray(getattr(mesh, "faces", []), dtype=np.int64)
    if len(faces) == 0:
        raise ValueError(
            "the 3MF contains no triangles — empty build, or it references model parts the reader "
            "could not load (the production extension's external parts must live in the same archive)"
        )
    # Soup stays in the FILE's units; the op applies native_to_mm exactly once,
    # before welding (the weld grid is 1e-5 mm, so metre-scale values would
    # quantize 1000× coarser).
    soup = verts[faces].reshape(-1, 3)
    return soup, "3mf", factor, [
        f"3MF declares its own unit ({units}); appliedScale folds ×{factor:g} to mm. "
        "Use scale for size corrections — the unit argument does not apply."
    ]


def _load_dxf_soup(path: str, params: dict) -> tuple:
    """DXF → ezdxf → triangle soup in mm: 3D mesh entities as-is, or closed 2D
    profiles extruded by depthMm through manifold3d."""
    scratch = os.path.dirname(os.path.abspath(params["out"]))
    # ezdxf writes a font cache under ~/.cache by default; containers may not have
    # one and the warning would pollute stderr on every call.
    os.environ.setdefault("EZDXF_CONFIG_DIR", os.path.join(scratch, "ezdxf-config"))
    import numpy as np
    import ezdxf
    from ezdxf import recover
    from ezdxf.disassemble import recursive_decompose, to_primitives

    try:
        # `recover` is the malformed-ASCII path; it cannot read BINARY DXF (its
        # text loader chokes on the "AutoCAD Binary DXF" sentinel), so binary
        # files are detected by magic and read with the strict loader, which
        # auto-detects the format.
        with open(path, "rb") as handle:
            head = handle.read(22)
        if head.startswith(b"AutoCAD Binary DXF"):
            doc, auditor = ezdxf.readfile(path), None
        else:
            doc, auditor = recover.readfile(path)
    except Exception as exc:
        raise ValueError(f"ezdxf could not read this file: {exc}")
    warnings = []
    if auditor is not None and auditor.has_errors:
        warnings.append(f"ezdxf recovered this file with {len(auditor.errors)} error(s); invalid entities may be missing.")

    code = int(doc.header.get("$INSUNITS", 0) or 0)
    factor = _DXF_INSUNITS_TO_MM.get(code)
    if factor is None:
        factor = 1.0
        warnings.append(
            f"DXF $INSUNITS={code} (absent or not a length unit): coordinates treated as the declared unit (default mm)."
        )
    elif code != 4:
        warnings.append(f"DXF $INSUNITS={code}: coordinates scaled ×{factor} to mm; the unit argument was ignored.")

    depth = params.get("depthMm")
    if depth is not None and (not isinstance(depth, (int, float)) or float(depth) <= 0):
        raise ValueError(f"depthMm must be a positive number of millimetres, got {depth!r}")

    msp = doc.modelspace()
    # 3D mesh entities first: a file that carries its own solids means them.
    soup = []
    for primitive in to_primitives(recursive_decompose(msp)):
        mb = primitive.mesh
        if mb is None or len(mb.faces) == 0:
            continue
        for face in mb.faces:
            idx = [int(i) for i in face]
            for k in range(1, len(idx) - 1):  # fan-triangulate the n-gon
                soup.append((mb.vertices[idx[0]].xyz, mb.vertices[idx[k]].xyz, mb.vertices[idx[k + 1]].xyz))
    if soup:
        if depth is not None:
            warnings.append("depthMm was ignored: the DXF carries 3D mesh entities, which are imported as-is.")
        # Soup stays in the file's own units; the op applies `factor` exactly once.
        return np.asarray(soup, dtype=np.float64).reshape(-1, 3), "dxf-ezdxf-mesh", factor, warnings

    # 2D profiles → manifold3d extrusion. depthMm is in mm (the stored frame), so
    # the loops go to mm BEFORE the EvenOdd resolution and the extrude depth is
    # the mm value verbatim.
    from manifold3d import CrossSection, FillRule

    if depth is None:
        raise ValueError(
            "this DXF has 2D drawing geometry only, and a profile is not a body: pass depthMm (millimetres) to "
            "extrude the closed profiles into a solid, e.g. depthMm=10 for a 10 mm plate. Open curves and text are "
            "not profiles and are ignored. Nothing was imported."
        )
    loops = []
    open_curves = 0
    for primitive in to_primitives(recursive_decompose(msp)):
        p = primitive.path
        if p is None:
            continue
        pts = np.asarray([(v.x, v.y) for v in p.flattening(0.01)], dtype=np.float64)
        if len(pts) < 3 or not np.allclose(pts[0], pts[-1], atol=1e-6):
            open_curves += 1
            continue
        loops.append((pts * factor).astype(np.float32))
    if open_curves:
        warnings.append(f"{open_curves} open curve(s) ignored (not closed profiles).")
    if not loops:
        raise ValueError("no closed 2D profiles and no mesh entities found in this DXF — nothing to import.")
    section = CrossSection(loops, fillrule=FillRule.EvenOdd)
    if section.is_empty():
        raise ValueError("the closed profiles collapsed to an empty region (self-intersecting or degenerate loops).")
    solid = section.extrude(float(depth))
    if factor != 1.0:
        warnings.append(
            "depthMm is millimetres in the stored frame and is NOT scaled by $INSUNITS — the profile is at its "
            f"real size (×{factor}), the plate is exactly depthMm thick."
        )
    mesh = solid.to_mesh()
    verts = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    faces = np.asarray(mesh.tri_verts, dtype=np.int64)
    return verts[faces].reshape(-1, 3), "dxf-ezdxf-extrude", 1.0, warnings


def _shell_count(faces) -> int:
    """Edge-connected components of a mesh — the TS `shellCount` (undirected edge
    keys), which drives the "the parts you merged do not all touch" warning."""
    import numpy as np
    import trimesh

    if len(faces) == 0:
        return 0
    adjacency = trimesh.graph.face_adjacency(faces)
    return len(trimesh.graph.connected_components(adjacency, nodes=np.arange(len(faces))))


def _write_binary_stl(path: str, verts, faces, header: str = "dsh-cad-harness export") -> int:
    """Byte-for-byte mirror of the TS `writeBinaryStl`: 80-byte header, uint32
    triangle count, then per triangle a winding-derived normal (advisory, but
    written) and its three vertices, little-endian float32."""
    import numpy as np

    triangle_count = len(faces)
    buffer = np.zeros(84 + triangle_count * 50, dtype=np.uint8)
    text = header[:79].ljust(80)[:80].encode("utf-8", "replace")
    buffer[0 : len(text)] = np.frombuffer(text, dtype=np.uint8)
    buffer[80:84] = np.frombuffer(np.uint32(triangle_count).tobytes(), dtype=np.uint8)

    triangles = np.asarray(verts, dtype=np.float64)[faces]  # normals in float64, like JS numbers
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    normal = np.cross(b - a, c - a)
    length = np.linalg.norm(normal, axis=1)
    length[length == 0] = 1.0
    normal = normal / length[:, None]
    records = np.concatenate([normal, a, b, c], axis=1).astype("<f4")  # (n, 12)
    body = np.zeros((triangle_count, 50), dtype=np.uint8)
    body[:, 0:48] = records.view(np.uint8).reshape(triangle_count, 48)
    buffer[84:] = body.reshape(-1)
    with open(path, "wb") as handle:
        handle.write(buffer.tobytes())
    return int(len(buffer))


def op_merge_solids(params: dict) -> dict:
    """Union of placed solids → one merged binary STL on disk plus its facts.

    The union is Manifold's (the same C++ kernel the TS version used), so the
    merged body is the same; what moved is which process does the work and which
    side writes the deliverable. A part that is not a usable solid is NAMED in the
    error — `merge_parts` used to say which part failed, and that is part of what
    the model needs in order to fix it.
    """
    import numpy as np

    parts = params["parts"]
    out_path = params["out"]
    header = params.get("header", "dsh-cad-harness export")

    union = None
    for part in parts:
        try:
            info = _solid_from_stl(part["path"], part.get("transform"))
        except ValueError as exc:
            raise ValueError(f'part "{part.get("name", "?")}" is not a usable solid — {exc}') from exc
        union = info["solid"] if union is None else union + info["solid"]
    if union is None:
        raise ValueError("merge_solids produced nothing")

    mesh = union.to_mesh()
    verts = np.asarray(mesh.vert_properties, dtype=np.float32)[:, :3]
    faces = np.asarray(mesh.tri_verts, dtype=np.uint32)
    written = _write_binary_stl(out_path, verts, faces, header)
    box = [float(x) for x in union.bounding_box()]
    return {
        "triangles": int(len(faces)),
        "volumeMm3": float(union.volume()),
        "sizeMm": [box[3] - box[0], box[4] - box[1], box[5] - box[2]],
        "shells": _shell_count(faces),
        "outBytes": written,
    }


_STRESS_FEM_MODULE = None


def _load_stress_fem():
    """Load the sibling voxel-FEM module by explicit path.

    Same reason as `_load_mpm_numba`: the worker runs with `python -I`, so the
    script directory is not on sys.path and a plain `import stress_fem` fails even
    though the file sits next to this one.
    """
    global _STRESS_FEM_MODULE
    if _STRESS_FEM_MODULE is not None:
        return _STRESS_FEM_MODULE
    import importlib.util

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stress_fem.py")
    spec = importlib.util.spec_from_file_location("stress_fem", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load stress_fem from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["stress_fem"] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop("stress_fem", None)
        raise
    _STRESS_FEM_MODULE = module
    return module


def op_stress_field(params: dict) -> dict:
    """Voxel hex8 linear-elastic static analysis (the `simulate_stress` engine).

    The capability boundary this result must be read with is in `stress_fem.py`,
    and the tool face repeats it. Two things the caller has to know here:

      * large grids go BY FILE (`fieldPath`) — the same rule every other voxel op
        follows, because a megabyte-scale array through the pipe costs 148x more;
      * a non-watertight mesh is REFUSED, not repaired: `.fill()` on an open shell
        silently invents solid interior, which would show up as a plausible stress
        field for a part that cannot be printed at all.
    """
    return _load_stress_fem().run(params)


def _app_rot(rx: float, ry: float, rz: float):
    import numpy as np

    rx, ry, rz = np.radians([rx, ry, rz])
    Rx = np.array([[1, 0, 0], [0, np.cos(rx), -np.sin(rx)], [0, np.sin(rx), np.cos(rx)]])
    Ry = np.array([[np.cos(ry), 0, np.sin(ry)], [0, 1, 0], [-np.sin(ry), 0, np.cos(ry)]])
    Rz = np.array([[np.cos(rz), -np.sin(rz), 0], [np.sin(rz), np.cos(rz), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def _app_placed(mesh, transform: dict):
    import numpy as np

    m = mesh.copy()
    m.merge_vertices()
    t = transform or {}
    R = _app_rot(*(t.get("rotate") or [0, 0, 0]))
    p = np.array(t.get("translate") or [0, 0, 0], dtype=float)
    m.vertices = m.vertices @ R.T + p
    return m


def _app_convex_edges(mesh, min_deg: float = 60.0):
    """Convex edges sharper than min_deg: (midpoints, lengths)."""
    import numpy as np

    n, c = mesh.face_normals, mesh.triangles_center
    fa = mesh.face_adjacency
    ang = np.degrees(mesh.face_adjacency_angles)
    edges = mesh.face_adjacency_edges
    mid = (mesh.vertices[edges[:, 0]] + mesh.vertices[edges[:, 1]]) / 2
    ln = np.linalg.norm(mesh.vertices[edges[:, 0]] - mesh.vertices[edges[:, 1]], axis=1)
    d1 = np.einsum("ij,ij->i", n[fa[:, 0]], c[fa[:, 1]] - c[fa[:, 0]])
    d2 = np.einsum("ij,ij->i", n[fa[:, 1]], c[fa[:, 0]] - c[fa[:, 1]])
    keep = (ang > min_deg) & (d1 < 0) & (d2 < 0)
    return mid[keep], ln[keep]


def _app_clusters(points, cell: float):
    import numpy as np

    if len(points) == 0:
        return np.zeros((0, 3)), np.zeros(0, dtype=int), np.zeros(0, dtype=int)
    keys = np.floor(points / cell).astype(int)
    uniq, inverse = np.unique(keys, axis=0, return_inverse=True)
    cen = np.zeros((len(uniq), 3))
    for i in range(len(uniq)):
        cen[i] = points[inverse == i].mean(axis=0)
    return cen, np.bincount(inverse, minlength=len(uniq)), inverse


def _app_visibility(part_meshes, points, views):
    """Fraction of viewpoints from which each point is unoccluded.

    Cast against ONE PART AT A TIME, prefiltered by a ray-AABB slab test. The merged
    scene is not used: a 17-part assembly is ~300k triangles, and casting every ray
    against all of them is what made a real project time out (measured: microscope2
    never finished inside the worker budget). The slab test rejects most (ray, part)
    pairs before any triangle is touched.
    """
    import numpy as np

    if len(points) == 0:
        return np.zeros(0)
    n = len(points)
    score = np.zeros(n)
    for vp in views:
        d = points - vp
        dist = np.linalg.norm(d, axis=1)
        d = d / np.maximum(dist, 1e-9)[:, None]
        nearest = np.full(n, np.inf)
        for m in part_meshes:
            lo, hi = m.bounds
            t0 = (lo - vp) / np.where(np.abs(d) < 1e-12, 1e-12, d)
            t1 = (hi - vp) / np.where(np.abs(d) < 1e-12, 1e-12, d)
            tmin = np.minimum(t0, t1).max(1)
            tmax = np.maximum(t0, t1).min(1)
            cand = np.where((tmax >= np.maximum(tmin, 0.0)) & (tmin < dist) & (tmin < nearest))[0]
            if len(cand) == 0:
                continue
            loc, ir, _ = m.ray.intersects_location(
                np.repeat(vp[None, :], len(cand), 0), d[cand], multiple_hits=True
            )
            if len(ir) == 0:
                continue
            dd = np.linalg.norm(loc - vp, axis=1)
            for j in np.unique(ir):
                t = float(dd[ir == j].min())
                gi = int(cand[j])
                if t < nearest[gi]:
                    nearest[gi] = t
        score += (nearest > dist - 1.0)
    return score / len(views)


def _app_functional(version_dir: str, default_radius: float = 4.0):
    """Functional features declared as axis/cylinder datums next to the STL."""
    import json as _json
    import os as _os

    import numpy as np

    path = _os.path.join(version_dir, "datums.json")
    if not _os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            d = _json.load(fh)
    except Exception:
        return []
    out = []
    for a in d.get("axes", []):
        out.append({"name": a.get("name", "axis"),
                    "point": np.array(a["point"], dtype=float),
                    "dir": np.array(a["dir"], dtype=float),
                    "radius": float(default_radius)})
    for c in d.get("cylinders", []):
        out.append({"name": c.get("name", "cylinder"),
                    "point": np.array(c["point"], dtype=float),
                    "dir": np.array(c["dir"], dtype=float),
                    "radius": float(c.get("radius", default_radius))})
    return out


def _app_exempt(cen, functional):
    import numpy as np

    for f in functional:
        d = f["dir"] / max(np.linalg.norm(f["dir"]), 1e-9)
        v = cen - f["point"]
        perp = v - np.dot(v, d) * d
        if np.linalg.norm(perp) < f["radius"]:
            return f["name"]
    return None


def _app_blunt_caps(mesh, functional=(), min_feature_mm: float = 1.5,
                    max_area: float = 40.0, normal_tol: float = 0.98,
                    square_tol: float = 10.0):
    """Flat caps whose whole boundary is a 90 deg corner, at the end of a member."""
    import numpy as np

    n, c, a = mesh.face_normals, mesh.triangles_center, mesh.area_faces
    fa, ang = mesh.face_adjacency, np.degrees(mesh.face_adjacency_angles)
    groups: dict = {}
    for i in range(len(n)):
        key = tuple(np.round(n[i], 2)) + (round(float(np.dot(n[i], c[i])), 2),)
        groups.setdefault(key, []).append(i)
    adj: dict = {}
    for (f1, f2), ang_ in zip(fa, ang):
        adj.setdefault(f1, []).append((f2, ang_))
        adj.setdefault(f2, []).append((f1, ang_))
    caps = []
    for key, idx in groups.items():
        total = float(a[idx].sum())
        if total > max_area or total <= 0:
            continue
        normal = np.array(key[:3])
        ax = int(np.argmax(np.abs(normal)))
        if abs(normal[ax]) < normal_tol:
            continue
        idx_set = set(idx)
        boundary, square = 0.0, 0.0
        for f in idx:
            for nb, ang_ in adj.get(f, []):
                if nb in idx_set:
                    continue
                boundary += 1.0
                if abs(ang_ - 90.0) <= square_tol:
                    square += 1.0
        if boundary == 0 or square / boundary < 0.9:
            continue
        cen = (c[idx] * a[idx, None]).sum(0) / total
        # below the visual feature size: a 0.7 mm scale tick is texture, not a form end
        cap_pts = np.unique(np.concatenate([mesh.faces[f] for f in idx]))
        cap_v = mesh.vertices[cap_pts] - cen
        u = np.cross(normal, [0.0, 0.0, 1.0])
        if np.linalg.norm(u) < 1e-6:
            u = np.cross(normal, [1.0, 0.0, 0.0])
        u /= np.linalg.norm(u)
        v = np.cross(normal, u)
        if min(float(np.ptp(cap_v @ u)), float(np.ptp(cap_v @ v))) < min_feature_mm:
            continue
        # a member extends away inside a tube of 1.5x the cap width
        width = np.sqrt(max(total, 1e-6))
        rel = mesh.vertices - cen
        lateral = rel - np.outer(rel @ normal, normal)
        tube = np.linalg.norm(lateral, axis=1) < 1.5 * width
        if not tube.any():
            continue
        proj = rel[tube] @ (-normal)
        if float(proj.max()) < 3.0 * width:
            continue
        caps.append({"atMm": [round(float(x), 1) for x in cen],
                     "areaMm2": round(total, 1),
                     "memberLengthMm": round(float(proj.max()), 1),
                     "slender": round(float(proj.max()) / width, 1),
                     "normal": [round(float(x), 2) for x in normal],
                     "exemptBy": _app_exempt(cen, functional)})
    return caps


def _app_mask(verts_2d, faces, origin, res: float = 0.5):
    """Boolean occupancy of a 2D projection, on a caller-supplied grid."""
    import numpy as np

    lo = np.asarray(origin, dtype=float)
    hi = verts_2d.max(0) + res
    nx = int(np.ceil((hi[0] - lo[0]) / res)) + 1
    ny = int(np.ceil((hi[1] - lo[1]) / res)) + 1
    mask = np.zeros((ny, nx), bool)
    for tri in verts_2d[faces]:
        p = (tri - lo) / res
        i0, j0 = np.floor(p.min(0)).astype(int)
        i1, j1 = np.ceil(p.max(0)).astype(int)
        i0, j0 = max(i0, 0), max(j0, 0)
        i1, j1 = min(i1, nx - 1), min(j1, ny - 1)
        if i1 < i0 or j1 < j0:
            continue
        xs, ys = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        pts = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
        A, B, C = p[0], p[1], p[2]
        v0, v1, v2 = C - A, B - A, pts - A
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        u = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
        v = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
        inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
        if inside.any():
            mask[ys.ravel()[inside], xs.ravel()[inside]] = True
    return mask, lo


def _app_mask_fast(verts2d, faces, origin, shape, res: float = 0.5, seed: int = 0):
    """Filled occupancy mask by AREA-WEIGHTED SAMPLING, not per-triangle rasterising.

    The per-triangle loop costs ~44 us per triangle: 30 s on a 686k-triangle real
    assembly (microscope2) and the whole check timed out. Sampling costs one vectorised
    pass: each triangle gets samples proportional to its projected area, then the
    points are binned. Deterministic (seeded), and accurate to the grid cell.
    """
    import numpy as np

    P = verts2d[faces]
    e1 = P[:, 1] - P[:, 0]
    e2 = P[:, 2] - P[:, 0]
    area = np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) * 0.5
    per_cell = max(res * res * 0.25, 1e-6)
    n = np.maximum(3, np.ceil(area / per_cell).astype(np.int64))
    total = int(n.sum())
    budget = 4_000_000
    if total > budget:
        n = np.maximum(1, (n * (budget / total)).astype(np.int64))
        total = int(n.sum())
    idx = np.repeat(np.arange(len(P)), n)
    starts = np.cumsum(n) - n
    k = np.arange(total) - np.repeat(starts, n)
    rng = np.random.default_rng(seed)
    u = rng.random(total)
    v = rng.random(total)
    flip = u + v > 1.0
    u[flip] = 1.0 - u[flip]
    v[flip] = 1.0 - v[flip]
    w = 1.0 - u - v
    pts = P[idx, 0] * w[:, None] + P[idx, 1] * u[:, None] + P[idx, 2] * v[:, None]
    i = np.floor((pts[:, 0] - origin[0]) / res).astype(np.int64)
    j = np.floor((pts[:, 1] - origin[1]) / res).astype(np.int64)
    ok = (i >= 0) & (j >= 0) & (i < shape[0]) & (j < shape[1])
    mask = np.zeros((shape[1], shape[0]), bool)
    mask[j[ok], i[ok]] = True
    from scipy.ndimage import binary_closing
    return binary_closing(mask, np.ones((3, 3), bool))


def _app_planes(mesh, min_area: float = 200.0):
    """Axis-aligned flat faces, grouped into (axis, side, offset) planes.

    A facet of a cylinder has siblings at ~11 deg; a genuinely flat face has neighbours
    that are either coplanar (<0.5 deg) or a hard edge (>20 deg). Without that filter a
    R6 fillet alone produces a dozen "planes" 5 mm apart (measured on the P4 stool).
    """
    import numpy as np

    ang = np.degrees(mesh.face_adjacency_angles)
    fa = mesh.face_adjacency
    curved = np.zeros(len(mesh.faces), bool)
    sel = (ang > 0.5) & (ang < 20.0)
    curved[fa[sel, 0]] = True
    curved[fa[sel, 1]] = True
    n, c, a = mesh.face_normals, mesh.triangles_center, mesh.area_faces
    idx = np.where((~curved) & (a >= min_area))[0]
    if len(idx) == 0:
        return []
    ax = np.argmax(np.abs(n[idx]), axis=1)
    absn = np.abs(n[idx])[np.arange(len(idx)), ax]
    keep = absn >= 0.98
    idx, ax = idx[keep], ax[keep]
    if len(idx) == 0:
        return []
    sign = np.where(n[idx, ax] > 0, 1, -1)
    off = np.round(np.einsum("ij,ij->i", n[idx], c[idx]), 1)
    labels = np.stack([ax, sign, off], 1)
    uniq, inv = np.unique(labels, axis=0, return_inverse=True)
    # bbox from CENTROIDS via reduceat: ufunc.at over 686k rows costs tens of seconds on
    # a real assembly (microscope2), and a plane's extent is a coarse overlap test anyway
    order = np.argsort(inv, kind="stable")
    inv_s = inv[order]
    cen_s = c[idx][order]
    starts = np.searchsorted(inv_s, np.arange(len(uniq)))
    lo = np.minimum.reduceat(cen_s, starts, axis=0)
    hi = np.maximum.reduceat(cen_s, starts, axis=0)
    area = np.bincount(inv, weights=a[idx], minlength=len(uniq))
    out = []
    for i in range(len(uniq)):
        out.append({"axis": int(uniq[i][0]), "sign": int(uniq[i][1]), "offset": float(uniq[i][2]),
                    "area": float(area[i]), "lo": lo[i].copy(), "hi": hi[i].copy()})
    return out


def _app_near_planes(placed, gap_min: float = 1.0, gap_max: float = 20.0, overlap_min: float = 0.5):
    """Two LARGE flat faces of DIFFERENT parts, facing each other, 1-20 mm apart, whose
    projections overlap: "these should be flush but are 10 mm off".

    Sorting every plane offset and taking close neighbours does NOT work: plate
    thickness produces a pair on every part, and a fillet produces a dozen. The three
    filters that make it usable are measured in experiments/20261101_appearance_eval.md:
    cross-part, opposite normals, projection overlap.
    """
    import numpy as np

    planes = []
    for pid, m in placed:
        for q in _app_planes(m):
            planes.append((pid, q))
    if not planes:
        return []
    pids = np.array([x[0] for x in planes], dtype=object)
    axis = np.array([q["axis"] for _, q in planes])
    sign = np.array([q["sign"] for _, q in planes])
    off = np.array([q["offset"] for _, q in planes])
    lo = np.array([q["lo"] for _, q in planes])
    hi = np.array([q["hi"] for _, q in planes])
    ar = np.array([q["area"] for _, q in planes])
    hits = []
    for ax in (0, 1, 2):
        A = np.where((axis == ax) & (sign > 0))[0]
        B = np.where((axis == ax) & (sign < 0))[0]
        if len(A) == 0 or len(B) == 0:
            continue
        # the whole A x B gap matrix at once: a Python double loop over 17 parts was
        # 100 s on microscope2, this is milliseconds
        gap = np.abs(off[A][:, None] - off[B][None, :])
        ok = (gap >= gap_min) & (gap <= gap_max) & (pids[A][:, None] != pids[B][None, :])
        for a, b in zip(*np.where(ok)):
            f, g = A[a], B[b]
            ov = 1.0
            for k in (0, 1, 2):
                if k == ax:
                    continue
                inter = max(0.0, min(hi[f][k], hi[g][k]) - max(lo[f][k], lo[g][k]))
                smaller = max(min(hi[f][k] - lo[f][k], hi[g][k] - lo[g][k]), 1e-6)
                ov *= inter / smaller
            if ov < overlap_min:
                continue
            mid = (np.maximum(lo[f], lo[g]) + np.minimum(hi[f], hi[g])) / 2
            hits.append({"parts": [pids[f], pids[g]], "axis": "xyz"[ax],
                         "gapMm": round(float(gap[a, b]), 1), "overlap": round(float(ov), 2),
                         "atMm": [round(float(v), 1) for v in mid],
                         "areaMm2": round(float(min(ar[f], ar[g])), 1)})
    hits.sort(key=lambda h: -h["areaMm2"])
    return hits[:8]


def _app_silhouette(mesh, axes, res: float = 0.5):
    """Rasterised orthographic silhouette: waists, peaks, top/base ratio, symmetry."""
    import numpy as np
    from scipy.ndimage import binary_dilation
    from scipy.signal import find_peaks

    V2 = mesh.vertices[:, axes]
    lo = V2.min(0) - res
    hi = V2.max(0) + res
    shape = (int(np.ceil((hi[0] - lo[0]) / res)) + 1, int(np.ceil((hi[1] - lo[1]) / res)) + 1)
    mask = _app_mask_fast(V2, mesh.faces, lo, shape, res)
    mn = lo
    rows = np.where(mask.any(1))[0]
    if len(rows) == 0:
        return {}
    width = np.array([(np.where(mask[r])[0].max() - np.where(mask[r])[0].min() + 1) * res
                      for r in range(rows.min(), rows.max() + 1)])
    z = mn[1] + np.arange(rows.min(), rows.max() + 1) * res
    ws = np.convolve(width, np.ones(9) / 9, mode="same")
    waists, _ = find_peaks(-ws, prominence=5.0)
    peaks, _ = find_peaks(ws, prominence=5.0)
    cx = int(round((0 - mn[0]) / res))
    left = mask[:, :cx][:, ::-1]
    right = mask[:, cx:]
    k = min(left.shape[1], right.shape[1])
    L, R = left[:, :k], right[:, :k]
    near = binary_dilation(R, np.ones((3, 3), bool))
    near_l = binary_dilation(L, np.ones((3, 3), bool))
    inter = (L & near).sum() + (R & near_l).sum()
    union = max(int(L.sum() + R.sum()), 1)
    base_w = float(width[: max(1, int(0.2 * len(width)))].max())
    # An EDGE-ON view of a plate or a propeller is a thin bar: max/base explodes
    # (measured 4.58 on the propeller's side view) and says nothing about proportion.
    # An edge-on view of a plate or a propeller is a thin BAR: max/base explodes
    # (measured 4.58 on the propeller's side view) and says nothing about proportion.
    h = float(z[-1] - z[0])
    aspect = float(width.max()) / max(h, 1e-6)
    # A silhouette much wider than tall rests on a line, not a footprint: "top wider
    # than base" is then a statement about a bar, not about proportion (propeller 4.58).
    edge_on = aspect > 2.5
    return {
        "heightMm": round(float(z[-1] - z[0]), 1),
        "widthMaxMm": round(float(width.max()), 1),
        "maxWidthAtZMm": round(float(z[int(np.argmax(width))]), 1),
        "baseWidthMm": round(base_w, 1),
        "maxOverBase": None if edge_on else round(float(width.max() / max(base_w, 1e-6)), 2),
        "edgeOnView": bool(edge_on),
        "waists": [{"zMm": round(float(z[i]), 1), "widthMm": round(float(ws[i]), 1)} for i in waists],
        "peaks": [{"zMm": round(float(z[i]), 1), "widthMm": round(float(ws[i]), 1)} for i in peaks],
        "symmetryMatch": round(float(inter / union), 3),
    }


def _app_json_safe(o):
    """Normalise -0.0 to 0.0. JSON.stringify(-0) is "0", so a -0.0 coordinate is not
    a lossless round trip and the host's output contract rejects the whole value."""
    if isinstance(o, float):
        return 0.0 if o == 0 else o
    if isinstance(o, dict):
        return {k: _app_json_safe(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_app_json_safe(v) for v in o]
    return o


def _app_symmetry(scene, axis: int = 0, step_deg: int = 15, res: float = 0.5):
    """VISUAL symmetry, not geometric: sweep azimuths, project the scene and its
    mirror image, and measure the area where the two silhouettes disagree.

    A single view is not enough. Measured on the P1 stool (one round leg among three
    square ones): the front, 45 deg and side silhouettes are ALL perfectly symmetric —
    the odd leg hides behind a square one — and only 30/60 deg expose it. A product
    can also be symmetric in every view and still be built asymmetrically inside,
    which is fine: this rule asks what a viewer sees, not how it is assembled.
    """
    import numpy as np

    axes = (0, 2)
    worst = None
    per_view = []
    for az in range(0, 360, max(1, step_deg)):
        a = np.radians(az)
        R = np.array([[np.cos(a), -np.sin(a), 0.0], [np.sin(a), np.cos(a), 0.0], [0.0, 0.0, 1.0]])
        V = scene.vertices @ R.T
        Vm = V.copy()
        Vm[:, axis] *= -1.0
        a2, b2 = V[:, axes], Vm[:, axes]
        lo = np.minimum(a2.min(0), b2.min(0)) - res
        hi = np.maximum(a2.max(0), b2.max(0)) + res
        grid = (lo, np.ceil((hi - lo) / res).astype(int) + 1)
        # same grid for both, or the two masks cannot be compared element-wise
        from math import ceil
        shape = (int(ceil((hi[0] - lo[0]) / res)) + 1, int(ceil((hi[1] - lo[1]) / res)) + 1)
        A = _app_mask_fast(a2, scene.faces, lo, shape, res, seed=1)
        B = _app_mask_fast(b2, scene.faces, lo, shape, res, seed=2)
        diff = A ^ B
        area = float(diff.sum()) * res * res
        rec = {"azimuthDeg": az, "mismatchMm2": round(area, 1)}
        if area > 0:
            ys, xs = np.where(diff)
            rec["mismatchBboxMm"] = [
                [round(float(lo[0] + xs.min() * res), 1), round(float(lo[1] + ys.min() * res), 1)],
                [round(float(lo[0] + xs.max() * res), 1), round(float(lo[1] + ys.max() * res), 1)],
            ]
        per_view.append(rec)
        if worst is None or area > worst["mismatchMm2"]:
            worst = rec
    per_view.sort(key=lambda r: -r["mismatchMm2"])
    return {"planeAxis": "xyz"[axis], "views": len(per_view),
            "worst": worst, "top": per_view[:3],
            "note": "area where a view and its mirror disagree; 0 in every view is not a proof of symmetry, it is the absence of evidence in those views"}


def op_check_appearance(params: dict) -> dict:
    """Appearance screen over a whole SET, never a single part.

    WHY THE SCOPE IS THE SET. Appearance is a relation: proportion, alignment,
    repetition, contrast. A single part has nothing to be "off" against, and a
    part-level report is mostly invalid anyway — measured on toy-balance2, 29-39%
    of its sharp edges are invisible from EVERY viewpoint because the assembly
    hides them. The host resolves the manifest and hands every part here; this op
    answers "where is it wrong, where, by how much", never "is it pretty".

    THREE RULES (v1), each with a calibration pair behind it
    (experiments/20261030_appearance_probe.md):

      sharp-edge   visible convex edge LENGTH, not count: a fillet adds many short
                   segments, so the count RISES as a part gets rounder (measured
                   732 -> 836) while the length falls (2447 -> 1004 mm).
      termination  a flat cap at the end of a slender member whose whole boundary
                   is a 90 deg corner — the "just cut off" signature.
      silhouette   width profile of the projected outline: waists, peaks, and
                   whether the widest mass sits at the top. ATTENTION ONLY.

    VISIBILITY. Rays from N viewpoints to each sharp-edge cluster; the score is
    the fraction of views that see it. Below `visibilityThreshold` it is counted,
    not reported; never-visible clusters are excluded and the COUNT is reported,
    because a silent exclusion cannot be told from a missed one.

    FUNCTIONAL EXEMPTION. A cap inside a declared axis/cylinder datum (datums.json
    beside the STL) is a functional opening — a knife-edge groove must stay open —
    and is exempted by NAME, never dropped.
    """
    import numpy as np
    import trimesh

    parts = params.get("parts") or []
    if not isinstance(parts, list) or not parts:
        raise ValueError("check_appearance needs `parts`: [{id, role, path, transform}]")
    cell = float(params.get("cellMm") or 10.0)
    n_views = max(4, int(params.get("views") or 12))
    min_feature = float(params.get("minFeatureMm") or 1.5)
    functional_radius = float(params.get("functionalRadiusMm") or 4.0)
    vis_threshold = float(params.get("visibilityThreshold") or 0.25)

    scene, analysed, reference = [], [], []
    role_assumed = 0
    for p in parts:
        path = p.get("path")
        if not path:
            raise ValueError("each part needs `path` to its model.stl")
        m = _app_placed(trimesh.load(path, force="mesh"), p.get("transform") or {})
        scene.append(m)
        role = p.get("role")
        if role is None:
            role = "purchased" if p.get("source") == "stock" else "printed"
            role_assumed += 1
        elif p.get("roleAssumed"):
            role_assumed += 1
        (reference if role != "printed" else analysed).append((p, m))

    if not analysed:
        raise ValueError("no printed parts to judge — every part is purchased/reference")

    scene_mesh = trimesh.util.concatenate(scene)
    lo, hi = scene_mesh.bounds
    centre = np.array([0.0, 0.0, (lo[2] + hi[2]) / 2])
    radius = max(float(np.linalg.norm(hi - lo)), 1.0) * 1.6
    views = []
    for az in range(0, 360, max(1, 360 // n_views)):
        for el in (12, 55):
            a_, e_ = np.radians(az), np.radians(el)
            views.append(centre + radius * np.array([np.cos(e_) * np.cos(a_),
                                                     np.cos(e_) * np.sin(a_),
                                                     np.sin(e_)]))
    views = np.array(views)

    findings, attention = [], []
    total_visible = total_hidden = 0.0
    subsampled = 0
    max_rays = int(params.get("maxRays") or 6000)
    for p, m in analysed:
        mid, length = _app_convex_edges(m)
        cen, counts, inverse = _app_clusters(mid, cell)
        cluster_len = np.zeros(len(cen))
        for i in range(len(cen)):
            cluster_len[i] = length[inverse == i].sum()
        total_clusters = len(cen)
        # ray budget: the longest clusters are the ones worth measuring; a silent
        # truncation would look like "no sharp edges here", so the count rides along
        if total_clusters * len(views) > max_rays and total_clusters > 0:
            keep = max(20, int(max_rays) // max(1, len(views)))
            sel = np.argsort(-cluster_len)[:keep]
            cen, cluster_len = cen[sel], cluster_len[sel]
            subsampled += total_clusters - len(sel)
        score = _app_visibility(scene, cen, views)
        vis = score >= vis_threshold
        total_visible += float(cluster_len[vis].sum())
        total_hidden += float(cluster_len[~vis].sum())
        findings.append({
            "part": p.get("id"), "version": p.get("version"),
            "role": p.get("role") or ("purchased" if p.get("source") == "stock" else "printed"),
            "volumeMm3": round(float(m.volume), 1),
            "areaMm2": round(float(m.area), 1),
            "bboxMm": [[round(float(x), 1) for x in m.bounds[0]],
                       [round(float(x), 1) for x in m.bounds[1]]],
            "sharpEdgesMm": round(float(length.sum()), 1),
            "visibleSharpMm": round(float(cluster_len[vis].sum()), 1),
            "hiddenSharpMm": round(float(cluster_len[~vis].sum()), 1),
            "clusters": int(total_clusters),
            "clustersMeasured": int(len(cen)),
            "visibleClusters": int(vis.sum()),
            "topVisible": [
                {"atMm": [round(float(x), 1) for x in cen[i]],
                 "lenMm": round(float(cluster_len[i]), 1),
                 "visibility": round(float(score[i]), 2)}
                for i in np.argsort(-cluster_len * vis)[:3]
            ],
        })
        version_dir = os.path.dirname(str(p.get("path")))
        functional = _app_functional(version_dir, functional_radius)
        all_caps = _app_blunt_caps(m, functional, min_feature)
        exempted = [c for c in all_caps if c["exemptBy"]]
        findings[-1]["exemptCaps"] = len(exempted)
        for cap in sorted([c for c in all_caps if not c["exemptBy"]],
                          key=lambda c: -c["areaMm2"])[:3]:
            attention.append({
                "kind": "termination", "part": p.get("id"), "version": p.get("version"),
                "atMm": cap["atMm"], "areaMm2": cap["areaMm2"],
                "memberLengthMm": cap["memberLengthMm"], "slender": cap["slender"],
                "detail": f"flat cap {cap['areaMm2']} mm2, slenderness {cap['slender']}, "
                          f"boundary all 90 deg",
            })

    for hit in _app_near_planes([(p.get("id"), m) for p, m in analysed]):
        attention.append({"kind": "near-plane", **hit})

    for label, axes in (("front", (0, 2)), ("side", (1, 2))):
        sil = _app_silhouette(scene_mesh, axes)
        if sil:
            attention.append({"kind": "silhouette", "view": label, **sil})

    sym = params.get("symmetry") or {}
    if sym.get("plane"):
        axis = {"x": 0, "y": 1, "z": 2}.get(str(sym["plane"]).lower(), 0)
        attention.append({"kind": "symmetry", **_app_symmetry(scene_mesh, axis,
                         step_deg=int(sym.get("stepDeg") or 15))})

    area_total = sum(f["areaMm2"] for f in findings)
    result = {
        "parts": {"analysed": len(analysed), "reference": len(reference),
                  "roleAssumed": role_assumed},
        "judgement": {
            "visibleSharpMm": round(total_visible, 1),
            "hiddenSharpMm": round(total_hidden, 1),
            "hiddenShare": round(total_hidden / max(total_visible + total_hidden, 1e-6), 3),
            "volumeMm3": round(sum(f["volumeMm3"] for f in findings), 1),
            "areaMm2": round(area_total, 1),
            "visibleSharpPerKmm2": round(total_visible / max(area_total / 1000, 1e-6), 2),
            "exemptCaps": sum(f["exemptCaps"] for f in findings),
            "clustersSubsampled": subsampled,
            "findings": sorted(findings, key=lambda f: -f["visibleSharpMm"]),
        },
        "attention": {"count": len(attention), "items": attention},
    }
    return _app_json_safe(result)


HANDLERS = {
    "ping": op_ping,
    "versions": op_versions,
    "stl_stats": op_stl_stats,
    "closest_points": op_closest_points,
    "closest_mesh_mesh": op_closest_mesh_mesh,
    "closest_mesh_sphere": op_closest_mesh_sphere,
    "support_map": op_support_map,
    "connectivity": op_connectivity,
    "validate_assembly": op_validate_assembly,
    "merge_solids": op_merge_solids,
    "measure_distance": op_measure_distance,
    "measure_thickness": op_measure_thickness,
    "list_features": op_list_features,
    "measure_section": op_measure_section,
    "passage_bottleneck": op_passage_bottleneck,
    "measure_extent": op_measure_extent,
    "measure_angle": op_measure_angle,
    "assembly_contracts": op_assembly_contracts,
    "import_mesh": op_import_mesh,
    "scad_prelude": op_scad_prelude,
    "scad_parse_output": op_scad_parse_output,
    "scad_parse_params": op_scad_parse_params,
    "simulate_physics": op_simulate_physics,
    "lbm_channel": op_lbm_channel,
    "simulate_motion": op_simulate_motion,
    "measure_part": op_measure_part,
    "scan_attention": op_scan_attention,
    "check_appearance": op_check_appearance,
    "stress_field": op_stress_field,
    "check_printability": op_check_printability,
    "mpm_create": op_mpm_create,
    "mpm_step": op_mpm_step,
    "mpm_state": op_mpm_state,
    "mpm_destroy": op_mpm_destroy,
    "fluid_run": op_fluid_run,
    "crash": op_crash,
}


def main() -> int:
    _send(
        {
            "type": "hello",
            "protocolVersion": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "pid": os.getpid(),
            "ops": OPS,
        }
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.perf_counter()
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            params = request.get("params") or {}
            handler = HANDLERS.get(op)
            if handler is None:
                raise KeyError(f"unknown op {op!r} (ops: {', '.join(OPS)})")
            result = handler(params)
            _send(
                {
                    "id": request_id,
                    "ok": True,
                    "result": result,
                    "ms": round((time.perf_counter() - started) * 1000, 3),
                }
            )
        except BaseException as exc:  # noqa: BLE001 - one bad request must not kill the worker
            _send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(),
                    "ms": round((time.perf_counter() - started) * 1000, 3),
                }
            )
    _log("stdin closed, exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
