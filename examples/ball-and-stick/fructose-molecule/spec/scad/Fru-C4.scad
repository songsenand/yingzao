
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
heavy_boss([[-0.263707,0.030886,-0.964108,0.000000],[0.008149,0.999523,0.029792,0.000000],[0.964568,0.000000,-0.263833,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.083893,-0.962445,0.258189,0.000000],[-0.297421,-0.271477,-0.915337,0.000000],[0.951054,0.000000,-0.309026,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.286066,0.793742,0.536787,0.000000],[0.373302,-0.608255,0.700479,0.000000],[0.882503,0.000000,-0.470307,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[-0.677117,0.725418,0.123618,0.000000],[-0.713623,-0.688308,0.130283,0.000000],[0.179597,0.000000,0.983740,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C3",[-20.2463,0.6256,-5.5405]);
datum_axis("ax_C3",[-20.2463,0.6256,-5.5405],[-0.9641,0.0298,-0.2638]);
datum_cyl("cyl_C3",[-20.2463,0.6256,-5.5405],[-0.9641,0.0298,-0.2638],5.5000);
datum("to_C5",[5.4220,-19.2221,-6.4896]);
datum_axis("ax_C5",[5.4220,-19.2221,-6.4896],[0.2582,-0.9153,-0.3090]);
datum_cyl("cyl_C5",[5.4220,-19.2221,-6.4896],[0.2582,-0.9153,-0.3090],5.5000);
datum("to_O4",[11.2725,14.7101,-9.8764]);
datum_axis("ax_O4",[11.2725,14.7101,-9.8764],[0.5368,0.7005,-0.4703]);
datum_cyl("cyl_O4",[11.2725,14.7101,-9.8764],[0.5368,0.7005,-0.4703],5.5000);
datum("to_H06",[2.2869,2.4102,18.1992]);
datum_axis("ax_H06",[2.2869,2.4102,18.1992],[0.1236,0.1303,0.9837]);
datum_cyl("cyl_H06",[2.2869,2.4102,18.1992],[0.1236,0.1303,0.9837],3.2500);

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

