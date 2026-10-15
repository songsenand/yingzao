#!/usr/bin/env python3
"""Profile `list_features` on a real STL (the 11–21MB corpus parts).

Why this script exists: the 2026-10-11 execution summary recorded that
`list_features` takes 24–43s on an 11–21MB mesh and left the first call's cost
unexplained ("the cache only helps repeat calls"). This probe answers WHERE the
time goes, so a fix targets the measured hot spot instead of a guess.

Usage
-----
    <runtime>/venv/bin/python experiments/scripts/probe_list_features_perf.py \
        examples/microscope2/cad-data/versions/v036/model.stl [--no-profile]

`--no-profile` runs the op twice (cold + warm) to separate one-off costs from
per-call costs; the default wraps the first run in cProfile.
"""

from __future__ import annotations

import argparse
import cProfile
import io
import pstats
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKER_DIR = REPO / "dsh-cad-harness" / "python" / "cad_worker"
sys.path.insert(0, str(WORKER_DIR))

import worker  # noqa: E402  (path must be on sys.path first)


def timed(label, fn):
    started = time.perf_counter()
    value = fn()
    print(f"  {label:<28} {time.perf_counter() - started:8.3f}s", flush=True)
    return value


def install_legacy_paths() -> None:
    """Restore the two code paths the 2026-10-13 fix replaced.

    Before/after has to be measured by the SAME script on the SAME machine, so the
    old implementation is carried here verbatim instead of being quoted from the
    earlier campaign's numbers:

    1. `_watertight_bad_edges` via `np.unique` + `np.isin` (the hash path).
    2. `_mesh_watertight` recomputing the strict test on every call — which is what
       `_ray_spans` did once per hole before the per-mesh memo existed.
    """

    import numpy as np

    def legacy_bad_edges(faces) -> int:
        faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
        if faces.size == 0:
            return 1
        edges = np.concatenate(
            [faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0
        ).astype(np.int64)
        directed = edges[:, 0] * 4294967296 + edges[:, 1]
        unique, counts = np.unique(directed, return_counts=True)
        if len(unique) == 0:
            return 1
        bad = int(np.count_nonzero(counts != 1))
        reverse = edges[:, 1] * 4294967296 + edges[:, 0]
        has_reverse = np.isin(unique, np.unique(reverse))
        return bad + int(np.count_nonzero(~has_reverse))

    worker._watertight_bad_edges = legacy_bad_edges
    worker._mesh_watertight = lambda mesh: worker._is_watertight(np.asarray(mesh.faces))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("stl")
    parser.add_argument("--no-profile", action="store_true")
    parser.add_argument("--legacy", action="store_true", help="measure the pre-2026-10-13 paths")
    parser.add_argument("--top", type=int, default=18)
    args = parser.parse_args()

    path = str(Path(args.stl).resolve())
    size_mb = Path(path).stat().st_size / 1e6
    print(f"fixture: {path}  ({size_mb:.2f}MB)")
    if args.legacy:
        install_legacy_paths()
        print("mode: LEGACY (np.unique/np.isin + one strict test per ray)")

    params = {"path": path}

    if args.no_profile:
        print("\n-- cold run --")
        result = timed("op_list_features", lambda: worker.op_list_features(params))
        print(f"  faces={result['faceCount']} holes={result['holeCount']} "
              f"cylinders={result['cylinderCount']} triangles={result['triangles']}")
        print("\n-- warm run (same process, same path) --")
        timed("op_list_features", lambda: worker.op_list_features(params))
        return 0

    profile = cProfile.Profile()
    started = time.perf_counter()
    profile.enable()
    result = worker.op_list_features(params)
    profile.disable()
    wall = time.perf_counter() - started

    print(f"\nop wall time: {wall:.3f}s  "
          f"(faces={result['faceCount']} holes={result['holeCount']} "
          f"cylinders={result['cylinderCount']} triangles={result['triangles']})")

    stream = io.StringIO()
    stats = pstats.Stats(profile, stream=stream).sort_stats("tottime")
    stats.print_stats(args.top)
    print("\n=== by tottime (self) ===")
    print(stream.getvalue())

    stream = io.StringIO()
    stats = pstats.Stats(profile, stream=stream).sort_stats("cumulative")
    stats.print_stats(args.top)
    print("=== by cumulative ===")
    print(stream.getvalue())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
