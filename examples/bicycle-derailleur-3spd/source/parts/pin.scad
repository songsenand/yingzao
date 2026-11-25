$fn = 48;
union(){
  translate([0,3.8,0]) rotate([-90,0,0]) cylinder(h=8.5, r=2.45);
  translate([0,12.3,0]) rotate([-90,0,0]) cylinder(h=2.0, r=4.0);
}
datum_plane("head-face", [0,12.3,0], [0,-1,0]);
datum_axis("axis", [0,12.3,0], [0,1,0]);
datum("tip", [0,3.8,0]);