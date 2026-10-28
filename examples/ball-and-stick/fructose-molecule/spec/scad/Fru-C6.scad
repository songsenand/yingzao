
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
heavy_boss([[-0.491260,0.513232,-0.703745,0.000000],[0.293773,0.858250,0.420838,0.000000],[0.819976,0.000000,-0.572397,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.078464,-0.975658,0.204779,0.000000],[-0.349089,-0.219297,-0.911068,0.000000],[0.933799,0.000000,-0.357799,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[0.891779,-0.328596,-0.311053,0.000000],[0.310264,0.944471,-0.108220,0.000000],[0.329342,0.000000,0.944211,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[0.002925,0.539588,0.841924,0.000000],[0.001875,-0.841929,0.539585,0.000000],[0.999994,0.000000,-0.003474,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C5",[-14.7786,8.8376,-12.0203]);
datum_axis("ax_C5",[-14.7786,8.8376,-12.0203],[-0.7037,0.4208,-0.5724]);
datum_cyl("cyl_C5",[-14.7786,8.8376,-12.0203],[-0.7037,0.4208,-0.5724],5.5000);
datum("to_O6",[4.3004,-19.1324,-7.5138]);
datum_axis("ax_O6",[4.3004,-19.1324,-7.5138],[0.2048,-0.9111,-0.3578]);
datum_cyl("cyl_O6",[4.3004,-19.1324,-7.5138],[0.2048,-0.9111,-0.3578],5.5000);
datum("to_H09",[-5.7545,-2.0021,17.4679]);
datum_axis("ax_H09",[-5.7545,-2.0021,17.4679],[-0.3111,-0.1082,0.9442]);
datum_cyl("cyl_H09",[-5.7545,-2.0021,17.4679],[-0.3111,-0.1082,0.9442],3.2500);
datum("to_H10",[15.5756,9.9823,-0.0643]);
datum_axis("ax_H10",[15.5756,9.9823,-0.0643],[0.8419,0.5396,-0.0035]);
datum_cyl("cyl_H10",[15.5756,9.9823,-0.0643],[0.8419,0.5396,-0.0035],3.2500);

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

