// 氢原子 H：单孔
// 球半径 R=6；定心平台在球面下 0.9mm；打印姿态：按本文件姿态（+Z 朝上）
$fn = 72;

// ---- socket（定心平台在 z=0，+Z 朝材料内部）----
module socket_cut(roofDeg = 0) {
  // 定心平台：自平台外侧切到 z=0
  translate([0, 0, -2]) cylinder(h = 2, r = 3.4, $fn = 72);
  // 直孔
  cylinder(h = 3.4, r = 2.6, $fn = 72);
  // 卡槽
  translate([0, 0, 2.15])
    cylinder(h = 0.9, r = 2.95, $fn = 72);
  // 泪滴排屑（朝"屋顶"偏心，让近水平孔的上壁不塌）
  rotate([0, 0, roofDeg])
    translate([2.85, 0, 0.5])
      cylinder(h = 2.9, r = 0.5, $fn = 72);
}

difference() {
  sphere(r = 6);
  // socket 轴 (0, 0, 1)
  translate([0, 0, 5.1])
    rotate(a = 180, v = [1, 0, 0])
      socket_cut(0);
}

datum_cyl("sock0", [0, 0, 5.1], [0, 0, 1], 2.6);
