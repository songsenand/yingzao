$fn = 96;
// Front barrel v2: spring pusher holes changed to x=+4.8 and x=-5.0.
REF_X = 1.6;

module outer_shell() {
    rotate_extrude(convexity=10)
        polygon(points=[
            [0,0],[4.0,0],[4.4,8],[5.4,15],[6.2,20],[7.0,30],
            [7.8,45],[8.0,55],[8.0,85],[0,85]
        ]);
}

module inner_cavity() {
    rotate_extrude(convexity=10)
        polygon(points=[
            [0,8],[2.9,8],[4.8,20],[6.6,45],[7.3,83],[0,83]
        ]);
}

module grip_grooves() {
    for (z=[30,35,40]) {
        translate([0,0,z]) difference() {
            cylinder(h=1.0, r=8.2, center=false);
            cylinder(h=1.1, r=6.7, center=false);
        }
    }
}

module refill_slot(h=1.0) {
    hull() {
        translate([-REF_X,0,0]) cylinder(h=h, r=1.35, center=false);
        translate([ REF_X,0,0]) cylinder(h=h, r=1.35, center=false);
    }
}

difference() {
    union() {
        outer_shell();
        translate([0,0,44]) cylinder(h=2.0, r=6.65, center=false);
        translate([0,0,69]) cylinder(h=2.0, r=7.15, center=false);
        translate([0,0,83]) cylinder(h=2.0, r=7.9, center=false);
        translate([0,0,84.9]) difference() {
            cylinder(h=3.1, r=7.9, center=false);
            translate([0,0,-0.1]) cylinder(h=3.3, r=7.2, center=false);
        }
    }
    inner_cavity();
    for (x=[-REF_X,REF_X])
        translate([x,0,-0.1]) cylinder(h=8.3, r=1.2, center=false);
    translate([0,0,42.9]) refill_slot(h=45.6);
    // leaf-spring pusher holes
    translate([4.8,0,82.9]) cylinder(h=5.4, r=0.9, center=false);
    translate([-5.0,0,82.9]) cylinder(h=5.4, r=0.9, center=false);
    grip_grooves();
}
