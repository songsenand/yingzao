$fn = 64;

difference(){
  cylinder(h=9, r=21);
  translate([0,0,4.5]) rotate_extrude() polygon([[17,2.5],[21,4.5],[17,6.5]]);
  translate([0,0,-0.5]) cylinder(h=10, r=13.05);
}
datum_plane("face-in", [0,0,0], [0,0,-1]);
datum_plane("face-out", [0,0,9], [0,0,1]);
datum_axis("bore-axis", [0,0,0], [0,0,1]);