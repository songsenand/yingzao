$fn = 64;
// Purchased slim ballpoint refill, reference geometry. Local tip z=0, rear z=100.
L = 100;
r_body = 1.2;
r_tip  = 0.35;
r_ball = 0.35;

translate([0,0,r_ball]) sphere(r=r_ball);
translate([0,0,0.6]) cylinder(h=5.4, r1=r_tip, r2=r_body, center=false);
translate([0,0,6]) cylinder(h=L-6, r=r_body, center=false);
translate([0,0,L-0.5]) cylinder(h=0.5, r1=r_body, r2=r_body-0.25, center=false);
// retention groove for the plastic carrier (z=92.0..93.4)
translate([0,0,92.0]) cylinder(h=1.4, r=r_body-0.18, center=false);
translate([0,0,93.4]) cylinder(h=0.4, r1=r_body-0.18, r2=r_body, center=false);
translate([0,0,91.6]) cylinder(h=0.4, r1=r_body, r2=r_body-0.18, center=false);
