$fn = 96;
module cylY(cx, cz, y0, y1, r) {
  translate([cx, y1, cz]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}
difference() {
  union() {
    cylY(-36, 0, -96, -34, 4.98);
    cylY(-36, 0, -60, -58.4, 6);
    cylY(-36, 0, -34, -31.5, 6);
    hull() {
      cylY(-36, 0, -96, -92, 7);
      cylY(-16, 0, -96, -92, 6);
    }
    cylY(-16, 0, -92, -76, 4);
  }
  translate([-32.5, -70, -30]) cube([30, 10, 60]);
  difference() {
    cylY(-36, 0, -71.5, -70.4, 5.2);
    cylY(-36, 0, -71.5, -70.4, 4.3);
  }
}
datum_axis("input-axis", [-36, -60, 0], [0, 1, 0]);
datum_axis("input-gear-seat", [-36, -65, 0], [0, 1, 0]);
datum_axis("input-bearing-rear", [-36, -50, 0], [0, 1, 0]);
datum_axis("input-bearing-front", [-36, -38, 0], [0, 1, 0]);
datum_axis("crank-pin-axis", [-16, -94, 0], [0, 1, 0]);
datum_axis("knob-pin-axis", [-16, -84, 0], [0, 1, 0]);
datum("input-front-end", [-36, -34, 0]);