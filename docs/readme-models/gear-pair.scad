// README example: 20T / 10T spur gear pair, module 1.5, 6 mm face.
// Ratio 2:1; nominal centre distance 22.5 mm.
include <BOSL2/std.scad>
include <BOSL2/gears.scad>

teeth_a = 20;
teeth_b = 10;
mod = 1.5;
face = 6;
shaft = 5;
dist = gear_dist(mod = mod, teeth1 = teeth_a, teeth2 = teeth_b);

color("#c9a227")
  spur_gear(mod = mod, teeth = teeth_a, thickness = face, shaft_diam = shaft);

translate([dist, 0, 0])
  color("#3b6ea5")
    spur_gear(mod = mod, teeth = teeth_b, thickness = face, shaft_diam = shaft);
