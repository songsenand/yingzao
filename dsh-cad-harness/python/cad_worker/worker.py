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


def _closest_side(vertices, target, seed_count: int = 64, chunk: int = 2048) -> dict:
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
    stride = max(1, int(math.ceil(len(points) / MAX_QUERY_POINTS)))
    sampled = points[::stride]
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
    side_a = _closest_side(mesh_a.vertices, mesh_b)
    side_b = _closest_side(mesh_b.vertices, mesh_a)
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


HANDLERS = {
    "ping": op_ping,
    "versions": op_versions,
    "stl_stats": op_stl_stats,
    "closest_points": op_closest_points,
    "closest_mesh_mesh": op_closest_mesh_mesh,
    "closest_mesh_sphere": op_closest_mesh_sphere,
    "connectivity": op_connectivity,
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
