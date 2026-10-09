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


def _is_watertight(faces) -> bool:
    """Strict manifold test, identical to the TS `isWatertight`.

    Every DIRECTED edge must occur exactly once and its reverse must exist. That
    is stricter than trimesh's `is_watertight` (which only counts undirected
    edge-sharing), and the tool reports this flag next to a "this part must be a
    single connected solid" verdict — so the stricter definition is the one that
    must survive the migration.
    """
    import numpy as np

    if faces.size == 0:
        return False
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0).astype(np.int64)
    directed = edges[:, 0] * 4294967296 + edges[:, 1]
    unique, counts = np.unique(directed, return_counts=True)
    if len(unique) == 0:
        return False
    bad = int(np.count_nonzero(counts != 1))
    reverse = edges[:, 1] * 4294967296 + edges[:, 0]
    has_reverse = np.isin(unique, np.unique(reverse))
    bad += int(np.count_nonzero(~has_reverse))
    return bad == 0


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


def _weld_raw(raw):
    """Mirror of the TS `MeshBuilder`: coordinates are keyed at 1e-5 mm, the FIRST
    occurrence's exact values survive, and triangles with a repeated vertex are
    dropped as degenerate. Welding is what lets Manifold see shared edges.

    ORDER MATTERS. `np.unique` hands back unique keys SORTED, while the TS builder
    assigns indices in FIRST-ENCOUNTER order — and vertex order propagates into the
    merged STL, so a sorted rebuild produced byte-different (though geometrically
    identical) deliverables. `remap` restores the encounter order.
    """
    import numpy as np

    vertices = raw.reshape(-1, 3)
    keys = np.round(vertices * 1e5).astype(np.int64)
    unique_keys, first_index, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    encounter = np.argsort(first_index, kind="stable")
    remap = np.empty(len(unique_keys), dtype=np.int64)
    remap[encounter] = np.arange(len(unique_keys), dtype=np.int64)
    faces = remap[inverse].reshape(-1, 3)
    keep = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    return vertices[first_index[encounter]].astype(np.float32), faces[keep].astype(np.uint32)


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

    vertices, faces = _weld_raw(_parse_stl_raw(path))
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
