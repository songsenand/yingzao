$fn = 64;
union(){
  translate([0,0,12]) sphere(r=1.9);
  translate([0,0,12]) cylinder(h=4, r=2.0);
  translate([0,0,16]) cylinder(h=8, r=4.0);
}
datum("tip", [0,0,10.1]);
datum_axis("axis", [0,0,10.1], [0,0,1]);
datum_plane("spring-seat", [0,0,24], [0,0,1]);