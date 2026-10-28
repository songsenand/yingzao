
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
heavy_boss([[-0.462624,0.319188,0.827102,0.000000],[-0.155814,-0.947692,0.278572,0.000000],[0.872755,0.000000,0.488159,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.064858,-0.970521,-0.232128,0.000000],[0.261166,0.241018,-0.934720,0.000000],[0.963113,0.000000,0.269099,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[0.986030,0.104139,0.130003,0.000000],[0.103246,-0.994563,0.013612,0.000000],[0.130714,0.000000,-0.991420,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[0.190806,0.601114,-0.776051,0.000000],[-0.143520,0.799163,0.583729,0.000000],[0.971079,0.000000,0.238757,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C2",[17.3691,5.8500,10.2513]);
datum_axis("ax_C2",[17.3691,5.8500,10.2513],[0.8271,0.2786,0.4882]);
datum_cyl("cyl_C2",[17.3691,5.8500,10.2513],[0.8271,0.2786,0.4882],5.5000);
datum("to_O1",[-4.8747,-19.6291,5.6511]);
datum_axis("ax_O1",[-4.8747,-19.6291,5.6511],[-0.2321,-0.9347,0.2691]);
datum_cyl("cyl_O1",[-4.8747,-19.6291,5.6511],[-0.2321,-0.9347,0.2691],5.5000);
datum("to_H01",[2.4051,0.2518,-18.3413]);
datum_axis("ax_H01",[2.4051,0.2518,-18.3413],[0.1300,0.0136,-0.9914]);
datum_cyl("cyl_H01",[2.4051,0.2518,-18.3413],[0.1300,0.0136,-0.9914],3.2500);
datum("to_H02",[-14.3569,10.7990,4.4170]);
datum_axis("ax_H02",[-14.3569,10.7990,4.4170],[-0.7761,0.5837,0.2388]);
datum_cyl("cyl_H02",[-14.3569,10.7990,4.4170],[-0.7761,0.5837,0.2388],3.2500);

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

