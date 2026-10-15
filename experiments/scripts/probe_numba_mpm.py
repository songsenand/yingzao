#!/usr/bin/env python
"""MPM kernel probe: current numpy kernel (worker.py) vs numba port, same machine.

Run under the SCRATCH venv (numba installed, production lock untouched):

    NUMBA_NUM_THREADS=16 .tmp-numba-probe/venv/bin/python experiments/scripts/probe_numba_mpm.py

`--baseline-only` skips the numba import so the same script can also run under the
plugin venv (~/.dsh/cad/runtime/venv) as a numpy-version cross-check.

Order matters (a first draft got this wrong): parity runs FIRST, from the fresh
world; timing runs afterwards on its own clones. Parity on a world that already
went through 150+ timed steps measures trajectory decorrelation of a DRIVEN
steady flow, not kernel correctness — this harness documented that effect itself
(TOOL-RUNTIME-MATRIX row 16: incoherent rounding noise amplifies ~20% macro while
coherent perturbations of the same size move ~0.017).

Parity is two-phase, both from one fresh snapshot:
  * micro (30 steps): max/mean position + velocity drift — port-correctness signal
    (expected ~float32 noise on the transient);
  * macro (150 steps total): transits / escaped / nonFinite / activeN / mean+max
    speed — the acceptance-style metrics, since individual trajectories in the
    driven flow decorrelate for ANY non-bit-identical implementation.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = ROOT / "dsh-cad-harness" / "python" / "cad_worker"
RESULTS_PATH = ROOT / "experiments" / "20261014_numba_mpm_results.json"

CELLS = (100, 24, 24)  # pipe along +x, same shape as bench-mpm-scaling
CONFIG = {
    "cells": list(CELLS),
    "dt": 0.004,
    "vmax": 60,
    "gravity": [0.0, 0.0, -49.05],
    "stiffness": 50,
    "viscosity": 0.1,
    "inlet": {"axis": 0, "band": [2, 5], "speed": 25},
    "recycle": {"axis": 0, "at": 98, "respawn": 3},
}
LADDER_S = [1.0, 0.5, 0.28, 0.25]  # lattice spacings in cells
PARITY_RANGE = (20_000, 200_000)  # parity runs on the rung inside this particle band


def build_seeds(s: float) -> np.ndarray:
    xs = np.arange(2.5, 22.0, s)
    ys = np.arange(2.0, 22.5, s)
    zs = np.arange(2.0, 22.5, s)
    return np.stack(np.meshgrid(xs, ys, zs, indexing="ij"), axis=-1).reshape(-1, 3)


def steps_for(count: int) -> int:
    return 50 if count < 100_000 else 25


def make_world(worker, seeds: np.ndarray):
    params = {"config": dict(CONFIG, particleCount=int(len(seeds))), "seeds": seeds}
    result = worker.op_mpm_create(params)
    return worker._MpmWorlds[result["worldId"]], result


def clone_world(world: dict) -> dict:
    """Same state, fresh counters — the standard fork point."""
    return {
        "config": world["config"],
        "cells": list(world["cells"]),
        "n": world["n"],
        "pos": world["pos"].copy(),
        "vel": world["vel"].copy(),
        "C": world["C"].copy(),
        "transits": 0,
        "escaped": 0,
        "activeN": world["activeN"],
        "nonFinite": 0,
        "restDensity": world["restDensity"],
        "lastStep": {"maxSpeed": 0.0, "clampedFraction": 0.0},
        "inletCounters": {"band": 0, "floored": 0, "injected": 0.0},
        "solidMask": None,
        "solidNormal": None,
    }


def time_engine(step_fn, warmup: int, blocks: int, steps: int) -> dict:
    for _ in range(warmup):
        step_fn()
    per_block = []
    for _ in range(blocks):
        t0 = time.perf_counter()
        for _ in range(steps):
            step_fn()
        per_block.append((time.perf_counter() - t0) / steps * 1000.0)
    return {
        "msPerStepBlocks": [round(v, 3) for v in per_block],
        "msPerStepBest": round(min(per_block), 3),
        "msPerStepMedian": round(statistics.median(per_block), 3),
    }


def speed_stats(world: dict) -> dict:
    vel = world["vel"][: world["activeN"]]
    if vel.shape[0] == 0:
        return {"meanSpeed": 0.0, "maxSpeed": 0.0}
    speeds = np.linalg.norm(vel, axis=1)
    return {"meanSpeed": round(float(speeds.mean()), 4), "maxSpeed": round(float(speeds.max()), 4)}


def counters(world: dict) -> dict:
    return {k: world[k] for k in ("transits", "escaped", "nonFinite", "activeN")}


def parity_run(worker, world, engine_factory, micro=30, macro_total=150) -> dict:
    """Two-phase parity from ONE fresh snapshot. Returns micro + macro datapoints."""
    A = clone_world(world)
    B = clone_world(world)
    eng = engine_factory(B)

    for _ in range(micro):
        worker._mpm_step_once(A)
    for _ in range(micro):
        eng.step()
    dpos = np.abs(B["pos"][: B["activeN"]] - A["pos"][: A["activeN"]])
    dvel = np.abs(B["vel"][: B["activeN"]] - A["vel"][: A["activeN"]])
    out = {
        "micro": {
            "steps": micro,
            "maxAbsPosDriftCells": float(dpos.max()) if dpos.size else 0.0,
            "meanAbsPosDriftCells": float(dpos.mean()) if dpos.size else 0.0,
            "maxAbsVelDriftCellsPerSec": float(dvel.max()) if dvel.size else 0.0,
        }
    }

    for _ in range(macro_total - micro):
        worker._mpm_step_once(A)
    for _ in range(macro_total - micro):
        eng.step()
    out["macro"] = {
        "steps": macro_total,
        "numpy": {**counters(A), **speed_stats(A)},
        "numba": {**counters(B), **speed_stats(B)},
        "numbaFinite": bool(np.isfinite(B["pos"]).all() and np.isfinite(B["vel"]).all()),
    }
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--rung", type=float, default=None, help="only this ladder spacing")
    parser.add_argument("--no-parity", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(WORKER_DIR))
    import worker  # noqa: E402  (plugin's own worker module, import-safe)

    numba_meta = None
    if not args.baseline_only:
        import numba  # noqa: E402

        numba_meta = {"version": numba.__version__, "threads": numba.get_num_threads()}

    results = {
        "date": "2026-10-14",
        "machine": {"cpus": os.cpu_count(), "python": sys.version.split()[0]},
        "numba": numba_meta,
        "numpy": np.__version__,
        "scene": {
            "cells": list(CELLS),
            "dt": CONFIG["dt"],
            "vmax": CONFIG["vmax"],
            "inlet": CONFIG["inlet"],
            "recycle": CONFIG["recycle"],
            "note": "pipe along +x, no solids; identical scene for all engines",
        },
        "ladder": [],
    }

    ladder = [args.rung] if args.rung else LADDER_S
    for s in ladder:
        seeds = build_seeds(s)
        count = int(len(seeds))
        steps = steps_for(count)
        entry = {"latticeSpacingCells": s, "particles": count, "timedStepsPerBlock": steps}

        world, created = make_world(worker, seeds)
        entry["restDensity"] = created["restDensity"]

        # --- parity FIRST, from the fresh world (see module docstring) ---
        if not args.baseline_only and not args.no_parity and PARITY_RANGE[0] <= count <= PARITY_RANGE[1]:
            from mpm_numba_kernel import NumbaEngine  # noqa: E402

            entry["parity"] = parity_run(worker, world, lambda w: NumbaEngine(w))
            print(json.dumps({"parity": entry["parity"]}, ensure_ascii=False), flush=True)

        # --- baseline: the production numpy kernel, on its own clone ---
        world_np = clone_world(world)
        entry["numpyKernel"] = time_engine(
            lambda: worker._mpm_step_once(world_np), warmup=3, blocks=3, steps=steps
        )

        # --- numba port: own clone + own engine buffers ---
        if not args.baseline_only:
            from mpm_numba_kernel import NumbaEngine  # noqa: E402

            world_nb = clone_world(world)
            engine = NumbaEngine(world_nb)
            t0 = time.perf_counter()
            engine.step()
            compile_s = time.perf_counter() - t0
            entry["numbaKernel"] = time_engine(engine.step, warmup=2, blocks=3, steps=steps)
            entry["numbaCompileFirstStepS"] = round(compile_s, 3)
            entry["speedupBest"] = round(
                entry["numpyKernel"]["msPerStepBest"] / entry["numbaKernel"]["msPerStepBest"], 2
            )

        results["ladder"].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

    path = RESULTS_PATH if not args.baseline_only else RESULTS_PATH.with_suffix(".baseline.json")
    path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(f"results -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
