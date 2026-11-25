$fn = 64;
difference() {
  translate([-16, -78, 0]) rotate([90, 0, 0]) cylinder(h = 14, r = 9);
  translate([-16, -76, 0]) rotate([90, 0, 0]) cylinder(h = 17, r = 4.05);
  translate([-16, -91, 0]) rotate([90, 0, 0]) cylinder(h = 1, r = 5.5);
}
datum_axis("knob-axis", [-16, -85, 0], [0, 1, 0]);
datum_plane("knob-face", [-16, -78, 0], [0, 1, 0]);