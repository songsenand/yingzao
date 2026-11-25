$fn = 64;
module boreY(cx, cz, y0, y1, r) {
  translate([cx, y1, cz]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}
difference() {
  union() {
    translate([-52, -58, -48.5]) cube([74, 24, 68.5]);
    translate([14, -40, 20]) cylinder(h = 4, r = 5);
    translate([-14, -40, 20]) cylinder(h = 4, r = 5);
  }
  boreY(0, 0, -58, -34, 5.2);
  boreY(-36, 0, -58, -34, 5.2);
  boreY(0, 0, -54, -46, 13);
  boreY(0, 0, -42, -34, 13);
  boreY(-36, 0, -54, -46, 13);
  boreY(-36, 0, -42, -34, 13);
  boreY(0, 0, -46, -42, 6.2);
  boreY(-36, 0, -46, -42, 6.2);
  translate([14, -40, 16]) cylinder(h = 9, r = 1.4);
  translate([-14, -40, 16]) cylinder(h = 9, r = 1.4);
  translate([-40, -46, -48.5]) cylinder(h = 9, r = 1.4);
  translate([12, -46, -48.5]) cylinder(h = 9, r = 1.4);
}
datum_axis("arbor-bore", [0, -44, 0], [0, 1, 0]);
datum_axis("input-bore", [-36, -44, 0], [0, 1, 0]);
datum("plate-boss-1", [14, -40, 24]);
datum("plate-boss-2", [-14, -40, 24]);
datum_plane("block-top", [0, -40, 20], [0, 0, 1]);
datum_plane("block-bottom", [0, -46, -48.5], [0, 0, -1]);
datum_plane("block-front", [0, -34, 0], [0, 1, 0]);