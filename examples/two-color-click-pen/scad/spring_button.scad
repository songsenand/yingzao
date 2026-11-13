$fn = 16;
// Button return spring, installed length 28.0 mm (z=117.0..145).
linear_extrude(height=28.0, twist=360*8, slices=300, convexity=10)
    translate([2.4,0]) circle(r=0.30);
