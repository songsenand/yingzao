$fn = 48;
module cylx(x0,x1,y,z,r){translate([x0,y,z]) rotate([0,90,0]) cylinder(h=x1-x0, r=r);}
difference(){
  union(){
    cylx(21.05, 23.05, 0, 30, 4.0);
    cylx(15.05, 21.05, 0, 30, 1.95);
    cylx(11.8, 15.05, 0, 30, 1.6);
  }
  translate([22.25,0,30]) rotate([0,90,0]) cylinder(h=1.2, r=2.0, $fn=6);
}
datum_axis("axis", [11.8,0,30], [1,0,0]);
datum_plane("head-face", [21.05,0,30], [-1,0,0]);
datum("thread-end", [11.8,0,30]);