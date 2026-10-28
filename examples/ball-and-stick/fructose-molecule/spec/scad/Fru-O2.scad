
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

R=12.5000;
sphere(R);
heavy_boss([[0.897211,0.415239,0.150294,0.000000],[0.409533,-0.909712,0.068602,0.000000],[0.165211,0.000000,-0.986258,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[-0.231874,0.865721,0.443579,0.000000],[-0.401053,-0.500527,0.767221,0.000000],[0.886223,0.000000,0.463259,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C2",[2.9307,1.3377,-19.2320]);
datum_axis("ax_C2",[2.9307,1.3377,-19.2320],[0.1503,0.0686,-0.9863]);
datum_cyl("cyl_C2",[2.9307,1.3377,-19.2320],[0.1503,0.0686,-0.9863],5.5000);
datum("to_H03",[7.5408,13.0428,7.8754]);
datum_axis("ax_H03",[7.5408,13.0428,7.8754],[0.4436,0.7672,0.4633]);
datum_cyl("cyl_H03",[7.5408,13.0428,7.8754],[0.4436,0.7672,0.4633],3.2500);

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

