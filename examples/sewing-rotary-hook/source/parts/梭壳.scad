$fn = 96;
module cylY(y0, y1, r) {
  translate([0, y1, 0]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}
union() {
  difference() {
    union() {
      cylY(2.6, 6.7, 18.3);
      cylY(6.55, 24.0, 17.0);
      translate([15.8, 19.5, -1.0]) cube([4.4, 5.0, 2.5]);
    }
    cylY(9.0, 24.5, 15.7);
    translate([18.0, 22.0, -2.0]) cylinder(h = 5, r = 1.2);
  }
  cylY(8.5, 15.0, 3.0);
}
datum_axis("case-axis", [0, 10, 0], [0, 1, 0]);
datum_plane("case-face", [0, 24, 0], [0, 1, 0]);
datum_plane("case-back", [0, 2.6, 0], [0, -1, 0]);
datum_plane("case-cavity-floor", [0, 9, 0], [0, 1, 0]);
datum_axis("case-tab-hole", [18.0, 22.0, 0.25], [0, 0, 1]);