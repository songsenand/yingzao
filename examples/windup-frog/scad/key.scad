// 上弦钥匙 + 棘轮（一体）：顶板上方，压配在轴上
$fn = 64;
A = [4, 0];
function r_at(a) =
  let (t = ((a % 30) + 30) % 30)
  t < 3  ? 5.8 + 1.2*t/3 :
  t < 18 ? 7.0 :
  t < 27 ? 7.0 - 1.2*(t-18)/9 : 5.8;
pts = [for (i=[0:359]) let(a=i) [r_at(a)*cos(a), r_at(a)*sin(a)]];

module part() {
  difference() {
    union() {
      // 棘轮盘（旋转 -60° 使齿顶正对棘爪）
      translate([A[0],A[1],22.6]) rotate([0,0,-60]) linear_extrude(1.2) polygon(pts);
      translate([A[0],A[1],22.6]) cylinder(h=1.2, d=11.7);
      // 轮毂
      translate([A[0],A[1],23.8]) cylinder(h=0.5, d=10.0);
      // 钥匙翼（圆头长条）
      translate([A[0],A[1],24.2]) linear_extrude(1.8) hull() {
        translate([-7.5,0]) circle(r=3.0);
        translate([7.5,0]) circle(r=3.0);
      }
    }
    translate([A[0],A[1],21.5]) intersection() {
      cylinder(h=6.0, d=5.04);
      translate([-3.2,-3.2,-0.1]) cube([6.4, 5.1, 6.2]);   // y <= 1.9
    }
  }
}
datum_axis("轴A",[4,0,24],[0,0,1]);
datum_cyl("孔",[4,0,24],[0,0,1],2.52);
datum_plane("底面",[4,0,22.6],[0,0,-1]);
part();
