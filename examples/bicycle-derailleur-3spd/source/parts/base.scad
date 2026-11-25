$fn = 64;
module boxo(x0,x1,y0,y1,z0,z1){translate([x0,y0,z0]) cube([x1-x0,y1-y0,z1-z0]);}
module cylx(x0,x1,y,z,r){translate([x0,y,z]) rotate([0,90,0]) cylinder(h=x1-x0, r=r);}
module cyly(y0,y1,x,z,r){translate([x,y0,z]) rotate([-90,0,0]) cylinder(h=y1-y0, r=r);}
module cylz(z0,z1,x,y,r){translate([x,y,z0]) cylinder(h=z1-z0, r=r);}

difference(){
  union(){
    boxo(-12, 20, -4, 4, 0, 12);
    boxo(14, 20, -4, 4, -33, 0);
    cylx(-21, -11.8, 0, 6, 13);
    boxo(-8, 4, 3.8, 6, -6, 6);
    boxo(-8, 4, 10, 12, -6, 6);
    boxo(-12, -7.8, 3.8, 12, -6, 6);
    boxo(6, 24, -6, -3.8, -6, 6);
    boxo(6, 24, -12, -10, -6, 6);
    boxo(20, 24, -12, -3.8, -6, 6);
    boxo(19.8, 38, -4, 16, -38, -33);
    cylz(-33, -31, 29.5804, 8, 6.2);
    cylz(-44, -32.8, 29.5804, 8, 6.0);
  }
  cylx(-21.2, -11.0, 0, 6, 5.1);
  cylx(-21.2, -15.5, 0, 6, 8.5);
  cyly(3.7, 12.2, 0, 0, 2.6);
  cyly(-12.2, -3.7, 12, 0, 2.6);
  for (x = [0, 5, 10]) cyly(-5, 5, x, 12, 2.0);
  cylz(-44.5, -30.5, 29.5804, 8, 1.3);
  cylz(-44.5, -40.0, 29.5804, 8, 3.15);
}
datum("pivot-A", [0, 0, 0]);
datum_axis("pivot-A-axis", [0, 0, 0], [0, 1, 0]);
datum("pivot-B", [12, 0, 0]);
datum_axis("pivot-B-axis", [12, 0, 0], [0, 1, 0]);
datum("index-g1", [0, 0, 12]);
datum("index-g2", [5, 0, 12]);
datum("index-g3", [10, 0, 12]);
datum_plane("spring-seat", [29.5804, 8, -33], [0, 0, 1]);
datum_axis("cable-line", [29.5804, 8, -44], [0, 0, 1]);
datum_axis("mount-bore", [-21, 0, 6], [1, 0, 0]);
datum_plane("housing-stop", [29.5804, 8, -44], [0, 0, -1]);