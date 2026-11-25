import cadquery as cq

# ===== 机架 frame : 轴座凸台 Ø26->Ø28 (衬套法兰沉孔外壁 0.8 -> 1.8) =====
SLAB_Z0, SLAB_Z1 = 21.0, 29.0
SLAB_X, SLAB_Y0, SLAB_Y1 = 31.0, -45.0, 34.0
LEG = 10.0
BOSS_R, BOSS_Z1 = 14.0, 37.0
BORES = [(0.0, 0.0), (0.0, -30.0)]

f = (cq.Workplane("XY").box(2 * SLAB_X, SLAB_Y1 - SLAB_Y0, SLAB_Z1 - SLAB_Z0)
     .translate((0, (SLAB_Y0 + SLAB_Y1) / 2, (SLAB_Z0 + SLAB_Z1) / 2)))
for sx in (-1, 1):
    for y in (-40.0, 27.0):
        f = f.union(cq.Workplane("XY").box(LEG, LEG, SLAB_Z0 - 3.0)
                    .translate((sx * (SLAB_X - 5.0), y, 3.0 + (SLAB_Z0 - 3.0) / 2)))
for (bx, by) in BORES:
    f = f.union(cq.Workplane("XY").circle(BOSS_R).extrude(BOSS_Z1 - SLAB_Z1)
                .translate((bx, by, SLAB_Z1)))
    f = f.cut(cq.Workplane("XY").circle(9.0).extrude(BOSS_Z1 - SLAB_Z0)
              .translate((bx, by, SLAB_Z0)))
    f = f.cut(cq.Workplane("XY").circle(12.2).extrude(BOSS_Z1 - 35.0)
              .translate((bx, by, 35.0)))
f = f.union(cq.Workplane("XY").box(6.5, 6.0, 7.0).translate((-4.75, 26.0, 32.5)))
f = f.cut(cq.Workplane("YZ").circle(2.1).extrude(20, both=True).translate((0, 26.0, 33.0)))
for x in (-4.0, 4.0):
    f = f.cut(cq.Workplane("XY").circle(1.25).extrude(5).translate((x, 30.4, 26.0)))
result = f

datum_axis("hook_bore", [0, 0, SLAB_Z0], [0, 0, 1])
datum_axis("lower_bore", [0, -30.0, SLAB_Z0], [0, 0, 1])
datum_plane("seat", [0, 0, BOSS_Z1], [0, 0, 1])
datum_plane("slab_top", [0, 0, SLAB_Z1], [0, 0, 1])
datum("opener_hinge", [0, 26.0, 33.0])
datum("finger_mount", [0, 30.4, 29.0])