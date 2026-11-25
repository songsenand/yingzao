$fn = 64;
module boxo(x0,x1,y0,y1,z0,z1){translate([x0,y0,z0]) cube([x1-x0,y1-y0,z1-z0]);}
module cylx(x0,x1,y,z,r){translate([x0,y,z]) rotate([0,90,0]) cylinder(h=x1-x0, r=r);}
module cyly(y0,y1,x,z,r){translate([x,y0,z]) rotate([-90,0,0]) cylinder(h=y1-y0, r=r);}
module cylz(z0,z1,x,y,r){translate([x,y,z0]) cylinder(h=z1-z0, r=r);}

difference(){
  union(){
    boxo(-5, 11.2, -4, 4, 22, 40);
    boxo(-11, 1, 3.8, 6, 22.5, 37.2);
    boxo(-11, 1, 10, 12, 22.5, 37.2);
    boxo(-7, 3, 3.8, 12, 36.8, 40.2);
    boxo(1, 13, -6, -3.8, 22.5, 37.2);
    boxo(1, 13, -12, -10, 22.5, 37.2);
    boxo(5, 15, -12, -3.8, 36.8, 40.2);
    cylz(14, 40, 0, 0, 6);
    cylx(11, 14.9, 0, 30, 6);
    cylz(39.8, 58, 0, 0, 8);
  }
  cyly(3.7, 12.2, -5, 29.5804, 2.6);
  cyly(-12.2, -3.7, 7, 29.5804, 2.6);
  cylz(14, 38, 0, 0, 4.5);
  cylz(38, 40.2, 0, 0, 2.0);
  cylx(10.8, 15.2, 0, 30, 1.65);
  cylz(40, 58.2, 0, 0, 5.25);
}
datum("pivot-C", [-5,0,29.5804]);
datum_axis("pivot-C-axis", [-5,0,29.5804], [0,1,0]);
datum("pivot-D", [7,0,29.5804]);
datum_axis("pivot-D-axis", [7,0,29.5804], [0,1,0]);
datum_axis("detent-bore", [0,0,14], [0,0,1]);
datum_axis("cage-bore", [11,0,30], [1,0,0]);
datum_plane("cage-seat", [14.9,0,30], [1,0,0]);
datum_plane("spring-floor", [0,0,40], [0,0,1]);
datum_axis("spring-pocket", [0,0,40], [0,0,1]);
datum_plane("detent-shoulder", [0,0,38], [0,0,-1]);
datum_plane("cage-spring-floor", [0,0,40], [0,0,1]);