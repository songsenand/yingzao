
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
heavy_boss([[0.069306,-0.953157,-0.294428,0.000000],[0.218398,0.302475,-0.927799,0.000000],[0.973396,0.000000,0.229131,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[-0.263707,-0.030886,0.964108,0.000000],[0.008149,-0.999523,-0.029792,0.000000],[0.964568,0.000000,0.263833,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.284969,0.810906,-0.511102,0.000000],[-0.394894,0.585177,0.708256,0.000000],[0.873414,0.000000,0.486979,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[-0.428177,0.899714,-0.084732,0.000000],[0.882598,0.436481,0.174657,0.000000],[0.194125,0.000000,-0.980977,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C2",[-6.1830,-19.4838,4.8117]);
datum_axis("ax_C2",[-6.1830,-19.4838,4.8117],[-0.2944,-0.9278,0.2291]);
datum_cyl("cyl_C2",[-6.1830,-19.4838,4.8117],[-0.2944,-0.9278,0.2291],5.5000);
datum("to_C4",[20.2463,-0.6256,5.5405]);
datum_axis("ax_C4",[20.2463,-0.6256,5.5405],[0.9641,-0.0298,0.2638]);
datum_cyl("cyl_C4",[20.2463,-0.6256,5.5405],[0.9641,-0.0298,0.2638],5.5000);
datum("to_O3",[-10.7331,14.8734,10.2266]);
datum_axis("ax_O3",[-10.7331,14.8734,10.2266],[-0.5111,0.7083,0.4870]);
datum_cyl("cyl_O3",[-10.7331,14.8734,10.2266],[-0.5111,0.7083,0.4870],5.5000);
datum("to_H04",[-1.5675,3.2312,-18.1481]);
datum_axis("ax_H04",[-1.5675,3.2312,-18.1481],[-0.0847,0.1747,-0.9810]);
datum_cyl("cyl_H04",[-1.5675,3.2312,-18.1481],[-0.0847,0.1747,-0.9810],3.2500);

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

