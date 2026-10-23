"""XLB LBM engine (stage A) — compat shims + channel template.

Adopted 2026-10-15 (DECISION-LOG same day + addendum; probe
experiments/20261015_xlb_lbm_probe.md). Three upstream xlb==0.3.1 defects are
absorbed HERE, not in worker.py, so the engine is the single isolation point:

  1. warp-lang is pinned at 1.12.1 in the lock — 1.18 removed
     `warp.utils.ScopedTimer`, which kills `import xlb` outright. Nothing to do
     at runtime; the lock is the fix. Revisit when xlb ships its Warp upgrade
     (upstream PR #168).

  2. `check_bc_overlaps` accumulates with `list += ndarray`, which numpy 2.5
     turned into array semantics (empty list -> shape (0,) broadcast) — replaced
     below with an extend-based implementation, patched into BOTH binding names
     (`xlb.helper` and the stepper module) because nse_stepper imported it by
     `from xlb.helper import check_bc_overlaps`.

  3. ZouHeBC.__init__ stores `prescribed_value`, but get_rho/get_vel read
     `prescribed_values` — never assigned in 0.3.1. The shim mirrors upstream
     main VERBATIM (`prescribed_values = profile()`, main bc_zouhe.py:120) so
     that removing the shim when a fixed release lands is a no-op. Acceptance
     (accept-lbm-channel.mjs) asserts an UNPATCHED ZouHeBC still raises
     AttributeError: when upstream fixes it, that assertion turns red and tells
     us to drop the shim instead of letting it silently rot.

The worker imports this module lazily by explicit path (python -I), mirroring
_load_mpm_numba. CAD_LBM_ENGINE gates the op: "off" refuses loudly; unset or
"xlb" runs the engine (there is no fallback engine — unavailability surfaces as
a loud ok:false, never as a silent empty result).

A fourth shim lives here that is NOT an upstream defect: xlb's `__init__`
eagerly imports its visualization module, which would drag matplotlib + pyvista
+ VTK (~726 MB) into the runtime for code we never call. `_stub_unused_viz_module`
makes that one import a no-op; the measurement and the escape hatch are in its
docstring.
"""

import sys
import types

_XLB = None
_SHIMS_APPLIED = False


def _apply_compat_shims(xlb):
    """Idempotent: install the two 0.3.1 workarounds described in the docstring."""
    global _SHIMS_APPLIED
    if _SHIMS_APPLIED:
        return
    import numpy as np

    from xlb.compute_backend import ComputeBackend

    def _check_bc_overlaps_fixed(bclist, dim, compute_backend):
        # numpy 2.5 changed `list += ndarray` into array semantics; extend keeps
        # the original accumulate-then-uniqueness-check behaviour.
        index_list = [[] for _ in range(dim)]
        for bc in bclist:
            if bc.indices is None:
                continue
            arr = np.asarray(bc.indices)
            for d in range(dim):
                index_list[d].extend(arr[d].tolist())
        uniq = np.unique(np.asarray(index_list), axis=-1)
        if uniq.shape[-1] != len(index_list[0]):
            if compute_backend == ComputeBackend.WARP:
                raise ValueError("Boundary condition list contains duplicate indices!")
            print("WARNING: duplicate indices in bc list; order matters")

    import xlb.helper
    import xlb.operator.stepper.nse_stepper as _nss

    xlb.helper.check_bc_overlaps = _check_bc_overlaps_fixed
    _nss.check_bc_overlaps = _check_bc_overlaps_fixed
    _SHIMS_APPLIED = True


def _stub_unused_viz_module():
    """Make xlb's eager `import xlb.utils` a no-op.

    `xlb/__init__.py` line 34 does `import xlb.utils`, and that module is pure
    VISUALIZATION (matplotlib + pyvista + VTK: save_image, save_fields_vtk,
    save_BCs_vtk, voxelize_stl, save_usd_* …). Nothing inside xlb imports it
    except that one line — `grep -rn 'xlb.utils' xlb/` outside `utils/` returns
    only `__init__.py` — and nothing we call touches it.

    Honoring xlb's declared dependency list to satisfy an unused import cost
    ~726 MB of runtime (measured 2026-10-22: vtk 591 MB, matplotlib 35, ruff 25,
    pillow 21, pyvista 14, + their trees). The engine itself needs warp + jax,
    which stay. Verified by blocking matplotlib/pyvista/vtk/numpy_stl/pydantic/
    ruff and every one of their dependencies, then running the 200-step channel:
    stable=True, mirrorError=2.8e-06, and not one blocked module was imported.

    A pre-registered submodule does NOT get the parent attribute set by the
    import system, so `xlb.utils` is attached explicitly — otherwise
    `xlb.utils` is simply absent (measured: AttributeError on the first probe).

    If a future path wants VTK field export, add the dependency back on purpose;
    do not discover this stub as a mysterious AttributeError.
    """
    if "xlb.utils" not in sys.modules:
        sys.modules["xlb.utils"] = types.ModuleType("xlb.utils")


