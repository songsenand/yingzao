$fn=64;
// 剪影校准件：与 v001 同构，仅底板 150 -> 180（其余尺寸、功能面不动）
R_OUT = 3; R_TOP = 1.5; C_BOT = 0.5;
module rr(w, d, r=R_OUT) { offset(r=r) square([w-2*r, d-2*r], center=true); }
module rr_slab(w, d, z, r=R_OUT, h=0.02) { translate([0,0,z]) linear_extrude(height=h) rr(w,d,r); }
module r_plate(w, d, z0, z1) {
  hull() {
    rr_slab(w-2*C_BOT, d-2*C_BOT, z0, R_OUT, C_BOT);
    rr_slab(w, d, z0+C_BOT, R_OUT, (z1-z0)-C_BOT-R_TOP);
    rr_slab(w-2*R_TOP, d-2*R_TOP, z1-R_TOP, R_OUT, R_TOP);
  }
}
module r_boss(d=14, h=7.1, c=1) {
  translate([0,0,0]) cylinder(d1=d-2*c, d2=d, h=c);
  translate([0,0,c]) cylinder(d=d, h=h-c);
}
foot=[[-55,-28],[55,-28],[0,32]];
module col(){
  hull(){ rr_slab(46,10,19); rr_slab(30,10,70); }
  hull(){ rr_slab(30,10,70); rr_slab(18,16,84); }
  rr_slab(18,16,84,R_OUT,20);
}
module brk(){
  hull(){ translate([-10,4.4,52]) cube([20,0.6,18]);
          translate([-10,9.0,61]) cube([20,0.6,9]); }
  for(i=[-3:3]) translate([i*2-(i==0?0.7:0.35),9.6,61]) cube([(i==0?1.4:0.7),0.9,3.5]);
}
difference(){
  union(){
    r_plate(180, 80, 15, 20);
    for(f=foot) translate([f[0],f[1],8]) r_boss();
    col(); brk();
  }
  for(s=[-1,1]) translate([s*50,0,14]) linear_extrude(height=7) rr(38,44,3);
  for(f=foot){
    translate([f[0],f[1],7.9]) cylinder(d=6.5,h=2.6,$fn=6);
    translate([f[0],f[1],10.5]) cylinder(d=3.4,h=11);
  }
  rotate([90,0,0]) linear_extrude(height=11,center=true)
    polygon([[-0.3,101],[0.3,101],[2.03,104],[-2.03,104]]);
}
