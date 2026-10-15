"""Numba port of the worker's MLS-MPM kernel — PROBE ONLY, not production code.

What is ported (worker.py `_mpm_step_once`, current as of 2026-10-14):
  * P2G pass 1  (mass + APIC momentum, 27 taps)      -> `_p2g_mass_momentum`  [serial njit]
  * density + EOS stress (per particle)              -> `_density_stress`      [prange]
  * P2G pass 2  (stress impulses, 27 taps)           -> `_p2g_stress`          [serial njit]
  * G2P gather (27 taps, free-slip renormalization)  -> `_g2p`                 [prange]

What stays NUMPY (identical code path in both engines, so the measured delta is
exactly the 27-tap sections): grid velocity normalization + boundary conditions
(solidMask / solidNormal), the G2P tail (affine scale, C_new, gravity, speed
clamp, inlet drive, NaN guard, advection + box clamp, recycle, escape, write-back).

Semantics preserved on purpose:
  * particle state float32, grid mass/momentum float64, grid velocity float32
    (worker keeps f64 grid so bincount accumulation is f64 — mirrored here by
    accumulating in float64 inside the scatter loops);
  * P2G stays SERIAL: np.bincount accumulates in particle order, so the serial
    loop is the closest legal ordering without atomics (numba nopython has none);
  * G2P is per-particle independent -> prange is race-free by construction;
  * stencil base clipped to [0, cells-2]; quadratic B-spline weights in float32.

Known intentional deviation vs the numpy kernel: the float ADDITION order inside
a tap differs (bincount goes tap-by-tap over all particles; the serial loop goes
particle-by-particle over all taps), so results are close, not bit-identical.
The probe quantifies the drift instead of asserting bitwise parity.
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
def _p2g_mass_momentum(pos, vel, C, grid_mass, grid_mom, active, nx, ny, nz):
    """P2G pass 1: mass + APIC momentum. Serial (bincount-order semantics)."""
    nyz = ny * nz
    for p in range(active):
        px = pos[p, 0]
        py = pos[p, 1]
        pz = pos[p, 2]
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


class NumbaEngine:
    """Buffers + step for one world; mirrors worker `_mpm_step_once` structure."""

    def __init__(self, world):
        import numpy as _np

        self.world = world
        cells = world["cells"]
        self.total = cells[0] * cells[1] * cells[2]
        n = world["n"]
        self.grid_mass = _np.zeros(self.total, dtype=_np.float64)
        self.grid_mom = _np.zeros((self.total, 3), dtype=_np.float64)
        self.grid_vel = _np.zeros((self.total, 3), dtype=_np.float32)
        self.stress = _np.zeros((n, 6), dtype=_np.float32)
        self.gathered = _np.zeros((n, 3), dtype=_np.float32)
        self.wsum = _np.zeros(n, dtype=_np.float32)
        self.b = _np.zeros((n, 9), dtype=_np.float32)
        self.mask_u8 = None
        if world.get("solidMask") is not None:
            self.mask_u8 = world["solidMask"].view(_np.uint8)
        self.dummy_mask = _np.zeros(1, dtype=_np.uint8)

    def step(self):
        import numpy as np

        world = self.world
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
        self.grid_mass.fill(0.0)
        self.grid_mom.fill(0.0)

        _p2g_mass_momentum(pos, vel, C, self.grid_mass, self.grid_mom, active, nx, ny, nz)
        _density_stress(
            pos, C, self.grid_mass, self.stress[:active], active, nx, ny, nz,
            rest_density, stiffness, viscosity, dt,
        )
        _p2g_stress(pos, self.stress[:active], self.grid_mom, active, nx, ny, nz)

        # --- grid update: verbatim structure from worker (numpy) ---
        grid_mass = self.grid_mass
        grid_mom = self.grid_mom
        mass_safe = np.where(grid_mass > 0, grid_mass, 1.0)
        grid_vel = self.grid_vel
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
        gathered = self.gathered[:active]
        wsum = self.wsum[:active]
        b = self.b[:active]
        gathered.fill(0.0)
        wsum.fill(0.0)
        b.fill(0.0)
        if self.mask_u8 is not None:
            _g2p(pos, grid_vel, self.mask_u8, gathered, wsum, b, active, nx, ny, nz, vmax, 1)
        else:
            _g2p(pos, grid_vel, self.dummy_mask, gathered, wsum, b, active, nx, ny, nz, vmax, 0)

        # --- tail: verbatim structure from worker (numpy) ---
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
