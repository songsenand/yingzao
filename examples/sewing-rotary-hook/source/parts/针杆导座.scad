$fn = 64;
difference() {
  translate([-15, -35, 94]) cube([30, 18, 14]);
  translate([0, -26, 90]) cylinder(h = 20, r = 4.1);
  translate([8, -26, 97]) cylinder(h = 12, r = 1.4);
  translate([-8, -26, 97]) cylinder(h = 12, r = 1.4);
}
datum_axis("guide-axis", [0, -26, 101], [0, 0, 1]);
datum_plane("guide-top", [0, -26, 108], [0, 0, 1]);