$fn = 64;
difference() {
  union() {
    translate([-38, -44, 24]) cube([78, 66, 4]);
    translate([13, 18, 24]) cube([9, 12, 4]);
  }
  translate([-15, -6, 23]) cube([30, 20, 6]);
  translate([0, -18, 23]) cylinder(h = 6, r = 2.25);
  translate([-12, -32, 23]) cube([24, 6, 6]);
  translate([14, -40, 23]) cylinder(h = 6, r = 1.7);
  translate([-14, -40, 23]) cylinder(h = 6, r = 1.7);
  translate([18, 25.5, 23]) cylinder(h = 6, r = 1.4);
}
datum_plane("plate-top", [0, 0, 28], [0, 0, 1]);
datum_axis("needle-hole", [0, -18, 26], [0, 0, 1]);
datum("boss-hole-1", [14, -40, 24]);
datum("boss-hole-2", [-14, -40, 24]);
datum_axis("finger-bolt", [18, 25.5, 26], [0, 0, 1]);
datum_plane("plate-front", [0, 22, 26], [0, 1, 0]);
datum_plane("plate-bottom", [0, 0, 24], [0, 0, -1]);