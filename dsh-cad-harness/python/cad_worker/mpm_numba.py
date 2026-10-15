"""Numba engine for the MLS-MPM kernel (worker `_mpm_step_once`).

Adopted 2026-10-14 from `experiments/20261014_numba_mpm_probe.md` (user decision,
DECISION-LOG same day): on the pipe benchmark this engine runs the kernel
5.1-8.7x faster than the numpy kernel and 1.3-2.0x faster than the TS kernel,
with micro parity at float32 rounding scale and macro parity exact.

Engine selection is the WORKER'S decision, resolved once per process by
`worker._mpm_engine()`:

  * `CAD_MPM_ENGINE=numba`  -> numba REQUIRED; if it cannot import, raise.
    A forced engine that silently falls back would make every acceptance run a
    "silent false pass" — the exact defect class this harness exists to prevent.
  * `CAD_MPM_ENGINE=numpy`  -> the numpy kernel (parity oracle runs use this).
  * unset                   -> numba when importable, else numpy. The lock
    excludes numba on linux-musl and darwin-x64 (no cp313 wheels), so those
    targets legitimately run numpy — the fallback is a platform fact, not an
    error, and `op_versions` / the stderr banner make it visible.

Numerics, same contract as the probe kernel:

  * particle state float32, grid mass/momentum float64, grid velocity float32 —
    the exact dtypes of the TS kernel and of the numpy kernel's buffers;
  * P2G passes are SERIAL: `np.bincount` accumulates in particle order, so a
    serial loop is the same summation ORDER (the one ordering that keeps P2G
    machine-precision identical to the numpy kernel — verified 4.2e-16);
  * G2P is per-particle independent -> `prange` is race-free by construction;
  * the grid update and the G2P tail (affine scale, C_new, gravity, speed clamp,
    inlet drive, NaN guard, advection + box clamp, recycle, escape) stay NUMPY
    here, mirroring `_mpm_step_once` line for line, so both engines share one
    tail implementation of every drive/audit rule.

Buffers are allocated once per world (`world["mpmNumbaScratch"]`) and reused —
the same discipline that took the numpy kernel from 941 MB to 229 MB at 564k
particles. Escape shrinks `activeN` but never the buffers.
"""

from __future__ import annotations

import numpy as np
from numba import njit, prange


@njit(cache=True)
def _axis_weights32(coord):
    """Three quadratic B-spline taps along one axis, float32 (worker `_weights32`)."""
    frac = np.float32(coord - np.floor(coord)) - np.float32(0.5)
    w0 = np.float32(0.5) * (np.float32(0.5) - frac) * (np.float32(0.5) - frac)
    w1 = np.float32(0.75) - frac * frac
    w2 = np.float32(0.5) * (np.float32(0.5) + frac) * (np.float32(0.5) + frac)
    return w0, w1, w2


@njit(cache=True)
def _stencil_base(px, py, pz, nx, ny, nz):
    """Clipped stencil base per axis (worker: `np.clip(floor(pos)-1, 0, cells-2)`)."""
    b0 = int(np.floor(px)) - 1
    b1 = int(np.floor(py)) - 1
    b2 = int(np.floor(pz)) - 1
    if b0 < 0:
        b0 = 0
    elif b0 > nx - 2:
        b0 = nx - 2
    if b1 < 0:
        b1 = 0
    elif b1 > ny - 2:
        b1 = ny - 2
    if b2 < 0:
        b2 = 0
    elif b2 > nz - 2:
        b2 = nz - 2
    return b0, b1, b2


