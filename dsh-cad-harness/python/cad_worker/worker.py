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
    import_mesh     parse/scale/weld one STL into a storable mesh (import_part)
    scad_prelude        the datum prelude injected into every part
    scad_parse_output   errors/warnings/datums from one OpenSCAD run
    scad_parse_params   the `// PARAMS` convention
    simulate_physics    step a rigid-body scenario and report what happened
    simulate_motion     drive a mechanism + exact interference timeline
    measure_part        whole-part ground truth (volume/area/centroid/genus)
    check_printability  wall thickness + overhang screen
    mpm_create/step/state/destroy   MLS-MPM fluid kernel (stateful, keyed by id)
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
    "connectivity",
    "validate_assembly",
    "merge_solids",
    "measure_distance",
    "measure_thickness",
    "list_features",
    "measure_section",
    "measure_extent",
    "measure_angle",
    "import_mesh",
    "scad_prelude",
    "scad_parse_output",
    "scad_parse_params",
    "simulate_physics",
    "simulate_motion",
    "measure_part",
    "check_printability",
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

    wanted = ["numpy", "scipy", "trimesh", "manifold3d", "networkx", "skfem", "rtree", "rapier3d", "shapely"]
    found = {}
    for name in wanted:
        try:
            module = importlib.import_module(name)
            found[name] = getattr(module, "__version__", "unknown")
        except BaseException as exc:  # noqa: BLE001 - report, do not die
            found[name] = f"unavailable: {type(exc).__name__}"
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

    return {
        "bodies": bodies,
        "count": len(bodies),
        "watertight": _is_watertight(faces),
        "triangles": int(len(faces)),
    }


def _watertight_bad_edges(faces) -> int:
    """How many directed-edge keys violate the strict manifold rule — the TS
    `isWatertight`'s `undirectedBad`: a directed edge must appear exactly once AND
    its reverse must exist. trimesh's own `is_watertight` only counts undirected
    edge sharing, which is laxer and would silence real warnings.
    """
    import numpy as np

    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if faces.size == 0:
        return 1
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0).astype(np.int64)
    directed = edges[:, 0] * 4294967296 + edges[:, 1]
    unique, counts = np.unique(directed, return_counts=True)
    if len(unique) == 0:
        return 1
    bad = int(np.count_nonzero(counts != 1))
    reverse = edges[:, 1] * 4294967296 + edges[:, 0]
    has_reverse = np.isin(unique, np.unique(reverse))
    return bad + int(np.count_nonzero(~has_reverse))


def _is_watertight(faces) -> bool:
    """Strict manifold test, identical to the TS `isWatertight`: every DIRECTED edge
    occurs exactly once and its reverse exists. The tool reports this flag next to a
    "this part must be a single connected solid" verdict, so the stricter definition
    is the one that had to survive the migration.
    """
    import numpy as np

    faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    return bool(faces.size > 0 and _watertight_bad_edges(faces) == 0)


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

    watertight = _is_watertight(np.asarray(mesh.faces))
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
        watertight[label] = _is_watertight(np.asarray(mesh.faces))
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
    watertight = _is_watertight(triangles)
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

    facet_of_face = np.empty(len(triangles), dtype=np.int64)
    for index, region in enumerate(mesh.facets):
        facet_of_face[np.asarray(region, dtype=np.int64)] = index
    facet_count = len(mesh.facets)
    facet_area = np.asarray(mesh.facets_area, dtype=float)
    facet_normal = np.asarray(mesh.facets_normal, dtype=float)
    facet_origin = np.asarray(mesh.facets_origin, dtype=float)

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
            keep = i != j
            graph = coo_matrix(
                (np.ones(int(keep.sum())), (i[keep], j[keep])), shape=(facet_count, facet_count)
            )
            _count, labels = connected_components(graph, directed=False)
            region_of_facet = labels

    region_facets: dict[int, list[int]] = {}
    for facet in range(facet_count):
        region_facets.setdefault(int(region_of_facet[facet]), []).append(facet)

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
                depth = hole_depth(center, normal, "a")
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
        region_triangles = np.concatenate([np.asarray(mesh.facets[int(f)], dtype=np.int64) for f in indices])
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
    if not _is_watertight(np.asarray(mesh.faces)):
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
            if not _is_watertight(np.asarray(mesh.faces)):
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


def _mpm_step_once(world) -> None:
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


