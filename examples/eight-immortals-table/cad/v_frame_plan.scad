include <parts.scad>
difference(){
 union(){
color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,0]) rail();color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,90]) rail();color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,180]) rail();color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,270]) rail();color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,0]) leg();color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,90]) leg();color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,180]) leg();color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,270]) leg();color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,0]) apron();color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,90]) apron();color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,180]) apron();color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,270]) apron();
 }
 translate([-600,-600,779]) cube([1200,1200,400]);
}

