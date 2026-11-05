include <parts.scad>
difference(){
 union(){
color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,0]) leg();
color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,90]) leg();
color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,180]) leg();
color([0.42,0.28,0.16]) translate([0,0,0]) rotate([0,0,270]) leg();
color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,0]) rail();
color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,90]) rail();
color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,180]) rail();
color([0.54,0.37,0.21]) translate([0,0,0]) rotate([0,0,270]) rail();
color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,0]) apron();
color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,90]) apron();
color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,180]) apron();
color([0.49,0.33,0.19]) translate([0,0,0]) rotate([0,0,270]) apron();
color([0.82,0.66,0.45]) translate([0,0,0]) rotate([0,0,0]) panel_outer();
color([0.82,0.66,0.45]) translate([0,0,0]) rotate([0,0,180]) panel_outer();
color([0.85,0.7,0.49]) translate([0,0,0]) rotate([0,0,0]) panel_middle();
color([0.62,0.44,0.26]) translate([-244,0,0]) rotate([0,0,0]) cleat();
color([0.62,0.44,0.26]) translate([0,0,0]) rotate([0,0,0]) cleat();
color([0.62,0.44,0.26]) translate([244,0,0]) rotate([0,0,0]) cleat();
color([0.88,0.78,0.58]) translate([0,-121,0]) rotate([0,0,0]) spline();
color([0.88,0.78,0.58]) translate([0,121,0]) rotate([0,0,0]) spline();
color([0.3,0.19,0.1]) translate([0,0,0]) rotate([0,0,0]) wedge();
color([0.3,0.19,0.1]) translate([0,0,0]) rotate([0,0,90]) wedge();
color([0.3,0.19,0.1]) translate([0,0,0]) rotate([0,0,180]) wedge();
color([0.3,0.19,0.1]) translate([0,0,0]) rotate([0,0,270]) wedge();
color([0.86,0.8,0.55]) translate([418,384,0]) rotate([0,0,0]) pin();
color([0.86,0.8,0.55]) translate([-384,418,0]) rotate([0,0,0]) pin();
color([0.86,0.8,0.55]) translate([-418,-384,0]) rotate([0,0,0]) pin();
color([0.86,0.8,0.55]) translate([384,-418,0]) rotate([0,0,0]) pin();
 }
 translate([-600,-600,-10]) cube([1200,600,1000]);
}
