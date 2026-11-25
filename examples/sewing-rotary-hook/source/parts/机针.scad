$fn = 64;
difference() {
  union() {
    translate([0, -18, 20.9]) cylinder(h = 42.2, r = 1.25);
    translate([0, -18, 18.5]) cylinder(h = 2.6, r1 = 0, r2 = 1.25);
    translate([0, -18, 62.9]) cylinder(h = 7.1, r = 1.6);
  }
  translate([-2, -18, 22.5]) rotate([0, 90, 0]) cylinder(h = 4, r = 0.5);
}
datum_axis("needle-axis", [0, -18, 40], [0, 0, 1]);
datum("needle-tip", [0, -18, 18.5]);
datum("needle-eye", [0, -18, 22.5]);