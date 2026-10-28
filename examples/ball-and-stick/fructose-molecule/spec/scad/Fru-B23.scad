
$fn=64;
// ---- shared interface modules: edit the numbers only here ----
module rib_pos(r1,r2,w,h,cham) {
  hull() {
    translate([r1,-w/2,0]) cube([r2-r1,w,h-cham]);
    translate([r1+cham,-w/2+cham,h-cham]) cube([r2-r1-2*cham,w-2*cham,cham]);
  }
}
module spline_pos(n,r1,r2,w,h,cham,phase=0,wkey=1.0,hkey=0.7) {
  // rib 0 is the key rib: wider and taller, so only one angular position seats
  for (i=[0:n-1])
    rotate([0,0,phase+i*360/n])
      if (i==0) rib_pos(r1,r2,wkey,hkey,cham); else rib_pos(r1,r2,w,h,cham);
}
module spline_neg(n,r1,r2,w,h,depth,phase=0,wkey=1.0,hkey=0.7,depthkey=0.75) {
  // rectangular pockets, 0.1mm wider / 0.05mm deeper than the ribs
  for (i=[0:n-1])
    rotate([0,0,phase+i*360/n])
      if (i==0)
        translate([r1-0.05,-(wkey+0.1)/2,-depthkey]) cube([r2-r1+0.1,wkey+0.1,depthkey+0.01]);
      else
        translate([r1-0.05,-(w+0.1)/2,-depth]) cube([r2-r1+0.1,w+0.1,depth+0.01]);
}

L=15.0266;
phaseB=0.0000;
light_rod(L);

// one light cup, opening +Z, origin on the seating face
module cup_l() {
  difference() {
    union() {
      difference() {
        cylinder(h=4.5000,r=4.1500);
        translate([0,0,-0.01]) cylinder(h=4.5200,r=3.3500);
      }
      translate([0,0,-1.8]) cylinder(h=1.8,r=4.1500);
      translate([0,0,3.5000])
        rotate_extrude(convexity=10)
          polygon([[3.5000,-0.5000],[3.1750,0],[3.5000,0.5000]]);
    }
    translate([0,0,4.1000])
      cylinder(h=0.4100,r1=3.3500,r2=3.7500);
    for (a=[60,180,300]) rotate([0,0,a])
      translate([2.8500,-0.2250,0.5]) cube([1.6,0.4500,4.3000]);
  }
}
module light_rod(L) {
  translate([0,0,-L/2+4.5000]) rotate([180,0,0]) cup_l();
  translate([0,0, L/2-4.5000]) cup_l();
  translate([0,0,-L/2+5.8000]) cylinder(h=max(0.1,L-11.6000),r=3.0000);
  translate([0,0,-L/2+5.8000]) cylinder(h=0.8,r1=4.1500,r2=3.0000);
  translate([0,0, L/2-6.6000]) cylinder(h=0.8,r1=3.0000,r2=4.1500);
}


// ---- datums ----
datum("A_face",[0.0000,0.0000,-3.0133]);
datum_axis("A_axis",[0.0000,0.0000,-3.0133],[0.0000,0.0000,-1.0000]);
datum_cyl("A_cyl",[0.0000,0.0000,-3.0133],[0.0000,0.0000,-1.0000],3.3500);
datum("B_face",[0.0000,0.0000,3.0133]);
datum_axis("B_axis",[0.0000,0.0000,3.0133],[0.0000,0.0000,1.0000]);
datum_cyl("B_cyl",[0.0000,0.0000,3.0133],[0.0000,0.0000,1.0000],3.3500);
