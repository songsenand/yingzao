
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

L=22.9765;
phaseB=0.0000;
heavy_rod(L,phaseB);

// one heavy cup, opening +Z, origin on the seating face
module cup_h(phase=0) {
  difference() {
    union() {
      difference() {
        cylinder(h=7.0000,r=6.4000);
        translate([0,0,-0.01]) cylinder(h=7.0200,r=5.6000);
      }
      translate([0,0,-2]) cylinder(h=2,r=6.4000);
      translate([0,0,5.0000])
        rotate_extrude(convexity=10)
          polygon([[5.7500,-0.6000],[5.3750,0],[5.7500,0.6000]]);
    }
    // lead-in at the rim
    translate([0,0,6.4000])
      cylinder(h=0.6100,r1=5.6000,r2=6.1500);
    // 12-rib face spline pockets
    spline_neg(12,2.9000,5.2000,0.6500,0.6000,0.6500,phase,1.0,0.7,0.75);
    // four relief slits through the bead ring
    for (a=[45,135,225,315]) rotate([0,0,a])
      translate([5.0000,-0.2500,1.0]) cube([2.0,0.5000,6.0000]);
  }
}
module heavy_rod(L,phaseB) {
  translate([0,0,-L/2+7.0000]) rotate([180,0,0]) cup_h(0);
  translate([0,0, L/2-7.0000]) cup_h(phaseB);
  translate([0,0,-L/2+8.5000]) cylinder(h=max(0.1,L-17.0000),r=5.2500);
  translate([0,0,-L/2+8.5000]) cylinder(h=1.5,r1=6.4000,r2=5.2500);
  translate([0,0, L/2-10.0000]) cylinder(h=1.5,r1=5.2500,r2=6.4000);
}


// ---- datums ----
datum("A_face",[0.0000,0.0000,-4.4882]);
datum_axis("A_axis",[0.0000,0.0000,-4.4882],[0.0000,0.0000,-1.0000]);
datum_cyl("A_cyl",[0.0000,0.0000,-4.4882],[0.0000,0.0000,-1.0000],5.6000);
datum("B_face",[0.0000,0.0000,4.4882]);
datum_axis("B_axis",[0.0000,0.0000,4.4882],[0.0000,0.0000,1.0000]);
datum_cyl("B_cyl",[0.0000,0.0000,4.4882],[0.0000,0.0000,1.0000],5.6000);
