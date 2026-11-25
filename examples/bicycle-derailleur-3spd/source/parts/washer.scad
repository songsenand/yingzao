$fn = 64;
difference(){
  cylinder(h=0.8, r=7);
  translate([0,0,-0.5]) cylinder(h=2, r=2.1);
}
datum_plane("face-in", [0,0,0], [0,0,-1]);
datum_plane("face-out", [0,0,0.8], [0,0,1]);
datum_axis("axis", [0,0,0], [0,0,1]);