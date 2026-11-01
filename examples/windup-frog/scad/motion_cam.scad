$fn=64;
phi = is_undef(phi) ? 0 : phi;
A=[4,0];
s = 2*(1-cos(phi));
module rotat(pt, ang) { translate([pt[0],pt[1],0]) rotate([0,0,ang]) translate([-pt[0],-pt[1],0]) children(); }
color("SteelBlue") import("m/base.stl");
color("Orange") rotat(A, phi) import("m/cam.stl");
color("Coral") translate([s,0,0]) import("m/slider.stl");
