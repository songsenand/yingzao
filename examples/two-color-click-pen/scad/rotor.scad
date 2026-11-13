$fn = 96;
// Rotor v2.7: 1.6 mm cam rings, ratchet base collar outer radius 7.4 -> 7.6
// (flush with the top plate) so the z=123 edge is no longer a thin exposed step.
R_OUT = 7.6;
Z_TOP0 = 116.5;
Z_TOP1 = 122.0;
RIB_TOP = 104.5;

function ang(a) = ((a % 360) + 360) % 360;

function hb(a) =
    let(t = ang(a))
    t < 30  ? 96 :
    t < 90  ? 96 + 8*(t-30)/60 :
    t < 270 ? 104 :
    t < 330 ? 104 - 8*(t-270)/60 :
              96;

function hr(a) =
    let(t = ang(a))
    t < 30  ? 102 - 6*(t/30) :
    t < 90  ? 96 :
    t < 150 ? 96 + 12*(t-90)/60 :
    t < 330 ? 108 :
              108 - 6*((t-330)/30);

module black_track() {
    for (a=[0:2:358]) {
        h = hb(a);
        if (h < RIB_TOP - 0.01) {
            rotate([0,0,a])
                translate([5.5, -0.18, h])
                    cube([1.6, 0.36, RIB_TOP-h], center=false);
        }
    }
    for (a=[30,150,270])
        rotate([0,0,a])
            translate([5.5, -0.45, RIB_TOP])
                cube([1.6, 0.9, Z_TOP0-RIB_TOP], center=false);
}

module red_track() {
    for (a=[0:2:358]) {
        h = hr(a) + 8.5;
        if (h < Z_TOP0 - 0.01) {
            rotate([0,0,a])
                translate([2.8, -0.18, h])
                    cube([1.6, 0.36, Z_TOP0-h], center=false);
        }
    }
}

module ratchet() {
    translate([0,0,122]) difference() {
        cylinder(h=1.0, r=7.6, center=false);
        translate([0,0,-0.1]) cylinder(h=1.2, r=6.0, center=false);
    }
    for (k=[0:2]) {
        for (a=[0:2:110]) {
            h = 4*a/110;
            if (h > 0.01) {
                rotate([0,0,k*120+a])
                    translate([6.0, -0.18, 123])
                        cube([1.4, 0.36, h], center=false);
            }
        }
    }
}

difference() {
    union() {
        translate([0,0,Z_TOP0]) cylinder(h=Z_TOP1-Z_TOP0, r=R_OUT, center=false);
        translate([0,0,Z_TOP0]) cylinder(h=0.5, r=3.2, center=false);
        black_track();
        red_track();
        ratchet();
    }
    translate([0,0,117.0]) cylinder(h=5.2, r=3.0, center=false);
    translate([0,0,116.4]) cylinder(h=0.7, r=1.8, center=false);
    for (k=[0:2]) {
        rotate([0,0,90+k*120])
            translate([7.95,0,119]) sphere(r=0.75);
    }
}