@njit(cache=True)
def _p2g_mass_momentum(pos, vel, C, grid_mass, grid_mom, active, nx, ny, nz):
    """P2G pass 1: mass + APIC momentum. Serial (bincount-order semantics)."""
    nyz = ny * nz
    for p in range(active):
        px = pos[p, 0]
        py = pos[p, 1]
        pz = pos[p, 2]
        b0, b1, b2 = _stencil_base(px, py, pz, nx, ny, nz)
        w0x, w1x, w2x = _axis_weights32(px)
        w0y, w1y, w2y = _axis_weights32(py)
        w0z, w1z, w2z = _axis_weights32(pz)
        wx0 = (w0x, w1x, w2x)
        wy0 = (w0y, w1y, w2y)
        wz0 = (w0z, w1z, w2z)
        c00 = C[p, 0, 0]
        c01 = C[p, 0, 1]
        c02 = C[p, 0, 2]
        c10 = C[p, 1, 0]
        c11 = C[p, 1, 1]
        c12 = C[p, 1, 2]
        c20 = C[p, 2, 0]
        c21 = C[p, 2, 1]
        c22 = C[p, 2, 2]
        v0 = vel[p, 0]
        v1 = vel[p, 1]
        v2 = vel[p, 2]
        for i in range(3):
            d0 = np.float32(np.float32(b0 + i + 0.5) - px)
            base_x = (b0 + i) * nyz
            for j in range(3):
                d1 = np.float32(np.float32(b1 + j + 0.5) - py)
                base_xy = base_x + (b1 + j) * nz
                for k in range(3):
                    d2 = np.float32(np.float32(b2 + k + 0.5) - pz)
                    cell = base_xy + (b2 + k)
                    w = wx0[i] * wy0[j] * wz0[k]
                    wd = np.float64(w)
                    grid_mass[cell] += wd
                    # Q = C @ d, float32 like the numpy row ops
                    q0 = c00 * d0 + c01 * d1 + c02 * d2
                    q1 = c10 * d0 + c11 * d1 + c12 * d2
                    q2 = c20 * d0 + c21 * d1 + c22 * d2
                    grid_mom[cell, 0] += wd * np.float64(v0 + q0)
                    grid_mom[cell, 1] += wd * np.float64(v1 + q1)
                    grid_mom[cell, 2] += wd * np.float64(v2 + q2)


@njit(cache=True, parallel=True)
def _density_stress(pos, C, grid_mass, stress, active, nx, ny, nz, rest_density, stiffness, viscosity, dt):
    """Per-particle density gather + weakly-compressible EOS stress. prange-safe."""
    nyz = ny * nz
    for p in prange(active):
        px = pos[p, 0]
        py = pos[p, 1]
        pz = pos[p, 2]
        b0, b1, b2 = _stencil_base(px, py, pz, nx, ny, nz)
        w0x, w1x, w2x = _axis_weights32(px)
        w0y, w1y, w2y = _axis_weights32(py)
        w0z, w1z, w2z = _axis_weights32(pz)
        wx0 = (w0x, w1x, w2x)
        wy0 = (w0y, w1y, w2y)
        wz0 = (w0z, w1z, w2z)
        density = 0.0
        for i in range(3):
            base_x = (b0 + i) * nyz
            for j in range(3):
                base_xy = base_x + (b1 + j) * nz
                for k in range(3):
                    cell = base_xy + (b2 + k)
                    w = np.float64(wx0[i] * wy0[j] * wz0[k])
                    density += w * grid_mass[cell]
        if density != 0.0:
            volume = 1.0 / density
        else:
            volume = 1.0
        dr = density / rest_density
        over = dr**5 - 1.0
        if over < 0.0:
            over = 0.0
        pressure = stiffness * over
        scale = volume * -4.0 * dt
        c00 = C[p, 0, 0]
        c01 = C[p, 0, 1]
        c02 = C[p, 0, 2]
        c10 = C[p, 1, 0]
        c11 = C[p, 1, 1]
        c12 = C[p, 1, 2]
        c20 = C[p, 2, 0]
        c21 = C[p, 2, 1]
        c22 = C[p, 2, 2]
        vp = viscosity * 2.0
        stress[p, 0] = np.float32(scale * (-pressure + vp * c00))
        stress[p, 3] = np.float32(scale * (-pressure + vp * c11))
        stress[p, 5] = np.float32(scale * (-pressure + vp * c22))
        stress[p, 1] = np.float32(scale * (viscosity * (c01 + c10)))
        stress[p, 2] = np.float32(scale * (viscosity * (c02 + c20)))
        stress[p, 4] = np.float32(scale * (viscosity * (c12 + c21)))


