$fn = 96;
// Cap ring v2.1: body wall 0.2 -> 0.40 mm (outer 8.85 -> 9.05), flange
// 0.3 -> 0.4 mm (outer 9.15 -> 9.45).  Snap rib and z levels unchanged.
difference() {
    union() {
        translate([0,0,122.0]) difference() {
            cylinder(h=6.0, r=9.05, center=false);
            translate([0,0,-0.1]) cylinder(h=6.2, r=8.65, center=false);
        }
        translate([0,0,125.2]) difference() {
            cylinder(h=1.0, r=9.45, center=false);
            translate([0,0,-0.1]) cylinder(h=1.2, r=9.05, center=false);
        }
        translate([0,0,124.2]) difference() {
            cylinder(h=1.6, r=8.65, center=false);
            translate([0,0,-0.1]) cylinder(h=1.8, r=8.22, center=false);
        }
    }
}
