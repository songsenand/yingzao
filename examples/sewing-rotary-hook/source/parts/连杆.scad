$fn = 64;
module cylY(cx, cz, y0, y1, r) {
  translate([cx, y1, cz]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}
difference() {
  union() {
    cylY(8.531, -9.813, -30.5, -28.5, 6);
    cylY(0, 62.5, -30.5, -28.5, 5);
    hull() {
      cylY(9.531, -9.813, -30.5, -28.5, 2);
      cylY(0, 62.5, -30.5, -28.5, 2);
    }
  }
  cylY(8.531, -9.813, -31.5, -27.5, 3.1);
  cylY(0, 62.5, -31.5, -27.5, 3.1);
}
datum_axis("rod-big-end", [8.531, -29.5, -9.813], [0, 1, 0]);
datum_axis("rod-small-end", [0, -29.5, 62.5], [0, 1, 0]);