@njit(cache=True)
def _p2g_stress(pos, stress, grid_mom, active, nx, ny, nz):
    """P2G pass 2: stress impulses. Serial (same ordering rationale as pass 1)."""
    nyz = ny * nz
    for p in range(active):
        px = pos[p, 0]
        py = pos[p, 1]
        pz = pos[p, 2]
        b0, b1, b2 = _stencil_base(px, py, pz, nx, ny, nz)
        w0x, w1x, w2x = _axis_weights32(px)
        w0y, w1y, w2y = _axis_weights32(py)
        w0z, w1z, w2z = _axis_weights32(pz)
        wx0 = (w0x, w1x, w2x)
        wy0 = (w0y, w1y, w2y)
        wz0 = (w0z, w1z, w2z)
        s00 = stress[p, 0]
        s01 = stress[p, 1]
        s02 = stress[p, 2]
        s11 = stress[p, 3]
        s12 = stress[p, 4]
        s22 = stress[p, 5]
        for i in range(3):
            d0 = np.float32(np.float32(b0 + i + 0.5) - px)
            base_x = (b0 + i) * nyz
            for j in range(3):
                d1 = np.float32(np.float32(b1 + j + 0.5) - py)
                base_xy = base_x + (b1 + j) * nz
                for k in range(3):
                    d2 = np.float32(np.float32(b2 + k + 0.5) - pz)
                    cell = base_xy + (b2 + k)
                    w = wx0[i] * wy0[j] * wz0[k]
                    wd = np.float64(w)
                    i0 = s00 * d0 + s01 * d1 + s02 * d2
                    i1 = s01 * d0 + s11 * d1 + s12 * d2
                    i2 = s02 * d0 + s12 * d1 + s22 * d2
                    grid_mom[cell, 0] += wd * np.float64(i0)
                    grid_mom[cell, 1] += wd * np.float64(i1)
                    grid_mom[cell, 2] += wd * np.float64(i2)


@njit(cache=True, parallel=True)
def _g2p(pos, grid_vel, mask, gathered, wsum, b, active, nx, ny, nz, vmax, use_mask):
    """G2P gather with free-slip renormalization. prange-safe (per-particle writes)."""
    nyz = ny * nz
    for p in prange(active):
        px = pos[p, 0]
        py = pos[p, 1]
        pz = pos[p, 2]
        b0, b1, b2 = _stencil_base(px, py, pz, nx, ny, nz)
        w0x, w1x, w2x = _axis_weights32(px)
        w0y, w1y, w2y = _axis_weights32(py)
        w0z, w1z, w2z = _axis_weights32(pz)
        wx0 = (w0x, w1x, w2x)
        wy0 = (w0y, w1y, w2y)
        wz0 = (w0z, w1z, w2z)
        acc0 = np.float32(0.0)
        acc1 = np.float32(0.0)
        acc2 = np.float32(0.0)
        ws = np.float32(0.0)
        b00 = np.float32(0.0)
        b01 = np.float32(0.0)
        b02 = np.float32(0.0)
        b10 = np.float32(0.0)
        b11 = np.float32(0.0)
        b12 = np.float32(0.0)
        b20 = np.float32(0.0)
        b21 = np.float32(0.0)
        b22 = np.float32(0.0)
        for i in range(3):
            d0 = np.float32(np.float32(b0 + i + 0.5) - px)
            base_x = (b0 + i) * nyz
            for j in range(3):
                d1 = np.float32(np.float32(b1 + j + 0.5) - py)
                base_xy = base_x + (b1 + j) * nz
                for k in range(3):
                    d2 = np.float32(np.float32(b2 + k + 0.5) - pz)
                    cell = base_xy + (b2 + k)
                    w = wx0[i] * wy0[j] * wz0[k]
                    if use_mask != 0 and mask[cell] != 0:
                        # free-slip renormalization: solid cells are EXCLUDED,
                        # otherwise near-wall particles get dragged by the zeros.
                        w = np.float32(0.0)
                    g0 = np.float32(min(max(np.float64(grid_vel[cell, 0]), -vmax), vmax))
                    g1 = np.float32(min(max(np.float64(grid_vel[cell, 1]), -vmax), vmax))
                    g2 = np.float32(min(max(np.float64(grid_vel[cell, 2]), -vmax), vmax))
                    t0 = w * g0
                    t1 = w * g1
                    t2 = w * g2
                    acc0 += t0
                    acc1 += t1
                    acc2 += t2
                    ws += w
                    b00 += t0 * d0
                    b01 += t0 * d1
                    b02 += t0 * d2
                    b10 += t1 * d0
                    b11 += t1 * d1
                    b12 += t1 * d2
                    b20 += t2 * d0
                    b21 += t2 * d1
                    b22 += t2 * d2
        gathered[p, 0] = acc0
        gathered[p, 1] = acc1
        gathered[p, 2] = acc2
        wsum[p] = ws
        b[p, 0] = b00
        b[p, 1] = b01
        b[p, 2] = b02
        b[p, 3] = b10
        b[p, 4] = b11
        b[p, 5] = b12
        b[p, 6] = b20
        b[p, 7] = b21
        b[p, 8] = b22


