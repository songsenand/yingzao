$fn = 48;
rotate([90, 0, 0]) cylinder(h = 8, r = 3, center = true);
datum_axis("pin-axis", [0, 0, 0], [0, 1, 0]);
datum_plane("pin-end", [0, -4, 0], [0, -1, 0]);