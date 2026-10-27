// 键棒 stick_7.2：CO_ring：两端台肩面间距 7.2mm，两端另各伸出 3.2mm 卡脚
// 杆 Ø6.2；卡脚 Ø5.0，四瓣弹性（0.6 开缝），通气孔 Ø4.2
// 打印姿态：竖立，一端卡脚朝下（首层是 Ø5 环，建议 2mm brim）
$fn = 72;
L = 7.2;

// 卡脚：z=0 台肩面（定位面），+Z 朝外，尖端在 z=3.2
module peg() {
  // 自 z=-0.4 起，与杆重叠 0.4（共面接触会让 union 变成多个 body）
  translate([0, 0, -0.4])
    cylinder(h = 2.58, r = 2.5, $fn = 72);
  translate([0, 0, 2.18])
    cylinder(h = 0.5, r = 2.7, $fn = 72);
  translate([0, 0, 2.68])
    cylinder(h = 0.2, r1 = 2.7, r2 = 2.5, $fn = 72);
  translate([0, 0, 2.88])
    cylinder(h = 0.32, r1 = 2.5, r2 = 1.6, $fn = 72);
}

// 去料：z=0 是尖端，+Z 朝台肩
module peg_relief() {
  translate([0, 0, 0.4]) cylinder(h = 2.2, r = 2.1, $fn = 72);
  for (r = [0, 90]) rotate([0, 0, r])
    translate([-0.3, -4.1, 0])
      cube([0.6, 8.2, 2.8], center = false);
}

difference() {
  union() {
    cylinder(h = L, r = 3.1, $fn = 72, center = true);
    translate([0, 0, -3.6]) rotate([180, 0, 0]) peg();
    translate([0, 0, 3.6]) peg();
  }
  translate([0, 0, -6.8]) peg_relief();
  translate([0, 0, 6.8]) rotate([180, 0, 0]) peg_relief();
}

datum_cyl("pegA", [0, 0, -3.6], [0, 0, -1], 2.5);
datum_cyl("pegB", [0, 0, 3.6], [0, 0, 1], 2.5);
datum("seatA", [0, 0, -3.6]);
datum("seatB", [0, 0, 3.6]);
