$fn = 96;
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
difference() {
  translate([-36, -65, 0]) rotate([90, 0, 0])
    spur_gear(mod = 1.5, teeth = 24, thickness = 10, backlash = 0.3, gear_spin = 7.5);
  intersection() {
    translate([-36, -65, 0]) rotate([90, 0, 0]) cylinder(h = 14, r = 5.1, center = true);
    translate([-66, -72, -30]) cube([33.6, 14, 60]);
  }
}
datum_axis("gear-axis", [-36, -65, 0], [0, 1, 0]);
datum_plane("gear-face", [-36, -60, 0], [0, 1, 0]);
datum_axis("gear-bore", [-36, -65, 0], [0, 1, 0]);