// Text wrapped around a cylinder, engraved (left) and embossed (right).
// Requires BOSL2 and the experimental textmetrics feature:
//   openscad --backend=Manifold --enable=textmetrics -o cylinder.stl cylinder.scad
// NOTE: reverse() the path, otherwise the glyphs come out mirrored/upside down:
// BOSL2's path normal for circle() points inward on the default (CW) path.
include <BOSL2/std.scad>
$fn   = 240;
FONT  = "Noto Sans CJK SC:style=Bold";
R     = 18;
H     = 26;
DEPTH = 0.8;
SIZE  = 5.5;
TXT   = "造物 浮雕";

path = reverse(path3d(circle(r = R, $fn = 360)));

translate([-30, 0, 0]) rotate([0, 0, -90]) difference() {
    cyl(r = R, h = H, center = true);
    path_text(path, TXT, size = SIZE, font = FONT, thickness = DEPTH,
              offset = -DEPTH / 2, textmetrics = true, center = true);
}

translate([30, 0, 0]) rotate([0, 0, -90]) union() {
    cyl(r = R, h = H, center = true);
    path_text(path, TXT, size = SIZE, font = FONT, thickness = DEPTH,
              offset = 0, textmetrics = true, center = true);
}
