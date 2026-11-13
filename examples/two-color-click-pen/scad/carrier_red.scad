$fn = 64;
// Red carrier v2.1: sleeve 89.5..100, rib 92..93.4, inner track post + pusher.
PAD_R      = -2.0;
PUSH_R     = -3.4;
POST_TOP   = 108.5;
ARM_TOP    = 100.0;
SLEEVE_TOP = 100.0;
SLEEVE_BOT = 89.5;
SHELL_ID   = 1.22;
SHELL_OD   = 1.82;

module half_shell() {
    difference() {
        intersection() {
            difference() {
                translate([0,0,SLEEVE_BOT])
                    cylinder(h=SLEEVE_TOP-SLEEVE_BOT, r=SHELL_OD, center=false);
                translate([0,0,SLEEVE_BOT-0.1])
                    cylinder(h=SLEEVE_TOP-SLEEVE_BOT+0.2, r=SHELL_ID, center=false);
            }
            translate([-2,-2,SLEEVE_BOT-0.2])
                cube([2,4,SLEEVE_TOP-SLEEVE_BOT+0.4], center=false);
        }
        intersection() {
            difference() {
                translate([0,0,92.0]) cylinder(h=1.4, r=1.30, center=false);
                translate([0,0,91.9]) cylinder(h=1.6, r=1.00, center=false);
            }
            translate([-2,-2,91.8]) cube([2,4,1.8], center=false);
        }
    }
}

module arm() {
    hull() {
        translate([-1.70, -1.0, 97.2]) cube([0.2, 2.0, 1.6], center=false);
        translate([-3.40, -1.0, 97.2]) cube([0.2, 2.0, 1.6], center=false);
    }
    translate([PAD_R-0.6, -0.6, ARM_TOP])
        cube([1.2, 1.2, POST_TOP-ARM_TOP], center=false);
    translate([PUSH_R-0.6, -0.6, 97.2])
        cube([1.2, 1.2, 1.6], center=false);
}

half_shell();
arm();
