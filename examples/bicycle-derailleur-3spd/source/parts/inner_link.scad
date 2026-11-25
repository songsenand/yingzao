$fn = 64;
module cyly(y0,y1,x,z,r){translate([x,y0,z]) rotate([-90,0,0]) cylinder(h=y1-y0, r=r);}
module capsule(x0,z0,x1,z1,r,y0,y1){hull(){cyly(y0,y1,x0,z0,r); cyly(y0,y1,x1,z1,r);}}

difference(){
  union(){
    capsule(12,0,7,29.5804,4.7,-9.8,-6.2);
    cyly(-9.8,-6.2,12,0,7);
    cyly(-9.8,-6.2,7,29.5804,6);
  }
  cyly(-12,-4,12,0,2.55);
  cyly(-12,-4,7,29.5804,2.55);
}
datum("pivot-B", [12,0,0]);
datum_axis("pivot-B-axis", [12,0,0], [0,1,0]);
datum("pivot-D", [7,0,29.5804]);
datum_axis("pivot-D-axis", [7,0,29.5804], [0,1,0]);