def load():
    """Import xlb, apply shims, init the JAX/D3Q19 backend. Cached."""
    global _XLB
    if _XLB is not None:
        return _XLB
    _stub_unused_viz_module()
    import xlb
    xlb.utils = sys.modules["xlb.utils"]
    from xlb.compute_backend import ComputeBackend
    from xlb.precision_policy import PrecisionPolicy
    from xlb.velocity_set import D3Q19

    _apply_compat_shims(xlb)
    vs = D3Q19(precision_policy=PrecisionPolicy.FP32FP32, compute_backend=ComputeBackend.JAX)
    xlb.init(velocity_set=vs, default_backend=ComputeBackend.JAX,
             default_precision_policy=PrecisionPolicy.FP32FP32)
    _XLB = {"module": xlb, "velocity_set": vs, "backend": ComputeBackend.JAX,
            "precision": PrecisionPolicy.FP32FP32}
    return _XLB


def zouhe_velocity_inlet(handle, indices, u):
    """Velocity inlet; carries the upstream-mirroring shim (see module docstring).

    Returns (bc, upstream_fixed): upstream_fixed is True when __init__ itself
    already set `prescribed_values` — i.e. the installed xlb carries the upstream
    fix and the shim assignment below has become redundant (acceptance asserts
    False on the pinned 0.3.1; when it flips True, drop the shim — DECISION-LOG
    2026-10-15 addendum).
    """
    bc = handle["module"].operator.boundary_condition.ZouHeBC(
        "velocity", prescribed_value=(u, 0.0, 0.0), indices=indices)
    upstream_fixed = hasattr(bc, "prescribed_values")
    # shim #3 — identical statement to upstream main bc_zouhe.py:120. When the
    # fixed release lands, this attribute is set by __init__ and the assignment
    # below is redundant; delete it together with the acceptance's
    # "unpatched ZouHe raises" detector.
    bc.prescribed_values = bc.profile()
    return bc, upstream_fixed


def run_channel(grid_shape, lattice_velocity, reynolds, steps):
    """3D incompressible channel: ZouHe velocity inlet, DoNothing outlet,
    halfway bounce-back walls. Returns metrics + the developed centerline."""
    import time

    import numpy as np
    import jax

    handle = load()
    xlb = handle["module"]
    vs = handle["velocity_set"]
    nx, ny, nz = (int(v) for v in grid_shape)
    grid = xlb.grid.grid_factory(shape=(nx, ny, nz), compute_backend=handle["backend"])

    nu = lattice_velocity * (ny - 1) / reynolds
    omega = 1.0 / (3.0 * nu + 0.5)

    def plane(axis, at):
        spans = [range(nx), range(ny), range(nz)]
        spans[axis] = [at]
        return np.stack(np.meshgrid(*spans, indexing="ij")).reshape(3, -1)

    bcs = []
    inlet_bc, upstream_zouhe_fixed = zouhe_velocity_inlet(handle, plane(0, 0), lattice_velocity)
    bcs.append(inlet_bc)
    bcs.append(xlb.operator.boundary_condition.DoNothingBC(indices=plane(0, nx - 1)))
    bcs.append(xlb.operator.boundary_condition.HalfwayBounceBackBC(indices=plane(1, 0)))
    bcs.append(xlb.operator.boundary_condition.HalfwayBounceBackBC(indices=plane(1, ny - 1)))
    stepper = xlb.operator.stepper.IncompressibleNavierStokesStepper(
        grid=grid, boundary_conditions=bcs, collision_type="BGK")
    f_0, f_1, bc_mask, missing_mask = stepper.prepare_fields()

    started = time.perf_counter()
    for step in range(1, int(steps) + 1):
        f_1, f_0 = stepper(f_0, f_1, bc_mask, missing_mask, omega, step)
        if step % 1000 == 0:
            jax.block_until_ready(f_1)
    elapsed = time.perf_counter() - started

    f = np.asarray(f_1)
    finite = bool(np.isfinite(f).all())
    rho = f.sum(axis=0)
    cc = np.array(vs.c).T  # (q, 3)
    ux = (f * cc[:, 0].reshape(-1, 1, 1, 1)).sum(axis=0) / rho

    mid_z = nz // 2
    prof = ux[nx // 2 - 4, :, mid_z].tolist()
    peak = max(prof) if prof else 0.0
    interior = prof[3:ny - 3]
    mirror_err = 0.0
    if interior:
        n = len(interior)
        mirror_err = max(abs(interior[i] - interior[n - 1 - i]) for i in range(n)) / (abs(peak) or 1.0)
    return {
        "engine": "xlb",
        "grid": [nx, ny, nz],
        "reynolds": reynolds,
        "latticeVelocity": lattice_velocity,
        "omega": round(omega, 6),
        "steps": int(steps),
        "stable": finite,
        "maxUx": float(np.abs(ux).max()),
        "inletUx": float(ux[1, ny // 2, mid_z]),
        "upstreamZouheFixed": bool(upstream_zouhe_fixed),
        "centerline": [round(v, 6) for v in prof],
        "peakUx": float(peak),
        "mirrorError": float(mirror_err),
        "msPerStep": round(elapsed / steps * 1000.0, 3),
        "wallSeconds": round(elapsed, 2),
    }
