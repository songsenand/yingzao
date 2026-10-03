$fn=64;
// 显微镜底座 150x120x12。z=0 台面, z 向上。
// 立柱轴 (0,0); 光轴 (0,60)。配重腔供 M4 稳定性验证做"空 vs 填"两态。
H=12;
module rrect(x0,x1,y0,y1,r){
  hull(){
    translate([x0+r,y0+r]) circle(r=r);
    translate([x1-r,y0+r]) circle(r=r);
    translate([x0+r,y1-r]) circle(r=r);
    translate([x1-r,y1-r]) circle(r=r);
  }
}
module outline(){
  difference(){
    rrect(-75,75,-50,70,14);
    translate([42,92]) circle(r=34);
    translate([-42,92]) circle(r=34);
  }
}
difference(){
  linear_extrude(H) outline();
  // 立柱根部止口孔 Ø40.15 (从顶面往下 6)
  translate([0,0,6]) cylinder(d=40.15,h=7);
  // 4x M3 热熔铜螺母孔 Ø4.2x5.7, 分布圆 Ø46
  for(p=[[23,0],[-23,0],[0,23],[0,-23]]) translate([p[0],p[1],6.3]) cylinder(d=4.2,h=7);
  // 2x 配重腔 40x40x6 (从底面往上)
  translate([27,-15,-0.5]) cube([40,40,7]);
  translate([-67,-15,-0.5]) cube([40,40,7]);
  // 4x 橡胶垫位 Ø14x2
  for(p=[[62,-38],[-62,-38],[55,45],[-55,45]]) translate([p[0],p[1],-0.5]) cylinder(d=14,h=2.5);
}
// ---- datum anchors (世界坐标, 不影响几何) ----
datum("法兰座面",[14,20,12]);
datum("上表面",[0,-40,12]);
datum("配重腔中心",[47,5,3]);
datum_cyl("法兰孔",[0,0,9],[0,0,1],20.075);
datum_plane("底座上表面",[0,-40,12],[0,0,1]);