def op_check_printability(params: dict) -> dict:
    """Manufacturability screen (FDM bias): sampled wall thickness by a ray along the
    inward normal, plus down-facing overhang area — the `checkPrintabilityInTs` of
    src/host/inspect.ts.

    The overhang half is pure arithmetic on a deterministic triangle sample, so it is
    expected to match the TS version exactly. The wall half is a spatial-index ray
    cast; the matrix's negative-return table flagged the index as a risk, so it was
    measured before porting (601 rays on the 28,830-triangle real part: 0.121 s
    against a 120 s budget).
    """
    import numpy as np
    import trimesh

    wall_min_mm = float(params.get("wallMinMm") or 1.2)
    overhang_deg = float(params.get("overhangDeg") or 45)
    target_samples = max(100, min(int(params.get("samples") or 600), 4000))

    vertices, faces, _degenerate = _weld_raw(_parse_stl_raw(params["path"]))
    points = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    triangles = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    watertight = _is_watertight(triangles)

    tri_count = len(triangles)
    step = max(1, tri_count // target_samples)
    sampled_index = np.arange(0, tri_count, step)
    corners = points[triangles[sampled_index]]
    centroids = corners.mean(axis=1)
    edge_u = corners[:, 1] - corners[:, 0]
    edge_v = corners[:, 2] - corners[:, 0]
    cross = np.cross(edge_u, edge_v)
    lengths = np.linalg.norm(cross, axis=1)
    safe = np.where(lengths[:, None] == 0, 1.0, lengths[:, None])
    normals = cross / safe
    areas = lengths / 2
    sampled = int(len(sampled_index))
    z_floor = float(points[:, 2].min())

    # down-facing overhang: normal points below horizontal by overhangDeg
    overhang_sin = math.sin(overhang_deg * math.pi / 180)
    overhang_mask = (normals[:, 2] < -overhang_sin) & (centroids[:, 2] - z_floor > 0.8)
    overhang_area = float(np.sum(areas[overhang_mask]))
    overhang_z_min = float(np.min(centroids[overhang_mask][:, 2])) if bool(overhang_mask.any()) else float("inf")
    overhang_z_max = float(np.max(centroids[overhang_mask][:, 2])) if bool(overhang_mask.any()) else float("-inf")

    # wall thickness: from 0.05 outside the surface, march along -n; the FIRST hit is
    # the sample triangle's own plane (at ≈0.05, skipped), the SECOND is the opposite
    # wall → wall = distance − 0.05.
    min_wall = float("inf")
    min_wall_at = None
    thin_samples = 0
    mesh = trimesh.Trimesh(vertices=points, faces=triangles, process=False)
    origins = centroids + normals * 0.05
    directions = -normals
    try:
        locations, index_ray, _index_tri = mesh.ray.intersects_location(origins, directions, multiple_hits=True)
        distances = np.linalg.norm(locations - origins[index_ray], axis=1) if len(locations) else np.zeros(0)
    except BaseException:  # noqa: BLE001 - degenerate region: fall back to per-ray
        locations, index_ray, distances = [], [], []
        for ray_index in range(sampled):
            try:
                hit, hit_ray, _hit_tri = mesh.ray.intersects_location(origins[ray_index : ray_index + 1], directions[ray_index : ray_index + 1], multiple_hits=True)
                for point in hit:
                    locations.append(point)
                    index_ray.append(ray_index)
                    distances.append(float(np.linalg.norm(point - origins[ray_index])))
            except BaseException:  # noqa: BLE001
                continue
        index_ray = np.asarray(index_ray, dtype=np.int64)
        distances = np.asarray(distances, dtype=np.float64)

    order = np.argsort(distances, kind="stable") if len(distances) else np.zeros(0, dtype=np.int64)
    for ray_index in range(sampled):
        hits = distances[index_ray == ray_index]
        hits = hits[hits > 0.075]
        if hits.size == 0:
            continue
        wall = float(hits.min()) - 0.05
        if wall < min_wall:
            min_wall = wall
            min_wall_at = [float(v) for v in centroids[ray_index]]
        if wall < wall_min_mm:
            thin_samples += 1

    findings = []
    if not watertight:
        findings.append(
            "mesh is NOT watertight — printability numbers below are computed on an open surface and are unreliable; fix the mesh first"
        )
    if min_wall_at is not None and min_wall < wall_min_mm:
        where = ",".join(_js_to_fixed(v, 1) for v in min_wall_at)
        findings.append(
            f"最薄壁 {_js_to_fixed(min_wall, 2)}mm @ [{where}]（阈值 {wall_min_mm}mm；"
            f"{sampled} 个采样面中 {thin_samples} 个低于阈值）— 薄壁打印要么断要么翘，加厚、加筋或改朝向"
        )
    if overhang_area > 20:
        findings.append(
            f"{_js_to_fixed(overhang_area, 0)}mm² 朝下悬垂面比 {overhang_deg}° 更平"
            f"（z ∈ [{_js_to_fixed(overhang_z_min, 0)}, {_js_to_fixed(overhang_z_max, 0)}]）"
            " — 需要支撑、改打印朝向、或改成 45° 以内/桥接"
        )

    severe = math.isfinite(min_wall) and min_wall < wall_min_mm * 0.4
    verdict = "unprintable" if severe else ("check" if findings else "ok")
    return {
        "verdict": verdict,
        **({"minWallMm": float(_js_to_fixed(min_wall, 3))} if math.isfinite(min_wall) else {}),
        "thinSamples": thin_samples,
        "sampled": sampled,
        "overhangAreaMm2": float(_js_to_fixed(overhang_area, 1)),
        "overhangZRange": (
            [float(_js_to_fixed(overhang_z_min, 1)), float(_js_to_fixed(overhang_z_max, 1))]
            if math.isfinite(overhang_z_min)
            else []
        ),
        "findings": findings,
        "watertight": watertight,
    }


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
    cycles = int(scenario.get("cycles") or 2)
    sample_per_cycle = int(scenario.get("samplePerCycle") or 24)
    oscillator_inputs = scenario.get("oscillators") or []
    drive = scenario.get("drive")
    omega = float((drive or {}).get("omegaRadPerSec") or 0)
    cycle_period = (2 * math.pi) / omega if omega > 0 else 1.0
    total_sec = cycles * cycle_period
    steps = max(1, int(round(total_sec / dt)))
    sample_every = max(1, int(round((cycle_period / sample_per_cycle) / dt)))

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

        if (i + 1) % sample_every == 0:
            sample_times.append(t)
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
                        "step": (k + 1) * sample_every,
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
    sample_dt = sample_every * dt
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
                "step": (k + 1) * sample_every,
                "timeSec": round(sample_times[k], 4),
                "label": "interference",
                "poses": sample_poses[k],
            }
        )
    if sample_poses:
        k = len(sample_poses) - 1
        keyframes.append({"step": steps, "timeSec": round(sample_times[k], 4), "label": "final", "poses": sample_poses[k]})

    clean = interference_count == 0 and not diverged and max_joint_drift <= 2

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


