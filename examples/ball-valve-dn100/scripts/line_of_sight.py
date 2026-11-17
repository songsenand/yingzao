#!/usr/bin/env python3
"""Line-of-sight open area through a full-port ball valve vs. handle angle.

NOT CFD. A ray-cast through the seat bore: for every (y,z) inside the Ø104 seat
bore, march along the pipe axis (x) and ask whether the ray is ever inside the
BALL SOLID — the Ø160 sphere minus the Ø100 bore (and minus the stem slot, which
does not reach the bore). A ray that never enters the solid is open.

Read it as a LINE-OF-SIGHT number, not as a flow area: a ball valve bends the
flow through the ball, so once the port tilts far enough no straight ray gets
through even though water still passes (the 45° MPM run puts ~75% of the seeded
water at the outlet). What this measures is when the straight path closes.
"""
import math

import numpy as np

R_BALL = 80.0
R_BORE = 50.0
R_SEAT = 52.0
DN = 100.0
V_INLET = 2.0            # m/s
X = np.arange(-200.0, 200.5, 0.5)


def open_area(angle_deg: float, n: int = 121) -> float:
    th = math.radians(angle_deg)
    u = np.array([math.cos(th), math.sin(th), 0.0])          # bore axis
    # seat-bore disc grid
    lin = np.linspace(-R_SEAT, R_SEAT, n)
    y, z = np.meshgrid(lin, lin, indexing="xy")
    mask = y * y + z * z <= R_SEAT * R_SEAT
    y, z = y[mask], z[mask]
    # points along the ray: (x, y, z)
    px = X[:, None]
    py = np.broadcast_to(y, (X.size, y.size))
    pz = np.broadcast_to(z, (X.size, y.size))
    inside_sphere = px * px + py * py + pz * pz < R_BALL * R_BALL
    # distance to the (infinite) bore axis
    along = px * u[0] + py * u[1]                     # (pz * 0)
    perp2 = (px - along * u[0]) ** 2 + (py - along * u[1]) ** 2 + pz * pz
    in_bore = perp2 < R_BORE * R_BORE
    blocked = np.any(inside_sphere & ~in_bore, axis=0)
    a0 = math.pi * R_SEAT * R_SEAT
    return float((~blocked).sum()) / mask.sum() * a0


def main() -> None:
    a0 = math.pi * min(R_BORE, R_SEAT) ** 2
    q = V_INLET * math.pi * (DN / 2000.0) ** 2
    print(f"DN{DN:.0f} full port · inlet {V_INLET} m/s → Q = {q * 3600:.1f} m³/h · A0(Ø{2*R_BORE:.0f}) = {a0:.0f} mm²")
    print("line-of-sight area through the seat bore (not a flow area — the path bends):")
    print(f"{'角度':>5} {'A(mm²)':>9} {'A/A0':>7} {'D_eq(mm)':>9} {'v_jet(m/s)':>11}")
    for deg in (0, 5, 10, 20, 30, 45, 60, 70, 80, 85, 90):
        a = open_area(deg)
        deq = math.sqrt(4 * a / math.pi)
        v = q / (a * 1e-6) if a > 0 else float("inf")
        print(f"{deg:5d} {a:9.1f} {a / a0:7.3f} {deq:9.2f} {v:11.2f}")


if __name__ == "__main__":
    main()
