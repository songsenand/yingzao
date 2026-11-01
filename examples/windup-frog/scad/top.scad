// 机架顶板：4 柱孔 + 轴孔 + 棘爪销/导向柱/簧柱
$fn = 64;
A = [4, 0]; B = [15.6906, 8.1826]; C = [22.6701, -1.7857];
P = [13.5, -6.5]; G = [19.0, -6.5]; Q = [24.5, -9.5];

module rrect(w, h, r) { offset(r=r) square([w-2*r, h-2*r], center=true); }
module part() {
  difference() {
    union() {
      translate([2,0,19.6]) linear_extrude(3) rrect(60,36,4);
      translate([P[0],P[1],22.5]) cylinder(h=1.7, d=4.0);
      translate([G[0],G[1],22.5]) cylinder(h=1.7, d=3.0);
      translate([Q[0],Q[1],22.5]) cylinder(h=1.7, d=4.0);
    }
    translate([A[0],A[1],18.6]) cylinder(h=5, d=5.4);
    translate([B[0],B[1],18.6]) cylinder(h=5, d=3.3);
    translate([C[0],C[1],18.6]) cylinder(h=5, d=3.3);
    // 沉头孔（轴用 M3 沉头螺钉，头不露出顶面）
    for (p=[B,C]) translate([p[0],p[1],21.15]) cylinder(h=1.5, r1=1.65, r2=3.10);
    for (p=[[-24,-14],[-24,14],[28,-14],[28,14]])
      translate([p[0],p[1],18.6]) cylinder(h=5, d=3.3);
  }
}
datum_axis("轴A",[4,0,21],[0,0,1]);
datum_axis("轴B",[15.6906,8.1826,21],[0,0,1]);
datum_axis("轴C",[22.6701,-1.7857,21],[0,0,1]);
datum_cyl("孔A",[4,0,21],[0,0,1],2.7);
datum_plane("底面",[2,0,19.6],[0,0,-1]);
datum_plane("顶面",[2,0,22.6],[0,0,1]);
part();
