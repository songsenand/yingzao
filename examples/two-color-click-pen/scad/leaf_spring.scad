$fn = 48;
// Leaf-spring v2: 4 mm wide beam with a central refill clearance slot.
difference() {
    union() {
        translate([-6.5,-2.0,82.2]) cube([13.0,4.0,0.8], center=false);
        translate([-6.5,-2.0,82.2]) cube([1.0,4.0,0.8], center=false);
        translate([ 5.5,-2.0,82.2]) cube([1.0,4.0,0.8], center=false);
        translate([ 4.8,0,83.0]) cylinder(h=10.2, r=0.70, center=false);
        translate([-5.0,0,83.0]) cylinder(h=22.2, r=0.70, center=false);
    }
    // central slot for the two refills (x=+/-1.6, Ø2.4)
    hull() {
        translate([-1.6,0,82.1]) cylinder(h=1.0, r=1.40, center=false);
        translate([ 1.6,0,82.1]) cylinder(h=1.0, r=1.40, center=false);
    }
}
