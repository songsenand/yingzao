$fn = 96;
module cylY(y0, y1, r) {
  translate([0, y1, 0]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}
difference() {
  union() {
    cylY(9.5, 11.3, 15.2);
    cylY(21.7, 23.5, 15.2);
    cylY(9.5, 23.5, 9.0);
  }
  cylY(9.0, 24.0, 3.1);
}
datum_axis("bobbin-axis", [0, 16.5, 0], [0, 1, 0]);
datum_plane("bobbin-face", [0, 23.5, 0], [0, 1, 0]);
datum_plane("bobbin-back", [0, 9.5, 0], [0, -1, 0]);
datum_axis("bobbin-bore", [0, 16.5, 0], [0, 1, 0]);