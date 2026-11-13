$fn = 96;
// Button v4.1: skirt 0.40 mm; pawls widened to 1.2 radial x 1.6 wide with a
// 0.4 mm bottom chamfer (the 0.219 reading was the sharp pawl bottom edge).
R_CAP = 9.95;
Z_CAP0 = 132.0;
Z_CAP1 = 148.0;

module pawl(a) {
    rotate([0,0,a])
        translate([6.2, -0.8, 127.0])
            hull() {
                cube([1.2, 1.6, 0.01], center=false);                 // bottom, full
                translate([0.4, 0.4, 0.4]) cube([0.4, 0.8, 0.01], center=false); // inset
                translate([0, 0, 4.99]) cube([1.2, 1.6, 0.01], center=false);    // top, full
            }
}

difference() {
    union() {
        translate([0,0,Z_CAP0]) cylinder(h=Z_CAP1-Z_CAP0, r=R_CAP, center=false);
        translate([0,0,124.0]) difference() {
            cylinder(h=8.0, r=9.95, center=false);
            translate([0,0,-0.1]) cylinder(h=8.2, r=9.55, center=false);
        }
        translate([0,0,124.2]) difference() {
            cylinder(h=1.0, r=9.55, center=false);
            translate([0,0,-0.1]) cylinder(h=1.2, r=9.05, center=false);
        }
        for (a=[100,220,340]) pawl(a);
    }
    translate([0,0,Z_CAP0-0.1]) cylinder(h=13.0, r=6.5, center=false);
    translate([0,0,146.5]) cylinder(h=1.6, r1=0.0, r2=6.0, center=false);
    for (a=[100,220,340]) {
        rotate([0,0,a])
            translate([6.2,-0.8,126.5]) rotate([0,45,0])
                cube([1.0,1.6,1.0], center=false);
    }
}
