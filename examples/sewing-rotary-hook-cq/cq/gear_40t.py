import cadquery as cq
import math

# ===== 大齿轮 gear_40t : m=1 z=40, 齿相位 +4.5° 与20T错开半齿保证啮合 =====
m, z, width, bore, z0, phase = 1.0, 40, 1.2, 13.95, 14.4, 4.5
al = math.radians(20.0)
rp, ra, rf = m * z / 2.0, m * z / 2.0 + m, m * z / 2.0 - 1.25 * m
rb = rp * math.cos(al)
psi_p = (math.pi * m / 2.0 - 0.10) / (2.0 * rp)

def inv(a):
    return math.tan(a) - a

def ha(r):
    if r <= rb:
        return psi_p + inv(al)
    return psi_p + inv(al) - inv(math.acos(min(1.0, rb / r)))

ss = [rb + (ra - rb) * i / 14.0 for i in range(15)]
pts = []
for k in range(z):
    off = 2 * math.pi * k / z + math.radians(phase)
    pts += [(r, -ha(r) + off) for r in ss]
    pts += [(ra, -ha(ra) + 2 * ha(ra) * i / 5.0 + off) for i in range(1, 5)]
    pts += [(r, ha(r) + off) for r in reversed(ss[1:])]
    pts += [(rf, ha(rb) + off), (rf, 2 * math.pi / z - ha(rb) + off)]
poly = [(r * math.cos(a), r * math.sin(a)) for (r, a) in pts]
g = (cq.Workplane("XY").moveTo(*poly[0]).polyline(poly[1:]).close()
     .extrude(width).translate((0, 0, z0)))
g = g.cut(cq.Workplane("XY").circle(bore / 2.0).extrude(width + 2).translate((0, 0, z0 - 1)))
result = g

datum_axis("gear_axis", [0, 0, z0], [0, 0, 1])
datum_cyl("bore", [0, 0, z0], [0, 0, 1], bore / 2.0)
datum_plane("face_low", [0, 0, z0], [0, 0, 1])
datum("pitch_pt", [rp, 0, z0 + width / 2.0])