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
    import_mesh     parse/scale/weld one STL into a storable mesh (import_part)
    scad_prelude        the datum prelude injected into every part
    scad_parse_output   errors/warnings/datums from one OpenSCAD run
    scad_parse_params   the `// PARAMS` convention
    simulate_physics    step a rigid-body scenario and report what happened
    simulate_motion     drive a mechanism + exact interference timeline
    measure_part        whole-part ground truth (volume/area/centroid/genus)
    check_printability  wall thickness + overhang screen
    mpm_create/step/state/destroy   MLS-MPM fluid kernel (stateful, keyed by id)
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

    wanted = ["numpy", "scipy", "trimesh", "manifold3d", "networkx", "skfem", "rtree", "rapier3d"]
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
    the surface, and whether it sat on the outward side of that face."""
    import numpy as np
    import trimesh

    closest, distance, face_ids = trimesh.proximity.ProximityQuery(mesh).on_surface(np.asarray(point, dtype=float).reshape(1, 3))
    snapped = np.asarray(closest[0], dtype=float)
    vertices = np.asarray(mesh.vertices, dtype=float)
    face = np.asarray(mesh.faces[int(face_ids[0])], dtype=np.int64)
    va, vb, vc = vertices[face[0]], vertices[face[1]], vertices[face[2]]
    normal = np.cross(vb - va, vc - va)
    length = float(np.linalg.norm(normal))
    if length > 0:
        normal = normal / length
    return {
        "snapped": snapped,
        "distance": float(distance[0]),
        "outside": bool(float(np.dot(np.asarray(point, dtype=float) - snapped, normal)) > 0),
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
        "pos": positions,
        "vel": np.zeros((count, 3), dtype=np.float64),
        "C": np.zeros((count, 3, 3), dtype=np.float64),
        "transits": 0,
        "escaped": 0,
        "activeN": count,
        "nonFinite": 0,
        "restDensity": float(config["restDensity"]) if config.get("restDensity") is not None else 0.0,
        "lastStep": {"maxSpeed": 0.0, "clampedFraction": 0.0},
        "solidMask": None,
        "solidNormal": None,
    }
    if config.get("solidMask"):
        world["solidMask"] = np.asarray(config["solidMask"], dtype=bool)
    if config.get("solidNormal"):
        world["solidNormal"] = np.asarray(config["solidNormal"], dtype=np.int64)
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
    taps = []
    for i in range(3):
        for j in range(3):
            for k in range(3):
                cell = (base[:, 0] + i) * cells[1] * cells[2] + (base[:, 1] + j) * cells[2] + (base[:, 2] + k)
                taps.append(
                    {
                        "cell": cell,
                        "weight": weights_of(base, pos, i, j, k),
                        "dist": np.stack([dx[i], dy[j], dz[k]], axis=1),
                    }
                )
    return taps


def weights_of(base, pos, i, j, k):
    """Quadratic B-spline weight for stencil tap (i, j, k)."""
    import numpy as np

    out = None
    for axis, tap in ((0, i), (1, j), (2, k)):
        frac = pos[:, axis] - np.floor(pos[:, axis]) - 0.5
        w = (0.5 * (0.5 - frac) ** 2, 0.75 - frac ** 2, 0.5 * (0.5 + frac) ** 2)[tap]
        out = w if out is None else out * w
    return out


def _mpm_step_once(world) -> None:
    import numpy as np

    config = world["config"]
    cells = world["cells"]
    nx, ny, nz = cells
    total = nx * ny * nz
    dt = float(config["dt"])
    stiffness = float(config.get("stiffness", 50))
    viscosity = float(config.get("viscosity", 0.1))
    rest_density = world["restDensity"]
    active = world["activeN"]
    pos = world["pos"][:active]
    vel = world["vel"][:active]
    C = world["C"][:active]

    base = np.floor(pos).astype(np.int64) - 1
    taps = _mpm_taps(base, pos, cells)

    # --- P2G pass 1: mass + APIC momentum ---
    grid_mass = np.zeros(total, dtype=np.float64)
    grid_mom = np.zeros((total, 3), dtype=np.float64)
    for tap in taps:
        cell, weight, dist = tap["cell"], tap["weight"], tap["dist"]
        q = np.einsum("pab,pb->pa", C, dist)
        grid_mass += np.bincount(cell, weights=weight, minlength=total)
        for axis in range(3):
            grid_mom[:, axis] += np.bincount(cell, weights=weight * (vel[:, axis] + q[:, axis]), minlength=total)

    # --- P2G pass 2: stress (weakly-compressible EOS + viscosity), vectorized ---
    density = np.zeros(active, dtype=np.float64)
    for tap in taps:
        density += tap["weight"] * grid_mass[tap["cell"]]
    volume = 1.0 / np.where(density != 0, density, 1.0)
    dr = density / rest_density if rest_density else np.zeros(active)
    pressure = stiffness * np.maximum(0.0, dr ** 5 - 1) if rest_density else np.zeros(active)
    stress = np.empty((active, 3, 3), dtype=np.float64)
    stress[:, 0, 0] = -pressure + viscosity * 2 * C[:, 0, 0]
    stress[:, 1, 1] = -pressure + viscosity * 2 * C[:, 1, 1]
    stress[:, 2, 2] = -pressure + viscosity * 2 * C[:, 2, 2]
    stress[:, 0, 1] = stress[:, 1, 0] = viscosity * (C[:, 0, 1] + C[:, 1, 0])
    stress[:, 0, 2] = stress[:, 2, 0] = viscosity * (C[:, 0, 2] + C[:, 2, 0])
    stress[:, 1, 2] = stress[:, 2, 1] = viscosity * (C[:, 1, 2] + C[:, 2, 1])
    stress *= (volume * -4 * dt)[:, None, None]
    for tap in taps:
        cell, weight, dist = tap["cell"], tap["weight"], tap["dist"]
        momentum = np.einsum("pab,pb->pa", stress, dist) * weight[:, None]
        for axis in range(3):
            grid_mom[:, axis] += np.bincount(cell, weights=momentum[:, axis], minlength=total)

    # --- grid update: v = momentum/mass + boundary conditions ---
    mass_safe = np.where(grid_mass > 0, grid_mass, 1.0)
    grid_vel = grid_mom / mass_safe[:, None]
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
    flat_vel = grid_vel.reshape(total, 3)

    # --- G2P: gather velocity + affine, advect, drives, clamps ---
    vmax = float(config["vmax"])
    gravity = np.asarray(config.get("gravity") or [0.0, 0.0, 0.0], dtype=np.float64)
    gathered = np.zeros((active, 3), dtype=np.float64)
    B = np.zeros((active, 3, 3), dtype=np.float64)
    wsum = np.zeros(active, dtype=np.float64)
    mask_flat = world["solidMask"]
    for tap in taps:
        cells_of_tap = tap["cell"]
        weight = tap["weight"]
        if mask_flat is not None:
            # free-slip renormalization: solid cells (v ≡ 0) are EXCLUDED, otherwise
            # near-wall particles get dragged by the zeros (artificial boundary layer).
            solid = mask_flat[cells_of_tap]
            weight = np.where(solid, 0.0, weight)
        gathered += weight[:, None] * np.clip(flat_vel[cells_of_tap], -vmax, vmax)
        wsum += weight
        B += (weight[:, None] * np.clip(flat_vel[cells_of_tap], -vmax, vmax))[:, :, None] * tap["dist"][:, None, :]

    scale = np.where(wsum > 0.5, 1.0 / np.where(wsum == 0.0, 1.0, wsum), 1.0)
    gathered *= scale[:, None]
    B *= scale[:, None, None]
    bad = ~np.isfinite(B[:, 0, 0] + B[:, 1, 1] + B[:, 2, 2])
    if bad.any():
        B[bad] = 0.0
        gathered[bad] = 0.0
    C_new = 4.0 * B

    gathered += gravity[None, :] * dt
    speed2 = np.einsum("pa,pa->p", gathered, gathered)
    over = speed2 > vmax * vmax
    safe_speed2 = np.where(speed2 > 0, speed2, 1.0)
    gathered *= np.where(over, vmax / np.sqrt(safe_speed2), 1.0)[:, None]
    max_speed = vmax if over.any() else (float(np.sqrt(speed2.max())) if active else 0.0)
    clamped = int(over.sum())

    inlet = config.get("inlet")
    if inlet:
        axis = int(inlet["axis"])
        in_band = (pos[:, axis] >= float(inlet["band"][0])) & (pos[:, axis] <= float(inlet["band"][1]))
        below = in_band & (gathered[:, axis] < float(inlet["speed"]))
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
    high = np.array([nx - 1.5, ny - 1.5, nz - 1.5])
    below = new_pos < 1.5
    above = new_pos > high[None, :]
    new_pos = np.clip(new_pos, 1.5, high[None, :])
    gathered = np.where(below & (gathered < 0), 0.0, gathered)
    gathered = np.where(above & (gathered > 0), 0.0, gathered)

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
