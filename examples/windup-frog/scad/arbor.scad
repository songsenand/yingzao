// 上弦轴：φ5 轴 + 凸轮 D 面 + 发条内端卡槽 + 钥匙 D 面
$fn = 64;
A = [4, 0];
module part() {
  difference() {
    translate([A[0],A[1],3.0]) cylinder(h=20.6, d=5.0);
    // 凸轮安装 D 面
    translate([0.5,1.9,3.0]) cube([7,3,3.0]);
    // 钥匙 D 面
    translate([0.5,1.9,22.0]) cube([7,3,2.0]);
    // 发条内端卡槽
    translate([1.3,-0.4,9.8]) cube([2.3,0.8,2.4]);
  }
}
datum_axis("轴A",[4,0,10],[0,0,1]);
datum_cyl("轴颈",[4,0,10],[0,0,1],2.5);
part();
