include <parts.scad>
difference(){
 intersection(){
  union(){
color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,0]) leg();color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,0]) rail();color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,270]) rail();color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,0]) apron();color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,270]) apron();color([0.30,0.19,0.10]) translate([0,0,0]) rotate([0,0,0]) wedge();color([0.86,0.80,0.55]) translate([418,384,0]) rotate([0,0,0]) pin();
  }
  translate([340,340,600]) cube([140,170,230]);
 }
 translate([420,300,590]) cube([300,300,260]);
}

