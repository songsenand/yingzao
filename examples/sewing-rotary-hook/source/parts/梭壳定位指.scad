$fn = 64;
difference() {
  union() {
    translate([13, 18, 22.5]) cube([10, 10, 1.5]);
    translate([17.25, 21, 4]) cube([1.5, 2, 19]);
    translate([18, 22, -0.5]) cylinder(h = 5, r = 1.0);
  }
  translate([18, 25.5, 22]) cylinder(h = 3, r = 1.7);
}
datum_axis("finger-pin", [18, 22, 1], [0, 0, 1]);
datum_plane("finger-top", [0, 0, 24], [0, 0, 1]);
datum_axis("finger-bolt", [18, 25.5, 23.25], [0, 0, 1]);