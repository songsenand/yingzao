// README example: M8×30 hex bolt + M8 hex nut, real ISO metric thread.
// Thread pitch 1.25 mm; nut 13 mm across flats, 6.5 mm high.
include <BOSL2/std.scad>
include <BOSL2/threading.scad>

$fn = 64;
$fa = 2;
$fs = 1;
pitch = 1.25;

// bolt: shank from z=0, hex head on top
threaded_rod(d = 8, l = 30, pitch = pitch, anchor = BOTTOM);
translate([0, 0, 30])
  cylinder(d = 13, h = 5.5, $fn = 6);

// nut, threaded onto the shank, with a few exposed threads above it
translate([0, 0, 9])
  threaded_nut(nutwidth = 13, id = 8, h = 6.5, pitch = pitch,
               $slop = 0.1, anchor = BOTTOM);
