$fn = 96;
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
difference() {
  translate([0, -65, 0]) rotate([90, 0, 0])
    spur_gear(mod = 1.5, teeth = 24, thickness = 10, backlash = 0.3, gear_spin = 0);
  intersection() {
    translate([0, -65, 0]) rotate([90, 0, 0]) cylinder(h = 14, r = 5.1, center = true);
    translate([-30, -72, -30]) cube([33.6, 14, 60]);
  }
}
datum_axis("gear-axis", [0, -65, 0], [0, 1, 0]);
datum_plane("gear-face", [0, -60, 0], [0, 1, 0]);
datum_axis("gear-bore", [0, -65, 0], [0, 1, 0]);