$fn = 64;
difference() {
  linear_extrude(height = 6)
    offset(r = 4)
      square([52, 32], center = true);
  for (x = [-22, 22])
    for (y = [-13, 13])
      translate([x, y, -1])
        cylinder(h = 8, d = 4.5);
}
datum("top", [0, 0, 6]);
datum_plane("top_plane", [0, 0, 6], [0, 0, 1]);
datum_axis("hole_axis", [22, 13, 0], [0, 0, 1]);
datum_cyl("hole", [22, 13, 0], [0, 0, 1], 2.25);
