$fn=64;
// 齿轮轴 v2: 轴心外移到 (y=26.5, z=265) —— Ø22 齿顶原来切进 Ø40 精调环。
// Ø8 轴 (x=-34..34) + mod1 z=20 齿轮 (厚 8); 齿条节线 y=16.5 (齿顶 17.5)。
m=1; z=20; pa=20;
rp=m*z/2; ra=rp+m; rf=rp-1.25*m; ap=360/z;
htip=4.5-(m/rp)*tan(pa)*180/PI;
hroot=4.5+(1.25*m/rp)*tan(pa)*180/PI;
YC=26.5;
module gear2d(){
  polygon([for(i=[0:z-1]) each [
    [rf*cos(i*ap-hroot), rf*sin(i*ap-hroot)],
    [ra*cos(i*ap-htip),  ra*sin(i*ap-htip)],
    [ra*cos(i*ap+htip),  ra*sin(i*ap+htip)],
    [rf*cos(i*ap+hroot), rf*sin(i*ap+hroot)]]]);
}
difference(){
  union(){
    translate([-34,YC,265]) rotate([0,90,0]) cylinder(d=8,h=68);
    translate([4,YC,265]) rotate([0,-90,0]) linear_extrude(8) rotate(9) gear2d();
  }
  translate([24,YC-3.3-4,261]) cube([10,4,8]);
  translate([24,YC+3.3,261])   cube([10,4,8]);
  translate([-34,YC-3.3-4,261]) cube([10,4,8]);
  translate([-34,YC+3.3,261])   cube([10,4,8]);
}
// ---- datum anchors ----
datum("轴心",[0,YC,265]);
datum("节圆点",[0,16.5,265]);
datum("轴端",[34,YC,265]);
datum_cyl("轴径",[0,YC,265],[1,0,0],4);
datum_cyl("齿轮节圆",[0,YC,265],[1,0,0],10);
datum_axis("轴轴线",[0,YC,265],[1,0,0]);
