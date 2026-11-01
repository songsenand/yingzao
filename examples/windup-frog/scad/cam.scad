// 偏心凸轮：R6, e2（行程 4mm）
$fn = 64;
A = [4, 0];
module part() {
  difference() {
    translate([A[0]-2, A[1], 3.6]) cylinder(h=2.0, d=12.0);
    translate([A[0],A[1],2.5]) intersection() {
      cylinder(h=5.0, d=5.04);
      translate([-3.2,-3.2,-0.1]) cube([6.4, 5.1, 5.2]);   // y <= 1.9
    }
  }
}
datum_axis("轴A",[4,0,4.6],[0,0,1]);
datum_cyl("孔",[4,0,4.6],[0,0,1],2.52);
datum_plane("底面",[4,0,3.6],[0,0,-1]);
part();
