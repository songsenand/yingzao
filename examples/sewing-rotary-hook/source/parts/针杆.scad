$fn = 64;
module cylY(cx, cz, y0, y1, r) {
  translate([cx, y1, cz]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}
difference() {
  union() {
    translate([-8, -39, 56.5]) cube([16, 27, 12]);
    translate([0, -26, 67.5]) cylinder(h = 39, r = 4);
  }
  translate([0, -18, 50]) cylinder(h = 13.2, r = 1.25);
  translate([0, -18, 63]) cylinder(h = 6, r = 1.65);
  translate([-0.75, -17.9, 57.5]) cube([1.5, 5.9, 8.5]);
  translate([-9, -15, 62]) rotate([0, 90, 0]) cylinder(h = 18, r = 1.6);
  translate([-5.6, -30.7, 50]) cube([11.2, 2.4, 20]);
  cylY(0, 62.5, -40, -30.7, 3);
  cylY(0, 62.5, -28.3, -22, 3);
}
datum_axis("bar-axis", [0, -26, 80], [0, 0, 1]);
datum_axis("clamp-pin", [0, -29.5, 62.5], [0, 1, 0]);
datum_axis("needle-axis", [0, -18, 62], [0, 0, 1]);
datum_plane("head-top", [0, -20, 68.5], [0, 0, 1]);