def _scratch(world) -> dict:
    """Per-world work buffers, allocated ONCE and reused (worker `_mpm_scratch` discipline)."""
    cells = world["cells"]
    total = cells[0] * cells[1] * cells[2]
    scratch = world.get("mpmNumbaScratch")
    if scratch is None or scratch["total"] != total or scratch["capacity"] < world["n"]:
        n = world["n"]
        scratch = {
            "total": total,
            "capacity": n,
            "grid_mass": np.zeros(total, dtype=np.float64),
            "grid_mom": np.zeros((total, 3), dtype=np.float64),
            "grid_vel": np.zeros((total, 3), dtype=np.float32),
            "stress": np.zeros((n, 6), dtype=np.float32),
            "gathered": np.zeros((n, 3), dtype=np.float32),
            "wsum": np.zeros(n, dtype=np.float32),
            "b": np.zeros((n, 9), dtype=np.float32),
        }
        world["mpmNumbaScratch"] = scratch
    return scratch


def step_once(world) -> None:
    """One MLS-MPM step via the numba kernels. Mirrors `_mpm_step_once` structure."""
    config = world["config"]
    cells = world["cells"]
    nx, ny, nz = cells
    dt = float(config["dt"])
    vmax = float(config["vmax"])
    rest_density = world["restDensity"]
    stiffness = float(config.get("stiffness", 50))
    viscosity = float(config.get("viscosity", 0.1))
    active = world["activeN"]
    pos = world["pos"][:active]
    vel = world["vel"][:active]
    C = world["C"][:active]
    scratch = _scratch(world)
    grid_mass = scratch["grid_mass"]
    grid_mom = scratch["grid_mom"]
    grid_mass.fill(0.0)
    grid_mom.fill(0.0)

    _p2g_mass_momentum(pos, vel, C, grid_mass, grid_mom, active, nx, ny, nz)
    stress = scratch["stress"][:active]
    _density_stress(
        pos, C, grid_mass, stress, active, nx, ny, nz, rest_density, stiffness, viscosity, dt
    )
    _p2g_stress(pos, stress, grid_mom, active, nx, ny, nz)

    # --- grid update: verbatim from the numpy kernel ---
    mass_safe = np.where(grid_mass > 0, grid_mass, 1.0)
    grid_vel = scratch["grid_vel"]
    grid_vel[:] = (grid_mom / mass_safe[:, None]).astype(np.float32)
    grid_vel[grid_mass <= 0] = 0.0
    grid_view = grid_vel.reshape(nx, ny, nz, 3)
    if nx > 2:
        grid_view[0, :, :, 0] = 0.0
        grid_view[nx - 1, :, :, 0] = 0.0
    if ny > 2:
        grid_view[:, 0, :, 1] = 0.0
        grid_view[:, ny - 1, :, 1] = 0.0
    if nz > 2:
        grid_view[:, :, 0, 2] = 0.0
        grid_view[:, :, nz - 1, 2] = 0.0
    mask = world.get("solidMask")
    code = world.get("solidNormal")
    if mask is not None and code is not None:
        m = mask.reshape(nx, ny, nz)
        c = code.reshape(nx, ny, nz)
        grid_view[:, :, :, 0] = np.where(m & ((c == 1) | (c == 2)), 0.0, grid_view[:, :, :, 0])
        grid_view[:, :, :, 1] = np.where(m & ((c == 3) | (c == 4)), 0.0, grid_view[:, :, :, 1])
        grid_view[:, :, :, 2] = np.where(m & ((c == 5) | (c == 6)), 0.0, grid_view[:, :, :, 2])

    # --- G2P gather (numba) ---
    gathered = scratch["gathered"][:active]
    wsum = scratch["wsum"][:active]
    b = scratch["b"][:active]
    gathered.fill(0.0)
    wsum.fill(0.0)
    b.fill(0.0)
    if mask is not None:
        _g2p(pos, grid_vel, mask.view(np.uint8), gathered, wsum, b, active, nx, ny, nz, vmax, 1)
    else:
        _g2p(pos, grid_vel, grid_mass.view(np.uint8), gathered, wsum, b, active, nx, ny, nz, vmax, 0)

    # --- tail: verbatim from the numpy kernel ---
    scale = np.where(wsum > 0.5, 1.0 / np.where(wsum == 0.0, 1.0, wsum), 1.0).astype(np.float32)
    gathered *= scale[:, None]
    b *= scale[:, None]
    bad = ~np.isfinite(b[:, 0] + b[:, 4] + b[:, 8])
    if bad.any():
        b[bad] = 0.0
        gathered[bad] = 0.0
    C_new = world["C"][:active]
    C_new[:] = (4.0 * b).reshape(-1, 3, 3)

    gravity = np.asarray(config.get("gravity") or [0.0, 0.0, 0.0], dtype=np.float64)
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
