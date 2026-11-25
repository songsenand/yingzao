$fn = 64;
module boxo(x0,x1,y0,y1,z0,z1){translate([x0,y0,z0]) cube([x1-x0,y1-y0,z1-z0]);}
module cylx(x0,x1,y,z,r){translate([x0,y,z]) rotate([0,90,0]) cylinder(h=x1-x0, r=r);}

difference(){
  union(){
    hull(){ cylx(15.05,21, 0,30,11); cylx(15.05,21, -38,14,16); }
    hull(){ cylx(15.05,21, -38,14,16); cylx(15.05,21, -70,-22,16); }
    boxo(15.05,21, -6,6, 40, 58.4);
    boxo(-3,21, -6,6, 58.2, 62.2);
    cylx(20.8,30, -38,14,4.975);
    cylx(20.8,22.0, -38,14,6);
    cylx(20.8,30, -70,-22,4.975);
    cylx(20.8,22.0, -70,-22,6);
  }
  cylx(14.9,21.2, 0,30, 2.1);
  cylx(21,30.2, -38,14,1.7);
  cylx(21,30.2, -70,-22,1.7);
}
datum("pivot-cage", [15.05,0,30]);
datum_axis("pivot-cage-axis", [15.05,0,30], [1,0,0]);
datum_plane("spring-pad", [0,0,58.2], [0,0,-1]);
datum_axis("guide-axle", [21,-38,14], [1,0,0]);
datum_axis("tension-axle", [21,-70,-22], [1,0,0]);
datum_plane("guide-axle-tip", [30,-38,14], [1,0,0]);
datum_plane("tension-axle-tip", [30,-70,-22], [1,0,0]);