
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
heavy_boss([[0.083893,0.962445,-0.258189,0.000000],[-0.297421,0.271477,0.915337,0.000000],[0.951054,0.000000,0.309026,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[0.020378,-0.560767,-0.827723,0.000000],[0.013802,0.827974,-0.560597,0.000000],[0.999697,0.000000,0.024612,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
heavy_boss([[-0.491260,-0.513232,0.703745,0.000000],[0.293773,-0.858250,-0.420838,0.000000],[0.819976,0.000000,0.572397,0.000000],[0.000000,0.000000,0.000000,1.000000]]);
light_boss([[0.950560,0.012631,0.310285,0.000000],[0.012008,-0.999920,0.003920,0.000000],[0.310310,0.000000,-0.950635,0.000000],[0.000000,0.000000,0.000000,1.000000]]);

// ---- datums ----
datum("to_C4",[-5.4220,19.2221,6.4896]);
datum_axis("ax_C4",[-5.4220,19.2221,6.4896],[-0.2582,0.9153,0.3090]);
datum_cyl("cyl_C4",[-5.4220,19.2221,6.4896],[-0.2582,0.9153,0.3090],5.5000);
datum("to_O5",[-17.3822,-11.7725,0.5169]);
datum_axis("ax_O5",[-17.3822,-11.7725,0.5169],[-0.8277,-0.5606,0.0246]);
datum_cyl("cyl_O5",[-17.3822,-11.7725,0.5169],[-0.8277,-0.5606,0.0246],5.5000);
datum("to_C6",[14.7786,-8.8376,12.0203]);
datum_axis("ax_C6",[14.7786,-8.8376,12.0203],[0.7037,-0.4208,0.5724]);
datum_cyl("cyl_C6",[14.7786,-8.8376,12.0203],[0.7037,-0.4208,0.5724],5.5000);
datum("to_H08",[5.7403,0.0725,-17.5868]);
datum_axis("ax_H08",[5.7403,0.0725,-17.5868],[0.3103,0.0039,-0.9506]);
datum_cyl("cyl_H08",[5.7403,0.0725,-17.5868],[0.3103,0.0039,-0.9506],3.2500);

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

