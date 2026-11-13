$fn = 96;
// Rotor retainer v2: under the 116.5 top plate.
difference() {
    union() {
        translate([0,0,115.1]) cylinder(h=1.4, r=7.70, center=false);
        for (k=[0:2])
            rotate([0,0,k*120])
                translate([7.65,0,115.4]) cylinder(h=0.8, r=0.30, center=false);
    }
    translate([0,0,115.0]) cylinder(h=1.6, r=7.25, center=false);
}
