$fn=64;
phi = is_undef(phi) ? 0 : phi;
A=[4,0]; B=[15.6906,8.1826]; C=[22.6701,-1.7857];
module rotat(pt, ang) { translate([pt[0],pt[1],0]) rotate([0,0,ang]) translate([-pt[0],-pt[1],0]) children(); }
color("SteelBlue") import("m/base.stl");
color("Goldenrod") rotat(A, phi) import("m/drum.stl");
color("Gold") rotat(A, phi) import("m/lid.stl");
color("MediumSeaGreen") rotat(B, -3*phi) import("m/gearB.stl");
color("Teal") rotat(C, 7.2*phi) import("m/fly.stl");
color("Silver") import("m/arbor.stl");