def op_import_mesh(params: dict) -> dict:
    """Parse → shells → scale → weld → solid verdict for `import_part`.

    Mirrors the domain half of `importGeometry` in src/host/import.ts. What stays in
    TS: path resolution, extension checks, hashing, unit/scale validation, datums
    and version storage. The welded, scaled mesh is WRITTEN to `out` — that file is
    what the version store holds — and its facts come back with it.
    """
    import numpy as np
    from manifold3d import Error, Manifold, Mesh

    path = params["path"]
    scale = float(params.get("scale", 1.0))
    out = params["out"]

    data = open(path, "rb").read()
    fmt = _detect_stl_format(data)
    if fmt == "unknown":
        raise ValueError(
            f'not an STL I can read ({len(data)} bytes; neither binary — 84+n*50 — nor an ASCII "solid/facet" file). '
            "If this is STEP/3MF/OBJ, see the import notes."
        )
    vertices = _parse_stl_raw(path).reshape(-1, 3) if fmt == "binary" else _parse_ascii_vertices(data)
    if len(vertices) == 0:
        raise ValueError("no triangles")

    welded, faces, degenerate = _weld(vertices, np.arange(len(vertices), dtype=np.int64).reshape(-1, 3))
    raw_triangles = int(len(faces))
    raw_vertices = int(len(welded))
    # Shells are counted on the file AS DELIVERED (welded, pre-scale): welding can
    # only merge what touches, and a multi-body file is something the caller must know.
    shells = _shell_count(faces)
    # The declared unit/scale is applied ONCE, before anything is measured, so every
    # number this op returns is already in mm.
    if scale != 1.0:
        welded = (welded.astype(np.float64) * scale).astype(np.float32)

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
        "format": "stl-binary" if fmt == "binary" else "stl-ascii",
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
        "appliedScale": scale,
        "outBytes": os.path.getsize(out),
    }


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


HANDLERS = {
    "ping": op_ping,
    "versions": op_versions,
    "stl_stats": op_stl_stats,
    "closest_points": op_closest_points,
    "closest_mesh_mesh": op_closest_mesh_mesh,
    "closest_mesh_sphere": op_closest_mesh_sphere,
    "connectivity": op_connectivity,
    "validate_assembly": op_validate_assembly,
    "merge_solids": op_merge_solids,
    "measure_distance": op_measure_distance,
    "measure_thickness": op_measure_thickness,
    "list_features": op_list_features,
    "measure_section": op_measure_section,
    "measure_extent": op_measure_extent,
    "measure_angle": op_measure_angle,
    "import_mesh": op_import_mesh,
    "scad_prelude": op_scad_prelude,
    "scad_parse_output": op_scad_parse_output,
    "scad_parse_params": op_scad_parse_params,
    "simulate_physics": op_simulate_physics,
    "simulate_motion": op_simulate_motion,
    "measure_part": op_measure_part,
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
