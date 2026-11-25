$fn = 96;

module cylY(y0, y1, r) {
  translate([0, y1, 0]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}

module sector_ring(r0, r1, a0, a1, h, y0) {
  translate([0, y0, 0]) rotate([90, 0, 0])
    linear_extrude(height = h)
      polygon(concat(
        [for (a = [a0:1.5:a1]) [r1*cos(a), r1*sin(a)]],
        [for (a = [a1:-1.5:a0]) [r0*cos(a), r0*sin(a)]]
      ));
}

PX = 13 * cos(311);
PZ = 13 * sin(311);
ANG = 49;

difference() {
  union() {
    cylY(-8, 8, 22.5);
    sector_ring(19, 22.5, 72, 96, 5, -7.5);
    cylY(-26, -7.5, 4.98);
    cylY(-72, -33.2, 4.98);
    cylY(-60, -58.4, 6);
    cylY(-46, -42, 6);
    cylY(-33.8, -25.5, 5.9);
    rotate([0, ANG, 0]) translate([5.0, -33.8, -7]) cube([15, 8.3, 14]);
  }
  cylY(2, 8.5, 18.8);
  sector_ring(17, 24, 96, 112, 24, 10);
  rotate([0, ANG, 0]) translate([5.0, -30.7, -7]) cube([15, 2.4, 14]);
  translate([PX, 0, PZ]) cylY(-34.5, -25, 3);
  translate([3.5, -70, -30]) cube([10, 10, 60]);
  difference() {
    cylY(-71.5, -70.4, 5.2);
    cylY(-71.5, -70.4, 4.3);
  }
}

datum("hook-center", [0, 0, 0]);
datum_axis("hook-axis", [0, -40, 0], [0, 1, 0]);
datum_plane("hook-face", [0, 8, 0], [0, 1, 0]);
datum_axis("crank-pin-axis", [PX, -29.5, PZ], [0, 1, 0]);
datum_axis("gear-seat-axis", [0, -65, 0], [0, 1, 0]);
datum_plane("gear-seat-face", [0, -60, 0], [0, 1, 0]);
datum_axis("bearing-rear", [0, -50, 0], [0, 1, 0]);
datum_axis("bearing-front", [0, -38, 0], [0, 1, 0]);
datum("hook-tip", [22.5 * cos(96), -10, 22.5 * sin(96)]);