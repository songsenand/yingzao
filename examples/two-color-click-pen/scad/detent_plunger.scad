$fn = 48;
// Purchased spring-ball detent cartridge, simplified.  Ball at z=0 (tip),
// body Ø3.0 x 1.85.  M3 body, light spring, ball Ø1.5.
translate([0,0,0.75]) sphere(r=0.75);
translate([0,0,0.75]) cylinder(h=1.85, r=1.5, center=false);
translate([0,0,2.4]) cylinder(h=0.20, r=1.5, center=false);
