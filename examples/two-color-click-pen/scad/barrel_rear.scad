$fn = 96;
// Rear barrel v2: z=85..128, boss at z=119, retainer holes at 115.9,
// cap-ring groove at 124..126.
R_OUT = 8.6;
Z0 = 85.0;
Z1 = 128.0;

difference() {
    union() {
        translate([0,0,Z0]) cylinder(h=Z1-Z0, r=R_OUT, center=false);
        translate([0,0,Z0]) cylinder(h=0.8, r=R_OUT, center=false);
        translate([0,8.4,119]) rotate([-90,0,0]) cylinder(h=1.6, r=2.0, center=false);
    }
    translate([0,0,Z0-0.1]) cylinder(h=3.2, r=8.0, center=false);
    translate([0,0,88.0]) cylinder(h=Z1-88.0+0.1, r=7.7, center=false);
    for (k=[0:2])
        rotate([0,0,k*120])
            translate([7.5,0,115.9]) rotate([0,90,0])
                cylinder(h=1.4, r=0.36, center=false);
    translate([0,7.4,119]) rotate([-90,0,0]) cylinder(h=2.6, r=1.5, center=false);
    translate([0,0,124.0]) difference() {
        cylinder(h=2.0, r=R_OUT+0.2, center=false);
        cylinder(h=2.1, r=8.2, center=false);
    }
    translate([0,0,Z1-0.5]) cylinder(h=0.6, r1=7.7, r2=7.95, center=false);
    translate([0,0,Z0-0.1]) cylinder(h=0.7, r1=8.15, r2=8.0, center=false);
}
