
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

R=14.0000;
sphere(R);
heavy_boss([[-0.462624,-0.319188,-0.827102,0.000000],[-0.155814,0.947692,-0.278572,0.000000],[0.872755,0.000000,-0.488159,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.069306,0.953157,0.294428,0.000000],[0.218398,-0.302475,0.927799,0.000000],[0.973396,0.000000,-0.229131,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.214087,-0.601234,0.769860,0.000000],[-0.161082,-0.799073,-0.579253,0.000000],[0.963441,0.000000,-0.267919,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.897211,-0.415239,-0.150294,0.000000],[0.409533,0.909712,-0.068602,0.000000],[0.165211,0.000000,0.986258,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C1",[-17.3691,-5.8500,-10.2513]);
datum_axis("ax_C1",[-17.3691,-5.8500,-10.2513],[-0.8271,-0.2786,-0.4882]);
datum_cyl("cyl_C1",[-17.3691,-5.8500,-10.2513],[-0.8271,-0.2786,-0.4882],5.5000);
datum("to_C3",[6.1830,19.4838,-4.8117]);
datum_axis("ax_C3",[6.1830,19.4838,-4.8117],[0.2944,0.9278,-0.2291]);
datum_cyl("cyl_C3",[6.1830,19.4838,-4.8117],[0.2944,0.9278,-0.2291],5.5000);
datum("to_O5",[16.1671,-12.1643,-5.6263]);
datum_axis("ax_O5",[16.1671,-12.1643,-5.6263],[0.7699,-0.5793,-0.2679]);
datum_cyl("cyl_O5",[16.1671,-12.1643,-5.6263],[0.7699,-0.5793,-0.2679],5.5000);
datum("to_O2",[-3.1562,-1.4406,20.7114]);
datum_axis("ax_O2",[-3.1562,-1.4406,20.7114],[-0.1503,-0.0686,0.9863]);
datum_cyl("cyl_O2",[-3.1562,-1.4406,20.7114],[-0.1503,-0.0686,0.9863],5.5000);

// heavy boss: 11.0 mm OD, 7.0 mm exposed, 12-rib face spline, annular groove
module heavy_boss(M) {
  multmatrix(M) {
    difference() {
      union() {
        translate([0,0,R-2]) cylinder(h=9.0000,r=5.5000);
        translate([0,0,R+7.0000])
          spline_pos(12,2.9000,5.2000,0.6500,0.6000,0.2000,0,1.0,0.7);
      }
      translate([0,0,R+1.3500])
        difference() {
          cylinder(h=1.3000,r=5.6500);
          cylinder(h=1.3000,r=5.2000);
        }
    }
  }
}


// light boss: 6.5 mm OD, 4.5 mm exposed, round (terminal H only)
module light_boss(M) {
  multmatrix(M) {
    difference() {
      translate([0,0,R-2]) cylinder(h=6.5000,r=3.2500);
      translate([0,0,R+0.4500])
        difference() {
          cylinder(h=1.1000,r=3.4000);
          cylinder(h=1.1000,r=3.0500);
        }
    }
  }
}

