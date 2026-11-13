$fn = 96;
// Pocket clip v3: lower C-collar at z=110..112, strip rises to z=120,
// standing clear of the detent boss (boss y=10.0, z=117..121).
difference() {
    union() {
        translate([0,0,110.0]) difference() {
            cylinder(h=2.0, r=9.30, center=false);
            translate([0,0,-0.1]) cylinder(h=2.2, r=8.61, center=false);
            translate([-6,-12,109.0]) cube([12,6,4], center=false);
        }
        hull() {
            translate([-1.1, 9.0, 110.6]) cube([2.2,0.8,1.4], center=false);
            translate([-1.1, 10.4, 113.0]) cube([2.2,0.8,1.4], center=false);
        }
        hull() {
            translate([-1.1, 10.4, 113.0]) cube([2.2,0.8,1.4], center=false);
            translate([-1.1, 10.4, 118.4]) cube([2.2,0.8,3.0], center=false);
        }
        hull() {
            translate([-1.1, 10.4, 118.4]) cube([2.2,0.8,3.0], center=false);
            translate([-1.1, 10.5, 119.8]) cube([2.2,1.0,1.2], center=false);
        }
    }
}
