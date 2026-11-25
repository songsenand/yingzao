$fn = 64;
module cyly(y0,y1,x,z,r){translate([x,y0,z]) rotate([-90,0,0]) cylinder(h=y1-y0, r=r);}
module cylz(z0,z1,x,y,r){translate([x,y,z0]) cylinder(h=z1-z0, r=r);}
module capsule(x0,z0,x1,z1,r,y0,y1){hull(){cyly(y0,y1,x0,z0,r); cyly(y0,y1,x1,z1,r);}}

difference(){
  union(){
    capsule(0,0,-5,29.5804,6,6.2,9.8);
    capsule(0,0,29.5804,7.0,6,6.2,9.8);
    cyly(6.2,9.8,0,0,7);
    cylz(1,9,29.5804,8,7);
    cylz(1,3,29.5804,8,8);
  }
  cyly(4,12,0,0,2.55);
  cyly(4,12,-5,29.5804,2.55);
  cylz(-1,10,29.5804,8,1.3);
  cyly(-1,16,29.5804,6,1.6);
}
datum("pivot-A", [0,0,0]);
datum_axis("pivot-A-axis", [0,0,0], [0,1,0]);
datum("pivot-C", [-5,0,29.5804]);
datum_axis("pivot-C-axis", [-5,0,29.5804], [0,1,0]);
datum_plane("spring-seat", [29.5804,8,1], [0,0,-1]);
datum_axis("cable-line", [29.5804,8,1], [0,0,1]);
datum_plane("clamp-screw", [29.5804,8,6], [0,1,0]);