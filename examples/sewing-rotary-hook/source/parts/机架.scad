$fn = 64;
module box(x0, x1, y0, y1, z0, z1) {
  translate([x0, y0, z0]) cube([x1 - x0, y1 - y0, z1 - z0]);
}
difference() {
  union() {
    box(-80, 55, -85, 45, -50, -48.5);
    box(-80, 55, -85, -83.5, -50, 108);
    box(-30, 30, -84, -6.5, 108, 109.5);
    box(-30, 30, -8, -6.5, 88, 108.5);
    box(-80, -78.5, -84, -68.5, -50, 108);
    box(53.5, 55, -84, -68.5, -50, 108);
  }
  translate([-36, -83, 0]) rotate([90, 0, 0]) cylinder(h = 2, r = 35);
  translate([0, -26, 107]) cylinder(h = 3, r = 5);
  translate([8, -26, 107]) cylinder(h = 3, r = 1.7);
  translate([-8, -26, 107]) cylinder(h = 3, r = 1.7);
  translate([-40, -46, -51]) cylinder(h = 3, r = 1.7);
  translate([-40, -46, -50]) cylinder(h = 1.5, r1 = 3.25, r2 = 1.7);
  translate([12, -46, -51]) cylinder(h = 3, r = 1.7);
  translate([12, -46, -50]) cylinder(h = 1.5, r1 = 3.25, r2 = 1.7);
}
datum_plane("frame-base-top", [0, 0, -48.5], [0, 0, 1]);
datum_axis("frame-input-window", [-36, -84.25, 0], [0, 1, 0]);
datum_axis("frame-arm-bar", [0, -26, 108.75], [0, 0, 1]);
datum("frame-guide-bolt-1", [8, -26, 109.5]);
datum("frame-guide-bolt-2", [-8, -26, 109.5]);