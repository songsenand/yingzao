// 演示底板（去掉回位簧，仅供运动仿真播放；不是交付件）
$fn = 64;
A = [4, 0]; B = [15.6906, 8.1826]; C = [22.6701, -1.7857];

module rrect(w, h, r) { offset(r=r) square([w-2*r, h-2*r], center=true); }

module spring_leaf() {
  pts = [[31.0,10.0],[29.0,11.5],[26.0,11.8],[23.0,10.8],[20.5,9.2],
         [18.5,7.6],[17.2,5.4],[15.8,4.8]];
  for (i=[0:len(pts)-2])
    hull() { translate([pts[i][0],pts[i][1],0]) circle(r=0.4);
             translate([pts[i+1][0],pts[i+1][1],0]) circle(r=0.4); }
}

module part() {
  difference() {
    union() {
      translate([2,0,0]) linear_extrude(3) rrect(60,36,4);
      for (p=[[-24,-14],[-24,14],[28,-14],[28,14]])
        translate([p[0],p[1],3]) cylinder(h=16.6, d=6);
      // 导轨：-y 长，+y 短（避让 B 轴螺钉）
      translate([8.5,-8.6,2.9]) cube([6.0,2.0,3.3]);
      translate([8.5, 6.6,2.9]) cube([4.0,2.0,3.3]);
      // 发条盒 4 个支承柱（r9.5，避开凸轮 r8）
      for (a=[100,140,220,260]) translate([A[0]+9.5*cos(a), A[1]+9.5*sin(a), 3.0]) cylinder(h=4.15, d=2.6);
    }
    translate([A[0],A[1],-1]) cylinder(h=5, d=5.4);
    translate([B[0],B[1],-1]) cylinder(h=5, d=3.3);
    translate([C[0],C[1],-1]) cylinder(h=5, d=3.3);
    for (p=[[-24,-14],[-24,14],[28,-14],[28,14]])
      translate([p[0],p[1],-1]) cylinder(h=21, d=3.3);
    for (s=[-1,1]) hull() {
      translate([11.5, s*3.2, -1]) cylinder(h=5, d=4.4);
      translate([15.5, s*3.2, -1]) cylinder(h=5, d=4.4);
    }
  }
}
datum_plane("顶面演示",[2,0,3],[0,0,1]);
datum_axis("轴A",[4,0,10],[0,0,1]);
datum_axis("轴B",[15.6906,8.1826,10],[0,0,1]);
datum_axis("轴C",[22.6701,-1.7857,10],[0,0,1]);
datum_cyl("孔A",[4,0,1.5],[0,0,1],2.7);
datum_plane("顶面",[2,0,3],[0,0,1]);
datum_plane("底面",[2,0,0],[0,0,-1]);
part();
